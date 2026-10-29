// Copyright (c) 2026 Srinivas Chaturvedula

import { describe, expect, it } from 'vitest';

import { rewrite, toSqlLiteral } from '../src/dialect.js';

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
    expect(run('SELECT NVL(a, 0)')).toBe('SELECT COALESCE(a, 0)');
    expect(run('SELECT ZEROIFNULL(a)')).toBe('SELECT COALESCE(a, 0)');
    expect(run('SELECT DIV0(a, b)')).toBe('SELECT COALESCE(a / NULLIF(b, 0), 0)');
  });

  it('translates DATEADD to interval arithmetic', () => {
    expect(run('SELECT DATEADD(day, 1, d)')).toBe('SELECT (d + (1) * INTERVAL 1 DAY)');
    expect(run("SELECT DATEADD('month', -2, d)")).toBe('SELECT (d + (-2) * INTERVAL 1 MONTH)');
  });

  it('translates DATEDIFF to date_diff', () => {
    expect(run("SELECT DATEDIFF('day', a, b)")).toBe("SELECT date_diff('day', a, b)");
  });

  it('converts LISTAGG and drops WITHIN GROUP', () => {
    const out = run("SELECT LISTAGG(x, ',') WITHIN GROUP (ORDER BY y) FROM t");
    expect(out).toContain('string_agg(x, ');
    expect(out).not.toContain('WITHIN GROUP');
  });

  it('converts TO_VARCHAR to a cast', () => {
    expect(run('SELECT TO_VARCHAR(123)')).toBe('SELECT CAST(123 AS VARCHAR)');
  });

  it('translates CONVERT_TIMEZONE to timezone()', () => {
    expect(run("SELECT CONVERT_TIMEZONE('UTC', ts)")).toBe("SELECT timezone('UTC', ts)");
    expect(run("SELECT CONVERT_TIMEZONE('A', 'B', ts)")).toBe("SELECT timezone('B', timezone('A', ts))");
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
});

describe('variant access', () => {
  it('translates a path to json_extract', () => {
    expect(run('SELECT payload:region FROM t')).toBe("SELECT json_extract(payload, '$.region') FROM t");
  });

  it('unquotes when cast to string', () => {
    expect(run('SELECT payload:region::string FROM t')).toBe(
      "SELECT json_extract_string(payload, '$.region') FROM t",
    );
  });
});

describe('types and DDL', () => {
  it('maps Snowflake column types', () => {
    const out = run('CREATE TRANSIENT TABLE t (a NUMBER(10,2), b VARIANT, c TIMESTAMP_NTZ, d NUMBER)');
    // Unquoted identifiers fold to upper case, as Snowflake folds them.
    expect(out).toBe('CREATE TABLE T (a DECIMAL(10,2), b JSON, c TIMESTAMP, d DECIMAL(38,0))');
  });

  it('strips clustering and copy grants', () => {
    const out = run('ALTER TABLE t SET CLUSTER BY (a)');
    expect(out).not.toContain('CLUSTER BY');
  });
});

describe('literals and bindings', () => {
  it('leaves string literals alone', () => {
    expect(run("SELECT 'IFF(1,2,3)' AS s")).toBe("SELECT 'IFF(1,2,3)' AS s");
  });

  it('leaves comments alone', () => {
    expect(run('SELECT 1 -- NVL(a,b)\n')).toContain('-- NVL(a,b)');
  });

  it('substitutes positional bindings', () => {
    expect(run('SELECT ? AS a', [42])).toBe('SELECT 42 AS a');
    expect(run('SELECT ? AS a', ["o'brien"])).toBe("SELECT 'o''brien' AS a");
  });

  it('resolves session context functions', () => {
    expect(run('SELECT CURRENT_DATABASE(), CURRENT_SCHEMA()')).toBe("SELECT 'SNOWTEST', 'PUBLIC'");
  });

  it('renders literals safely', () => {
    expect(toSqlLiteral(null)).toBe('NULL');
    expect(toSqlLiteral(true)).toBe('TRUE');
    expect(toSqlLiteral("a'b")).toBe("'a''b'");
  });
});
