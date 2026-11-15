// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * The reference served at `/operations`.
 *
 * Every supported endpoint, statement and function lives here once, as data.
 * The page is rendered from it, and so is the summary on the landing page — a
 * second hand-written list is how a stub ends up claiming more than it does.
 *
 * When a statement or endpoint gains or loses support, change it here: the
 * landing page, the counts and the tests all read from this table.
 */

import { escapeHtml, inlineMarkup, renderPage, renderTabs } from './page.js';

export type OperationStatus = 'supported' | 'partial' | 'unsupported';

export interface OperationRow {
  /** What a client sends, or the feature being described. */
  syntax: string;
  /** What the server does with it. */
  behaviour: string;
  status: OperationStatus;
  /** The gap, when status is `partial`. */
  note?: string;
  /**
   * The snowtest release that gave this row the status it shows today. Provenance
   * comes from the tagged trees, not from memory: a row promoted from partial to
   * supported carries the version of the promotion, not of the original row.
   */
  since: string;
}

export interface OperationGroup {
  /** Anchor on this page; also the landing-page link target. */
  id: string;
  /** Short tab label; `title` is the panel heading. */
  tab: string;
  title: string;
  summary: string;
  /** Set to also appear in the landing page's summary table, under this label. */
  landingLabel?: string;
  columns: [string, string, string];
  rows: OperationRow[];
}

export interface UnsupportedFeature {
  feature: string;
  outcome: string;
}

const STATUS_COLUMNS: [string, string, string] = ['Statement', 'Behaviour', 'Status'];
const ENDPOINT_COLUMNS: [string, string, string] = ['Endpoint', 'Purpose', 'Status'];

export const GROUPS: OperationGroup[] = [
  {
    id: 'driver-protocol',
    tab: 'Driver',
    title: 'Driver protocol',
    summary: 'The paths Snowflake drivers call: login, heartbeat, query, fetch, logout.',
    landingLabel: 'Driver protocol',
    columns: ENDPOINT_COLUMNS,
    rows: [
      {
        syntax: 'POST /session/v1/login-request',
        behaviour: 'Password, account and key-pair logins; issues a session token.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'GET /session/v1/login-request',
        behaviour: 'Renews the session token on the driver renewal path.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'POST /session/token-request',
        behaviour: 'Renews the session token.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'POST /session/heartbeat',
        behaviour: 'Keeps a long-lived session alive.',
        status: 'supported',
        since: '1.0.0',
      },
      { syntax: 'POST /session, GET /session', behaviour: 'Logout.', status: 'supported', since: '1.0.0' },
      {
        syntax: 'POST /queries/v1/query-request',
        behaviour: 'Runs one statement and returns its rows inline.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'GET /queries/v1/query-result/:queryId',
        behaviour: 'Fetches a stored result for a query id.',
        status: 'partial',
        since: '1.0.0',
        note: 'One partition. A real account may return partitions 0…n.',
      },
      {
        syntax: 'POST /queries/v1/abort-request',
        behaviour: 'Acknowledges an abort.',
        status: 'partial',
        since: '1.0.0',
        note: 'Statements run to completion on the request thread; nothing is interrupted.',
      },
      {
        syntax: 'GET /monitoring/queries/:id',
        behaviour: 'Recent query log, which the connector reads for diagnostics.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'POST /telemetry/send',
        behaviour: 'Accepted and discarded.',
        status: 'supported',
        since: '1.0.0',
      },
    ],
  },
  {
    id: 'sql-api',
    tab: 'SQL API',
    title: 'SQL REST API v2',
    summary: 'The documented HTTP API: submit a statement, poll a handle, cancel it.',
    landingLabel: 'SQL REST API v2',
    columns: ENDPOINT_COLUMNS,
    rows: [
      {
        syntax: 'POST /api/v2/statements',
        behaviour: 'Runs a statement synchronously and returns the rows in `data`.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'POST /api/v2/statements?async=true',
        behaviour: 'Returns a handle immediately, with the statement still running.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'GET /api/v2/statements/:handle',
        behaviour: 'Polls the handle until it completes, then returns the rows.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'POST /api/v2/statements/:handle/cancel',
        behaviour: 'Marks the handle cancelled.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'Request body: statement, bindings',
        behaviour: 'Positional and named bindings, typed by the driver.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'database, schema, role, warehouse, timeout',
        behaviour: 'Per-request overrides of the session context.',
        status: 'supported',
        since: '1.0.0',
      },
    ],
  },
  {
    id: 'control-plane',
    tab: 'Control plane',
    title: 'Control plane',
    summary: 'Endpoints for tests and operators, outside the Snowflake surface.',
    columns: ENDPOINT_COLUMNS,
    rows: [
      { syntax: 'GET /', behaviour: 'The landing page: what this is, and how to connect.', status: 'supported', since: '1.0.0' },
      { syntax: 'GET /operations', behaviour: 'This page.', status: 'supported', since: '1.0.0' },
      {
        syntax: 'GET /configuration',
        behaviour: 'Flags and environment, the launcher, the control plane and staging, for the running build. `GET /usage` redirects here.',
        status: 'supported',
        since: '3.0.0',
      },
      {
        syntax: 'GET /troubleshooting',
        behaviour: 'Common symptoms, their causes and fixes.',
        status: 'supported',
        since: '3.0.0',
      },
      {
        syntax: 'GET /browse/:database/:schema[/:table]',
        behaviour: 'Catalog browser: objects, row counts, and a preview of the first rows of any table or view.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'GET /_snowtest/health',
        behaviour: 'Liveness probe, with both the emulated Snowflake version and the snowtest version.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'GET /_snowtest/state',
        behaviour: 'Databases, schemas, warehouses, roles, stages and session count.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'POST /_snowtest/seed',
        behaviour: 'Runs a SQL script sent as `{"sql": "..."}`.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'POST /_snowtest/reset',
        behaviour: 'Drops everything, persisted database files included, and recreates the configured catalog.',
        status: 'supported',
        since: '1.0.0',
      },
    ],
  },
  {
    id: 'sessions',
    tab: 'Sessions',
    title: 'Sessions and authentication',
    summary: 'Who may connect, and what a session remembers.',
    columns: ['Feature', 'Behaviour', 'Status'],
    rows: [
      {
        syntax: 'Permissive logins (default)',
        behaviour: 'Any user and password is accepted.',
        status: 'supported',
        since: '1.0.0',
        note: 'Nothing is authorised. Never expose the server publicly.',
      },
      {
        syntax: 'SNOWTEST_USERS',
        behaviour: 'Comma-separated login allow-list; other names are refused at login.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'Key-pair JWT',
        behaviour: 'RS256, RS384 and RS512, with the signature checked against the configured public key.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'Key-pair claims',
        behaviour: '`exp` is enforced and `iss` must name the login user.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'Session token renewal',
        behaviour: 'Both driver renewal paths mint a fresh token for the same session.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'USE DATABASE | SCHEMA | WAREHOUSE | ROLE',
        behaviour: 'Switches the session context, including bare `USE`; a missing database or schema is an error (`002043`).',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'ALTER SESSION SET key = value',
        behaviour: 'Stored on the session and echoed by `SHOW PARAMETERS`.',
        status: 'partial',
        since: '1.0.0',
        note: 'Not applied to result formatting: DATE_OUTPUT_FORMAT and TIMESTAMP_*_OUTPUT_FORMAT are accepted and ignored.',
      },
    ],
  },
  {
    id: 'account-objects',
    tab: 'Objects',
    title: 'Databases, schemas and account objects',
    summary: 'What can be created, and how much of it is only recorded.',
    columns: STATUS_COLUMNS,
    rows: [
      {
        syntax: 'CREATE | DROP DATABASE',
        behaviour:
          'Creates or drops the database and its DuckDB catalog, its file when persisted, and its stages. Dropping the current database leaves the session with none (`CURRENT_DATABASE()` is NULL; unqualified names fail with `090105`); a missing database is an error unless `IF EXISTS`.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'Persistence (SNOWTEST_DATA_DIR)',
        behaviour:
          'Each database is a DuckDB file in the directory; databases, schemas, tables, rows and stage definitions survive a restart. Unset, everything is in memory.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'CREATE | DROP SCHEMA',
        behaviour:
          'Creates or drops a schema in place. `DROP SCHEMA` cascades to its tables, views and stages by default; a missing schema is an error unless `IF EXISTS`.',
        status: 'partial',
        since: '1.0.0',
        note: '`RESTRICT` refuses any schema that still holds tables or views (`002003`, SQLSTATE `2BP01`); Snowflake refuses only on foreign-key references.',
      },
      {
        syntax: 'CREATE | DROP WAREHOUSE',
        behaviour: 'Recorded in the catalog; it shows up in `SHOW WAREHOUSES`.',
        status: 'supported',
        since: '1.0.0',
        note: 'No sizing, queues or credits.',
      },
      {
        syntax: 'CREATE | DROP ROLE',
        behaviour: 'Recorded and shown by `SHOW ROLES`.',
        status: 'supported',
        since: '1.0.0',
        note: 'No privileges attach to a role.',
      },
      {
        syntax: 'GRANT | REVOKE privileges, roles',
        behaviour:
          'Recorded, then answered by `SHOW GRANTS`. `GRANT SELECT ON TABLE t TO ROLE r`, `GRANT ROLE a TO USER u`, `ALL PRIVILEGES`, `WITH GRANT OPTION` and the matching `REVOKE`s all succeed. A dropped role takes its grants with it.',
        status: 'supported',
        since: '4.0.0',
        note: 'Recorded only: no statement is authorised or refused, and a grant on an object that does not exist is accepted.',
      },
      {
        syntax: 'SHOW GRANTS [ON <object>] [TO ROLE | USER <name>] [OF ROLE <name>]',
        behaviour:
          'Answers from the recorded grants, in the column shape Snowflake gives each variant.',
        status: 'partial',
        since: '4.0.0',
        note: 'Reports what was granted, not what is enforced: every role can still do everything. A renamed table keeps its grants under the old name.',
      },
      {
        syntax: 'CREATE | DROP STAGE',
        behaviour: 'Creates or removes the stage directory that `PUT` writes into.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'CREATE | DROP FILE FORMAT',
        behaviour:
          'Creates or removes a named file format, `TYPE` and options and all, so `SHOW FILE FORMATS` and `DESCRIBE FILE FORMAT` answer from it.',
        status: 'partial',
        since: '1.0.0',
        note: 'The options are stored, not applied: `COPY INTO` still reads its own `FILE_FORMAT = (…)` list. Formats live in memory like roles and warehouses, so a restart forgets them.',
      },
      {
        syntax: 'CREATE | ALTER | DROP SEQUENCE',
        behaviour:
          'Creates a sequence with `START [WITH]`, `INCREMENT [BY]` (negative for descending), `OR REPLACE` and `IF NOT EXISTS`; `ALTER SEQUENCE … RESTART [WITH n]` and `… SET INCREMENT [BY] n` rewrite it, keeping the value it would hand out next on a `SET` and returning to its start value on a bare `RESTART`; `DROP SEQUENCE [IF EXISTS]`. `seq.NEXTVAL`, `NEXT VALUE FOR seq` and `seq.CURRVAL` read it, with the name resolved from the session when it is not qualified.',
        status: 'supported',
        since: '4.0.0',
        note: '`ORDER`/`NOORDER` and `COMMENT` are accepted and not stored; any other option (`CACHE`, `RENAME TO`, …) is refused rather than ignored. The start value a bare `RESTART` returns to is remembered while the process runs. A column named `nextval` or `currval`, referred to with a qualifier, is read as a sequence reference.',
      },
      {
        syntax: 'CREATE | DROP USER',
        behaviour: 'Accepted and recorded.',
        status: 'partial',
        since: '1.0.0',
        note: 'No credentials, roles or policies attach to the user.',
      },
      {
        syntax: 'ALTER DATABASE | SCHEMA | WAREHOUSE | ROLE',
        behaviour: 'Accepted.',
        status: 'partial',
        since: '1.0.0',
        note: 'No-ops: there is no sizing, retention or ownership to change. `ALTER SCHEMA … RENAME TO` is not supported.',
      },
      {
        syntax: 'COMMENT ON …',
        behaviour: 'Accepted.',
        status: 'partial',
        since: '1.0.0',
        note: 'No-ops; comments are not stored.',
      },
    ],
  },
  {
    id: 'metadata',
    tab: 'Metadata',
    title: 'Metadata and reflection',
    summary: 'What dbt, SQLAlchemy and the connector ask about the catalog.',
    landingLabel: 'Metadata',
    columns: STATUS_COLUMNS,
    rows: [
      {
        syntax: 'SHOW [TERSE] DATABASES | SCHEMAS | TABLES | VIEWS | COLUMNS | OBJECTS | FUNCTIONS | WAREHOUSES | ROLES | STAGES | PARAMETERS | GRANTS | USERS',
        behaviour: 'Answers from the catalog, honouring `IN …`, `LIKE …` and `LIMIT`. `SHOW STAGES` lists the current schema by default, every schema with `IN DATABASE [db]`, everything with `IN ACCOUNT`.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'SHOW PRIMARY KEYS | UNIQUE KEYS | IMPORTED KEYS',
        behaviour: 'Returns Snowflake’s columns, with no rows.',
        status: 'partial',
        since: '1.0.0',
        note: 'Constraints are not tracked; reflection only needs the shape.',
      },
      {
        syntax: 'SHOW SEQUENCES',
        behaviour:
          'Lists the sequences in scope — `created_on`, `name`, `schema_name`, `database_name`, `next_value`, `interval`, `owner`, `comment`, `ordered` — honouring `IN …` and `LIKE`.',
        status: 'supported',
        since: '4.0.0',
        note: '`next_value` is read from the live counter, so it moves as values are used. `ordered` is always `YES`: DuckDB hands values out in order. `created_on` is when the sequence was created, or when this process first saw it.',
      },
      {
        syntax: 'SHOW FILE FORMATS',
        behaviour: 'Lists the formats in scope, honouring `IN SCHEMA`, `IN DATABASE`, `IN ACCOUNT` and `LIKE`.',
        status: 'supported',
        since: '1.0.0',
        note: 'Empty until a format is created: they are held in memory like roles and warehouses, so a restart forgets them.',
      },
      {
        syntax: 'DESCRIBE TABLE | VIEW',
        behaviour: 'Name, type, kind, nullability, default, key flags and comment. The table name matches exactly: `"orders"` is not `ORDERS`.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'DESCRIBE STAGE',
        behaviour:
          'Snowflake’s five property columns — `parent_property`, `property`, `property_type`, `property_value`, `property_default` — carrying `url`, `has_credentials`, `create_on`, `type`, `owner`, `comment` and `directory_enabled`.',
        status: 'supported',
        since: '4.0.0',
        note: '`has_credentials` is always `FALSE` (no stage credentials are stored) and `directory_enabled` always `FALSE` (there are no directory tables).',
      },
      {
        syntax: 'DESCRIBE FILE FORMAT',
        behaviour:
          'The same property table: `type`, then every option the format was created with, then `owner` and `create_on`.',
        status: 'supported',
        since: '4.0.0',
        note: 'Options are reported as written and never applied; a format is only known to the session that created it plus this process’s memory.',
      },
      {
        syntax: 'DESCRIBE SEQUENCE',
        behaviour:
          'One row — `created_on`, `name`, `next_value`, `interval`, `ordered` — for a sequence that exists, and object-not-found otherwise.',
        status: 'supported',
        since: '4.0.0',
      },
      {
        syntax: 'information_schema.columns | tables | views | schemata | databases',
        behaviour: 'Rewritten to carry the Snowflake-only columns, such as `bytes` and `last_altered`.',
        status: 'supported',
        since: '3.1.0',
      },
    ],
  },
  {
    id: 'sql',
    tab: 'SQL',
    title: 'SQL execution',
    summary: 'DuckDB behind a Snowflake dialect layer: the statements that reach it.',
    landingLabel: 'SQL execution',
    columns: STATUS_COLUMNS,
    rows: [
      {
        syntax: 'SELECT, INSERT, UPDATE, DELETE, MERGE',
        behaviour: 'Executed by DuckDB; bare column names in a `MERGE` insert list are qualified first.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'INSERT OVERWRITE INTO',
        behaviour: 'Rewritten to `DELETE` then `INSERT`.',
        status: 'supported',
        since: '1.0.0',
        note: 'What `dbt seed` emits for a table that already exists.',
      },
      {
        syntax: 'CREATE [OR REPLACE] TABLE … AS SELECT',
        behaviour: 'Creates and fills the table.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'CREATE [OR REPLACE] TABLE t (col type [NOT NULL] …) AS SELECT',
        behaviour:
          'Runs the query first, then creates the typed table and inserts by position, in one transaction: `CREATE OR REPLACE TABLE t (…) AS SELECT … FROM t` reads the old rows, and a NULL in a NOT NULL column fails the statement (`100072`) and keeps any table it was replacing.',
        status: 'partial',
        since: '1.0.0',
        note: 'PRIMARY KEY, UNIQUE and FOREIGN KEY are dropped, as Snowflake does not enforce them; `DESCRIBE` reports them as N.',
      },
      {
        syntax: 'ALTER TABLE … RENAME TO [db.][schema.]name',
        behaviour:
          'Renames in place within a schema. Across schemas, columns (type, NOT NULL) and rows are copied and the source dropped, in one transaction. Across databases (DuckDB writes one database per transaction), the copy is committed and its row count verified, then the source is dropped.',
        status: 'partial',
        since: '1.0.0',
        note: 'A moved table does not carry column defaults or comments. A cross-database rename is not atomic: if the source cannot be dropped, the copy is removed and the error reported.',
      },
      {
        syntax: 'ALTER TABLE … SWAP WITH …',
        behaviour: 'Exchanges the two tables in one transaction, across schemas of one database too.',
        status: 'partial',
        since: '1.0.0',
        note: 'Across databases it is refused with an error: three cross-database moves cannot be made atomic.',
      },
      {
        syntax: 'ALTER TABLE … CLUSTER BY (…) | DROP CLUSTERING KEY | SUSPEND RECLUSTER | RESUME RECLUSTER',
        behaviour: 'Accepted once the table is found to exist; a missing table is object-not-found.',
        status: 'partial',
        since: '1.0.0',
        note: 'No-ops: there is no clustering to change.',
      },
      {
        syntax: 'CREATE | DROP VIEW',
        behaviour: 'Ordinary views over the same catalog.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'CREATE [TRANSIENT | VOLATILE | TEMPORARY] TABLE',
        behaviour: 'Treated as an ordinary table.',
        status: 'partial',
        since: '1.0.0',
        note: 'No transient or temporary lifetime; nothing is dropped at session end.',
      },
      {
        syntax: 'CLUSTER BY, COPY GRANTS, DATA_RETENTION_TIME_IN_DAYS, CHANGE_TRACKING, ENABLE_SCHEMA_EVOLUTION',
        behaviour: 'Parsed and dropped from `CREATE`.',
        status: 'partial',
        since: '1.0.0',
        note: 'Accepted so ordinary DDL runs; none of it has an effect.',
      },
      {
        syntax: 'BEGIN | COMMIT | ROLLBACK',
        behaviour: 'A real transaction on the session’s own connection.',
        status: 'supported',
        since: '3.3.0',
        note: 'A rolled-back load leaves nothing behind, and a statement that fails inside the transaction aborts it until ROLLBACK. Account-level DDL (databases, schemas, warehouses, roles, stages) is not rolled back.',
      },
      {
        syntax: 'Semicolon (;) separated statements in one request',
        behaviour:
          'Each `;`-separated statement is routed and run in turn; the driver protocol answers with the last result, the SQL API with one per statement.',
        status: 'supported',
        since: '3.3.0',
        note: '`MULTI_STATEMENT_COUNT` is enforced when the client sets it. Separators inside strings, quoted names, comments and `$$…$$` do not split.',
      },
      {
        syntax: 'LATERAL FLATTEN(input => …) and FROM TABLE(FLATTEN(…))',
        behaviour:
          'Expanded into a `json_each` join exposing `SEQ`, `KEY`, `PATH`, `INDEX`, `VALUE` and `THIS`, with `path =>`, `outer => TRUE` and `mode => ARRAY | OBJECT | BOTH`. `VALUE` is JSON, so `VALUE:key` and `VALUE::number` work on it.',
        status: 'partial',
        since: '4.0.0',
        note: '`recursive => TRUE` is refused: it changes which rows come back. `SEQ` is the output row number, not a stored sequence, and the row `outer => TRUE` keeps has NULL in every column where Snowflake repeats `THIS` and `SEQ`.',
      },
      {
        syntax: 'CREATE TABLE … CLONE …',
        behaviour: 'Columns and rows copied into a new table.',
        status: 'partial',
        since: '3.3.0',
        note: 'A copy, not Snowflake’s zero-copy clone. `AT`/`BEFORE` and `CREATE DATABASE | SCHEMA … CLONE` are refused rather than approximated.',
      },
    ],
  },
  {
    id: 'functions',
    tab: 'Functions',
    title: 'Function translation',
    summary: 'Snowflake functions and types rewritten to DuckDB equivalents.',
    columns: ['Family', 'Translation', 'Status'],
    rows: [
      {
        syntax: 'IFF, DECODE, EQUAL_NULL',
        behaviour: '`CASE WHEN`, `CASE` with `IS NOT DISTINCT FROM` (so NULL matches NULL), `IS NOT DISTINCT FROM`.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'NVL, NVL2, ZEROIFNULL, NULLIFZERO, DIV0',
        behaviour: '`COALESCE`, `CASE`, `NULLIF`.',
        status: 'supported',
        since: '1.0.0',
      },
      { syntax: 'SQUARE', behaviour: '`x * x`.', status: 'supported', since: '1.0.0' },
      {
        syntax: 'LISTAGG, ARRAY_AGG, BOOLOR_AGG, BOOLAND_AGG',
        behaviour:
          '`string_agg`, `array_agg`, `bool_or`, `bool_and`; `WITHIN GROUP (ORDER BY …)` moves inside the call, so the order is kept. `ARRAY_AGG` skips NULLs and returns `[]` for no rows, as in Snowflake.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'CURRENT_TIMESTAMP, LOCALTIMESTAMP, CURRENT_TIME, LOCALTIME, CURRENT_DATE, SYSDATE, GETDATE — bare or with ()',
        behaviour:
          'DuckDB clock functions; `SYSDATE()` is the UTC wall clock as TIMESTAMP_NTZ. A precision of 0, 3 or 6–9 truncates accordingly.',
        status: 'partial',
        since: '1.0.0',
        note: 'Precisions 1, 2, 4 and 5 are refused with an error.',
      },
      {
        syntax: 'DATEADD, DATEDIFF, CONVERT_TIMEZONE',
        behaviour: 'Interval arithmetic, `date_diff`, `timezone()`.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax:
          'TO_VARCHAR | CHAR | TEXT, TO_DATE, TO_TIMESTAMP[_NTZ | _LTZ | _TZ], TO_BOOLEAN, TO_NUMBER | DECIMAL | NUMERIC, TO_DOUBLE, TO_BINARY, and their TRY_ variants',
        behaviour:
          'Casts; `TRY_` variants use `TRY_CAST` and return NULL on bad input. Date/time formats are translated (YYYY, YY, MM, MON, MMMM, DD, DY, HH24, HH12, AM, PM, MI, SS, FF3, FF6, FF9, FF (= FF9), TZH:TZM, "quoted text"); `TO_TIMESTAMP(n, scale)` reads an epoch value; `TO_BINARY` reads HEX, BASE64 and UTF-8.',
        status: 'partial',
        since: '1.0.0',
        note: 'Any other format element (HH, FF1, …), and any number format model, is refused with an error naming it rather than ignored.',
      },
      {
        syntax: 'ARRAY_CONSTRUCT, OBJECT_CONSTRUCT, PARSE_JSON, TO_JSON',
        behaviour: 'JSON arrays and objects.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'Variant paths: col:field.subfield',
        behaviour: '`json_extract`, or `json_extract_string` when cast to a string.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'Types: NUMBER, DECIMAL, NUMERIC, VARIANT, OBJECT, ARRAY, STRING, TEXT, BINARY, FLOAT, TIME, TIMESTAMP_NTZ | LTZ | TZ',
        behaviour:
          '`DECIMAL` — (38,0) when no precision is given, as in Snowflake, so `\'1.5\'::number` is 2 — then `JSON`, `VARCHAR`, `BLOB`, `DOUBLE`, `TIMESTAMP[TZ]`. Mapped only where a type is named (`::`, `CAST(… AS …)`, column definitions in `CREATE TABLE` and `ALTER TABLE … ADD | … TYPE`), so a column called `number` or `variant` stays a column. A cast to `TIME` accepts TIMESTAMP_TZ/LTZ (UTC wall clock; the engine runs in UTC) and refuses 24:00:00 (`TRY_CAST` gives NULL).',
        status: 'supported',
        since: '1.0.0',
        note: '`TIME(n)` casts truncate to n digits; timestamp casts take n of 0, 3 (truncated) or 6–9. Columns need n of 6–9 (DuckDB stores TIME/TZ in microseconds and rounds `TIMESTAMP(0|3)`); lower is an error. `TIMESTAMP_NTZ(9)` is nanoseconds, `(7)`/`(8)` an error. `DESCRIBE` reports `(9)`. `CREATE TABLE … AS SELECT x::timestamp_ntz(0)` columns are full precision: later fractional INSERT/MERGE values are kept, not truncated. `CREATE TABLE` TIME columns refuse 24:00:00 on insert; columns added by `ALTER TABLE … ADD` fail only when such a value is read.',
      },
      {
        syntax: 'CURRENT_DATABASE, CURRENT_SCHEMA, CURRENT_ROLE, CURRENT_USER, CURRENT_WAREHOUSE, CURRENT_ACCOUNT, CURRENT_VERSION',
        behaviour: 'Substituted from the connection’s session state; NULL when there is no current database or schema.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: "String literals: '…\\'…', '\\\\', '\\n', '\\t', '\\xhh', '\\uhhhh', '\\ooo'",
        behaviour: 'Backslash escapes are applied as in Snowflake before DuckDB sees the value.',
        status: 'partial',
        since: '1.0.0',
        note: 'A NUL character (`\\0`) is refused with an error.',
      },
      {
        syntax: 'Unquoted identifiers',
        behaviour:
          'Folded to upper case everywhere, so table, column and alias names come back as Snowflake reports them (`select a` → `A`); quoted names keep their case and are never rewritten.',
        status: 'supported',
        since: '1.0.0',
      },
    ],
  },
  {
    id: 'staging',
    tab: 'Stages',
    title: 'Staged files',
    summary: 'Local-filesystem stages: upload, list, load, download, remove.',
    landingLabel: 'Staged files',
    columns: STATUS_COLUMNS,
    rows: [
      {
        syntax: 'PUT file://… @stage',
        behaviour: 'Hands the client a local-filesystem stage to copy the file into.',
        status: 'supported',
        since: '1.0.0',
        note: 'Client and server must see the same absolute path; no bytes travel over HTTP.',
      },
      {
        syntax: 'GET @stage/… file://…',
        behaviour: 'Hands the client back the staged files to copy out.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'LIST | LS @stage [PATTERN = …]',
        behaviour: 'Lists the stage directory, with Snowflake’s list columns.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'REMOVE | RM @stage [PATTERN = …]',
        behaviour: 'Deletes staged files.',
        status: 'supported',
        since: '1.0.0',
      },
      {
        syntax: 'COPY INTO <table> FROM @stage',
        behaviour: 'Loads CSV, JSON and Parquet, honouring `TYPE`, `SKIP_HEADER`, `FIELD_DELIMITER`, `FIELD_OPTIONALLY_ENCLOSED_BY`, `NULL_IF`, `PATTERN` and `PURGE`.',
        status: 'supported',
        since: '1.0.0',
      },
    ],
  },
];

export const UNSUPPORTED: UnsupportedFeature[] = [
  {
    feature: 'Streams, tasks, dynamic tables',
    outcome: 'Not implemented; the statement reaches DuckDB and fails there.',
  },
  {
    feature: 'Snowpark UDFs and stored procedures',
    outcome: 'No function bodies are executed, in any language.',
  },
  {
    feature: 'Snowpipe and Snowpipe Streaming',
    outcome: 'There is no ingestion service; load with `COPY INTO` instead.',
  },
  {
    feature: 'Privilege and ownership enforcement',
    outcome: '`GRANT`/`REVOKE` are recorded and shown by `SHOW GRANTS`; no statement is authorised or refused, and ownership never changes hands.',
  },
  {
    feature: 'Warehouse sizing, credits and query cost',
    outcome: 'Warehouses are names only; nothing is billed or queued.',
  },
  {
    feature: 'ODBC and TLS',
    outcome: 'HTTP only. Terminate TLS in a proxy if a client insists on HTTPS.',
  },
  {
    feature: 'Driver async execution (`execute_async`)',
    outcome: 'Not polled. Use the SQL API with `async=true` for asynchronous work.',
  },
  {
    feature: 'Table functions other than FLATTEN',
    outcome: '`LATERAL FLATTEN` and `TABLE(FLATTEN(…))` are translated; `GENERATOR`, `RESULT_SCAN` and user table functions are not.',
  },
  {
    feature: 'Unloading: COPY INTO @stage',
    outcome: '`COPY INTO` only loads into a table; the reverse direction returns a Snowflake error.',
  },
  {
    feature: 'GET /api/v2/statements?statement=…',
    outcome: 'Not routed; POST the statement instead.',
  },
  {
    feature: 'ALTER SCHEMA … RENAME TO',
    outcome: 'Fails with `not supported on snowtest`.',
  },
  {
    feature: 'ALTER SCHEMA … SWAP WITH',
    outcome: 'Fails with `not supported on snowtest`.',
  },
  {
    feature: "Bracket variant paths cast to string (`col['a']::string`)",
    outcome: 'Fails with `not supported on snowtest`; write `col:a::string`.',
  },
];

const STATUS_TEXT: Record<OperationStatus, string> = {
  supported: 'supported',
  partial: 'partial',
  unsupported: 'not supported',
};

const STATUS_ORDER: OperationStatus[] = ['supported', 'partial', 'unsupported'];

/** Display rank of a status: everything that works first, the gaps after it. */
const STATUS_RANK = new Map(STATUS_ORDER.map((status, index) => [status, index]));

/**
 * Sort key for the statement column: punctuation and code fencing dropped, so the
 * order is the one a reader expects. Comparing the raw text would put
 * `CREATE | DROP VIEW` after every bracketed variant, because `|`, `[` and `_`
 * collate unpredictably against letters.
 */
const statementKey = (syntax: string): string =>
  syntax.replace(/[^A-Za-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Rows as displayed: supported, then partial, then unsupported, and alphabetical
 * by statement within each. The table is authored in logical groups, not in
 * display order, so the sort happens here rather than in the data.
 */
function sortedRows(group: OperationGroup): OperationRow[] {
  return [...group.rows].sort((left, right) => {
    const rank = (STATUS_RANK.get(left.status) ?? 0) - (STATUS_RANK.get(right.status) ?? 0);
    if (rank !== 0) return rank;
    return statementKey(left.syntax).localeCompare(statementKey(right.syntax), 'en', {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

const countByStatus = (status: OperationStatus): number =>
  GROUPS.reduce((total, group) => total + group.rows.filter((row) => row.status === status).length, 0);

/** Landing-page summary rows, derived from the same table. */
export const LANDING_SURFACES = GROUPS.filter((group) => group.landingLabel !== undefined).map(
  (group) => ({
    id: group.id,
    label: group.landingLabel as string,
    summary: group.summary,
    supported: group.rows.filter((row) => row.status === 'supported').length,
    total: group.rows.length,
  }),
);

function renderRow(row: OperationRow, index: number): string {
  const note = row.note ? `<span class="note">${inlineMarkup(row.note)}</span>` : '';
  return `      <tr>
        <td class="rn">${index + 1}</td>
        <td><code>${escapeHtml(row.syntax)}</code></td>
        <td>${inlineMarkup(row.behaviour)}${note}</td>
        <td><span class="pill pill-${row.status}">${STATUS_TEXT[row.status]}</span></td>
        <td class="since">${escapeHtml(row.since)}</td>
      </tr>`;
}

const paneHead = (title: string, count: number): string =>
  `<h2 class="panehead">${escapeHtml(title)} <span class="badge">${count} entries</span></h2>`;

function renderGroup(group: OperationGroup): string {
  const rows = sortedRows(group).map(renderRow).join('\n');
  return `${paneHead(group.title, group.rows.length)}
<p class="muted">${escapeHtml(group.summary)}</p>
<table>
  <thead>
    <tr><th scope="col" class="rn">#</th><th scope="col">${escapeHtml(group.columns[0])}</th><th scope="col">${escapeHtml(group.columns[1])}</th><th scope="col">${escapeHtml(group.columns[2])}</th><th scope="col" class="since">Since</th></tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}

/** The page served at `/operations`. */
export function renderOperations(version: string): string {
  const total = GROUPS.reduce((sum, group) => sum + group.rows.length, 0);
  const counts = STATUS_ORDER.map((status) => `${countByStatus(status)} ${STATUS_TEXT[status]}`).join(', ');
  const entries = total + UNSUPPORTED.length;

  const unsupportedRows = UNSUPPORTED.map(
    (item, index) =>
      `      <tr><td class="rn">${index + 1}</td><td>${inlineMarkup(item.feature)}</td><td>${inlineMarkup(item.outcome)}</td></tr>`,
  ).join('\n');
  const unsupported = `${paneHead('Not supported', UNSUPPORTED.length)}
<p class="muted">Called out so nobody guesses, and so a failure is understood before it is debugged.</p>
<table>
  <thead>
    <tr><th scope="col" class="rn">#</th><th scope="col">Feature</th><th scope="col">What you get</th></tr>
  </thead>
  <tbody>
${unsupportedRows}
  </tbody>
</table>`;

  const tabs = renderTabs(
    [
      ...GROUPS.map((group) => ({ id: group.id, label: group.tab, title: group.title, html: renderGroup(group) })),
      { id: 'not-supported', label: 'Not supported', html: unsupported },
    ].sort((first, second) => {
      // Alphabetical by tab, except "Not supported": it is a catch-all rather
      // than an area, so it stays at the end where it is looked for.
      const pinned = (tab: { id: string }) => (tab.id === 'not-supported' ? 1 : 0);
      return pinned(first) - pinned(second) || first.label.localeCompare(second.label);
    }),
    { hash: true, variant: 'dense' },
  );

  const body = `<h1>Supported operations</h1>
<p class="lede">
  Everything this server answers: the driver protocol, the SQL REST API, the control
  plane, and the SQL it can run. A row marked partial works but has a gap, and every
  one of those rows says what the gap is — those are the calls that can quietly
  pass a test for the wrong reason. Rows run supported first, then partial, then
  not supported, and alphabetically by statement within each group.
  <strong>Since</strong> names the snowtest
  release that gave a row the status it shows today, read from that release's own
  table, so a promoted row carries the version of the promotion.
</p>

<div class="card">
  <strong>${entries} entries</strong> &mdash; ${total} endpoints and statements (${counts}),
  plus ${UNSUPPORTED.length} features listed as not supported.
</div>

<div class="ops">
${tabs}
</div>`;

  return renderPage({ title: 'snowtest — supported operations', body, version, nav: 'operations' });
}
