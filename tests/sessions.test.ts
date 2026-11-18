// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * Server state that no other suite covers: sessions expire when idle, an
 * oversized request body is refused rather than buffered, and every way of
 * logging out releases the session's DuckDB connection.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EngineConnection } from '../src/engine/engine.js';
import { createServer, type SnowtestServer } from '../src/server.js';
import { SESSION_IDLE_MS } from '../src/engine/session.js';

interface LoginData {
  token: string;
  sessionId: number;
  validityInSeconds: number;
}

async function login(server: SnowtestServer): Promise<LoginData> {
  const response = await server.app.request('/session/v1/login-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { LOGIN_NAME: 'T' } }),
  });
  const body = (await response.json()) as { success: boolean; data: LoginData };
  expect(body.success).toBe(true);
  return body.data;
}

async function query(server: SnowtestServer, token: string, sql: string): Promise<{ success: boolean; code?: string }> {
  const response = await server.app.request('/queries/v1/query-request', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sqlText: sql }),
  });
  return (await response.json()) as { success: boolean; code?: string };
}

describe('session lifecycle', () => {
  let server: SnowtestServer;

  beforeAll(async () => {
    server = await createServer({ dataDir: null });
  });

  afterAll(async () => {
    await server.close();
  });

  it('advertises the idle timeout it enforces', async () => {
    const { validityInSeconds } = await login(server);
    expect(SESSION_IDLE_MS).toBe(60 * 60 * 1000);
    expect(validityInSeconds * 1000).toBe(SESSION_IDLE_MS);
  });

  it('rejects a session that has been idle past the timeout, and closes it on the next sweep', async () => {
    const { token } = await login(server);
    const session = server.sessionRegistry.get(token);
    expect(session).toBeDefined();
    expect((await query(server, token, 'select 1')).success).toBe(true);

    // A live statement is what keeps a session alive, so the connection exists now.
    const connection = session!.connection as EngineConnection;
    expect(connection).toBeDefined();

    session!.lastUsedAt = new Date(Date.now() - SESSION_IDLE_MS - 1_000);
    expect(server.sessionRegistry.get(token)).toBeUndefined();
    expect(await query(server, token, 'select 1')).toMatchObject({
      success: false,
      code: '390111',
    });

    // Any login sweeps idle sessions; sweeping is what releases their handles.
    await login(server);
    expect(server.sessionRegistry.all().some((entry) => entry.id === session!.id)).toBe(false);
    expect(session!.connection).toBeNull();
    await expect(connection.execute('select 1')).rejects.toThrow(/Session no longer exists/);
  });

  it('releases the connection when GET /session logs out', async () => {
    const { token } = await login(server);
    expect((await query(server, token, 'select 1')).success).toBe(true);

    const session = server.sessionRegistry.get(token);
    const connection = session!.connection as EngineConnection;
    expect(connection).toBeDefined();

    const logout = await server.app.request('/session', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(logout.status).toBe(200);
    expect(server.sessionRegistry.get(token)).toBeUndefined();
    expect(session!.connection).toBeNull();
    await expect(connection.execute('select 1')).rejects.toThrow(/Session no longer exists/);
  });
});

describe('login allow-list', () => {
  it('refuses a name that SNOWTEST_USERS does not list, and accepts one it does', async () => {
    const server = await createServer({ dataDir: null, users: ['ALICE'] });
    const attempt = async (name: string) => {
      const response = await server.app.request('/session/v1/login-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { LOGIN_NAME: name } }),
      });
      return (await response.json()) as { success: boolean };
    };

    try {
      expect((await attempt('BOB')).success).toBe(false);
      expect((await attempt('alice')).success).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe('request body limit', () => {
  let server: SnowtestServer;
  let running: { port: number; close: () => Promise<void> };
  let url: string;

  beforeAll(async () => {
    server = await createServer({ dataDir: null });
    running = await server.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${running.port}/api/v2/statements`;
  });

  afterAll(async () => {
    await running.close();
    await server.close();
  });

  it('accepts a normal statement over HTTP', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: 'select 1 as n' }),
    });
    expect(response.status).toBe(200);
  });

  it('refuses a body over 32 MiB instead of buffering it', async () => {
    // The cap is checked as bytes arrive, so the payload needs no structure: it is
    // refused before anything tries to parse it as JSON.
    const oversized = Buffer.alloc(32 * 1024 * 1024 + 1024, 0x78);
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: oversized,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('exceeds') });
  }, 60_000);
});
