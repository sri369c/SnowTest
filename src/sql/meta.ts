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

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { Catalog, normalizeName } from '../engine/catalog.js';
import { rewrite, splitColumnListCtas, toSqlLiteral, type ColumnListCtas } from './dialect.js';
import type { Outcome } from './outcome.js';
import { Engine, quoteIdent, type EngineConnection, type QueryResult, type SequenceInfo } from '../engine/engine.js';
import {
  SnowflakeError,
  compilationError,
  mapEngineError,
  noCurrentContext,
  objectNotFound,
  unsupported,
} from './errors.js';
import type { DataDir } from '../engine/persist.js';
import type { Session } from '../engine/session.js';
import { StageStore } from './stage.js';
import { StatementInterceptor } from '../interceptor.js';
import { formatTimestamp, toSnowflakeType, toSnowflakeTypeName, type SnowflakeColumn } from '../http/types.js';


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
/** The value a sequence hands out next; DuckDB records the last one issued. */
function nextValueOf(sequence: SequenceInfo): number {
  return sequence.lastValue === null ? sequence.startValue : sequence.lastValue + sequence.increment;
}

/** The five columns `DESCRIBE STAGE` and `DESCRIBE FILE FORMAT` answer in. */
const DESCRIBE_PROPERTY_COLUMNS = [
  { name: 'parent_property', duckType: 'VARCHAR' },
  { name: 'property', duckType: 'VARCHAR' },
  { name: 'property_type', duckType: 'VARCHAR' },
  { name: 'property_value', duckType: 'VARCHAR' },
  { name: 'property_default', duckType: 'VARCHAR' },
];

/** Object kinds named without a container, so a grant on one is recorded as written. */
const ACCOUNT_SCOPED_GRANT_KINDS = new Set([
  'ACCOUNT',
  'DATABASE',
  'WAREHOUSE',
  'ROLE',
  'USER',
  'INTEGRATION',
]);

/**
 * The name a grant is recorded (and looked up) under, resolved the way
 * Snowflake resolves it when the statement runs: `GRANT … ON TABLE t` records
 * `DB.SCHEMA.T`, which is what lets a later `DROP TABLE t` find it again.
 */
function grantedNameFor(session: Session, grantedOn: string, reference: string): string {
  const pieces = canonicalName(reference).split('.');
  if (ACCOUNT_SCOPED_GRANT_KINDS.has(grantedOn)) return pieces.join('.');
  if (grantedOn === 'SCHEMA') {
    if (pieces.length >= 2) return pieces.join('.');
    return session.database ? `${session.database}.${pieces[0]}` : pieces[0];
  }
  // Table-like objects are `db.schema.name`; a two-part name is missing only the
  // database, which the drop will resolve, so it must be filled in here too.
  if (pieces.length >= 3) return pieces.join('.');
  if (pieces.length === 2) {
    return session.database ? `${session.database}.${pieces.join('.')}` : pieces.join('.');
  }
  if (session.database && session.schema) return `${session.database}.${session.schema}.${pieces[0]}`;
  if (session.database) return `${session.database}.${pieces[0]}`;
  return pieces[0];
}

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
      // Snowflake string literals take backslash escapes (`'it\'s'`).
      if (quote === "'" && ch === '\\' && i + 1 < sql.length) {
        out += sql[i + 1];
        i += 2;
        continue;
      }
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

/**
 * Split a request into its `;`-separated statements, ignoring separators inside
 * string literals, quoted identifiers, comments and `$$…$$` bodies.
 *
 * Snowflake runs each statement in turn: the driver protocol answers with the
 * last result, the SQL API with one per statement. Before this the whole request
 * went to DuckDB as one string, so routing followed the first statement and the
 * result was whichever one DuckDB chose to return.
 */
export function splitStatements(sql: string): string[] {
  const parts: string[] = [];
  let current = '';
  let i = 0;
  let quote: string | null = null;
  let dollar: string | null = null;

  while (i < sql.length) {
    const ch = sql[i];

    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        current += dollar;
        i += dollar.length;
        dollar = null;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (quote) {
      current += ch;
      // Snowflake string literals take backslash escapes (`'it\'s'`).
      if (quote === "'" && ch === '\\' && i + 1 < sql.length) {
        current += sql[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag) {
        dollar = tag[0];
        current += dollar;
        i += dollar.length;
        continue;
      }
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === ';') {
      parts.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }

  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** `CREATE [OR REPLACE] TABLE [IF NOT EXISTS] t CLONE src`, with any trailing AT/BEFORE. */
const CLONE_TABLE =
  /^create\s+(or\s+replace\s+)?(?:transient\s+)?table\s+(if\s+not\s+exists\s+)?([\w$".]+)\s+clone\s+([\w$".]+)([\s\S]*)$/i;

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

const qualifiedTable = (table: ResolvedTable): string =>
  `${quoteIdent(table.database)}.${quoteIdent(table.schema)}.${quoteIdent(table.name)}`;

const displayName = (table: ResolvedTable): string => `${table.database}.${table.schema}.${table.name}`;

/** One table name: up to three dot-separated parts, each bare or double-quoted. */
const TABLE_NAME = String.raw`((?:"[^"]*"|[\w$]+)(?:\s*\.\s*(?:"[^"]*"|[\w$]+)){0,2})`;

const ALTER_TABLE = new RegExp(
  String.raw`^alter\s+table\s+(if\s+exists\s+)?${TABLE_NAME}\s+` +
    String.raw`(cluster\s+by\s*\([\s\S]*\)|drop\s+clustering\s+key|suspend\s+recluster|resume\s+recluster|` +
    String.raw`rename\s+to\s+${TABLE_NAME}|swap\s+with\s+${TABLE_NAME})\s*$`,
  'i',
);

/** The one object a write/drop names: verb, modifiers, kind and `IF [NOT] EXISTS` skipped. */
const WRITE_TARGET = new RegExp(
  String.raw`^(?:create\s+(?:or\s+replace\s+)?(?:(?:local|global|temp|temporary|transient|volatile|secure|recursive|materialized)\s+)*` +
    String.raw`(?:table|view|sequence)|(?:drop|alter)\s+(?:table|view|sequence)|insert\s+into|merge\s+into|update|delete\s+from)` +
    String.raw`\s+(?:if\s+(?:not\s+)?exists\s+)?${TABLE_NAME}`,
  'i',
);

const operationOf = (statement: string): string => /^\w+/.exec(statement)?.[0].toUpperCase() ?? 'operation';

/** DuckDB's "X does not exist" for an unqualified X, in a session without context, is Snowflake's 090105/090106. */
function missingContext(error: unknown, statement: string, session: Session): SnowflakeError | null {
  if (session.database !== null && session.schema !== null) return null;
  const message = error instanceof Error ? error.message : String(error);
  const name = /(?:Table|View|Sequence) with name (.+?) does not exist/.exec(message)?.[1];
  if (!name) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const unqualified = new RegExp(String.raw`(?<![\w$".]|\.\s+)(?:"${escaped}"|${escaped})(?![\w$"]|\s*\.)`, 'i');
  if (!unqualified.test(statement)) return null;
  return noCurrentContext(session.database === null ? 'database' : 'schema', operationOf(statement));
}

/** Run `cleanup` after `error`, then rethrow `error`; a cleanup failure is appended, never substituted. */
export async function failAfter(error: unknown, cleanup: () => Promise<unknown>): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    const original = mapEngineError(error);
    const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    throw new SnowflakeError(
      original.code,
      `${original.message}\n(cleanup also failed: ${detail})`,
      original.sqlState,
      original.kind,
    );
  }
  throw error;
}

function currentDatabase(session: Session, operation = 'operation'): string {
  if (session.database === null) throw noCurrentContext('database', operation);
  return session.database;
}

function currentSchema(session: Session, operation = 'operation'): string {
  if (session.schema === null) throw noCurrentContext('schema', operation);
  return session.schema;
}

function resolveTable(session: Session, reference: string): ResolvedTable {
  const parts = splitName(reference);
  if (parts.length >= 3) {
    return { database: parts[0], schema: parts[1], name: parts.slice(2).join('.') };
  }
  if (parts.length === 2) {
    return { database: currentDatabase(session), schema: parts[0], name: parts[1] };
  }
  if (parts.length === 1) {
    return { database: currentDatabase(session), schema: currentSchema(session), name: parts[0] };
  }
  throw compilationError(`Invalid object name '${reference}'.`);
}

/** `x` or `db.x` naming a database, else the current one. */
function resolveDatabase(session: Session, reference: string | undefined): string {
  const parts = reference ? splitName(reference) : [];
  return parts.length > 0 ? parts[0] : currentDatabase(session);
}

function resolveSchema(session: Session, reference: string | undefined): { database: string; schema: string } {
  if (!reference) return { database: currentDatabase(session), schema: currentSchema(session) };
  const parts = splitName(reference);
  if (parts.length >= 2) return { database: parts[0], schema: parts[1] };
  if (parts.length === 1) {
    // `SHOW TABLES IN <db>` is valid, so a single part means database.
    if (session.catalog.getDatabase(parts[0])) {
      return { database: parts[0], schema: currentSchema(session) };
    }
    return { database: currentDatabase(session), schema: parts[0] };
  }
  return { database: currentDatabase(session), schema: currentSchema(session) };
}

/** SHOW STAGES scope like SHOW TABLES (current schema by default); `IN DATABASE` spans its schemas, `IN ACCOUNT` → null. */
function stageScope(session: Session, rest: string): { database: string; schema: string | null } | null {
  const match = /\bin\s+(?:(account|database|schema)\b\s*)?([\w$".]*)/i.exec(rest);
  const keyword = match?.[1]?.toUpperCase();
  const name = match?.[2] || undefined;
  if (keyword === 'ACCOUNT') return null;
  if (keyword === 'DATABASE') {
    const database = resolveDatabase(session, name);
    if (!session.catalog.getDatabase(database)) throw objectNotFound('DATABASE', database);
    return { database, schema: null };
  }
  const { database, schema } = resolveSchema(session, name);
  if (!session.catalog.getSchema(database, schema)) throw objectNotFound('SCHEMA', `${database}.${schema}`);
  return { database, schema };
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

/** Canonical form of a possibly-qualified object name, as SQL text supplies it. */
function canonicalName(raw: string): string {
  return raw
    .split('.')
    .map((part) => normalizeName(part))
    .join('.');
}

export class StatementRouter {
  /** Everything that happens around a statement, in one place. */
  private readonly interceptor: StatementInterceptor;

  constructor(
    private readonly engine: Engine,
    private readonly catalog: Catalog,
    readonly stages: StageStore = new StageStore(),
    private readonly dataDir: DataDir | null = null,
    /** Called after a database is dropped, so the server can clear every session's context. */
    private readonly onDatabaseDropped: (database: string) => void = () => {},
  ) {
    this.interceptor = new StatementInterceptor(engine, catalog);
  }

  private async connectionFor(session: Session): Promise<EngineConnection> {
    let connection = session.connection as EngineConnection | null;
    if (!connection) {
      connection = await this.engine.newConnection();
      session.connection = connection;
    }
    session.lastUsedAt = new Date();
    await connection.use(session.database, session.schema);
    return connection;
  }

  async execute(sql: string, session: Session, options: ExecuteOptions = {}): Promise<Outcome> {
    const statement = stripComments(sql).trim().replace(/;+\s*$/, '');
    if (statement.length === 0) {
      return statusOutcome('Statement executed successfully.', STATEMENT_TYPES.select);
    }

    return this.interceptor.run(statement, session, () => this.route(statement, session, options));
  }

  /** One statement, routed. `execute` wraps this so every statement is timed and noted. */
  private async route(statement: string, session: Session, options: ExecuteOptions): Promise<Outcome> {
    const verb = /^([a-z]+)/i.exec(statement)?.[1]?.toUpperCase() ?? '';

    // Explicit transactions are real. The session's own connection carries them,
    // so a failed statement aborts the transaction and ROLLBACK discards what the
    // client wrote. They used to be accepted and ignored, which meant a test that
    // asserted "the failed load left nothing behind" passed with the rows there.
    if (verb === 'BEGIN' || (verb === 'START' && /^start\s+transaction\b/i.test(statement))) {
      return this.handleBegin(session);
    }
    if (verb === 'COMMIT') return this.handleCommit(session);
    if (verb === 'ROLLBACK') return this.handleRollback(session);

    // dbt seeds the first batch of rows with `INSERT OVERWRITE INTO ...`, which
    // clears the table and inserts in one DML statement. DuckDB has no such
    // variant, so the two steps happen here.
    if (verb === 'INSERT' && /^insert\s+overwrite\b/i.test(statement)) {
      return this.handleInsertOverwrite(statement, session, options);
    }

    if (verb === 'USE') return this.handleUse(statement, session);
    if (verb === 'GRANT' || verb === 'REVOKE') return this.handleAccess(statement, session);
    if (verb === 'ALTER' && /^alter\s+session\b/i.test(statement)) {
      return this.handleAlterSession(statement, session);
    }
    if (verb === 'ALTER' && /^alter\s+sequence\b/i.test(statement)) {
      return this.handleAlterSequence(statement, session);
    }
    if (verb === 'PUT') return this.handlePut(statement, session);
    if (verb === 'GET') return this.handleGet(statement, session);
    if (verb === 'COPY') return this.handleCopyInto(statement, session);
    if (verb === 'LIST' || verb === 'LS') return this.handleList(statement, session);
    if (verb === 'REMOVE' || verb === 'RM') return this.handleRemove(statement, session);
    if (verb === 'SHOW') return this.handleShow(statement, session);
    if (verb === 'DESCRIBE' || verb === 'DESC') return this.handleDescribe(statement, session);
    if (verb === 'CREATE') {
      const ctas = splitColumnListCtas(statement);
      if (ctas) return this.handleColumnListCtas(ctas, session, options);
      const clone = CLONE_TABLE.exec(statement);
      if (clone) {
        return this.handleCloneTable(
          clone[1] !== undefined,
          clone[2] !== undefined,
          clone[3],
          clone[4],
          clone[5] ?? '',
          session,
        );
      }
    }
    if (verb === 'ALTER' && /^alter\s+table\b/i.test(statement)) {
      const handled = await this.handleAlterTable(statement, session);
      if (handled) return handled;
    }
    if (verb === 'CREATE' || verb === 'DROP' || verb === 'ALTER' || verb === 'COMMENT') {
      const handled = await this.handleAccountDdl(statement, session);
      if (handled) return handled;
    }

    if (verb === 'CREATE' && /^create\s+(?:or\s+replace\s+)?sequence\b/i.test(statement)) {
      return this.handleCreateSequence(statement, session);
    }

    if (/^drop\s+(?:table|view|sequence)\b/i.test(statement)) {
      const outcome = await this.runOnEngine(statement, session, options);
      // A dropped table or view takes the grants recorded on it, as in Snowflake.
      // The drop already succeeded, so a name that will not resolve has nothing
      // recorded against it.
      const reference =
        /^drop\s+(?:table|view|sequence)\s+(?:if\s+exists\s+)?([\w$".]+(?:\s*\.\s*[\w$".]+)*)/i.exec(statement)?.[1];
      if (reference !== undefined) {
        try {
          const name = displayName(resolveTable(session, reference));
          this.catalog.purgeGrantsFor(name);
          this.catalog.sequenceStarts.delete(name);
          this.catalog.sequenceCreatedAt.delete(name);
        } catch {
          /* the statement itself would have failed first */
        }
      }
      return outcome;
    }

    return this.runOnEngine(statement, session, options);
  }

  /**
   * Run a request that may hold several `;`-separated statements.
   *
   * Routing happens per statement, so a `USE`, a `BEGIN` or a `CREATE` in the
   * middle of a script now takes effect instead of being decided by the first
   * statement alone.
   */
  async executeMany(sql: string, session: Session, options: ExecuteOptions = {}): Promise<Outcome[]> {
    const statements = splitStatements(sql);
    if (statements.length <= 1) return [await this.execute(sql, session, options)];

    // MULTI_STATEMENT_COUNT is enforced only when the client set it: the default
    // of 1 would otherwise reject every script.
    const declared = session.multiStatementCount();
    if (declared !== null && declared !== 0 && declared !== statements.length) {
      throw compilationError(
        `The request contains ${statements.length} statements but MULTI_STATEMENT_COUNT is ${declared}.`,
      );
    }

    const outcomes: Outcome[] = [];
    for (const statement of statements) outcomes.push(await this.execute(statement, session, options));
    return outcomes;
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

  /** Forget a dropped database's (or schema's) stages: definitions, directories, `stages.json`. */
  private async removeStages(database: string, schema?: string): Promise<void> {
    this.catalog.dropStagesIn(database, schema);
    await this.stages.removeScope(database, schema);
    await this.dataDir?.saveStages(this.catalog.stages.values());
  }

  /**
   * Run `work` in one DuckDB transaction on the session's connection.
   *
   * Inside a client's own transaction the work joins it and must not commit
   * behind the client's back: DuckDB has no SAVEPOINT, so there is nothing to
   * nest with. A failure there aborts the client's transaction, as Snowflake does.
   */
  private async inTransaction<T>(connection: EngineConnection, work: () => Promise<T>): Promise<T> {
    if (connection.inTransaction) return work();
    await connection.beginTransaction();
    try {
      const result = await work();
      await connection.commitTransaction();
      return result;
    } catch (error) {
      return failAfter(error, () => connection.rollbackTransaction());
    }
  }

  private async handleBegin(session: Session): Promise<Outcome> {
    const connection = await this.connectionFor(session);
    await connection.beginTransaction();
    return statusOutcome('Statement executed successfully.', STATEMENT_TYPES.rollback);
  }

  private async handleCommit(session: Session): Promise<Outcome> {
    const connection = await this.connectionFor(session);
    await connection.commitTransaction();
    return statusOutcome('Statement executed successfully.', STATEMENT_TYPES.commit);
  }

  private async handleRollback(session: Session): Promise<Outcome> {
    const connection = await this.connectionFor(session);
    await connection.rollbackTransaction();
    return statusOutcome('Statement executed successfully.', STATEMENT_TYPES.rollback);
  }

  /**
   * Existence checks read the session's own connection while it holds a
   * transaction: the admin connection only ever sees committed state, so a table
   * created inside a transaction would otherwise look like it does not exist.
   */
  private async objectKindFor(
    session: Session,
    database: string,
    schema: string,
    name: string,
  ): Promise<'TABLE' | 'VIEW' | null> {
    const connection = session.connection as EngineConnection | null;
    if (connection?.inTransaction) return connection.objectKind(database, schema, name);
    return this.engine.objectKind(database, schema, name);
  }

  /**
   * `CREATE TABLE … CLONE`: a full copy of the source, not Snowflake's zero-copy
   * clone. DuckDB has nothing cheaper, and the documentation says copy rather
   * than implying the two tables share storage.
   */
  private async handleCloneTable(
    orReplace: boolean,
    ifNotExists: boolean,
    targetRef: string,
    sourceRef: string,
    rest: string,
    session: Session,
  ): Promise<Outcome> {
    if (/\b(?:at|before)\b/i.test(rest)) {
      throw unsupported('CREATE TABLE … CLONE with AT or BEFORE (time travel)');
    }
    const target = resolveTable(session, targetRef);
    const source = resolveTable(session, sourceRef);
    if (!this.catalog.getSchema(target.database, target.schema)) {
      throw objectNotFound('SCHEMA', `${target.database}.${target.schema}`);
    }
    if ((await this.objectKindFor(session, source.database, source.schema, source.name)) !== 'TABLE') {
      throw objectNotFound('TABLE', displayName(source));
    }
    const connection = await this.connectionFor(session);
    if (await this.objectKindFor(session, target.database, target.schema, target.name)) {
      if (ifNotExists) {
        return statusOutcome(`${target.name} already exists, statement succeeded.`, STATEMENT_TYPES.create);
      }
      if (!orReplace) throw compilationError(`Object '${displayName(target)}' already exists.`);
      await connection.execute(`DROP TABLE ${qualifiedTable(target)}`);
    }
    const definition = await this.columnDefinitions(connection, source);
    await this.inTransaction(connection, async () => {
      await connection.execute(`CREATE TABLE ${qualifiedTable(target)} (${definition})`);
      await connection.execute(
        `INSERT INTO ${qualifiedTable(target)} SELECT * FROM ${qualifiedTable(source)}`,
      );
    });
    return statusOutcome(`Table ${target.name} successfully created.`, STATEMENT_TYPES.create);
  }

  /** Typed create, then insert by position, atomically: a NOT NULL violation keeps any replaced table. */
  private async handleColumnListCtas(
    ctas: ColumnListCtas,
    session: Session,
    options: ExecuteOptions,
  ): Promise<Outcome> {
    const target = resolveTable(session, ctas.table);
    if (
      ctas.ifNotExists &&
      (await this.objectKindFor(session, target.database, target.schema, target.name))
    ) {
      return statusOutcome(`${target.name} already exists, statement succeeded.`, STATEMENT_TYPES.create);
    }
    const connection = await this.connectionFor(session);
    const name = quoteIdent(`SNOWTEST_CTAS_${randomUUID().replace(/-/g, '').toUpperCase()}`);
    const staging = `"temp"."main".${name}`;
    await this.inTransaction(connection, async () => {
      // Snowflake runs the query before replacing the table: a self-reference reads the old rows.
      // Internal staging, not a user target: bypasses runOnEngine's context guard.
      await this.executeTranslated(
        connection,
        `CREATE TEMP TABLE ${name} AS SELECT * FROM (${ctas.query})`,
        session,
        options,
      );
      await this.runOnEngine(ctas.create, session, {});
      await this.runOnEngine(`INSERT INTO ${ctas.table} SELECT * FROM ${staging}`, session, {});
      await connection.execute(`DROP TABLE ${staging}`);
    });
    return statusOutcome(`Table ${target.name} successfully created.`, STATEMENT_TYPES.create);
  }

  // ---------------------------------------------------------------------------
  // ALTER TABLE: clustering, RENAME TO, SWAP WITH
  // ---------------------------------------------------------------------------

  private async requireTable(session: Session, table: ResolvedTable): Promise<void> {
    if ((await this.objectKindFor(session, table.database, table.schema, table.name)) !== 'TABLE') {
      throw objectNotFound('TABLE', displayName(table));
    }
  }

  /** Column DDL as seen inside the session's transaction (the admin connection cannot see it). */
  private async columnDefinitions(connection: EngineConnection, table: ResolvedTable): Promise<string> {
    const result = await connection.execute(
      `SELECT column_name, data_type, is_nullable FROM duckdb_columns()
       WHERE database_name = ${toSqlLiteral(table.database)} AND schema_name = ${toSqlLiteral(table.schema)}
         AND table_name = ${toSqlLiteral(table.name)}
       ORDER BY column_index`,
    );
    return result.rows
      .map(([name, type, nullable]) => `${quoteIdent(String(name))} ${String(type)}${nullable ? '' : ' NOT NULL'}`)
      .join(', ');
  }

  /** DuckDB renames only within a schema; across schemas, copy columns and rows, then drop. Same database only. */
  private async moveTable(connection: EngineConnection, from: ResolvedTable, to: ResolvedTable): Promise<void> {
    if (from.database === to.database && from.schema === to.schema) {
      await connection.execute(`ALTER TABLE ${qualifiedTable(from)} RENAME TO ${quoteIdent(to.name)}`);
      return;
    }
    const definition = await this.columnDefinitions(connection, from);
    await connection.execute(`CREATE TABLE ${qualifiedTable(to)} (${definition})`);
    await connection.execute(`INSERT INTO ${qualifiedTable(to)} SELECT * FROM ${qualifiedTable(from)}`);
    await connection.execute(`DROP TABLE ${qualifiedTable(from)}`);
  }

  /** A DuckDB transaction writes one database: commit a verified copy, then drop the source (or the copy, on failure). */
  private async moveAcrossDatabases(connection: EngineConnection, from: ResolvedTable, to: ResolvedTable): Promise<void> {
    const definition = await this.columnDefinitions(connection, from);
    await this.inTransaction(connection, async () => {
      await connection.execute(`CREATE TABLE ${qualifiedTable(to)} (${definition})`);
      await connection.execute(`INSERT INTO ${qualifiedTable(to)} SELECT * FROM ${qualifiedTable(from)}`);
      const check = await connection.execute(
        `SELECT (SELECT count(*) FROM ${qualifiedTable(to)}) = (SELECT count(*) FROM ${qualifiedTable(from)})`,
      );
      if (check.rows[0]?.[0] !== true) {
        throw new SnowflakeError(
          '000000',
          `Copy of ${displayName(from)} to ${displayName(to)} is incomplete; nothing was moved.`,
          '22000',
          'runtime',
        );
      }
    });
    try {
      await connection.execute(`DROP TABLE ${qualifiedTable(from)}`);
    } catch (error) {
      await failAfter(error, () => connection.execute(`DROP TABLE ${qualifiedTable(to)}`));
    }
  }

  private async handleAlterTable(statement: string, session: Session): Promise<Outcome | null> {
    const match = ALTER_TABLE.exec(statement);
    if (!match) return null;

    const table = resolveTable(session, match[2]);
    const action = match[3].toLowerCase();
    const done = statusOutcome('Statement executed successfully.', STATEMENT_TYPES.alter);

    if (
      match[1] &&
      (await this.objectKindFor(session, table.database, table.schema, table.name)) !== 'TABLE'
    ) {
      return done;
    }
    await this.requireTable(session, table);

    // Clustering is a storage concern with no equivalent here.
    if (!action.startsWith('rename') && !action.startsWith('swap')) return done;

    const other = resolveTable(session, (match[4] ?? match[5]) as string);
    if (!this.catalog.getSchema(other.database, other.schema)) {
      throw objectNotFound('SCHEMA', `${other.database}.${other.schema}`);
    }
    const connection = await this.connectionFor(session);

    if (action.startsWith('rename')) {
      if (await this.objectKindFor(session, other.database, other.schema, other.name)) {
        throw new SnowflakeError(
          '002002',
          `SQL compilation error:\nObject '${displayName(other)}' already exists.`,
          '42710',
        );
      }
      if (table.database !== other.database) {
        await this.moveAcrossDatabases(connection, table, other);
      } else {
        await this.inTransaction(connection, () => this.moveTable(connection, table, other));
      }
      return done;
    }

    await this.requireTable(session, other);
    if (table.database !== other.database) {
      // Three cross-database moves cannot be made atomic here.
      throw unsupported('ALTER TABLE ... SWAP WITH a table in another database');
    }
    const parked = { ...table, name: `SNOWTEST_SWAP_${randomUUID().replace(/-/g, '').toUpperCase()}` };
    await this.inTransaction(connection, async () => {
      await this.moveTable(connection, table, parked);
      await this.moveTable(connection, other, table);
      await this.moveTable(connection, parked, other);
    });
    return done;
  }

  // ---------------------------------------------------------------------------
  // USE / ALTER SESSION
  // ---------------------------------------------------------------------------

  private async handleUse(statement: string, session: Session): Promise<Outcome> {
    const match = /^use\s+(?:(database|schema|warehouse|role)\s+)?(.+)$/i.exec(statement);
    if (!match) throw compilationError(`Invalid USE statement: ${statement}`);

    const scope = match[1]?.toUpperCase() ?? 'DATABASE';
    const target = match[2].trim().replace(/;+\s*$/, '');

    if (scope === 'DATABASE') {
      const name = normalizeName(target);
      if (!this.catalog.getDatabase(name)) throw objectNotFound('DATABASE', name, '002043');
      session.database = name;
      await this.engine.attachDatabase(name);
      // Snowflake: PUBLIC if the database still has it, else no current schema.
      session.schema = this.catalog.getSchema(name, 'PUBLIC') ? 'PUBLIC' : null;
      await this.connectionFor(session);
      return statusOutcome(`${name} successfully set.`, STATEMENT_TYPES.use);
    }

    if (scope === 'SCHEMA') {
      const { database, schema } = resolveSchema(session, target);
      if (!this.catalog.getSchema(database, schema)) {
        throw objectNotFound('SCHEMA', `${database}.${schema}`, '002043');
      }
      // `USE SCHEMA a.b` switches database too.
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

  // ---------------------------------------------------------------------------
  // Access control
  // ---------------------------------------------------------------------------

  /**
   * `GRANT` / `REVOKE` are recorded, and answered back by `SHOW GRANTS`; nothing
   * is enforced, because there is no privilege model behind them.
   *
   * They used to reach DuckDB and fail on its grammar, which took out a whole
   * dbt project over a `grants:` block. A grant that has no effect is closer to
   * Snowflake than a syntax error, as long as the documentation says which of
   * the two it is — so `/operations` and the README call that out rather than
   * sampling RBAC.
   */
  private handleAccess(statement: string, session: Session): Outcome {
    const revoke = /^revoke\b/i.test(statement);
    const grantOption = /\bwith\s+grant\s+option\s*$/i.test(statement);
    const body = statement
      .replace(/\bwith\s+grant\s+option\s*$/i, '')
      .replace(/\b(?:cascade|restrict)\s*$/i, '')
      .trim();

    const roleGrant =
      /^(?:grant|revoke)\s+(?:grant\s+option\s+for\s+)?role\s+([\w$".]+)\s+(?:to|from)\s+(role|user)\s+([\w$".]+)$/i.exec(
        body,
      );
    if (roleGrant) {
      const grantedRole = normalizeName(roleGrant[1]);
      const granteeType = roleGrant[2].toUpperCase() as 'ROLE' | 'USER';
      const granteeName = normalizeName(roleGrant[3]);
      if (revoke) {
        this.catalog.removeGrants({
          privilege: 'USAGE',
          grantedOn: 'ROLE',
          name: grantedRole,
          grantedTo: granteeType,
          granteeName,
        });
      } else {
        if (!this.catalog.roles.has(grantedRole)) throw objectNotFound('ROLE', grantedRole);
        if (granteeType === 'ROLE' && !this.catalog.roles.has(granteeName)) {
          throw objectNotFound('ROLE', granteeName);
        }
        this.catalog.addGrant({
          privilege: 'USAGE',
          grantedOn: 'ROLE',
          name: grantedRole,
          grantedTo: granteeType,
          granteeName,
          grantOption,
          grantedBy: session.role,
          createdAt: new Date(),
        });
      }
      return statusOutcome('Statement executed successfully.', STATEMENT_TYPES.alter);
    }

    const objectGrant =
      /^(?:grant|revoke)\s+([\s\S]+?)\s+on\s+(account|(database|schema|table|view|stage|warehouse|role|user|function|procedure|file\s+format|sequence|integration)\s+([\w$".]+(?:\s*\.\s*[\w$".]+)*))\s+(?:to|from)\s+(role|user)\s+([\w$".]+)$/i.exec(
        body,
      );
    if (!objectGrant) {
      throw compilationError(`Invalid ${revoke ? 'REVOKE' : 'GRANT'} statement: ${statement}`);
    }

    const privileges = objectGrant[1]
      .split(',')
      .map((privilege) => privilege.trim().toUpperCase().replace(/\s+/g, ' '))
      .filter((privilege) => privilege.length > 0);
    if (privileges.length === 0) {
      throw compilationError(`Invalid ${revoke ? 'REVOKE' : 'GRANT'} statement: ${statement}`);
    }

    const grantedOn = objectGrant[3] ? objectGrant[3].toUpperCase().replace(/\s+/g, ' ') : 'ACCOUNT';
    const name =
      objectGrant[4] === undefined ? null : grantedNameFor(session, grantedOn, objectGrant[4]);
    const granteeType = objectGrant[5].toUpperCase() as 'ROLE' | 'USER';
    const granteeName = normalizeName(objectGrant[6]);

    if (!revoke && granteeType === 'ROLE' && !this.catalog.roles.has(granteeName)) {
      throw objectNotFound('ROLE', granteeName);
    }

    for (const privilege of privileges) {
      // `ALL` on a revoke clears every privilege on that object for the grantee.
      const all = privilege === 'ALL' || privilege === 'ALL PRIVILEGES';
      if (revoke) {
        this.catalog.removeGrants({
          privilege: all ? undefined : privilege,
          grantedOn,
          name,
          grantedTo: granteeType,
          granteeName,
        });
      } else {
        this.catalog.addGrant({
          privilege: all ? 'ALL' : privilege,
          grantedOn,
          name,
          grantedTo: granteeType,
          granteeName,
          grantOption,
          grantedBy: session.role,
          createdAt: new Date(),
        });
      }
    }

    return statusOutcome('Statement executed successfully.', STATEMENT_TYPES.alter);
  }

  /**
   * When a sequence was created — or, for one this process did not create, when
   * it first saw it. DuckDB's catalog has no creation time to report.
   */
  private sequenceCreatedAt(database: string, schema: string, name: string): Date {
    const key = `${database}.${schema}.${name}`;
    const known = this.catalog.sequenceCreatedAt.get(key);
    if (known !== undefined) return known;
    const seen = new Date();
    this.catalog.sequenceCreatedAt.set(key, seen);
    return seen;
  }

  /**
   * `CREATE [OR REPLACE] SEQUENCE`. DuckDB keeps the state; this normalises the
   * Snowflake spelling to what it understands — `ORDER`/`NOORDER` dropped (its
   * sequences are always ordered), `COMMENT` dropped, and an explicit range for
   * a descending sequence — and refuses anything else rather than ignoring it.
   */
  private async handleCreateSequence(statement: string, session: Session): Promise<Outcome> {
    const match =
      /^create\s+(or\s+replace\s+)?sequence\s+(if\s+not\s+exists\s+)?([\w$".]+(?:\s*\.\s*[\w$".]+){0,2})([\s\S]*)$/i.exec(
        statement,
      );
    if (!match) throw compilationError(`Unsupported CREATE SEQUENCE statement: ${statement}`);

    const resolved = resolveTable(session, match[3]);
    const key = `${resolved.database}.${resolved.schema}.${resolved.name}`;
    if (!this.catalog.getSchema(resolved.database, resolved.schema)) {
      throw objectNotFound('SCHEMA', `${resolved.database}.${resolved.schema}`);
    }

    const start = /(?:^|\s)start\s*(?:with\s*)?=?\s*(-?\d+)/i.exec(match[4])?.[1];
    const increment = /(?:^|\s)increment\s*(?:by\s*)?=?\s*(-?\d+)/i.exec(match[4])?.[1];
    const step = increment === undefined ? 1 : Number(increment);
    if (step === 0) throw compilationError('Sequence increment cannot be zero.');

    const leftovers = match[4]
      .replace(/(?:^|\s)start\s*(?:with\s*)?=?\s*-?\d+/gi, ' ')
      .replace(/(?:^|\s)increment\s*(?:by\s*)?=?\s*-?\d+/gi, ' ')
      .replace(/\b(?:no)?order\b/gi, ' ')
      .replace(/\bcomment\s*(?:=\s*)?'(?:[^']|'')*'/gi, ' ')
      .trim();
    if (leftovers.length > 0) throw unsupported(`CREATE SEQUENCE ... ${leftovers}`);

    // A descending sequence needs its range spelled out: DuckDB's default maximum
    // of -1 refuses a positive start value.
    const range = step < 0 ? ' MINVALUE -9223372036854775808 MAXVALUE 9223372036854775807' : '';
    const connection = await this.connectionFor(session);
    await connection.execute(
      `CREATE ${match[1] ? 'OR REPLACE ' : match[2] ? 'IF NOT EXISTS ' : ''}` +
        `SEQUENCE ${qualifiedTable(resolved)}` +
        `${start === undefined ? '' : ` START WITH ${start}`} INCREMENT BY ${step}${range}`,
    );
    this.catalog.sequenceStarts.set(key, start === undefined ? 1 : Number(start));
    this.catalog.sequenceCreatedAt.set(key, new Date());
    return statusOutcome(`${resolved.name} successfully created.`, STATEMENT_TYPES.create);
  }

  /**
   * `ALTER SEQUENCE … RESTART [WITH n]` and `… SET INCREMENT [BY] n`. DuckDB has
   * no ALTER for sequences, so the definition is read back and rewritten with
   * `CREATE OR REPLACE`: a bare `RESTART` returns to the sequence's own start
   * value, and `SET` keeps the value it would have handed out next, which is
   * what Snowflake does.
   */
  private async handleAlterSequence(statement: string, session: Session): Promise<Outcome> {
    const match =
      /^alter\s+sequence\s+(if\s+exists\s+)?([\w$".]+(?:\s*\.\s*[\w$".]+){0,2})\s+(restart|set)\b([\s\S]*)$/i.exec(
        statement,
      );
    if (!match) throw compilationError(`Unsupported ALTER SEQUENCE statement: ${statement}`);

    const resolved = resolveTable(session, match[2]);
    const key = `${resolved.database}.${resolved.schema}.${resolved.name}`;
    const found = (await this.engine.listSequences(resolved.database, resolved.schema)).find(
      (sequence) => sequence.name.toUpperCase() === resolved.name.toUpperCase(),
    );
    if (!found) {
      if (match[1]) {
        return statusOutcome(`${resolved.name} does not exist, statement succeeded.`, STATEMENT_TYPES.alter);
      }
      throw objectNotFound('SEQUENCE', key);
    }

    const tail = match[4].trim();
    // `RESTART` does not change the sequence's start value, so a later bare
    // RESTART still returns to the one it was created with.
    const originalStart = this.catalog.sequenceStarts.get(key) ?? found.startValue;
    let increment = found.increment;
    let start: number;

    if (/^restart/i.test(match[3])) {
      const restart = /^(?:with\s*)?=?\s*(-?\d*)\s*$/i.exec(tail);
      if (!restart) throw unsupported(`ALTER SEQUENCE ... RESTART ${tail}`.trim());
      start = restart[1] === '' ? originalStart : Number(restart[1]);
    } else {
      const value = /(?:^|\s)increment\s*(?:by\s*)?=?\s*(-?\d+)/i.exec(tail)?.[1];
      if (value === undefined) throw compilationError(`Unsupported ALTER SEQUENCE statement: ${statement}`);
      if (Number(value) === 0) throw compilationError('Sequence increment cannot be zero.');

      const leftovers = tail
        .replace(/(?:^|\s)increment\s*(?:by\s*)?=?\s*-?\d+/gi, ' ')
        .replace(/\b(?:no)?order\b/gi, ' ')
        .replace(/\bcomment\s*(?:=\s*)?'(?:[^']|'')*'/gi, ' ')
        .trim();
      if (leftovers.length > 0) throw unsupported(`ALTER SEQUENCE ... ${leftovers}`);

      increment = Number(value);
      start = nextValueOf(found);
    }

    const range = increment < 0 ? ' MINVALUE -9223372036854775808 MAXVALUE 9223372036854775807' : '';
    const connection = await this.connectionFor(session);
    await connection.execute(
      `CREATE OR REPLACE SEQUENCE ${qualifiedTable(resolved)} START WITH ${start}` +
        ` INCREMENT BY ${increment}${found.cycle ? ' CYCLE' : ''}${range}`,
    );
    this.catalog.sequenceStarts.set(key, originalStart);
    return statusOutcome('Statement executed successfully.', STATEMENT_TYPES.alter);
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
        const database = resolveDatabase(session, inMatch?.[1] || undefined);
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
        const scope = stageScope(session, rest);
        const inScope = (stage: { database: string; schema: string }): boolean =>
          scope === null ||
          (stage.database === scope.database && (scope.schema === null || stage.schema === scope.schema));
        const rows = [...this.catalog.stages.values()].filter(inScope).map((stage) => [
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

      case 'sequences': {
        const scope = stageScope(session, rest);
        const rows: unknown[][] = [];
        for (const database of this.catalog.databases.values()) {
          if (scope !== null && database.name !== scope.database) continue;
          for (const schema of database.schemas.keys()) {
            if (scope !== null && scope.schema !== null && schema !== scope.schema) continue;
            for (const sequence of await this.engine.listSequences(database.name, schema)) {
              rows.push([
                this.sequenceCreatedAt(database.name, schema, sequence.name),
                sequence.name,
                schema,
                database.name,
                String(nextValueOf(sequence)),
                String(sequence.increment),
                'SYSADMIN',
                sequence.comment ?? '',
                'YES',
              ]);
            }
          }
        }
        return finish(
          [
            { name: 'created_on', duckType: 'TIMESTAMP_TZ' },
            { name: 'name', duckType: 'VARCHAR' },
            { name: 'schema_name', duckType: 'VARCHAR' },
            { name: 'database_name', duckType: 'VARCHAR' },
            { name: 'next_value', duckType: 'VARCHAR' },
            { name: 'interval', duckType: 'VARCHAR' },
            { name: 'owner', duckType: 'VARCHAR' },
            { name: 'comment', duckType: 'VARCHAR' },
            { name: 'ordered', duckType: 'VARCHAR' },
          ],
          rows,
          1,
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
        // Snowflake has three shapes here, and a client that reads one of them
        // depends on the column order, so each is built separately: `OF ROLE`,
        // `ON <object>`, and `[TO ROLE|USER]` — which is also the bare form.
        const ofRole = /^\s*of\s+role\s+([\w$".]+)/i.exec(rest);
        if (ofRole) {
          const role = normalizeName(ofRole[1]);
          const rows = this.catalog.grants
            .filter((grant) => grant.grantedOn === 'ROLE' && grant.name === role)
            .map((grant) => [
              grant.createdAt,
              grant.name,
              grant.grantedTo,
              grant.granteeName,
              grant.grantedBy,
            ]);
          return finish(
            [
              { name: 'created_on', duckType: 'TIMESTAMP_TZ' },
              { name: 'role', duckType: 'VARCHAR' },
              { name: 'granted_to', duckType: 'VARCHAR' },
              { name: 'grantee_name', duckType: 'VARCHAR' },
              { name: 'granted_by', duckType: 'VARCHAR' },
            ],
            rows,
            1,
          );
        }

        const onObject =
          /^\s*on\s+(account|(database|schema|table|view|stage|warehouse|role|user|function|procedure|file\s+format|sequence|integration)\s+([\w$".]+(?:\s*\.\s*[\w$".]+)*))/i.exec(
            rest,
          );
        if (onObject) {
          const grantedOn = onObject[2] ? onObject[2].toUpperCase().replace(/\s+/g, ' ') : 'ACCOUNT';
          const name =
            onObject[3] === undefined ? null : grantedNameFor(session, grantedOn, onObject[3]);
          const rows = this.catalog.grants
            .filter(
              (grant) => grant.grantedOn === grantedOn && (name === null || grant.name === name),
            )
            .map((grant) => [
              grant.createdAt,
              grant.privilege,
              grant.grantedOn,
              grant.name,
              grant.grantedTo,
              grant.granteeName,
              grant.grantOption ? 'TRUE' : 'FALSE',
              'ROLE',
              grant.grantedBy,
            ]);
          return finish(
            [
              { name: 'created_on', duckType: 'TIMESTAMP_TZ' },
              { name: 'privilege', duckType: 'VARCHAR' },
              { name: 'granted_on', duckType: 'VARCHAR' },
              { name: 'name', duckType: 'VARCHAR' },
              { name: 'granted_to', duckType: 'VARCHAR' },
              { name: 'grantee_name', duckType: 'VARCHAR' },
              { name: 'grant_option', duckType: 'VARCHAR' },
              { name: 'granted_by_role_type', duckType: 'VARCHAR' },
              { name: 'granted_by', duckType: 'VARCHAR' },
            ],
            rows,
            3,
          );
        }

        const target = /^\s*to\s+(role|user)\s+([\w$".]+)/i.exec(rest);
        const grantedTo = target ? (target[1].toUpperCase() as 'ROLE' | 'USER') : 'USER';
        const granteeName = normalizeName(target ? target[2] : session.user);
        const rows = this.catalog.grants
          .filter((grant) => grant.grantedTo === grantedTo && grant.granteeName === granteeName)
          .map((grant) => [
            grant.createdAt,
            grant.privilege,
            grant.grantedOn,
            grant.name,
            grant.grantedTo === 'ROLE' ? grant.granteeName : null,
            grant.grantedTo,
            grant.granteeName,
            grant.grantOption ? 'TRUE' : 'FALSE',
            grant.grantedBy,
          ]);
        return finish(
          [
            { name: 'created_on', duckType: 'TIMESTAMP_TZ' },
            { name: 'privilege', duckType: 'VARCHAR' },
            { name: 'granted_on', duckType: 'VARCHAR' },
            { name: 'name', duckType: 'VARCHAR' },
            { name: 'role', duckType: 'VARCHAR' },
            { name: 'granted_to', duckType: 'VARCHAR' },
            { name: 'grantee_name', duckType: 'VARCHAR' },
            { name: 'grant_option', duckType: 'VARCHAR' },
            { name: 'granted_by', duckType: 'VARCHAR' },
          ],
          rows,
          3,
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
        const scope = stageScope(session, rest);
        const inScope = (format: { database: string; schema: string }): boolean =>
          scope === null ||
          (format.database === scope.database && (scope.schema === null || format.schema === scope.schema));
        const rows = [...this.catalog.fileFormats.values()]
          .filter(inScope)
          .map((format) => [
            format.createdAt,
            format.name,
            format.database,
            format.schema,
            format.type,
            format.owner,
            null,
          ]);
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
          rows,
          1,
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
    const match = /^desc(?:ribe)?\s+(?:(table|view|stage|file\s+format|sequence)\s+)?(.+)$/i.exec(statement);
    if (!match) throw compilationError(`Unsupported DESCRIBE statement: ${statement}`);

    const kind = (match[1] ?? 'table').toLowerCase().replace(/\s+/g, ' ');
    const target = match[2].trim();
    if (kind === 'stage') return this.describeStage(session, target);
    if (kind === 'file format') return this.describeFileFormat(session, target);
    if (kind === 'sequence') return this.describeSequence(session, target);

    const resolved = resolveTable(session, target);
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

  /**
   * `DESCRIBE STAGE` / `DESCRIBE FILE FORMAT` answer in Snowflake's property
   * table — five columns — rather than in the column list a table returns.
   */
  private describeStage(session: Session, name: string): Outcome {
    const resolved = resolveTable(session, name);
    const key = `${resolved.database}.${resolved.schema}.${resolved.name}`;
    const stage = this.catalog.stages.get(key);
    if (!stage) throw objectNotFound('STAGE', key);

    const rows = [
      [null, 'url', 'STAGE_URL', stage.url ?? '', null],
      [null, 'has_credentials', 'BOOLEAN', 'FALSE', 'FALSE'],
      [null, 'create_on', 'TIMESTAMP', formatTimestamp(stage.createdAt ?? new Date()), null],
      [null, 'type', 'STAGE_TYPE', stage.url === null ? 'INTERNAL' : 'EXTERNAL', null],
      [null, 'owner', 'ROLE', 'SYSADMIN', null],
      [null, 'comment', 'STRING', null, null],
      [null, 'directory_enabled', 'BOOLEAN', 'FALSE', 'FALSE'],
    ];
    return syntheticOutcome(DESCRIBE_PROPERTY_COLUMNS, rows, STATEMENT_TYPES.describe);
  }

  private describeFileFormat(session: Session, name: string): Outcome {
    const resolved = resolveTable(session, name);
    const key = `${resolved.database}.${resolved.schema}.${resolved.name}`;
    const format = this.catalog.getFileFormat(resolved.database, resolved.schema, resolved.name);
    if (!format) throw objectNotFound('FILE FORMAT', key);

    const rows: unknown[][] = [[null, 'type', 'STRING', format.type, 'CSV']];
    for (const option of format.options.matchAll(/\b([A-Za-z_][\w$]*)\s*=\s*('(?:[^']|'')*'|[^\s,]+)/g)) {
      if (option[1].toUpperCase() === 'TYPE') continue;
      rows.push([null, option[1].toLowerCase(), 'STRING', option[2].replace(/^'(.*)'$/s, '$1'), null]);
    }
    rows.push([null, 'owner', 'ROLE', format.owner, null]);
    rows.push([null, 'create_on', 'TIMESTAMP', formatTimestamp(format.createdAt), null]);
    return syntheticOutcome(DESCRIBE_PROPERTY_COLUMNS, rows, STATEMENT_TYPES.describe);
  }

  /** `DESCRIBE SEQUENCE` answers with the single row Snowflake returns for one. */
  private async describeSequence(session: Session, name: string): Promise<Outcome> {
    const resolved = resolveTable(session, name);
    const key = `${resolved.database}.${resolved.schema}.${resolved.name}`;
    const found = (await this.engine.listSequences(resolved.database, resolved.schema)).find(
      (sequence) => sequence.name.toUpperCase() === resolved.name.toUpperCase(),
    );
    if (!found) throw objectNotFound('SEQUENCE', key);

    return syntheticOutcome(
      [
        { name: 'created_on', duckType: 'TIMESTAMP_TZ' },
        { name: 'name', duckType: 'VARCHAR' },
        { name: 'next_value', duckType: 'VARCHAR' },
        { name: 'interval', duckType: 'VARCHAR' },
        { name: 'ordered', duckType: 'VARCHAR' },
      ],
      [
        [
          this.sequenceCreatedAt(resolved.database, resolved.schema, found.name),
          found.name,
          String(nextValueOf(found)),
          String(found.increment),
          'YES',
        ],
      ],
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

      // `CREATE DATABASE … CLONE …`: the name matched, but creating an empty
      // database would be a quiet lie. Table-level CLONE is handled in execute().
      if (/\bclone\b/i.test(rest)) throw unsupported(`CREATE ${object.toUpperCase()} … CLONE`);

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
          const { created, name: key } = this.catalog.createWarehouse(normalizeName(name));
          return statusOutcome(
            created ? `${key} successfully created.` : `${key} already exists, statement succeeded.`,
            STATEMENT_TYPES.create,
          );
        }
        case 'role': {
          const { created, name: key } = this.catalog.createRole(normalizeName(name));
          return statusOutcome(
            created ? `${key} successfully created.` : `${key} already exists, statement succeeded.`,
            STATEMENT_TYPES.create,
          );
        }
        case 'stage': {
          const stage = resolveTable(session, name);
          // A stage outside a known schema could not be restored after a restart.
          if (!this.catalog.getSchema(stage.database, stage.schema)) {
            throw objectNotFound('SCHEMA', `${stage.database}.${stage.schema}`);
          }
          const directory = await this.stages.directoryFor(stage.database, stage.schema, stage.name);
          this.catalog.createStage({
            ...stage,
            url: /url\s*=\s*'([^']*)'/i.exec(rest)?.[1] ?? null,
            directory,
            createdAt: new Date(),
          });
          await this.dataDir?.saveStages(this.catalog.stages.values());
          return statusOutcome(`Stage area ${stage.name} successfully created.`, STATEMENT_TYPES.create);
        }
        case 'file format': {
          const format = resolveTable(session, name);
          if (!this.catalog.getSchema(format.database, format.schema)) {
            throw objectNotFound('SCHEMA', `${format.database}.${format.schema}`);
          }
          const options = rest.trim();
          this.catalog.defineFileFormat({
            ...format,
            type: /\btype\s*=\s*([\w$]+)/i.exec(options)?.[1]?.toUpperCase() ?? 'CSV',
            options,
            owner: session.role,
            createdAt: new Date(),
          });
          return statusOutcome(`${format.name} successfully created.`, STATEMENT_TYPES.create);
        }
        case 'user':
          return statusOutcome('User successfully created.', STATEMENT_TYPES.create);
        default:
          return null;
      }
    }

    const drop = /^drop\s+(database|schema|warehouse|role|stage|file\s+format|user)\s+(if\s+exists\s+)?([\w$".]+)([\s\S]*)$/i.exec(
      statement,
    );
    if (drop) {
      const object = drop[1].toLowerCase().replace(/\s+/g, ' ');
      const ifExists = Boolean(drop[2]);
      const name = drop[3];
      const rest = drop[4] ?? '';
      const alreadyDropped = (key: string) =>
        statusOutcome(`Drop statement executed successfully (${key} already dropped).`, STATEMENT_TYPES.drop);
      switch (object) {
        case 'database': {
          const key = normalizeName(name);
          if (!this.catalog.getDatabase(key)) {
            if (ifExists) return alreadyDropped(key);
            throw objectNotFound('DATABASE', key);
          }
          await this.engine.dropDatabase(key);
          this.catalog.dropDatabase(key);
          await this.removeStages(key);
          // A dropped database takes its file formats and grants with it.
          this.catalog.dropFileFormatsIn(key);
          this.catalog.purgeGrantsFor(key);
          // Snowflake leaves every session with no current database, not just this one.
          if (session.database === key) {
            session.database = null;
            session.schema = null;
          }
          this.onDatabaseDropped(key);
          return statusOutcome(`${key} successfully dropped.`, STATEMENT_TYPES.drop);
        }
        case 'schema': {
          const resolved = resolveSchema(session, name);
          if (!this.catalog.getSchema(resolved.database, resolved.schema)) {
            if (ifExists) return alreadyDropped(resolved.schema);
            throw objectNotFound('SCHEMA', `${resolved.database}.${resolved.schema}`);
          }
          // Snowflake's default is CASCADE; RESTRICT refuses a schema that still holds objects.
          await this.engine.dropSchema(resolved.database, resolved.schema, !/^\s*restrict\b/i.test(rest));
          this.catalog.dropSchema(resolved.database, resolved.schema);
          await this.removeStages(resolved.database, resolved.schema);
          this.catalog.dropFileFormatsIn(resolved.database, resolved.schema);
          this.catalog.purgeGrantsFor(`${resolved.database}.${resolved.schema}`);
          if (session.database === resolved.database && session.schema === resolved.schema) {
            session.schema = null;
          }
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
          const stage = resolveTable(session, name);
          this.catalog.dropStage(stage.database, stage.schema, stage.name);
          this.catalog.purgeGrantsFor(`${stage.database}.${stage.schema}.${stage.name}`);
          await this.dataDir?.saveStages(this.catalog.stages.values());
          await this.stages.removeAll(await this.stages.directoryFor(stage.database, stage.schema, stage.name));
          return statusOutcome('Stage area successfully dropped.', STATEMENT_TYPES.drop);
        }
        case 'file format': {
          const format = resolveTable(session, name);
          if (!this.catalog.dropFileFormat(format.database, format.schema, format.name)) {
            if (ifExists) return alreadyDropped(format.name);
            throw objectNotFound('FILE FORMAT', `${format.database}.${format.schema}.${format.name}`);
          }
          this.catalog.purgeGrantsFor(`${format.database}.${format.schema}.${format.name}`);
          return statusOutcome(`${format.name} successfully dropped.`, STATEMENT_TYPES.drop);
        }
        case 'user':
          return statusOutcome('User successfully dropped.', STATEMENT_TYPES.drop);
        default:
          return null;
      }
    }

    // ALTER WAREHOUSE / ALTER ROLE / ALTER DATABASE are accepted as no-ops;
    // ALTER TABLE falls through to DuckDB.
    if (/^alter\s+schema\s+(if\s+exists\s+)?\S+\s+rename\s+to\b/i.test(statement)) throw unsupported('ALTER SCHEMA ... RENAME TO');
    if (/^alter\s+schema\s+(if\s+exists\s+)?\S+\s+swap\s+with\b/i.test(statement)) throw unsupported('ALTER SCHEMA ... SWAP WITH');
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
    if (parts.length === 2) return { database: currentDatabase(session), schema: parts[0], name, filePath };
    return { database: currentDatabase(session), schema: currentSchema(session), name, filePath };
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

    // A target in a missing schema, or unqualified without context, fails as in Snowflake rather than letting DuckDB guess.
    const target = WRITE_TARGET.exec(statement);
    if (target) {
      const parts = splitName(target[1]);
      const operation = operationOf(statement);
      if (parts.length < 3) currentDatabase(session, operation);
      if (parts.length < 2) currentSchema(session, operation);
      if (parts.length >= 3) {
        if (!this.catalog.getDatabase(parts[0])) throw objectNotFound('DATABASE', parts[0]);
        if (!this.catalog.getSchema(parts[0], parts[1])) {
          throw objectNotFound('SCHEMA', `${parts[0]}.${parts[1]}`);
        }
      }
    }

    const result = await this.executeTranslated(connection, statement, session, options);
    const columns = result.columns.map((column) =>
      buildColumn(column.name, column.duckType, true, {
        database: session.database ?? '',
        schema: session.schema ?? '',
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

  private async executeTranslated(
    connection: EngineConnection,
    statement: string,
    session: Session,
    options: ExecuteOptions,
  ): Promise<QueryResult> {
    const translated = rewrite(
      statement,
      {
        database: session.database,
        schema: session.schema,
        role: session.role,
        user: session.user,
        warehouse: session.warehouse,
        databases: [...this.catalog.databases.values()],
        clockMs: session.clockMs(),
      },
      options.bindings ?? [],
    );
    try {
      return await connection.execute(translated);
    } catch (error) {
      throw missingContext(error, statement, session) ?? error;
    }
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
