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

/** A statement the server timed, as the landing page lists it. */
export interface HomeQueryState {
  queryText: string;
  startedAt: Date;
  elapsedMs: number;
  rowsProduced: number;
  status: string;
  user: string;
}

export interface HomeState {
  databases: HomeDatabaseState[];
  warehouses: string[];
  roles: string[];
  stages: number;
  sessions: HomeSessionState[];
  queries: HomeQueryState[];
  /** Statements in the timings table, not just the ones the page lists. */
  queryCount: number;
  /** What a clear just did, carried across the reload that follows it. */
  notice?: { kind: 'timings' | 'reset'; text: string } | null;
}

/** Home's tabs; the catalog browser repeats them as links, with Live state current. */
export const HOME_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'live', label: 'Live state' },
  { id: 'connect', label: 'Connect' },
  { id: 'speaks', label: 'What it speaks' },
  { id: 'control', label: 'Control plane' },
  { id: 'timings', label: 'Query timings' },
  { id: 'clear', label: 'Clear Data' },
] as const;

const REFRESH_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 1 1 .908-.418A6 6 0 1 1 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966a.25.25 0 0 1 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/></svg>';

// One script for every refresh button on the page: `data-refresh` names the region
// to swap, and the stamp beside the button shows when it last ran. A failure is
// shown, never left looking current.
const REFRESH_SCRIPT = `<script>
(() => {
  for (const button of document.querySelectorAll('[data-refresh]')) {
    const body = button.dataset.refresh;
    const at = button.parentElement.querySelector('[data-stamp]');
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
        const fresh = doc.getElementById(body);
        if (!fresh) throw new Error(body + ' missing from response');
        document.getElementById(body).replaceWith(fresh);
        stamp();
      } catch (error) {
        button.classList.add('err');
        at.textContent = 'refresh failed: ' + error.message;
      } finally {
        button.classList.remove('busy');
        button.disabled = false;
      }
    });
  }
})();
</script>`;

// The Clear Data tab is static, so its listeners can hold their elements.
const CLEAR_SCRIPT = `<script>
(() => {
  const WORD = 'Delete All Data';
  const timingsDialog = document.getElementById('clear-timings-dialog');
  const allDialog = document.getElementById('clear-all-dialog');
  const word = document.getElementById('clear-word');
  const go = document.getElementById('clear-go');
  const error = document.getElementById('clear-error');
  const fail = (what, problem) => {
    error.hidden = false;
    error.textContent = what + ' failed: ' + problem.message;
  };

  document.getElementById('clear-timings-open').addEventListener('click', () => {
    error.hidden = true;
    timingsDialog.showModal();
  });
  document.getElementById('clear-all-open').addEventListener('click', () => {
    error.hidden = true;
    word.value = '';
    go.disabled = true;
    allDialog.showModal();
    word.focus();
  });
  for (const button of document.querySelectorAll('.modal [data-close]')) {
    button.addEventListener('click', () => button.closest('dialog').close());
  }
  // A confirmation is for the click that caused it, not for every refresh after.
  // The flag lives in the URL so it survives the redirect, and is dropped as soon
  // as the page renders: the banner stays on screen, a reload no longer shows it.
  if (new URLSearchParams(location.search).has('cleared')) {
    history.replaceState(null, '', location.pathname + location.hash);
  }

  // A method=dialog form closes on submit, and Enter in the text field is an
  // implicit submit: without this, Enter dismissed the dialog and did nothing.
  // Neither dialog does anything on Enter; both act only on their own button.
  for (const form of document.querySelectorAll('.modal form')) {
    form.addEventListener('submit', (event) => event.preventDefault());
  }

  document.getElementById('clear-timings-yes').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      const response = await fetch('/_snowtest/queries/clear', { method: 'POST' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      location.replace('/?cleared=timings#clear');
    } catch (problem) {
      event.target.disabled = false;
      timingsDialog.close();
      fail('Clear', problem);
    }
  });
  word.addEventListener('input', () => {
    go.disabled = word.value !== WORD;
  });
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const response = await fetch('/_snowtest/reset', { method: 'POST' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      location.replace('/?cleared=reset#clear');
    } catch (problem) {
      go.disabled = false;
      allDialog.close();
      fail('Reset', problem);
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

/** A single statement is usually under a second, so this counts in milliseconds. */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

/** One-line statement text for a table cell; the full text is the cell's title. */
function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
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
  const queryRows =
    state.queries
      .map(
        (query) =>
          `    <tr><td>${escapeHtml(formatServerTime(query.startedAt))}</td><td><code>${escapeHtml(query.user)}</code></td><td class="sql" title="${escapeHtml(query.queryText)}">${escapeHtml(shorten(query.queryText, 90))}</td><td class="num">${escapeHtml(formatElapsed(query.elapsedMs))}</td><td class="num">${query.rowsProduced}</td><td>${escapeHtml(query.status)}</td></tr>`,
      )
      .join('\n') || '    <tr><td colspan="6">No statements recorded yet.</td></tr>';
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
  const live = `<div class="livebar"><span class="muted" data-stamp aria-live="polite"></span><button type="button" class="refresh" data-refresh="live-body" title="Refresh live state">${REFRESH_ICON}Refresh</button></div>
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

  // Each confirmation belongs to the block that caused it, under its heading.
  const noticeFor = (kind: 'timings' | 'reset'): string =>
    state.notice && state.notice.kind === kind
      ? `\n    <p class="ok" role="status">${escapeHtml(state.notice.text)}</p>`
      : '';
  const clearPane = `<p class="lede">
  Two things can be cleared, and neither happens on its own.
</p>

<div class="action">
  <div>
    <h3>Query timings</h3>${noticeFor('timings')}
    <p class="muted">
      ${state.queryCount} statement(s) in <code>SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY</code>.
    </p>
  </div>
  <div class="action-controls">
    <button type="button" class="refresh" id="clear-timings-open" aria-haspopup="dialog">Clear timings</button>
  </div>
</div>

<div class="action">
  <div>
    <h3>Everything</h3>${noticeFor('reset')}
    <p class="muted">
      Drops every database and its files, every stage, session and statement handle,
      and the timings table, then rebuilds the configured catalog. There is no undo.
    </p>
  </div>
  <div class="action-controls">
    <button type="button" class="refresh danger" id="clear-all-open" aria-haspopup="dialog">Delete all data</button>
  </div>
</div>

<p class="muted">
  A direct <code>POST /_snowtest/reset</code> still resets without the confirmation, as it always has.
</p>
<p class="warn" id="clear-error" hidden></p>

<dialog class="modal" id="clear-timings-dialog" aria-labelledby="clear-timings-title">
  <form method="dialog">
    <h3 id="clear-timings-title">Clear the query timings?</h3>
    <p class="muted">
      Empties <code>SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY</code> — ${state.queryCount} statement(s).
      Databases, stages and sessions stay exactly as they are.
    </p>
    <div class="modal-actions">
      <button type="button" class="refresh" data-close>Cancel</button>
      <button type="button" class="refresh danger" id="clear-timings-yes">Clear timings</button>
    </div>
  </form>
</dialog>

<dialog class="modal" id="clear-all-dialog" aria-labelledby="clear-all-title">
  <form method="dialog">
    <h3 id="clear-all-title">Delete all data?</h3>
    <p class="muted">
      Every database and its files, every stage, session and statement handle, and the
      timings table. The configured catalog is rebuilt. There is no undo.
    </p>
    <label for="clear-word">Type <code>Delete All Data</code> to confirm</label>
    <input type="text" id="clear-word" autocomplete="off" spellcheck="false" autocapitalize="off">
    <div class="modal-actions">
      <button type="button" class="refresh" data-close>Cancel</button>
      <button type="button" class="refresh danger" id="clear-go" disabled>Delete all data</button>
    </div>
  </form>
</dialog>`;

  // The count is the whole table; the list underneath is only its latest page, so
  // say both numbers whenever they differ.
  const timingsCount =
    state.queries.length < state.queryCount
      ? `${state.queryCount} statement(s) in <code>SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY</code>, the latest ${state.queries.length} below.`
      : `${state.queryCount} statement(s) in <code>SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY</code>, all of them below.`;

  // `timings-body` is swapped in place by this tab's own refresh button.
  const timings = `<div class="livebar"><span class="muted" data-stamp aria-live="polite"></span><button type="button" class="refresh" data-refresh="timings-body" title="Refresh the query timings">${REFRESH_ICON}Refresh</button></div>
<div id="timings-body">
<p class="muted">
  ${timingsCount}
  Every statement the server runs is timed into that table, newest first, the way
  Snowflake keeps it. It is a real table — query it from a client for anything
  older than this preview.
</p>
<table>
  <tr><th>Started (server time)</th><th>User</th><th>Statement</th><th>Took</th><th>Rows</th><th>Status</th></tr>
${queryRows}
</table>
</div>`;

  // Only the read-only endpoints are links. A link is a GET, and the rest of this
  // table drops or changes things, so those stay plain labels you cannot click by
  // accident.
  const endpointRow = (title: string, what: string, path?: string): string => {
    const label = `<code>${title}</code>`;
    const cell = path
      ? `<a class="endpoint" href="${path}" target="_blank" rel="noreferrer">${label}</a>`
      : label;
    return `  <tr><th>${cell}</th><td>${what}</td></tr>`;
  };

  const control = `<table>
${endpointRow('GET /_snowtest/health', 'liveness probe', '/_snowtest/health')}
${endpointRow('GET /_snowtest/state', 'databases, schemas, warehouses, roles, stages, sessions', '/_snowtest/state')}
${endpointRow('POST /_snowtest/seed', 'run a SQL script: <code>{"sql": "..."}</code>')}
${endpointRow('POST /_snowtest/reset', 'drop everything, persisted files included, and recreate the configured catalog')}
${endpointRow('POST /_snowtest/queries/clear', 'empty the query timings table')}
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
    html: { overview, live, connect, speaks, control, timings, clear: clearPane }[tab.id],
  })),
  { hash: true },
)}
${REFRESH_SCRIPT}
${CLEAR_SCRIPT}`;

  return renderPage({ title: 'snowtest — Snowflake-compatible stub server', body, version, nav: 'home' });
}
