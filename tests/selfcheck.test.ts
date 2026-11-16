// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * The self test at `/self-test`: every check has to pass every one of its
 * assertions on a healthy server, the totals have to add up, the scratch
 * database has to be gone afterwards, and the page has to carry the button that
 * starts a run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServer, type SnowtestServer } from '../src/server.js';

interface SelfCheckResult {
  name: string;
  ok: boolean;
  passed: number;
  total: number;
  detail: string;
  ms: number;
}

interface SelfReport {
  ok: boolean;
  passed: number;
  total: number;
  failedChecks: number;
  durationMs: number;
  checks: SelfCheckResult[];
}

describe('self test', () => {
  let server: SnowtestServer;

  beforeAll(async () => {
    server = await createServer({ dataDir: null });
  });

  afterAll(async () => {
    await server.close();
  });

  it('passes every assertion in every check on a healthy instance', async () => {
    const response = await server.app.request('/_snowtest/self-test', { method: 'POST' });
    expect(response.status).toBe(200);
    const report = (await response.json()) as SelfReport;

    // Name the failures rather than printing a bare boolean: a broken check is
    // the only thing this test can plausibly tell you.
    const failures = report.checks
      .filter((check) => !check.ok)
      .map((check) => `${check.name} ${check.passed}/${check.total}: ${check.detail}`);
    expect(failures).toEqual([]);

    expect(report.ok).toBe(true);
    expect(report.failedChecks).toBe(0);
    expect(report.checks.length).toBe(11);
    for (const check of report.checks) {
      expect(check.total, check.name).toBeGreaterThan(0);
      expect(check.passed, check.name).toBe(check.total);
    }

    expect(report.total).toBe(38);
    expect(report.passed).toBe(report.total);
    expect(report.durationMs).toBeGreaterThan(0);
  }, 60_000);

  it('drops the database it wrote to', async () => {
    const response = await server.app.request('/_snowtest/state');
    expect(await response.text()).not.toContain('SNOWTEST_SELFCHECK');
  });

  it('serves the page with the run button', async () => {
    const response = await server.app.request('/self-test');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<h1>Self Test</h1>');
    expect(html).toContain('id="run-self-test"');
    expect(html).toContain('href="/self-test" aria-current="page"');
  });
});
