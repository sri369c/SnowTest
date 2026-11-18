// Copyright (c) 2026 Srinivas Chaturvedula

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Clock } from '../src/config/config.js';
import { splitStatements, StatementRouter } from '../src/sql/meta.js';
import { createServer, type SnowtestServer } from '../src/server.js';
import { Session, type SessionOptions } from '../src/engine/session.js';

describe('transactions, scripts and the emulated clock', () => {
  let server: SnowtestServer;
  let router: StatementRouter;
  let nextId = 1;

  const newSession = (overrides: Partial<SessionOptions> = {}): Session =>
    new Session(
      {
        id: nextId++,
        user: 'T',
        role: 'SYSADMIN',
        database: 'SNOWTEST',
        schema: 'PUBLIC',
        warehouse: 'SNOWTEST_WH',
        ...overrides,
      },
      server.catalog,
    );

  const count = async (session: Session, table = 'tx'): Promise<number> =>
    Number((await router.execute(`select count(*) from ${table}`, session)).rows[0][0]);

  const value = async (session: Session, statement: string): Promise<unknown> =>
    (await router.execute(statement, session)).rows[0][0];

  const asIso = (raw: unknown): string => (raw instanceof Date ? raw.toISOString() : String(raw));

  beforeAll(async () => {
    server = await createServer({ dataDir: null });
    router = new StatementRouter(server.engine, server.catalog);
  });

  afterAll(async () => {
    await server.close();
  });

  it('discards what a rolled-back transaction wrote', async () => {
    const session = newSession();
    await router.execute('create or replace table tx (n int not null)', session);
    await router.execute('begin', session);
    await router.execute('insert into tx values (1), (2)', session);
    // Inside the transaction the session sees its own uncommitted rows.
    expect(await count(session)).toBe(2);
    await router.execute('rollback', session);
    expect(await count(session)).toBe(0);
  });

  it('keeps what a committed transaction wrote', async () => {
    const session = newSession();
    await router.execute('create or replace table tx (n int not null)', session);
    await router.execute('begin transaction', session);
    await router.execute('insert into tx values (7)', session);
    await router.execute('commit', session);
    expect(await count(session)).toBe(1);
    expect(await value(session, 'select n from tx')).toBe(7);
  });

  it('hides an open transaction from every other session', async () => {
    const writer = newSession();
    const reader = newSession();
    await router.execute('create or replace table tx (n int not null)', writer);
    await router.execute('begin', writer);
    await router.execute('insert into tx values (1)', writer);
    expect(await count(reader)).toBe(0);
    await router.execute('rollback', writer);
    expect(await count(reader)).toBe(0);
  });

  it('aborts the transaction when a statement inside it fails', async () => {
    const session = newSession();
    await router.execute('create or replace table tx (n int not null)', session);
    await router.execute('begin', session);
    await router.execute('insert into tx values (1)', session);
    await expect(router.execute("insert into tx values ('not a number')", session)).rejects.toThrow();
    // Snowflake makes the client roll back; so does DuckDB, and the message says so.
    await expect(router.execute('select 1', session)).rejects.toThrow(/abort|rollback/i);
    await router.execute('rollback', session);
    expect(await count(session)).toBe(0);
    // The session is usable again once it has rolled back.
    expect(await value(session, 'select 1')).toBe(1);
  });

  it('runs a typed CTAS inside the client transaction and rolls it back with it', async () => {
    const session = newSession();
    await router.execute('begin', session);
    await router.execute('create table tx2 (n int not null) as select 1 as n', session);
    // The admin connection cannot see it, so this only passes if existence checks
    // read the session's own connection while a transaction is open.
    expect(await count(session, 'tx2')).toBe(1);
    await router.execute('rollback', session);
    await expect(router.execute('select * from tx2', session)).rejects.toThrow(/does not exist/i);
  });

  it('treats COMMIT and ROLLBACK with nothing open as no-ops', async () => {
    const session = newSession();
    await expect(router.execute('commit', session)).resolves.toBeDefined();
    await expect(router.execute('rollback', session)).resolves.toBeDefined();
  });

  it('routes every statement in a script, not just the first', async () => {
    const session = newSession();
    const outcomes = await router.executeMany(
      'create or replace table m1 (n int not null); insert into m1 values (1), (2); select count(*) from m1',
      session,
    );
    expect(outcomes).toHaveLength(3);
    expect(Number(outcomes[2].rows[0][0])).toBe(2);
  });

  it('runs BEGIN … COMMIT across one script', async () => {
    const session = newSession();
    await router.execute('create or replace table tx (n int not null)', session);
    await router.executeMany('begin; insert into tx values (1); commit', session);
    expect(await count(session)).toBe(1);
    await router.executeMany('begin; insert into tx values (2); rollback', session);
    expect(await count(session)).toBe(1);
  });

  it('honours MULTI_STATEMENT_COUNT only when the client set it', async () => {
    const session = newSession();
    await expect(router.executeMany('select 1; select 2', session)).resolves.toHaveLength(2);

    session.setParameter('MULTI_STATEMENT_COUNT', '3');
    await expect(router.executeMany('select 1; select 2', session)).rejects.toThrow(/MULTI_STATEMENT_COUNT/);

    session.setParameter('MULTI_STATEMENT_COUNT', '2');
    await expect(router.executeMany('select 1; select 2', session)).resolves.toHaveLength(2);

    session.setParameter('MULTI_STATEMENT_COUNT', '0');
    await expect(router.executeMany('select 1; select 2; select 3', session)).resolves.toHaveLength(3);
  });

  it('answers the SQL API with one result per statement', async () => {
    const response = await server.app.request('/api/v2/statements', {
      method: 'POST',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: 'select 1 as a; select 2 as b' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data?: unknown[]; resultSetMetaData?: unknown };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(2);
    // The flat, single-result shape is what one statement still returns.
    expect(body.resultSetMetaData).toBeUndefined();
  });

  it('splits a script without breaking literals, comments or quoted names', () => {
    expect(splitStatements('select 1; select 2')).toEqual(['select 1', 'select 2']);
    expect(splitStatements("select 'a;b' as v; select 2")).toEqual(["select 'a;b' as v", 'select 2']);
    expect(splitStatements('select 1 -- a; comment\n; select 2')).toEqual([
      'select 1 -- a; comment',
      'select 2',
    ]);
    expect(splitStatements('select /* a; b */ 1; select 2')).toEqual(['select /* a; b */ 1', 'select 2']);
    expect(splitStatements('select "we;ird" from t; select 2')).toEqual([
      'select "we;ird" from t',
      'select 2',
    ]);
    expect(splitStatements('select $$a;b$$ as v; select 2')).toEqual(['select $$a;b$$ as v', 'select 2']);
    expect(splitStatements('  ;  ; select 1 ;  ')).toEqual(['select 1']);
    expect(splitStatements('')).toEqual([]);
  });

  it('copies a table with CLONE and keeps the copy independent', async () => {
    const session = newSession();
    await router.execute('create or replace table src (n int not null)', session);
    await router.execute('insert into src values (1), (2)', session);

    await router.execute('create table cl clone src', session);
    expect(await count(session, 'cl')).toBe(2);
    expect(Number(await value(session, 'select count(*) from cl where n is null'))).toBe(0);

    await router.execute('insert into src values (3)', session);
    expect(await count(session, 'cl')).toBe(2);

    await expect(router.execute('create table cl clone src', session)).rejects.toThrow(/already exists/i);
    await router.execute('create or replace table cl clone src', session);
    expect(await count(session, 'cl')).toBe(3);
  });

  it('refuses the clones it cannot emulate instead of pretending', async () => {
    const session = newSession();
    await router.execute('create or replace table src (n int not null)', session);
    await expect(
      router.execute("create table cl2 clone src at (timestamp => '2026-01-01')", session),
    ).rejects.toThrow(/CLONE/);
    await expect(router.execute('create database CLONEDB clone SNOWTEST', session)).rejects.toThrow(
      /CLONE/,
    );
    expect(server.catalog.getDatabase('CLONEDB')).toBeUndefined();
  });

  it('freezes the clock for every way of asking the time', async () => {
    const clock: Clock = { kind: 'fixed', at: new Date('2026-01-31T09:00:00Z') };
    const session = newSession({ clock });
    expect(asIso(await value(session, 'select current_timestamp()'))).toBe('2026-01-31T09:00:00.000Z');
    expect(asIso(await value(session, 'select current_date'))).toBe('2026-01-31T00:00:00.000Z');
    expect(asIso(await value(session, 'select sysdate()'))).toBe('2026-01-31T09:00:00.000Z');
    expect(asIso(await value(session, 'select getdate()'))).toBe('2026-01-31T09:00:00.000Z');
    // A frozen clock does not move between statements.
    expect(asIso(await value(session, 'select current_timestamp'))).toBe('2026-01-31T09:00:00.000Z');
  });

  it('shifts the clock with an offset and leaves the host clock alone otherwise', async () => {
    const shifted = newSession({ clock: { kind: 'offset', ms: 3_600_000 } });
    const reported = new Date(String(await value(shifted, 'select current_timestamp()'))).getTime();
    expect(Math.abs(reported - (Date.now() + 3_600_000))).toBeLessThan(60_000);

    const plain = newSession();
    const now = new Date(String(await value(plain, 'select current_timestamp()'))).getTime();
    expect(Math.abs(now - Date.now())).toBeLessThan(60_000);
  });
});
