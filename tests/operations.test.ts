// Copyright (c) 2026 Srinivas Chaturvedula

import { describe, expect, it } from 'vitest';

import type { SnowtestConfig } from '../src/config.js';
import { renderHome } from '../src/home.js';
import { GROUPS, LANDING_SURFACES, UNSUPPORTED, renderOperations } from '../src/operations.js';
import { escapeHtml, inlineMarkup } from '../src/page.js';

const STATUSES = new Set(['supported', 'partial', 'unsupported']);

const config: SnowtestConfig = {
  port: 3030,
  host: '127.0.0.1',
  account: 'SNOWTEST',
  defaultDatabase: 'SNOWTEST',
  defaultSchema: 'PUBLIC',
  defaultWarehouse: 'SNOWTEST_WH',
  defaultRole: 'SYSADMIN',
  users: [],
  jwtPublicKey: null,
  databases: [{ name: 'SNOWTEST', schemas: ['PUBLIC'] }],
  warehouses: ['SNOWTEST_WH'],
  roles: ['SYSADMIN'],
  verbose: false,
  dataDir: null,
  clock: null,
};

const home = (): string =>
  renderHome(config, 'http://localhost:3030', '8.42.0', {
    databases: [],
    warehouses: ['SNOWTEST_WH'],
    roles: ['SYSADMIN'],
    stages: 0,
    queries: [],
    queryCount: 0,
    sessions: [],
  });

describe('operations data', () => {
  it('gives every group a unique anchor and at least one row', () => {
    const ids = GROUPS.map((group) => group.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const group of GROUPS) {
      expect(group.rows.length, `${group.id} is empty`).toBeGreaterThan(0);
    }
  });

  it('gives every row a syntax, a behaviour and a known status', () => {
    for (const group of GROUPS) {
      for (const row of group.rows) {
        expect(row.syntax.trim(), group.id).not.toBe('');
        expect(row.behaviour.trim(), `${group.id}: ${row.syntax}`).not.toBe('');
        expect(STATUSES.has(row.status), `${group.id}: ${row.syntax}`).toBe(true);
      }
    }
  });

  it('dates every row to a release, and only to a release that exists', () => {
    const known = new Set(['1.0.0', '2.0.0', '3.0.0', '3.0.1', '3.1.0', '3.1.1', '3.2.0', '3.3.0', '4.0.0', '4.1.0']);
    for (const group of GROUPS) {
      for (const row of group.rows) {
        expect(row.since, `${group.id}: ${row.syntax}`).toMatch(/^\d+\.\d+\.\d+$/);
        expect(known.has(row.since), `${group.id}: ${row.syntax} says ${row.since}`).toBe(true);
      }
    }
  });

  it('makes every partial row say what is missing', () => {
    for (const group of GROUPS) {
      for (const row of group.rows.filter((entry) => entry.status === 'partial')) {
        expect(row.note, `${group.id}: ${row.syntax} is partial without a note`).toBeTruthy();
      }
    }
  });

  it('lists each unsupported feature once', () => {
    const features = UNSUPPORTED.map((item) => item.feature);
    expect(new Set(features).size).toBe(features.length);
    for (const item of UNSUPPORTED) {
      expect(item.outcome.trim(), item.feature).not.toBe('');
    }
  });

  it('summarises groups that exist on the reference page', () => {
    expect(LANDING_SURFACES.length).toBeGreaterThan(0);
    for (const surface of LANDING_SURFACES) {
      const group = GROUPS.find((entry) => entry.id === surface.id);
      expect(group, `${surface.id} is summarised but missing`).toBeDefined();
      expect(group?.landingLabel).toBe(surface.label);
      expect(surface.total).toBe(group?.rows.length);
    }
  });
});

describe('operations page', () => {
  const html = renderOperations('8.42.0');

  it('has a tab and a panel per group, without scroll targets on the tab keys', () => {
    for (const group of GROUPS) {
      expect(html).toContain(`data-tab="${group.id}"`);
      expect(html).toContain(`id="pane-${group.id}"`);
      expect(html).not.toContain(`id="${group.id}"`);
      expect(html).toContain(escapeHtml(group.title));
    }
  });

  it('numbers rows from 1 in every table', () => {
    const firsts = html.match(/<td class="rn">1<\/td>/g) ?? [];
    expect(firsts.length).toBe(GROUPS.length + 1);
  });

  it('renders every row and every unsupported feature', () => {
    for (const group of GROUPS) {
      for (const row of group.rows) {
        expect(html).toContain(inlineMarkup(row.behaviour));
      }
    }
    for (const item of UNSUPPORTED) {
      expect(html).toContain(inlineMarkup(item.feature));
    }
    expect(html).toContain('id="pane-not-supported"');
  });

  it('shows the release each row arrived in', () => {
    expect(html).toContain('>Since</th>');
    for (const group of GROUPS) {
      for (const row of group.rows) {
        expect(html, `${group.id}: ${row.syntax}`).toContain(`<td class="since">${row.since}</td>`);
      }
    }
  });

  it('marks itself in the nav and names the emulated version', () => {
    expect(html).toContain('<a href="/operations" aria-current="page">');
    expect(html).toContain('emulating Snowflake 8.42.0');
  });

  it('escapes markup in the data', () => {
    const hostile = '<script>alert(1)</script>';
    expect(renderOperations(hostile)).not.toContain(hostile);
    expect(renderOperations(hostile)).toContain('&lt;script&gt;');
  });
});

describe('landing page', () => {
  const html = home();

  it('links to the reference', () => {
    expect(html).toContain('<a href="/operations">');
  });

  it('summarises the same groups the reference lists', () => {
    for (const surface of LANDING_SURFACES) {
      expect(html).toContain(`href="/operations#${surface.id}"`);
      expect(html).toContain(`${surface.supported} of ${surface.total} supported`);
    }
  });

  it('keeps live state refreshable in place', () => {
    expect(html).toContain('id="live-body"');
    expect(html).toContain('id="live-refresh"');
    expect(html).not.toContain('Reload to refresh');
  });
});
