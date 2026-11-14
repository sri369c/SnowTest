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
import { escapeHtml, renderPage, renderTabs } from './page.js';

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
  database: string | null;
  schema: string | null;
  role: string;
  createdAt: Date;
}

export interface HomeState {
  databases: HomeDatabaseState[];
  warehouses: string[];
  roles: string[];
  stages: number;
  sessions: HomeSessionState[];
}

/** Home's tabs; the catalog browser repeats them as links, with Live state current. */
export const HOME_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'live', label: 'Live state' },
  { id: 'connect', label: 'Connect' },
  { id: 'speaks', label: 'What it speaks' },
  { id: 'control', label: 'Control plane' },
] as const;

const REFRESH_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 1 1 .908-.418A6 6 0 1 1 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966a.25.25 0 0 1 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/></svg>';

// Re-fetches `/` and swaps in its #live-body; a failure is shown, never left looking current.
const LIVE_SCRIPT = `<script>
(() => {
  const button = document.getElementById('live-refresh');
  const at = document.getElementById('live-at');
  const stamp = () => { at.textContent = 'updated ' + new Date().toLocaleTimeString(); };
  stamp();
  button.addEventListener('click', async () => {
    button.classList.add('busy');
    button.classList.remove('err');
    button.disabled = true;
    try {
      const response = await fetch('/', { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      const fresh = doc.getElementById('live-body');
      if (!fresh) throw new Error('live section missing from response');
      document.getElementById('live-body').replaceWith(fresh);
      stamp();
    } catch (error) {
      button.classList.add('err');
      at.textContent = 'refresh failed: ' + error.message;
    } finally {
      button.classList.remove('busy');
      button.disabled = false;
    }
  });
})();
</script>`;

const pad = (n: number): string => String(n).padStart(2, '0');

/** Server-local `YYYY-MM-DD HH:MM:SS TZ`; `server time` if no zone name. */
export function formatServerTime(date: Date): string {
  const zone =
    new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')?.value || 'server time';
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${day} ${time} ${zone}`;
}

/** Compact elapsed time, e.g. `2d 3h 04m`, `1h 02m 05s`, `12m 30s`, `5s`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${hours}h ${pad(minutes)}m`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
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
  const storageLine = config.dataDir
    ? `DuckDB files under <code>${escapeHtml(config.dataDir)}</code> — data survives a restart`
    : 'in memory — a restart is a clean slate';

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
  const now = Date.now();
  const sessionRows =
    state.sessions
      .map(
        (session) =>
          `    <tr><td><code>${escapeHtml(session.user)}</code></td><td><code>${escapeHtml(session.database ?? 'NULL')}.${escapeHtml(session.schema ?? 'NULL')}</code></td><td>${escapeHtml(session.role)}</td><td>${escapeHtml(formatServerTime(session.createdAt))}</td><td>${formatDuration(now - session.createdAt.getTime())}</td></tr>`,
      )
      .join('\n') || '    <tr><td colspan="5">No active sessions.</td></tr>';
  const surfaceRows = LANDING_SURFACES.map(
    (surface) =>
      `  <tr><th scope="row"><a href="/operations#${escapeHtml(surface.id)}">${escapeHtml(surface.label)}</a></th><td>${escapeHtml(surface.summary)} <span class="muted">(${surface.supported} of ${surface.total} supported)</span></td></tr>`,
  ).join('\n');

  const overview = `<div class="card">
  <table>
    <tr><th>Endpoint</th><td><code>${endpoint}</code></td></tr>
    <tr><th>Account</th><td><code>${account}</code></td></tr>
    <tr><th>Default context</th><td><code>${database}.${schema}</code> &middot; warehouse <code>${warehouse}</code></td></tr>
    <tr><th>Auth</th><td>${authLine}${usersLine}</td></tr>
    <tr><th>Storage</th><td>${storageLine}</td></tr>
  </table>
</div>

<h3>What it is not</h3>
<p class="warn">
  A test double, not a replacement. No TLS, no users, roles or privileges, no ODBC,
  no warehouse sizing or cost behaviour, one result partition, JSON only. Staged
  transfers use a local directory instead of cloud object storage.
</p>
<ul>
  <li>Nothing here authenticates or authorises unless you configure a public key.</li>
  <li>Never expose it publicly or point real credentials at it.</li>
  <li>Data lives in memory unless <code>SNOWTEST_DATA_DIR</code> is set (<code>setup.py</code> and <code>compose.yaml</code> set it).</li>
</ul>`;

  // `live-body` is swapped in place by the refresh button; keep the id on the server-rendered copy.
  const live = `<div class="livebar"><span class="muted" id="live-at" aria-live="polite"></span><button type="button" class="refresh" id="live-refresh" title="Refresh live state">${REFRESH_ICON}Refresh</button></div>
<div id="live-body">
<p class="muted">
  ${state.databases.length} database(s) &middot; ${objectCount} table/view(s) &middot;
  ${state.warehouses.length} warehouse(s) &middot; ${state.roles.length} role(s) &middot;
  ${state.stages} stage(s) &middot; ${state.sessions.length} session(s).
</p>
<table>
  <tr><th>Database</th><th>Schema</th><th>Tables</th><th>Views</th></tr>
${databaseRows}
</table>
<p class="muted">Select a schema to list its tables and preview the first rows of any of them.</p>

<h3>Active sessions</h3>
<table>
  <tr><th>User</th><th>Context</th><th>Role</th><th>Started (server time)</th><th>Length</th></tr>
${sessionRows}
</table>
</div>`;

  const python = `<pre><code>import snowflake.connector

conn = snowflake.connector.connect(
    account="${account}", user="test", password="test",
    host="localhost", port=${port}, protocol="http",
    database="${database}", schema="${schema}", warehouse="${warehouse}",
)
cur = conn.cursor()
cur.execute("SELECT CURRENT_DATABASE(), CURRENT_SCHEMA()")
print(cur.fetchall())</code></pre>`;

  const dbt = `<p>Key-pair auth is the normal way a service account reaches Snowflake, so it is the
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
(<code>SNOWTEST_JWT_PUBLIC_KEY</code>); otherwise any credential is accepted.</p>`;

  const curl = `<pre><code>curl -s -X POST '${endpoint}/api/v2/statements' \\
  -H 'Authorization: Bearer test' \\
  -H 'Content-Type: application/json' \\
  -d '{"statement":"SELECT 1 AS n"}'</code></pre>`;

  const speaks = `<table>
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
</p>`;

  const control = `<table>
  <tr><th><code>GET /_snowtest/health</code></th><td>liveness probe</td></tr>
  <tr><th><code>GET /_snowtest/state</code></th><td>databases, schemas, warehouses, roles, stages, sessions</td></tr>
  <tr><th><code>POST /_snowtest/seed</code></th><td>run a SQL script: <code>{"sql": "..."}</code></td></tr>
  <tr><th><code>POST /_snowtest/reset</code></th><td>drop everything, persisted files included, and recreate the configured catalog</td></tr>
</table>`;

  const connect = renderTabs(
    [
      { id: 'connect-python', label: 'Python', html: python },
      { id: 'connect-dbt', label: 'dbt', html: dbt },
      { id: 'connect-curl', label: 'curl', html: curl },
    ],
    { variant: 'sub' },
  );

  const body = `<h1>A Snowflake-compatible stub server</h1>
<p class="lede">
  Point a Snowflake client's host and port here and it answers the way Snowflake does —
  no account, no warehouse cost, no network. Use it for integration tests, local
  development and CI.
</p>

${renderTabs(
  HOME_TABS.map((tab) => ({
    ...tab,
    html: { overview, live, connect, speaks, control }[tab.id],
  })),
  { hash: true },
)}
${LIVE_SCRIPT}`;

  return renderPage({ title: 'snowtest — Snowflake-compatible stub server', body, version, nav: 'home' });
}
