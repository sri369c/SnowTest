// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * What translation admits to, and what the three modes do about it.
 *
 * The point of these tests is the *absence* of notes as much as their presence:
 * a warning on every faithful rewrite would be noise, and noise is how a reader
 * learns to skip the report.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServer, type SnowtestServer } from '../src/server.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, loadConfig } from '../src/config/server-config.js';
import { rewrite, type Approximation } from '../src/sql/dialect.js';
import { approximation, type ApproximatedFeature } from '../src/sql/approximations.js';

const ctx = {
  database: 'SNOWTEST',
  schema: 'PUBLIC',
  role: 'SYSADMIN',
  user: 'TEST',
  warehouse: 'SNOWTEST_WH',
  variantPaths: true,
};

/** Translate one statement and return what it admitted to. */
function approximationsOf(sql: string): Approximation[] {
  const seen: Approximation[] = [];
  rewrite(sql, ctx, [], (approximation) => seen.push(approximation));
  return seen;
}

const featuresOf = (sql: string): string[] => approximationsOf(sql).map((approximation) => approximation.feature);

describe('translation fidelity', () => {
  it('reports a variant path as an approximation', () => {
    const features = featuresOf('SELECT V:NAME FROM T');
    expect(features).toContain('variant path');
    expect(approximationsOf('SELECT V:NAME FROM T')[0].detail).toContain('json_extract');
  });

  it('reports a lateral flatten as an approximation', () => {
    expect(featuresOf('SELECT F.VALUE FROM T, LATERAL FLATTEN(input => T.V) F')).toContain('LATERAL FLATTEN');
  });

  it('reports CONVERT_TIMEZONE as an approximation', () => {
    expect(featuresOf("SELECT CONVERT_TIMEZONE('UTC', TS) FROM T")).toContain('CONVERT_TIMEZONE');
  });

  it('reports the session clock once per use, call or bare', () => {
    expect(featuresOf('SELECT CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP, LOCALTIMESTAMP(), GETDATE()')).toEqual([
      'CURRENT_TIMESTAMP',
      'CURRENT_TIMESTAMP',
      'LOCALTIMESTAMP',
      'GETDATE',
    ]);
    expect(featuresOf('SELECT SYSDATE(), CURRENT_DATE')).toEqual([]);
  });

  it('reports LTZ/TZ casts and conversions, not NTZ', () => {
    expect(featuresOf("SELECT '2026-01-15 12:00:00'::TIMESTAMP_LTZ, CAST(A AS TIMESTAMP_TZ(3)) FROM T")).toEqual([
      'TIMESTAMP_LTZ',
      'TIMESTAMP_TZ',
    ]);
    expect(featuresOf('SELECT TO_TIMESTAMP_LTZ(A), TRY_TO_TIMESTAMP_TZ(B) FROM T').sort()).toEqual([
      'TO_TIMESTAMP_LTZ',
      'TRY_TO_TIMESTAMP_TZ',
    ]);
    expect(featuresOf("SELECT A::TIMESTAMP_NTZ, TO_TIMESTAMP_NTZ(B), 'x::timestamp_ltz' FROM T")).toEqual([]);
    expect(featuresOf("SELECT CONVERT_TIMEZONE('UTC', TS) AS TIMESTAMP_TZ FROM T")).toEqual(['CONVERT_TIMEZONE']);
  });

  it('reports TYPEOF', () => {
    expect(featuresOf('SELECT TYPEOF(V) FROM T')).toEqual(['TYPEOF']);
  });

  it('reports HASH, but not HASH_AGG', () => {
    expect(featuresOf('SELECT HASH(A), HASH_AGG(B) FROM T')).toEqual(['HASH']);
  });

  it('reports TO_VARCHAR of a visible timestamp, not of other values', () => {
    expect(
      featuresOf("SELECT TO_VARCHAR(A::TIMESTAMP_NTZ), TO_CHAR(CURRENT_TIMESTAMP()), TO_VARCHAR(TO_TIMESTAMP(B)) FROM T")
        .filter((feature) => feature.startsWith('TO_'))
        .sort(),
    ).toEqual(['TO_CHAR', 'TO_VARCHAR', 'TO_VARCHAR']);
    expect(featuresOf("SELECT TO_VARCHAR(A), TO_VARCHAR(1.5), TO_CHAR(TS, 'YYYY-MM-DD') FROM T")).toEqual([]);
  });

  it('reports ARRAY_CONSTRUCT only with a NULL element', () => {
    expect(featuresOf('SELECT ARRAY_CONSTRUCT(1, NULL), ARRAY_CONSTRUCT(1, 2)')).toEqual(['ARRAY_CONSTRUCT']);
  });

  it('reports DATEADD only when the operand is visibly a DATE and the unit keeps it one', () => {
    expect(featuresOf("SELECT DATEADD(day, 1, '2026-01-01'::DATE), DATEADD(month, 1, CURRENT_DATE)")).toEqual([
      'DATEADD',
      'DATEADD',
    ]);
    expect(featuresOf("SELECT DATEADD(hour, 1, '2026-01-01'::DATE), DATEADD(day, 1, TS) FROM T")).toEqual([]);
  });

  it('says nothing about rewrites that mean exactly what Snowflake means', () => {
    // Each of these is a faithful substitution, not an approximation.
    for (const sql of [
      "SELECT IFF(A > 0, 'x', 'y') FROM T",
      'SELECT NVL2(A, B, C) FROM T',
      'SELECT ZEROIFNULL(A) FROM T',
      'SELECT NULLIFZERO(A) FROM T',
      'SELECT DIV0(A, B) FROM T',
      'SELECT DECODE(A, 1, 2, 3) FROM T',
      'SELECT GREATEST(A, B), LEAST(A, B) FROM T',
      "SELECT OBJECT_CONSTRUCT('a', A), PARSE_JSON(S), DATEDIFF(week, A, B) FROM T",
      'SELECT A + 1 FROM T',
    ]) {
      expect(featuresOf(sql), sql).toEqual([]);
    }
  });

  it('reports each occurrence, so a model using it twice is not undercounted', () => {
    const features = featuresOf("SELECT CONVERT_TIMEZONE('UTC', A), CONVERT_TIMEZONE('UTC', B) FROM T");
    expect(features).toHaveLength(2);
  });

  it('translates without a sink at all', () => {
    expect(rewrite("SELECT CONVERT_TIMEZONE('UTC', TS) FROM T", ctx)).toBe(
      "SELECT TIMEZONE('UTC', TS) FROM T",
    );
  });

  it('refuses a construct name that is not in the registry', () => {
    expect(() => approximation('TO_TIMESTMAP_TZ' as ApproximatedFeature)).toThrow(/not registered/);
  });
});

/**
 * The three modes, from the outside: what a client sees and what the ledger holds.
 * A dbt comment is the only thing that names a model, so these statements carry one.
 */
const dbt = (nodeId: string, sql: string): string => `/* {"app": "dbt", "node_id": "${nodeId}"} */\n${sql}`;

const APPROXIMATE_SQL = "SELECT CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP) AS TS";

async function run(server: SnowtestServer, statement: string) {
  const response = await server.app.request('/api/v2/statements', {
    method: 'POST',
    headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ statement }),
  });
  return { status: response.status, body: (await response.json()) as { message?: string } };
}

interface ModelReport {
  fidelity: string;
  models: Array<{ nodeId: string; statements: number; constructs: string[]; verdict: string }>;
}

async function models(server: SnowtestServer): Promise<ModelReport> {
  const response = await server.app.request('/_snowtest/models');
  return (await response.json()) as ModelReport;
}

describe('fidelity: report', () => {
  let server: SnowtestServer;
  beforeAll(async () => {
    server = await createServer({ dataDir: null, fidelity: 'report' });
  });
  afterAll(async () => {
    await server?.close();
  });

  it('holds an approximate model in the ledger with what it leaned on', async () => {
    const result = await run(server, dbt('model.demo.approx', APPROXIMATE_SQL));
    expect(result.status).toBe(200);
    const report = await models(server);
    expect(report.fidelity).toBe('report');
    const model = report.models.find((entry) => entry.nodeId === 'model.demo.approx');
    expect(model?.verdict).toBe('approximate');
    expect(model?.constructs.sort()).toEqual(['CONVERT_TIMEZONE', 'CURRENT_TIMESTAMP']);
    expect(model?.statements).toBe(1);
  });

  it('marks a model that needed nothing approximated as verified, and counts repeats', async () => {
    await run(server, dbt('model.demo.clean', 'SELECT 1 AS ONE'));
    await run(server, dbt('model.demo.clean', 'SELECT 2 AS TWO'));
    const model = (await models(server)).models.find((entry) => entry.nodeId === 'model.demo.clean');
    expect(model?.verdict).toBe('verified');
    expect(model?.constructs).toEqual([]);
    expect(model?.statements).toBe(2);
  });

  it('records nothing for a statement that names no model', async () => {
    const before = (await models(server)).models.length;
    await run(server, 'SELECT 3 AS THREE');
    expect((await models(server)).models.length).toBe(before);
  });
});

describe('fidelity: strict', () => {
  let server: SnowtestServer;
  beforeAll(async () => {
    server = await createServer({ dataDir: null, fidelity: 'strict' });
  });
  afterAll(async () => {
    await server?.close();
  });

  it('refuses an approximate statement before it runs, naming the construct', async () => {
    const result = await run(server, dbt('model.demo.approx', APPROXIMATE_SQL));
    expect(result.status).not.toBe(200);
    expect(result.body.message).toContain('CONVERT_TIMEZONE');
    expect(result.body.message).toContain('strict');
  });

  it('leaves no ledger row for the refused statement', async () => {
    const report = await models(server);
    expect(report.fidelity).toBe('strict');
    expect(report.models.some((entry) => entry.nodeId === 'model.demo.approx')).toBe(false);
  });

  it('still runs a model that needs nothing approximated', async () => {
    const result = await run(server, dbt('model.demo.clean', 'SELECT 1 AS ONE'));
    expect(result.status).toBe(200);
    const model = (await models(server)).models.find((entry) => entry.nodeId === 'model.demo.clean');
    expect(model?.verdict).toBe('verified');
  });
});

describe('fidelity: off', () => {
  let server: SnowtestServer;
  beforeAll(async () => {
    server = await createServer({ dataDir: null, fidelity: 'off' });
  });
  afterAll(async () => {
    await server?.close();
  });

  it('runs approximate SQL and keeps no ledger at all', async () => {
    expect((await run(server, dbt('model.demo.approx', APPROXIMATE_SQL))).status).toBe(200);
    const report = await models(server);
    expect(report.fidelity).toBe('off');
    expect(report.models).toEqual([]);
  });
});

describe('fidelity mode configuration', () => {
  it('defaults to report, because refusing by default would surprise every existing setup', () => {
    expect(DEFAULTS.fidelity).toBe('report');
  });

  it('rejects a mode it does not know, including one supplied as a flag', () => {
    expect(() => loadConfig({ fidelity: 'stric' as never })).toThrow(/off, report or strict/);
  });
});

describe('fidelity: the setting', () => {
  it('applies from the control plane, and the next statement feels it', async () => {
    const server = await createServer({ dataDir: null });
    try {
      const response = await server.app.request('/_snowtest/fidelity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'strict' }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { mode: string; applied: string; impact: string };
      expect(body.mode).toBe('strict');
      expect(body.impact).toContain('refused');

      const refused = await run(server, dbt('model.later.approx', APPROXIMATE_SQL));
      expect(refused.status).not.toBe(200);
      expect(refused.body.message).toContain('strict');
    } finally {
      await server.close();
    }
  });

  it('rejects a value it does not know', async () => {
    const server = await createServer({ dataDir: null });
    try {
      const response = await server.app.request('/_snowtest/fidelity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'lenient' }),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain('off, report, strict');
    } finally {
      await server.close();
    }
  });

  it('refuses to override a mode a flag pinned, instead of saving a dead value', async () => {
    const server = await createServer({ dataDir: null, fidelity: 'report', fidelityPinned: true });
    try {
      const response = await server.app.request('/_snowtest/fidelity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'strict' }),
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toContain('pinned');
    } finally {
      await server.close();
    }
  });

  it('remembers the mode in the data directory, across a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'snowtest-fidelity-'));
    try {
      const first = await createServer({ dataDir: dir });
      const applied = await first.app.request('/_snowtest/fidelity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'strict' }),
      });
      expect(applied.status).toBe(200);
      await first.close();

      const second = await createServer({ dataDir: dir });
      try {
        expect((await models(second)).fidelity).toBe('strict');
      } finally {
        await second.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('fidelity: the settings page', () => {
  it('is a top-level tab after Self Test, with the control above the explanations', async () => {
    const server = await createServer({ dataDir: null });
    try {
      const html = await (await server.app.request('/settings')).text();
      expect(html).toContain('<a href="/settings" aria-current="page">Settings</a>');
      const selfTest = html.indexOf('>Self Test<');
      const settings = html.indexOf('>Settings<');
      expect(selfTest).toBeGreaterThan(-1);
      expect(settings).toBeGreaterThan(selfTest);

      const select = html.indexOf('id="fidelity-value"');
      const explanations = html.indexOf('What each mode does');
      expect(select).toBeGreaterThan(-1);
      expect(explanations).toBeGreaterThan(select);

      for (const line of [
        'Does no fidelity work at all.',
        'Records what each model needed approximated, and never stops a query.',
        'Refuses a statement before it executes',
      ]) {
        expect(html, line).toContain(line);
      }
      expect(html).toContain('id="fidelity-apply"');
    } finally {
      await server.close();
    }
  });

  it('leaves no fidelity tab behind on the configuration page', async () => {
    const server = await createServer({ dataDir: null });
    try {
      const html = await (await server.app.request('/configuration')).text();
      expect(html).not.toContain('id="tab-fidelity"');
      expect(html).toContain('Change it on the Settings page.');
    } finally {
      await server.close();
    }
  });
});
