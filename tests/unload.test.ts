// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * `COPY INTO @stage` unload.
 *
 * The dbt suite drives this through a real connector, which proves a full round
 * trip. What a round trip cannot see is the naming and refusal rules: a file that
 * a test asserts on has to be named the way Snowflake names it, and the shapes a
 * stub cannot reproduce have to be refused by name instead of returning something
 * plausible.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Session } from '../src/engine/session.js';
import { StatementRouter } from '../src/sql/meta.js';
import { createServer, type SnowtestServer } from '../src/server.js';

const STAGE = 'SNOWTEST.PUBLIC.UNLOAD_STAGE';

let root: string;
let server: SnowtestServer;
let router: StatementRouter;
let nextId = 1;

const newSession = (): Session =>
  new Session(
    {
      id: nextId++,
      user: 'T',
      role: 'SYSADMIN',
      database: 'SNOWTEST',
      schema: 'PUBLIC',
      warehouse: 'SNOWTEST_WH',
    },
    server.catalog,
  );

const unload = (session: Session, sql: string): ReturnType<StatementRouter['execute']> =>
  router.execute(sql, session);

const stageFile = (...segments: string[]): string =>
  join(root, 'SNOWTEST', 'PUBLIC', 'UNLOAD_STAGE', ...segments);

const listed = async (session: Session): Promise<string[]> =>
  (await router.execute(`list @${STAGE}`, session)).rows.map((row) => String(row[0]));

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'snowtest-unload-'));
  // StageStore reads this when it is constructed, so it has to be set first.
  process.env.SNOWTEST_STAGE_ROOT = root;
  server = await createServer({ dataDir: null });
  router = new StatementRouter(server.engine, server.catalog);

  const session = newSession();
  await router.execute(`create or replace stage ${STAGE}`, session);
  await router.execute('create or replace table u (n int, s text)', session);
  await router.execute("insert into u values (1, 'a'), (2, 'b')", session);
});

afterAll(async () => {
  await server.close();
  delete process.env.SNOWTEST_STAGE_ROOT;
  await rm(root, { recursive: true, force: true });
});

describe('unloading to a stage', () => {
  it('writes a gzipped csv under the parallel-unload name and reports its counters', async () => {
    const session = newSession();
    const outcome = await unload(session, `copy into @${STAGE} from (select n from u)`);

    expect(outcome.columns.map((column) => column.name)).toEqual([
      'rows_unloaded',
      'input_bytes',
      'output_bytes',
    ]);
    expect(outcome.rows).toHaveLength(1);
    expect(Number(outcome.rows[0][0])).toBe(2);
    expect(Number(outcome.rows[0][2])).toBeGreaterThan(0);

    // COMPRESSION defaults to AUTO, which Snowflake means as gzip for CSV.
    const bytes = await readFile(stageFile('data_0_0_0.csv.gz'));
    expect(bytes.subarray(0, 2).toString('hex')).toBe('1f8b');
  });

  it('honours HEADER, FIELD_DELIMITER and a path that names the file', async () => {
    const session = newSession();
    await unload(
      session,
      `copy into @${STAGE}/out.txt from (select n from u) header = true field_delimiter = '|' compression = none`,
    );

    // The unquoted column folds to uppercase, as Snowflake folds it.
    expect(await readFile(stageFile('out.txt'), 'utf8')).toBe('N\n1\n2\n');
  });

  it('unloads a table named without parentheses', async () => {
    const session = newSession();
    const outcome = await unload(session, `copy into @${STAGE}/t/ from SNOWTEST.PUBLIC.u`);
    expect(Number(outcome.rows[0][0])).toBe(2);
  });

  it('names the single file `data` when SINGLE = TRUE', async () => {
    const session = newSession();
    await unload(session, `copy into @${STAGE}/single/ from (select n from u) single = true`);
    expect((await listed(session)).some((name) => name.endsWith('single/data'))).toBe(true);
  });

  it('refuses to replace an existing file without OVERWRITE', async () => {
    const session = newSession();
    const sql = `copy into @${STAGE}/twice.csv from (select n from u) file_format = (type = csv, compression = none)`;

    await unload(session, sql);
    await expect(unload(session, sql)).rejects.toThrow(/already exists/);
    await expect(unload(session, `${sql} overwrite = true`)).resolves.toBeTruthy();
  });

  it('writes no file and reports zeros for a query that returns nothing', async () => {
    const session = newSession();
    const outcome = await unload(
      session,
      `copy into @${STAGE}/empty/data.csv from (select n from u where n > 99) compression = none`,
    );

    expect(outcome.rows[0].map(String)).toEqual(['0', '0', '0']);
    await expect(stat(stageFile('empty', 'data.csv'))).rejects.toThrow();
  });

  it('unloads parquet and loads it back', async () => {
    const session = newSession();
    // Its own stage: a load from `@stage/p/` also accepts a flat file at the stage
    // root, which is how PUT lands `@stage/data/x.csv` as `x.csv`.
    await router.execute('create or replace stage SNOWTEST.PUBLIC.PARQUET_STAGE', session);
    const outcome = await unload(
      session,
      'copy into @SNOWTEST.PUBLIC.PARQUET_STAGE/p/ from (select n from u) file_format = (type = parquet)',
    );
    expect(Number(outcome.rows[0][0])).toBe(2);

    await router.execute('create or replace table p (n int)', session);
    await router.execute(
      'copy into SNOWTEST.PUBLIC.p from @SNOWTEST.PUBLIC.PARQUET_STAGE/p/ file_format = (type = parquet)',
      session,
    );
    expect(Number((await router.execute('select count(*) from p', session)).rows[0][0])).toBe(2);
  });

  it('encloses with the character FIELD_OPTIONALLY_ENCLOSED_BY names', async () => {
    const session = newSession();
    await router.execute('create or replace table commas (s text)', session);
    await router.execute("insert into commas values ('a,b'), ('plain')", session);

    await unload(
      session,
      `copy into @${STAGE}/enclosed.csv from (select s from commas) field_optionally_enclosed_by = '@' compression = none`,
    );

    // Only the value that needs it: FIELD_OPTIONALLY_ENCLOSED_BY, not always.
    expect(await readFile(stageFile('enclosed.csv'), 'utf8')).toBe('S\n@a,b@\nplain\n');
  });

  it('quotes nothing by default, because Snowflake unloads as NONE', async () => {
    const session = newSession();
    await router.execute('create or replace table commas (s text)', session);
    await router.execute("insert into commas values ('a,b'), ('plain')", session);

    await unload(session, `copy into @${STAGE}/unquoted.csv from (select s from commas) compression = none`);

    // Snowflake writes the delimiter inside the value rather than quoting to escape it.
    expect(await readFile(stageFile('unquoted.csv'), 'utf8')).toBe('S\na,b\nplain\n');
  });

  it('writes the first NULL_IF value in place of a null', async () => {
    const session = newSession();
    await router.execute('create or replace table nulls (s text)', session);
    await router.execute("insert into nulls values (NULL), ('x')", session);

    await unload(
      session,
      `copy into @${STAGE}/nulls.csv from (select s from nulls) file_format = (type = csv, compression = none, null_if = ('NULL', 'nil'))`,
    );

    expect(await readFile(stageFile('nulls.csv'), 'utf8')).toBe('S\nNULL\nx\n');
  });

  it('refuses what it cannot reproduce, by name', async () => {
    const session = newSession();

    await expect(
      unload(session, `copy into @${STAGE}/x/ from (select n from u) partition by ('n')`),
    ).rejects.toThrow(/PARTITION BY/);
    await expect(unload(session, `copy into @~ from (select n from u)`)).rejects.toThrow(/user or table stage/);
    await expect(
      unload(session, `copy into @${STAGE}/x/ from (select n from u) file_format = (type = json)`),
    ).rejects.toThrow(/JSON/);
  });

  it('will not write outside the stage directory', async () => {
    const session = newSession();
    await expect(
      unload(session, `copy into @${STAGE}/../../escape.csv from (select n from u)`),
    ).rejects.toThrow(/inside the stage/);
  });
});
