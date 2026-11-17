// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * The page served at `/`.
 *
 * A stub that only answers protocol endpoints is hard to approach: you have to
 * read the README before you know what to point at it. This page is the
 * five-second version — what the process is, the values to connect with, and
 * the limits worth knowing before trusting it.
 *
 * The "what it speaks" summary is derived from the operations table rather than
 * written here, so the overview cannot advertise more than the reference lists.
 */

import type { SnowtestConfig } from './config.js';
import { LANDING_SURFACES } from './operations.js';
import { escapeHtml, renderPage, renderTabs } from './page.js';

/** Catalog and session snapshot shown on the landing page. */
export interface HomeSchemaState {
  name: string;
  tables: number;
  views: number;
}

export interface HomeDatabaseState {
  name: string;
  schemas: HomeSchemaState[];
}

export interface HomeSessionState {
  user: string;
  database: string | null;
  schema: string | null;
  role: string;
  createdAt: Date;
}

/** A statement the server timed, as the landing page lists it. */
export interface HomeQueryState {
  queryText: string;
  startedAt: Date;
  elapsedMs: number;
  rowsProduced: number;
  status: string;
  user: string;
}

/** Hourly statement counts behind the timings chart. */
export interface HomeVolumeState {
  from: Date;
  to: Date;
  total: number;
  buckets: Array<{ start: Date; statements: number }>;
}

/** The hour the timings table has been narrowed to. */
export interface HomeFilterState {
  from: Date;
  to: Date;
  /** Statements in that hour, even when the table below shows only the newest of them. */
  statements: number;
}

export interface HomeState {
  databases: HomeDatabaseState[];
  warehouses: string[];
  roles: string[];
  stages: number;
  sessions: HomeSessionState[];
  queries: HomeQueryState[];
  /** Statements in the timings table, not just the ones the page lists. */
  queryCount: number;
  /** Hourly counts for the chart; null when the table could not be read. */
  volume?: HomeVolumeState | null;
  /** Set when a bar was clicked, so the table shows that hour only. */
  filter?: HomeFilterState | null;
  /** Hours the chart covers; the window links and the bucket width follow it. */
  windowHours?: number;
  /** What a clear just did, carried across the reload that follows it. */
  notice?: { kind: 'timings' | 'reset' | 'seed'; text: string } | null;
}

/** Home's tabs; the catalog browser repeats them as links, with Live state current. */
export const HOME_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'live', label: 'Live state' },
  { id: 'connect', label: 'Connect' },
  { id: 'speaks', label: 'What it speaks' },
  { id: 'control', label: 'Control plane' },
  { id: 'timings', label: 'Query timings' },
  { id: 'clear', label: 'Clear Data' },
] as const;

const REFRESH_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 1 1 .908-.418A6 6 0 1 1 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966a.25.25 0 0 1 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/></svg>';

// One script for every refresh button on the page: `data-refresh` names the region
// to swap, and the stamp beside the button shows when it last ran. A failure is
// shown, never left looking current.
const REFRESH_SCRIPT = `<script>
(() => {
  for (const button of document.querySelectorAll('[data-refresh]')) {
    const body = button.dataset.refresh;
    const at = button.parentElement.querySelector('[data-stamp]');
    const stamp = () => { at.textContent = 'updated ' + new Date().toLocaleTimeString(); };
    stamp();
    button.addEventListener('click', async () => {
      button.classList.add('busy');
      button.classList.remove('err');
      button.disabled = true;
      try {
        const response = await fetch(location.pathname + location.search, { cache: 'no-store' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        const fresh = doc.getElementById(body);
        if (!fresh) throw new Error(body + ' missing from response');
        document.getElementById(body).replaceWith(fresh);
        // The new copy is server time until the browser relabels it.
        if (window.snowtestRelabel) window.snowtestRelabel();
        stamp();
      } catch (error) {
        button.classList.add('err');
        at.textContent = 'refresh failed: ' + error.message;
      } finally {
        button.classList.remove('busy');
        button.disabled = false;
      }
    });
  }
})();
</script>`;

// Hovering reads the count off the bar; a click follows the link the server built.
// Delegated from the document, so a bar inside a refreshed `timings-body` works
// without anything being re-bound.
const CHART_SCRIPT = `<script>
(() => {
  const tooltip = () => document.getElementById('chart-tip');
  const hide = () => { const node = tooltip(); if (node) node.hidden = true; };
  const show = (hit) => {
    const node = tooltip();
    const svg = hit.ownerSVGElement;
    if (!node || !svg) return;
    const box = svg.getBoundingClientRect();
    const wrap = svg.parentElement.getBoundingClientRect();
    const left = box.left - wrap.left + (Number(hit.dataset.cx) / Number(svg.dataset.width)) * box.width;
    const top = box.top - wrap.top + (Number(hit.dataset.cy) / Number(svg.dataset.height)) * box.height;
    node.textContent = hit.dataset.label + ' · ' + hit.dataset.count
      + (hit.dataset.count === '1' ? ' statement' : ' statements');
    node.style.left = Math.min(Math.max(left, 68), wrap.width - 68) + 'px';
    node.style.top = (top - 6) + 'px';
    node.hidden = false;
  };
  const bar = (event) => (event.target instanceof Element ? event.target.closest('.hit') : null);
  document.addEventListener('mouseover', (event) => { const hit = bar(event); if (hit) show(hit); });
  document.addEventListener('mouseout', (event) => { if (bar(event)) hide(); });
  document.addEventListener('focusin', (event) => { const hit = bar(event); if (hit) show(hit); });
  document.addEventListener('focusout', hide);
  document.addEventListener('click', (event) => {
    const hit = bar(event);
    if (hit) location.assign(hit.dataset.href);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const hit = bar(event);
    if (!hit) return;
    event.preventDefault();
    location.assign(hit.dataset.href);
  });
  // A bar is a link, and #timings is a tab name, not an element to land on —
  // so arriving from one would otherwise start at the top of the page. Wait for
  // load, because the tab script hides the other panels and moves this one up.
  addEventListener('load', () => {
    if (location.hash !== '#timings') return;
    const chart = document.getElementById('timings-chart');
    if (chart) chart.scrollIntoView({ block: 'start' });
  });
})();
</script>`;

// The page is rendered on the server, which knows its own zone and not the
// reader's, so every time it prints carries the instant it stands for. This
// relabels them in the browser's zone — table cells in full, chart ticks and the
// hour filter as `HH:MM` — and is exported so a refreshed body gets the same
// treatment. Nothing about the data depends on it: a filter is an instant, so
// clicking a bar means the same hour whatever the label says.
const TIMES_SCRIPT = `<script>
(() => {
  const pad = (n) => String(n).padStart(2, '0');
  const hourOf = (iso) => { const at = new Date(iso); return pad(at.getHours()) + ':' + pad(at.getMinutes()); };
  const fullOf = (iso) => {
    const at = new Date(iso);
    let zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    try {
      zone = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
        .formatToParts(at).find((part) => part.type === 'timeZoneName')?.value || zone;
    } catch {}
    return at.getFullYear() + '-' + pad(at.getMonth() + 1) + '-' + pad(at.getDate())
      + ' ' + pad(at.getHours()) + ':' + pad(at.getMinutes()) + ':' + pad(at.getSeconds()) + ' ' + zone;
  };
  const relabel = () => {
    for (const node of document.querySelectorAll('[data-at]')) node.textContent = fullOf(node.dataset.at);
    for (const node of document.querySelectorAll('[data-hour-at]')) node.textContent = hourOf(node.dataset.hourAt);
    for (const node of document.querySelectorAll('[data-span-from]')) {
      node.textContent = hourOf(node.dataset.spanFrom) + '–' + hourOf(node.dataset.spanTo);
    }
    for (const node of document.querySelectorAll('.hit[data-from]')) {
      const label = hourOf(node.dataset.from) + '–' + hourOf(node.dataset.to);
      node.dataset.label = label;
      node.setAttribute('aria-label', label + ': ' + node.dataset.count + ' statement(s)');
    }
    // One divider per local day: the first bucket whose date differs from the one
    // before it. Labels are thinned rather than the dividers: a window that opens
    // an hour before midnight puts two dates a few pixels apart, and the later day
    // is the one worth naming.
    const marks = [...document.querySelectorAll('.daymark')];
    if (marks.length > 0) {
      const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
      const gap = 42; // viewBox units a date label needs to itself
      const openingDay = new Date(marks[0].dataset.dayAt).toDateString();
      const openingHours = marks.filter(
        (mark) => new Date(mark.dataset.dayAt).toDateString() === openingDay,
      ).length;
      let previousDay = null;
      let lastX = -Infinity;
      for (const mark of marks) {
        const label = mark.querySelector('text');
        const line = mark.querySelector('line');
        if (!label || !line) continue;
        const at = new Date(mark.dataset.dayAt);
        const day = at.toDateString();
        const first = day !== previousDay;
        previousDay = day;
        if (!first) {
          mark.style.display = 'none';
          continue;
        }
        // A sliver of an opening day is where the window starts, not a day name.
        if (day === openingDay && openingHours < 12) {
          mark.style.display = 'none';
          continue;
        }
        mark.style.display = '';
        label.textContent = dayFormat.format(at);
        const atX = Number(line.getAttribute('x1'));
        if (atX - lastX < gap) {
          label.style.display = 'none';
          continue;
        }
        lastX = atX;
      }
    }
  };
  window.snowtestRelabel = relabel;
  relabel();
})();
</script>`;

// The Clear Data and Control plane tabs are static, so their listeners can hold
// their elements.
const CLEAR_SCRIPT = `<script>
(() => {
  const WORD = 'Delete All Data';
  const timingsDialog = document.getElementById('clear-timings-dialog');
  const allDialog = document.getElementById('clear-all-dialog');
  const word = document.getElementById('clear-word');
  const go = document.getElementById('clear-go');
  const error = document.getElementById('clear-error');
  const fail = (what, problem) => {
    error.hidden = false;
    error.textContent = what + ' failed: ' + problem.message;
  };

  document.getElementById('clear-timings-open').addEventListener('click', () => {
    error.hidden = true;
    timingsDialog.showModal();
  });
  document.getElementById('clear-all-open').addEventListener('click', () => {
    error.hidden = true;
    word.value = '';
    go.disabled = true;
    allDialog.showModal();
    word.focus();
  });
  for (const button of document.querySelectorAll('.modal [data-close]')) {
    button.addEventListener('click', () => button.closest('dialog').close());
  }
  // A confirmation is for the click that caused it, not for every refresh after.
  // The flag lives in the URL so it survives the redirect, and is dropped as soon
  // as the page renders: the banner stays on screen, a reload no longer shows it.
  const flag = new URLSearchParams(location.search);
  if (flag.has('cleared') || flag.has('seeded')) {
    history.replaceState(null, '', location.pathname + location.hash);
  }

  // A method=dialog form closes on submit, and Enter in the text field is an
  // implicit submit: without this, Enter dismissed the dialog and did nothing.
  // Neither dialog does anything on Enter; both act only on their own button.
  for (const form of document.querySelectorAll('.modal form')) {
    form.addEventListener('submit', (event) => event.preventDefault());
  }

  const seedDialog = document.getElementById('seed-dialog');
  const seedError = document.getElementById('seed-error');
  document.getElementById('seed-open').addEventListener('click', () => {
    seedError.hidden = true;
    seedDialog.showModal();
  });
  document.getElementById('seed-yes').addEventListener('click', async (event) => {
    event.target.disabled = true;
    seedError.hidden = true;
    try {
      const response = await fetch('/_snowtest/seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      location.replace('/?seeded=examples#control');
    } catch (problem) {
      event.target.disabled = false;
      seedDialog.close();
      seedError.hidden = false;
      seedError.textContent = 'Seeding failed: ' + problem.message;
    }
  });

  document.getElementById('clear-timings-yes').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      const response = await fetch('/_snowtest/queries/clear', { method: 'POST' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      location.replace('/?cleared=timings#clear');
    } catch (problem) {
      event.target.disabled = false;
      timingsDialog.close();
      fail('Clear', problem);
    }
  });
  word.addEventListener('input', () => {
    go.disabled = word.value !== WORD;
  });
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const response = await fetch('/_snowtest/reset', { method: 'POST' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      location.replace('/?cleared=reset#clear');
    } catch (problem) {
      go.disabled = false;
      allDialog.close();
      fail('Reset', problem);
    }
  });
})();
</script>`;

const pad = (n: number): string => String(n).padStart(2, '0');

/** Server-local `YYYY-MM-DD HH:MM:SS TZ`; `server time` if no zone name. */
export function formatServerTime(date: Date): string {
  const zone =
    new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')?.value || 'server time';
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${day} ${time} ${zone}`;
}

/** Compact elapsed time, e.g. `2d 3h 04m`, `1h 02m 05s`, `12m 30s`, `5s`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${hours}h ${pad(minutes)}m`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

/** A single statement is usually under a second, so this counts in milliseconds. */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

/** One-line statement text for a table cell; the full text is the cell's title. */
function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const HOUR_MS = 3_600_000;

/** Windows the chart offers, in hours, with the label its link carries. */
const CHART_WINDOWS: Array<[number, string]> = [
  [6, '6h'],
  [24, '24h'],
  [168, '7d'],
];

/** `HH:00`, in the same server time the timings table prints. */
function formatHour(date: Date): string {
  return `${pad(date.getHours())}:00`;
}

const CHART = { width: 720, height: 105, left: 30, right: 8, top: 8, bottom: 22 } as const;

/**
 * The hour-of-requests line above the timings table.
 *
 * Inline SVG built here, so the page carries no chart library, and no client
 * state either: the selected hour is a URL parameter and every bar is a link.
 * Hovering reads the count off the bar's data attributes; clicking follows the
 * link — see CHART_SCRIPT. The buckets arrive whole, empty hours included, so
 * the line runs across the window instead of jumping the quiet stretches.
 */
function renderVolumeChart(
  volume: HomeVolumeState,
  windowHours: number,
  selected: HomeFilterState | null,
): string {
  const links = CHART_WINDOWS.map(([hours, label]) =>
    hours === windowHours ? `<strong>${label}</strong>` : `<a href="/?window=${hours}#timings">${label}</a>`,
  ).join(' <span class="muted">·</span> ');
  const head = `<div class="charthead">
    <span><strong>Statements per hour</strong> <span class="muted">&mdash; last ${windowHours} hours, ${volume.total} in the window</span></span>
    <span class="muted">${links}</span>
  </div>`;

  // Nothing timed yet: a flat line at zero would look like a quiet day, not an
  // empty table, so say which one it is.
  if (volume.total === 0) {
    return `<div class="card" id="timings-chart">
${head}
<p class="muted">Nothing in the last ${windowHours} hours is timed yet, so there is no line to draw. Run a statement and it appears.</p>
</div>`;
  }

  const { width, height, left, right, top, bottom } = CHART;
  const count = volume.buckets.length;
  const step = (width - left - right) / count;
  const peak = Math.max(1, ...volume.buckets.map((bucket) => bucket.statements));
  const x = (index: number): number => left + index * step + step / 2;
  const y = (value: number): number => top + (height - top - bottom) * (1 - value / peak);
  const points = volume.buckets.map((bucket, index) => `${x(index).toFixed(1)},${y(bucket.statements).toFixed(1)}`);
  const area = `M${x(0).toFixed(1)},${y(0).toFixed(1)} L${points.join(' L')} L${x(count - 1).toFixed(1)},${y(0).toFixed(1)} Z`;

  const grid = [0, 0.5, 1]
    .map((fraction) => {
      const at = y(peak * fraction).toFixed(1);
      return `<line class="grid" x1="${left}" x2="${width - right}" y1="${at}" y2="${at}" />
        <text class="axis" x="${left - 6}" y="${Number(at) + 3}" text-anchor="end">${Math.round(peak * fraction)}</text>`;
    })
    .join('');

  const selectedIndex = selected
    ? volume.buckets.findIndex(
        (bucket) => bucket.start.getTime() === Math.floor(selected.from.getTime() / HOUR_MS) * HOUR_MS,
      )
    : -1;

  const band =
    selectedIndex >= 0
      ? `<rect class="band" x="${(x(selectedIndex) - step / 2).toFixed(1)}" y="${top}" width="${step.toFixed(1)}" height="${height - top - bottom}" />`
      : '';

  // A dot per hour is a shape; a dot per hour across a week is a smear.
  const dots =
    count <= 48
      ? volume.buckets
          .map(
            (bucket, index) =>
              `<circle class="chartdot" cx="${x(index).toFixed(1)}" cy="${y(bucket.statements).toFixed(1)}" r="${index === selectedIndex ? 4 : 2.5}" />`,
          )
          .join('')
      : '';

  // Past a day, hours stop being the unit that matters: every bucket still gets
  // a candidate divider, and the browser keeps the ones that begin a local day.
  // The server cannot know the reader's zone, so it marks its own days and the
  // script corrects them; a :30 offset can put a boundary half a bucket out.
  const multiDay = windowHours > 24;
  const labelEvery = Math.max(1, Math.round(count / 6));
  const ticks = multiDay
    ? ''
    : volume.buckets
        .map((bucket, index) => {
          const isLast = index === count - 1;
          if (index % labelEvery !== 0 && !isLast) return '';
          const anchor = isLast && index % labelEvery !== 0 ? 'end' : 'middle';
          return `<text class="axis" data-hour-at="${bucket.start.toISOString()}" x="${x(index).toFixed(1)}" y="${height - 6}" text-anchor="${anchor}">${formatHour(bucket.start)}</text>`;
        })
        .join('');
  const dayMarks = multiDay
    ? volume.buckets
        .map((bucket, index) => {
          const isLast = index === count - 1;
          const left = (x(index) - step / 2).toFixed(1);
          const textX = isLast ? (x(index) - 4).toFixed(1) : (x(index) - step / 2 + 4).toFixed(1);
          // `data-day-at`, not `data-hour-at`: the hour loop rewrites the text of
          // everything carrying that attribute, which would wipe this group's children.
          return `<g class="daymark" data-day-at="${bucket.start.toISOString()}" style="display:none">
          <line class="dayline" x1="${left}" x2="${left}" y1="${top}" y2="${height - bottom}" />
          <text class="axis" x="${textX}" y="${height - 6}" text-anchor="${isLast ? 'end' : 'start'}"></text>
        </g>`;
        })
        .join('')
    : '';

  const hits = volume.buckets
    .map((bucket, index) => {
      const end = new Date(bucket.start.getTime() + HOUR_MS);
      const label = `${formatHour(bucket.start)}–${formatHour(end)}`;
      // Clicking the hour that is already selected is how the filter is dropped.
      const href =
        index === selectedIndex
          ? `/?window=${windowHours}#timings`
          : `/?window=${windowHours}&from=${encodeURIComponent(bucket.start.toISOString())}&to=${encodeURIComponent(end.toISOString())}#timings`;
      return `<rect class="hit" x="${(x(index) - step / 2).toFixed(1)}" y="${top}" width="${step.toFixed(1)}" height="${height - top - bottom}" tabindex="0" role="link"
          data-href="${href}" data-cx="${x(index).toFixed(1)}" data-cy="${y(bucket.statements).toFixed(1)}"
          data-label="${label}" data-count="${bucket.statements}"
          data-from="${bucket.start.toISOString()}" data-to="${end.toISOString()}"
          aria-label="${label}: ${bucket.statements} statement(s)" />`;
    })
    .join('');

  return `<div class="card" id="timings-chart">
${head}
<div class="chartwrap">
<div class="tooltip" id="chart-tip" hidden></div>
<svg viewBox="0 0 ${width} ${height}" data-width="${width}" data-height="${height}" role="img"
     aria-label="Statements per hour over the last ${windowHours} hours">
${grid}
${band}
<path class="chartarea" d="${area}" />
<polyline class="chartline" points="${points.join(' ')}" />
${dots}
${dayMarks}
${ticks}
${hits}
</svg>
</div>
<p class="muted">Hover an hour for its count; click one to narrow the table below. Click it again, or the × on the chip, to go back. Times here follow your browser's zone.</p>
</div>`;
}

export function renderHome(
  config: SnowtestConfig,
  origin: string,
  version: string,
  state: HomeState,
): string {
  const account = escapeHtml(config.account);
  const database = escapeHtml(config.defaultDatabase);
  const schema = escapeHtml(config.defaultSchema);
  const warehouse = escapeHtml(config.defaultWarehouse);
  const endpoint = escapeHtml(origin);
  const port = config.port;
  const verified = config.jwtPublicKey !== null;
  const authLine = verified
    ? 'key-pair JWT — signatures verified against the configured public key'
    : 'permissive — any user and password is accepted';
  const usersLine =
    config.users.length > 0
      ? `, login names limited to ${escapeHtml(config.users.join(', '))}`
      : '';
  const storageLine = config.dataDir
    ? `DuckDB files under <code>${escapeHtml(config.dataDir)}</code> — data survives a restart`
    : 'in memory — a restart is a clean slate';

  const objectCount = state.databases.reduce(
    (total, db) =>
      total + db.schemas.reduce((sum, schema) => sum + schema.tables + schema.views, 0),
    0,
  );
  const databaseRows =
    state.databases
      .flatMap((db) =>
        db.schemas.map(
          (schema) =>
            `    <tr><td><code>${escapeHtml(db.name)}</code></td><td><a href="/browse/${encodeURIComponent(db.name)}/${encodeURIComponent(schema.name)}"><code>${escapeHtml(schema.name)}</code></a></td><td>${schema.tables}</td><td>${schema.views}</td></tr>`,
        ),
      )
      .join('\n') || '    <tr><td colspan="4">No databases yet.</td></tr>';
  const now = Date.now();
  const sessionRows =
    state.sessions
      .map(
        (session) =>
          `    <tr><td><code>${escapeHtml(session.user)}</code></td><td><code>${escapeHtml(session.database ?? 'NULL')}.${escapeHtml(session.schema ?? 'NULL')}</code></td><td>${escapeHtml(session.role)}</td><td>${escapeHtml(formatServerTime(session.createdAt))}</td><td>${formatDuration(now - session.createdAt.getTime())}</td></tr>`,
      )
      .join('\n') || '    <tr><td colspan="5">No active sessions.</td></tr>';
  const queryRows =
    state.queries
      .map(
        (query) =>
          `    <tr><td data-at="${query.startedAt.toISOString()}">${escapeHtml(formatServerTime(query.startedAt))}</td><td><code>${escapeHtml(query.user)}</code></td><td class="sql" title="${escapeHtml(query.queryText)}">${escapeHtml(shorten(query.queryText, 90))}</td><td class="num">${escapeHtml(formatElapsed(query.elapsedMs))}</td><td class="num">${query.rowsProduced}</td><td>${escapeHtml(query.status)}</td></tr>`,
      )
      .join('\n') || '    <tr><td colspan="6">No statements recorded yet.</td></tr>';
  const surfaceRows = LANDING_SURFACES.map(
    (surface) =>
      `  <tr><th scope="row"><a href="/operations#${escapeHtml(surface.id)}">${escapeHtml(surface.label)}</a></th><td>${escapeHtml(surface.summary)} <span class="muted">(${surface.supported} of ${surface.total} supported)</span></td></tr>`,
  ).join('\n');

  const overview = `<div class="card">
  <table>
    <tr><th>Endpoint</th><td><code>${endpoint}</code></td></tr>
    <tr><th>Account</th><td><code>${account}</code></td></tr>
    <tr><th>Default context</th><td><code>${database}.${schema}</code> &middot; warehouse <code>${warehouse}</code></td></tr>
    <tr><th>Auth</th><td>${authLine}${usersLine}</td></tr>
    <tr><th>Storage</th><td>${storageLine}</td></tr>
  </table>
</div>

<h3>What it is not</h3>
<p class="warn">
  A test double, not a replacement. No TLS, no users, roles or privileges, no ODBC,
  no warehouse sizing or cost behaviour, one result partition, JSON only. Staged
  transfers use a local directory instead of cloud object storage.
</p>
<ul>
  <li>Nothing here authenticates or authorises unless you configure a public key.</li>
  <li>Never expose it publicly or point real credentials at it.</li>
  <li>Data lives in memory unless <code>SNOWTEST_DATA_DIR</code> is set (<code>setup.py</code> and <code>compose.yaml</code> set it).</li>
</ul>`;

  // `live-body` is swapped in place by the refresh button; keep the id on the server-rendered copy.
  const live = `<div class="livebar"><span class="muted" data-stamp aria-live="polite"></span><button type="button" class="refresh" data-refresh="live-body" title="Refresh live state">${REFRESH_ICON}Refresh</button></div>
<div id="live-body">
<p class="muted">
  ${state.databases.length} database(s) &middot; ${objectCount} table/view(s) &middot;
  ${state.warehouses.length} warehouse(s) &middot; ${state.roles.length} role(s) &middot;
  ${state.stages} stage(s) &middot; ${state.sessions.length} session(s).
</p>
<table>
  <tr><th>Database</th><th>Schema</th><th>Tables</th><th>Views</th></tr>
${databaseRows}
</table>
<p class="muted">Select a schema to list its tables and preview the first rows of any of them.</p>

<h3>Active sessions</h3>
<table>
  <tr><th>User</th><th>Context</th><th>Role</th><th>Started (server time)</th><th>Length</th></tr>
${sessionRows}
</table>
</div>`;

  const python = `<pre><code>import snowflake.connector

conn = snowflake.connector.connect(
    account="${account}", user="test", password="test",
    host="localhost", port=${port}, protocol="http",
    database="${database}", schema="${schema}", warehouse="${warehouse}",
)
cur = conn.cursor()
cur.execute("SELECT CURRENT_DATABASE(), CURRENT_SCHEMA()")
print(cur.fetchall())</code></pre>`;

  const dbt = `<p>Key-pair auth is the normal way a service account reaches Snowflake, so it is the
normal way to reach this too. Add these keys to any dbt-snowflake profile:</p>
<pre><code>snowtest:
  target: dev
  outputs:
    dev:
      type: snowflake
      account: ${account}
      user: DBT_SVC
      authenticator: snowflake_jwt
      private_key_path: /absolute/path/to/rsa_key.p8
      database: ${database}
      schema: ${schema}
      warehouse: ${warehouse}
      role: SYSADMIN
      threads: 4
      host: localhost      # "snowtest" from another container
      port: ${port}
      protocol: http</code></pre>
<p>Generated keys are only verified when the server was started with a public key
(<code>SNOWTEST_JWT_PUBLIC_KEY</code>); otherwise any credential is accepted.</p>`;

  const curl = `<pre><code>curl -s -X POST '${endpoint}/api/v2/statements' \\
  -H 'Authorization: Bearer test' \\
  -H 'Content-Type: application/json' \\
  -d '{"statement":"SELECT 1 AS n"}'</code></pre>`;

  const speaks = `<table>
  <thead>
    <tr><th scope="col">Surface</th><th scope="col">Notes</th></tr>
  </thead>
  <tbody>
${surfaceRows}
  </tbody>
</table>
<p>
  <a href="/operations"><strong>Supported operations</strong></a> &mdash;
  <span class="muted">every endpoint, statement and function, with what each one does and where it stops.</span>
</p>`;

  // Each confirmation belongs to the block that caused it, under its heading.
  const noticeFor = (kind: 'timings' | 'reset' | 'seed'): string =>
    state.notice && state.notice.kind === kind
      ? `\n    <p class="ok" role="status">${escapeHtml(state.notice.text)}</p>`
      : '';
  const clearPane = `<p class="lede">
  Two things can be cleared, and neither happens on its own.
</p>

<div class="action">
  <div>
    <h3>Query timings</h3>${noticeFor('timings')}
    <p class="muted">
      ${state.queryCount} statement(s) in <code>SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY</code>.
    </p>
  </div>
  <div class="action-controls">
    <button type="button" class="refresh" id="clear-timings-open" aria-haspopup="dialog">Clear timings</button>
  </div>
</div>

<div class="action">
  <div>
    <h3>Everything</h3>${noticeFor('reset')}
    <p class="muted">
      Drops every database and its files, every stage, session and statement handle,
      and the timings table, then rebuilds the configured catalog. There is no undo.
    </p>
  </div>
  <div class="action-controls">
    <button type="button" class="refresh danger" id="clear-all-open" aria-haspopup="dialog">Delete all data</button>
  </div>
</div>

<p class="muted">
  A direct <code>POST /_snowtest/reset</code> still resets without the confirmation, as it always has.
</p>
<p class="warn" id="clear-error" hidden></p>

<dialog class="modal" id="clear-timings-dialog" aria-labelledby="clear-timings-title">
  <form method="dialog">
    <h3 id="clear-timings-title">Clear the query timings?</h3>
    <p class="muted">
      Empties <code>SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY</code> — ${state.queryCount} statement(s).
      Databases, stages and sessions stay exactly as they are.
    </p>
    <div class="modal-actions">
      <button type="button" class="refresh" data-close>Cancel</button>
      <button type="button" class="refresh danger" id="clear-timings-yes">Clear timings</button>
    </div>
  </form>
</dialog>

<dialog class="modal" id="clear-all-dialog" aria-labelledby="clear-all-title">
  <form method="dialog">
    <h3 id="clear-all-title">Delete all data?</h3>
    <p class="muted">
      Every database and its files, every stage, session and statement handle, and the
      timings table. The configured catalog is rebuilt. There is no undo.
    </p>
    <label for="clear-word">Type <code>Delete All Data</code> to confirm</label>
    <input type="text" id="clear-word" autocomplete="off" spellcheck="false" autocapitalize="off">
    <div class="modal-actions">
      <button type="button" class="refresh" data-close>Cancel</button>
      <button type="button" class="refresh danger" id="clear-go" disabled>Delete all data</button>
    </div>
  </form>
</dialog>`;

  // The count is the whole table; the list underneath is only its latest page, so
  // say both numbers whenever they differ.
  const windowHours = state.windowHours ?? 24;
  const filter = state.filter ?? null;
  const volume = state.volume ?? null;
  const timingsCount = filter
    ? `${filter.statements} statement(s) started between <span data-hour-at="${filter.from.toISOString()}">${escapeHtml(formatHour(filter.from))}</span> and <span data-hour-at="${filter.to.toISOString()}">${escapeHtml(formatHour(filter.to))}</span>; the latest ${state.queries.length} of them are below.`
    : state.queries.length < state.queryCount
      ? `${state.queryCount} statement(s) in <code>SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY</code>, the latest ${state.queries.length} below.`
      : `${state.queryCount} statement(s) in <code>SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY</code>, all of them below.`;
  const timingsRows =
    state.queries.length > 0
      ? queryRows
      : `    <tr><td colspan="6" class="empty">${filter ? 'No statements in this hour.' : 'No statements recorded yet.'}</td></tr>`;
  // Only rendered while an hour is selected, so there is nothing to hide — and
  // nothing that can stay on screen after the filter is cleared.
  const chip = filter
    ? `<div class="chip"><span data-span-from="${filter.from.toISOString()}" data-span-to="${filter.to.toISOString()}">${escapeHtml(formatHour(filter.from))}–${escapeHtml(formatHour(filter.to))}</span> &middot; ${filter.statements} statement(s)<a href="/?window=${windowHours}#timings" title="Clear the hour filter" aria-label="Clear the hour filter">×</a></div>`
    : '';

  // `timings-body` is swapped in place by this tab's own refresh button.
  const timings = `<div class="livebar"><span class="muted" data-stamp aria-live="polite"></span><button type="button" class="refresh" data-refresh="timings-body" title="Refresh the query timings">${REFRESH_ICON}Refresh</button></div>
<div id="timings-body">
<p class="muted">
  ${timingsCount}
  Every statement the server runs is timed into that table, newest first, the way
  Snowflake keeps it. It is a real table — query it from a client for anything
  older than this preview.
</p>
${volume ? renderVolumeChart(volume, windowHours, filter) : ''}
${chip}
<div class="vscroll">
<table>
  <thead>
    <tr><th scope="col">Started (your time)</th><th scope="col">User</th><th scope="col">Statement</th><th scope="col">Took</th><th scope="col">Rows</th><th scope="col">Status</th></tr>
  </thead>
  <tbody>
${timingsRows}
  </tbody>
</table>
</div>
</div>`;

  // Only the read-only endpoints are links: a link is a GET. Seed is a button of its
  // own because it asks first and then posts; reset and clear stay labels, since a
  // pill you can click by accident is the last thing they need.
  const endpointRow = (title: string, what: string, path?: string): string => {
    const label = `<code>${title}</code>`;
    const cell = path
      ? `<a class="endpoint" href="${path}" target="_blank" rel="noreferrer">${label}</a>`
      : label;
    return `  <tr><th>${cell}</th><td>${what}</td></tr>`;
  };

  const seedRow = `  <tr><th><button type="button" class="endpoint" id="seed-open" aria-haspopup="dialog" title="Seed the example tables (asks first)"><code>POST /_snowtest/seed</code></button></th><td>run a SQL script: <code>{"sql": "..."}</code>, or the bundled examples when the body carries none</td></tr>`;

  const control = `<table>
${endpointRow('GET /_snowtest/health', 'liveness probe', '/_snowtest/health')}
${endpointRow('GET /_snowtest/state', 'databases, schemas, warehouses, roles, stages, sessions', '/_snowtest/state')}
${seedRow}
${endpointRow('POST /_snowtest/reset', 'drop everything, persisted files included, and recreate the configured catalog')}
${endpointRow('POST /_snowtest/queries/clear', 'empty the query timings table')}
</table>
${noticeFor('seed')}
<p class="warn" id="seed-error" hidden></p>

<dialog class="modal" id="seed-dialog" aria-labelledby="seed-title">
  <form method="dialog">
    <h3 id="seed-title">Seed the example tables?</h3>
    <p class="muted">
      <code>data/examples.sql</code> replaces the five tables under
      <code>SNOWTEST.EXAMPLES</code>, so edits you made to them are lost. Nothing else is
      touched.
    </p>
    <div class="modal-actions">
      <button type="button" class="refresh" data-close>Cancel</button>
      <button type="button" class="refresh" id="seed-yes">Seed examples</button>
    </div>
  </form>
</dialog>`;

  const connect = renderTabs(
    [
      { id: 'connect-python', label: 'Python', html: python },
      { id: 'connect-dbt', label: 'dbt', html: dbt },
      { id: 'connect-curl', label: 'curl', html: curl },
    ],
    { variant: 'sub' },
  );

  const body = `<h1>A Snowflake-compatible stub server</h1>
<p class="lede">
  Point a Snowflake client's host and port here and it answers the way Snowflake does —
  no account, no warehouse cost, no network. Use it for integration tests, local
  development and CI.
</p>

${renderTabs(
  HOME_TABS.map((tab) => ({
    ...tab,
    html: { overview, live, connect, speaks, control, timings, clear: clearPane }[tab.id],
  })),
  { hash: true },
)}
${REFRESH_SCRIPT}
${CHART_SCRIPT}
${TIMES_SCRIPT}
${CLEAR_SCRIPT}`;

  return renderPage({ title: 'snowtest — Snowflake-compatible stub server', body, version, nav: 'home' });
}
