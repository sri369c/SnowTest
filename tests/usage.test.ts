// Copyright (c) 2026 Srinivas Chaturvedula

import { describe, expect, it } from 'vitest';

import { DEFAULTS } from '../src/config.js';
import { ENV_ONLY, OPTIONS, helpText } from '../src/options.js';
import { renderUsage } from '../src/usage.js';

describe('option table', () => {
  it('lists every flag once', () => {
    const flags = OPTIONS.map((option) => option.flag);
    expect(new Set(flags).size).toBe(flags.length);
    for (const flag of flags) expect(flag.startsWith('--')).toBe(true);
  });

  it('gives every flag a description', () => {
    for (const option of OPTIONS) {
      expect(option.description.trim(), option.flag).not.toBe('');
    }
  });

  it('does not repeat an environment variable', () => {
    const envs = [
      ...OPTIONS.map((option) => option.env).filter((env): env is string => Boolean(env)),
      ...ENV_ONLY.map((entry) => entry.name),
    ];
    expect(new Set(envs).size).toBe(envs.length);
  });

  it('reads its defaults from the config module', () => {
    const port = OPTIONS.find((option) => option.flag === '--port');
    const host = OPTIONS.find((option) => option.flag === '--host');
    expect(port?.default).toBe(String(DEFAULTS.port));
    expect(host?.default).toBe(DEFAULTS.host);
    expect(ENV_ONLY.find((entry) => entry.name === 'SNOWTEST_ROLE')?.default).toBe(
      DEFAULTS.defaultRole,
    );
  });

  it('maps configurable flags onto real config fields', () => {
    const keys = OPTIONS.filter((option) => option.configKey).map((option) => option.configKey);
    for (const key of keys) {
      expect(Object.keys(DEFAULTS)).toContain(key);
    }
  });
});

describe('--help', () => {
  const text = helpText();

  it('mentions every flag and its environment variable', () => {
    for (const option of OPTIONS) {
      expect(text).toContain(option.flag);
      if (option.env) expect(text).toContain(option.env);
    }
  });

  it('shows the real defaults', () => {
    expect(text).toContain(`default ${DEFAULTS.port}`);
    expect(text).toContain(DEFAULTS.host);
  });

  it('keeps the connect snippet in step with the defaults', () => {
    expect(text).toContain(`account="${DEFAULTS.account}"`);
    expect(text).toContain(`port=${DEFAULTS.port}`);
  });
});

describe('usage page', () => {
  const html = renderUsage('8.42.0');

  it('has a section and a contents entry per heading', () => {
    for (const id of ['configuration', 'launcher', 'control-plane', 'staging', 'troubleshooting']) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`href="#${id}"`);
    }
  });

  it('renders the generated configuration tables', () => {
    for (const option of OPTIONS) {
      expect(html).toContain(option.flag);
    }
    for (const entry of ENV_ONLY) {
      expect(html).toContain(entry.name);
    }
    expect(html).toContain(String(DEFAULTS.port));
  });

  it('names the build it describes', () => {
    expect(html).toContain('emulating Snowflake 8.42.0');
  });

  it('links to the overview and the operations reference', () => {
    expect(html).toContain('<a href="/">&larr; Overview</a>');
    expect(html).toContain('href="/operations"');
  });

  it('covers the staging caveat', () => {
    expect(html).toContain('same absolute path');
  });

  it('escapes the version', () => {
    const hostile = renderUsage('<script>alert(1)</script>');
    expect(hostile).not.toContain('<script>alert(1)</script>');
    expect(hostile).toContain('&lt;script&gt;');
  });
});
