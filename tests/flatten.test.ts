// Copyright (c) 2026 Srinivas Chaturvedula

import { describe, expect, it } from 'vitest';

import { rewrite } from '../src/sql/dialect.js';
import { SnowflakeError } from '../src/sql/errors.js';

const ctx = {
  database: 'SNOWTEST',
  schema: 'PUBLIC',
  role: 'SYSADMIN',
  user: 'TEST',
  warehouse: 'SNOWTEST_WH',
};

const run = (sql: string) => rewrite(sql, ctx, []);

describe('FLATTEN translation', () => {
  it('turns a lateral FLATTEN into a json_each join with the six columns', () => {
    const sql = run('SELECT f.value FROM t, LATERAL FLATTEN(input => t.v) f');
    expect(sql).toContain('JSON_EACH(T.V)');
    for (const column of ['"SEQ"', '"KEY"', '"PATH"', '"INDEX"', '"VALUE"', '"THIS"']) {
      expect(sql).toContain(`AS ${column}`);
    }
    expect(sql).toContain('F.VALUE');
  });

  it('expands TABLE(FLATTEN(…)) without a lateral keyword', () => {
    const sql = run("SELECT value FROM TABLE(FLATTEN(input => parse_json('[1,2]'))) ");
    expect(sql).not.toContain('TABLE(');
    expect(sql).toContain('JSON_EACH(');
    expect(sql).toContain('AS FLATTEN_0');
  });

  it('takes a quoted alias as written instead of generating one', () => {
    const sql = run('SELECT "f".key FROM t, LATERAL FLATTEN(input => t.v) AS "f"');
    expect(sql).toContain('AS "f"');
    expect(sql).not.toContain('FLATTEN_0');
  });

  it('keeps a row for empty input with outer => TRUE', () => {
    const sql = run('SELECT f.value FROM t, LATERAL FLATTEN(input => t.v, outer => TRUE) f');
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain('ON TRUE');
  });

  it('honours mode and path', () => {
    expect(run("SELECT f.value FROM t, LATERAL FLATTEN(input => t.v, mode => 'OBJECT') f")).toContain(
      "JSON_TYPE(T.V) = 'OBJECT'",
    );
    // The path prefix is emitted as a SQL literal, so the quotes double up.
    expect(run("SELECT f.value FROM t, LATERAL FLATTEN(input => t.v, path => 'a') f")).toContain(
      "[''a'']",
    );
  });

  it('refuses recursive => TRUE instead of approximating it', () => {
    expect(() => run('SELECT f.value FROM t, LATERAL FLATTEN(input => t.v, recursive => TRUE) f')).toThrow(
      /recursive => TRUE is not supported on snowtest/,
    );
  });

  it('rejects positional and unknown arguments', () => {
    expect(() => run('SELECT f.value FROM t, LATERAL FLATTEN(t.v) f')).toThrow(SnowflakeError);
    expect(() => run('SELECT f.value FROM t, LATERAL FLATTEN(input => t.v, colour => 1) f')).toThrow(
      /Invalid FLATTEN argument/,
    );
  });
});
