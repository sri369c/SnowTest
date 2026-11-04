// Copyright (c) 2026 Srinivas Chaturvedula

/** `SNOWTEST_DATA_DIR`: one DuckDB file per database, plus `stages.json` for stage definitions. */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { StageDef } from './catalog.js';

const DATABASE_SUFFIX = '.duckdb';
const STAGES_FILE = 'stages.json';

/** Windows can keep a handle for a moment after DuckDB releases the file, so retry deletes. */
export const REMOVE_OPTIONS = { force: true, maxRetries: 10, retryDelay: 50 } as const;

export type PersistedStage = Pick<StageDef, 'database' | 'schema' | 'name' | 'url'>;

export class DataDir {
  private constructor(readonly root: string) {}

  static async open(root: string): Promise<DataDir> {
    const absolute = resolve(root);
    await mkdir(absolute, { recursive: true });
    return new DataDir(absolute);
  }

  databaseFile(name: string): string {
    return join(this.root, `${encodeURIComponent(name)}${DATABASE_SUFFIX}`);
  }

  /** Database names that have a file on disk. */
  async databases(): Promise<string[]> {
    return (await readdir(this.root))
      .filter((file) => file.endsWith(DATABASE_SUFFIX))
      .map((file) => decodeURIComponent(file.slice(0, -DATABASE_SUFFIX.length)))
      .sort();
  }

  /** Delete a detached database's file and its write-ahead log. */
  async removeDatabase(name: string): Promise<void> {
    const file = this.databaseFile(name);
    await rm(file, REMOVE_OPTIONS);
    await rm(`${file}.wal`, REMOVE_OPTIONS);
  }

  async loadStages(): Promise<PersistedStage[]> {
    let text: string;
    try {
      text = await readFile(join(this.root, STAGES_FILE), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error(`${join(this.root, STAGES_FILE)} is not a JSON array.`);
    return parsed as PersistedStage[];
  }

  async saveStages(stages: Iterable<StageDef>): Promise<void> {
    const rows: PersistedStage[] = [...stages].map(({ database, schema, name, url }) => ({
      database,
      schema,
      name,
      url,
    }));
    await writeFile(join(this.root, STAGES_FILE), `${JSON.stringify(rows, null, 2)}\n`);
  }

  /** Remove every database file and the stage list. Databases must be detached first. */
  async clear(): Promise<void> {
    for (const name of await this.databases()) await this.removeDatabase(name);
    await rm(join(this.root, STAGES_FILE), REMOVE_OPTIONS);
  }
}
