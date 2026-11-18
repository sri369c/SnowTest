// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * The running fidelity setting.
 *
 * `--fidelity` / `SNOWTEST_FIDELITY` pin the mode at start-up; a value applied
 * from the configuration page is saved beside the databases so it survives a
 * restart, and is ignored while a pin is in force. A flag that a web form could
 * quietly override would not be a pin, so the form refuses instead of lying.
 *
 * With no data directory the choice lives in memory for the life of the process,
 * which the configuration page says out loud rather than pretending to save.
 */

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FidelityMode } from './server-config.js';

export const FIDELITY_MODES: readonly FidelityMode[] = ['off', 'report', 'strict'];

/** What applying each mode actually changes, in the words the page shows. */
export const FIDELITY_IMPACT: Record<FidelityMode, string> = {
  off: 'Statements run exactly as in 4.x. QUERY_HISTORY still records them; MODEL_FIDELITY is not written.',
  report:
    'Every statement runs. MODEL_FIDELITY records each dbt model as verified or approximate, and nothing is ever refused.',
  strict:
    'A statement that would approximate a construct is refused before it executes, and nothing is written for it. A dbt run stops at the first such model.',
};

const SETTINGS_FILE = 'settings.json';

export interface FidelityState {
  /** What the next statement gets. */
  mode: FidelityMode;
  /** What the page saved last, even while a pin overrides it. */
  saved: FidelityMode | null;
  /** True when a start-up flag or environment variable fixed the mode. */
  pinned: boolean;
  /** True when there is a data directory, so the choice outlives the process. */
  persisted: boolean;
}

export class FidelitySetting {
  private saved: FidelityMode | null;

  private constructor(
    private readonly pinned: FidelityMode | null,
    private readonly file: string | null,
    saved: FidelityMode | null,
  ) {
    this.saved = saved;
  }

  static async open(
    root: string | null,
    configured: { mode: FidelityMode; pinned: boolean },
  ): Promise<FidelitySetting> {
    const file = root === null ? null : join(root, SETTINGS_FILE);
    let saved: FidelityMode | null = null;
    if (file) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { fidelity?: unknown };
        const value = typeof parsed.fidelity === 'string' ? parsed.fidelity.trim().toLowerCase() : '';
        if (FIDELITY_MODES.includes(value as FidelityMode)) saved = value as FidelityMode;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          process.stderr.write(
            `snowtest: ${file} could not be read, keeping the configured fidelity: ${String(error)}\n`,
          );
        }
      }
    }
    return new FidelitySetting(configured.pinned ? configured.mode : null, file, saved);
  }

  get mode(): FidelityMode {
    return this.pinned ?? this.saved ?? 'report';
  }

  get state(): FidelityState {
    return { mode: this.mode, saved: this.saved, pinned: this.pinned !== null, persisted: this.file !== null };
  }

  /** Apply a mode now and remember it. Refuses while a start-up pin is in force. */
  async apply(mode: FidelityMode): Promise<FidelityState> {
    if (this.pinned) {
      throw new Error(
        `fidelity is pinned to '${this.pinned}' by --fidelity or SNOWTEST_FIDELITY; unset it to change the mode here.`,
      );
    }
    this.saved = mode;
    if (this.file) await writeFile(this.file, `${JSON.stringify({ fidelity: mode }, null, 2)}\n`);
    return this.state;
  }
}
