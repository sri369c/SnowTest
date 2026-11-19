// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * The self test behind `/self-test`.
 *
 * Every check goes through the same HTTP surface a client uses, so a pass means
 * the instance answering the request works, not that the source tree compiles.
 * Anything that needs somewhere to write goes into its own database, which the
 * last check drops again. The fidelity check is the one exception: a dbt comment
 * is the only thing that names a model, so it leaves two rows in
 * SNOWFLAKE.ACCOUNT_USAGE.MODEL_FIDELITY under `model.snowtest_selfcheck.*`.
 *
 * A check is a group of assertions, and each group reports how many of its own
 * assertions passed, so `4/4` says more than a bare pass. A group stops at its
 * first failed assertion and keeps the count it reached.
 *
 * The checks are ordered, and the later ones use the session the login check
 * creates. A failure is reported where it happened and the rest still run.
 */

import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { renderPage } from '../pages/page.js';

export interface SelfCheckResult {
  name: string;
  /** True when every assertion in the group passed. */
  ok: boolean;
  passed: number;
  total: number;
  detail: string;
  ms: number;
}

export interface SelfReport {
  /** True when no check failed. */
  ok: boolean;
  checks: SelfCheckResult[];
  /** Assertions that passed, across every check. */
  passed: number;
  /** Assertions the run attempted to reach, across every check. */
  total: number;
  failedChecks: number;
  durationMs: number;
  at: string;
}

type Request = (path: string, init?: RequestInit) => Promise<Response>;
type Assert = (label: string, condition: boolean) => void;

const DATABASE = 'SNOWTEST_SELFCHECK';
const REQUEST_TIMEOUT_MS = 10_000;
const STAGE = `${DATABASE}.PROBE.S`;
const TABLE = `${DATABASE}.PROBE.T`;

interface Envelope {
  success: boolean;
  data: Record<string, any> | null;
  message?: string | null;
  code?: string;
}

interface StatementResult {
  success: boolean;
  code?: string;
  message?: string | null;
  rows: string[][];
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One driver-protocol statement, with the rows the transport actually carries. */
async function run(request: Request, token: string, sql: string): Promise<StatementResult> {
  const response = await request('/queries/v1/query-request', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sqlText: sql }),
  });
  const body = (await response.json()) as Envelope;
  return {
    success: body.success,
    code: body.code,
    message: body.message,
    rows: (body.data?.rowset ?? []) as string[][],
  };
}

async function must(request: Request, token: string, sql: string): Promise<string[][]> {
  const result = await run(request, token, sql);
  if (!result.success) throw new Error(`${result.code ?? 'error'}: ${(result.message ?? '').split('\n')[0]}`);
  return result.rows;
}

export async function runSelfChecks(inner: Request): Promise<SelfReport> {
  const started = Date.now();
  const checks: SelfCheckResult[] = [];
  let token = '';

  // A probe that never settles would hold the run's latch forever, so every
  // request carries its own deadline. Ten seconds is far longer than any check
  // takes and far shorter than an operator's patience.
  const request: Request = (path, init = {}) =>
    inner(path, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  const check = async (name: string, total: number, body: (ok: Assert) => Promise<string>): Promise<void> => {
    const at = Date.now();
    let passed = 0;
    const ok: Assert = (label, condition) => {
      if (!condition) throw new Error(label);
      passed += 1;
    };
    try {
      const detail = await body(ok);
      checks.push({ name, ok: passed === total, passed, total, detail, ms: Date.now() - at });
    } catch (error) {
      checks.push({ name, ok: false, passed, total, detail: reason(error), ms: Date.now() - at });
    }
  };

  await check('health', 3, async (ok) => {
    const response = await request('/_snowtest/health');
    const body = (await response.json()) as {
      status?: string;
      snowtestVersion?: string;
      emulatedSnowflakeVersion?: string;
    };
    ok(`GET /_snowtest/health answered ${response.status}`, response.status === 200);
    ok(`status is ${body.status ?? 'missing'}`, body.status === 'ok');
    ok('both versions are reported', Boolean(body.snowtestVersion && body.emulatedSnowflakeVersion));
    return `${body.snowtestVersion} serving ${body.emulatedSnowflakeVersion}`;
  });

  // Every page the nav links to, this one included: a tab that 500s is the kind
  // of thing you only find out about from the tab you did not click.
  await check('pages', 8, async (ok) => {
    const paths = ['/', '/operations', '/configuration', '/troubleshooting', '/self-test', '/settings'];
    for (const path of paths) {
      const response = await request(path);
      const html = await response.text();
      ok(`${path} answered ${response.status} without a heading`, response.status === 200 && html.includes('<h1'));
    }
    // One page is only reachable by clicking a database, and one address is the
    // old name for a page that still has to answer for bookmarks. The database's
    // name is configuration, not a constant, so ask the catalog what this instance
    // has rather than assuming the default SNOWTEST.PUBLIC exists.
    const state = (await (await request('/_snowtest/state')).json()) as {
      databases?: Array<{ name?: string; schemas?: string[] }>;
    };
    // The first database need not have a schema: CREATE DATABASE leaves one empty,
    // and an empty one can sort first. Take the first database that has a schema.
    const browsable = (state.databases ?? []).find((entry) => entry.name && entry.schemas?.length);
    const database = browsable?.name ?? '';
    const schema = browsable?.schemas?.[0] ?? '';
    const browsed = await request(`/browse/${encodeURIComponent(database)}/${encodeURIComponent(schema)}`);
    const browsedHtml = await browsed.text();
    ok(
      `/browse/${database}/${schema} answered ${browsed.status} without a heading`,
      Boolean(database) && Boolean(schema) && browsed.status === 200 && browsedHtml.includes('<h1'),
    );

    const alias = await request('/usage');
    const location = alias.headers.get('location');
    ok(
      `/usage answered ${alias.status} to ${location ?? 'nowhere'}`,
      alias.status === 301 && location === '/configuration',
    );

    return `${paths.length + 2} pages served`;
  });

  await check('login', 3, async (ok) => {
    const response = await request('/session/v1/login-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { LOGIN_NAME: 'SELF_TEST' } }),
    });
    const body = (await response.json()) as Envelope;
    ok(`login was refused: ${body.message ?? 'no message'}`, body.success);
    token = String(body.data?.token ?? '');
    ok('login returned no token', token !== '');
    ok('login returned no session id', typeof body.data?.sessionId === 'number');
    return `session ${body.data?.sessionId} as SELF_TEST`;
  });

  const session = (label: string): string => {
    if (!token) throw new Error(`${label}: no session`);
    return token;
  };

  await check('query', 3, async (ok) => {
    const result = await run(request, session('query'), 'select 1 as one');
    ok(`select 1 failed: ${result.code ?? 'no code'}`, result.success);
    ok(`select 1 returned ${result.rows.length} rows`, result.rows.length === 1);
    ok(`select 1 returned ${JSON.stringify(result.rows[0])}`, result.rows[0]?.[0] === '1');
    return 'select 1 returned 1';
  });

  await check('dialect', 3, async (ok) => {
    const rows = await must(
      request,
      session('dialect'),
      "select iff(1 = 1, 'yes', 'no') as a, nvl(null, 'x') as b, decode(null, null, 'n', 'o') as c",
    );
    const row = rows[0] ?? [];
    ok(`IFF returned ${row[0]}`, row[0] === 'yes');
    ok(`NVL returned ${row[1]}`, row[1] === 'x');
    ok(`DECODE returned ${row[2]}`, row[2] === 'n');
    return 'IFF, NVL and DECODE translated';
  });

  await check('write round-trip', 4, async (ok) => {
    const token = session('write round-trip');
    // A run that died halfway leaves the database behind, and CREATE DATABASE on
    // an existing one succeeds, so clear the ground before claiming anything.
    await must(request, token, `drop database if exists ${DATABASE}`);
    await must(request, token, `create database ${DATABASE}`);
    await must(request, token, `create schema ${DATABASE}.PROBE`);
    await must(request, token, `create table ${TABLE} (id number, name varchar)`);

    const state = JSON.stringify(await (await request('/_snowtest/state')).json());
    ok('the scratch database is not in the catalog', state.includes(DATABASE));

    const tables = await must(request, token, `show tables in ${DATABASE}.PROBE`);
    ok(`SHOW TABLES returned ${JSON.stringify(tables)}`, tables.some((row) => row.includes('T')));

    await must(request, token, `insert into ${TABLE} values (1, 'one'), (2, 'two')`);
    const count = await must(request, token, `select count(*) as n from ${TABLE}`);
    ok(`count returned ${JSON.stringify(count[0])}`, count[0]?.[0] === '2');

    const rows = await must(request, token, `select id, name from ${TABLE} order by id`);
    ok(
      `read back ${JSON.stringify(rows)}`,
      rows.length === 2 && rows[0]?.[0] === '1' && rows[1]?.[1] === 'two',
    );
    return 'created, inserted and read back 2 rows';
  });

  await check('metadata', 2, async (ok) => {
    const described = await must(request, session('metadata'), `describe table ${TABLE}`);
    ok(`DESCRIBE TABLE returned ${described.length} rows`, described.length === 2);
    ok(`first column is ${described[0]?.[0]}`, described[0]?.[0] === 'ID');
    return `DESCRIBE TABLE returned ${described.length} columns`;
  });

  await check('staging', 4, async (ok) => {
    const token = session('staging');
    const directory = await mkdtemp(join(tmpdir(), 'snowtest-selfcheck-'));
    const file = join(directory, 'probe.csv');
    try {
      await writeFile(file, 'id,name\n1,one\n');
      await must(request, token, `create stage ${STAGE}`);

      // PUT hands the client a local-filesystem stage and lets it copy the bytes
      // in, which is how every driver does it. Play that half here: the descriptor
      // is the server's part of the contract.
      const transfer = await request('/queries/v1/query-request', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sqlText: `put file://${file} @${STAGE}/data/ auto_compress=false` }),
      });
      // The descriptor is spread into `data`, not nested under a key of its own.
      const descriptor = (await transfer.json()) as Envelope;
      const stageInfo = descriptor.data?.stageInfo as { location?: string; path?: string } | undefined;
      ok('PUT returned no stage descriptor', Boolean(stageInfo?.location));
      const target = join(stageInfo!.location!, stageInfo?.path ?? '', basename(file));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(file, target);

      const listed = await must(request, token, `list @${STAGE}`);
      ok(`LIST showed ${listed.length} files`, listed.length === 1);
      const removed = await must(request, token, `remove @${STAGE}`);
      ok(`REMOVE reported ${removed.length} files`, removed.length >= 1);
      const empty = await must(request, token, `list @${STAGE}`);
      ok(`REMOVE left ${empty.length} files behind`, empty.length === 0);
      return 'PUT descriptor, LIST and REMOVE round-tripped one file';
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await check('SQL API v2', 6, async (ok) => {
    const headers = { Authorization: `Bearer ${session('SQL API v2')}`, 'Content-Type': 'application/json' };
    const submitted = await request('/api/v2/statements', {
      method: 'POST',
      headers,
      body: JSON.stringify({ statement: 'select 1 as n' }),
    });
    const body = (await submitted.json()) as { statementHandle?: string };
    ok(`submit answered ${submitted.status}`, submitted.status === 200);
    const handle = body.statementHandle;
    ok('submit returned no statement handle', Boolean(handle));

    // The async branch: the first poll says the statement is still running, the one
    // after it hands over the result. A second 202 would hang a polling client, so
    // the second poll has to carry the row, not merely answer.
    const waiting = await request(`/api/v2/statements/${handle}?async=true`, { headers });
    const waitingBody = (await waiting.json()) as { message?: string };
    ok(
      `the first async poll answered ${waiting.status}: ${waitingBody.message ?? 'no message'}`,
      waiting.status === 202 && (waitingBody.message ?? '').includes('still running'),
    );
    const consumed = await request(`/api/v2/statements/${handle}?async=true`, { headers });
    const result = (await consumed.json()) as { data?: unknown[][] };
    ok(
      `the second async poll answered ${consumed.status} with ${JSON.stringify(result.data)}`,
      consumed.status === 200 && result.data?.[0]?.[0] === '1',
    );

    const cancelled = await request(`/api/v2/statements/${handle}/cancel`, { method: 'POST', headers });
    const cancelledBody = (await cancelled.json()) as { code?: string };
    ok(
      `cancel answered ${cancelled.status} with ${cancelledBody.code ?? 'no code'}`,
      cancelled.status === 200 && cancelledBody.code === '000604',
    );

    const gone = await request(`/api/v2/statements/${handle}`, { headers });
    ok(`cancelled handle still answers ${gone.status}`, gone.status === 404);
    return 'submitted, polled and cancelled one statement';
  });

  // Fidelity is the feature the other checks cannot see: they run untagged
  // statements, which by design carry no verdict. A dbt comment is what names a
  // model, so this check sends two tagged statements and reads the ledger back.
  await check('fidelity', 10, async (ok) => {
    interface LedgerModel {
      nodeId: string;
      constructs: string[];
      verdict: string;
    }

    const headers = {
      Authorization: `Bearer ${session('fidelity')}`,
      'Content-Type': 'application/json',
    };

    // Reading is separate from asserting: a request that only feeds a later claim
    // is not counted twice.
    const modelReport = async (): Promise<{ status: number; mode: string; models: LedgerModel[] }> => {
      const response = await request('/_snowtest/models');
      const body = (await response.json()) as { fidelity?: string; models?: LedgerModel[] };
      return { status: response.status, mode: body.fidelity ?? '', models: body.models ?? [] };
    };

    const submit = async (
      nodeId: string,
      sql: string,
    ): Promise<{ status: number; code: string; message: string }> => {
      const response = await request('/api/v2/statements', {
        method: 'POST',
        headers,
        body: JSON.stringify({ statement: `/* {"app": "dbt", "node_id": "${nodeId}"} */\n${sql}` }),
      });
      const body = (await response.json()) as { code?: string; message?: string };
      return { status: response.status, code: body.code ?? '', message: body.message ?? '' };
    };

    const writeMode = async (value: string): Promise<{ status: number; applied?: string; error?: string }> => {
      const response = await request('/_snowtest/fidelity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      const body = (await response.json()) as { applied?: string; error?: string };
      return { status: response.status, applied: body.applied, error: body.error };
    };

    // One read, one assertion: the endpoint answered and its body names the mode in
    // force. `models` is defaulted to [] when the body omits it, so asserting that
    // the list is an array would be true by construction.
    const opened = await modelReport();
    ok(
      `GET /_snowtest/models answered ${opened.status} with mode ${opened.mode || 'missing'}`,
      opened.status === 200 && opened.mode !== '',
    );

    const approximateId = 'model.snowtest_selfcheck.approximate';
    const verifiedId = 'model.snowtest_selfcheck.verified';
    const approximateStatus = await submit(
      approximateId,
      "SELECT CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP) AS TS",
    );
    ok(`the approximate statement answered ${approximateStatus.status}`, approximateStatus.status === 200);
    const verifiedStatus = await submit(verifiedId, 'SELECT 1 AS N');
    ok(`the verified statement answered ${verifiedStatus.status}`, verifiedStatus.status === 200);

    // No second status assertion: this is the same endpoint as the read above, and
    // a failed read leaves both verdicts below naming a missing model themselves.
    const landed = await modelReport();
    const approximate = landed.models.find((model) => model.nodeId === approximateId);
    ok(
      `${approximateId} came back ${approximate?.verdict ?? 'missing'} with ${JSON.stringify(approximate?.constructs ?? [])}`,
      approximate?.verdict === 'approximate' && approximate.constructs.includes('CONVERT_TIMEZONE'),
    );
    const verified = landed.models.find((model) => model.nodeId === verifiedId);
    ok(`${verifiedId} came back ${verified?.verdict ?? 'missing'}`, verified?.verdict === 'verified');

    // A mode is a setting, not a per-statement hint, so the check leaves it at
    // report. strict goes on unconditionally and report comes back in the finally
    // even when an assertion above threw, or a failed run would leave the instance
    // refusing the caller's SQL.
    const target = 'strict';
    try {
      const applied = await writeMode(target);
      ok(
        `applying ${target} answered ${applied.status}: ${applied.error ?? applied.applied ?? ''}`,
        applied.status === 200 && applied.applied === target,
      );
      const rejected = await writeMode('sideways');
      ok(`an unknown mode answered ${rejected.status}`, rejected.status === 400);

      // Applying a mode is not the same as the mode acting: strict has to refuse
      // the approximate statement before it runs, and name the construct.
      const refused = await submit(
        'model.snowtest_selfcheck.refused',
        "SELECT CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP) AS TS",
      );
      // The status and the code, not merely "not 200": a crash answering 500 with no
      // Snowflake code would satisfy the weaker form while proving nothing about
      // strict.
      ok(
        `strict answered the approximate statement ${refused.status} ${refused.code}`,
        refused.status === 422 && refused.code === '002003',
      );
      ok(
        `the refusal read "${refused.message.split('\n')[0].slice(0, 60)}"`,
        refused.message.includes('CONVERT_TIMEZONE') && refused.message.includes('strict'),
      );
    } finally {
      await writeMode('report');
    }

    const restored = await modelReport();
    ok(`the mode read back as ${restored.mode}`, restored.mode === 'report');
    return `${landed.models.length} models, mode ${restored.mode}`;
  });

  // Drivers rotate their token mid-run, and a rotation that kills the old token
  // too early breaks every long dbt job. This check keeps its own session, so a
  // failure here cannot leave the later checks holding a dead token.
  await check('session', 3, async (ok) => {
    const login = await request('/session/v1/login-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { LOGIN_NAME: 'SELF_TEST_ROTATION' } }),
    });
    const first = String(((await login.json()) as Envelope).data?.token ?? '');
    // Whether a login hands back a token is the 'login' check's assertion; counting
    // it again here would say nothing new. This stops with the reason instead.
    if (!first) throw new Error(`a fresh login answered ${login.status} with no token`);

    const renewal = await request('/session/v1/login-request', {
      headers: { Authorization: `Bearer ${first}` },
    });
    const renewed = String(((await renewal.json()) as Envelope).data?.token ?? '');
    ok(
      `renewal answered ${renewal.status} with ${renewed && renewed !== first ? 'a new' : 'no new'} token`,
      renewal.status === 200 && renewed !== '' && renewed !== first,
    );

    const stale = await run(request, first, 'select 1');
    ok(`the replaced token still ran a statement: ${stale.code ?? 'no code'}`, !stale.success);
    const fresh = await run(request, renewed, 'select 1');
    ok(`the renewed token returned ${JSON.stringify(fresh.rows)}`, fresh.success && fresh.rows[0]?.[0] === '1');

    // The session is this check's own; hand it back instead of waiting for the sweep.
    await request('/session', { method: 'POST', headers: { Authorization: `Bearer ${renewed}` } });
    return 'old token retired, renewed token ran select 1';
  });

  await check('error reporting', 3, async (ok) => {
    const result = await run(request, session('error reporting'), 'select * from no_such_table_self_check');
    ok('a query against a missing table succeeded', !result.success);
    ok('the error carried no code', Boolean(result.code));
    ok('the error carried no message', Boolean(result.message));
    return `${result.code}: ${(result.message ?? '').split('\n')[0]}`.slice(0, 80);
  });

  await check('cleanup', 3, async (ok) => {
    // Cleanup has to run even when the login check is what failed, so it gets its
    // own session instead of depending on the one above it.
    let cleaning = token;
    if (!cleaning) {
      const response = await request('/session/v1/login-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { LOGIN_NAME: 'SELF_TEST_CLEANUP' } }),
      });
      cleaning = String(((await response.json()) as Envelope).data?.token ?? '');
      if (!cleaning) throw new Error('no session, and a fresh login was refused');
    }

    await must(request, cleaning, `drop database if exists ${DATABASE}`);

    const databases = await must(request, cleaning, 'show databases');
    ok(`${DATABASE} is still listed by SHOW DATABASES`, !databases.some((row) => row[0] === DATABASE));

    await request('/session', { method: 'POST', headers: { Authorization: `Bearer ${cleaning}` } });
    const after = await run(request, cleaning, 'select 1');
    ok('the session still accepts statements after logout', !after.success);

    const state = JSON.stringify(await (await request('/_snowtest/state')).json());
    ok(`${DATABASE} is still in the catalog`, !state.includes(DATABASE));
    return `${DATABASE} dropped, session closed`;
  });

  const passed = checks.reduce((sum, entry) => sum + entry.passed, 0);
  const total = checks.reduce((sum, entry) => sum + entry.total, 0);
  const failedChecks = checks.filter((entry) => !entry.ok).length;

  return {
    ok: failedChecks === 0,
    checks,
    passed,
    total,
    failedChecks,
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  };
}

const SCRIPT = `<script>
(() => {
  const button = document.getElementById('run-self-test');
  const out = document.getElementById('self-test-results');
  const stamp = document.getElementById('self-test-stamp');

  const cell = (text, className) => {
    const td = document.createElement('td');
    if (className) td.className = className;
    td.textContent = text;
    return td;
  };

  const render = (report) => {
    const summary = report.passed + '/' + report.total + ' assertions in ' + report.durationMs + ' ms';
    const banner = document.createElement('p');
    banner.className = report.ok ? 'lede' : 'lede failed';
    banner.textContent = report.ok
      ? report.checks.length + ' checks, ' + summary
      : report.failedChecks + ' of ' + report.checks.length + ' checks failed, ' + summary;

    const table = document.createElement('table');
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['Check', 'Result', 'Detail', 'ms']) headRow.append(cell(label));
    head.append(headRow);
    headRow.lastChild.className = 'rn';

    const body = document.createElement('tbody');
    for (const check of report.checks) {
      const row = document.createElement('tr');
      const status = document.createElement('td');
      const pill = document.createElement('span');
      pill.className = 'pill ' + (check.ok ? 'pill-supported' : 'pill-unsupported');
      pill.textContent = check.passed + '/' + check.total;
      status.append(pill);
      row.append(cell(check.name), status, cell(check.detail), cell(String(check.ms), 'rn'));
      body.append(row);
    }
    table.append(head, body);
    out.replaceChildren(banner, table);
    stamp.textContent = 'ran at ' + new Date(report.at).toLocaleTimeString();
  };

  button.addEventListener('click', async () => {
    button.disabled = true;
    out.hidden = false;
    out.textContent = 'Running…';
    try {
      const response = await fetch('/_snowtest/self-test', { method: 'POST' });
      const report = await response.json();
      if (response.status === 409) {
        out.textContent = 'A self test is already running.';
        return;
      }
      if (!report.checks) throw new Error(report.error || 'the run returned no report');
      render(report);
    } catch (error) {
      out.textContent = 'The self test could not run: ' + error.message;
    } finally {
      button.disabled = false;
    }
  });
})();
</script>`;

/** The page served at `/self-test`. */
export function renderSelfTest(version: string): string {
  const body = `<h1>Self Test</h1>
<p class="lede">Runs a set of checks against this instance, over the same endpoints a client uses,
and reports each one with how many of its own assertions passed. It writes only to a scratch
database, <code>${DATABASE}</code>, and drops it at the end, apart from two rows in the fidelity
ledger under <code>model.snowtest_selfcheck.*</code>.</p>

<div class="ops">
<button type="button" id="run-self-test">Run self test</button>
<span class="muted" id="self-test-stamp"></span>
</div>

<div class="ops" id="self-test-results" hidden></div>
${SCRIPT}`;

  return renderPage({ title: 'snowtest — self test', body, version, nav: 'self-test' });
}
