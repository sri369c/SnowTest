// Copyright (c) 2026 Srinivas Chaturvedula

import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SnowflakeError } from '../src/errors.js';
import { failAfter, StatementRouter } from '../src/meta.js';
import { createServer, type SnowtestServer } from '../src/server.js';
import { Session } from '../src/session.js';
import { toApiV2Rowset, toDriverRowset, type SnowflakeColumn } from '../src/types.js';

interface ApiResult {
  status: number;
  body: {
    data?: unknown[][];
    message?: string;
    sqlState?: string;
    resultSetMetaData?: { rowType: Array<{ name: string }> };
  };
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

async function failure(server: SnowtestServer, statement: string): Promise<string> {
  const result = await sql(server, statement);
  expect(result.status, statement).not.toBe(200);
  return result.body.message ?? '';
}

describe('engine behaviour (in memory)', () => {
  let server: SnowtestServer;
  beforeAll(async () => {
    server = await createServer({ dataDir: null });
  });
  afterAll(async () => {
    await server?.close();
  });

  it('redirects the old /usage page to /configuration', async () => {
    const response = await server.app.request('/usage');
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/configuration');
  });

  it('runs the CURRENT_* call forms dbt emits', async () => {
    const [row] = await rows(
      server,
      "select to_timestamp_ntz(convert_timezone('UTC', current_timestamp())), current_date(), current_time(), sysdate(), localtimestamp(), current_timestamp(3)",
    );
    expect(row.every((value) => value !== null)).toBe(true);
  });

  it('accepts clustering changes on an existing table only', async () => {
    await rows(server, 'create or replace table clustered (a int, b date)');
    for (const statement of [
      'alter table clustered cluster by (a, to_date(b))',
      'alter table clustered drop clustering key',
      'alter table clustered suspend recluster',
      'alter table clustered resume recluster',
      'alter table if exists no_such_table cluster by (a)',
    ]) {
      expect((await sql(server, statement)).status, statement).toBe(200);
    }
    expect(await failure(server, 'alter table no_such_table cluster by (a)')).toMatch(/does not exist/);
    expect(await rows(server, 'create or replace table c2 cluster by (date_trunc(\'day\', ts)) as select 1 as ts')).toBeDefined();
  });

  it('creates a contract table and enforces NOT NULL atomically', async () => {
    await rows(
      server,
      `create or replace transient table contracted (id integer not null primary key, name varchar)
       as (select 1 as id, 'a' as name union all select 1, 'b')`,
    );
    expect(await rows(server, 'select count(*) from contracted')).toEqual([['2']]);
    const described = await rows(server, 'describe table contracted');
    expect(described.map((row) => [row[0], row[3]])).toEqual([
      ['ID', 'N'],
      ['NAME', 'Y'],
    ]);

    const message = await failure(
      server,
      `create or replace table contracted (id integer not null, name varchar)
       as (select null as id, 'x' as name)`,
    );
    expect(message).toMatch(/NULL result in a non-nullable column/);
    expect(await rows(server, 'select count(*) from contracted')).toEqual([['2']]);
  });

  it('reports column names the way Snowflake folds them', async () => {
    await rows(server, 'create or replace table cased (a int, "Mixed" int)');
    await rows(server, 'insert into cased values (1, 2)');
    expect((await sql(server, 'select a from cased')).body.resultSetMetaData?.rowType[0].name).toBe('A');
    expect((await sql(server, 'select a as "x" from cased')).body.resultSetMetaData?.rowType[0].name).toBe('x');
    expect((await rows(server, 'describe table cased')).map((row) => row[0])).toEqual(['A', 'Mixed']);
    expect((await rows(server, 'show columns in table cased')).map((row) => row[2])).toEqual(['A', 'Mixed']);
    expect(
      await rows(
        server,
        "select column_name from information_schema.columns where table_name = 'CASED' order by ordinal_position",
      ),
    ).toEqual([['A'], ['Mixed']]);
  });

  it('lists databases in information_schema.databases', async () => {
    await rows(server, 'create database if not exists INFO_DB');
    await rows(server, 'use database SNOWTEST');
    const names = (await rows(server, 'SELECT DATABASE_NAME from information_schema.databases')).map((row) => row[0]);
    expect(names).toEqual(expect.arrayContaining(['SNOWTEST', 'INFO_DB']));
    const result = await sql(server, 'select * from snowtest.information_schema.databases where database_name = \'INFO_DB\'');
    expect(result.body.resultSetMetaData?.rowType.map((column) => column.name)).toEqual([
      'DATABASE_NAME', 'DATABASE_OWNER', 'IS_TRANSIENT', 'COMMENT', 'CREATED', 'LAST_ALTERED', 'RETENTION_TIME', 'TYPE',
    ]);
    expect(result.body.data?.[0]?.slice(0, 3)).toEqual(['INFO_DB', 'SYSADMIN', 'NO']);
  });

  it('renames within and across schemas, and swaps', async () => {
    await rows(server, 'create schema if not exists OTHER');
    await rows(server, 'create or replace table r1 (n int not null)');
    await rows(server, 'insert into r1 values (1)');
    await rows(server, 'alter table r1 rename to r2');
    expect(await rows(server, 'select n from r2')).toEqual([['1']]);

    await rows(server, 'alter table SNOWTEST.PUBLIC.r2 rename to SNOWTEST.OTHER.r3');
    expect(await rows(server, 'select n from SNOWTEST.OTHER.r3')).toEqual([['1']]);
    expect(await failure(server, 'select n from r2')).toMatch(/does not exist/);
    expect((await rows(server, 'describe table SNOWTEST.OTHER.r3'))[0][3]).toBe('N');

    await rows(server, 'create or replace table s1 as select 1 as v');
    await rows(server, 'create or replace table s2 as select 2 as v');
    await rows(server, 'alter table s1 swap with s2');
    expect(await rows(server, 'select v from s1')).toEqual([['2']]);
    expect(await rows(server, 'select v from s2')).toEqual([['1']]);

    await rows(server, 'alter table s1 swap with SNOWTEST.OTHER.r3');
    expect(await rows(server, 'select n from s1')).toEqual([['1']]);
    expect(await rows(server, 'select v from SNOWTEST.OTHER.r3')).toEqual([['2']]);

    expect(await failure(server, 'alter table s1 rename to s2')).toMatch(/already exists/);
    expect(await failure(server, 'alter table missing_table swap with s2')).toMatch(/does not exist/);
  });

  it('emulates conversions instead of approximating them', async () => {
    const [row] = await rows(
      server,
      `select try_to_number('abc'), try_to_date('2024-13-45'), try_to_timestamp('nope'), try_to_decimal('1.25', 10, 1),
              '1.5'::number, cast('2.5' as decimal), to_number('7.6')`,
    );
    expect(row).toEqual([null, null, null, '1.3', '2', '3', '8']);

    expect(
      await rows(
        server,
        "select listagg(x, ',') within group (order by x desc) from (values ('a'), ('c'), ('b')) v(x)",
      ),
    ).toEqual([['c,b,a']]);
    expect(await rows(server, "select decode(null, null, 'null matched', 'no')")).toEqual([['null matched']]);
    expect(
      await rows(
        server,
        "select to_varchar('2024-03-05 07:08:09.123'::timestamp, 'DD MON YYYY HH24:MI:SS.FF3'), to_date('05/03/2024', 'DD/MM/YYYY')",
      ),
    ).toEqual([['05 Mar 2024 07:08:09.123', '2024-03-05']]);
    expect(await failure(server, "select to_varchar(current_date, 'YYYY-Q')")).toMatch(/not supported on snowtest/);
    expect(await failure(server, 'alter schema PUBLIC rename to P2')).toMatch(/ALTER SCHEMA \.\.\. RENAME TO is not supported on snowtest/);
    expect(await failure(server, 'alter schema PUBLIC swap with OTHER')).toMatch(/ALTER SCHEMA \.\.\. SWAP WITH is not supported on snowtest/);
    await rows(server, "alter schema PUBLIC set comment = 'rename to x'");
  });

  it('renames across databases with a verified copy; refuses a cross-database swap', async () => {
    await rows(server, 'create database if not exists XDB');
    await rows(server, 'create or replace table SNOWTEST.PUBLIC.x1 (n int not null)');
    await rows(server, 'insert into SNOWTEST.PUBLIC.x1 values (1), (2)');
    await rows(server, 'alter table SNOWTEST.PUBLIC.x1 rename to XDB.PUBLIC.x1');
    expect(await rows(server, 'select n from XDB.PUBLIC.x1 order by n')).toEqual([['1'], ['2']]);
    expect((await rows(server, 'describe table XDB.PUBLIC.x1'))[0][3]).toBe('N');
    expect(await failure(server, 'select n from SNOWTEST.PUBLIC.x1')).toMatch(/does not exist/);

    await rows(server, 'create or replace table SNOWTEST.PUBLIC.x2 (n int)');
    expect(await failure(server, 'alter table SNOWTEST.PUBLIC.x2 swap with XDB.PUBLIC.x1')).toMatch(
      /SWAP WITH a table in another database is not supported on snowtest/,
    );
    expect(await rows(server, 'select count(*) from XDB.PUBLIC.x1')).toEqual([['2']]);
  });

  it('reads the old table when CREATE OR REPLACE (cols) AS SELECT references itself', async () => {
    await rows(server, 'create or replace table selfref (n int) as select 1 as n union all select 2');
    await rows(server, 'create or replace table selfref (n int not null) as select n + 10 from selfref');
    expect(await rows(server, 'select n from selfref order by n')).toEqual([['11'], ['12']]);
  });

  it('keeps quoted and keyword-named columns, escapes and ARRAY_AGG semantics', async () => {
    await rows(server, 'create or replace table kw (number number, decimal int, numeric int, string string, binary int, variant varchar)');
    await rows(server, "insert into kw values (1, 2, 3, 's', 4, 'a')");
    expect(await rows(server, 'select number, decimal, numeric, string, binary, variant, "NUMBER" from kw')).toEqual([
      ['1', '2', '3', 's', '4', 'a', '1'],
    ]);
    expect(await rows(server, String.raw`select 'it\'s' as a, 'C:\\x' as b -- trailing`)).toEqual([["it's", 'C:\\x']]);
    expect(await rows(server, 'select array_agg(x) within group (order by x) from (values (2), (null), (1)) v(x)')).toEqual([
      ['[1,2]'],
    ]);
    expect(await rows(server, 'select array_agg(x) from (values (1)) v(x) where false')).toEqual([['[]']]);
  });

  it('drops schemas CASCADE by default, honours RESTRICT, and errors on missing objects', async () => {
    await rows(server, 'create schema if not exists DS1');
    await rows(server, 'create table DS1.T (n int)');
    await rows(server, 'create schema if not exists DS2');
    await rows(server, 'create table DS2.T (n int)');
    expect(await failure(server, 'drop schema DS2 restrict')).toMatch(/depend on it/);
    expect(server.catalog.getSchema('SNOWTEST', 'DS2')).toBeDefined();
    await rows(server, 'drop schema DS1');
    expect(server.catalog.getSchema('SNOWTEST', 'DS1')).toBeUndefined();
    expect(await failure(server, 'drop schema DS1')).toMatch(/does not exist/);
    expect(await rows(server, 'drop schema if exists DS1')).toEqual([['Drop statement executed successfully (DS1 already dropped).']]);
    expect(await failure(server, 'drop database NO_SUCH_DB')).toMatch(/does not exist/);
    await rows(server, 'drop database if exists NO_SUCH_DB');
  });

  it('leaves the session with no current database after dropping it', async () => {
    const session = new Session(
      { id: 9001, user: 'T', role: 'SYSADMIN', database: 'SNOWTEST', schema: 'PUBLIC', warehouse: 'SNOWTEST_WH' },
      server.catalog,
    );
    const router = new StatementRouter(server.engine, server.catalog);
    await router.execute('create database DROPME', session);
    await router.execute('use database DROPME', session);
    await router.execute('drop database DROPME', session);
    expect([session.database, session.schema]).toEqual([null, null]);
    expect((await router.execute('select current_database(), current_schema()', session)).rows).toEqual([[null, null]]);
    for (const statement of [
      'create table t (a int)',
      'create table if not exists t (a int)',
      'drop table if exists t',
      'select * from t',
    ]) {
      await expect(router.execute(statement, session), statement).rejects.toMatchObject({ code: '090105' });
    }
    await router.execute('use database SNOWTEST', session);
    expect([session.database, session.schema]).toEqual(['SNOWTEST', 'PUBLIC']);
  });

  it('refuses unqualified objects in a database without a current schema', async () => {
    const session = new Session(
      { id: 9002, user: 'T', role: 'SYSADMIN', database: 'SNOWTEST', schema: 'PUBLIC', warehouse: 'SNOWTEST_WH' },
      server.catalog,
    );
    const router = new StatementRouter(server.engine, server.catalog);
    await router.execute('create database NOSCHEMA', session);
    await router.execute('drop schema NOSCHEMA.PUBLIC', session);
    await router.execute('use database NOSCHEMA', session);
    expect([session.database, session.schema]).toEqual(['NOSCHEMA', null]);
    for (const statement of [
      'create table if not exists t (a int)',
      'drop table if exists t',
      'select * from t',
    ]) {
      await expect(router.execute(statement, session), statement).rejects.toMatchObject({ code: '090106' });
    }
    expect(await server.engine.listTables('NOSCHEMA', 'main')).toEqual([]);
    await router.execute('drop database NOSCHEMA', session);
  });

  it('fails USE SCHEMA on a missing schema without creating it', async () => {
    const session = new Session(
      { id: 9003, user: 'T', role: 'SYSADMIN', database: 'SNOWTEST', schema: 'PUBLIC', warehouse: 'SNOWTEST_WH' },
      server.catalog,
    );
    const router = new StatementRouter(server.engine, server.catalog);
    await expect(router.execute('use schema NO_SUCH_SCHEMA', session)).rejects.toMatchObject({ code: '002043' });
    expect(server.catalog.getSchema('SNOWTEST', 'NO_SUCH_SCHEMA')).toBeUndefined();
    expect([session.database, session.schema]).toEqual(['SNOWTEST', 'PUBLIC']);
  });

  it('fails USE DATABASE on a missing database with 002043', async () => {
    const session = new Session(
      { id: 9004, user: 'T', role: 'SYSADMIN', database: 'SNOWTEST', schema: 'PUBLIC', warehouse: 'SNOWTEST_WH' },
      server.catalog,
    );
    const router = new StatementRouter(server.engine, server.catalog);
    for (const statement of ['use database NOPE_DB', 'use NOPE_DB', 'use schema NOPE_SCHEMA']) {
      await expect(router.execute(statement, session), statement).rejects.toMatchObject({
        code: '002043',
        sqlState: '02000',
        message: 'SQL compilation error:\nObject does not exist, or operation cannot be performed.',
      });
    }
    expect(server.catalog.getDatabase('NOPE_DB')).toBeUndefined();
    expect([session.database, session.schema]).toEqual(['SNOWTEST', 'PUBLIC']);
  });

  it('reports DROP SCHEMA RESTRICT on a non-empty schema as a compilation error', async () => {
    const session = new Session(
      { id: 9005, user: 'T', role: 'SYSADMIN', database: 'SNOWTEST', schema: 'PUBLIC', warehouse: 'SNOWTEST_WH' },
      server.catalog,
    );
    const router = new StatementRouter(server.engine, server.catalog);
    await router.execute('create schema RS1', session);
    await router.execute('create table RS1.T (n int)', session);
    await expect(router.execute('drop schema RS1 restrict', session)).rejects.toMatchObject({
      code: '002003',
      sqlState: '2BP01',
      message: expect.stringMatching(/^SQL compilation error:\nCannot drop entry .*depend on it/s),
    });
    await router.execute('drop schema RS1 cascade', session);
  });

  it('scopes SHOW STAGES like SHOW TABLES', async () => {
    const session = new Session(
      { id: 9006, user: 'T', role: 'SYSADMIN', database: 'SNOWTEST', schema: 'PUBLIC', warehouse: 'SNOWTEST_WH' },
      server.catalog,
    );
    const router = new StatementRouter(server.engine, server.catalog);
    for (const statement of [
      'create database QS_A',
      'create schema QS_A.S2',
      'create database QS_B',
      'create stage QS_A.PUBLIC.QS_A1',
      'create stage QS_A.S2.QS_A2',
      'create stage QS_B.PUBLIC.QS_B1',
      'use database QS_A',
    ]) {
      await router.execute(statement, session);
    }
    const names = async (statement: string) =>
      (await router.execute(statement, session)).rows.map((row) => row[1]).sort();
    expect(await names('show stages')).toEqual(['QS_A1']);
    expect(await names('show stages in schema')).toEqual(['QS_A1']);
    expect(await names('show stages in database')).toEqual(['QS_A1', 'QS_A2']);
    expect(await names('show stages in database QS_B')).toEqual(['QS_B1']);
    expect(await names('show stages in schema QS_A.S2')).toEqual(['QS_A2']);
    expect(await names('show stages in QS_A.S2')).toEqual(['QS_A2']);
    expect(await names("show stages like 'qs_a%' in account")).toEqual(['QS_A1', 'QS_A2']);
    expect(await names("show stages like 'QS_B%' in database QS_A")).toEqual([]);
    await expect(router.execute('show stages in database NOPE_DB', session)).rejects.toMatchObject({ code: '002003' });
    await expect(router.execute('show stages in schema QS_A.NOPE', session)).rejects.toMatchObject({ code: '002003' });
    await router.execute('drop database QS_A', session);
    await router.execute('drop database QS_B', session);
  });

  it('returns TIME as seconds since midnight from every cast source', async () => {
    expect(
      await rows(
        server,
        "select '14:05:06.123456'::time, cast('2024-01-02 03:04:05.5+00:00'::timestamp_tz as time), " +
          "'2024-01-02 03:04:05'::timestamp_ntz::time, try_cast('25:00:00' as time)",
      ),
    ).toEqual([['50706.123456000', '11045.500000000', '11045.000000000', null]]);
    for (const statement of ['select current_time()', 'select current_time', 'select localtime()', 'select current_timestamp()::time']) {
      expect((await rows(server, statement))[0][0], statement).toMatch(/^\d{1,5}\.\d{6}000$/);
    }
    expect(await failure(server, "select '25:00:00'::time")).toMatch(/not recognized/);
    expect(await failure(server, "select '24:00:00'::time")).toMatch(/not recognized/);
    expect(await failure(server, "select cast('24:00:00' as time(3))")).toMatch(/not recognized/);
    expect(await rows(server, "select try_cast('24:00:00' as time), try_cast(null as time), '23:59:59.5'::time(3)")).toEqual([
      [null, null, '86399.500000000'],
    ]);
    await rows(server, 'create or replace table times (t time(9))');
    expect(await failure(server, "insert into times values ('24:00:00')")).toMatch(/out of range/);
    await rows(server, "insert into times values ('23:59:59.999999'), (null)");
    expect(await rows(server, 'select t from times order by t')).toEqual([['86399.999999000'], [null]]);
    await rows(server, 'alter table times add column u time(9)');
    expect((await rows(server, 'describe table times')).map((row) => row[1])).toEqual(['TIME(9)', 'TIME(9)']);
  });

  it('truncates TIME and timestamp casts and columns to the declared precision', async () => {
    expect(
      await rows(
        server,
        "select '01:02:03.123456'::time(3), '01:02:03.123456'::time(0), cast('01:02:03.1' as time(5)), " +
          "try_cast('24:00:00' as time(3)), '01:02:03.987654'::time(9)",
      ),
    ).toEqual([['3723.123000000', '3723.000000000', '3723.100000000', null, '3723.987654000']]);
    expect(await failure(server, "select '24:00:00.5'::time(0)")).toMatch(/not recognized/);
    expect(await failure(server, 'create or replace table times (t time(3))')).toMatch(/TIME\(3\) column .* not supported/);
    expect(await failure(server, 'create or replace table stamps (a timestamp_ntz(0))')).toMatch(/TIMESTAMP_NTZ\(0\) column .* not supported/);
    expect(
      await rows(
        server,
        "select ('2024-01-02 03:04:05.987654'::timestamp_ntz(0))::varchar, cast('2024-01-02 03:04:05.987654' as timestamp(3))::varchar, " +
          "('2024-01-02 03:04:05.987654+00'::timestamp_tz(0))::varchar, cast('2024-01-02 03:04:05.987654+00' as timestamp_ltz(3))::varchar",
      ),
    ).toEqual([['2024-01-02 03:04:05', '2024-01-02 03:04:05.987', '2024-01-02 03:04:05+00', '2024-01-02 03:04:05.987+00']]);
    expect(await failure(server, "select '2024-01-02'::timestamp_ntz(1)")).toMatch(/TIMESTAMP_NTZ\(1\) is not supported/);
  });

  it('casts variant paths to string as Snowflake does: strings unquoted, other values as JSON text', async () => {
    expect(
      await rows(
        server,
        `select parse_json('{"a":{"b":"x"}}'):a:b::string, parse_json('{"a":{"b":5}}'):a:b::string, ` +
          `parse_json('{"file":"f"}'):file::string, coalesce(parse_json('{"k":"v"}'), null):k::string, ` +
          `object_construct('a', 'y'):a::text, cast(parse_json('{"a":"x"}'):a as varchar), ` +
          `try_cast(parse_json('{"a":"x"}'):a as string), parse_json('{"a":{"b":1}}'):a::varchar, ` +
          `parse_json('{"a":null}'):a::string, parse_json('{"a":"x"}'):a`,
      ),
    ).toEqual([['x', '5', 'f', 'v', 'y', 'x', 'x', '{"b":1}', null, '"x"']]);
    expect(
      await rows(
        server,
        `select parse_json('{"Quoted Key":"q","a":{"Q":["r"]},"it''s":"s"}'):"Quoted Key"::string, ` +
          `parse_json('{"a":{"Q":["r"]}}'):a."Q"[0]::string, parse_json('{"it''s":"s"}'):"it's"::string`,
      ),
    ).toEqual([['q', 'r', 's']]);
  });

  it('casts variant paths and window results to TIME, failing as SQLSTATE 22007', async () => {
    expect(
      await rows(
        server,
        `select parse_json('{"s":"10:11:12","a":{"b":"01:02:03"},"l":["04:05:06"]}'):s::time, ` +
          `parse_json('{"a":{"b":"01:02:03"}}'):a.b::time, parse_json('{"l":["04:05:06"]}'):l[0]::time`,
      ),
    ).toEqual([['36672.000000000', '3723.000000000', '14706.000000000']]);
    const window = "from (select '10:00:00' x union all select '11:00:00') order by 1 nulls first";
    for (const over of ['over (order by x)', 'over(order by x)', 'over (partition by 1 order by x)']) {
      expect(await rows(server, `select lag(x) ${over}::time ${window}`), over).toEqual([[null], ['36000.000000000']]);
    }
    expect(await rows(server, "select timestamp '2024-01-02 03:04:05'::time")).toEqual([['11045.000000000']]);
    for (const statement of ["select '24:00:00'::time", "select 'abc'::time", "select 'abc'::date", "select '2024-13-01'::date", "select 'abc'::timestamp", "select to_date('x', 'YYYY-MM-DD')"]) {
      expect((await sql(server, statement)).body.sqlState, statement).toBe('22007');
    }
    expect((await sql(server, "select 'abc'::int")).body.sqlState).toBe('22018');
    await rows(server, 'create or replace table times22007 (t time)');
    expect((await sql(server, "insert into times22007 values ('24:00:00')")).body.sqlState).toBe('22007');
  });

  it('converts TIMESTAMP_TZ in UTC whatever the host zone', async () => {
    expect(
      await rows(
        server,
        "select current_setting('TimeZone'), '2024-01-02 03:04:05+05:30'::timestamp_tz::time, " +
          "'2024-01-02 03:04:05+05:30'::timestamp_tz::date",
      ),
    ).toEqual([['UTC', '77645.000000000', '2024-01-01']]);
  });

  it('describes a table by its exact stored name', async () => {
    await rows(server, 'create or replace table "orders" (a int)');
    expect((await rows(server, 'describe table "orders"')).map((row) => row[0])).toEqual(['A']);
    expect(await failure(server, 'describe table orders')).toMatch(/SNOWTEST\.PUBLIC\.ORDERS' does not exist/);
    await rows(server, 'drop table "orders"');
    await rows(server, 'create table ORDERS (b int, c int)');
    expect((await rows(server, 'describe table orders')).map((row) => row[0])).toEqual(['B', 'C']);
    expect(await failure(server, 'describe table "orders"')).toMatch(/SNOWTEST\.PUBLIC\.orders' does not exist/);
  });
});

describe('quoted default database', () => {
  let server: SnowtestServer;
  beforeAll(async () => {
    server = await createServer({ dataDir: null, defaultDatabase: '"devDb"' });
  });
  afterAll(async () => {
    await server?.close();
  });

  it('keeps its case on the SQL API and login paths', async () => {
    expect(await rows(server, 'select current_database()')).toEqual([['devDb']]);
    const login = await server.app.request('/session/v1/login-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { LOGIN_NAME: 'T' } }),
    });
    expect(((await login.json()) as { success: boolean }).success).toBe(true);
    expect(server.catalog.getDatabase('devDb')).toBeDefined();
    expect(server.catalog.getDatabase('DEVDB')).toBeUndefined();
  });
});

describe('login with CLIENT_VALIDATE_DEFAULT_PARAMETERS', () => {
  let server: SnowtestServer;
  beforeAll(async () => {
    server = await createServer({ dataDir: null });
  });
  afterAll(async () => {
    await server?.close();
  });

  async function login(fields: Record<string, unknown>): Promise<{ success: boolean; code?: string; message?: string }> {
    const response = await server.app.request('/session/v1/login-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { LOGIN_NAME: 'T', ...fields } }),
    });
    return (await response.json()) as { success: boolean; code?: string; message?: string };
  }
  const validate = { SESSION_PARAMETERS: { CLIENT_VALIDATE_DEFAULT_PARAMETERS: true } };

  it('rejects a missing schema, database or warehouse', async () => {
    expect(await login({ ...validate, SCHEMA_NAME: 'NO_SUCH_SCHEMA' })).toMatchObject({
      success: false,
      code: '390201',
      message: 'The requested schema does not exist or not authorized.',
    });
    expect(server.catalog.getSchema('SNOWTEST', 'NO_SUCH_SCHEMA')).toBeUndefined();
    expect((await login({ ...validate, DATABASE_NAME: 'NO_SUCH_DB' })).message).toBe(
      'The requested database does not exist or not authorized.',
    );
    expect(server.catalog.getDatabase('NO_SUCH_DB')).toBeUndefined();
    expect((await login({ ...validate, WAREHOUSE_NAME: 'NO_SUCH_WH' })).message).toBe(
      'The requested warehouse does not exist or not authorized.',
    );
  });

  it('accepts existing objects', async () => {
    expect((await login({ ...validate, DATABASE_NAME: 'SNOWTEST', SCHEMA_NAME: 'PUBLIC' })).success).toBe(true);
  });

  it('still auto-creates without the flag', async () => {
    expect((await login({ SCHEMA_NAME: 'AUTO_SCHEMA' })).success).toBe(true);
    expect(server.catalog.getSchema('SNOWTEST', 'AUTO_SCHEMA')).toBeDefined();
  });
});

describe('persistence (SNOWTEST_DATA_DIR)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'snowtest-data-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('restores databases, schemas, tables and stages after a restart', async () => {
    const first = await createServer({ dataDir: dir });
    await rows(first, 'create database KEEP');
    await rows(first, 'create schema KEEP.RAW');
    await rows(first, 'create table KEEP.RAW.T (n int)');
    await rows(first, 'insert into KEEP.RAW.T values (42)');
    await rows(first, "create stage KEEP.RAW.LANDING url = 's3://bucket/x'");
    await first.close();

    const second = await createServer({ dataDir: dir });
    expect(second.catalog.getSchema('KEEP', 'RAW')).toBeDefined();
    expect(second.catalog.stages.has('KEEP.RAW.LANDING')).toBe(true);
    expect(await rows(second, 'select n from KEEP.RAW.T')).toEqual([['42']]);

    await rows(second, 'drop database KEEP');
    expect((await readdir(dir)).some((file) => file.startsWith('KEEP'))).toBe(false);

    await rows(second, 'create table PUBLIC.GONE (n int)');
    const reset = await second.app.request('/_snowtest/reset', { method: 'POST' });
    expect(reset.status).toBe(200);
    await second.close();

    const third = await createServer({ dataDir: dir });
    expect(await failure(third, 'select * from PUBLIC.GONE')).toMatch(/does not exist/);
    expect(third.catalog.stages.size).toBe(0);
    await third.close();
  });

  it('drops stages with their database or schema, so a restart still starts', async () => {
    const first = await createServer({ dataDir: dir });
    await rows(first, 'create database STG1');
    await rows(first, 'create stage STG1.PUBLIC.S1');
    await rows(first, 'create database STG2');
    await rows(first, 'create schema STG2.RAW');
    await rows(first, 'create stage STG2.RAW.S2');
    await rows(first, 'create stage STG2.PUBLIC.KEEP');
    const gone = ['STG1.PUBLIC.S1', 'STG2.RAW.S2'].map((key) => first.catalog.stages.get(key)?.directory as string);
    expect(gone.every((directory) => existsSync(directory))).toBe(true);

    await rows(first, 'drop database STG1');
    await rows(first, 'drop schema STG2.RAW');
    expect([...first.catalog.stages.keys()]).toEqual(['STG2.PUBLIC.KEEP']);
    expect(gone.some((directory) => existsSync(directory))).toBe(false);
    expect(existsSync(dirname(dirname(gone[0])))).toBe(false);
    expect(existsSync(dirname(gone[1]))).toBe(false);
    await first.close();

    const second = await createServer({ dataDir: dir });
    expect([...second.catalog.stages.keys()]).toEqual(['STG2.PUBLIC.KEEP']);
    await rows(second, 'drop database STG2');
    await second.close();
  });

  it('keeps a quoted lower-case database name across a restart', async () => {
    const first = await createServer({ dataDir: dir });
    await rows(first, 'create database "mydb"');
    await rows(first, 'create table "mydb".PUBLIC.T (n int)');
    await rows(first, 'insert into "mydb".PUBLIC.T values (7)');
    await first.close();
    expect(await readdir(dir)).toContain('mydb.duckdb');

    const second = await createServer({ dataDir: dir });
    expect(second.catalog.getDatabase('mydb')).toBeDefined();
    expect(second.catalog.getDatabase('MYDB')).toBeUndefined();
    expect(await rows(second, 'select n from "mydb".PUBLIC.T')).toEqual([['7']]);
    await rows(second, 'drop database "mydb"');
    await second.close();
  });
});

describe('failAfter', () => {
  it('rethrows the original error when cleanup succeeds', async () => {
    const original = new SnowflakeError('100072', 'NULL result', '22000', 'runtime');
    await expect(failAfter(original, async () => undefined)).rejects.toBe(original);
  });

  it('keeps the original code and message and appends a cleanup failure', async () => {
    const original = new SnowflakeError('100072', 'NULL result', '22000', 'runtime');
    const cleanup = async () => {
      throw new Error('rollback failed');
    };
    await expect(failAfter(original, cleanup)).rejects.toMatchObject({
      code: '100072',
      sqlState: '22000',
      kind: 'runtime',
      message: 'NULL result\n(cleanup also failed: rollback failed)',
    });
  });
});

describe('TIME wire encoding', () => {
  const time: SnowflakeColumn = {
    name: 'T', type: 'time', precision: 0, scale: 9, byteLength: null, length: null,
    nullable: true, database: '', schema: '', table: '',
  };

  it('sends seconds since midnight at scale 9 on both surfaces', () => {
    const values = [[50706123456n], [{ micros: 1n, offset: 7200 }], [null]];
    const expected = [['50706.123456000'], ['0.000001000'], [null]];
    expect(toDriverRowset(values, [time])).toEqual(expected);
    expect(toApiV2Rowset(values, [time])).toEqual(expected);
  });

  it('refuses values Snowflake TIME cannot hold', () => {
    expect(() => toDriverRowset([[86_400_000_000n]], [time])).toThrow(/out of range/);
    expect(() => toDriverRowset([['14:05:06']], [time])).toThrow(/Unexpected TIME value/);
  });
});
