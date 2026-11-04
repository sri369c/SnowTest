// Copyright (c) 2026 Srinivas Chaturvedula

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULTS, loadConfig, parsePort } from '../src/config.js';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('configuration validation', () => {
  it('accepts a port between 1 and 65535 only', () => {
    expect(parsePort('3131', '--port')).toBe(3131);
    for (const bad of ['0', '65536', '30a0', '-1', '', '3.5']) {
      expect(() => parsePort(bad, '--port'), bad).toThrow(/between 1 and 65535/);
    }
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
});
