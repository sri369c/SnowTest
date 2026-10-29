// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * Internal stages, backed by the local filesystem.
 *
 * Snowflake clients treat `PUT`/`GET` as a two-phase handshake: the SQL call
 * returns a stage descriptor, then the client moves the bytes itself. The
 * connector supports a `LOCAL_FS` stage type for exactly this case, which lets
 * snowtest implement staging with real files on disk instead of emulating
 * cloud object storage and presigned URLs.
 *
 * Every stage therefore owns a directory; `@stage/path` maps onto a path inside
 * it and nothing outside it.
 */

import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

import { normalizeName } from './catalog.js';

export interface StagedFile {
  /** Path relative to the stage root, e.g. `orders/data.csv`. */
  name: string;
  size: number;
  modified: Date;
}

function safeSegment(part: string): string {
  return normalizeName(part).replace(/[^\w$.-]/g, '_');
}

export class StageStore {
  private readonly root: string;

  constructor(root = process.env.SNOWTEST_STAGE_ROOT || join(tmpdir(), `snowtest-stages-${process.pid}`)) {
    this.root = root;
  }

  /** Directory that backs one stage. Created on demand. */
  async directoryFor(database: string, schema: string, name: string): Promise<string> {
    const directory = join(this.root, safeSegment(database), safeSegment(schema), safeSegment(name));
    await mkdir(directory, { recursive: true });
    return directory;
  }

  /**
   * Resolve a stage-relative path to an absolute one, refusing anything that
   * would escape the stage directory (`@stage/../../etc/passwd`).
   */
  resolveWithin(directory: string, stagePath: string): string {
    const cleaned = stagePath.replace(/^@?[^/]*\//, '').replace(/^\/+/, '');
    const target = resolve(directory, cleaned);
    const base = resolve(directory);
    if (target !== base && !target.startsWith(base + sep)) {
      throw new Error(`Path '${stagePath}' escapes the stage directory.`);
    }
    return target;
  }

  /** Files under a directory, relative to it, filtered by SQL `LIKE` pattern. */
  async list(directory: string, pattern?: string | null): Promise<StagedFile[]> {
    const out: StagedFile[] = [];

    const walk = async (current: string, prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const absolute = join(current, entry.name);
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(absolute, relative);
          continue;
        }
        const info = await stat(absolute);
        out.push({ name: relative, size: info.size, modified: info.mtime });
      }
    };

    await walk(directory, '');
    const sorted = out.sort((a, b) => a.name.localeCompare(b.name));
    if (!pattern) return sorted;

    const regex = new RegExp(
      `^${pattern
        .replace(/^'|'$/g, '')
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/%/g, '.*')
        .replace(/_/g, '.')}$`,
      'i',
    );
    return sorted.filter((file) => regex.test(basename(file.name)) || regex.test(file.name));
  }

  /** Delete files under a stage (optionally restricted to a sub-path). */
  async remove(directory: string, stagePath?: string | null): Promise<number> {
    const files = await this.list(directory, null);
    const wanted = stagePath
      ? files.filter((file) => file.name === stagePath || file.name.startsWith(`${stagePath}/`))
      : files;
    for (const file of wanted) {
      await rm(join(directory, file.name), { force: true });
    }
    return wanted.length;
  }

  /** Delete an explicit list of stage-relative files. */
  async removeFiles(directory: string, names: string[]): Promise<number> {
    for (const name of names) {
      await rm(join(directory, name), { force: true });
    }
    return names.length;
  }

  async removeAll(directory: string): Promise<void> {
    await rm(directory, { recursive: true, force: true });
  }
}
