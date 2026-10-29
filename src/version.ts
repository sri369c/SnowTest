// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * Version reporting.
 *
 * Two different numbers get confused easily, so they live apart: snowtest's own
 * version comes from `package.json`, while `SERVER_VERSION` (in `protocol.ts`)
 * is the Snowflake release this stub imitates.
 */

import { readFileSync } from 'node:fs';

/**
 * Read the manifest at runtime rather than duplicating the number in source.
 * `src/` and `dist/` both sit one level below the package root, and the image
 * copies `package.json` next to `dist/`.
 */
function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const manifest = JSON.parse(raw) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const PACKAGE_VERSION = readPackageVersion();
