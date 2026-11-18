// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * The statement interceptor: what it records about statements that pass
 * through it, and what it deliberately leaves alone.
 *
 * These assertions are about the seam rather than about SQL answers, so they go
 * through the server's own HTTP surface and read back the account's query
 * history — that is the interceptor's only observable output today.
 */

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

describe('statement interceptor', () => {
  let server: SnowtestServer;
  beforeAll(async () => {
    server = await createServer({ dataDir: null });
  });
  afterAll(async () => {
    await server?.close();
  });

  it('notes every statement in a multi-statement body, one row each', async () => {
    const result = await sql(server, 'SELECT 11 AS INTERCEPTOR_A; SELECT 12 AS INTERCEPTOR_B');
    expect(result.status).toBe(200);

    const history = await rows(
      server,
      `SELECT query_text FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
       WHERE query_text IN ('SELECT 11 AS INTERCEPTOR_A', 'SELECT 12 AS INTERCEPTOR_B')`,
    );
    // Both, not just the body as a whole: the interceptor wraps each statement.
    expect(history.length).toBe(2);
  });

  it('records the verb Snowflake would call the statement', async () => {
    expect((await sql(server, 'CREATE TABLE INTERCEPTOR_VERB (ID INT)')).status).toBe(200);

    const history = await rows(
      server,
      `SELECT query_type FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
       WHERE query_text = 'CREATE TABLE INTERCEPTOR_VERB (ID INT)'`,
    );
    expect(history.length).toBe(1);
    expect(history[0][0]).toBe('CREATE');
  });

  it('keeps the statement as the client wrote it, not the translated form', async () => {
    // IFF is rewritten to CASE before DuckDB sees it; history must not reveal that.
    expect((await sql(server, "SELECT IFF(1 > 0, 'a', 'b') AS INTERCEPTOR_BAND")).status).toBe(200);

    const history = await rows(
      server,
      `SELECT query_text FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
       WHERE query_text = 'SELECT IFF(1 > 0, ''a'', ''b'') AS INTERCEPTOR_BAND'`,
    );
    expect(history.length).toBe(1);
  });

  it('truncates a long statement to the history column width', async () => {
    const statement = `SELECT 1 AS ${'INTERCEPTOR_LONG_COLUMN_'.repeat(10)}`;
    expect(statement.length).toBeGreaterThan(200);
    expect((await sql(server, statement)).status).toBe(200);

    const expected = `${statement.slice(0, 197)}...`;
    expect(expected.length).toBe(200);
    const history = await rows(
      server,
      `SELECT length(query_text) FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
       WHERE query_text = '${expected}'`,
    );
    // BIGINT rides the wire as text.
    expect(history.length).toBe(1);
    expect(Number(history[0][0])).toBe(200);
  });

  it('records a failure with the Snowflake code and message the client saw', async () => {
    const failed = await sql(server, 'SELECT * FROM INTERCEPTOR_NO_SUCH_TABLE');
    expect(failed.status).not.toBe(200);

    const history = await rows(
      server,
      `SELECT execution_status, error_code, error_message
       FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
       WHERE query_text = 'SELECT * FROM INTERCEPTOR_NO_SUCH_TABLE'`,
    );
    expect(history.length).toBe(1);
    const [status, code, message] = history[0];
    expect(status).toBe('FAIL');
    expect(String(code)).toBe('002003');
    expect(String(message)).toContain('INTERCEPTOR_NO_SUCH_TABLE');
  });

  it('intercepts statements the control plane runs on its own session', async () => {
    const response = await server.app.request('/_snowtest/seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'CREATE OR REPLACE TABLE INTERCEPTOR_FROM_SEED (X INT)' }),
    });
    expect(response.status).toBe(200);

    const history = await rows(
      server,
      `SELECT user_name FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
       WHERE query_text = 'CREATE OR REPLACE TABLE INTERCEPTOR_FROM_SEED (X INT)'`,
    );
    expect(history.length).toBe(1);
    // The seed endpoint runs under its own session, and that session is what the
    // row names — the interceptor reads the session it was handed, not a global.
    expect(String(history[0][0])).toBe('SNOWTEST_SEED');
  });
});
