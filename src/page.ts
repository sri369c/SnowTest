// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * The shell shared by the pages the server renders itself.
 *
 * Pages are rendered inline rather than shipped as static files so the runtime
 * image keeps carrying nothing but `dist/`, which means both of them need the
 * same head, the same stylesheet and the same escaping rules. One copy here,
 * imported by `home.ts` and `operations.ts`, keeps them from drifting apart.
 */

/** Escape text for HTML text nodes and attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );
}

const STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; padding: 2.5rem 1.25rem 4rem; max-width: 52rem;
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #1b1f24; background: #fff;
  }
  .wide { max-width: 64rem; }
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

  /* Reference page: a sticky index beside long tables. */
  .crumb { font-size: .88rem; margin: 0 0 .75rem; }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0 2.5rem; }
  @media (min-width: 60rem) {
    .layout { grid-template-columns: 12rem minmax(0, 1fr); }
    .toc { position: sticky; top: 1.5rem; align-self: start; }
  }
  .toc ol { list-style: none; margin: .4rem 0 1.25rem; padding: 0; font-size: .88rem; }
  .toc li { margin: .3rem 0; display: flex; justify-content: space-between; gap: .5rem; }
  .toc .count { color: #57606a; font-size: .8rem; }
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

export interface PageOptions {
  title: string;
  body: string;
  /** Extra class on `<body>`; the reference page uses `wide` for its tables. */
  bodyClass?: string;
}

/** Wrap rendered body markup in the shared document shell. */
export function renderPage({ title, body, bodyClass }: PageOptions): string {
  const bodyTag = bodyClass ? `<body class="${escapeHtml(bodyClass)}">` : '<body>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
${bodyTag}
${body}
</body>
</html>
`;
}
