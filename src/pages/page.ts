// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * The shell shared by the pages the server renders itself.
 *
 * Pages are rendered inline rather than shipped as static files so the runtime
 * image keeps carrying nothing but `dist/`, which means both of them need the
 * same head, the same stylesheet and the same escaping rules. One copy here,
 * imported by every page renderer, keeps them from drifting apart.
 *
 * Colour comes from tokens on `:root`, and a theme redefines only tokens: no
 * rule below names a colour, so a palette is one block. The theme is a reader's
 * preference, not the server's, so it lives in `sessionStorage` — a reload keeps
 * it, a closed tab forgets it, and nothing about it is ever sent anywhere.
 */

import { PACKAGE_VERSION } from '../config/version.js';
import { DEFAULT_THEME, renderThemeControl, THEME_SCRIPT, THEME_STYLES } from './themes.js';

/** Escape text for HTML text nodes and attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );
}

/**
 * Escape a value, then turn `backticked` spans into inline code. The reference
 * tables are written as prose, and this is the whole markup vocabulary they get.
 */
export function inlineMarkup(value: string): string {
  return escapeHtml(value).replace(/`([^`]+)`/g, '<code>$1</code>');
}

const STYLES = `
  :root { scrollbar-gutter: stable; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; padding: 2.5rem 1.25rem 4rem; max-width: 64rem;
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: var(--fg); background: var(--bg);
  }
  h1 { font-size: 1.9rem; margin: 0 0 .25rem; letter-spacing: -.02em; }
  h2 { font-size: 1.15rem; margin: 2.25rem 0 .75rem; }
  h3 { font-size: .95rem; margin: 1.5rem 0 .4rem; }
  .muted { color: var(--muted); font-size: .9rem; }
  p { margin: .6rem 0; }
  .tag { display: inline-block; font-size: .75rem; letter-spacing: .04em;
         text-transform: uppercase; color: var(--muted); margin-bottom: .5rem; }
  .lede { font-size: 1.02rem; color: var(--muted); }
  .card { border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.15rem;
          background: var(--surface); margin: 1.25rem 0; }
  table { border-collapse: collapse; width: 100%; font-size: .92rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--border);
           vertical-align: top; }
  th { font-weight: 600; }
  td:first-child { white-space: nowrap; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
         font-size: .875em; background: var(--surface); border: 1px solid var(--border);
         border-radius: 5px; padding: .1rem .3rem; }
  pre { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
        padding: .85rem 1rem; overflow-x: auto; font-size: .85rem; line-height: 1.5; }
  pre code { background: none; border: 0; padding: 0; font-size: inherit; }
  ul { margin: .5rem 0; padding-left: 1.2rem; }
  li { margin: .25rem 0; }
  a { color: var(--link); }
  a.endpoint, button.endpoint { color: var(--link); text-decoration: none; }
  a.endpoint code, button.endpoint code { color: inherit; }
  a.endpoint:hover code, button.endpoint:hover code { border-color: var(--link); }
  button.endpoint { font: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
  .warn { border-left: 3px solid var(--warn); padding-left: .9rem; color: var(--muted); }
  footer { margin-top: 3rem; font-size: .85rem; color: var(--muted); }

  /* Site header: version tag above the page nav, theme control at its right end. */
  .toptag { display: flex; align-items: center; justify-content: space-between; gap: .75rem;
            flex-wrap: wrap; font-size: .72rem; letter-spacing: .04em; text-transform: uppercase;
            color: var(--muted); margin: -1.25rem 0 .75rem; }
  .topnav { display: flex; flex-wrap: wrap; gap: 0 1.25rem; font-size: .9rem; margin: 0 0 1.5rem;
            padding-bottom: .5rem; border-bottom: 1px solid var(--border); }
  .topnav a { text-decoration: none; color: var(--muted); }
  .topnav a[aria-current] { color: inherit; font-weight: 600; }
  .crumb { font-size: .88rem; margin: 0 0 .75rem; }

  /* Tabs. Panels stay visible until the script runs, so nothing hides without JS. */
  .tabs { display: flex; flex-wrap: wrap; gap: .15rem; border-bottom: 1px solid var(--border);
          margin: 1.75rem 0 1rem; }
  .tabs.dense { gap: 0; font-size: .9rem; }
  .tabs.sub { margin: .5rem 0 .75rem; font-size: .9rem; }
  .tab { font: inherit; color: inherit; background: none; cursor: pointer; padding: .35rem .8rem;
         margin-bottom: -1px; border: 1px solid transparent; border-radius: 6px 6px 0 0; }
  .tabs.dense .tab { padding: .35rem .55rem; }
  .tab:hover { background: var(--surface); }
  a.tab { text-decoration: none; }
  .tab[aria-selected="true"], .tab[aria-current] { border-color: var(--link);
                               border-bottom: 2px solid var(--link); color: var(--link);
                               border-radius: 6px; }
  .panehead { margin: .5rem 0 .25rem; font-size: 1.05rem; display: flex; align-items: center; gap: .5rem; }
  .badge { display: inline-block; font-size: .72rem; line-height: 1.4; padding: 0 .4rem;
           border-radius: 999px; background: var(--badge-bg); color: var(--badge-fg); font-weight: 600; }
  .rn { width: 2.5rem; text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
  .since { width: 7rem; white-space: nowrap; color: var(--muted); font-variant-numeric: tabular-nums; }
  .livebar { display: flex; align-items: center; justify-content: flex-end; gap: .6rem; margin: .25rem 0; }
  .livebar .muted { font-size: .8rem; }
  .refresh { display: inline-flex; align-items: center; gap: .35rem; font: inherit; font-size: .85rem;
             cursor: pointer; color: var(--link); background: none; border: 1px solid var(--border);
             border-radius: 6px; padding: .2rem .6rem; }
  .refresh.danger { color: var(--danger-fg); }
  .refresh.danger:hover { border-color: var(--danger-fg); background: var(--danger-hover); }
  .refresh:disabled { cursor: not-allowed; opacity: .5; }
  .ok { border: 1px solid var(--ok-border); background: var(--ok-bg); color: var(--ok-fg);
        border-radius: 6px; padding: .5rem .75rem; margin: 0 0 .9rem; }
  .action { display: flex; align-items: flex-start; justify-content: space-between; gap: 1.5rem;
            border-top: 1px solid var(--border); padding: 1rem 0; }
  .action h3 { margin: 0 0 .3rem; }
  .action p { margin: 0; }
  .action-controls { display: flex; align-items: center; gap: .4rem; flex: 0 0 auto; }
  .modal { width: min(30rem, calc(100vw - 2rem)); padding: 1.1rem 1.25rem;
           border: 1px solid var(--border); border-radius: 10px; background: var(--modal-bg);
           color: inherit; box-shadow: 0 12px 32px var(--overlay); }
  .modal::backdrop { background: var(--overlay); }
  .modal h3 { margin: 0 0 .5rem; }
  .modal p { margin: 0 0 .9rem; }
  .modal label { display: block; margin-bottom: .35rem; }
  .modal input { font: inherit; font-size: .9rem; padding: .3rem .55rem; width: 100%; box-sizing: border-box;
                 border: 1px solid var(--border); border-radius: 6px; background: var(--input-bg);
                 color: inherit; }
  .modal-actions { display: flex; justify-content: flex-end; gap: .5rem; margin-top: 1rem; }
  /* Narrow enough that the timings table fits without scrolling sideways,
     wide enough to still read a statement. */
  td.sql { max-width: 16rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .refresh:hover { background: var(--surface); border-color: var(--link); }
  .refresh svg { width: 14px; height: 14px; }
  .refresh.busy svg { animation: spin .8s linear infinite; }
  .refresh.err { color: var(--danger-fg); border-color: var(--danger-fg); }
  @keyframes spin { to { transform: rotate(360deg); } }

  .ops td:first-child { white-space: normal; }
  .ops thead th { position: sticky; top: 0; z-index: 1; background: var(--bg); }
  .ops h2 { scroll-margin-top: 1rem; }
  .note { display: block; color: var(--muted); font-size: .82rem; margin-top: .15rem; }
  /* A row's gap is the part people need to read, so it gets a callout block
     instead of smaller grey text. Scoped to the operations tables: the catalog
     browser uses the same class for column-type hints, where this is noise. */
  .ops .note {
    background: var(--note-bg); border-left: 3px solid var(--note-border); border-radius: 4px;
    padding: .3rem .55rem; color: var(--note-fg); margin-top: .3rem;
  }
  .null { color: var(--muted); font-style: italic; }
  .scroller { overflow-x: auto; margin: 1.25rem 0; }
  .scroller table { min-width: 100%; }
  .scroller td { white-space: nowrap; }

  /* Vertical cap for the data tables: twelve rows, then a scrollbar. The header
     sticks, so a scrolled table never loses its column names. */
  .vscroll { max-height: 22rem; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; }
  .vscroll thead th { position: sticky; top: 0; z-index: 1; background: var(--bg); }
  .vscroll .empty { color: var(--muted); font-style: italic; padding: 1.25rem .6rem; }

  /* The timings chart. Inline SVG, so each part is one class and no library. */
  .charthead { display: flex; align-items: baseline; justify-content: space-between;
               gap: 1rem; flex-wrap: wrap; }
  /* Landing on the chart from a bar: not flush against the top of the window. */
  #timings-chart { scroll-margin-top: .75rem; }
  .chartwrap { position: relative; margin: .5rem 0 .25rem; }
  .chartwrap svg { display: block; width: 100%; height: auto; overflow: visible; }
  .chartwrap .hit { fill: transparent; cursor: pointer; }
  .chartwrap .hit:hover { fill: var(--chart-focus); }
  .chartwrap .hit:focus-visible { fill: var(--chart-focus); outline: 1px solid var(--link); }
  .chartwrap .grid { stroke: currentColor; stroke-opacity: .12; }
  .axis { fill: var(--muted); font-size: 10px; font-family: inherit; }
  .chartline { fill: none; stroke: var(--chart); stroke-width: 2; stroke-linejoin: round;
               stroke-linecap: round; }
  .chartarea { fill: var(--chart); fill-opacity: .12; }
  .chartdot { fill: var(--chart); }
  .band { fill: var(--chart-band); pointer-events: none; }
  .dayline { stroke: currentColor; stroke-opacity: .22; stroke-dasharray: 2 3; }
  .tooltip { position: absolute; transform: translate(-50%, -100%); pointer-events: none;
             background: var(--tooltip-bg); color: var(--tooltip-fg); font-size: .78rem;
             line-height: 1.35; padding: .3rem .5rem; border-radius: 6px; white-space: nowrap;
             z-index: 2; }
  .chip { display: inline-flex; align-items: center; gap: .5rem; font-size: .85rem;
          border: 1px solid var(--link); color: var(--link); border-radius: 999px;
          padding: .1rem .3rem .1rem .7rem; margin: 0 0 .75rem; }
  .chip a { color: inherit; text-decoration: none; padding: .15rem .35rem; }
  /* An author display rule beats the UA rule for [hidden]; say it again. */
  .chip[hidden] { display: none; }
  .pill { display: inline-block; white-space: nowrap; font-size: .72rem; line-height: 1.5;
          padding: 0 .45rem; border: 1px solid; border-radius: 999px; }
  .pill-supported { color: var(--pill-ok-fg); border-color: var(--pill-ok-fg);
                    background: var(--pill-ok-bg); }
  .pill-partial { color: var(--pill-partial-fg); border-color: var(--pill-partial-fg);
                  background: var(--pill-partial-bg); }
  .pill-unsupported { color: var(--pill-unsupported-fg); border-color: var(--pill-unsupported-fg);
                      background: var(--pill-unsupported-bg); }

  /* Configuration flags: the flag and its argument stay on one line, and the
     purpose column keeps body contrast instead of fading into the table. */
  .ops .flagtable td:first-child { white-space: nowrap; }
  .ops .flagtable td.purpose { color: inherit; }
  .fidelitymodes td:first-child { width: 7rem; }
  .fidelity-form { display: flex; align-items: center; gap: .6rem; margin: 1rem 0 .25rem; }
  .fidelity-form label { font-size: .9rem; color: var(--muted); }
  .fidelity-form select { font: inherit; font-size: .9rem; padding: .3rem 2rem .3rem .55rem;
                          border: 1px solid var(--border); border-radius: 6px;
                          background: var(--input-bg); color: inherit; }
  .fidelity-form select:disabled, .fidelity-form button:disabled { opacity: .55; cursor: not-allowed; }
  .err-note { border: 1px solid var(--danger-fg); background: var(--danger-bg); color: var(--danger-fg);
              border-radius: 6px; padding: .5rem .75rem; margin: .5rem 0 .9rem; }

  /* Settings: the control first, so it is the first thing on the page. */
  .settings-control { border: 1px solid var(--border); border-radius: 10px; background: var(--surface);
                      padding: 1rem 1.15rem; margin: 1.25rem 0 1.75rem; }
  .settings-control-row { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
  .settings-control-row label { font-weight: 600; }
  .settings-control select { font: inherit; font-size: 1rem; padding: .4rem 2.2rem .4rem .6rem;
                             border: 1px solid var(--border); border-radius: 6px;
                             background: var(--input-bg); color: inherit; }
  .settings-control select:disabled, .settings-control button:disabled { opacity: .55; cursor: not-allowed; }
  .settings-current { margin: .75rem 0 0; }
  .settings-current .muted { margin-left: .35rem; }

  /* The rows dropdown above the timings table. */
  .timings-filter { display: flex; align-items: center; gap: .5rem; margin: .6rem 0 .3rem; }
  .timings-filter label { font-size: .9rem; color: var(--muted); }
  .timings-filter select { font: inherit; font-size: .9rem; padding: .3rem 2rem .3rem .55rem;
                           border: 1px solid var(--border); border-radius: 6px;
                           background: var(--input-bg); color: inherit; }
`;

export type NavKey = 'home' | 'operations' | 'configuration' | 'troubleshooting' | 'self-test' | 'settings';

const NAV: Array<[NavKey, string, string]> = [
  ['home', '/', 'Home'],
  ['operations', '/operations', 'Operations'],
  ['configuration', '/configuration', 'Configuration'],
  ['troubleshooting', '/troubleshooting', 'Troubleshooting'],
  ['self-test', '/self-test', 'Self Test'],
  ['settings', '/settings', 'Settings'],
];

export interface TabItem {
  /** Panel id; also the URL fragment when the tab list syncs the hash. */
  id: string;
  label: string;
  /** Tooltip for a shortened label. */
  title?: string;
  html: string;
}

export interface TabOptions {
  /** Mirror the selected tab in `location.hash`; one list per page. */
  hash?: boolean;
  variant?: 'dense' | 'sub';
}

/** Tab strip of plain links, for sub-pages that sit under another page's tab. */
export function renderTabLinks(items: ReadonlyArray<{ href: string; label: string }>, current: string): string {
  const links = items
    .map(
      (item) =>
        `<a class="tab" href="${escapeHtml(item.href)}"${item.href === current ? ' aria-current="page"' : ''}>${escapeHtml(item.label)}</a>`,
    )
    .join('');
  return `<nav class="tabs" aria-label="Sections">${links}</nav>`;
}

/** Tab strip plus panels. The strip starts hidden; TAB_SCRIPT reveals it. */
export function renderTabs(items: TabItem[], { hash = false, variant }: TabOptions = {}): string {
  const cls = variant ? `tabs ${variant}` : 'tabs';
  // Panel ids are prefixed so a `#tab` fragment selects a tab without the browser scrolling to it.
  const buttons = items
    .map((item) => {
      const id = escapeHtml(item.id);
      const tip = item.title ? ` title="${escapeHtml(item.title)}"` : '';
      return `<button type="button" role="tab" class="tab" id="tab-${id}" aria-controls="pane-${id}" data-tab="${id}"${tip}>${escapeHtml(item.label)}</button>`;
    })
    .join('');
  const panels = items
    .map((item) => {
      const id = escapeHtml(item.id);
      return `<section role="tabpanel" class="pane" id="pane-${id}" aria-labelledby="tab-${id}">\n${item.html}\n</section>`;
    })
    .join('\n');
  return `<div class="${cls}" role="tablist" data-tabs${hash ? ' data-hash' : ''} hidden>${buttons}</div>\n${panels}`;
}

// Selects the tab named by the hash (else the first); only user choices write the hash, so loads stay at the top.
const TAB_SCRIPT = `<script>
(() => {
  for (const list of document.querySelectorAll('[role=tablist][data-tabs]')) {
    const tabs = [...list.querySelectorAll('[role=tab]')];
    const sync = list.hasAttribute('data-hash');
    const select = (id, chosen) => {
      const hit = tabs.find((t) => t.dataset.tab === id);
      if (!hit) return false;
      for (const t of tabs) {
        const on = t === hit;
        t.setAttribute('aria-selected', on);
        t.tabIndex = on ? 0 : -1;
        document.getElementById('pane-' + t.dataset.tab).hidden = !on;
      }
      if (chosen && sync) history.replaceState(null, '', '#' + id);
      return true;
    };
    list.hidden = false;
    list.addEventListener('click', (e) => {
      const t = e.target.closest('[role=tab]');
      if (t) select(t.dataset.tab, true);
    });
    list.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      const i = tabs.indexOf(document.activeElement);
      if (!step || i < 0) return;
      e.preventDefault();
      const next = tabs[(i + step + tabs.length) % tabs.length];
      select(next.dataset.tab, true);
      next.focus();
    });
    const fromHash = () => sync && select(decodeURIComponent(location.hash.slice(1)), false);
    if (!fromHash()) select(tabs[0].dataset.tab, false);
    if (sync) addEventListener('hashchange', fromHash);
  }
})();
</script>`;

export interface PageOptions {
  title: string;
  body: string;
  /** Emulated Snowflake version, shown in the header tag. */
  version: string;
  /** Highlighted nav entry; omit for pages outside the nav (catalog browser). */
  nav?: NavKey;
}

/** Wrap rendered body markup in the shared document shell. */
export function renderPage({ title, body, version, nav }: PageOptions): string {
  const links = NAV.map(
    ([key, href, label]) =>
      `<a href="${href}"${key === nav ? ' aria-current="page"' : ''}>${label}</a>`,
  ).join('');
  const script = body.includes('data-tabs') ? `\n${TAB_SCRIPT}` : '';
  return `<!doctype html>
<html lang="en" data-theme-choice="${DEFAULT_THEME}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}${THEME_STYLES}</style>
${THEME_SCRIPT}
</head>
<body>
<div class="toptag">
<span>snowtest ${escapeHtml(PACKAGE_VERSION)} &middot; emulating Snowflake ${escapeHtml(version)}</span>
${renderThemeControl()}
</div>
<nav class="topnav" aria-label="Site">${links}</nav>
${body}${script}
</body>
</html>
`;
}
