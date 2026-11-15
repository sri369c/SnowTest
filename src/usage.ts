// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * The pages served at `/configuration` and `/troubleshooting`.
 *
 * It replaces the markdown usage document that used to live in `docs/`, which
 * described a build nobody could identify: the page always belongs to the
 * process answering the request, so the flags, defaults and failure modes it
 * lists are the ones in front of the reader.
 *
 * The configuration tables are rendered from `src/options.ts`, the same table
 * `--help` prints. Anything hand-written here is limited to things a client can
 * observe: the launcher, the control plane, staging, and troubleshooting.
 */

import { ENV_ONLY, OPTIONS } from './options.js';
import { escapeHtml, inlineMarkup, renderPage, renderTabs } from './page.js';

const dash = '<span class="null">—</span>';

function flagTable(): string {
  return OPTIONS.map((option) => {
    const usage = `${escapeHtml(option.flag)}${option.argument ? ` ${escapeHtml(option.argument)}` : ''}`;
    const env = option.env ? `<code>${escapeHtml(option.env)}</code>` : dash;
    const fallback = option.default ? `<code>${escapeHtml(option.default)}</code>` : dash;
    return `      <tr><td><code>${usage}</code></td><td>${env}</td><td>${fallback}</td><td>${escapeHtml(option.description)}</td></tr>`;
  }).join('\n');
}

function envTable(): string {
  return ENV_ONLY.map(
    (entry) =>
      `      <tr><td><code>${escapeHtml(entry.name)}</code></td><td>${escapeHtml(entry.default)}</td><td>${escapeHtml(entry.description)}</td></tr>`,
  ).join('\n');
}

const TROUBLESHOOTING: Array<[string, string]> = [
  ['Container exits straight away', 'Bad flag, or the port is already taken. Check `./setup.py logs`.'],
  ['Health stays unhealthy', 'The published port and `SNOWTEST_PORT` disagree. Publish `-p <host>:$SNOWTEST_PORT`.'],
  ['`390100` … malformed token', 'The private key does not match the configured public key. Regenerate the pair.'],
  ['`390100` … incorrect username or password', 'The login name is not in `SNOWTEST_USERS`. Add it, or unset the variable.'],
  ['`002003` … object does not exist', 'Wrong schema, or an unqualified name resolving elsewhere. Qualify `DB.SCHEMA.TABLE`.'],
  ['`090105` / `090106` … does not have a current database / schema', 'The session’s current database or schema was dropped. `USE DATABASE` / `USE SCHEMA`, or qualify the name.'],
  ['`PUT` or `COPY INTO` fails on paths', 'Client and server must see the same absolute path. Share the stage directory.'],
  ['A client in another container cannot connect', 'It resolved `127.0.0.1` to itself. Use the container name (`host: snowtest`) on the same network.'],
  ['The client refuses plain HTTP', 'There is no TLS. Set `protocol: http`, or terminate TLS in a proxy.'],
  ['Data is gone after a restart', 'The server ran in memory. Set `SNOWTEST_DATA_DIR`; `./setup.py up` does unless `--no-persist`.'],
  ['`COPY INTO` loads more rows than expected', 'An earlier file is still on the stage. `REMOVE @stage` first, or use a fresh stage root.'],
  ['`execute_async` returns no rows', 'Connector async polling is not implemented. Use the SQL API with `async=true`.'],
  ['A time-dependent test flakes', 'Set `SNOWTEST_CLOCK` to a frozen instant or an offset: `current_timestamp`, `current_date`, `current_time`, `sysdate` and `getdate` all follow it.'],
  ['`SNOWTEST_CLOCK` (or another setting) has no effect in the container', 'A shell export does not reach the container. `setup.py` forwards only what it is given: pass `--env SNOWTEST_CLOCK=…` (with `--recreate` for an existing container). Compose forwards `SNOWTEST_CLOCK` itself when it is exported.'],
  ['A script only ran its first statement', 'Fixed in 3.3.0: every `;`-separated statement is routed now. Set `MULTI_STATEMENT_COUNT` when a client needs the count checked.'],
  ['Podman: permission denied on the mount', 'Rootless mapping or a missing SELinux label. `./setup.py up` sets both.'],
  ['Podman Desktop shows no containers', 'It can be looking at a different engine than the shell. `./setup.py status` prints the store and the Windows pipe; a healthy container with a missing pipe means the machine needs `podman machine stop && podman machine start`.'],
];

const pane = (title: string, html: string): string => `<h2 class="panehead">${escapeHtml(title)}</h2>\n${html}`;

const FLAGS = `<p class="muted">Flags override environment variables. Defaults are the server's own;
the container launchers set <code>SNOWTEST_PORT=3030</code>.</p>
<table>
  <thead>
    <tr><th scope="col">Flag</th><th scope="col">Environment</th><th scope="col">Default</th><th scope="col">Purpose</th></tr>
  </thead>
  <tbody>
${flagTable()}
  </tbody>
</table>

<p class="muted">Read at boot; there is no flag for these.</p>
<table>
  <thead>
    <tr><th scope="col">Environment</th><th scope="col">Default</th><th scope="col">Purpose</th></tr>
  </thead>
  <tbody>
${envTable()}
  </tbody>
</table>`;

const LAUNCHER = `<p><code>setup.py</code> wraps the container so nobody has to remember the podman
arguments. The same image runs under Docker.</p>
<table>
  <thead>
    <tr><th scope="col">Command</th><th scope="col">What it does</th></tr>
  </thead>
  <tbody>
      <tr><td><code>./setup.py up</code></td><td>Start the container, creating it only when it is missing, and wait until healthy. A container it creates gets the example tables; an existing one is never built over, seeded or replaced.</td></tr>
      <tr><td><code>./setup.py redeploy</code></td><td>Replace the deployment after a code change: new container, cleared stage files, rebuilt image, example tables seeded. The data volume is kept.</td></tr>
      <tr><td><code>./setup.py status</code></td><td>Engine, store (rootful or rootless), machine, Desktop pipe, container state, published ports and the health endpoint. Exits non-zero when the container answers but a client on the host cannot reach it.</td></tr>
      <tr><td><code>./setup.py logs</code></td><td>Server log, for a container that will not start.</td></tr>
      <tr><td><code>./setup.py reset</code></td><td>Drop all data, persisted files included, and recreate the catalog.</td></tr>
      <tr><td><code>./setup.py down</code></td><td>Stop the container. Nothing is removed: the container, the data volume and the stage directory all stay.</td></tr>
  </tbody>
</table>
<p class="muted">Worth knowing: <code>--name</code> (default <code>snowtest</code>; also names the
<code>&lt;name&gt;-data</code> volume and the <code>.snowtest/&lt;name&gt;/stages</code> directory),
<code>--port</code>, <code>--bind</code> (default <code>127.0.0.1</code>: the control plane is
unauthenticated, so widening it is deliberate), <code>--network</code>, <code>--no-persist</code>,
<code>--public-key</code>,
<code>--users</code>, <code>--env KEY=VALUE</code>. <code>up</code> and <code>down</code> take no
behaviour flags at all: they start and stop what is there, and the only thing
<code>up</code> writes is the example data, once, into a container it just created. Everything that changes the
deployment belongs to <code>redeploy</code> — <code>--recreate</code>, <code>--rebuild</code>,
<code>--no-cache</code>, <code>--keep-stages</code>, <code>--no-seed-examples</code>,
<code>--write-profile DIR</code>. Invalid names and ports are refused.
The full list is <code>./setup.py redeploy --help</code>.</p>`;

const CONTROL_PLANE = `<table>
  <thead>
    <tr><th scope="col">Endpoint</th><th scope="col">Purpose</th></tr>
  </thead>
  <tbody>
      <tr><td><code>GET /_snowtest/health</code></td><td>Liveness, plus both versions: the emulated Snowflake release and snowtest's own.</td></tr>
      <tr><td><code>GET /_snowtest/state</code></td><td>Databases, schemas, warehouses, roles, stages and the session count.</td></tr>
      <tr><td><code>POST /_snowtest/seed</code></td><td>Run a SQL script sent as <code>{"sql": "…"}</code>; statements split on <code>;</code>. Leave <code>sql</code> out of the body to load the bundled example tables instead.</td></tr>
      <tr><td><code>POST /_snowtest/reset</code></td><td>Drop everything, persisted database files included, and recreate the configured catalog.</td></tr>
  </tbody>
</table>
<pre><code>curl -s -X POST 'http://localhost:3030/_snowtest/seed' \\
  -H 'Content-Type: application/json' \\
  -d '{"sql":"create schema if not exists SNOWTEST.FIXTURES; create table SNOWTEST.FIXTURES.T (n int)"}'</code></pre>`;

const STAGING = `<p>
  Stages are backed by a directory on the server, and the client copies the bytes
  itself: the connector is handed a <code>file://</code> path instead of a presigned
  URL. That is what makes <code>PUT</code> and <code>GET</code> work with no object
  storage, and it is also the requirement people trip over — <strong>client and server
  must see the same absolute path</strong>. <code>setup.py</code> bind-mounts a host directory
  at the same path inside the container, so a client on the host works.
  <code>compose.yaml</code> uses the <code>snowtest-stages</code> named volume instead, which only
  a client in another container can reach, by mounting that volume at the same path.
</p>
<pre><code>PUT file:///srv/data/orders.csv @MY_STAGE
COPY INTO ORDERS FROM @MY_STAGE FILE_FORMAT = (TYPE = CSV SKIP_HEADER = 1)
GET @MY_STAGE/orders.csv file:///srv/data/back/</code></pre>
<p class="muted">Internal stages only: <code>@~</code> and <code>@%table</code> are not
implemented. <code>LIST</code>, <code>REMOVE</code> and <code>COPY INTO</code> treat a
directory-style prefix as the stage root itself.</p>`;

/** The page served at `/configuration` (`/usage` redirects here). */
export function renderConfiguration(version: string): string {
  // Panel ids keep the old `/usage#…` anchors working through the redirect.
  const tabs = renderTabs(
    [
      { id: 'configuration', label: 'Flags', html: pane('Flags and environment', FLAGS) },
      { id: 'launcher', label: 'Launcher', html: pane('Launcher', LAUNCHER) },
      { id: 'control-plane', label: 'Control plane', html: pane('Control plane', CONTROL_PLANE) },
      { id: 'staging', label: 'Stages', title: 'Staged files', html: pane('Staged files', STAGING) },
    ],
    { hash: true, variant: 'dense' },
  );

  const body = `<h1>Configuration</h1>
<p class="lede">
  How this process is configured. The flags and defaults below are the ones built
  into the version you are talking to, so this page cannot describe a build older
  than the one serving it.
</p>

<div class="ops">
${tabs}
</div>`;

  return renderPage({ title: 'snowtest — configuration', body, version, nav: 'configuration' });
}

/** The page served at `/troubleshooting`. */
export function renderTroubleshooting(version: string): string {
  const rows = TROUBLESHOOTING.map(
    ([symptom, fix], index) =>
      `      <tr><td class="rn">${index + 1}</td><td>${inlineMarkup(symptom)}</td><td>${inlineMarkup(fix)}</td></tr>`,
  ).join('\n');

  const body = `<h1>Troubleshooting</h1>
<p class="lede">Symptoms you are likely to hit, what causes them, and the fix.</p>

<div class="ops">
<table>
  <thead>
    <tr><th scope="col" class="rn">#</th><th scope="col">Symptom</th><th scope="col">Cause and fix</th></tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>
</div>`;

  return renderPage({ title: 'snowtest — troubleshooting', body, version, nav: 'troubleshooting' });
}