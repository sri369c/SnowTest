// Copyright (c) 2026 Srinivas Chaturvedula

import { describe, expect, it, vi } from 'vitest';

import {
  PREVIEW_LIMIT,
  formatValue,
  renderMissing,
  renderPreview,
  renderSchema,
} from '../src/pages/browse.js';
import type { SnowtestConfig } from '../src/config/server-config.js';
import { HOME_TABS, renderHome } from '../src/pages/home.js';

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

describe('cell formatting', () => {
  it('marks NULL rather than showing an empty cell', () => {
    expect(formatValue(null)).toBe('<span class="null">NULL</span>');
    expect(formatValue(undefined)).toBe('<span class="null">NULL</span>');
  });

  it('renders dates, bigints and booleans as text', () => {
    expect(formatValue(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02 03:04:05.000');
    expect(formatValue(123n)).toBe('123');
    expect(formatValue(true)).toBe('true');
  });

  it('leaves the time off a DATE column', () => {
    expect(formatValue(new Date('2026-01-02T00:00:00.000Z'), 'DATE')).toBe('2026-01-02');
    expect(formatValue(new Date('2026-01-02T03:04:05.000Z'), 'TIMESTAMP')).toBe(
      '2026-01-02 03:04:05.000',
    );
  });

  it('describes binary values instead of dumping bytes', () => {
    expect(formatValue(new Uint8Array([1, 2, 3]))).toContain('3 bytes');
  });

  it('serialises objects as JSON', () => {
    expect(formatValue({ a: [1, 2] })).toBe('{&quot;a&quot;:[1,2]}');
  });

  it('truncates long values', () => {
    const out = formatValue('x'.repeat(200));
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThan(200);
  });

  it('escapes markup in values', () => {
    expect(formatValue('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });
});

describe('schema page', () => {
  const html = renderSchema('SNOWTEST', 'EXAMPLES', [
    { name: 'CUSTOMERS', kind: 'TABLE', rows: 2500 },
    { name: 'ORDERS_V', kind: 'VIEW', rows: null },
  ]);

  it('lists every object with a link and a count', () => {
    expect(html).toContain('/browse/SNOWTEST/EXAMPLES/CUSTOMERS');
    expect(html).toContain('2,500');
    expect(html).toContain('view');
    expect(html).toContain('1 table(s), 1 view(s)');
  });

  it('shows a dash when a count could not be read', () => {
    expect(html).toContain('<span class="null">—</span>');
  });

  it('says so when the schema is empty', () => {
    const empty = renderSchema('SNOWTEST', 'PUBLIC', []);
    expect(empty).toContain('no tables or views');
  });

  it('sits under Home → Live state and links back to it', () => {
    expect(html).toContain('<a href="/" aria-current="page">Home</a>');
    expect(html).toContain('<a class="tab" href="/#live" aria-current="page">Live state</a>');
    expect(html).toContain('<a href="/#live">&larr; Live state</a>');
    expect(html).not.toContain('<footer');
  });
});

describe('preview page', () => {
  const preview = {
    database: 'SNOWTEST',
    schema: 'EXAMPLES',
    table: 'CUSTOMERS',
    kind: 'TABLE',
    columns: [
      { name: 'ID', duckType: 'BIGINT' },
      { name: 'NAME', duckType: 'VARCHAR' },
    ],
    rows: [
      [1, 'acme'],
      [2, null],
    ],
    total: 99,
  };

  it('renders column names and their types', () => {
    const html = renderPreview(preview);
    expect(html).toContain('ID<span class="note">bigint</span>');
    expect(html).toContain('NAME<span class="note">varchar</span>');
  });

  it('states how many rows are shown of how many', () => {
    const html = renderPreview(preview);
    expect(html).toContain('Showing the first 2 rows of 99.');
    expect(html).toContain('A capped preview: these are the first 2 of 99 rows.');
  });

  it('does not call a complete table a capped preview', () => {
    const html = renderPreview({ ...preview, rows: [[1, 'acme']], total: 1 });
    expect(html).toContain('1 row in total.');
    expect(html).toContain('The whole table, read-only.');
    expect(html).not.toContain('capped preview');
  });

  it('renders one cell per column, including NULLs', () => {
    const html = renderPreview(preview);
    expect(html.match(/<td>/g)?.length).toBe(4);
    expect(html).toContain('<span class="null">NULL</span>');
  });

  it('handles an empty result', () => {
    const html = renderPreview({ ...preview, rows: [], total: 0 });
    expect(html).toContain('No rows.');
    expect(html).toContain('0 rows in total.');
    expect(html).toContain('The whole table, read-only.');
  });

  it('caps at the documented limit', () => {
    expect(PREVIEW_LIMIT).toBe(50);
  });

  it('escapes a hostile table name', () => {
    const html = renderPreview({ ...preview, table: '<img onerror=x>' });
    expect(html).not.toContain('<img onerror=x>');
  });
});

describe('missing objects', () => {
  it('offers the way back', () => {
    const html = renderMissing('Schema not found', 'No schema A.B in this account.');
    expect(html).toContain('Schema not found');
    expect(html).toContain('<a href="/#live">Back to live state</a>');
  });
});

describe('landing page', () => {
  it('links each schema to its browser page', () => {
    const html = renderHome(config, 'http://localhost:3030', '8.42.0', {
      databases: [{ name: 'SNOWTEST', schemas: [{ name: 'EXAMPLES', tables: 5, views: 0 }] }],
      warehouses: ['SNOWTEST_WH'],
      roles: ['SYSADMIN'],
      stages: 0,
      queries: [],
      queryCount: 0,
      sessions: [],
    });
    expect(html).toContain('href="/browse/SNOWTEST/EXAMPLES"');
    expect(html).toContain('Select a schema to list its tables');
  });

  it('shows session start in server time and its length', () => {
    vi.useFakeTimers();
    try {
      const createdAt = new Date(2026, 10, 12, 9, 5, 7);
      vi.setSystemTime(createdAt.getTime() + (3600 + 2 * 60 + 5) * 1000);
      const html = renderHome(config, 'http://localhost:3030', '8.42.0', {
        databases: [],
        warehouses: [],
        roles: [],
        stages: 0,
        queries: [],
        queryCount: 0,
        sessions: [
          { user: 'DBT_SVC', database: 'SNOWTEST', schema: 'DBT_TEST', role: 'SYSADMIN', createdAt },
        ],
      });
      expect(html).toContain('<th>Started (server time)</th><th>Length</th>');
      expect(html).toMatch(/<td>2026-11-12 09:05:07 [^<]+<\/td><td>1h 02m 05s<\/td>/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps Query timings a tab of its own, right before Clear Data', () => {
    // The strip is generated from HOME_TABS, so a reshuffle there is exactly what
    // would move or lose this pane without anything else noticing.
    const labels = HOME_TABS.map((tab) => tab.label);
    expect(labels).toContain('Query timings');
    expect(labels.indexOf('Query timings')).toBe(labels.indexOf('Clear Data') - 1);

    const html = renderHome(config, 'http://localhost:3030', '8.42.0', {
      databases: [],
      warehouses: ['SNOWTEST_WH'],
      roles: ['SYSADMIN'],
      stages: 0,
      queries: [
        {
          queryText: 'SELECT 1 AS ONE',
          startedAt: new Date(2026, 10, 12, 9, 5, 7),
          elapsedMs: 4,
          rowsProduced: 1,
          status: 'SUCCESS',
          user: 'SNOWTEST_USER',
        },
      ],
      queryCount: 1,
      sessions: [],
    });

    // Hyphens are excluded on purpose: the Connect tab's own sub-tabs share this
    // markup, and they are not part of the strip being checked.
    const ids = [...html.matchAll(/data-tab="([a-z]+)"/g)].map((match) => match[1]);
    expect(ids).toContain('timings');
    expect(ids.indexOf('timings')).toBe(ids.indexOf('clear') - 1);

    const pane = html.slice(html.indexOf('id="pane-timings"'), html.indexOf('id="pane-clear"'));
    expect(pane).toContain('SELECT 1 AS ONE');
    expect(pane).toContain('4ms');
    expect(pane).toContain('SNOWTEST_USER');
  });
});
