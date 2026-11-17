// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * DuckDB execution engine.
 *
 * Each Snowflake database is a separate DuckDB catalog (`ATTACH ':memory:'`,
 * or one file per database under `SNOWTEST_DATA_DIR`),
 * so `DB.SCHEMA.TABLE` resolves natively and no identifier rewriting is needed.
 * The *current* database/schema is per-connection (`USE`), which mirrors
 * Snowflake: sessions share the account's objects but not their context.
 *
 * Row-producing statements come back as plain JS values via `getRowsJS()`:
 * timestamps and dates become `Date`, wide integers become `BigInt`, JSON
 * becomes a string. `types.ts` turns those into Snowflake's wire vocabulary.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

import { toSqlLiteral } from './dialect.js';
import { mapEngineError, sessionExpired } from './errors.js';
import type { DataDir } from './persist.js';

export interface RawColumn {
  name: string;
  duckType: string;
}

/** One sequence, as DuckDB's `duckdb_sequences()` reports it. */
export interface SequenceInfo {
  name: string;
  startValue: number;
  increment: number;
  minValue: number;
  maxValue: number;
  cycle: boolean;
  comment: string | null;
  /** The last value handed out, or null before the first call. */
  lastValue: number | null;
}

export interface QueryResult {
  columns: RawColumn[];
  rows: unknown[][];
  rowsChanged: number;
}

export function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** Names are canonical keys (see catalog.ts); they are quoted, never re-folded. */
function qualified(database: string, schema: string): string {
  return `${quoteIdent(database)}.${quoteIdent(schema)}`;
}

/**
 * Prefer the type's alias when DuckDB has one: a `JSON` column reports its
 * base type as VARCHAR, but `alias` still says JSON, and that distinction is
 * what makes variant columns appear as `variant` to clients.
 */
function typeName(type: unknown): string {
  if (type && typeof type === 'object') {
    const alias = (type as { alias?: unknown }).alias;
    if (typeof alias === 'string' && alias.length > 0) return alias;
  }
  return String(type);
}

/** `TIMESTAMP` literal text: the column is a plain timestamp, so no zone suffix rides along. */
function utcStamp(at: Date): string {
  return at.toISOString().replace('T', ' ').slice(0, 23);
}

/**
 * Empty, read-only catalog a session without a current database or schema points at:
 * unqualified names find nothing and cannot be created. Read-only needs a file (DuckDB refuses `:memory:`).
 */
const NO_CONTEXT_CATALOG = '__snowtest_no_context';

/**
 * The account's own query history, at the name Snowflake keeps it, in a plain
 * table. Nothing ages rows out on its own: the Clear button on the landing page
 * is the only thing that empties this, so a test can look back as far as it likes.
 */
const HISTORY_DATABASE = 'SNOWFLAKE';
const HISTORY_SCHEMA = 'ACCOUNT_USAGE';
const HISTORY_TABLE = 'QUERY_HISTORY';
const HISTORY_SEQUENCE = 'QUERY_HISTORY_SEQ';
/** Not `.duckdb`: DataDir restores every `.duckdb` file as a user database, and this is not one. */
const HISTORY_FILE = 'query_history.db';

/** The columns the pages read, in the order `toHistoryEntry` expects them. */
const HISTORY_COLUMNS = `SELECT query_text, start_time, total_elapsed_time, rows_produced, execution_status, user_name
       FROM ${HISTORY_DATABASE}.${HISTORY_SCHEMA}.${HISTORY_TABLE}`;

const HOUR_MS = 3_600_000;

/** One page of statements is a preview; a caller asking for a million gets a cap. */
const rowLimit = (limit: number): number => Math.max(1, Math.min(1_000, Math.trunc(limit)));

/** A history row as the pages use it; `start_time` arrives as a Date or as text. */
function toHistoryEntry(row: unknown[]): QueryHistoryEntry {
  return {
    queryText: String(row[0]),
    startedAt: row[1] instanceof Date ? row[1] : new Date(String(row[1])),
    elapsedMs: Number(row[2] ?? 0),
    rowsProduced: Number(row[3] ?? 0),
    status: String(row[4] ?? ''),
    user: String(row[5] ?? ''),
  };
}

/** One statement as the landing page shows it. */
export interface QueryHistoryEntry {
  queryText: string;
  startedAt: Date;
  elapsedMs: number;
  rowsProduced: number;
  status: string;
  user: string;
}

/** One hour of the timings chart: how many statements started in it. */
export interface QueryVolumeBucket {
  /** Start of the hour, UTC. */
  start: Date;
  statements: number;
}

/** Statement counts across a window, for the line above the timings table. */
export interface QueryVolume {
  from: Date;
  to: Date;
  /** Statements inside the window — not the count the whole table holds. */
  total: number;
  buckets: QueryVolumeBucket[];
}

/** One statement, as the history table records it. Times are wall clock, UTC. */
export interface QueryHistoryRecord {
  queryText: string;
  databaseName: string | null;
  schemaName: string | null;
  queryType: string;
  sessionId: number;
  userName: string;
  roleName: string;
  warehouseName: string | null;
  warehouseSize: string | null;
  executionStatus: 'SUCCESS' | 'FAIL';
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date;
  endedAt: Date;
  totalElapsedTime: number;
  rowsProduced: number;
}

export interface TableInfo {
  name: string;
  kind: string;
  rowCount: number | null;
}

export interface ColumnInfo {
  name: string;
  duckType: string;
  nullable: boolean;
}

export class Engine {
  private readonly instance: DuckDBInstance;
  /** Dedicated connection for catalog/metadata work, never a session's context. */
  private readonly admin: DuckDBConnection;
  private readonly attached = new Set<string>();
  private closed = false;

  private constructor(
    instance: DuckDBInstance,
    admin: DuckDBConnection,
    private readonly dataDir: DataDir | null,
    private readonly noContextDir: string,
  ) {
    this.instance = instance;
    this.admin = admin;
  }

  /** In memory unless a data directory is given. */
  static async create(dataDir: DataDir | null = null): Promise<Engine> {
    // UTC, not the host zone: TIMESTAMPTZ → TIMETZ/TIME/DATE conversions must not depend on where we run.
    const instance = await DuckDBInstance.create(':memory:', { TimeZone: 'UTC' });
    const admin = await instance.connect();
    const noContextDir = await mkdtemp(join(tmpdir(), 'snowtest-'));
    const file = toSqlLiteral(join(noContextDir, 'no_context.duckdb'));
    await admin.run(`ATTACH ${file} AS ${quoteIdent(NO_CONTEXT_CATALOG)}`);
    await admin.run(`DETACH ${quoteIdent(NO_CONTEXT_CATALOG)}`);
    await admin.run(`ATTACH ${file} AS ${quoteIdent(NO_CONTEXT_CATALOG)} (READ_ONLY)`);
    const engine = new Engine(instance, admin, dataDir, noContextDir);
    await engine.ensureQueryHistory();
    return engine;
  }

  /** Create the table and the counter behind `query_id`. Idempotent. */
  private async ensureQueryHistory(): Promise<void> {
    const target = this.dataDir
      ? toSqlLiteral(join(this.dataDir.root, HISTORY_FILE))
      : "':memory:'";
    await this.admin.run(`ATTACH ${target} AS ${HISTORY_DATABASE}`);
    await this.admin.run(`CREATE SCHEMA IF NOT EXISTS ${HISTORY_DATABASE}.${HISTORY_SCHEMA}`);
    await this.admin.run(
      `CREATE SEQUENCE IF NOT EXISTS ${HISTORY_DATABASE}.${HISTORY_SCHEMA}.${HISTORY_SEQUENCE} START 1`,
    );
    await this.admin.run(
      `CREATE TABLE IF NOT EXISTS ${HISTORY_DATABASE}.${HISTORY_SCHEMA}.${HISTORY_TABLE} (
         query_id BIGINT NOT NULL,
         query_text VARCHAR NOT NULL,
         database_name VARCHAR,
         schema_name VARCHAR,
         query_type VARCHAR,
         session_id BIGINT,
         user_name VARCHAR,
         role_name VARCHAR,
         warehouse_name VARCHAR,
         warehouse_size VARCHAR,
         execution_status VARCHAR,
         error_code VARCHAR,
         error_message VARCHAR,
         start_time TIMESTAMP,
         end_time TIMESTAMP,
         total_elapsed_time BIGINT,
         rows_produced BIGINT
       )`,
    );
  }

  /**
   * Note one statement. One INSERT, with the counter read inside it so nothing has
   * to be counted, swept or pruned on the way.
   */
  async recordQuery(record: QueryHistoryRecord): Promise<void> {
    const value = (input: string | number | null): string => {
      if (input === null) return 'NULL';
      if (typeof input === 'number') return String(Math.max(0, Math.trunc(input)));
      return toSqlLiteral(input);
    };
    const target = `${HISTORY_DATABASE}.${HISTORY_SCHEMA}.${HISTORY_TABLE}`;
    await this.admin.run(
      `WITH n AS (SELECT nextval('${HISTORY_DATABASE}.${HISTORY_SCHEMA}.${HISTORY_SEQUENCE}') AS v)
       INSERT INTO ${target}
         (query_id, query_text, database_name, schema_name, query_type, session_id,
          user_name, role_name, warehouse_name, warehouse_size, execution_status,
          error_code, error_message, start_time, end_time, total_elapsed_time, rows_produced)
       SELECT v,
              ${value(record.queryText)}, ${value(record.databaseName)}, ${value(record.schemaName)},
              ${value(record.queryType)}, ${value(record.sessionId)}, ${value(record.userName)},
              ${value(record.roleName)}, ${value(record.warehouseName)}, ${value(record.warehouseSize)},
              ${value(record.executionStatus)}, ${value(record.errorCode)}, ${value(record.errorMessage)},
              TIMESTAMP '${utcStamp(record.startedAt)}', TIMESTAMP '${utcStamp(record.endedAt)}',
              ${value(record.totalElapsedTime)}, ${value(record.rowsProduced)}
       FROM n`,
    );
  }

  /** How many statements the table holds, for the Clear Data tab. */
  async queryHistoryCount(): Promise<number> {
    const rows = await this.queryOnAdmin(
      `SELECT count(*) FROM ${HISTORY_DATABASE}.${HISTORY_SCHEMA}.${HISTORY_TABLE}`,
    );
    return Number(rows[0]?.[0] ?? 0);
  }

  /** Newest statements first, for the landing page. */
  async queryHistory(limit = 15): Promise<QueryHistoryEntry[]> {
    const rows = await this.queryOnAdmin(
      `${HISTORY_COLUMNS}
       ORDER BY query_id DESC LIMIT ${rowLimit(limit)}`,
    );
    return rows.map(toHistoryEntry);
  }

  /** The statements that started inside `[from, to)`, newest first. */
  async queryHistoryRange(from: Date, to: Date, limit = 50): Promise<QueryHistoryEntry[]> {
    const rows = await this.queryOnAdmin(
      `${HISTORY_COLUMNS}
       WHERE start_time >= TIMESTAMP '${utcStamp(from)}' AND start_time < TIMESTAMP '${utcStamp(to)}'
       ORDER BY query_id DESC LIMIT ${rowLimit(limit)}`,
    );
    return rows.map(toHistoryEntry);
  }

  /**
   * Statement counts per hour over the last `hours` hours, ending with the hour
   * in progress. An hour with nothing in it comes back as a zero rather than
   * being skipped: the chart draws a line across the whole window, and a quiet
   * hour is part of the shape it shows.
   */
  async queryVolume(hours = 24, now = new Date()): Promise<QueryVolume> {
    const span = Math.max(1, Math.min(24 * 30, Math.trunc(hours)));
    // Whole hours, so a bucket never straddles the minute the page was loaded.
    const to = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS);
    const from = new Date(to.getTime() - span * HOUR_MS);
    // epoch_ms keeps the bucketing in UTC: a TIMESTAMP read back as a Date would
    // depend on the host's zone, and the grid below is built from epoch values.
    const rows = await this.queryOnAdmin(
      `SELECT CAST(epoch_ms(date_trunc('hour', start_time)) AS BIGINT) AS bucket, count(*)
       FROM ${HISTORY_DATABASE}.${HISTORY_SCHEMA}.${HISTORY_TABLE}
       WHERE start_time >= TIMESTAMP '${utcStamp(from)}' AND start_time < TIMESTAMP '${utcStamp(to)}'
       GROUP BY 1 ORDER BY 1`,
    );
    const counts = new Map<number, number>();
    for (const row of rows) {
      counts.set(Number(row[0]), Number(row[1] ?? 0));
    }
    const buckets: QueryVolumeBucket[] = [];
    let total = 0;
    for (let index = 0; index < span; index++) {
      const start = new Date(from.getTime() + index * HOUR_MS);
      const statements = counts.get(start.getTime()) ?? 0;
      total += statements;
      buckets.push({ start, statements });
    }
    return { from, to, total, buckets };
  }

  /** Empty the timings table, and say how many statements went. */
  async clearQueryHistory(): Promise<number> {
    const rows = await this.queryOnAdmin(
      `SELECT count(*) FROM ${HISTORY_DATABASE}.${HISTORY_SCHEMA}.${HISTORY_TABLE}`,
    );
    const cleared = Number(rows[0]?.[0] ?? 0);
    await this.admin.run(`DELETE FROM ${HISTORY_DATABASE}.${HISTORY_SCHEMA}.${HISTORY_TABLE}`);
    return cleared;
  }

  /** Attach a Snowflake database as its own DuckDB catalog. Idempotent. */
  async attachDatabase(key: string): Promise<boolean> {
    if (this.attached.has(key)) return false;
    const target = this.dataDir ? toSqlLiteral(this.dataDir.databaseFile(key)) : "':memory:'";
    await this.admin.run(`ATTACH ${target} AS ${quoteIdent(key)}`);
    this.attached.add(key);
    return true;
  }

  async existsDatabase(key: string): Promise<boolean> {
    if (this.attached.has(key)) return true;
    const rows = await this.queryOnAdmin(
      `SELECT 1 FROM duckdb_databases() WHERE database_name = ${toSqlLiteral(key)}`,
    );
    return rows.length > 0;
  }

  async detachDatabase(key: string): Promise<boolean> {
    if (!this.attached.has(key)) return false;
    await this.admin.run(`DETACH ${quoteIdent(key)}`);
    this.attached.delete(key);
    return true;
  }

  /** DROP DATABASE: detach, and delete its file when persisted. */
  async dropDatabase(key: string): Promise<void> {
    await this.detachDatabase(key);
    await this.dataDir?.removeDatabase(key);
  }

  /** Schemas DuckDB holds for one attached database, DuckDB's own `main` excluded. */
  async listSchemas(database: string): Promise<string[]> {
    const rows = await this.queryOnAdmin(
      `SELECT schema_name FROM duckdb_schemas()
       WHERE database_name = ${toSqlLiteral(database)}
         AND schema_name <> 'main' AND NOT internal
       ORDER BY schema_name`,
    );
    return rows.map((row) => String(row[0]));
  }

  /** 'TABLE', 'VIEW' or null, matching the stored (already folded) name exactly. */
  async objectKind(database: string, schema: string, name: string): Promise<'TABLE' | 'VIEW' | null> {
    const where = `database_name = ${toSqlLiteral(database)} AND schema_name = ${toSqlLiteral(schema)}`;
    const tables = await this.queryOnAdmin(
      `SELECT 1 FROM duckdb_tables() WHERE ${where} AND table_name = ${toSqlLiteral(name)}`,
    );
    if (tables.length > 0) return 'TABLE';
    const views = await this.queryOnAdmin(
      `SELECT 1 FROM duckdb_views() WHERE ${where} AND view_name = ${toSqlLiteral(name)}`,
    );
    return views.length > 0 ? 'VIEW' : null;
  }

  async createSchema(database: string, schema: string): Promise<void> {
    await this.admin.run(`CREATE SCHEMA IF NOT EXISTS ${qualified(database, schema)}`);
  }

  async dropSchema(database: string, schema: string, cascade = false): Promise<void> {
    try {
      await this.admin.run(`DROP SCHEMA ${qualified(database, schema)} ${cascade ? 'CASCADE' : 'RESTRICT'}`);
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  /** Run a statement on the metadata connection (no session context applied). */
  async queryOnAdmin(sql: string): Promise<unknown[][]> {
    try {
      const reader = await this.admin.runAndReadAll(sql);
      return this.rows(reader);
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  private rows(reader: {
    getRowsJS?: () => unknown[][];
    getRows?: () => unknown[][];
  }): unknown[][] {
    try {
      if (typeof reader.getRowsJS === 'function') return reader.getRowsJS();
    } catch {
      // Some exotic types have no JS conversion; fall back to raw values.
    }
    if (typeof reader.getRows === 'function') return reader.getRows();
    return [];
  }

  /** Tables and views in one schema, read straight from DuckDB's catalog. */
  async listTables(database: string, schema: string): Promise<TableInfo[]> {
    const db = toSqlLiteral(database);
    const sc = toSqlLiteral(schema);
    const tables = await this.queryOnAdmin(
      `SELECT table_name FROM duckdb_tables()
       WHERE database_name = ${db} AND schema_name = ${sc} AND NOT internal`,
    );
    const views = await this.queryOnAdmin(
      `SELECT view_name FROM duckdb_views()
       WHERE database_name = ${db} AND schema_name = ${sc} AND NOT internal`,
    );
    return [
      ...tables.map((row) => ({
        name: String(row[0]),
        kind: 'TABLE',
        rowCount: null,
      })),
      ...views.map((row) => ({ name: String(row[0]), kind: 'VIEW', rowCount: null })),
    ];
  }

  /** Named sequences in one schema, read from DuckDB's own catalog. */
  async listSequences(database: string, schema: string): Promise<SequenceInfo[]> {
    const rows = await this.queryOnAdmin(
      `SELECT sequence_name, start_value, increment_by, min_value, max_value, cycle, comment, last_value
       FROM duckdb_sequences()
       WHERE database_name = ${toSqlLiteral(database)} AND schema_name = ${toSqlLiteral(schema)}`,
    );
    return rows.map((row) => ({
      name: String(row[0]),
      startValue: Number(row[1]),
      increment: Number(row[2]),
      minValue: Number(row[3]),
      maxValue: Number(row[4]),
      cycle: Boolean(row[5]),
      comment: row[6] === null ? null : String(row[6]),
      lastValue: row[7] === null ? null : Number(row[7]),
    }));
  }

  /** Columns of one table or view, matching the stored (already folded) names exactly. */
  async describeTable(database: string, schema: string, table: string): Promise<ColumnInfo[]> {
    const rows = await this.queryOnAdmin(
      `SELECT column_name, data_type, is_nullable FROM duckdb_columns()
       WHERE database_name = ${toSqlLiteral(database)}
         AND schema_name = ${toSqlLiteral(schema)}
         AND table_name = ${toSqlLiteral(table)}
       ORDER BY column_index`,
    );
    return rows.map((row) => ({
      name: String(row[0]),
      duckType: String(row[1]),
      nullable: row[2] === true,
    }));
  }

  async newConnection(): Promise<EngineConnection> {
    if (this.closed) throw new Error('Engine is closed.');
    const connection = await this.instance.connect();
    return new EngineConnection(connection);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.admin.closeSync();
    this.instance.closeSync();
    // Best effort: a file still mapped by another handle (Windows) must not turn
    // shutdown into a failure, and the directory is a temp dir anyway.
    await rm(this.noContextDir, { recursive: true, force: true }).catch(() => {});
  }
}

export class EngineConnection {
  private current: string | null = null;
  private closed = false;
  /**
   * True while a transaction this connection owns is open. DuckDB has no
   * SAVEPOINT, so nesting is tracked here instead of in the database: the
   * router joins an open transaction rather than starting a second one.
   */
  private open = false;

  constructor(private readonly connection: DuckDBConnection) {}

  get inTransaction(): boolean {
    return this.open;
  }

  /** Snowflake `USE`. No current database or schema → the empty read-only catalog. */
  async use(database: string | null, schema: string | null): Promise<void> {
    if (this.closed) throw sessionExpired();
    const target =
      database === null || schema === null ? qualified(NO_CONTEXT_CATALOG, 'main') : qualified(database, schema);
    if (this.current === target) return;
    try {
      await this.connection.run(`USE ${target}`);
      this.current = target;
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  /**
   * Snowflake's `BEGIN`. A transaction that is already open is committed first,
   * which is what BEGIN does in autocommit mode.
   */
  async beginTransaction(): Promise<void> {
    if (this.closed) throw sessionExpired();
    if (this.open) await this.commitTransaction();
    try {
      await this.connection.run('BEGIN TRANSACTION');
      this.open = true;
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  /**
   * Snowflake's `COMMIT`. With nothing open it is a no-op. On a transaction a
   * failed statement already aborted, DuckDB refuses and the transaction stays
   * open, so the client still has to roll back, as it would against Snowflake.
   */
  async commitTransaction(): Promise<void> {
    if (this.closed) throw sessionExpired();
    if (!this.open) return;
    try {
      await this.connection.run('COMMIT');
      this.open = false;
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  /** Snowflake's `ROLLBACK`. With nothing open it is a no-op, as in Snowflake. */
  async rollbackTransaction(): Promise<void> {
    if (this.closed) throw sessionExpired();
    if (!this.open) return;
    try {
      await this.connection.run('ROLLBACK');
      this.open = false;
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  /**
   * `TABLE`, `VIEW` or null, on this connection rather than the admin one:
   * inside a transaction the admin connection cannot see what the session has
   * created but not committed.
   */
  async objectKind(database: string, schema: string, name: string): Promise<'TABLE' | 'VIEW' | null> {
    const where = `database_name = ${toSqlLiteral(database)} AND schema_name = ${toSqlLiteral(schema)}`;
    const tables = await this.execute(
      `SELECT 1 FROM duckdb_tables() WHERE ${where} AND table_name = ${toSqlLiteral(name)}`,
    );
    if (tables.rows.length > 0) return 'TABLE';
    const views = await this.execute(
      `SELECT 1 FROM duckdb_views() WHERE ${where} AND view_name = ${toSqlLiteral(name)}`,
    );
    return views.rows.length > 0 ? 'VIEW' : null;
  }

  /** Execute already-rewritten SQL and collect the full result. */
  async execute(sql: string): Promise<QueryResult> {
    if (this.closed) throw sessionExpired();
    try {
      const reader = await this.connection.runAndReadAll(sql);
      const names = reader.columnNames();
      const types = reader.columnTypes();
      const columns: RawColumn[] = names.map((name, index) => ({
        name,
        duckType: typeName(types[index]),
      }));

      let rows: unknown[][] = [];
      try {
        rows = reader.getRowsJS();
      } catch {
        rows = reader.getRows();
      }

      let rowsChanged = 0;
      try {
        rowsChanged = Number(reader.rowsChanged ?? 0);
      } catch {
        rowsChanged = 0;
      }

      return { columns, rows, rowsChanged };
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  /** Idempotent: sessions close their connection on logout and again on shutdown. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // DuckDB rolls back an open transaction when the connection goes away, so a
    // logout or an idle sweep cannot leave half a client's transaction behind.
    this.open = false;
    this.connection.closeSync();
  }
}
