// Copyright (c) 2026 Srinivas Chaturvedula

import { describe, expect, it } from 'vitest';

import { createServer, type SnowtestServer } from '../src/server.js';

interface SeedResult {
  status: number;
  body: { executed?: number; source?: string; error?: string };
}

async function seed(server: SnowtestServer, payload: Record<string, unknown>): Promise<SeedResult> {
  const response = await server.app.request('/_snowtest/seed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as SeedResult['body'] };
}

interface ApiResult {
  status: number;
  body: { data?: string[][]; message?: string };
}

async function api(server: SnowtestServer, statement: string): Promise<ApiResult> {
  const response = await server.app.request('/api/v2/statements', {
    method: 'POST',
    headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ statement }),
  });
  return { status: response.status, body: (await response.json()) as ApiResult['body'] };
}

async function run(server: SnowtestServer, statement: string): Promise<void> {
  const result = await api(server, statement);
  if (result.status !== 200) throw new Error(`${statement}: ${result.body.message}`);
}

/** How many rows a `COUNT(*)` sees, as the client would read it. */
async function count(server: SnowtestServer, from: string): Promise<string> {
  const result = await api(server, `SELECT COUNT(*) AS N FROM ${from}`);
  if (result.status !== 200) throw new Error(`${from}: ${result.body.message}`);
  return result.body.data?.[0]?.[0] ?? 'no rows';
}

describe('POST /_snowtest/seed', () => {
  it('runs the script it is given, and says where the SQL came from', async () => {
    const server = await createServer({ dataDir: null });
    try {
      const result = await seed(server, {
        // Statements are split on `;` that ends a line, so each one gets its own line.
        sql: 'CREATE SCHEMA IF NOT EXISTS SNOWTEST.FIXTURES;\nCREATE TABLE SNOWTEST.FIXTURES.T (n INT)',
      });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ executed: 2, source: 'request' });
      expect(await count(server, 'SNOWTEST.FIXTURES.T')).toBe('0');
    } finally {
      await server.close();
    }
  });

  it('loads the bundled examples when the body carries no sql', async () => {
    const server = await createServer({ dataDir: null });
    try {
      const result = await seed(server, {});
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ executed: 11, source: 'examples' });
      expect(await count(server, 'SNOWTEST.EXAMPLES.STORES')).toBe('5');
      expect(await count(server, 'SNOWTEST.EXAMPLES.ORDER_ITEMS')).toBe('15');
    } finally {
      await server.close();
    }
  });

  it('replaces those tables rather than appending, so an edit does not survive a reseed', async () => {
    const server = await createServer({ dataDir: null });
    try {
      await seed(server, {});
      await run(server, "UPDATE SNOWTEST.EXAMPLES.STORES SET city = 'ZZZ' WHERE store_id = 1");
      expect(await count(server, "SNOWTEST.EXAMPLES.STORES WHERE city = 'ZZZ'")).toBe('1');

      const again = await seed(server, {});
      expect(again.status).toBe(200);
      expect(await count(server, "SNOWTEST.EXAMPLES.STORES WHERE city = 'ZZZ'")).toBe('0');
      expect(await count(server, 'SNOWTEST.EXAMPLES.STORES')).toBe('5');
    } finally {
      await server.close();
    }
  });

  it('still rejects a sql string that is present but empty', async () => {
    const server = await createServer({ dataDir: null });
    try {
      const result = await seed(server, { sql: '   ' });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('sql was empty');
      // Nothing was created on the way to that answer.
      expect((await api(server, 'SELECT COUNT(*) AS N FROM SNOWTEST.EXAMPLES.STORES')).status).not.toBe(200);
    } finally {
      await server.close();
    }
  });
});
