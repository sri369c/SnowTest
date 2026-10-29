// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * Statement router.
 *
 * Snowflake clients issue a lot of *metadata* SQL that is not really
 * query-shaped: `SHOW TERSE OBJECTS IN SCHEMA …`, `DESCRIBE TABLE …`,
 * `USE DATABASE …`, `ALTER SESSION SET …`. dbt in particular refuses to start
 * without them. DuckDB cannot answer those, so we synthesise Snowflake-shaped
 * results from the catalog and DuckDB's own `duckdb_*()` table functions, and
 * forward everything else to the engine.
 */

import { join } from 'node:path';

import { Catalog, normalizeName } from './catalog.js';
import { rewrite } from './dialect.js';
import { Engine, type EngineConnection } from './engine.js';
import { SnowflakeError, compilationError, objectNotFound } from './errors.js';
import type { Session } from './session.js';
import { StageStore } from './stage.js';
import { toSnowflakeType, toSnowflakeTypeName, type SnowflakeColumn } from './types.js';

export interface Outcome {
  columns: SnowflakeColumn[];
  /** Values already encoded for the wire. */
  rows: unknown[][];
  statementTypeId: number;
  rowsAffected: number;
  /**
   * PUT/GET are not result sets: the driver protocol answers with a file
   * transfer descriptor (`command`, `stageInfo`, …) that the client acts on
   * itself. The server puts this object in the response `data`.
   */
  fileTransfer?: Record<string, unknown>;
}

const STATEMENT_TYPES = {
  select: 4096,
  insert: 4097,
  update: 4098,
  delete: 4099,
  merge: 4100,
  copy: 4101,
  create: 4102,
  drop: 4104,
  alter: 4105,
  use: 4106,
  show: 4107,
  describe: 4108,
  commit: 4109,
  rollback: 4110,
} as const;

/** Snowflake renders a successful no-row statement as a `status` row. */
function statusOutcome(message: string, statementTypeId: number, rowsAffected = 0): Outcome {
  const columns = [buildColumn('status', 'VARCHAR', true, { database: '', schema: '', table: '' })];
  return {
    columns,
    rows: [[message]],
    statementTypeId,
    rowsAffected,
  };
}

function buildColumn(
  name: string,
  duckType: string,
  nullable: boolean,
  context: { database: string; schema: string; table: string },
): SnowflakeColumn {
  const mapped = toSnowflakeType(duckType);
  return {
    name,
    type: mapped.type,
    precision: mapped.precision,
    scale: mapped.scale,
    byteLength: mapped.byteLength,
    length: mapped.length,
    nullable,
    database: context.database,
    schema: context.schema,
    table: context.table,
  };
}

interface ColumnSpec {
  name: string;
  duckType: string;
}

/** Build a synthetic result set from `[name, type]` specs and raw rows. */
function syntheticOutcome(
  specs: ColumnSpec[],
  rawRows: unknown[][],
  statementTypeId: number = STATEMENT_TYPES.show,
): Outcome {
  const columns = specs.map((spec) =>
    buildColumn(spec.name, spec.duckType, true, { database: '', schema: '', table: '' }),
  );
  // Rows stay raw here; each protocol surface encodes them in its own format.
  return { columns, rows: rawRows, statementTypeId, rowsAffected: 0 };
}

/**
 * Remove SQL comments outside string literals.
 *
 * dbt appends `/* {"app": "dbt", ...} *\/` to every statement it sends. DuckDB
 * ignores those, but the metadata handlers match statement text with anchors, so
 * a trailing comment turns `describe table x` into an unsupported statement.
 */
function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;

  while (i < sql.length) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    out += ch;
    i += 1;
  }

  return out;
}

function splitName(reference: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of reference.trim()) {
    if (ch === '"') {
      quoted = !quoted;
      current += ch;
      continue;
    }
    if (ch === '.' && !quoted) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts.map((part) => normalizeName(part)).filter((part) => part.length > 0);
}

interface ResolvedTable {
  database: string;
  schema: string;
  name: string;
}

function resolveTable(session: Session, reference: string): ResolvedTable {
  const parts = splitName(reference);
  if (parts.length >= 3) {
    return { database: parts[0], schema: parts[1], name: parts.slice(2).join('.') };
  }
  if (parts.length === 2) {
    return { database: session.database, schema: parts[0], name: parts[1] };
  }
  if (parts.length === 1) {
    return { database: session.database, schema: session.schema, name: parts[0] };
  }
  throw compilationError(`Invalid object name '${reference}'.`);
}

function resolveSchema(session: Session, reference: string | undefined): { database: string; schema: string } {
  if (!reference) return { database: session.database, schema: session.schema };
  const parts = splitName(reference);
  if (parts.length >= 2) return { database: parts[0], schema: parts[1] };
  if (parts.length === 1) {
    // `SHOW TABLES IN <db>` is valid, so a single part means database.
    if (session.catalog.getDatabase(parts[0])) {
      return { database: parts[0], schema: session.schema };
    }
    return { database: session.database, schema: parts[0] };
  }
  return { database: session.database, schema: session.schema };
}

function likeMatcher(pattern: string | null): (value: string) => boolean {
  if (!pattern) return () => true;
  const unquoted = pattern.replace(/^'|'$/g, '');
  const regex = new RegExp(
    `^${unquoted
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/%/g, '.*')
      .replace(/_/g, '.')}$`,
    'i',
  );
  return (value: string) => regex.test(value);
}

export interface ExecuteOptions {
  bindings?: unknown[];
}

export class StatementRouter {
  constructor(
    private readonly engine: Engine,
    private readonly catalog: Catalog,
    readonly stages: StageStore = new StageStore(),
  ) {}

  private async connectionFor(session: Session): Promise<EngineConnection> {
    let connection = session.connection as EngineConnection | null;
    if (!connection) {
      connection = await this.engine.newConnection();
      session.connection = connection;
    }
    await connection.use(session.database, session.schema);
    return connection;
  }

  async execute(sql: string, session: Session, options: ExecuteOptions = {}): Promise<Outcome> {
    const statement = stripComments(sql).trim().replace(/;+\s*$/, '');
    if (statement.length === 0) {
      return statusOutcome('Statement executed successfully.', STATEMENT_TYPES.select);
    }

    const verb = /^([a-z]+)/i.exec(statement)?.[1]?.toUpperCase() ?? '';

    // DuckDB autocommits every statement, so Snowflake's explicit transaction
    // control (which clients issue around loads) has nothing to do here.
    if (verb === 'COMMIT' || verb === 'ROLLBACK' || verb === 'BEGIN' || verb === 'START') {
      return statusOutcome(
        'Statement executed successfully.',
        verb === 'COMMIT' ? STATEMENT_TYPES.commit : STATEMENT_TYPES.rollback,
      );
    }

    // dbt seeds the first batch of rows with `INSERT OVERWRITE INTO ...`, which
    // clears the table and inserts in one DML statement. DuckDB has no such
    // variant, so the two steps happen here.
    if (verb === 'INSERT' && /^insert\s+overwrite\b/i.test(statement)) {
      return this.handleInsertOverwrite(statement, session, options);
    }

    if (verb === 'USE') return this.handleUse(statement, session);
    if (verb === 'ALTER' && /^alter\s+session\b/i.test(statement)) {
      return this.handleAlterSession(statement, session);
    }
    if (verb === 'PUT') return this.handlePut(statement, session);
    if (verb === 'GET') return this.handleGet(statement, session);
    if (verb === 'COPY') return this.handleCopyInto(statement, session);
    if (verb === 'LIST' || verb === 'LS') return this.handleList(statement, session);
    if (verb === 'REMOVE' || verb === 'RM') return this.handleRemove(statement, session);
    if (verb === 'SHOW') return this.handleShow(statement, session);
    if (verb === 'DESCRIBE' || verb === 'DESC') return this.handleDescribe(statement, session);
    if (verb === 'CREATE' || verb === 'DROP' || verb === 'ALTER' || verb === 'COMMENT') {
      const handled = await this.handleAccountDdl(statement, session);
      if (handled) return handled;
    }

    return this.runOnEngine(statement, session, options);
  }

  private async handleInsertOverwrite(
    statement: string,
    session: Session,
    options: ExecuteOptions,
  ): Promise<Outcome> {
    const insert = statement.replace(/^insert\s+overwrite\s+/i, 'INSERT ');
    const target = /^insert\s+into\s+([\w$".]+)/i.exec(insert)?.[1];

    if (target) {
      try {
        await this.runOnEngine(`DELETE FROM ${target}`, session, {});
      } catch {
        // A missing table is the INSERT's error to report, not ours.
      }
    }

    return this.runOnEngine(insert, session, options);
  }

  // ---------------------------------------------------------------------------
  // USE / ALTER SESSION
  // ---------------------------------------------------------------------------

  private async handleUse(statement: string, session: Session): Promise<Outcome> {
    const match = /^use\s+(?:(database|schema|warehouse|role)\s+)?(.+)$/i.exec(statement);
    if (!match) throw compilationError(`Invalid USE statement: ${statement}`);

    const explicitScope = match[1]?.toUpperCase();
    const target = match[2].trim().replace(/;+\s*$/, '');

    let scope = explicitScope;
    if (!scope) {
      // Bare `USE x` means database.
      scope = this.catalog.getDatabase(target) ? 'DATABASE' : 'DATABASE';
    }

    if (scope === 'DATABASE') {
      const name = normalizeName(target);
      if (!this.catalog.getDatabase(name)) throw objectNotFound('DATABASE', name);
      session.database = name;
      await this.engine.attachDatabase(name);
      const schemas = this.catalog.listSchemas(name);
      session.schema = schemas.some((schema) => schema.name === 'PUBLIC')
        ? 'PUBLIC'
        : schemas[0]?.name ?? 'PUBLIC';
      await this.engine.createSchema(name, session.schema);
      await this.connectionFor(session);
      return statusOutcome(`${name} successfully set.`, STATEMENT_TYPES.use);
    }

    if (scope === 'SCHEMA') {
      const { database, schema } = resolveSchema(session, target);
      if (!this.catalog.getSchema(database, schema)) {
        // `USE SCHEMA a.b` should switch database too.
        this.catalog.createSchema(database, schema);
        await this.engine.createSchema(database, schema);
      }
      session.database = database;
      session.schema = schema;
      await this.connectionFor(session);
      return statusOutcome(
        `Statement executed successfully. ${database}.${schema} is now the current schema.`,
        STATEMENT_TYPES.use,
      );
    }

    if (scope === 'WAREHOUSE') {
      const name = normalizeName(target);
      if (!this.catalog.warehouses.has(name)) this.catalog.createWarehouse(name);
      session.warehouse = name;
      return statusOutcome('Statement executed successfully.', STATEMENT_TYPES.use);
    }

    if (scope === 'ROLE') {
      const name = normalizeName(target);
      this.catalog.createRole(name);
      session.role = name;
      return statusOutcome('Statement executed successfully.', STATEMENT_TYPES.use);
    }

    throw compilationError(`Unsupported USE ${scope} ${target}.`);
  }

  private handleAlterSession(statement: string, session: Session): Outcome {
    const body = statement.replace(/^alter\s+session\s+set\s+/i, '');
    const assignments = splitAssignments(body);
    for (const [key, value] of assignments) {
      session.setParameter(key, value);
    }
    return statusOutcome('Statement executed successfully.', STATEMENT_TYPES.alter);
  }

  // ---------------------------------------------------------------------------
  // SHOW
  // ---------------------------------------------------------------------------

  private async handleShow(statement: string, session: Session): Promise<Outcome> {
    const match =
      /^show\s+(terse\s+)?(?:(?:user|external|builtin)\s+)?(databases|schemas|tables|views|columns|objects|functions|warehouses|roles|stages|parameters|grants|file\s+formats|users|sequences|primary\s+keys|unique\s+keys|imported\s+keys)\b([\s\S]*)$/i.exec(
        statement,
      );
    if (!match) throw compilationError(`Unsupported SHOW statement: ${statement}`);

    const terse = Boolean(match[1]);
    const object = match[2].toLowerCase().replace(/\s+/g, ' ');
    const rest = match[3] ?? '';

    const inMatch = /\bin\s+(?:schema|database|table|view|warehouse|account|session)?\s*([\w$".]*)/i.exec(rest);
    const likePattern = /\blike\s+('[^']*')/i.exec(rest)?.[1] ?? null;
    const limit = Number.parseInt(/\blimit\s+(\d+)/i.exec(rest)?.[1] ?? '', 10);
    const matches = likeMatcher(likePattern);
    const cap = Number.isFinite(limit) && limit > 0 ? limit : Number.POSITIVE_INFINITY;

    // `LIKE` filters on the object name, which is not always the second column:
    // SHOW COLUMNS leads with table/schema, SHOW USERS and SHOW PARAMETERS with
    // the name itself.
    const finish = (specs: ColumnSpec[], rows: unknown[][], nameIndex = 1): Outcome => {
      const limited = rows
        .filter((row) => matches(String(row[nameIndex] ?? row[0] ?? '')))
        .slice(0, cap);
      return syntheticOutcome(specs, limited, STATEMENT_TYPES.show);
    };

    switch (object) {
      // Constraints are not tracked; SQLAlchemy reflection only needs the shape.
      case 'primary keys':
      case 'unique keys':
        return finish(
          ['created_on', 'database_name', 'schema_name', 'table_name', 'column_name',
            'key_sequence', 'constraint_name', 'rely', 'comment'].map((name) => ({ name, duckType: 'VARCHAR' })),
          [],
        );

      case 'imported keys':
        return finish(
          ['created_on', 'pk_database_name', 'pk_schema_name', 'pk_table_name', 'pk_column_name',
            'fk_database_name', 'fk_schema_name', 'fk_table_name', 'fk_column_name', 'key_sequence',
            'update_rule', 'delete_rule', 'fk_name', 'pk_name', 'deferrability', 'rely', 'comment',
          ].map((name) => ({ name, duckType: 'VARCHAR' })),
          [],
        );

      case 'databases': {
        const rows = [...this.catalog.databases.values()].map((db) => [
          db.createdAt,
          db.name,
          db.name === 'SNOWTEST' ? 'Y' : 'N',
          db.name === session.database ? 'Y' : 'N',
          '',
          'SYSADMIN',
          db.comment,
          '',
          '1',
        ]);
        return finish(
          [
            { name: 'created_on', duckType: 'TIMESTAMP_TZ' },
            { name: 'name', duckType: 'VARCHAR' },
            { name: 'is_default', duckType: 'VARCHAR' },
            { name: 'is_current', duckType: 'VARCHAR' },
            { name: 'origin', duckType: 'VARCHAR' },
            { name: 'owner', duckType: 'VARCHAR' },
            { name: 'comment', duckType: 'VARCHAR' },
            { name: 'options', duckType: 'VARCHAR' },
            { name: 'retention_time', duckType: 'VARCHAR' },
          ],
          rows,
        );
      }

      case 'schemas': {
        const { database } = resolveSchema(session, inMatch?.[1] || undefined);
        const rows = this.catalog.listSchemas(database).map((schema) => [
          new Date(),
          schema.name,
          'N',
          database === session.database && schema.name === session.schema ? 'Y' : 'N',
          database,
          'SYSADMIN',
          schema.comment,
          '',
          '1',
        ]);
        return finish(
          [
            { name: 'created_on', duckType: 'TIMESTAMP_TZ' },
            { name: 'name', duckType: 'VARCHAR' },
            { name: 'is_default', duckType: 'VARCHAR' },
            { name: 'is_current', duckType: 'VARCHAR' },
            { name: 'database_name', duckType: 'VARCHAR' },
            { name: 'owner', duckType: 'VARCHAR' },
            { name: 'comment', duckType: 'VARCHAR' },
            { name: 'options', duckType: 'VARCHAR' },
            { name: 'retention_time', duckType: 'VARCHAR' },
          ],
          rows,
        );
      }

      case 'tables':
      case 'views':
      case 'objects': {
        const { database, schema } = resolveSchema(session, inMatch?.[1] || undefined);
        const tables = await this.engine.listTables(database, schema);
        const wanted = tables.filter((table) =>
          object === 'objects'
            ? true
            : object === 'tables'
              ? table.kind === 'TABLE'
              : table.kind === 'VIEW',
        );

        if (object === 'objects' || terse) {
          // dbt's relation cache selects database_name, schema_name, name, kind,
          // is_dynamic and is_iceberg from this result set and raises if any of
          // them is absent, so the terse shape has to carry all six.
          const rows = wanted.map((table) => [
            new Date(),
            table.name,
            table.kind,
            database,
            schema,
            'N',
            'N',
          ]);
          return finish(
            [
              { name: 'created_on', duckType: 'TIMESTAMP_TZ' },
              { name: 'name', duckType: 'VARCHAR' },
              { name: 'kind', duckType: 'VARCHAR' },
              { name: 'database_name', duckType: 'VARCHAR' },
              { name: 'schema_name', duckType: 'VARCHAR' },
              { name: 'is_dynamic', duckType: 'VARCHAR' },
              { name: 'is_iceberg', duckType: 'VARCHAR' },
            ],
            rows,
          );
        }

        const rows = wanted.map((table) => [
          new Date(),
          table.name,
          database,
          schema,
          table.kind,
          '',
          '',
          table.rowCount,
          null,
          'SYSADMIN',
          '1',
          null,
          'OFF',
          'OFF',
          null,
          null,
          'N',
          'ACCOUNTADMIN',
        ]);
        return finish(
          [
            { name: 'created_on', duckType: 'TIMESTAMP_TZ' },
            { name: 'name', duckType: 'VARCHAR' },
            { name: 'database_name', duckType: 'VARCHAR' },
            { name: 'schema_name', duckType: 'VARCHAR' },
            { name: 'kind', duckType: 'VARCHAR' },
            { name: 'comment', duckType: 'VARCHAR' },
            { name: 'cluster_by', duckType: 'VARCHAR' },
            { name: 'rows', duckType: 'BIGINT' },
            { name: 'bytes', duckType: 'BIGINT' },
            { name: 'owner', duckType: 'VARCHAR' },
            { name: 'retention_time', duckType: 'VARCHAR' },
            { name: 'dropped_on', duckType: 'TIMESTAMP_TZ' },
            { name: 'automatic_clustering', duckType: 'VARCHAR' },
            { name: 'search_optimization', duckType: 'VARCHAR' },
            { name: 'search_optimization_progress', duckType: 'BIGINT' },
            { name: 'search_optimization_bytes', duckType: 'BIGINT' },
            { name: 'is_external', duckType: 'VARCHAR' },
            { name: 'owner_role_type', duckType: 'VARCHAR' },
          ],
          rows,
        );
      }

      case 'columns': {
        const target = inMatch?.[1];
        if (!target) throw compilationError('SHOW COLUMNS requires IN <table>.');
        const resolved = resolveTable(session, target);
        const columns = await this.engine.describeTable(resolved.database, resolved.schema, resolved.name);
        if (columns.length === 0) throw objectNotFound('TABLE', `${resolved.database}.${resolved.schema}.${resolved.name}`);
        const rows = columns.map((column) => [
          resolved.name,
          resolved.schema,
          column.name,
          toSnowflakeTypeName(column.duckType),
          column.nullable ? 'Y' : 'N',
          null,
          'COLUMN',
          null,
          null,
          resolved.database,
          'N',
          'ACCOUNTADMIN',
        ]);
        return finish(
          [
            { name: 'table_name', duckType: 'VARCHAR' },
            { name: 'schema_name', duckType: 'VARCHAR' },
            { name: 'column_name', duckType: 'VARCHAR' },
            { name: 'data_type', duckType: 'VARCHAR' },
            { name: 'null?', duckType: 'VARCHAR' },
            { name: 'default', duckType: 'VARCHAR' },
            { name: 'kind', duckType: 'VARCHAR' },
            { name: 'expression', duckType: 'VARCHAR' },
            { name: 'comment', duckType: 'VARCHAR' },
            { name: 'database_name', duckType: 'VARCHAR' },
            { name: 'autoincrement', duckType: 'VARCHAR' },
            { name: 'owner', duckType: 'VARCHAR' },
          ],
          rows,
          2,
        );
      }

      case 'functions': {
        // dbt probes for user-defined functions when it builds its relation
        // cache; an empty set is the truth here, but the columns must exist.
        return finish(
          [
            { name: 'created_on', duckType: 'TIMESTAMP_TZ' },
            { name: 'catalog_name', duckType: 'VARCHAR' },
            { name: 'name', duckType: 'VARCHAR' },
            { name: 'schema_name', duckType: 'VARCHAR' },
            { name: 'is_builtin', duckType: 'VARCHAR' },
            { name: 'is_aggregate', duckType: 'VARCHAR' },
            { name: 'is_ansi', duckType: 'VARCHAR' },
            { name: 'min_num_args', duckType: 'BIGINT' },
            { name: 'max_num_args', duckType: 'BIGINT' },
            { name: 'argument_signature', duckType: 'VARCHAR' },
            { name: 'data_type', duckType: 'VARCHAR' },
            { name: 'character_maximum_length', duckType: 'BIGINT' },
            { name: 'numeric_precision', duckType: 'BIGINT' },
            { name: 'numeric_scale', duckType: 'BIGINT' },
            { name: 'language', duckType: 'VARCHAR' },
            { name: 'is_secure', duckType: 'VARCHAR' },
            { name: 'is_external_function', duckType: 'VARCHAR' },
          ],
          [],
        );
      }

      case 'warehouses': {
        const rows = [...this.catalog.warehouses.values()].map((warehouse) => [
          warehouse.name,
          warehouse.state,
          'STANDARD',
          warehouse.size,
          '1',
          '1',
          '1',
          '0',
          '0',
          warehouse.name === session.warehouse ? 'Y' : 'N',
          warehouse.name === session.warehouse ? 'Y' : 'N',
          String(warehouse.autoSuspendSeconds),
          warehouse.autoResume ? 'true' : 'false',
          '0',
          '0',
          '0',
          '0',
          new Date(),
          new Date(),
          new Date(),
          'SYSADMIN',
          '',
          null,
        ]);
        return finish(
          [
            { name: 'name', duckType: 'VARCHAR' },
            { name: 'state', duckType: 'VARCHAR' },
            { name: 'type', duckType: 'VARCHAR' },
            { name: 'size', duckType: 'VARCHAR' },
            { name: 'min_cluster_count', duckType: 'VARCHAR' },
            { name: 'max_cluster_count', duckType: 'VARCHAR' },
            { name: 'started_clusters', duckType: 'VARCHAR' },
            { name: 'running', duckType: 'VARCHAR' },
            { name: 'queued', duckType: 'VARCHAR' },
            { name: 'is_default', duckType: 'VARCHAR' },
            { name: 'is_current', duckType: 'VARCHAR' },
            { name: 'auto_suspend', duckType: 'VARCHAR' },
            { name: 'auto_resume', duckType: 'VARCHAR' },
            { name: 'available', duckType: 'VARCHAR' },
            { name: 'provisioning', duckType: 'VARCHAR' },
            { name: 'quiescing', duckType: 'VARCHAR' },
            { name: 'other', duckType: 'VARCHAR' },
            { name: 'created_on', duckType: 'TIMESTAMP_TZ' },
            { name: 'resumed_on', duckType: 'TIMESTAMP_TZ' },
            { name: 'updated_on', duckType: 'TIMESTAMP_TZ' },
            { name: 'owner', duckType: 'VARCHAR' },
            { name: 'comment', duckType: 'VARCHAR' },
            { name: 'resource_monitor', duckType: 'VARCHAR' },
          ],
          rows,
        );
      }

      case 'roles': {
        const rows = [...this.catalog.roles.keys()].map((role) => [
          new Date(),
          role,
          'N',
          role === session.role ? 'Y' : 'N',
          'N',
          '0',
          '0',
          null,
          'ACCOUNTADMIN',
          '',
        ]);
        return finish(
          [
            { name: 'created_on', duckType: 'TIMESTAMP_TZ' },
            { name: 'name', duckType: 'VARCHAR' },
            { name: 'is_default', duckType: 'VARCHAR' },
            { name: 'is_current', duckType: 'VARCHAR' },
            { name: 'is_inherited', duckType: 'VARCHAR' },
            { name: 'assigned_to_users', duckType: 'VARCHAR' },
            { name: 'granted_to_roles', duckType: 'VARCHAR' },
            { name: 'granted_roles', duckType: 'VARCHAR' },
            { name: 'owner', duckType: 'VARCHAR' },
            { name: 'comment', duckType: 'VARCHAR' },
          ],
          rows,
        );
      }

      case 'stages': {
        const rows = [...this.catalog.stages.values()].map((stage) => [
          new Date(),
          stage.name,
          stage.database,
          stage.schema,
          stage.url,
          'INTERNAL',
          'SYSADMIN',
          '',
        ]);
        return finish(
          [
            { name: 'created_on', duckType: 'TIMESTAMP_TZ' },
            { name: 'name', duckType: 'VARCHAR' },
            { name: 'database_name', duckType: 'VARCHAR' },
            { name: 'schema_name', duckType: 'VARCHAR' },
            { name: 'url', duckType: 'VARCHAR' },
            { name: 'type', duckType: 'VARCHAR' },
            { name: 'owner', duckType: 'VARCHAR' },
            { name: 'comment', duckType: 'VARCHAR' },
          ],
          rows,
        );
      }

      case 'parameters': {
        const rows = [...session.parameters.entries()].map(([key, value]) => [
          key,
          value,
          value,
          'SESSION',
          `${key} session parameter`,
          typeof value === 'number' ? 'NUMBER' : 'STRING',
        ]);
        return finish(
          [
            { name: 'key', duckType: 'VARCHAR' },
            { name: 'value', duckType: 'VARCHAR' },
            { name: 'default', duckType: 'VARCHAR' },
            { name: 'level', duckType: 'VARCHAR' },
            { name: 'description', duckType: 'VARCHAR' },
            { name: 'type', duckType: 'VARCHAR' },
          ],
          rows,
          0,
        );
      }

      case 'grants': {
        return finish(
          [
            { name: 'created_on', duckType: 'TIMESTAMP_TZ' },
            { name: 'role', duckType: 'VARCHAR' },
            { name: 'granted_to', duckType: 'VARCHAR' },
            { name: 'grantee_name', duckType: 'VARCHAR' },
            { name: 'grant_option', duckType: 'VARCHAR' },
            { name: 'granted_by', duckType: 'VARCHAR' },
          ],
          [],
        );
      }

      case 'users': {
        return finish(
          [
            { name: 'name', duckType: 'VARCHAR' },
            { name: 'created_on', duckType: 'TIMESTAMP_TZ' },
            { name: 'login_name', duckType: 'VARCHAR' },
            { name: 'display_name', duckType: 'VARCHAR' },
            { name: 'email', duckType: 'VARCHAR' },
            { name: 'default_role', duckType: 'VARCHAR' },
            { name: 'default_warehouse', duckType: 'VARCHAR' },
          ],
          [[session.user, new Date(), session.user, session.user, null, 'SYSADMIN', session.warehouse]],
          0,
        );
      }

      case 'file formats': {
        return finish(
          [
            { name: 'created_on', duckType: 'TIMESTAMP_TZ' },
            { name: 'name', duckType: 'VARCHAR' },
            { name: 'database_name', duckType: 'VARCHAR' },
            { name: 'schema_name', duckType: 'VARCHAR' },
            { name: 'type', duckType: 'VARCHAR' },
            { name: 'owner', duckType: 'VARCHAR' },
            { name: 'comment', duckType: 'VARCHAR' },
          ],
          [],
        );
      }

      default: {
        return finish([{ name: 'name', duckType: 'VARCHAR' }], []);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // DESCRIBE
  // ---------------------------------------------------------------------------

  private async handleDescribe(statement: string, session: Session): Promise<Outcome> {
    const match = /^desc(?:ribe)?\s+(?:table\s+|view\s+)?(.+)$/i.exec(statement);
    if (!match) throw compilationError(`Unsupported DESCRIBE statement: ${statement}`);

    const resolved = resolveTable(session, match[1]);
    const columns = await this.engine.describeTable(resolved.database, resolved.schema, resolved.name);
    if (columns.length === 0) {
      throw objectNotFound(
        'TABLE',
        `${resolved.database}.${resolved.schema}.${resolved.name}`,
      );
    }

    const rows = columns.map((column) => [
      column.name,
      toSnowflakeTypeName(column.duckType),
      'COLUMN',
      column.nullable ? 'Y' : 'N',
      null,
      'N',
      'N',
      null,
      null,
      null,
      null,
    ]);

    return syntheticOutcome(
      [
        { name: 'name', duckType: 'VARCHAR' },
        { name: 'type', duckType: 'VARCHAR' },
        { name: 'kind', duckType: 'VARCHAR' },
        { name: 'null?', duckType: 'VARCHAR' },
        { name: 'default', duckType: 'VARCHAR' },
        { name: 'primary key', duckType: 'VARCHAR' },
        { name: 'unique key', duckType: 'VARCHAR' },
        { name: 'check', duckType: 'VARCHAR' },
        { name: 'expression', duckType: 'VARCHAR' },
        { name: 'comment', duckType: 'VARCHAR' },
        { name: 'policy name', duckType: 'VARCHAR' },
      ],
      rows,
      STATEMENT_TYPES.describe,
    );
  }

  // ---------------------------------------------------------------------------
  // Account-level DDL
  // ---------------------------------------------------------------------------

  private async handleAccountDdl(statement: string, session: Session): Promise<Outcome | null> {
    const create = /^create\s+(?:or\s+replace\s+)?(?:transient\s+)?(database|schema|warehouse|role|stage|file\s+format|user)\s+(?:if\s+not\s+exists\s+)?([\w$".]+)([\s\S]*)$/i.exec(
      statement,
    );
    if (create) {
      const object = create[1].toLowerCase().replace(/\s+/g, ' ');
      const name = create[2];
      const rest = create[3] ?? '';

      switch (object) {
        case 'database': {
          const key = normalizeName(name);
          const { created } = this.catalog.createDatabase(key);
          await this.engine.attachDatabase(key);
          this.catalog.createSchema(key, 'PUBLIC');
          await this.engine.createSchema(key, 'PUBLIC');
          return statusOutcome(
            created ? `${key} successfully created.` : `${key} already exists, statement succeeded.`,
            STATEMENT_TYPES.create,
          );
        }
        case 'schema': {
          const resolved = resolveSchema(session, name);
          if (!this.catalog.getDatabase(resolved.database)) {
            throw objectNotFound('DATABASE', resolved.database);
          }
          const { created } = this.catalog.createSchema(resolved.database, resolved.schema);
          await this.engine.createSchema(resolved.database, resolved.schema);
          return statusOutcome(
            created
              ? `${resolved.schema} successfully created.`
              : `${resolved.schema} already exists, statement succeeded.`,
            STATEMENT_TYPES.create,
          );
        }
        case 'warehouse': {
          const { created, name: key } = this.catalog.createWarehouse(name);
          return statusOutcome(
            created ? `${key} successfully created.` : `${key} already exists, statement succeeded.`,
            STATEMENT_TYPES.create,
          );
        }
        case 'role': {
          const { created, name: key } = this.catalog.createRole(name);
          return statusOutcome(
            created ? `${key} successfully created.` : `${key} already exists, statement succeeded.`,
            STATEMENT_TYPES.create,
          );
        }
        case 'stage': {
          const resolved = splitName(name);
          const stageName = resolved.at(-1) ?? name;
          const database = resolved.length >= 3 ? resolved[0] : session.database;
          const schema = resolved.length >= 2 ? resolved[1] : session.schema;
          const directory = await this.stages.directoryFor(database, schema, stageName);
          this.catalog.createStage({
            database,
            schema,
            name: stageName,
            url: /url\s*=\s*'([^']*)'/i.exec(rest)?.[1] ?? null,
            directory,
          });
          return statusOutcome(`Stage area ${stageName} successfully created.`, STATEMENT_TYPES.create);
        }
        case 'file format':
          return statusOutcome('File format successfully created.', STATEMENT_TYPES.create);
        case 'user':
          return statusOutcome('User successfully created.', STATEMENT_TYPES.create);
        default:
          return null;
      }
    }

    const drop = /^drop\s+(database|schema|warehouse|role|stage|file\s+format|user)\s+(?:if\s+exists\s+)?([\w$".]+)([\s\S]*)$/i.exec(
      statement,
    );
    if (drop) {
      const object = drop[1].toLowerCase().replace(/\s+/g, ' ');
      const name = drop[2];
      const rest = drop[3] ?? '';
      switch (object) {
        case 'database': {
          const key = normalizeName(name);
          this.catalog.dropDatabase(key);
          await this.engine.detachDatabase(key);
          if (session.database === key) {
            session.database = this.catalog.databases.keys().next().value ?? 'SNOWTEST';
          }
          return statusOutcome(`${key} successfully dropped.`, STATEMENT_TYPES.drop);
        }
        case 'schema': {
          const resolved = resolveSchema(session, name);
          this.catalog.dropSchema(resolved.database, resolved.schema);
          await this.engine.dropSchema(resolved.database, resolved.schema, /cascade/i.test(rest)).catch(
            () => undefined,
          );
          return statusOutcome(`${resolved.schema} successfully dropped.`, STATEMENT_TYPES.drop);
        }
        case 'warehouse': {
          const key = normalizeName(name);
          this.catalog.dropWarehouse(key);
          return statusOutcome(`${key} successfully dropped.`, STATEMENT_TYPES.drop);
        }
        case 'role': {
          const key = normalizeName(name);
          this.catalog.dropRole(key);
          return statusOutcome(`${key} successfully dropped.`, STATEMENT_TYPES.drop);
        }
        case 'stage': {
          const resolved = splitName(name);
          const database = resolved.length >= 3 ? resolved[0] : session.database;
          const schema = resolved.length >= 2 ? resolved[1] : session.schema;
          const stageName = resolved.at(-1) ?? name;
          this.catalog.dropStage(database, schema, stageName);
          await this.stages.removeAll(await this.stages.directoryFor(database, schema, stageName));
          return statusOutcome('Stage area successfully dropped.', STATEMENT_TYPES.drop);
        }
        case 'file format':
          return statusOutcome('File format successfully dropped.', STATEMENT_TYPES.drop);
        case 'user':
          return statusOutcome('User successfully dropped.', STATEMENT_TYPES.drop);
        default:
          return null;
      }
    }

    // ALTER WAREHOUSE / ALTER ROLE / ALTER DATABASE are accepted as no-ops;
    // ALTER TABLE falls through to DuckDB.
    if (/^alter\s+(warehouse|role|database|schema|session\s+parameter)\b/i.test(statement)) {
      return statusOutcome('Statement executed successfully.', STATEMENT_TYPES.alter);
    }

    if (/^comment\s+on\b/i.test(statement)) {
      return statusOutcome('Comment set.', STATEMENT_TYPES.alter);
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Stages: COPY INTO / LIST / REMOVE
  // ---------------------------------------------------------------------------

  /** `@name`, `@schema.name`, `@db.schema.name` → stage plus optional file path. */
  private resolveStageRef(
    session: Session,
    reference: string,
  ): { database: string; schema: string; name: string; filePath: string } {
    const cleaned = reference.trim().replace(/^'|'$/g, '');
    if (!cleaned.startsWith('@')) {
      throw compilationError(`Expected a stage reference starting with '@', got '${reference}'.`);
    }

    // `@~` and `@%table` are user/table stages; they have no directory here.
    const body = cleaned.slice(1).replace(/%[\w$]+%$/g, '');
    const slash = body.indexOf('/');
    const stagePart = slash === -1 ? body : body.slice(0, slash);
    const filePath = slash === -1 ? '' : body.slice(slash + 1);
    const parts = splitName(stagePart);
    if (parts.length === 0) throw compilationError(`Invalid stage reference '${reference}'.`);

    const name = parts[parts.length - 1];
    if (parts.length >= 3) return { database: parts[0], schema: parts[1], name, filePath };
    if (parts.length === 2) return { database: session.database, schema: parts[0], name, filePath };
    return { database: session.database, schema: session.schema, name, filePath };
  }

  private async handleCopyInto(statement: string, session: Session): Promise<Outcome> {
    const match = /^copy\s+into\s+([\w$".]+)\s+from\s+(@[^\s]+|'[^']*')([\s\S]*)$/i.exec(statement);
    if (!match) {
      throw compilationError(
        'Unsupported COPY statement. Snowtest loads from a stage: ' +
          'COPY INTO <table> FROM @stage/<path> FILE_FORMAT = (TYPE = CSV SKIP_HEADER = 1).',
      );
    }

    const target = resolveTable(session, match[1]);
    if (!this.catalog.getDatabase(target.database)) {
      throw objectNotFound('DATABASE', target.database);
    }

    const stageRef = this.resolveStageRef(session, match[2]);
    const rest = match[3] ?? '';
    const directory = await this.stages.directoryFor(
      stageRef.database,
      stageRef.schema,
      stageRef.name,
    );

    const pattern = /pattern\s*=\s*'([^']*)'/i.exec(rest)?.[1] ?? null;
    const purge = /purge\s*=\s*true/i.test(rest);
    const options = this.copyOptions(rest);

    const files = (await this.stages.list(directory, pattern)).filter((file) =>
      this.stagePathMatches(file.name, stageRef.filePath),
    );

    if (files.length === 0) {
      throw compilationError(
        `Remote file '${stageRef.filePath || stageRef.name}' was not found on stage '${stageRef.name}'.`,
      );
    }

    const connection = await this.connectionFor(session);
    const rows: unknown[][] = [];

    for (const file of files) {
      const reader = this.stageReader(file.name, join(directory, file.name), options);
      const result = await connection.execute(`INSERT INTO ${match[1]} SELECT * FROM ${reader}`);
      rows.push([
        `${stageRef.name}/${file.name}`,
        'LOADED',
        String(result.rowsChanged),
        String(result.rowsChanged),
        '1',
        '0',
        null,
        null,
        null,
        null,
      ]);
      if (purge) await this.stages.remove(directory, file.name);
    }

    return syntheticOutcome(
      [
        { name: 'file', duckType: 'VARCHAR' },
        { name: 'status', duckType: 'VARCHAR' },
        { name: 'rows_parsed', duckType: 'BIGINT' },
        { name: 'rows_loaded', duckType: 'BIGINT' },
        { name: 'error_limit', duckType: 'BIGINT' },
        { name: 'errors_seen', duckType: 'BIGINT' },
        { name: 'first_error', duckType: 'VARCHAR' },
        { name: 'first_error_line', duckType: 'BIGINT' },
        { name: 'first_error_character', duckType: 'BIGINT' },
        { name: 'first_error_column_name', duckType: 'VARCHAR' },
      ],
      rows,
      STATEMENT_TYPES.copy,
    );
  }

  private copyOptions(rest: string): {
    type: 'csv' | 'json' | 'parquet';
    header: boolean;
    delimiter: string | null;
    quote: string | null;
    nullIf: string | null;
  } {
    const declared = /\btype\s*=\s*'?(\w+)'?/i.exec(rest)?.[1]?.toLowerCase();
    const type = declared === 'json' ? 'json' : declared === 'parquet' ? 'parquet' : 'csv';
    const skipHeader = /\bskip_header\s*=\s*(\d+)/i.exec(rest)?.[1];
    const nullIf = /null_if\s*=\s*(?:\(\s*)?'([^']*)'/i.exec(rest)?.[1] ?? null;

    return {
      type,
      header: skipHeader !== undefined ? Number(skipHeader) > 0 : false,
      delimiter: /(?:field_delimiter|delimiter)\s*=\s*'([^']*)'/i.exec(rest)?.[1] ?? null,
      quote: /field_optionally_enclosed_by\s*=\s*'([^']*)'/i.exec(rest)?.[1] ?? null,
      nullIf,
    };
  }

  /** DuckDB reader for one staged file, honouring the COPY file-format options. */
  private stageReader(
    fileName: string,
    absolutePath: string,
    options: ReturnType<StatementRouter['copyOptions']>,
  ): string {
    const path = `'${absolutePath.replace(/'/g, "''")}'`;
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

    if (options.type === 'json' || /\.(json|ndjson|jsonl)(\.gz)?$/i.test(fileName)) {
      return `read_json_auto(${path})`;
    }
    if (options.type === 'parquet' || /\.parquet$/i.test(fileName)) {
      return `read_parquet(${path})`;
    }

    const args = [path, `header=${options.header}`];
    if (options.delimiter) args.push(`delim=${quote(options.delimiter)}`);
    if (options.quote) args.push(`quote=${quote(options.quote)}`);
    if (options.nullIf) args.push(`nullstr=${quote(options.nullIf)}`);
    return `read_csv_auto(${args.join(', ')})`;
  }

  private async handleList(statement: string, session: Session): Promise<Outcome> {
    const match = /^(?:list|ls)\s+(@[^\s]+)([\s\S]*)$/i.exec(statement);
    if (!match) throw compilationError(`Unsupported LIST statement: ${statement}`);

    const stageRef = this.resolveStageRef(session, match[1]);
    const directory = await this.stages.directoryFor(
      stageRef.database,
      stageRef.schema,
      stageRef.name,
    );
    const pattern = /pattern\s*=\s*'([^']*)'/i.exec(match[2] ?? '')?.[1] ?? null;
    const files = (await this.stages.list(directory, pattern)).filter((file) =>
      this.stagePathMatches(file.name, stageRef.filePath),
    );

    return syntheticOutcome(
      [
        { name: 'name', duckType: 'VARCHAR' },
        { name: 'size', duckType: 'BIGINT' },
        { name: 'md5', duckType: 'VARCHAR' },
        { name: 'last_modified', duckType: 'TIMESTAMP_TZ' },
      ],
      files.map((file) => [file.name, String(file.size), null, file.modified]),
      STATEMENT_TYPES.show,
    );
  }

  private async handleRemove(statement: string, session: Session): Promise<Outcome> {
    const match = /^(?:remove|rm)\s+(@[^\s]+)([\s\S]*)$/i.exec(statement);
    if (!match) throw compilationError(`Unsupported REMOVE statement: ${statement}`);

    const stageRef = this.resolveStageRef(session, match[1]);
    const directory = await this.stages.directoryFor(
      stageRef.database,
      stageRef.schema,
      stageRef.name,
    );
    const names = (await this.stages.list(directory, null))
      .filter((file) => this.stagePathMatches(file.name, stageRef.filePath))
      .map((file) => file.name);
    const removed = await this.stages.removeFiles(directory, names);

    return syntheticOutcome(
      [
        { name: 'name', duckType: 'VARCHAR' },
        { name: 'result', duckType: 'VARCHAR' },
      ],
      [[`${stageRef.name}/${stageRef.filePath}`, removed > 0 ? 'removed' : 'skipped']],
      STATEMENT_TYPES.drop,
    );
  }

  /**
   * Does a stored file satisfy a stage path such as `data/orders.csv`?
   *
   * The connector's local-filesystem stage client copies uploads in flat by
   * basename, so `PUT … @stage/data/x.csv` lands as `x.csv`. Accept either the
   * literal prefix or a match on the final component.
   */
  private stagePathMatches(fileName: string, stagePath: string): boolean {
    if (!stagePath) return true;
    const wanted = stagePath.replace(/^\/+|\/+$/g, '');
    if (!wanted) return true;
    const last = wanted.split('/').pop() as string;
    if (
      fileName === wanted ||
      fileName.startsWith(`${wanted}/`) ||
      fileName.endsWith(`/${wanted}`) ||
      fileName === last
    ) {
      return true;
    }
    // A flat file answers a directory-style prefix (`@stage/data/`): the
    // local-filesystem stage client copies uploads in by basename, so the prefix
    // only ever existed on the client side. A file-name prefix must still match.
    return !fileName.includes('/') && !(wanted.split('/').pop() ?? '').includes('.');
  }

  /** PUT: hand the client a local-filesystem stage so it can copy the file in. */
  private async handlePut(statement: string, session: Session): Promise<Outcome> {
    const match = /^put\s+'?file:\/\/([^'@\s]+)'?\s+(@[^\s]+)([\s\S]*)$/i.exec(statement);
    if (!match) {
      throw compilationError(
        "Unsupported PUT statement. Use PUT file:///local/path @stage/path [AUTO_COMPRESS = FALSE].",
      );
    }

    const localPath = match[1].startsWith('/') ? match[1] : `/${match[1]}`;
    const stageRef = this.resolveStageRef(session, match[2]);
    const directory = await this.stages.directoryFor(
      stageRef.database,
      stageRef.schema,
      stageRef.name,
    );
    const autoCompress = /auto_compress\s*=\s*true/i.test(match[3] ?? '');

    return {
      columns: [],
      rows: [],
      statementTypeId: STATEMENT_TYPES.copy,
      rowsAffected: 0,
      fileTransfer: {
        command: 'UPLOAD',
        src_locations: [localPath],
        parallel: 1,
        overwrite: true,
        autoCompress,
        sourceCompression: 'auto_detect',
        stageInfo: {
          locationType: 'LOCAL_FS',
          location: directory,
          path: stageRef.filePath,
          region: '',
          creds: {},
          isClientSideEncrypted: false,
        },
      },
    };
  }

  /** GET: hand the client the staged files to copy back to a local directory. */
  private async handleGet(statement: string, session: Session): Promise<Outcome> {
    const match = /^get\s+(@[^\s]+)\s+'?file:\/\/([^'\s]+)'?([\s\S]*)$/i.exec(statement);
    if (!match) {
      throw compilationError('Unsupported GET statement. Use GET @stage/path file:///local/dir/.');
    }

    const stageRef = this.resolveStageRef(session, match[1]);
    const directory = await this.stages.directoryFor(
      stageRef.database,
      stageRef.schema,
      stageRef.name,
    );
    const files = (await this.stages.list(directory, null)).filter((file) =>
      this.stagePathMatches(file.name, stageRef.filePath),
    );
    if (files.length === 0) {
      throw compilationError(
        `Remote file '${stageRef.filePath || stageRef.name}' was not found on stage '${stageRef.name}'.`,
      );
    }

    return {
      columns: [],
      rows: [],
      statementTypeId: STATEMENT_TYPES.copy,
      rowsAffected: 0,
      fileTransfer: {
        command: 'DOWNLOAD',
        src_locations: files.map((file) => `/${file.name}`),
        localLocation: match[2],
        parallel: 1,
        overwrite: true,
        stageInfo: {
          locationType: 'LOCAL_FS',
          location: directory,
          path: '',
          region: '',
          creds: {},
          isClientSideEncrypted: false,
        },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Engine passthrough
  // ---------------------------------------------------------------------------

  private async runOnEngine(
    statement: string,
    session: Session,
    options: ExecuteOptions,
  ): Promise<Outcome> {
    const connection = await this.connectionFor(session);

    // A qualified CREATE/INSERT can target a schema that does not exist yet;
    // refuse it the way Snowflake would rather than letting DuckDB guess.
    const target = /^(?:create|insert\s+into|update|delete\s+from|drop|alter)\s+(?:or\s+replace\s+)?(?:table\s+|view\s+)?([\w$".]+)/i.exec(
      statement,
    );
    if (target && !/^(table|view|if|temporary|temp)$/i.test(target[1])) {
      const parts = splitName(target[1]);
      if (parts.length >= 3) {
        if (!this.catalog.getDatabase(parts[0])) throw objectNotFound('DATABASE', parts[0]);
        if (!this.catalog.getSchema(parts[0], parts[1])) {
          throw objectNotFound('SCHEMA', `${parts[0]}.${parts[1]}`);
        }
      }
    }

    const translated = rewrite(
      statement,
      {
        database: session.database,
        schema: session.schema,
        role: session.role,
        user: session.user,
        warehouse: session.warehouse,
      },
      options.bindings ?? [],
    );

    const result = await connection.execute(translated);
    const columns = result.columns.map((column) =>
      buildColumn(column.name, column.duckType, true, {
        database: session.database,
        schema: session.schema,
        table: '',
      }),
    );

    const verb = /^([a-z]+)/i.exec(statement)?.[1]?.toUpperCase() ?? '';

    // DuckDB names the DML row-count column `Count`; Snowflake calls it
    // `number of rows inserted`, which is what clients print.
    if (
      columns.length === 1 &&
      columns[0].name.toLowerCase() === 'count' &&
      (verb === 'INSERT' || verb === 'UPDATE' || verb === 'DELETE')
    ) {
      columns[0].name = 'number of rows inserted';
    }

    const statementTypeId =
      verb === 'SELECT' || verb === 'WITH' || verb === 'VALUES'
        ? STATEMENT_TYPES.select
        : verb === 'INSERT'
          ? STATEMENT_TYPES.insert
          : verb === 'UPDATE'
            ? STATEMENT_TYPES.update
            : verb === 'DELETE'
              ? STATEMENT_TYPES.delete
              : verb === 'MERGE'
                ? STATEMENT_TYPES.merge
                : verb === 'CREATE'
                  ? STATEMENT_TYPES.create
                  : verb === 'DROP'
                    ? STATEMENT_TYPES.drop
                    : verb === 'ALTER'
                      ? STATEMENT_TYPES.alter
                      : STATEMENT_TYPES.select;

    const rows = result.rows;

    if (rows.length === 0 && result.rowsChanged > 0) {
      return {
        columns: [buildColumn('number of rows inserted', 'BIGINT', false, { database: '', schema: '', table: '' })],
        rows: [[String(result.rowsChanged)]],
        statementTypeId,
        rowsAffected: result.rowsChanged,
      };
    }

    if (rows.length === 0 && (verb === 'CREATE' || verb === 'DROP' || verb === 'ALTER')) {
      return statusOutcome('Statement executed successfully.', statementTypeId);
    }

    return { columns, rows, statementTypeId, rowsAffected: result.rowsChanged };
  }
}

/** Split `A = 1, B = 'x'` on top-level commas. */
function splitAssignments(input: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let depth = 0;
  let current = '';
  const parts: string[] = [];
  for (const ch of input) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) parts.push(current);

  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    let value = part.slice(eq + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    out.push([key, value]);
  }
  return out;
}

export { SnowflakeError };
