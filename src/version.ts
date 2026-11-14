// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * Version reporting.
 *
 * Two different numbers get confused easily, so they live apart: snowtest's own
 * version comes from `package.json`, while `SERVER_VERSION` (in `protocol.ts`)
 * is the Snowflake release this stub imitates.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Read the manifest at runtime rather than duplicating the number in source.
 * `src/` and `dist/` both sit one level below the package root, and the image
 * copies `package.json` next to `dist/`. Throws if it is unreadable, not JSON, or has no version.
 */
export function readPackageVersion(manifestUrl: URL = new URL('../package.json', import.meta.url)): string {
  const path = fileURLToPath(manifestUrl);
  let text: string;
  try {
    text = readFileSync(manifestUrl, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read snowtest version from ${path}: ${(error as Error).message}`);
  }
  let manifest: { version?: unknown };
  try {
    manifest = JSON.parse(text) as { version?: unknown };
  } catch (error) {
    throw new Error(`Cannot parse snowtest version manifest ${path} as JSON: ${(error as Error).message}`);
  }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error(`${path} has no "version" string.`);
  }
  return manifest.version;
}

export const PACKAGE_VERSION = readPackageVersion();
