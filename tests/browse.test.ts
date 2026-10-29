// Copyright (c) 2026 Srinivas Chaturvedula

import { describe, expect, it } from 'vitest';

import {
  PREVIEW_LIMIT,
  formatValue,
  renderMissing,
  renderPreview,
  renderSchema,
} from '../src/browse.js';
import type { SnowtestConfig } from '../src/config.js';
import { renderHome } from '../src/home.js';

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

  it('links back to the overview', () => {
    expect(html).toContain('<a href="/">&larr; Overview</a>');
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
    expect(html).toContain('<a href="/">Back to the overview</a>');
  });
});

describe('landing page', () => {
  it('links each schema to its browser page', () => {
    const html = renderHome(config, 'http://localhost:3030', '8.42.0', {
      databases: [{ name: 'SNOWTEST', schemas: [{ name: 'EXAMPLES', tables: 5, views: 0 }] }],
      warehouses: ['SNOWTEST_WH'],
      roles: ['SYSADMIN'],
      stages: 0,
      sessions: [],
    });
    expect(html).toContain('href="/browse/SNOWTEST/EXAMPLES"');
    expect(html).toContain('Select a schema to list its tables');
  });
});
