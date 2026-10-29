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

import { escapeHtml, inlineMarkup, renderPage } from './page.js';

export type OperationStatus = 'supported' | 'partial' | 'unsupported';

export interface OperationRow {
  /** What a client sends, or the feature being described. */
  syntax: string;
  /** What the server does with it. */
  behaviour: string;
  status: OperationStatus;
  /** The gap, when status is `partial`. */
  note?: string;
}

export interface OperationGroup {
  /** Anchor on this page; also the landing-page link target. */
  id: string;
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
    title: 'Driver protocol',
    summary: 'The paths Snowflake drivers call: login, heartbeat, query, fetch, logout.',
    landingLabel: 'Driver protocol',
    columns: ENDPOINT_COLUMNS,
    rows: [
      {
        syntax: 'POST /session/v1/login-request',
        behaviour: 'Password, account and key-pair logins; issues a session token.',
        status: 'supported',
      },
      {
        syntax: 'GET /session/v1/login-request',
        behaviour: 'Renews the session token on the driver renewal path.',
        status: 'supported',
      },
      {
        syntax: 'POST /session/token-request',
        behaviour: 'Renews the session token.',
        status: 'supported',
      },
      {
        syntax: 'POST /session/heartbeat',
        behaviour: 'Keeps a long-lived session alive.',
        status: 'supported',
      },
      { syntax: 'POST /session, GET /session', behaviour: 'Logout.', status: 'supported' },
      {
        syntax: 'POST /queries/v1/query-request',
        behaviour: 'Runs one statement and returns its rows inline.',
        status: 'supported',
      },
      {
        syntax: 'GET /queries/v1/query-result/:queryId',
        behaviour: 'Fetches a stored result for a query id.',
        status: 'partial',
        note: 'One partition. A real account may return partitions 0…n.',
      },
      {
        syntax: 'POST /queries/v1/abort-request',
        behaviour: 'Acknowledges an abort.',
        status: 'partial',
        note: 'Statements run to completion on the request thread; nothing is interrupted.',
      },
      {
        syntax: 'GET /monitoring/queries/:id',
        behaviour: 'Recent query log, which the connector reads for diagnostics.',
        status: 'supported',
      },
      {
        syntax: 'POST /telemetry/send',
        behaviour: 'Accepted and discarded.',
        status: 'supported',
      },
    ],
  },
  {
    id: 'sql-api',
    title: 'SQL REST API v2',
    summary: 'The documented HTTP API: submit a statement, poll a handle, cancel it.',
    landingLabel: 'SQL REST API v2',
    columns: ENDPOINT_COLUMNS,
    rows: [
      {
        syntax: 'POST /api/v2/statements',
        behaviour: 'Runs a statement synchronously and returns the rows in `data`.',
        status: 'supported',
      },
      {
        syntax: 'POST /api/v2/statements?async=true',
        behaviour: 'Returns a handle immediately, with the statement still running.',
        status: 'supported',
      },
      {
        syntax: 'GET /api/v2/statements/:handle',
        behaviour: 'Polls the handle until it completes, then returns the rows.',
        status: 'supported',
      },
      {
        syntax: 'POST /api/v2/statements/:handle/cancel',
        behaviour: 'Marks the handle cancelled.',
        status: 'supported',
      },
      {
        syntax: 'Request body: statement, bindings',
        behaviour: 'Positional and named bindings, typed by the driver.',
        status: 'supported',
      },
      {
        syntax: 'database, schema, role, warehouse, timeout',
        behaviour: 'Per-request overrides of the session context.',
        status: 'supported',
      },
    ],
  },
  {
    id: 'control-plane',
    title: 'Control plane',
    summary: 'Endpoints for tests and operators, outside the Snowflake surface.',
    columns: ENDPOINT_COLUMNS,
    rows: [
      { syntax: 'GET /', behaviour: 'The landing page: what this is, and how to connect.', status: 'supported' },
      { syntax: 'GET /operations', behaviour: 'This page.', status: 'supported' },
      {
        syntax: 'GET /usage',
        behaviour: 'Configuration, the launcher, staging and troubleshooting, for the running build.',
        status: 'supported',
      },
      {
        syntax: 'GET /browse/:database/:schema[/:table]',
        behaviour: 'Catalog browser: objects, row counts, and a preview of the first rows of any table or view.',
        status: 'supported',
      },
      {
        syntax: 'GET /_snowtest/health',
        behaviour: 'Liveness probe, with both the emulated Snowflake version and the snowtest version.',
        status: 'supported',
      },
      {
        syntax: 'GET /_snowtest/state',
        behaviour: 'Databases, schemas, warehouses, roles, stages and session count.',
        status: 'supported',
      },
      {
        syntax: 'POST /_snowtest/seed',
        behaviour: 'Runs a SQL script sent as `{"sql": "..."}`.',
        status: 'supported',
      },
      {
        syntax: 'POST /_snowtest/reset',
        behaviour: 'Drops everything and recreates the configured catalog.',
        status: 'supported',
      },
    ],
  },
  {
    id: 'sessions',
    title: 'Sessions and authentication',
    summary: 'Who may connect, and what a session remembers.',
    columns: ['Feature', 'Behaviour', 'Status'],
    rows: [
      {
        syntax: 'Permissive logins (default)',
        behaviour: 'Any user and password is accepted.',
        status: 'supported',
        note: 'Nothing is authorised. Never expose the server publicly.',
      },
      {
        syntax: 'SNOWTEST_USERS',
        behaviour: 'Comma-separated login allow-list; other names are refused at login.',
        status: 'supported',
      },
      {
        syntax: 'Key-pair JWT',
        behaviour: 'RS256, RS384 and RS512, with the signature checked against the configured public key.',
        status: 'supported',
      },
      {
        syntax: 'Key-pair claims',
        behaviour: '`exp` is enforced and `iss` must name the login user.',
        status: 'supported',
      },
      {
        syntax: 'Session token renewal',
        behaviour: 'Both driver renewal paths mint a fresh token for the same session.',
        status: 'supported',
      },
      {
        syntax: 'USE DATABASE | SCHEMA | WAREHOUSE | ROLE',
        behaviour: 'Switches the session context, including bare `USE`.',
        status: 'supported',
      },
      {
        syntax: 'ALTER SESSION SET key = value',
        behaviour: 'Stored on the session and echoed by `SHOW PARAMETERS`.',
        status: 'partial',
        note: 'Not applied to result formatting: DATE_OUTPUT_FORMAT and TIMESTAMP_*_OUTPUT_FORMAT are accepted and ignored.',
      },
    ],
  },
  {
    id: 'account-objects',
    title: 'Databases, schemas and account objects',
    summary: 'What can be created, and how much of it is only recorded.',
    columns: STATUS_COLUMNS,
    rows: [
      {
        syntax: 'CREATE | DROP DATABASE',
        behaviour: 'Creates or drops the database and its DuckDB catalog.',
        status: 'supported',
      },
      {
        syntax: 'CREATE | DROP SCHEMA',
        behaviour: 'Creates or drops a schema in place.',
        status: 'supported',
      },
      {
        syntax: 'CREATE | DROP WAREHOUSE',
        behaviour: 'Recorded in the catalog; it shows up in `SHOW WAREHOUSES`.',
        status: 'supported',
        note: 'No sizing, queues or credits.',
      },
      {
        syntax: 'CREATE | DROP ROLE',
        behaviour: 'Recorded and shown by `SHOW ROLES`.',
        status: 'supported',
        note: 'No privileges attach to a role.',
      },
      {
        syntax: 'CREATE | DROP STAGE',
        behaviour: 'Creates or removes the stage directory that `PUT` writes into.',
        status: 'supported',
      },
      {
        syntax: 'CREATE | DROP FILE FORMAT',
        behaviour: 'Accepted and recorded.',
        status: 'partial',
        note: 'Copy options are read from `COPY INTO`, not from the format object.',
      },
      {
        syntax: 'CREATE | DROP USER',
        behaviour: 'Accepted and recorded.',
        status: 'partial',
        note: 'No credentials, roles or policies attach to the user.',
      },
      {
        syntax: 'ALTER DATABASE | SCHEMA | WAREHOUSE | ROLE',
        behaviour: 'Accepted.',
        status: 'partial',
        note: 'No-ops: there is no sizing, retention or ownership to change.',
      },
      {
        syntax: 'COMMENT ON …',
        behaviour: 'Accepted.',
        status: 'partial',
        note: 'No-ops; comments are not stored.',
      },
    ],
  },
  {
    id: 'metadata',
    title: 'Metadata and reflection',
    summary: 'What dbt, SQLAlchemy and the connector ask about the catalog.',
    landingLabel: 'Metadata',
    columns: STATUS_COLUMNS,
    rows: [
      {
        syntax: 'SHOW [TERSE] DATABASES | SCHEMAS | TABLES | VIEWS | COLUMNS | OBJECTS | FUNCTIONS | WAREHOUSES | ROLES | STAGES | PARAMETERS | GRANTS | USERS',
        behaviour: 'Answers from the catalog, honouring `IN …`, `LIKE …` and `LIMIT`.',
        status: 'supported',
      },
      {
        syntax: 'SHOW PRIMARY KEYS | UNIQUE KEYS | IMPORTED KEYS',
        behaviour: 'Returns Snowflake’s columns, with no rows.',
        status: 'partial',
        note: 'Constraints are not tracked; reflection only needs the shape.',
      },
      {
        syntax: 'SHOW SEQUENCES',
        behaviour: 'Returns a single `name` column, empty.',
        status: 'partial',
        note: 'Sequences are not implemented, including `seq.NEXTVAL`.',
      },
      {
        syntax: 'SHOW FILE FORMATS',
        behaviour: 'Returns Snowflake’s columns, with no rows.',
        status: 'partial',
        note: 'File formats are not listed; create and copy still work.',
      },
      {
        syntax: 'DESCRIBE TABLE | VIEW',
        behaviour: 'Name, type, kind, nullability, default, key flags and comment.',
        status: 'supported',
      },
      {
        syntax: 'DESCRIBE STAGE | FILE FORMAT | SEQUENCE',
        behaviour: 'Not implemented.',
        status: 'unsupported',
        note: '`DESCRIBE` resolves a table or view, and fails with object-not-found otherwise.',
      },
      {
        syntax: 'information_schema.columns | tables | views | schemata',
        behaviour: 'Rewritten to carry the Snowflake-only columns, such as `bytes` and `last_altered`.',
        status: 'supported',
      },
    ],
  },
  {
    id: 'sql',
    title: 'SQL execution',
    summary: 'DuckDB behind a Snowflake dialect layer: the statements that reach it.',
    landingLabel: 'SQL execution',
    columns: STATUS_COLUMNS,
    rows: [
      {
        syntax: 'SELECT, INSERT, UPDATE, DELETE, MERGE',
        behaviour: 'Executed by DuckDB; bare column names in a `MERGE` insert list are qualified first.',
        status: 'supported',
      },
      {
        syntax: 'INSERT OVERWRITE INTO',
        behaviour: 'Rewritten to `DELETE` then `INSERT`.',
        status: 'supported',
        note: 'What `dbt seed` emits for a table that already exists.',
      },
      {
        syntax: 'CREATE [OR REPLACE] TABLE … AS SELECT',
        behaviour: 'Creates and fills the table.',
        status: 'supported',
      },
      {
        syntax: 'CREATE | DROP VIEW',
        behaviour: 'Ordinary views over the same catalog.',
        status: 'supported',
      },
      {
        syntax: 'CREATE [TRANSIENT | VOLATILE | TEMPORARY] TABLE',
        behaviour: 'Treated as an ordinary table.',
        status: 'partial',
        note: 'No transient or temporary lifetime; nothing is dropped at session end.',
      },
      {
        syntax: 'CLUSTER BY, COPY GRANTS, DATA_RETENTION_TIME_IN_DAYS, CHANGE_TRACKING, ENABLE_SCHEMA_EVOLUTION',
        behaviour: 'Parsed and dropped.',
        status: 'partial',
        note: 'Accepted so ordinary DDL runs; none of it has an effect.',
      },
      {
        syntax: 'BEGIN | COMMIT | ROLLBACK',
        behaviour: 'Accepted.',
        status: 'partial',
        note: 'DuckDB autocommits: there is no transaction isolation across sessions.',
      },
    ],
  },
  {
    id: 'functions',
    title: 'Function translation',
    summary: 'Snowflake functions and types rewritten to DuckDB equivalents.',
    columns: ['Family', 'Translation', 'Status'],
    rows: [
      {
        syntax: 'IFF, DECODE, EQUAL_NULL',
        behaviour: '`CASE WHEN`, `CASE`, `IS NOT DISTINCT FROM`.',
        status: 'supported',
      },
      {
        syntax: 'NVL, NVL2, ZEROIFNULL, NULLIFZERO, DIV0',
        behaviour: '`COALESCE`, `CASE`, `NULLIF`.',
        status: 'supported',
      },
      { syntax: 'SQUARE', behaviour: '`x * x`.', status: 'supported' },
      {
        syntax: 'LISTAGG, BOOLOR_AGG, BOOLAND_AGG',
        behaviour: '`string_agg`, `bool_or`, `bool_and`; `WITHIN GROUP` is stripped.',
        status: 'supported',
      },
      {
        syntax: 'GETDATE, SYSDATE, DATEADD, DATEDIFF, CONVERT_TIMEZONE',
        behaviour: '`now()`, interval arithmetic, `date_diff`, `timezone()`.',
        status: 'supported',
      },
      {
        syntax: 'TO_VARCHAR | CHAR | TEXT, TO_BOOLEAN, TO_DATE, TO_TIMESTAMP*, TO_BINARY, TO_NUMBER | DECIMAL | NUMERIC',
        behaviour: 'Casts, with `TRY_` variants returning `NULL` instead of failing.',
        status: 'supported',
      },
      {
        syntax: 'ARRAY_CONSTRUCT, OBJECT_CONSTRUCT, PARSE_JSON, TO_JSON',
        behaviour: 'JSON arrays and objects.',
        status: 'supported',
      },
      {
        syntax: 'Variant paths: col:field.subfield',
        behaviour: '`json_extract`, or `json_extract_string` when cast to a string.',
        status: 'supported',
      },
      {
        syntax: 'Types: NUMBER, VARIANT, STRING, BINARY, TIMESTAMP_NTZ',
        behaviour: '`DECIMAL`, `JSON`, `VARCHAR`, `BLOB`, `TIMESTAMP`.',
        status: 'supported',
      },
      {
        syntax: 'CURRENT_DATABASE, CURRENT_SCHEMA, CURRENT_ROLE, CURRENT_USER, CURRENT_WAREHOUSE, CURRENT_ACCOUNT, CURRENT_VERSION',
        behaviour: 'Substituted from the connection’s session state.',
        status: 'supported',
      },
      {
        syntax: 'Unquoted identifiers',
        behaviour: 'Folded to upper case, as Snowflake folds them.',
        status: 'supported',
      },
    ],
  },
  {
    id: 'staging',
    title: 'Staged files',
    summary: 'Local-filesystem stages: upload, list, load, download, remove.',
    landingLabel: 'Staged files',
    columns: STATUS_COLUMNS,
    rows: [
      {
        syntax: 'PUT file://… @stage',
        behaviour: 'Hands the client a local-filesystem stage to copy the file into.',
        status: 'supported',
        note: 'Client and server must see the same absolute path; no bytes travel over HTTP.',
      },
      {
        syntax: 'GET @stage/… file://…',
        behaviour: 'Hands the client back the staged files to copy out.',
        status: 'supported',
      },
      {
        syntax: 'LIST | LS @stage [PATTERN = …]',
        behaviour: 'Lists the stage directory, with Snowflake’s list columns.',
        status: 'supported',
      },
      {
        syntax: 'REMOVE | RM @stage [PATTERN = …]',
        behaviour: 'Deletes staged files.',
        status: 'supported',
      },
      {
        syntax: 'COPY INTO <table> FROM @stage',
        behaviour: 'Loads CSV, JSON and Parquet, honouring `TYPE`, `SKIP_HEADER`, `FIELD_DELIMITER`, `FIELD_OPTIONALLY_ENCLOSED_BY`, `NULL_IF`, `PATTERN` and `PURGE`.',
        status: 'supported',
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
    feature: 'GRANT and REVOKE, privilege and ownership checks',
    outcome: 'No RBAC: any role may do anything, and these statements fail.',
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
    feature: 'Multiple statements per request',
    outcome: 'One statement per request; `MULTI_STATEMENT_COUNT` is ignored.',
  },
  {
    feature: 'Driver async execution (`execute_async`)',
    outcome: 'Not polled. Use the SQL API with `async=true` for asynchronous work.',
  },
  {
    feature: 'LATERAL FLATTEN and table functions',
    outcome: 'No translation; the statement fails rather than approximating an answer.',
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
    feature: 'Persistence',
    outcome: 'Data lives in memory and a temp stage directory: a restart is a clean slate.',
  },
];

const STATUS_TEXT: Record<OperationStatus, string> = {
  supported: 'supported',
  partial: 'partial',
  unsupported: 'not supported',
};

const STATUS_ORDER: OperationStatus[] = ['supported', 'partial', 'unsupported'];

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

function renderRow(row: OperationRow): string {
  const note = row.note ? `<span class="note">${inlineMarkup(row.note)}</span>` : '';
  return `      <tr>
        <td><code>${escapeHtml(row.syntax)}</code></td>
        <td>${inlineMarkup(row.behaviour)}${note}</td>
        <td><span class="pill pill-${row.status}">${STATUS_TEXT[row.status]}</span></td>
      </tr>`;
}

function renderGroup(group: OperationGroup): string {
  const rows = group.rows.map(renderRow).join('\n');
  return `<h2 id="${escapeHtml(group.id)}">${escapeHtml(group.title)}</h2>
<p class="muted">${escapeHtml(group.summary)}</p>
<table>
  <thead>
    <tr><th scope="col">${escapeHtml(group.columns[0])}</th><th scope="col">${escapeHtml(group.columns[1])}</th><th scope="col">${escapeHtml(group.columns[2])}</th></tr>
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

  const toc = [
    ...GROUPS.map(
      (group) =>
        `        <li><a href="#${escapeHtml(group.id)}">${escapeHtml(group.title)}</a><span class="count">${group.rows.length}</span></li>`,
    ),
    `        <li><a href="#not-supported">Not supported</a><span class="count">${UNSUPPORTED.length}</span></li>`,
  ].join('\n');

  const groups = GROUPS.map(renderGroup).join('\n\n');
  const unsupportedRows = UNSUPPORTED.map(
    (item) =>
      `      <tr><td>${inlineMarkup(item.feature)}</td><td>${inlineMarkup(item.outcome)}</td></tr>`,
  ).join('\n');

  const body = `<p class="crumb"><a href="/">&larr; Overview</a></p>
<span class="tag">snowtest &middot; emulating Snowflake ${escapeHtml(version)}</span>
<h1>Supported operations</h1>
<p class="lede">
  Everything this server answers: the driver protocol, the SQL REST API, the control
  plane, and the SQL it can run. A row marked partial works but has a gap, and every
  one of those rows says what the gap is — those are the calls that can quietly
  pass a test for the wrong reason.
</p>

<div class="card">
  <strong>${entries} entries</strong> &mdash; ${total} endpoints and statements (${counts}),
  plus ${UNSUPPORTED.length} features listed as not supported.
</div>

<div class="layout">
  <nav class="toc" aria-label="On this page">
    <div class="muted">On this page</div>
    <ol>
${toc}
    </ol>
  </nav>

  <main class="ops">
${groups}

<h2 id="not-supported">Not supported</h2>
<p class="muted">Called out so nobody guesses, and so a failure is understood before it is debugged.</p>
<table>
  <thead>
    <tr><th scope="col">Feature</th><th scope="col">What you get</th></tr>
  </thead>
  <tbody>
${unsupportedRows}
  </tbody>
</table>

  </main>
</div>

<footer>
  Configuration and troubleshooting are at <a href="/usage">/usage</a>.
</footer>`;

  return renderPage({ title: 'snowtest — supported operations', body, bodyClass: 'wide' });
}
