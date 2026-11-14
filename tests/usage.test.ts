// Copyright (c) 2026 Srinivas Chaturvedula

import { describe, expect, it } from 'vitest';

import { DEFAULTS } from '../src/config.js';
import { ENV_ONLY, OPTIONS, helpText } from '../src/options.js';
import { renderConfiguration, renderTroubleshooting } from '../src/usage.js';

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

describe('configuration page', () => {
  const html = renderConfiguration('8.42.0');

  it('has a tab and a panel per section, keeping the old anchors', () => {
    for (const id of ['configuration', 'launcher', 'control-plane', 'staging']) {
      expect(html).toContain(`data-tab="${id}"`);
      expect(html).toContain(`id="pane-${id}"`);
      // A bare id would make the browser scroll to the panel on `#id`.
      expect(html).not.toContain(`id="${id}"`);
    }
    expect(html).not.toContain('data-tab="troubleshooting"');
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

  it('names the build it describes and marks itself in the nav', () => {
    expect(html).toContain('emulating Snowflake 8.42.0');
    expect(html).toContain('<a href="/configuration" aria-current="page">');
    expect(html).toContain('href="/troubleshooting"');
  });

  it('covers the staging caveat', () => {
    expect(html).toContain('same absolute path');
  });

  it('escapes the version', () => {
    const hostile = renderConfiguration('<script>alert(1)</script>');
    expect(hostile).not.toContain('<script>alert(1)</script>');
    expect(hostile).toContain('&lt;script&gt;');
  });
});

describe('troubleshooting page', () => {
  const html = renderTroubleshooting('8.42.0');

  it('numbers every symptom', () => {
    const numbers = [...html.matchAll(/<td class="rn">(\d+)<\/td>/g)].map((m) => Number(m[1]));
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    expect(html).toContain('<a href="/troubleshooting" aria-current="page">');
  });
});
