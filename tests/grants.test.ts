// Copyright (c) 2026 Srinivas Chaturvedula

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

describe('access control statements (in memory)', () => {
  let server: SnowtestServer;
  beforeAll(async () => {
    server = await createServer({ dataDir: null });
  });
  afterAll(async () => {
    await server.close();
  });

  it('accepts GRANT and REVOKE instead of failing on DuckDB grammar', async () => {
    expect((await sql(server, 'GRANT SELECT, INSERT ON TABLE SNOWTEST.PUBLIC.ORDERS TO ROLE SYSADMIN')).status).toBe(200);
    expect((await sql(server, 'GRANT SELECT ON TABLE SNOWTEST.PUBLIC.ORDERS TO ROLE SYSADMIN WITH GRANT OPTION')).status).toBe(200);
    expect((await sql(server, 'GRANT ROLE SYSADMIN TO USER alice')).status).toBe(200);
    expect((await sql(server, 'GRANT USAGE ON DATABASE SNOWTEST TO ROLE SYSADMIN')).status).toBe(200);
    expect((await sql(server, 'REVOKE INSERT ON TABLE SNOWTEST.PUBLIC.ORDERS FROM ROLE SYSADMIN')).status).toBe(200);
    expect((await sql(server, 'REVOKE ROLE SYSADMIN FROM USER alice')).status).toBe(200);
  });

  it('reports what was granted through SHOW GRANTS', async () => {
    const onObject = await rows(server, 'SHOW GRANTS ON TABLE SNOWTEST.PUBLIC.ORDERS');
    expect(onObject.length).toBe(1);
    expect(onObject[0][1], 'privilege').toBe('SELECT');
    expect(onObject[0][2], 'granted_on').toBe('TABLE');
    expect(onObject[0][3], 'name').toBe('SNOWTEST.PUBLIC.ORDERS');
    expect(onObject[0][6], 'grant_option').toBe('TRUE');

    await sql(server, 'GRANT ROLE SYSADMIN TO USER bob');
    const toUser = await rows(server, 'SHOW GRANTS TO USER BOB');
    expect(toUser.length).toBe(1);
    expect(toUser[0][1], 'privilege').toBe('USAGE');
    expect(toUser[0][2], 'granted_on').toBe('ROLE');
    expect(toUser[0][3], 'name').toBe('SYSADMIN');

    const ofRole = await rows(server, 'SHOW GRANTS OF ROLE SYSADMIN');
    expect(ofRole.map((row) => row[2])).toContain('USER');
  });

  it('drops the grants recorded on a dropped table, view or schema', async () => {
    await sql(server, 'create table SNOWTEST.PUBLIC.GRANTED (id number)');
    await sql(server, 'GRANT SELECT ON TABLE SNOWTEST.PUBLIC.GRANTED TO ROLE SYSADMIN');
    expect(await rows(server, 'SHOW GRANTS ON TABLE SNOWTEST.PUBLIC.GRANTED')).toHaveLength(1);

    await sql(server, 'drop table SNOWTEST.PUBLIC.GRANTED');
    expect(await rows(server, 'SHOW GRANTS ON TABLE SNOWTEST.PUBLIC.GRANTED')).toHaveLength(0);

    await sql(server, 'create schema SNOWTEST.PUBLIC.GRANT_SCHEMA');
    await sql(server, 'create table SNOWTEST.PUBLIC.GRANT_SCHEMA.T (id number)');
    await sql(server, 'GRANT SELECT ON TABLE SNOWTEST.PUBLIC.GRANT_SCHEMA.T TO ROLE SYSADMIN');
    await sql(server, 'GRANT USAGE ON SCHEMA SNOWTEST.PUBLIC.GRANT_SCHEMA TO ROLE SYSADMIN');
    await sql(server, 'drop schema SNOWTEST.PUBLIC.GRANT_SCHEMA');

    expect(await rows(server, 'SHOW GRANTS ON TABLE SNOWTEST.PUBLIC.GRANT_SCHEMA.T')).toHaveLength(0);
    expect(await rows(server, 'SHOW GRANTS ON SCHEMA SNOWTEST.PUBLIC.GRANT_SCHEMA')).toHaveLength(0);

    // A two-part name is completed with the database, as the drop will resolve it.
    await sql(server, 'create schema GRANT_TWO');
    await sql(server, 'create table GRANT_TWO.T (id number)');
    await sql(server, 'GRANT SELECT ON TABLE GRANT_TWO.T TO ROLE SYSADMIN');
    expect(await rows(server, 'SHOW GRANTS ON TABLE GRANT_TWO.T')).toHaveLength(1);
    await sql(server, 'drop table GRANT_TWO.T');
    expect(await rows(server, 'SHOW GRANTS ON TABLE GRANT_TWO.T')).toHaveLength(0);
    expect(await rows(server, 'SHOW GRANTS ON TABLE SNOWTEST.GRANT_TWO.T')).toHaveLength(0);
    await sql(server, 'drop schema GRANT_TWO');

    // An unqualified grant is resolved when it is made, so an unqualified drop finds it.
    await sql(server, 'create table UNQUAL (id number)');
    await sql(server, 'GRANT SELECT ON TABLE UNQUAL TO ROLE SYSADMIN');
    expect(await rows(server, 'SHOW GRANTS ON TABLE SNOWTEST.PUBLIC.UNQUAL')).toHaveLength(1);
    expect(await rows(server, 'SHOW GRANTS ON TABLE UNQUAL')).toHaveLength(1);
    await sql(server, 'drop table UNQUAL');
    expect(await rows(server, 'SHOW GRANTS ON TABLE UNQUAL')).toHaveLength(0);
    expect(await rows(server, 'SHOW GRANTS ON TABLE SNOWTEST.PUBLIC.UNQUAL')).toHaveLength(0);
  });

  it('refuses a grant to a role that does not exist', async () => {
    const result = await sql(server, 'GRANT SELECT ON TABLE t TO ROLE NO_SUCH_ROLE');
    expect(result.status).not.toBe(200);
    expect(result.body.message).toMatch(/NO_SUCH_ROLE/);
  });
});

describe('FLATTEN (in memory)', () => {
  let server: SnowtestServer;
  beforeAll(async () => {
    server = await createServer({ dataDir: null });
    await sql(server, 'create or replace table docs (id number, body variant)');
    await sql(server, "insert into docs values (1, parse_json('{\"x\":1,\"y\":2}')), (2, parse_json('[10,20]'))");
  });
  afterAll(async () => {
    await server.close();
  });

  it('flattens an object into one row per member', async () => {
    const result = await rows(
      server,
      'select f.key, f.value from docs, lateral flatten(input => docs.body) f where docs.id = 1 order by f.key',
    );
    expect(result.map((row) => row[0])).toEqual(['x', 'y']);
    expect(result.map((row) => row[1])).toEqual(['1', '2']);
  });

  it('reports INDEX for array elements and null KEY', async () => {
    const result = await rows(
      server,
      'select f.key, f.index, f.value from docs, lateral flatten(input => docs.body) f where docs.id = 2 order by f.index',
    );
    expect(result.map((row) => row[0])).toEqual([null, null]);
    expect(result.map((row) => row[1])).toEqual(['0', '1']);
  });

  it('flattens a nested array reached through a variant path', async () => {
    await sql(server, "create or replace table nested (id number, body variant)");
    await sql(server, "insert into nested values (1, parse_json('{\"items\":[5,6]}'))");
    const result = await rows(
      server,
      'select f.value::number from nested, lateral flatten(input => nested.body:items) f order by 1',
    );
    expect(result).toEqual([['5'], ['6']]);
  });
});
