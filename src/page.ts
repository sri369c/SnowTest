// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * The shell shared by the pages the server renders itself.
 *
 * Pages are rendered inline rather than shipped as static files so the runtime
 * image keeps carrying nothing but `dist/`, which means both of them need the
 * same head, the same stylesheet and the same escaping rules. One copy here,
 * imported by every page renderer, keeps them from drifting apart.
 */

import { PACKAGE_VERSION } from './version.js';

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
  :root { color-scheme: light dark; scrollbar-gutter: stable; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; padding: 2.5rem 1.25rem 4rem; max-width: 64rem;
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #1b1f24; background: #fff;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #e6edf3; background: #0d1117; }
    code, pre { background: #161b22 !important; border-color: #30363d !important; }
    th, td { border-color: #30363d !important; }
    .card { background: #161b22 !important; border-color: #30363d !important; }
    a { color: #6cb6ff; }
  }
  h1 { font-size: 1.9rem; margin: 0 0 .25rem; letter-spacing: -.02em; }
  h2 { font-size: 1.15rem; margin: 2.25rem 0 .75rem; }
  h3 { font-size: .95rem; margin: 1.5rem 0 .4rem; }
  .muted { color: #57606a; font-size: .9rem; }
  p { margin: .6rem 0; }
  .tag { display: inline-block; font-size: .75rem; letter-spacing: .04em;
         text-transform: uppercase; color: #57606a; margin-bottom: .5rem; }
  .lede { font-size: 1.02rem; color: #57606a; }
  .card { border: 1px solid #d0d7de; border-radius: 8px; padding: 1rem 1.15rem;
          background: #f6f8fa; margin: 1.25rem 0; }
  table { border-collapse: collapse; width: 100%; font-size: .92rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #d0d7de;
           vertical-align: top; }
  th { font-weight: 600; }
  td:first-child { white-space: nowrap; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
         font-size: .875em; background: #f6f8fa; border: 1px solid #d0d7de;
         border-radius: 5px; padding: .1rem .3rem; }
  pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 8px;
        padding: .85rem 1rem; overflow-x: auto; font-size: .85rem; line-height: 1.5; }
  pre code { background: none; border: 0; padding: 0; font-size: inherit; }
  ul { margin: .5rem 0; padding-left: 1.2rem; }
  li { margin: .25rem 0; }
  a { color: #0969da; }
  .warn { border-left: 3px solid #bf8700; padding-left: .9rem; color: #57606a; }
  footer { margin-top: 3rem; font-size: .85rem; color: #57606a; }

  /* Site header: version tag above the page nav. */
  .toptag { font-size: .72rem; letter-spacing: .04em; text-transform: uppercase; color: #57606a;
            margin: -1.25rem 0 .75rem; }
  .topnav { display: flex; flex-wrap: wrap; gap: 0 1.25rem; font-size: .9rem; margin: 0 0 1.5rem;
            padding-bottom: .5rem; border-bottom: 1px solid #d0d7de; }
  .topnav a { text-decoration: none; color: #57606a; }
  .topnav a[aria-current] { color: inherit; font-weight: 600; }
  .crumb { font-size: .88rem; margin: 0 0 .75rem; }

  /* Tabs. Panels stay visible until the script runs, so nothing hides without JS. */
  .tabs { display: flex; flex-wrap: wrap; gap: .15rem; border-bottom: 1px solid #d0d7de;
          margin: 1.75rem 0 1rem; }
  .tabs.dense { gap: 0; font-size: .9rem; }
  .tabs.sub { margin: .5rem 0 .75rem; font-size: .9rem; }
  .tab { font: inherit; color: inherit; background: none; cursor: pointer; padding: .35rem .8rem;
         margin-bottom: -1px; border: 1px solid transparent; border-radius: 6px 6px 0 0; }
  .tabs.dense .tab { padding: .35rem .55rem; }
  .tab:hover { background: #f6f8fa; }
  a.tab { text-decoration: none; }
  .tab[aria-selected="true"], .tab[aria-current] { border-color: #0969da; border-bottom: 2px solid #0969da;
                               color: #0969da; border-radius: 6px; }
  .panehead { margin: .5rem 0 .25rem; font-size: 1.05rem; display: flex; align-items: center; gap: .5rem; }
  .badge { display: inline-block; font-size: .72rem; line-height: 1.4; padding: 0 .4rem;
           border-radius: 999px; background: #eaeef2; color: #57606a; font-weight: 600; }
  .rn { width: 2.5rem; text-align: right; color: #57606a; font-variant-numeric: tabular-nums; }
  .livebar { display: flex; align-items: center; justify-content: flex-end; gap: .6rem; margin: .25rem 0; }
  .livebar .muted { font-size: .8rem; }
  .refresh { display: inline-flex; align-items: center; gap: .35rem; font: inherit; font-size: .85rem;
             cursor: pointer; color: #0969da; background: none; border: 1px solid #d0d7de;
             border-radius: 6px; padding: .2rem .6rem; }
  .refresh:hover { background: #f6f8fa; border-color: #0969da; }
  .refresh svg { width: 14px; height: 14px; }
  .refresh.busy svg { animation: spin .8s linear infinite; }
  .refresh.err { color: #b42318; border-color: #b42318; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-color-scheme: dark) {
    .tabs, .topnav { border-color: #30363d; }
    .tab:hover, .refresh:hover { background: #161b22; }
    .tab[aria-selected="true"], .tab[aria-current] { border-color: #6cb6ff; color: #6cb6ff; }
    .badge { background: #30363d; color: #9da7b3; }
    .refresh { color: #6cb6ff; border-color: #30363d; }
  }

  .ops td:first-child { white-space: normal; }
  .ops thead th { position: sticky; top: 0; z-index: 1; background: #fff; }
  @media (prefers-color-scheme: dark) { .ops thead th { background: #0d1117; } }
  .ops h2 { scroll-margin-top: 1rem; }
  .note { display: block; color: #57606a; font-size: .82rem; margin-top: .15rem; }
  .null { color: #57606a; font-style: italic; }
  .scroller { overflow-x: auto; margin: 1.25rem 0; }
  .scroller table { min-width: 100%; }
  .scroller td { white-space: nowrap; }
  .pill { display: inline-block; white-space: nowrap; font-size: .72rem; line-height: 1.5;
          padding: 0 .45rem; border: 1px solid; border-radius: 999px; }
  .pill-supported { color: #1a7f37; border-color: #1a7f37; background: #eaf6ec; }
  .pill-partial { color: #9a6700; border-color: #9a6700; background: #fff8e6; }
  .pill-unsupported { color: #b42318; border-color: #b42318; background: #fdecea; }
  @media (prefers-color-scheme: dark) {
    .pill-supported { color: #3fb950; border-color: #3fb950; background: #12261a; }
    .pill-partial { color: #d29922; border-color: #d29922; background: #2a2113; }
    .pill-unsupported { color: #f85149; border-color: #f85149; background: #2d1618; }
  }
`;

export type NavKey = 'home' | 'operations' | 'configuration' | 'troubleshooting';

const NAV: Array<[NavKey, string, string]> = [
  ['home', '/', 'Home'],
  ['operations', '/operations', 'Operations'],
  ['configuration', '/configuration', 'Configuration'],
  ['troubleshooting', '/troubleshooting', 'Troubleshooting'],
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
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="toptag">snowtest ${escapeHtml(PACKAGE_VERSION)} &middot; emulating Snowflake ${escapeHtml(version)}</div>
<nav class="topnav" aria-label="Site">${links}</nav>
${body}${script}
</body>
</html>
`;
}
