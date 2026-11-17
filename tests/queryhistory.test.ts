// Copyright (c) 2026 Srinivas Chaturvedula

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServer, type SnowtestServer } from '../src/server.js';

interface ApiResult {
  status: number;
  body: { data?: unknown[][]; message?: string; code?: string };
}

async function sql(server: SnowtestServer, statement: string): Promise<ApiResult> {
  const response = await server.app.request('/api/v2/statements', {
    method: 'POST',
    headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ statement }),
  });
  return { status: response.status, body: (await response.json()) as ApiResult['body'] };
}

async function rows(server: SnowtestServer, statement: string): Promise<unknown[][]> {
  const result = await sql(server, statement);
  if (result.status !== 200) throw new Error(`${statement}: ${result.body.message}`);
  return result.body.data ?? [];
}

describe('query history (in memory)', () => {
  let server: SnowtestServer;
  beforeAll(async () => {
    server = await createServer({ dataDir: null });
  });
  afterAll(async () => {
    await server?.close();
  });

  it('notes a successful statement where Snowflake keeps account usage', async () => {
    expect((await sql(server, 'SELECT 1 AS ONE')).status).toBe(200);

    const history = await rows(
      server,
      `SELECT query_text, total_elapsed_time, execution_status, rows_produced,
              query_type, user_name, warehouse_name, warehouse_size
       FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
       WHERE query_text = 'SELECT 1 AS ONE'`,
    );
    expect(history.length).toBe(1);
    const [text, elapsed, status, produced, type, user, warehouse, size] = history[0];
    expect(text).toBe('SELECT 1 AS ONE');
    expect(status).toBe('SUCCESS');
    expect(type).toBe('SELECT');
    // BIGINT rides the wire as text, the way Snowflake encodes NUMBER.
    expect(Number(produced)).toBe(1);
    expect(Number.isFinite(Number(elapsed))).toBe(true);
    expect(Number(elapsed)).toBeGreaterThanOrEqual(0);
    expect(String(user).length).toBeGreaterThan(0);
    expect(String(warehouse).length).toBeGreaterThan(0);
    expect(size).not.toBeNull();
  });

  it('notes a failed statement with the error it was given', async () => {
    const failed = await sql(server, 'SELECT * FROM NO_SUCH_TABLE_HERE');
    expect(failed.status).not.toBe(200);

    const history = await rows(
      server,
      `SELECT execution_status, error_code, error_message
       FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
       WHERE query_text LIKE 'SELECT * FROM NO_SUCH_TABLE_HERE%'`,
    );
    expect(history.length).toBe(1);
    expect(history[0][0]).toBe('FAIL');
    expect(String(history[0][1]).length).toBeGreaterThan(0);
    expect(String(history[0][2])).toContain('NO_SUCH_TABLE_HERE');
  });

  it('empties only when asked, and nothing prunes it on the way', async () => {
    expect((await sql(server, 'SELECT 3 AS THREE')).status).toBe(200);
    const kept = await rows(server, 'SELECT count(*) FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY');
    expect(Number(kept[0][0])).toBeGreaterThan(1);

    const cleared = await server.app.request('/_snowtest/queries/clear', { method: 'POST' });
    expect(cleared.status).toBe(200);
    expect(Number(((await cleared.json()) as { cleared: number }).cleared)).toBeGreaterThan(1);

    // The count below runs against the emptied table, and its own row lands after it.
    const after = await rows(server, 'SELECT count(*) FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY');
    expect(Number(after[0][0])).toBe(0);
  });

  it('counts every statement it saw, newest first', async () => {
    const before = await rows(server, 'SELECT count(*) FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY');
    expect((await sql(server, 'SELECT 5 AS FIVE')).status).toBe(200);
    const after = await rows(server, 'SELECT count(*) FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY');
    expect(Number(after[0][0])).toBe(Number(before[0][0]) + 2);

    const newest = await rows(
      server,
      `SELECT query_text FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY ORDER BY query_id DESC LIMIT 2`,
    );
    expect(newest[0][0]).toBe('SELECT count(*) FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY');
    expect(newest[1][0]).toBe('SELECT 5 AS FIVE');
  });
});

describe('query history (persisted)', () => {
  it('survives a restart, and its file never comes back as a user database', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'snowtest-history-'));
    try {
      const first = await createServer({ dataDir });
      await rows(first, 'SELECT 42 AS MARKER');
      await first.close();

      const second = await createServer({ dataDir });
      const found = await rows(
        second,
        `SELECT query_text FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY WHERE query_text = 'SELECT 42 AS MARKER'`,
      );
      expect(found.length).toBe(1);

      const databases = await rows(second, 'SHOW DATABASES');
      expect(JSON.stringify(databases)).not.toContain('query_history');
      await second.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('timings chart and the hour filter', () => {
  let server: SnowtestServer;

  const page = async (path: string): Promise<string> => (await server.app.request(path)).text();
  /** One rect per bucket; the count is what the window controls. */
  const buckets = (html: string): number => (html.match(/class="hit"/g) ?? []).length;

  beforeAll(async () => {
    server = await createServer({ dataDir: null });
  });
  afterAll(async () => {
    await server?.close();
  });

  it('draws one bucket for every hour in the window', async () => {
    expect((await sql(server, 'SELECT 1 AS CHART_MARKER')).status).toBe(200);

    const html = await page('/');
    expect(buckets(html)).toBe(24);
    expect(html).toContain('Statements per hour');
    expect(html).toContain('1 in the window');
  });

  it('marks days, not hours, once the window runs past one', async () => {
    const week = await page('/?window=168');
    // One candidate per bucket; the browser keeps the ones that start a local day.
    expect((week.match(/class="daymark"/g) ?? []).length).toBe(168);
    expect((await page('/?window=24')).includes('class="daymark"')).toBe(false);
  });

  it('falls back to a day for a window it does not offer', async () => {
    expect(buckets(await page('/?window=999'))).toBe(24);
    expect(buckets(await page('/?window=6'))).toBe(6);
    expect(buckets(await page('/?window=168'))).toBe(168);
  });

  it('narrows the table to the hour that was clicked', async () => {
    const from = new Date();
    from.setMinutes(0, 0, 0);
    const to = new Date(from.getTime() + 3_600_000);

    const html = await page(`/?window=24&from=${from.toISOString()}&to=${to.toISOString()}`);
    expect(html).toContain('CHART_MARKER');
    expect(html).toContain('class="chip"');
  });

  it('says the hour is empty instead of showing an older statement', async () => {
    const html = await page('/?from=2001-01-01T00:00:00.000Z&to=2001-01-01T01:00:00.000Z');
    expect(html).toContain('No statements in this hour.');
    expect(html).not.toContain('CHART_MARKER');
    expect(html).toContain('class="chip"');
  });

  it('ignores a range it cannot read', async () => {
    const html = await page('/?from=yesterday&to=tomorrow');
    expect(html).toContain('CHART_MARKER');
    expect(html).not.toContain('class="chip"');
  });

  it('draws no line when nothing is timed yet', async () => {
    const empty = await createServer({ dataDir: null });
    try {
      const html = await (await empty.app.request('/')).text();
      expect(buckets(html)).toBe(0);
      expect(html).toContain('Nothing in the last 24 hours is timed yet');
    } finally {
      await empty.close();
    }
  });
});
