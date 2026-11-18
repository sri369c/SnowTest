// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * Stage internals. The dbt suite drives PUT/LIST/GET/REMOVE through a real
 * connector, which proves the happy path works; nothing covered the store
 * itself. What keeps a stage path inside its directory is that every name it
 * handles comes from walking that directory, which these tests exercise.
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { StageStore } from '../src/sql/stage.js';

let root: string;
let store: StageStore;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'snowtest-stage-'));
  store = new StageStore(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('stage directories', () => {
  it('nests one directory per database, schema and stage', async () => {
    const directory = await store.directoryFor('SNOWTEST', 'PUBLIC', 'MY_STAGE');
    expect(directory).toBe(join(root, 'SNOWTEST', 'PUBLIC', 'MY_STAGE'));
  });

  it('turns path-unsafe characters into underscores instead of creating paths', async () => {
    const directory = await store.directoryFor('../escape', 'PUBLIC', 'my stage');
    expect(directory.startsWith(root + sep)).toBe(true);
    expect(directory).toBe(join(root, '.._escape', 'PUBLIC', 'my_stage'));
  });
});

describe('listing and removal', () => {
  it('walks sub-directories, sorts by name, and filters on a LIKE pattern', async () => {
    const directory = await store.directoryFor('SNOWTEST', 'PUBLIC', 'S2');
    await mkdir(join(directory, 'orders'), { recursive: true });
    await writeFile(join(directory, 'customers.csv'), 'a,b\n');
    await writeFile(join(directory, 'orders', '2024.csv'), 'x');
    await writeFile(join(directory, 'orders', '2025.csv'), 'yy');

    const all = await store.list(directory);
    expect(all.map((file) => file.name)).toEqual(['customers.csv', 'orders/2024.csv', 'orders/2025.csv']);
    expect(all.find((file) => file.name === 'orders/2025.csv')!.size).toBe(2);

    expect((await store.list(directory, "'%.csv'")).length).toBe(3);
    expect((await store.list(directory, "'orders/%'")).map((file) => file.name)).toEqual([
      'orders/2024.csv',
      'orders/2025.csv',
    ]);
    expect((await store.list(directory, "'ORDERS/%'")).length).toBe(2);
    expect((await store.list(directory, "'customers.cs_'")).map((file) => file.name)).toEqual(['customers.csv']);
  });

  it('returns nothing for a directory that does not exist', async () => {
    expect(await store.list(join(root, 'no-such-stage'))).toEqual([]);
  });

  it('removes one sub-path and leaves the rest', async () => {
    const directory = await store.directoryFor('SNOWTEST', 'PUBLIC', 'S3');
    await mkdir(join(directory, 'orders'), { recursive: true });
    await writeFile(join(directory, 'customers.csv'), 'a,b\n');
    await writeFile(join(directory, 'orders', '2024.csv'), 'x');
    await writeFile(join(directory, 'orders', '2025.csv'), 'yy');

    expect(await store.remove(directory, 'orders')).toBe(2);
    expect((await store.list(directory)).map((file) => file.name)).toEqual(['customers.csv']);

    expect(await store.remove(directory, null)).toBe(1);
    expect(await store.list(directory)).toEqual([]);
  });

  it('removes an explicit list of files', async () => {
    const directory = await store.directoryFor('SNOWTEST', 'PUBLIC', 'S4');
    await writeFile(join(directory, 'a.csv'), '1');
    await writeFile(join(directory, 'b.csv'), '2');

    expect(await store.removeFiles(directory, ['a.csv'])).toBe(1);
    expect((await store.list(directory)).map((file) => file.name)).toEqual(['b.csv']);
  });

  it('drops one schema of stages without touching the others', async () => {
    const publicStage = await store.directoryFor('SNOWTEST', 'PUBLIC', 'S5');
    const otherSchema = await store.directoryFor('SNOWTEST', 'OTHER', 'S5');
    const otherDatabase = await store.directoryFor('OTHERDB', 'PUBLIC', 'S5');
    for (const directory of [publicStage, otherSchema, otherDatabase]) {
      await writeFile(join(directory, 'file.csv'), 'x');
    }

    await store.removeScope('SNOWTEST', 'PUBLIC');
    await expect(stat(publicStage)).rejects.toThrow();
    expect((await store.list(otherSchema)).length).toBe(1);
    expect((await store.list(otherDatabase)).length).toBe(1);

    await store.removeScope('SNOWTEST');
    await expect(stat(otherSchema)).rejects.toThrow();
    expect((await store.list(otherDatabase)).length).toBe(1);
  });

  it('removes a whole stage directory on DROP STAGE', async () => {
    const directory = await store.directoryFor('SNOWTEST', 'PUBLIC', 'S6');
    await writeFile(join(directory, 'file.csv'), 'x');

    await store.removeAll(directory);
    await expect(stat(directory)).rejects.toThrow();
  });
});
