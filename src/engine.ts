// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * DuckDB execution engine.
 *
 * Each Snowflake database is a separate DuckDB catalog (`ATTACH ':memory:'`),
 * so `DB.SCHEMA.TABLE` resolves natively and no identifier rewriting is needed.
 * The *current* database/schema is per-connection (`USE`), which mirrors
 * Snowflake: sessions share the account's objects but not their context.
 *
 * Row-producing statements come back as plain JS values via `getRowsJS()`:
 * timestamps and dates become `Date`, wide integers become `BigInt`, JSON
 * becomes a string. `types.ts` turns those into Snowflake's wire vocabulary.
 */

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

import { normalizeName } from './catalog.js';
import { toSqlLiteral } from './dialect.js';
import { mapEngineError } from './errors.js';

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

function qualified(database: string, schema: string): string {
  return `${quoteIdent(normalizeName(database))}.${quoteIdent(normalizeName(schema))}`;
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

  private constructor(instance: DuckDBInstance, admin: DuckDBConnection) {
    this.instance = instance;
    this.admin = admin;
  }

  static async create(path = ':memory:'): Promise<Engine> {
    const instance = await DuckDBInstance.create(path);
    const admin = await instance.connect();
    return new Engine(instance, admin);
  }

  /** Attach a Snowflake database as its own DuckDB catalog. Idempotent. */
  async attachDatabase(name: string): Promise<boolean> {
    const key = normalizeName(name);
    if (this.attached.has(key)) return false;
    await this.admin.run(`ATTACH ':memory:' AS ${quoteIdent(key)}`);
    this.attached.add(key);
    return true;
  }

  async existsDatabase(name: string): Promise<boolean> {
    const key = normalizeName(name);
    if (this.attached.has(key)) return true;
    const rows = await this.queryOnAdmin(
      `SELECT 1 FROM duckdb_databases() WHERE database_name = ${toSqlLiteral(key)}`,
    );
    return rows.length > 0;
  }

  async detachDatabase(name: string): Promise<boolean> {
    const key = normalizeName(name);
    if (!this.attached.has(key)) return false;
    await this.admin.run(`DETACH ${quoteIdent(key)}`);
    this.attached.delete(key);
    return true;
  }

  async createSchema(database: string, schema: string): Promise<void> {
    await this.admin.run(`CREATE SCHEMA IF NOT EXISTS ${qualified(database, schema)}`);
  }

  async dropSchema(database: string, schema: string, cascade = false): Promise<void> {
    await this.admin.run(
      `DROP SCHEMA ${cascade ? 'CASCADE' : 'RESTRICT'} ${qualified(database, schema)}`,
    );
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
    const db = toSqlLiteral(normalizeName(database));
    const sc = toSqlLiteral(normalizeName(schema));
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

  async tableExists(database: string, schema: string, table: string): Promise<boolean> {
    // Table names are stored exactly as written, so compare case-insensitively:
    // Snowflake folds unquoted identifiers to upper case, DuckDB does not.
    const rows = await this.queryOnAdmin(
      `SELECT 1 FROM duckdb_tables()
       WHERE lower(database_name) = lower(${toSqlLiteral(normalizeName(database))})
         AND lower(schema_name) = lower(${toSqlLiteral(normalizeName(schema))})
         AND lower(table_name) = lower(${toSqlLiteral(normalizeName(table))})`,
    );
    if (rows.length > 0) return true;
    const views = await this.queryOnAdmin(
      `SELECT 1 FROM duckdb_views()
       WHERE lower(database_name) = lower(${toSqlLiteral(normalizeName(database))})
         AND lower(schema_name) = lower(${toSqlLiteral(normalizeName(schema))})
         AND lower(view_name) = lower(${toSqlLiteral(normalizeName(table))})`,
    );
    return views.length > 0;
  }

  async describeTable(database: string, schema: string, table: string): Promise<ColumnInfo[]> {
    const rows = await this.queryOnAdmin(
      `SELECT column_name, data_type, is_nullable FROM duckdb_columns()
       WHERE lower(database_name) = lower(${toSqlLiteral(normalizeName(database))})
         AND lower(schema_name) = lower(${toSqlLiteral(normalizeName(schema))})
         AND lower(table_name) = lower(${toSqlLiteral(normalizeName(table))})
       ORDER BY column_index`,
    );
    return rows.map((row) => ({
      name: String(row[0]),
      duckType: String(row[1]),
      nullable: String(row[2]).toUpperCase() !== 'NO',
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
  }
}

export class EngineConnection {
  private current: string | null = null;

  constructor(private readonly connection: DuckDBConnection) {}

  /** Point this connection at a database/schema pair (Snowflake `USE`). */
  async use(database: string, schema: string): Promise<void> {
    const target = qualified(database, schema);
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
