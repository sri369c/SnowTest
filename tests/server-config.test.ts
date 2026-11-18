// Copyright (c) 2026 Srinivas Chaturvedula

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULTS, loadConfig, parseClock, parsePort } from '../src/config/server-config.js';
import { PACKAGE_VERSION, readPackageVersion } from '../src/config/version.js';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('configuration validation', () => {
  it('accepts a port between 1 and 65535, and 0 for a free one', () => {
    expect(parsePort('3131', '--port')).toBe(3131);
    expect(parsePort('0', '--port')).toBe(0);
    for (const bad of ['65536', '30a0', '-1', '', '3.5']) {
      expect(() => parsePort(bad, '--port'), bad).toThrow(/between 1 and 65535/);
    }
  });

  it('reads SNOWTEST_CLOCK as an instant or an offset, and refuses anything else', () => {
    expect(parseClock(undefined)).toBeNull();
    expect(parseClock('  ')).toBeNull();

    const fixed = parseClock('2026-01-31T09:00:00Z');
    expect(fixed?.kind).toBe('fixed');
    expect(fixed?.kind === 'fixed' ? fixed.at.toISOString() : null).toBe('2026-01-31T09:00:00.000Z');

    const ahead = parseClock('+30m');
    expect(ahead).toEqual({ kind: 'offset', ms: 30 * 60_000 });
    const behind = parseClock('-2h');
    expect(behind).toEqual({ kind: 'offset', ms: -2 * 3_600_000 });

    expect(() => parseClock('tomorrow')).toThrow(/SNOWTEST_CLOCK/);
  });

  it('rejects an invalid SNOWTEST_PORT instead of falling back', () => {
    process.env.SNOWTEST_PORT = 'eighty';
    expect(() => loadConfig()).toThrow(/SNOWTEST_PORT/);
  });

  it('rejects an invalid SNOWTEST_VERBOSE', () => {
    process.env.SNOWTEST_VERBOSE = 'yes';
    expect(() => loadConfig()).toThrow(/SNOWTEST_VERBOSE/);
  });

  it('keeps data in memory unless SNOWTEST_DATA_DIR is set', () => {
    delete process.env.SNOWTEST_DATA_DIR;
    expect(loadConfig().dataDir).toBe(DEFAULTS.dataDir);
    process.env.SNOWTEST_DATA_DIR = '/var/lib/snowtest/data';
    expect(loadConfig().dataDir).toBe('/var/lib/snowtest/data');
  });

  it('reads the version from package.json and refuses a missing or invalid one', () => {
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    const dir = mkdtempSync(join(tmpdir(), 'snowtest-version-'));
    try {
      const manifest = join(dir, 'package.json');
      expect(() => readPackageVersion(pathToFileURL(manifest))).toThrow(/Cannot read snowtest version/);
      writeFileSync(manifest, '{not json');
      expect(() => readPackageVersion(pathToFileURL(manifest))).toThrow(/Cannot parse snowtest version manifest/);
      writeFileSync(manifest, '{"name":"snowtest"}');
      expect(() => readPackageVersion(pathToFileURL(manifest))).toThrow(/no "version" string/);
      writeFileSync(manifest, '{"version":2}');
      expect(() => readPackageVersion(pathToFileURL(manifest))).toThrow(/no "version" string/);
      writeFileSync(manifest, '{"version":"9.9.9"}');
      expect(readPackageVersion(pathToFileURL(manifest))).toBe('9.9.9');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
