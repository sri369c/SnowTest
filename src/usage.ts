// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * The page served at `/usage`.
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
import { escapeHtml, inlineMarkup, renderPage } from './page.js';

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
  ['`PUT` or `COPY INTO` fails on paths', 'Client and server must see the same absolute path. Share the stage directory.'],
  ['A client in another container cannot connect', 'It resolved `127.0.0.1` to itself. Use `host: snowtest` on `snowtest-network`.'],
  ['The client refuses plain HTTP', 'There is no TLS. Set `protocol: http`, or terminate TLS in a proxy.'],
  ['Data is gone after a restart', 'The engine is in memory. Recreate the fixtures, or keep the process running.'],
  ['`COPY INTO` loads more rows than expected', 'An earlier file is still on the stage. `REMOVE @stage` first, or use a fresh stage root.'],
  ['`execute_async` returns no rows', 'Connector async polling is not implemented. Use the SQL API with `async=true`.'],
  ['Podman: permission denied on the mount', 'Rootless mapping or a missing SELinux label. `./setup.py up` sets both.'],
];

export function renderUsage(version: string): string {
  const troubleshooting = TROUBLESHOOTING.map(
    ([symptom, fix]) => `      <tr><td>${inlineMarkup(symptom)}</td><td>${inlineMarkup(fix)}</td></tr>`,
  ).join('\n');

  const toc = [
    ['configuration', 'Configuration'],
    ['launcher', 'Launcher'],
    ['control-plane', 'Control plane'],
    ['staging', 'Staged files'],
    ['troubleshooting', 'Troubleshooting'],
  ]
    .map(([id, title]) => `        <li><a href="#${id}">${title}</a></li>`)
    .join('\n');

  const body = `<p class="crumb"><a href="/">&larr; Overview</a></p>
<span class="tag">snowtest &middot; emulating Snowflake ${escapeHtml(version)}</span>
<h1>Usage</h1>
<p class="lede">
  How this process is configured and how to get out of trouble with it. The flags
  and defaults below are the ones built into the version you are talking to, so
  this page cannot describe a build older than the one serving it.
</p>

<div class="layout">
  <nav class="toc" aria-label="On this page">
    <div class="muted">On this page</div>
    <ol>
${toc}
    </ol>
  </nav>

  <main class="ops">
<h2 id="configuration">Configuration</h2>
<p class="muted">Flags override environment variables. Defaults are the server's own;
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
</table>

<h2 id="launcher">Launcher</h2>
<p><code>setup.py</code> wraps the container so nobody has to remember the podman
arguments. The same image runs under Docker.</p>
<table>
  <thead>
    <tr><th scope="col">Command</th><th scope="col">What it does</th></tr>
  </thead>
  <tbody>
      <tr><td><code>./setup.py up</code></td><td>Build if needed, start, wait until healthy, load the example tables, print a dbt profile.</td></tr>
      <tr><td><code>./setup.py redeploy</code></td><td>Down, reset staged files, rebuild, up. Use it after a code change.</td></tr>
      <tr><td><code>./setup.py status</code></td><td>Container state and the health endpoint.</td></tr>
      <tr><td><code>./setup.py logs</code></td><td>Server log, for a container that will not start.</td></tr>
      <tr><td><code>./setup.py reset</code></td><td>Drop all data and recreate the catalog.</td></tr>
      <tr><td><code>./setup.py down</code></td><td>Stop and remove the container.</td></tr>
  </tbody>
</table>
<p class="muted">Worth knowing: <code>--port</code>, <code>--public-key</code>,
<code>--users</code>, <code>--env KEY=VALUE</code>, <code>--no-seed-examples</code>,
<code>--recreate</code>, <code>--write-profile DIR</code>. The full list is
<code>./setup.py up --help</code>.</p>

<h2 id="control-plane">Control plane</h2>
<table>
  <thead>
    <tr><th scope="col">Endpoint</th><th scope="col">Purpose</th></tr>
  </thead>
  <tbody>
      <tr><td><code>GET /_snowtest/health</code></td><td>Liveness, plus both versions: the emulated Snowflake release and snowtest's own.</td></tr>
      <tr><td><code>GET /_snowtest/state</code></td><td>Databases, schemas, warehouses, roles, stages and the session count.</td></tr>
      <tr><td><code>POST /_snowtest/seed</code></td><td>Run a SQL script sent as <code>{"sql": "…"}</code>; statements split on <code>;</code>.</td></tr>
      <tr><td><code>POST /_snowtest/reset</code></td><td>Drop everything and recreate the configured catalog.</td></tr>
  </tbody>
</table>
<pre><code>curl -s -X POST 'http://localhost:3030/_snowtest/seed' \\
  -H 'Content-Type: application/json' \\
  -d '{"sql":"create schema if not exists SNOWTEST.FIXTURES; create table SNOWTEST.FIXTURES.T (n int)"}'</code></pre>

<h2 id="staging">Staged files</h2>
<p>
  Stages are backed by a directory on the server, and the client copies the bytes
  itself: the connector is handed a <code>file://</code> path instead of a presigned
  URL. That is what makes <code>PUT</code> and <code>GET</code> work with no object
  storage, and it is also the requirement people trip over — <strong>client and server
  must see the same absolute path</strong>. In a container, mount the stage root on
  both sides; <code>setup.py</code> and <code>compose.yaml</code> already do it.
</p>
<pre><code>PUT file:///srv/data/orders.csv @MY_STAGE
COPY INTO ORDERS FROM @MY_STAGE FILE_FORMAT = (TYPE = CSV SKIP_HEADER = 1)
GET @MY_STAGE/orders.csv file:///srv/data/back/</code></pre>
<p class="muted">Internal stages only: <code>@~</code> and <code>@%table</code> are not
implemented. <code>LIST</code>, <code>REMOVE</code> and <code>COPY INTO</code> treat a
directory-style prefix as the stage root itself.</p>

<h2 id="troubleshooting">Troubleshooting</h2>
<table>
  <thead>
    <tr><th scope="col">Symptom</th><th scope="col">Cause and fix</th></tr>
  </thead>
  <tbody>
${troubleshooting}
  </tbody>
</table>
  </main>
</div>

<footer>
  What the server answers is at <a href="/operations">/operations</a>, including the
  list of things it does not support. Installing it and connecting for the first time
  is in the repository's README.
</footer>`;

  return renderPage({ title: 'snowtest — usage', body, bodyClass: 'wide' });
}
