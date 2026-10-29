// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * The catalog browser: `/browse/<database>/<schema>` and one table's preview.
 *
 * Counts on the landing page tell you how much exists; this is how you look at
 * it. Both pages are read-only, rendered inline like the rest, and deliberately
 * capped — a preview of the first rows, not a query console. Anything bigger
 * belongs in a real client pointed at the same server.
 */

import { escapeHtml, renderPage } from './page.js';

/** Rows shown per preview. Small enough to stay a glance, not a table dump. */
export const PREVIEW_LIMIT = 50;

/** Longest cell value before it is truncated for display. */
const CELL_LIMIT = 120;

export interface BrowseTable {
  name: string;
  kind: string;
  rows: number | null;
}

export interface BrowseColumn {
  name: string;
  duckType: string;
}

export interface BrowsePreview {
  database: string;
  schema: string;
  table: string;
  kind: string;
  columns: BrowseColumn[];
  rows: unknown[][];
  total: number | null;
}

const browsePath = (database: string, schema: string, table?: string): string => {
  const base = `/browse/${encodeURIComponent(database)}/${encodeURIComponent(schema)}`;
  return table === undefined ? base : `${base}/${encodeURIComponent(table)}`;
};

const columnCount = (tables: BrowseTable[], kind: string): number =>
  tables.filter((table) => table.kind === kind).length;

/** `1 row`, `0 rows`, `50 rows` — no parenthesised plurals in the prose. */
const plural = (count: number, noun: string): string =>
  `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Render one cell. Values arrive as JS, not strings, so each type gets a shape.
 * The declared column type matters: a `DATE` is a `Date` at midnight, and
 * printing its time would invent a precision the column does not have.
 */
export function formatValue(value: unknown, duckType = ''): string {
  if (value === null || value === undefined) return '<span class="null">NULL</span>';
  if (value instanceof Date) {
    const iso = value.toISOString();
    if (/^DATE$/i.test(duckType.trim())) return escapeHtml(iso.slice(0, 10));
    return escapeHtml(iso.endsWith('Z') ? iso.slice(0, -1).replace('T', ' ') : iso);
  }
  if (typeof value === 'bigint') return escapeHtml(value.toString());
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Uint8Array) {
    return `<span class="null">&lt;${value.byteLength} bytes&gt;</span>`;
  }
  const text =
    typeof value === 'object' ? JSON.stringify(value) ?? '[object]' : String(value);
  if (text.length <= CELL_LIMIT) return escapeHtml(text);
  return `${escapeHtml(text.slice(0, CELL_LIMIT))}…`;
}

const pageHead = (database: string, schema: string, table?: string): string => {
  const databaseLink = escapeHtml(database);
  const schemaLink = table ? `<a href="${browsePath(database, schema)}">${escapeHtml(schema)}</a>` : escapeHtml(schema);
  const tail = table ? ` <span class="muted">/</span> <code>${escapeHtml(table)}</code>` : '';
  return `<p class="crumb"><a href="/">&larr; Overview</a> <span class="muted">/</span> ${databaseLink} <span class="muted">/</span> ${schemaLink}${tail}</p>`;
};

/** `/browse/<database>/<schema>`: the objects in one schema. */
export function renderSchema(
  database: string,
  schema: string,
  tables: BrowseTable[],
): string {
  const rows =
    tables
      .map((table) => {
        const name = `<a href="${browsePath(database, schema, table.name)}"><code>${escapeHtml(table.name)}</code></a>`;
        const count = table.rows === null ? '<span class="null">—</span>' : table.rows.toLocaleString('en-US');
        return `      <tr><td>${name}</td><td>${escapeHtml(table.kind.toLowerCase())}</td><td>${count}</td><td><a href="${browsePath(database, schema, table.name)}">preview</a></td></tr>`;
      })
      .join('\n') || '      <tr><td colspan="4">This schema has no tables or views.</td></tr>';

  const body = `${pageHead(database, schema)}
<span class="tag">snowtest &middot; catalog</span>
<h1>${escapeHtml(database)}.${escapeHtml(schema)}</h1>
<p class="lede">
  ${tables.length} object(s): ${columnCount(tables, 'TABLE')} table(s), ${columnCount(tables, 'VIEW')} view(s).
  Row counts are read when you load this page; a preview shows the first ${PREVIEW_LIMIT} rows.
</p>

<table>
  <thead>
    <tr><th scope="col">Object</th><th scope="col">Kind</th><th scope="col">Rows</th><th scope="col"></th></tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>

<footer>
  Read-only previews. Run real queries against this server with any Snowflake
  client; the reference for what it answers is at <a href="/operations">/operations</a>.
</footer>`;

  return renderPage({ title: `snowtest — ${database}.${schema}`, body });
}

/** `/browse/<database>/<schema>/<table>`: columns and the first rows. */
export function renderPreview(preview: BrowsePreview): string {
  const { database, schema, table, columns, rows } = preview;
  const headers = columns
    .map(
      (column) =>
        `      <th scope="col">${escapeHtml(column.name)}<span class="note">${escapeHtml(column.duckType.toLowerCase())}</span></th>`,
    )
    .join('\n');
  const bodyRows =
    rows
      .map(
        (row) =>
          `      <tr>${row
            .map((value, index) => `<td>${formatValue(value, columns[index]?.duckType)}</td>`)
            .join('')}</tr>`,
      )
      .join('\n') || `      <tr><td colspan="${Math.max(columns.length, 1)}">No rows.</td></tr>`;

  const shown = rows.length;
  const truncated = preview.total !== null && preview.total > shown;
  const caption = truncated
    ? `Showing the first ${plural(shown, 'row')} of ${preview.total?.toLocaleString('en-US')}.`
    : `${plural(shown, 'row')} in total.`;
  // The footer has to describe the table in front of the reader, not the cap:
  // a five-row table is not "a capped preview".
  const footer =
    preview.total === null
      ? `Up to ${PREVIEW_LIMIT} rows, read-only, with no filters. Point a Snowflake client at this server for the rest.`
      : truncated
        ? `A capped preview: these are the first ${shown} of ${plural(preview.total, 'row')}. Point a Snowflake client at this server for the rest.`
        : 'The whole table, read-only. Point a Snowflake client at this server to query it yourself.';

  const body = `${pageHead(database, schema, table)}
<span class="tag">snowtest &middot; preview</span>
<h1><code>${escapeHtml(table)}</code></h1>
<p class="lede">
  ${escapeHtml(preview.kind.toLowerCase())} in <a href="${browsePath(database, schema)}">${escapeHtml(database)}.${escapeHtml(schema)}</a>.
  ${escapeHtml(caption)}
</p>

<div class="scroller">
<table>
  <thead>
    <tr>
${headers}
    </tr>
  </thead>
  <tbody>
${bodyRows}
  </tbody>
</table>
</div>

<footer>
  ${footer}
</footer>`;

  return renderPage({ title: `snowtest — ${database}.${schema}.${table}`, body });
}

/** Shown when a database, schema or object is not there (or has been dropped). */
export function renderMissing(title: string, detail: string): string {
  const body = `<p class="crumb"><a href="/">&larr; Overview</a></p>
<span class="tag">snowtest &middot; catalog</span>
<h1>${escapeHtml(title)}</h1>
<p class="lede">${escapeHtml(detail)}</p>
<p><a href="/">Back to the overview</a></p>`;
  return renderPage({ title: `snowtest — ${title}`, body });
}
