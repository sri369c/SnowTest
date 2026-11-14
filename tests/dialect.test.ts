// Copyright (c) 2026 Srinivas Chaturvedula

import { describe, expect, it } from 'vitest';

import { rewrite, splitColumnListCtas, toSqlLiteral } from '../src/dialect.js';

const ctx = {
  database: 'SNOWTEST',
  schema: 'PUBLIC',
  role: 'SYSADMIN',
  user: 'TEST',
  warehouse: 'SNOWTEST_WH',
};

const run = (sql: string, bindings: unknown[] = []) => rewrite(sql, ctx, bindings);

describe('function translation', () => {
  it('rewrites IFF to CASE', () => {
    expect(run("SELECT IFF(1 = 1, 'a', 'b')")).toBe("SELECT CASE WHEN 1 = 1 THEN 'a' ELSE 'b' END");
  });

  it('rewrites NVL, ZEROIFNULL and DIV0', () => {
    expect(run('SELECT NVL(a, 0)')).toBe('SELECT COALESCE(A, 0)');
    expect(run('SELECT ZEROIFNULL(a)')).toBe('SELECT COALESCE(A, 0)');
    expect(run('SELECT DIV0(a, b)')).toBe('SELECT COALESCE(A / NULLIF(B, 0), 0)');
  });

  it('translates DATEADD to interval arithmetic', () => {
    expect(run('SELECT DATEADD(day, 1, d)')).toBe('SELECT (D + (1) * INTERVAL 1 DAY)');
    expect(run("SELECT DATEADD('month', -2, d)")).toBe('SELECT (D + (-2) * INTERVAL 1 MONTH)');
  });

  it('translates DATEDIFF to date_diff', () => {
    expect(run("SELECT DATEDIFF('day', a, b)")).toBe("SELECT DATE_DIFF('day', A, B)");
  });

  it('translates CONVERT_TIMEZONE to timezone()', () => {
    expect(run("SELECT CONVERT_TIMEZONE('UTC', ts)")).toBe("SELECT TIMEZONE('UTC', TS)");
    expect(run("SELECT CONVERT_TIMEZONE('A', 'B', ts)")).toBe("SELECT TIMEZONE('B', TIMEZONE('A', TS))");
  });

  it('matches NULL to NULL in DECODE', () => {
    expect(run("SELECT DECODE(x, NULL, 'none', 1, 'one', 'other')")).toBe(
      "SELECT CASE WHEN X IS NOT DISTINCT FROM NULL THEN 'none' WHEN X IS NOT DISTINCT FROM 1 THEN 'one' ELSE 'other' END",
    );
  });
});

describe('clock functions', () => {
  it('accepts the call forms', () => {
    expect(run('SELECT CURRENT_TIMESTAMP(), LOCALTIMESTAMP(), CURRENT_DATE()')).toBe(
      'SELECT CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_DATE',
    );
    expect(run('SELECT CURRENT_TIME(), LOCALTIME, current_time')).toBe(
      'SELECT CURRENT_LOCALTIME(), CURRENT_LOCALTIME(), CURRENT_LOCALTIME()',
    );
  });

  it('truncates to a supported precision', () => {
    expect(run('SELECT current_timestamp(3)')).toBe("SELECT DATE_TRUNC('millisecond', CURRENT_TIMESTAMP)");
    expect(run('SELECT current_timestamp(0)')).toBe("SELECT DATE_TRUNC('second', CURRENT_TIMESTAMP)");
    expect(run('SELECT current_timestamp(9)')).toBe('SELECT CURRENT_TIMESTAMP');
    expect(() => run('SELECT current_timestamp(2)')).toThrow(/not supported on snowtest/);
  });

  it('keeps dbt snapshot timestamps intact', () => {
    expect(run("select to_timestamp_ntz(convert_timezone('UTC', current_timestamp()))")).toBe(
      "SELECT CAST(TIMEZONE('UTC', CURRENT_TIMESTAMP) AS TIMESTAMP)",
    );
  });

  it('makes SYSDATE the UTC wall clock', () => {
    expect(run('SELECT SYSDATE()')).toBe("SELECT TIMEZONE('UTC', CURRENT_TIMESTAMP)");
  });
});

describe('conversion functions', () => {
  it('turns TRY_ variants into TRY_CAST', () => {
    expect(run("SELECT TRY_TO_NUMBER('x'), TRY_TO_DECIMAL(v, 10, 2), TRY_TO_DOUBLE(v)")).toBe(
      "SELECT TRY_CAST('x' AS DECIMAL(38, 0)), TRY_CAST(V AS DECIMAL(10, 2)), TRY_CAST(V AS DOUBLE)",
    );
    expect(run('SELECT TRY_TO_DATE(v), TRY_TO_TIMESTAMP(v), TRY_TO_TIMESTAMP_NTZ(v), TRY_TO_BOOLEAN(v)')).toBe(
      'SELECT TRY_CAST(V AS DATE), TRY_CAST(V AS TIMESTAMP), TRY_CAST(V AS TIMESTAMP), TRY_CAST(V AS BOOLEAN)',
    );
  });

  it('refuses number format models', () => {
    expect(() => run("SELECT TO_NUMBER(v, '999.99')")).toThrow(/not supported on snowtest/);
  });

  it('gives NUMBER, DECIMAL and NUMERIC a scale of 0', () => {
    expect(run("SELECT '1.5'::number, x::numeric, CAST(y AS DECIMAL), z::number(10,2)")).toBe(
      "SELECT '1.5'::DECIMAL(38,0), X::DECIMAL(38,0), CAST(Y AS DECIMAL(38,0)), Z::DECIMAL(10,2)",
    );
  });

  it('translates date/time format elements', () => {
    expect(run("SELECT TO_VARCHAR(ts, 'YYYY-MM-DD HH24:MI:SS.FF3')")).toBe(
      "SELECT STRFTIME(TS, '%Y-%m-%d %H:%M:%S.%g')",
    );
    expect(run("SELECT TO_CHAR(d, 'DY, DD MON YYYY')")).toBe("SELECT STRFTIME(D, '%a, %d %b %Y')");
    expect(run("SELECT TO_DATE(s, 'DD/MM/YYYY')")).toBe("SELECT CAST(STRPTIME(S, '%d/%m/%Y') AS DATE)");
    expect(run("SELECT TRY_TO_TIMESTAMP(s, 'YYYY-MM-DD\"T\"HH24:MI:SS')")).toBe(
      "SELECT CAST(TRY_STRPTIME(S, '%Y-%m-%dT%H:%M:%S') AS TIMESTAMP)",
    );
    expect(run("SELECT TO_DATE(s, 'AUTO')")).toBe('SELECT CAST(S AS DATE)');
  });

  it("formats dbt's catalog timestamp", () => {
    expect(run("select to_varchar(ts, 'yyyy-mm-dd HH24:MI'||'UTC')")).toBe(
      "SELECT STRFTIME(TS, '%Y-%m-%d %H:%MUTC')",
    );
  });

  it('refuses unknown format elements instead of ignoring them', () => {
    expect(() => run("SELECT TO_VARCHAR(n, '9,999.99')")).toThrow(/format element '9'/);
    expect(() => run("SELECT TO_DATE(s, 'YYYY-WW')")).toThrow(/format element 'WW'/);
    expect(() => run('SELECT TO_DATE(s, fmt_column)')).toThrow(/non-literal format/);
  });

  it('reads an epoch scale', () => {
    expect(run('SELECT TO_TIMESTAMP(ms, 3)')).toBe(
      'SELECT CAST(MAKE_TIMESTAMP(CAST(MS AS BIGINT) * 1000) AS TIMESTAMP)',
    );
  });

  it('decodes TO_BINARY input', () => {
    expect(run("SELECT TO_BINARY('414243'), TO_BINARY(s, 'UTF-8')")).toBe("SELECT UNHEX('414243'), ENCODE(S)");
  });

  it('converts TO_VARCHAR to a cast', () => {
    expect(run('SELECT TO_VARCHAR(123)')).toBe('SELECT CAST(123 AS VARCHAR)');
  });

  it('routes TIME casts through TIMETZ and strptime, once', () => {
    const time = (value: string, tryCast = false) =>
      `CAST(${tryCast ? 'TRY_STRPTIME' : 'STRPTIME'}(CAST(CAST(${tryCast ? 'TRY_CAST' : 'CAST'}(${value} AS TIMETZ) AS TIME) ` +
      `AS VARCHAR), ['%H:%M:%S.%f', '%H:%M:%S']) AS TIME)`;
    expect(run("SELECT '14:05:06'::time, x :: time(9), ts::timestamp_tz::time")).toBe(
      `SELECT ${time("'14:05:06'")}, ${time('X')}, ${time('TS::TIMESTAMPTZ')}`,
    );
    expect(run('SELECT CAST(ts AS TIME(6)), TRY_CAST(CAST(s AS TIME) AS time)')).toBe(
      `SELECT ${time('TS')}, ${time(time('S'), true)}`,
    );
    expect(run('SELECT f(x)::time, t."c"::time, n::number(10,2)::time, (case when a then b end)::time, case when a then b end::time')).toBe(
      `SELECT ${time('F(X)')}, ${time('T."c"')}, ${time('N::DECIMAL(10,2)')}, ${time('(CASE WHEN A THEN B END)')}, ` +
        time('CASE WHEN A THEN B END'),
    );
    expect(run('SELECT 1 WHERE (x)::time > y')).toBe(`SELECT 1 WHERE ${time('(X)')} > Y`);
    expect(run('SELECT x::timestamp_tz, CAST(y AS TIMESTAMP)')).toBe('SELECT X::TIMESTAMPTZ, CAST(Y AS TIMESTAMP)');
  });

  it('takes the whole operand of ::TIME', () => {
    const time = (value: string) =>
      `CAST(STRPTIME(CAST(CAST(CAST(${value} AS TIMETZ) AS TIME) AS VARCHAR), ['%H:%M:%S.%f', '%H:%M:%S']) AS TIME)`;
    const cases: Array<[string, string]> = [
      ['payload:start', "JSON_EXTRACT(PAYLOAD, '$.start')"],
      ['v:a.b', "JSON_EXTRACT(V, '$.a.b')"],
      ['v:a[0]', "JSON_EXTRACT(V, '$.a[0]')"],
      ['t.v:a', "JSON_EXTRACT(T.V, '$.a')"],
      ['parse_json(s):k', "JSON_EXTRACT(TRY_CAST(S AS JSON), '$.k')"],
      ['lag(t) over (order by t)', 'LAG(T) OVER (ORDER BY T)'],
      ['lag(t) over(order by t)', 'LAG(T) OVER(ORDER BY T)'],
      ['lag(t, 1) over (partition by g order by t)', 'LAG(T, 1) OVER (PARTITION BY G ORDER BY T)'],
      ['max(t) filter (where t > 0)', 'MAX(T) FILTER (WHERE T > 0)'],
      ["TIMESTAMP '2024-01-02 03:04:05'", "TIMESTAMP '2024-01-02 03:04:05'"],
      ["date '2024-01-02'", "DATE '2024-01-02'"],
      ['func (x)', 'FUNC (X)'],
      ['"f"(x)', '"f"(X)'],
      ['x::varchar::number', 'X::VARCHAR::DECIMAL(38,0)'],
      ['case when a then b end', 'CASE WHEN A THEN B END'],
      ['(select max(t) from s)', '(SELECT MAX(T) FROM S)'],
    ];
    for (const [operand, translated] of cases) {
      expect(run(`SELECT ${operand}::time FROM t`), operand).toBe(`SELECT ${time(translated)} FROM T`);
    }
    expect(run('SELECT distinct(x)::time')).toBe(`SELECT DISTINCT ${time('(X)')}`);
    expect(run('SELECT a + b::time')).toBe(`SELECT A + ${time('B')}`);
  });

  it('leaves ::time inside strings, comments and quoted names alone', () => {
    expect(run("SELECT 'a::time', $$b::time$$, \"c::time\" -- d::time\n/* e::time */")).toBe(
      "SELECT 'a::time', $$b::time$$, \"c::time\" -- d::time\n/* e::time */",
    );
  });

  it('drops TIME precision and refuses 24:00:00 in CREATE TABLE columns', () => {
    expect(run('create table t (a time(9) not null, "b" TIME, c number)')).toBe(
      'CREATE TABLE T (A TIME CHECK (HOUR(A) < 24) NOT NULL, "b" TIME CHECK (HOUR("b") < 24), C DECIMAL(38,0))',
    );
    expect(run('alter table t add column d time(6)')).toBe('ALTER TABLE T ADD COLUMN D TIME');
    expect(run('alter table t alter column d type time(9)')).toBe('ALTER TABLE T ALTER COLUMN D TYPE TIME');
  });

  it('cuts TIME(n) casts to n fractional digits', () => {
    const time = (value: string, cut: number, tryCast = false) =>
      `CAST(${tryCast ? 'TRY_STRPTIME' : 'STRPTIME'}(LEFT(CAST(CAST(${tryCast ? 'TRY_CAST' : 'CAST'}(${value} AS TIMETZ) AS TIME) ` +
      `AS VARCHAR), ${cut}), ['%H:%M:%S.%f', '%H:%M:%S']) AS TIME)`;
    expect(run('SELECT x::time(0), CAST(y AS TIME(3)), TRY_CAST(z AS time( 5 ))')).toBe(
      `SELECT ${time('X', 8)}, ${time('Y', 12)}, ${time('Z', 14, true)}`,
    );
    expect(() => run('SELECT x::time(10)')).toThrow(/precision must be between 0 and 9/);
  });

  it('refuses column precisions the engine cannot store', () => {
    for (const sql of [
      'create table t (a time(3))',
      'create table t (a timestamp_tz(0))',
      'create table t (a timestamp_ltz(5)) as select 1',
      'alter table t add column a time(0)',
      'alter table t alter column a type timestamp_tz(3)',
      'create table t (a timestamp_ntz(1))',
      'create table t (a timestamp_ntz(3))',
      'create table t (a datetime(0))',
      'create table t (a timestamp(7))',
      'select x::timestamp_ntz(2)',
      'select x::timestamp_ntz(8)',
      'select cast(x as timestamp_tz(1))',
    ]) {
      expect(() => run(sql), sql).toThrow(/not supported on snowtest/);
    }
    expect(run('create table t (a timestamp_ntz(9), b timestamp(6), c timestamp_tz(9), d datetime)')).toBe(
      'CREATE TABLE T (A TIMESTAMP(9), B TIMESTAMP, C TIMESTAMPTZ, D TIMESTAMP)',
    );
  });

  it('truncates timestamp (0|3) casts with date_trunc', () => {
    expect(run('SELECT x::timestamp_tz(0), TRY_CAST(y AS TIMESTAMP_LTZ(3)), z::timestamp_tz(9), w::timestamp_ntz(3)')).toBe(
      "SELECT DATE_TRUNC('second', CAST(X AS TIMESTAMPTZ)), DATE_TRUNC('millisecond', TRY_CAST(Y AS TIMESTAMPTZ)), " +
        "Z::TIMESTAMPTZ, DATE_TRUNC('millisecond', CAST(W AS TIMESTAMP))",
    );
    expect(run('SELECT CAST(x AS DATETIME(0)), y::timestamp_ntz(9)')).toBe(
      "SELECT DATE_TRUNC('second', CAST(X AS TIMESTAMP)), Y::TIMESTAMP(9)",
    );
  });
});

describe('ordered aggregates', () => {
  it('moves LISTAGG ordering into string_agg', () => {
    expect(run("SELECT LISTAGG(x, ',') WITHIN GROUP (ORDER BY y DESC) FROM t")).toBe(
      "SELECT STRING_AGG(X, ',' ORDER BY Y DESC) FROM T",
    );
    expect(run('SELECT LISTAGG(DISTINCT x) FROM t')).toBe("SELECT STRING_AGG(DISTINCT X, '') FROM T");
  });

  it('keeps ARRAY_AGG ordering, skips NULLs and yields [] for no rows', () => {
    expect(run('SELECT ARRAY_AGG(x) WITHIN GROUP (ORDER BY x) FROM t')).toBe(
      'SELECT COALESCE(ARRAY_AGG(X ORDER BY X) FILTER (WHERE X IS NOT NULL), []) FROM T',
    );
    expect(run('SELECT ARRAY_AGG(DISTINCT x) OVER (PARTITION BY g) FROM t')).toBe(
      'SELECT COALESCE(ARRAY_AGG(DISTINCT X) FILTER (WHERE X IS NOT NULL) OVER (PARTITION BY G), []) FROM T',
    );
  });

  it('leaves ordered-set aggregates for DuckDB', () => {
    expect(run('SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x) FROM t')).toBe(
      'SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY X) FROM T',
    );
  });
});

describe('information_schema', () => {
  it('filters qualified views to that database', () => {
    const out = run('SELECT * FROM "DB_A".INFORMATION_SCHEMA.tables');
    expect(out).toContain("WHERE table_catalog = 'DB_A'");
  });

  it('filters unqualified views to the session database', () => {
    const out = run('SELECT t.table_name FROM information_schema.tables t');
    expect(out).toContain("WHERE table_catalog = 'SNOWTEST'");
  });

  it('adds the Snowflake-only tables columns', () => {
    const out = run('SELECT bytes FROM information_schema.tables');
    for (const column of ['comment', 'row_count', 'bytes', 'last_altered', 'is_dynamic', 'is_iceberg']) {
      expect(out).toContain(` AS ${column}`);
    }
  });

  it('lists account databases from the catalog, qualified or not', () => {
    const databases = [{ name: 'DB_A', comment: null, createdAt: new Date('2026-01-02T03:04:05Z') }];
    for (const sql of [
      'SELECT DATABASE_NAME from information_schema.databases',
      'SELECT database_name FROM "DB_A".INFORMATION_SCHEMA.DATABASES',
    ]) {
      const out = rewrite(sql, { ...ctx, databases });
      expect(out).toContain("'DB_A'::VARCHAR AS DATABASE_NAME");
      expect(out).toContain("'2026-01-02 03:04:05.000'::TIMESTAMPTZ AS CREATED");
    }
    expect(rewrite('SELECT * FROM information_schema.databases', { ...ctx, databases: [] })).toContain('WHERE FALSE');
  });
});

describe('variant access', () => {
  it('translates a path to json_extract, keeping the key case', () => {
    expect(run('SELECT payload:region FROM t')).toBe("SELECT JSON_EXTRACT(PAYLOAD, '$.region') FROM T");
    expect(run('SELECT t.v:a.b, "V":l[0], v:a:b FROM t')).toBe(
      "SELECT JSON_EXTRACT(T.V, '$.a.b'), JSON_EXTRACT(\"V\", '$.l[0]'), JSON_EXTRACT(JSON_EXTRACT(V, '$.a'), '$.b') FROM T",
    );
    expect(run("SELECT parse_json(s):k, {'k': v}, x::varchar FROM t")).toBe(
      "SELECT JSON_EXTRACT(TRY_CAST(S AS JSON), '$.k'), {'k': V}, X::VARCHAR FROM T",
    );
  });

  it('unquotes when cast to string', () => {
    expect(run('SELECT payload:region::string FROM t')).toBe(
      "SELECT JSON_EXTRACT_STRING(PAYLOAD, '$.region')::VARCHAR FROM T",
    );
  });

  it('reads every string cast of a path through json_extract_string', () => {
    const cases: Array<[string, string]> = [
      ['v:a:b::string', "JSON_EXTRACT_STRING(JSON_EXTRACT(V, '$.a'), '$.b')::VARCHAR"],
      ['$1:a:b::string', "JSON_EXTRACT_STRING(JSON_EXTRACT($1, '$.a'), '$.b')::VARCHAR"],
      ['coalesce(a,b):k::string', "JSON_EXTRACT_STRING(COALESCE(A,B), '$.k')::VARCHAR"],
      ["object_construct('a',x):a::string", "JSON_EXTRACT_STRING(JSON_OBJECT('a', X), '$.a')::VARCHAR"],
      ['v:a::varchar', "JSON_EXTRACT_STRING(V, '$.a')::VARCHAR"],
      ['v:a :: text', "JSON_EXTRACT_STRING(V, '$.a') ::VARCHAR"],
      ['v:a::varchar(10)', "JSON_EXTRACT_STRING(V, '$.a')::VARCHAR(10)"],
      ['(v:a)::string', "(JSON_EXTRACT_STRING(V, '$.a'))::VARCHAR"],
      ['cast(v:a as string)', "CAST(JSON_EXTRACT_STRING(V, '$.a') AS VARCHAR)"],
      ['CAST(coalesce(a,b):k AS VARCHAR)', "CAST(JSON_EXTRACT_STRING(COALESCE(A,B), '$.k') AS VARCHAR)"],
      ['try_cast(v:a:b as text)', "TRY_CAST(JSON_EXTRACT_STRING(JSON_EXTRACT(V, '$.a'), '$.b') AS VARCHAR)"],
      ['cast(cast(v:a as string) as string)', "CAST(CAST(JSON_EXTRACT_STRING(V, '$.a') AS VARCHAR) AS VARCHAR)"],
      ['v:a::number', "JSON_EXTRACT(V, '$.a')::DECIMAL(38,0)"],
      ['cast(v:a as int)', "CAST(JSON_EXTRACT(V, '$.a') AS INT)"],
    ];
    for (const [expression, translated] of cases) {
      expect(run(`SELECT ${expression} FROM t`), expression).toBe(`SELECT ${translated} FROM T`);
    }
  });

  it('takes any key name, URL-like ones included', () => {
    expect(run('SELECT payload:file, v:s3, v:https, v:http.x FROM t')).toBe(
      "SELECT JSON_EXTRACT(PAYLOAD, '$.file'), JSON_EXTRACT(V, '$.s3'), JSON_EXTRACT(V, '$.https'), " +
        "JSON_EXTRACT(V, '$.http.x') FROM T",
    );
  });

  it('reads quoted keys', () => {
    expect(run(`SELECT v:"Quoted Key", v:a."Q"[0], v:"it's"::string FROM t`)).toBe(
      `SELECT JSON_EXTRACT(V, '$."Quoted Key"'), JSON_EXTRACT(V, '$.a."Q"[0]'), ` +
        `JSON_EXTRACT_STRING(V, '$."it''s"')::VARCHAR FROM T`,
    );
    expect(() => run('SELECT v:"a""b" FROM t')).toThrow(/variant key containing a double quote is not supported/);
  });

  it('refuses named binds after a keyword', () => {
    for (const statement of ['SELECT :x', 'SELECT a FROM t LIMIT :n', 'SELECT a FROM t WHERE :flag', 'SELECT DISTINCT :"x"']) {
      expect(() => run(statement), statement).toThrow(/Named bind variable ':.+' \(bind with \? or %s\) is not supported/);
    }
  });

  it('refuses a path step after a :: cast', () => {
    expect(() => run('SELECT v:a::string:b FROM t')).toThrow(/variant path after a :: cast \(':b'\)/);
    expect(() => run('SELECT v:a::varchar(10):b FROM t')).toThrow(/variant path after a :: cast/);
    expect(run('SELECT (v:a::variant):b FROM t')).toBe("SELECT JSON_EXTRACT((JSON_EXTRACT(V, '$.a')::JSON), '$.b') FROM T");
  });

  it('refuses a bracket path cast to string', () => {
    expect(() => run("SELECT col['a']['b']::string FROM t")).toThrow(/bracket variant path .* is not supported on snowtest/);
  });
});

describe('identifier case', () => {
  it('folds unquoted identifiers and keeps quoted ones', () => {
    expect(run('select a, "Mixed" as "x", b as y from db.s.t')).toBe(
      'SELECT A, "Mixed" AS "x", B AS Y FROM DB.S.T',
    );
  });

  it('leaves numbers alone', () => {
    expect(run('SELECT 1e3, 2.5')).toBe('SELECT 1e3, 2.5');
  });
});

describe('types and DDL', () => {
  it('maps Snowflake column types', () => {
    const out = run('CREATE TRANSIENT TABLE t (a NUMBER(10,2), b VARIANT, c TIMESTAMP_NTZ, d NUMBER)');
    expect(out).toBe('CREATE TABLE T (A DECIMAL(10,2), B JSON, C TIMESTAMP, D DECIMAL(38,0))');
  });

  it('strips clustering and copy grants, nested parentheses included', () => {
    const out = run('create or replace table t cluster by (to_date(ts), a) copy grants as (select 1 as a)');
    expect(out).toBe('CREATE OR REPLACE TABLE T   AS (SELECT 1 AS A)');
  });
});

describe('CTAS with a column list', () => {
  it('splits dbt contract DDL into create and query', () => {
    const ctas = splitColumnListCtas(
      `create or replace transient table db.s.orders (
        id integer not null primary key,
        note varchar default 'a, b',
        constraint pk primary key (id)
      ) copy grants as (select id, note from src)`,
    );
    expect(ctas).not.toBeNull();
    expect(ctas?.table).toBe('db.s.orders');
    expect(ctas?.ifNotExists).toBe(false);
    expect(ctas?.create).toBe(
      "create or replace transient table db.s.orders (id integer not null, note varchar default 'a, b')",
    );
    expect(ctas?.query).toBe('select id, note from src');
  });

  it('ignores plain CREATE TABLE and plain CTAS', () => {
    expect(splitColumnListCtas('create table t (a int)')).toBeNull();
    expect(splitColumnListCtas('create table t as select 1')).toBeNull();
  });
});

describe('literals and bindings', () => {
  it('leaves string literals alone', () => {
    expect(run("SELECT 'IFF(1,2,3)' AS s")).toBe("SELECT 'IFF(1,2,3)' AS S");
  });

  it('leaves comments alone', () => {
    expect(run('SELECT 1 -- NVL(a,b)\n')).toContain('-- NVL(a,b)');
  });

  it('substitutes positional bindings', () => {
    expect(run('SELECT ? AS a', [42])).toBe('SELECT 42 AS A');
    expect(run('SELECT ? AS a', ["o'brien"])).toBe("SELECT 'o''brien' AS A");
  });

  it('resolves session context functions', () => {
    expect(run('SELECT CURRENT_DATABASE(), CURRENT_SCHEMA()')).toBe("SELECT 'SNOWTEST', 'PUBLIC'");
  });

  it('renders literals safely', () => {
    expect(toSqlLiteral(null)).toBe('NULL');
    expect(toSqlLiteral(true)).toBe('TRUE');
    expect(toSqlLiteral("a'b")).toBe("'a''b'");
  });

  it('applies Snowflake backslash escapes', () => {
    expect(run(String.raw`SELECT 'it\'s', 'C:\\x', 'a\tb', '\x41\u0042\103', 'q\z'`)).toBe(
      "SELECT 'it''s', 'C:\\x', 'a\tb', 'ABC', 'qz'",
    );
    expect(run(String.raw`SELECT 'it\'s -- not a comment' AS s`)).toBe("SELECT 'it''s -- not a comment' AS S");
    expect(() => run(String.raw`SELECT 'a\0b'`)).toThrow(/NUL character/);
  });

  it('resolves no current database/schema to NULL', () => {
    const none = { ...ctx, database: null, schema: null };
    expect(rewrite('SELECT CURRENT_DATABASE(), CURRENT_SCHEMA()', none)).toBe('SELECT NULL, NULL');
    expect(() => rewrite('SELECT * FROM information_schema.tables', none)).toThrow(/does not have a current database/);
  });
});

describe('quoted identifiers and keyword-named columns', () => {
  it('never rewrites a quoted identifier', () => {
    expect(run('SELECT "number", "current_schema", "variant", "nvl"(1) FROM t')).toBe(
      'SELECT "number", "current_schema", "variant", "nvl"(1) FROM T',
    );
    expect(run('CREATE TABLE t ("number" NUMBER, "string" STRING)')).toBe(
      'CREATE TABLE T ("number" DECIMAL(38,0), "string" VARCHAR)',
    );
  });

  it('maps types only in type positions', () => {
    expect(run('SELECT number, decimal, numeric, string, binary, variant FROM t')).toBe(
      'SELECT NUMBER, DECIMAL, NUMERIC, STRING, "BINARY", VARIANT FROM T',
    );
    expect(run('CREATE TABLE t (number number, string string, variant variant, binary binary)')).toBe(
      'CREATE TABLE T (NUMBER DECIMAL(38,0), STRING VARCHAR, VARIANT JSON, "BINARY" BLOB)',
    );
    expect(run('SELECT CAST(CAST(number AS string) AS number(10, 2)), TRY_CAST(variant AS variant) FROM t')).toBe(
      'SELECT CAST(CAST(NUMBER AS VARCHAR) AS DECIMAL(10,2)), TRY_CAST(VARIANT AS JSON) FROM T',
    );
    expect(run('ALTER TABLE t ADD COLUMN "V" TIMESTAMP_NTZ')).toBe('ALTER TABLE T ADD COLUMN "V" TIMESTAMP');
    expect(run('alter table t alter "C" set data type number(10,2)')).toBe(
      'ALTER TABLE T ALTER "C" SET DATA TYPE DECIMAL(10,2)',
    );
  });
});

describe('fractional seconds', () => {
  it('treats FF as FF9 in both directions', () => {
    expect(run("SELECT TO_VARCHAR(ts, 'HH24:MI:SS.FF'), TO_VARCHAR(ts, 'SS.FF9')")).toBe(
      "SELECT STRFTIME(TS, '%H:%M:%S.%n'), STRFTIME(TS, '%S.%n')",
    );
    expect(run("SELECT TO_TIMESTAMP(s, 'SS.FF'), TO_TIMESTAMP(s, 'SS.FF9')")).toBe(
      "SELECT CAST(STRPTIME(S, '%S.%n') AS TIMESTAMP), CAST(STRPTIME(S, '%S.%n') AS TIMESTAMP)",
    );
  });

  it('names the whole unsupported element', () => {
    expect(() => run("SELECT TO_VARCHAR(ts, 'HH:MI')")).toThrow(/format element 'HH'/);
    expect(() => run("SELECT TO_VARCHAR(ts, 'SS.FF2')")).toThrow(/format element 'FF2'/);
    expect(() => run("SELECT TO_TIMESTAMP(s, 'SS.FF8')")).toThrow(/format element 'FF8'/);
  });
});
