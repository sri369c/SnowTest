// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * The page served at `/`.
 *
 * A stub that only answers protocol endpoints is hard to approach: you have to
 * read the README before you know what to point at it. This page is the
 * five-second version — what the process is, the values to connect with, and
 * the limits worth knowing before trusting it.
 *
 * The "what it speaks" summary is derived from the operations table rather than
 * written here, so the overview cannot advertise more than the reference lists.
 */

import type { SnowtestConfig } from './config.js';
import { LANDING_SURFACES } from './operations.js';
import { escapeHtml, renderPage } from './page.js';
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
            `    <tr><td><code>${escapeHtml(db.name)}</code></td><td><a href="/browse/${encodeURIComponent(db.name)}/${encodeURIComponent(schema.name)}"><code>${escapeHtml(schema.name)}</code></a></td><td>${schema.tables}</td><td>${schema.views}</td></tr>`,
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
  const surfaceRows = LANDING_SURFACES.map(
    (surface) =>
      `  <tr><th scope="row"><a href="/operations#${escapeHtml(surface.id)}">${escapeHtml(surface.label)}</a></th><td>${escapeHtml(surface.summary)} <span class="muted">(${surface.supported} of ${surface.total} supported)</span></td></tr>`,
  ).join('\n');

  const body = `<span class="tag">snowtest ${escapeHtml(PACKAGE_VERSION)} &middot; emulating Snowflake ${escapeHtml(version)}</span>
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
<p class="muted">Select a schema to list its tables and preview the first rows of any of them.</p>

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
  <thead>
    <tr><th scope="col">Surface</th><th scope="col">Notes</th></tr>
  </thead>
  <tbody>
${surfaceRows}
  </tbody>
</table>
<p>
  <a href="/operations"><strong>Supported operations</strong></a> &mdash;
  <span class="muted">every endpoint, statement and function, with what each one does and where it stops.</span>
</p>

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
  <a href="/operations">Supported operations</a> &middot;
  <a href="/usage">Usage and configuration</a>.
  Both describe the build serving this page.
</footer>`;

  return renderPage({ title: 'snowtest — Snowflake-compatible stub server', body });
}
