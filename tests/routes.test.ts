// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * The plumbing around the driver protocol: the probes a driver pings without
 * showing them, both token-renewal paths, the monitoring and cancel routes, and
 * the async result fetch. A break in any of these only ever showed up as a
 * driver failing against a real client, so they get their own suite.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServer, type SnowtestServer } from '../src/server.js';
import { PACKAGE_VERSION } from '../src/version.js';

interface Envelope<T> {
  success: boolean;
  data: T;
  message?: string | null;
}

interface LoginData {
  token: string;
  sessionId: number;
}

async function request<B = unknown>(
  server: SnowtestServer,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: B }> {
  const response = await server.app.request(path, init);
  return { status: response.status, body: (await response.json()) as B };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function login(server: SnowtestServer, name = 'T'): Promise<LoginData> {
  const { body } = await request<Envelope<LoginData>>(server, '/session/v1/login-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { LOGIN_NAME: name } }),
  });
  expect(body.success).toBe(true);
  return body.data;
}

async function query<T>(server: SnowtestServer, token: string, sql: string, extra: Record<string, unknown> = {}): Promise<Envelope<T>> {
  const { body } = await request<Envelope<T>>(server, '/queries/v1/query-request', {
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sqlText: sql, ...extra }),
  });
  return body;
}

describe('control-plane probes', () => {
  let server: SnowtestServer;

  beforeAll(async () => {
    server = await createServer({ dataDir: null });
  });

  afterAll(async () => {
    await server?.close();
  });

  it('reports both versions on /_snowtest/health', async () => {
    const { status, body } = await request<{
      status: string;
      emulatedSnowflakeVersion: string;
      snowtestVersion: string;
    }>(server, '/_snowtest/health');

    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.snowtestVersion).toBe(PACKAGE_VERSION);
    expect(body.emulatedSnowflakeVersion).toMatch(/^\d+\.\d+/);
  });

  it('reports the catalog and the live sessions on /_snowtest/state', async () => {
    type State = {
      sessions: number;
      activeSession: Array<{ id: number; user: string; database: string }>;
    };
    const before = await request<State>(server, '/_snowtest/state');
    const { sessionId } = await login(server);
    const after = await request<State>(server, '/_snowtest/state');

    expect(before.status).toBe(200);
    expect(before.body.sessions).toBe(0);
    expect(after.body.sessions).toBe(1);
    expect(after.body.activeSession).toContainEqual(expect.objectContaining({ id: sessionId, user: 'T' }));
  });

  it('answers the acknowledgements a driver posts without expecting data', async () => {
    for (const path of ['/session/heartbeat', '/telemetry/send', '/queries/v1/abort-request']) {
      const { status, body } = await request<{ success: boolean }>(server, path, { method: 'POST' });
      expect(status, path).toBe(200);
      expect(body.success, path).toBe(true);
    }
  });
});

describe('token renewal', () => {
  let server: SnowtestServer;

  beforeAll(async () => {
    server = await createServer({ dataDir: null });
  });

  afterAll(async () => {
    await server?.close();
  });

  it('renews over GET and retires the old token', async () => {
    const original = await login(server);
    const { body } = await request<Envelope<LoginData>>(server, '/session/v1/login-request', {
      headers: bearer(original.token),
    });

    expect(body.success).toBe(true);
    expect(body.data.sessionId).toBe(original.sessionId);
    expect(body.data.token).not.toBe(original.token);

    expect((await query(server, original.token, 'select 1')).success).toBe(false);
    expect((await query(server, body.data.token, 'select 1')).success).toBe(true);
  });

  it('renews over POST /session/token-request', async () => {
    const original = await login(server);
    const { body } = await request<Envelope<LoginData>>(server, '/session/token-request', {
      method: 'POST',
      headers: { ...bearer(original.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(body.success).toBe(true);
    expect(body.data.sessionId).toBe(original.sessionId);
    expect(body.data.token).not.toBe(original.token);
    expect((await query(server, original.token, 'select 1')).success).toBe(false);
  });

  it('refuses to renew an unknown token', async () => {
    const { body } = await request<Envelope<LoginData>>(server, '/session/token-request', {
      method: 'POST',
      headers: { ...bearer('not-a-token'), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(body.success).toBe(false);
  });
});

describe('query monitoring and cancellation', () => {
  let server: SnowtestServer;

  beforeAll(async () => {
    server = await createServer({ dataDir: null });
  });

  afterAll(async () => {
    await server?.close();
  });

  it('lists a finished query under /monitoring/queries', async () => {
    const { token } = await login(server);
    const executed = await query<{ queryId: string }>(server, token, 'select 42 as answer');
    expect(executed.success).toBe(true);

    const { body } = await request<Envelope<{ queries: Array<{ queryId: string; state: string; sqlText: string }> }>>(
      server,
      `/monitoring/queries/${executed.data.queryId}`,
    );

    expect(body.success).toBe(true);
    expect(body.data.queries).toContainEqual(
      expect.objectContaining({
        queryId: executed.data.queryId,
        state: 'SUCCESS',
        sqlText: 'select 42 as answer',
      }),
    );
  });

  it('serves an async submission from the URL it advertised', async () => {
    const { token } = await login(server);
    const submitted = await query<{ queryId: string; getResultUrl: string }>(server, token, 'select 7 as n', {
      asyncExec: true,
    });

    expect(submitted.success).toBe(true);
    expect(submitted.data.getResultUrl).toBe(`/queries/v1/query-result/${submitted.data.queryId}`);

    const fetched = await request<Envelope<{ rowset: unknown[][] }>>(server, submitted.data.getResultUrl, {
      headers: bearer(token),
    });
    expect(fetched.status).toBe(200);
    expect(fetched.body.success).toBe(true);
    // Fixed-scale numbers cross the driver protocol as strings, so the client keeps
    // every digit; the connector is what turns them back into ints.
    expect(fetched.body.data.rowset).toEqual([['7']]);
  });

  it('404s a result that was never submitted asynchronously', async () => {
    const { status, body } = await request<Envelope<null>>(server, '/queries/v1/query-result/no-such-query');
    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });

  it('cancels a statement handle and drops it', async () => {
    // SQL API v2 answers with the statement itself, not a driver envelope.
    const submitted = await request<{ statementHandle: string; statementStatusUrl: string }>(
      server,
      '/api/v2/statements',
      {
        method: 'POST',
        headers: { ...bearer('sql-api'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ statement: 'select 1 as n' }),
      },
    );
    expect(submitted.status).toBe(200);
    const handle = submitted.body.statementHandle;
    expect(submitted.body.statementStatusUrl).toBe(`/api/v2/statements/${handle}`);

    const cancelled = await request<{ code: string; statementHandle: string }>(
      server,
      `/api/v2/statements/${handle}/cancel`,
      { method: 'POST' },
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ code: '000604', statementHandle: handle });

    const gone = await request<unknown>(server, `/api/v2/statements/${handle}`);
    expect(gone.status).toBe(404);
  });
});

describe('unmatched paths', () => {
  let server: SnowtestServer;

  beforeAll(async () => {
    server = await createServer({ dataDir: null });
  });

  afterAll(async () => {
    await server?.close();
  });

  it('answers a JSON 404 that names the path', async () => {
    const { status, body } = await request<{ error: string; path: string }>(server, '/nothing/here');
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: 'Not found', path: '/nothing/here' });
  });
});
