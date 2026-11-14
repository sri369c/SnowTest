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
import { mapEngineError } from './errors.js';
import type { DataDir } from './persist.js';

export interface RawColumn {
  name: string;
  duckType: string;
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

/**
 * Empty, read-only catalog a session without a current database or schema points at:
 * unqualified names find nothing and cannot be created. Read-only needs a file (DuckDB refuses `:memory:`).
 */
const NO_CONTEXT_CATALOG = '__snowtest_no_context';

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
    return new Engine(instance, admin, dataDir, noContextDir);
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
    this.admin.closeSync?.();
    this.instance.closeSync?.();
    await rm(this.noContextDir, { recursive: true, force: true });
  }
}

export class EngineConnection {
  private current: string | null = null;

  constructor(private readonly connection: DuckDBConnection) {}

  /** Snowflake `USE`. No current database or schema → the empty read-only catalog. */
  async use(database: string | null, schema: string | null): Promise<void> {
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

  /** Execute already-rewritten SQL and collect the full result. */
  async execute(sql: string): Promise<QueryResult> {
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

  close(): void {
    this.connection.closeSync?.();
  }
}
