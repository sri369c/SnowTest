// Copyright (c) 2026 Srinivas Chaturvedula

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { rewrite } from '../src/sql/dialect.js';
import { createServer, type SnowtestServer } from '../src/server.js';

interface ApiResult {
  status: number;
  body: { data?: unknown[][]; message?: string };
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

const ctx = {
  database: 'SNOWTEST',
  schema: 'PUBLIC',
  role: 'SYSADMIN',
  user: 'TEST',
  warehouse: 'SNOWTEST_WH',
};

describe('sequence translation', () => {
  const run = (statement: string, context = ctx) => rewrite(statement, context, []);

  it('turns the dotted form into nextval/currval with a resolved name', () => {
    // The folding pass that runs afterwards upper-cases the call itself.
    expect(run('SELECT SEQ.NEXTVAL').toLowerCase()).toContain("nextval('snowtest.public.seq')");
    expect(run('SELECT SEQ.CURRVAL').toLowerCase()).toContain("currval('snowtest.public.seq')");
    expect(run('SELECT DB1.SCH.SEQ.NEXTVAL').toLowerCase()).toContain("nextval('db1.sch.seq')");
    expect(run('SELECT SCH.SEQ.NEXTVAL').toLowerCase()).toContain("nextval('snowtest.sch.seq')");
  });

  it('turns NEXT VALUE FOR into nextval', () => {
    expect(run('INSERT INTO T VALUES (NEXT VALUE FOR SEQ)').toLowerCase()).toContain(
      "nextval('snowtest.public.seq')",
    );
  });

  it('does not touch a column called NEXTVAL', () => {
    expect(run('SELECT NEXT_VAL FROM T')).toContain('NEXT_VAL');
  });
});

describe('sequences (in memory)', () => {
  let server: SnowtestServer;
  beforeAll(async () => {
    server = await createServer({ dataDir: null });
  });
  afterAll(async () => {
    await server.close();
  });

  it('creates one, ORDER and all, and hands out values', async () => {
    const created = await sql(
      server,
      'CREATE SEQUENCE SNOWTEST.PUBLIC.S_ORD START WITH 5 INCREMENT BY 2 ORDER',
    );
    expect(created.status, created.body.message).toBe(200);

    expect(await rows(server, 'SELECT SNOWTEST.PUBLIC.S_ORD.NEXTVAL')).toEqual([['5']]);
    expect(await rows(server, 'SELECT NEXT VALUE FOR SNOWTEST.PUBLIC.S_ORD')).toEqual([['7']]);
    expect(await rows(server, 'SELECT SNOWTEST.PUBLIC.S_ORD.CURRVAL')).toEqual([['7']]);
  });

  it('lists and describes it', async () => {
    const listed = await rows(server, 'SHOW SEQUENCES');
    const row = listed.find((entry) => entry[1] === 'S_ORD');
    expect(row?.[4], 'next_value').toBe('9');
    expect(row?.[5], 'interval').toBe('2');
    expect(row?.[8], 'ordered').toBe('YES');

    const described = await rows(server, 'DESCRIBE SEQUENCE SNOWTEST.PUBLIC.S_ORD');
    expect(described).toHaveLength(1);
    expect(described[0][1], 'name').toBe('S_ORD');
    expect(described[0][2], 'next_value').toBe('9');
    expect(described[0][3], 'interval').toBe('2');
  });

  it('supports a descending sequence', async () => {
    expect(
      (await sql(server, 'CREATE SEQUENCE SNOWTEST.PUBLIC.S_DESC START 10 INCREMENT BY -2')).status,
    ).toBe(200);
    expect(await rows(server, 'SELECT SNOWTEST.PUBLIC.S_DESC.NEXTVAL')).toEqual([['10']]);
    expect(await rows(server, 'SELECT SNOWTEST.PUBLIC.S_DESC.NEXTVAL')).toEqual([['8']]);
  });

  it('refuses an option it cannot honour instead of dropping it', async () => {
    const refused = await sql(server, 'CREATE SEQUENCE SNOWTEST.PUBLIC.S_BAD START 1 WITH CACHE 10');
    expect(refused.status).not.toBe(200);
    expect(refused.body.message).toContain('CACHE');
  });

  it('restarts at a value, and a bare RESTART returns to the start value', async () => {
    expect(
      (await sql(server, 'CREATE SEQUENCE SNOWTEST.PUBLIC.S_RESTART START WITH 1 INCREMENT BY 3')).status,
    ).toBe(200);
    expect(await rows(server, 'SELECT SNOWTEST.PUBLIC.S_RESTART.NEXTVAL')).toEqual([['1']]);

    expect((await sql(server, 'ALTER SEQUENCE SNOWTEST.PUBLIC.S_RESTART RESTART WITH 50')).status).toBe(200);
    expect(await rows(server, 'SELECT SNOWTEST.PUBLIC.S_RESTART.NEXTVAL')).toEqual([['50']]);

    expect((await sql(server, 'ALTER SEQUENCE SNOWTEST.PUBLIC.S_RESTART RESTART')).status).toBe(200);
    expect(await rows(server, 'SELECT SNOWTEST.PUBLIC.S_RESTART.NEXTVAL')).toEqual([['1']]);
    expect(await rows(server, 'DESCRIBE SEQUENCE SNOWTEST.PUBLIC.S_RESTART')).toHaveLength(1);
  });

  it('changes the increment without losing the value it would hand out next', async () => {
    expect(
      (await sql(server, 'CREATE SEQUENCE SNOWTEST.PUBLIC.S_STEP START WITH 10 INCREMENT BY 1')).status,
    ).toBe(200);
    expect(await rows(server, 'SELECT SNOWTEST.PUBLIC.S_STEP.NEXTVAL')).toEqual([['10']]);

    expect((await sql(server, 'ALTER SEQUENCE SNOWTEST.PUBLIC.S_STEP SET INCREMENT BY 5')).status).toBe(200);
    expect(await rows(server, 'SELECT SNOWTEST.PUBLIC.S_STEP.NEXTVAL')).toEqual([['11']]);
    expect(await rows(server, 'SELECT SNOWTEST.PUBLIC.S_STEP.NEXTVAL')).toEqual([['16']]);
  });

  it('reports a created_on that does not move', async () => {
    expect((await sql(server, 'CREATE SEQUENCE SNOWTEST.PUBLIC.S_WHEN START 1')).status).toBe(200);

    const first = (await rows(server, 'SHOW SEQUENCES')).find((row) => row[1] === 'S_WHEN')?.[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = (await rows(server, 'SHOW SEQUENCES')).find((row) => row[1] === 'S_WHEN')?.[0];
    expect(second).toBe(first);

    const described = await rows(server, 'DESCRIBE SEQUENCE SNOWTEST.PUBLIC.S_WHEN');
    expect(described[0][0]).toBe(first);
  });

  it('refuses an ALTER it cannot honour, and honours IF EXISTS', async () => {
    const refused = await sql(server, 'ALTER SEQUENCE SNOWTEST.PUBLIC.S_STEP SET CACHE 10');
    expect(refused.status).not.toBe(200);

    const missing = await sql(server, 'ALTER SEQUENCE SNOWTEST.PUBLIC.NOPE RESTART');
    expect(missing.status).toBe(422);

    expect((await sql(server, 'ALTER SEQUENCE IF EXISTS SNOWTEST.PUBLIC.NOPE RESTART')).status).toBe(200);
  });

  it('drops one, and then cannot describe it', async () => {
    expect((await sql(server, 'DROP SEQUENCE SNOWTEST.PUBLIC.S_ORD')).status).toBe(200);
    const listed = await rows(server, 'SHOW SEQUENCES');
    expect(listed.some((entry) => entry[1] === 'S_ORD')).toBe(false);

    const missing = await sql(server, 'DESCRIBE SEQUENCE SNOWTEST.PUBLIC.S_ORD');
    expect(missing.status).toBe(422);
    expect(missing.body.message).toContain("Object 'SNOWTEST.PUBLIC.S_ORD'");
  });
});
