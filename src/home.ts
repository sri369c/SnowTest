// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * The page served at `/`.
 *
 * A stub that only answers protocol endpoints is hard to approach: you have to
 * read the README before you know what to point at it. This page is the
 * five-second version — what the process is, the values to connect with, and
 * the limits worth knowing before trusting it.
 *
 * Rendered inline rather than as a static asset so the runtime image keeps
 * carrying nothing but `dist/`.
 */

import type { SnowtestConfig } from './config.js';
import { PACKAGE_VERSION } from './version.js';

/** Catalog and session snapshot shown on the landing page. */
export interface HomeSchemaState {
  name: string;
  tables: number;
  views: number;
}

export interface HomeDatabaseState {
  name: string;
  schemas: HomeSchemaState[];
}

export interface HomeSessionState {
  user: string;
  database: string;
  schema: string;
  role: string;
}

export interface HomeState {
  databases: HomeDatabaseState[];
  warehouses: string[];
  roles: string[];
  stages: number;
  sessions: HomeSessionState[];
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );

export function renderHome(
  config: SnowtestConfig,
  origin: string,
  version: string,
  state: HomeState,
): string {
  const account = escapeHtml(config.account);
  const database = escapeHtml(config.defaultDatabase);
  const schema = escapeHtml(config.defaultSchema);
  const warehouse = escapeHtml(config.defaultWarehouse);
  const endpoint = escapeHtml(origin);
  const port = config.port;
  const verified = config.jwtPublicKey !== null;
  const authLine = verified
    ? 'key-pair JWT — signatures verified against the configured public key'
    : 'permissive — any user and password is accepted';
  const usersLine =
    config.users.length > 0
      ? `, login names limited to ${escapeHtml(config.users.join(', '))}`
      : '';

  const objectCount = state.databases.reduce(
    (total, db) =>
      total + db.schemas.reduce((sum, schema) => sum + schema.tables + schema.views, 0),
    0,
  );
  const databaseRows =
    state.databases
      .flatMap((db) =>
        db.schemas.map(
          (schema) =>
            `    <tr><td><code>${escapeHtml(db.name)}</code></td><td><code>${escapeHtml(schema.name)}</code></td><td>${schema.tables}</td><td>${schema.views}</td></tr>`,
        ),
      )
      .join('\n') || '    <tr><td colspan="4">No databases yet.</td></tr>';
  const sessionRows =
    state.sessions
      .map(
        (session) =>
          `    <tr><td><code>${escapeHtml(session.user)}</code></td><td><code>${escapeHtml(session.database)}.${escapeHtml(session.schema)}</code></td><td>${escapeHtml(session.role)}</td></tr>`,
      )
      .join('\n') || '    <tr><td colspan="3">No active sessions.</td></tr>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>snowtest — Snowflake-compatible stub server</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; padding: 2.5rem 1.25rem 4rem; max-width: 52rem;
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #1b1f24; background: #fff;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #e6edf3; background: #0d1117; }
    code, pre { background: #161b22 !important; border-color: #30363d !important; }
    th, td { border-color: #30363d !important; }
    .card { background: #161b22 !important; border-color: #30363d !important; }
    a { color: #6cb6ff; }
  }
  h1 { font-size: 1.9rem; margin: 0 0 .25rem; letter-spacing: -.02em; }
  h2 { font-size: 1.15rem; margin: 2.25rem 0 .75rem; }
  h3 { font-size: .95rem; margin: 1.5rem 0 .4rem; }
  .muted { color: #57606a; font-size: .9rem; }
  p { margin: .6rem 0; }
  .tag { display: inline-block; font-size: .75rem; letter-spacing: .04em;
         text-transform: uppercase; color: #57606a; margin-bottom: .5rem; }
  .lede { font-size: 1.02rem; color: #57606a; }
  .card { border: 1px solid #d0d7de; border-radius: 8px; padding: 1rem 1.15rem;
          background: #f6f8fa; margin: 1.25rem 0; }
  table { border-collapse: collapse; width: 100%; font-size: .92rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #d0d7de; }
  th { font-weight: 600; }
  td:first-child { white-space: nowrap; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
         font-size: .875em; background: #f6f8fa; border: 1px solid #d0d7de;
         border-radius: 5px; padding: .1rem .3rem; }
  pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 8px;
        padding: .85rem 1rem; overflow-x: auto; font-size: .85rem; line-height: 1.5; }
  pre code { background: none; border: 0; padding: 0; font-size: inherit; }
  ul { margin: .5rem 0; padding-left: 1.2rem; }
  li { margin: .25rem 0; }
  a { color: #0969da; }
  .warn { border-left: 3px solid #bf8700; padding-left: .9rem; color: #57606a; }
  footer { margin-top: 3rem; font-size: .85rem; color: #57606a; }
</style>
</head>
<body>

<span class="tag">snowtest ${escapeHtml(PACKAGE_VERSION)} &middot; emulating Snowflake ${escapeHtml(version)}</span>
<h1>A Snowflake-compatible stub server</h1>
<p class="lede">
  Point a Snowflake client's host and port here and it answers the way Snowflake does —
  no account, no warehouse cost, no network. Use it for integration tests, local
  development and CI.
</p>

<div class="card">
  <table>
    <tr><th>Endpoint</th><td><code>${endpoint}</code></td></tr>
    <tr><th>Account</th><td><code>${account}</code></td></tr>
    <tr><th>Default context</th><td><code>${database}.${schema}</code> &middot; warehouse <code>${warehouse}</code></td></tr>
    <tr><th>Auth</th><td>${authLine}${usersLine}</td></tr>
  </table>
</div>

<h2>Live state</h2>
<p class="muted">
  ${state.databases.length} database(s) &middot; ${objectCount} table/view(s) &middot;
  ${state.warehouses.length} warehouse(s) &middot; ${state.roles.length} role(s) &middot;
  ${state.stages} stage(s) &middot; ${state.sessions.length} session(s). Reload to refresh.
</p>
<table>
  <tr><th>Database</th><th>Schema</th><th>Tables</th><th>Views</th></tr>
${databaseRows}
</table>

<h3>Active sessions</h3>
<table>
  <tr><th>User</th><th>Context</th><th>Role</th></tr>
${sessionRows}
</table>

<h2>Connect with the Python connector</h2>
<pre><code>import snowflake.connector

conn = snowflake.connector.connect(
    account="${account}", user="test", password="test",
    host="localhost", port=${port}, protocol="http",
    database="${database}", schema="${schema}", warehouse="${warehouse}",
)
cur = conn.cursor()
cur.execute("SELECT CURRENT_DATABASE(), CURRENT_SCHEMA()")
print(cur.fetchall())</code></pre>

<h2>Connect with dbt</h2>
<p>Key-pair auth is the normal way a service account reaches Snowflake, so it is the
normal way to reach this too. Add these keys to any dbt-snowflake profile:</p>
<pre><code>snowtest:
  target: dev
  outputs:
    dev:
      type: snowflake
      account: ${account}
      user: DBT_SVC
      authenticator: snowflake_jwt
      private_key_path: /absolute/path/to/rsa_key.p8
      database: ${database}
      schema: ${schema}
      warehouse: ${warehouse}
      role: SYSADMIN
      threads: 4
      host: localhost      # "snowtest" from another container
      port: ${port}
      protocol: http</code></pre>
<p>Generated keys are only verified when the server was started with a public key
(<code>SNOWTEST_JWT_PUBLIC_KEY</code>); otherwise any credential is accepted.</p>

<h2>Or just curl it</h2>
<pre><code>curl -s -X POST '${endpoint}/api/v2/statements' \\
  -H 'Authorization: Bearer test' \\
  -H 'Content-Type: application/json' \\
  -d '{"statement":"SELECT 1 AS n"}'</code></pre>

<h2>What it speaks</h2>
<table>
  <tr><th>Surface</th><td>Notes</td></tr>
  <tr><th>Driver protocol</th><td><code>/session/v1/login-request</code>, <code>/queries/v1/query-request</code>, heartbeat, token refresh, logout — the path the Python connector, Snowpark and JDBC-style clients use</td></tr>
  <tr><th>SQL REST API v2</th><td><code>/api/v2/statements</code>, async handles, cancel</td></tr>
  <tr><th>SQL execution</th><td>DuckDB behind a Snowflake dialect layer: <code>IFF</code>, <code>NVL</code>, <code>DIV0</code>, <code>DATEADD</code>, <code>DATEDIFF</code>, <code>LISTAGG</code>, <code>TO_*</code> casts, variant paths</td></tr>
  <tr><th>Metadata</th><td><code>SHOW</code>, <code>DESCRIBE</code>, <code>USE</code>, <code>ALTER SESSION</code>, <code>information_schema</code> — what dbt and SQLAlchemy reflection need</td></tr>
  <tr><th>Staged files</th><td><code>CREATE STAGE</code>, <code>PUT</code>, <code>GET</code>, <code>LIST</code>, <code>REMOVE</code>, <code>COPY INTO</code> over local-filesystem stages</td></tr>
</table>

<h2>Control plane</h2>
<table>
  <tr><th><code>GET /_snowtest/health</code></th><td>liveness probe</td></tr>
  <tr><th><code>GET /_snowtest/state</code></th><td>databases, schemas, warehouses, roles, stages, sessions</td></tr>
  <tr><th><code>POST /_snowtest/seed</code></th><td>run a SQL script: <code>{"sql": "..."}</code></td></tr>
  <tr><th><code>POST /_snowtest/reset</code></th><td>drop everything and recreate the configured catalog</td></tr>
</table>

<h2>What it is not</h2>
<p class="warn">
  A test double, not a replacement. No TLS, no users, roles or privileges, no ODBC,
  no warehouse sizing or cost behaviour, one result partition, JSON only. Staged
  transfers use a local directory instead of cloud object storage.
</p>
<ul>
  <li>Nothing here authenticates or authorises unless you configure a public key.</li>
  <li>Never expose it publicly or point real credentials at it.</li>
  <li>Data lives in memory and a temp stage directory; a restart is a clean slate.</li>
</ul>

<footer>
  Full endpoint and statement list, configuration and troubleshooting live in
  <code>docs/usage.md</code>; the protocol design is in <code>docs/design.md</code>.
</footer>

</body>
</html>
`;
}
