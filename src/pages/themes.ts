// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * The theme control: eleven palettes, the menu that picks one, and the inline
 * script that resolves the choice before the first paint.
 *
 * It sits beside the page shell rather than inside it because a palette is data
 * and one block of CSS: adding a theme is a line in THEMES, its token block and
 * its swatch, never a hunt through the layout.
 *
 * The preference is the reader's, not the server's. The choice is kept in
 * `sessionStorage`, so a reload holds it, a closed tab forgets it, and nothing
 * about it is sent anywhere; `system` is the default and resolves to light or
 * midnight from the device.
 *
 * Every string rendered here is a constant in this module, never request data,
 * which is why the markup is written as-is rather than escaped.
 */

interface Theme {
  /** Matches `data-theme` and the stored value. */
  id: string;
  label: string;
  /** One line under the name in the menu. */
  note: string;
  /** Heading it sits under in the menu. */
  group: string;
  /** Which glyph the toggle wears while this theme is the choice. */
  glyph: 'sun' | 'moon' | 'auto';
}

/**
 * The palettes, in menu order. `system` is the default and resolves to light or
 * midnight from the device, so a first visit still looks exactly as it did
 * before themes existed. Its swatch is drawn as a split tile, not by `note`.
 */
const THEMES: Theme[] = [
  { id: 'light', label: 'Light', note: 'Ink on paper.', group: 'Light', glyph: 'sun' },
  { id: 'dawn', label: 'Rosé Pine Dawn', note: 'Warm rose paper.', group: 'Light', glyph: 'sun' },
  { id: 'latte', label: 'Catppuccin Latte', note: 'Cool, soft paper.', group: 'Light', glyph: 'sun' },
  { id: 'sky', label: 'Sky', note: 'Cool blue paper.', group: 'Light', glyph: 'sun' },
  { id: 'mint', label: 'Mint', note: 'Pale green paper.', group: 'Light', glyph: 'sun' },
  { id: 'lilac', label: 'Lilac', note: 'Pale violet paper.', group: 'Light', glyph: 'sun' },
  { id: 'midnight', label: 'Midnight', note: 'Blue-black, low glare.', group: 'Dark', glyph: 'moon' },
  { id: 'ocean', label: 'Ocean', note: 'Deep navy blue.', group: 'Dark', glyph: 'moon' },
  { id: 'forest', label: 'Forest', note: 'Deep forest green.', group: 'Dark', glyph: 'moon' },
  { id: 'plum', label: 'Plum', note: 'Deep aubergine.', group: 'Dark', glyph: 'moon' },
  { id: 'system', label: 'System', note: 'Follows this device.', group: 'Automatic', glyph: 'auto' },
];

/** The default when the browser has nothing stored. */
export const DEFAULT_THEME = 'system';

/** The theme ids, for the head script's validation. One list, two uses. */
const THEME_IDS = THEMES.map((theme) => `'${theme.id}'`).join(', ');

/** One glyph per family; the attribute rule in STYLES picks which is visible. */
const GLYPH_RULES = THEMES.map(
  (theme) => `  html[data-theme-choice="${theme.id}"] .theme-toggle .i-${theme.glyph}`,
).join(',\n');

/** The palettes, and the control that picks one. */
export const THEME_STYLES = `
  /* Palette tokens. :root is Light; every other theme redefines these and
     nothing below names a colour, so adding a palette is one block. */
  :root {
    color-scheme: light; scrollbar-gutter: stable;
    --bg: #fff; --fg: #1b1f24; --muted: #57606a; --border: #d0d7de;
    --surface: #f6f8fa; --link: #0969da;
    --modal-bg: #fff; --input-bg: #fff; --overlay: rgba(31, 35, 40, .35);
    --ok-fg: #1a7f37; --ok-bg: #f0fff4; --ok-border: #1a7f37;
    --danger-fg: #b42318; --danger-bg: #fdecea; --danger-hover: #fff5f5;
    --warn: #bf8700;
    --badge-bg: #eaeef2; --badge-fg: #57606a;
    --note-bg: #eef1f4; --note-border: #8c959f; --note-fg: #24292f;
    --tooltip-bg: #1b1f24; --tooltip-fg: #fff;
    --pill-ok-fg: #1a7f37; --pill-ok-bg: #eaf6ec;
    --pill-partial-fg: #9a6700; --pill-partial-bg: #fff8e6;
    --pill-unsupported-fg: #b42318; --pill-unsupported-bg: #fdecea;
    --chart: #0969da; --chart-focus: rgba(9, 105, 218, .08); --chart-band: rgba(9, 105, 218, .14);
  }
  html[data-theme="dawn"] {
    color-scheme: light;
    --bg: #faf4ed; --fg: #575279; --muted: #6a6683; --border: #e3d8cf;
    --surface: #f2e9e1; --link: #286983;
    --modal-bg: #fffaf3; --input-bg: #fffaf3;
    --ok-fg: #42717a; --ok-bg: #f1ede7; --ok-border: #42717a;
    --danger-fg: #a44f67; --danger-bg: #f5eae5; --danger-hover: #f9f0ec;
    --warn: #b57614;
    --badge-bg: #ece5de; --badge-fg: #66627e;
    --note-bg: #f2e9e1; --note-border: #cbbfb4; --note-fg: #575279;
    --tooltip-bg: #575279; --tooltip-fg: #fdf9f3;
    --pill-ok-fg: #42717a; --pill-ok-bg: #f1ede7;
    --pill-partial-fg: #965d10; --pill-partial-bg: #f5ece2;
    --pill-unsupported-fg: #a44f67; --pill-unsupported-bg: #f5eae5;
    --chart: #286983; --chart-focus: rgba(40, 105, 131, .10); --chart-band: rgba(40, 105, 131, .14);
  }
  html[data-theme="latte"] {
    color-scheme: light;
    --bg: #eff1f5; --fg: #4c4f69; --muted: #5c5f77; --border: #d5d9e4;
    --surface: #e6e9ef; --link: #0e5bf4;
    --modal-bg: #f7f8fb; --input-bg: #f7f8fb;
    --ok-fg: #307820; --ok-bg: #e5ebea; --ok-border: #307820;
    --danger-fg: #c30d35; --danger-bg: #ede6ec; --danger-hover: #f3eef2;
    --warn: #b0700f;
    --badge-bg: #dde1ea; --badge-fg: #5c5f77;
    --note-bg: #dce0e8; --note-border: #9ca0b0; --note-fg: #4c4f69;
    --tooltip-bg: #4c4f69; --tooltip-fg: #eff1f5;
    --pill-ok-fg: #307820; --pill-ok-bg: #e5ebea;
    --pill-partial-fg: #915d13; --pill-partial-bg: #eaeaea;
    --pill-unsupported-fg: #c30d35; --pill-unsupported-bg: #ede6ec;
    --chart: #0e5bf4; --chart-focus: rgba(14, 91, 244, .10); --chart-band: rgba(14, 91, 244, .14);
  }
  html[data-theme="sky"] {
    color-scheme: light;
    --bg: #eef5fc; --fg: #1b2a3d; --muted: #56687e; --border: #cbdcef;
    --surface: #e2edf9; --link: #1a63b8;
    --modal-bg: #f5faff; --input-bg: #f5faff;
    --ok-fg: #1a7f37; --ok-bg: #e9f5ee; --ok-border: #1a7f37;
    --danger-fg: #b42318; --danger-bg: #fbeaea; --danger-hover: #fbeaea;
    --warn: #a06800;
    --badge-bg: #dce8f5; --badge-fg: #3f5670;
    --note-bg: #dce8f5; --note-border: #91a9c4; --note-fg: #24374d;
    --tooltip-bg: #12324f; --tooltip-fg: #f2f8ff;
    --pill-ok-fg: #1a7f37; --pill-ok-bg: #e9f5ee;
    --pill-partial-fg: #8a5a00; --pill-partial-bg: #fbf1dc;
    --pill-unsupported-fg: #b42318; --pill-unsupported-bg: #fbeaea;
    --chart: #1a63b8; --chart-focus: rgba(26, 99, 184, .10); --chart-band: rgba(26, 99, 184, .14);
  }
  html[data-theme="mint"] {
    color-scheme: light;
    --bg: #f2faf4; --fg: #17281d; --muted: #55695c; --border: #cfe4d6;
    --surface: #e6f4ea; --link: #17734a;
    --modal-bg: #f8fdf9; --input-bg: #f8fdf9;
    --ok-fg: #1a7f37; --ok-bg: #e8f6ec; --ok-border: #1a7f37;
    --danger-fg: #b42318; --danger-bg: #fbeaea; --danger-hover: #fbeaea;
    --warn: #8a6400;
    --badge-bg: #dcece0; --badge-fg: #3f5747;
    --note-bg: #dcece0; --note-border: #93b3a0; --note-fg: #1f3327;
    --tooltip-bg: #103425; --tooltip-fg: #f2fbf5;
    --pill-ok-fg: #1a7f37; --pill-ok-bg: #e8f6ec;
    --pill-partial-fg: #8a6400; --pill-partial-bg: #fbf3d9;
    --pill-unsupported-fg: #b42318; --pill-unsupported-bg: #fbeaea;
    --chart: #17734a; --chart-focus: rgba(23, 115, 74, .10); --chart-band: rgba(23, 115, 74, .14);
  }
  html[data-theme="lilac"] {
    color-scheme: light;
    --bg: #f9f6fe; --fg: #2a1d3d; --muted: #655a7c; --border: #e0d5f2;
    --surface: #f0e9fa; --link: #6b3fb8;
    --modal-bg: #fcfaff; --input-bg: #fcfaff;
    --ok-fg: #1a7f37; --ok-bg: #e9f5ee; --ok-border: #1a7f37;
    --danger-fg: #b42318; --danger-bg: #fbeaea; --danger-hover: #fbeaea;
    --warn: #8a5a00;
    --badge-bg: #ece2f8; --badge-fg: #4d3a68;
    --note-bg: #ece2f8; --note-border: #a892c9; --note-fg: #33254a;
    --tooltip-bg: #2a1d3d; --tooltip-fg: #f9f6fe;
    --pill-ok-fg: #1a7f37; --pill-ok-bg: #e9f5ee;
    --pill-partial-fg: #8a5a00; --pill-partial-bg: #fbf1dc;
    --pill-unsupported-fg: #b42318; --pill-unsupported-bg: #fbeaea;
    --chart: #6b3fb8; --chart-focus: rgba(107, 63, 184, .10); --chart-band: rgba(107, 63, 184, .14);
  }
  html[data-theme="midnight"] {
    color-scheme: dark;
    --bg: #0a0f1a; --fg: #dfe6f2; --muted: #8b98ad; --border: #232c3f;
    --surface: #111827; --link: #7aa2f7;
    --modal-bg: #111827; --input-bg: #0a0f1a; --overlay: rgba(2, 6, 14, .65);
    --ok-fg: #4ade80; --ok-bg: #0f2a1d; --ok-border: #2ea043;
    --danger-fg: #f87171; --danger-bg: #2d1618; --danger-hover: #2d1618;
    --warn: #e3b341;
    --badge-bg: #1b2436; --badge-fg: #9aa8bd;
    --note-bg: #111827; --note-border: #3b4a63; --note-fg: #cbd5e5;
    --tooltip-bg: #1b2436; --tooltip-fg: #e6edf3;
    --pill-ok-fg: #4ade80; --pill-ok-bg: #0f2a1d;
    --pill-partial-fg: #e3b341; --pill-partial-bg: #2a2313;
    --pill-unsupported-fg: #f87171; --pill-unsupported-bg: #2d1618;
    --chart: #7aa2f7; --chart-focus: rgba(122, 162, 247, .12); --chart-band: rgba(122, 162, 247, .16);
  }
  html[data-theme="ocean"] {
    color-scheme: dark;
    --bg: #071a2b; --fg: #d6e6f5; --muted: #7f9cb5; --border: #1b3b55;
    --surface: #0c2438; --link: #56b6ff;
    --modal-bg: #0c2438; --input-bg: #071a2b; --overlay: rgba(2, 6, 14, .65);
    --ok-fg: #4ade80; --ok-bg: #0b2a20; --ok-border: #2ea043;
    --danger-fg: #f87171; --danger-bg: #2d1a1c; --danger-hover: #2d1a1c;
    --warn: #e3b341;
    --badge-bg: #123049; --badge-fg: #9dc0dc;
    --note-bg: #0c2438; --note-border: #2f5674; --note-fg: #cbdcec;
    --tooltip-bg: #123049; --tooltip-fg: #e6f2fb;
    --pill-ok-fg: #4ade80; --pill-ok-bg: #0b2a20;
    --pill-partial-fg: #e3b341; --pill-partial-bg: #2a2313;
    --pill-unsupported-fg: #f87171; --pill-unsupported-bg: #2d1a1c;
    --chart: #56b6ff; --chart-focus: rgba(86, 182, 255, .14); --chart-band: rgba(86, 182, 255, .18);
  }
  html[data-theme="forest"] {
    color-scheme: dark;
    --bg: #08150f; --fg: #d9ebde; --muted: #86a695; --border: #1e3b2c;
    --surface: #0f231a; --link: #5fd39a;
    --modal-bg: #0f231a; --input-bg: #08150f; --overlay: rgba(2, 10, 6, .65);
    --ok-fg: #4ade80; --ok-bg: #0f2a1d; --ok-border: #2ea043;
    --danger-fg: #f87171; --danger-bg: #2d1a1c; --danger-hover: #2d1a1c;
    --warn: #e3b341;
    --badge-bg: #15352a; --badge-fg: #9dc4b0;
    --note-bg: #0f231a; --note-border: #2c5442; --note-fg: #cfe6d8;
    --tooltip-bg: #15352a; --tooltip-fg: #e7f4ec;
    --pill-ok-fg: #4ade80; --pill-ok-bg: #0f2a1d;
    --pill-partial-fg: #e3b341; --pill-partial-bg: #2a2313;
    --pill-unsupported-fg: #f87171; --pill-unsupported-bg: #2d1a1c;
    --chart: #5fd39a; --chart-focus: rgba(95, 211, 154, .14); --chart-band: rgba(95, 211, 154, .18);
  }
  html[data-theme="plum"] {
    color-scheme: dark;
    --bg: #150e1d; --fg: #e8ddf5; --muted: #a496b8; --border: #33254a;
    --surface: #1e1529; --link: #c9a1ff;
    --modal-bg: #1e1529; --input-bg: #150e1d; --overlay: rgba(8, 4, 14, .65);
    --ok-fg: #4ade80; --ok-bg: #0f2a1d; --ok-border: #2ea043;
    --danger-fg: #f87171; --danger-bg: #2d1618; --danger-hover: #2d1618;
    --warn: #e3b341;
    --badge-bg: #2a1f3b; --badge-fg: #bdaad6;
    --note-bg: #1e1529; --note-border: #4a3766; --note-fg: #d9cdec;
    --tooltip-bg: #2a1f3b; --tooltip-fg: #efe6fb;
    --pill-ok-fg: #4ade80; --pill-ok-bg: #0f2a1d;
    --pill-partial-fg: #e3b341; --pill-partial-bg: #2a2313;
    --pill-unsupported-fg: #f87171; --pill-unsupported-bg: #2d1618;
    --chart: #c9a1ff; --chart-focus: rgba(201, 161, 255, .12); --chart-band: rgba(201, 161, 255, .16);
  }
  /* With no script no attribute is ever set, and the default is System: a dark
     device still gets a dark page. CSS cannot share a block between an attribute
     selector and a media query, so these are the midnight tokens again; keep the
     two in step. */
  @media (prefers-color-scheme: dark) {
    html:not([data-theme]) {
      color-scheme: dark;
      --bg: #0a0f1a; --fg: #dfe6f2; --muted: #8b98ad; --border: #232c3f;
      --surface: #111827; --link: #7aa2f7;
      --modal-bg: #111827; --input-bg: #0a0f1a; --overlay: rgba(2, 6, 14, .65);
      --ok-fg: #4ade80; --ok-bg: #0f2a1d; --ok-border: #2ea043;
      --danger-fg: #f87171; --danger-bg: #2d1618; --danger-hover: #2d1618;
      --warn: #e3b341;
      --badge-bg: #1b2436; --badge-fg: #9aa8bd;
      --note-bg: #111827; --note-border: #3b4a63; --note-fg: #cbd5e5;
      --tooltip-bg: #1b2436; --tooltip-fg: #e6edf3;
      --pill-ok-fg: #4ade80; --pill-ok-bg: #0f2a1d;
      --pill-partial-fg: #e3b341; --pill-partial-bg: #2a2313;
      --pill-unsupported-fg: #f87171; --pill-unsupported-bg: #2d1618;
      --chart: #7aa2f7; --chart-focus: rgba(122, 162, 247, .12); --chart-band: rgba(122, 162, 247, .16);
    }
  }

  /* The theme control: one button, a menu of palettes painted in their own colours. */
  .theme { position: relative; display: inline-flex; letter-spacing: 0; text-transform: none; }
  .theme-toggle { display: inline-flex; align-items: center; justify-content: center;
                  width: 1.75rem; height: 1.75rem; padding: 0; margin: -.35rem -.35rem -.35rem 0;
                  color: var(--muted); background: none; border: 1px solid transparent;
                  border-radius: 7px; cursor: pointer; }
  .theme-toggle:hover { color: var(--link); background: var(--surface); border-color: var(--border); }
  .theme-toggle[aria-expanded="true"] { color: var(--link); background: var(--surface);
                                        border-color: var(--border); }
  .theme-toggle svg { display: none; width: 16px; height: 16px; }
  /* One glyph per family, so the icon still says "light" or "dark" while the
     accent follows the page. The list is generated from THEMES. */
${GLYPH_RULES},
  html:not([data-theme-choice]) .theme-toggle .i-auto { display: block; }

  .theme-menu { position: absolute; top: calc(100% + .4rem); right: 0; z-index: 20;
                width: min(26rem, calc(100vw - 1.5rem)); padding: .3rem; margin: 0;
                max-height: min(70vh, 34rem); overflow-y: auto; overscroll-behavior: contain;
                background: var(--modal-bg); border: 1px solid var(--border); border-radius: 10px;
                box-shadow: 0 12px 32px var(--overlay);
                animation: pop .12s ease-out; }
  .theme-menu[hidden] { display: none; }
  /* Light and dark side by side; anything that is neither runs full width below. */
  .theme-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 .35rem;
                align-items: start; }
  @keyframes pop { from { opacity: 0; transform: translateY(-4px); } }
  .theme-menu .group { margin: .5rem .45rem .1rem; font-size: .66rem; letter-spacing: .07em;
                       text-transform: uppercase; color: var(--muted); }
  .theme-menu .group:first-child { margin-top: .1rem; }
  .theme-item { display: flex; align-items: center; gap: .6rem; width: 100%; min-height: 2.6rem;
                font: inherit; font-size: .86rem; text-align: left; color: var(--fg);
                background: none; border: 0; border-radius: 7px; padding: .24rem .4rem;
                cursor: pointer; }
  .theme-item:hover, .theme-item:focus-visible { background: var(--surface); }
  .theme-item .name { flex: 1 1 auto; }
  .theme-item[aria-checked="true"] .name { font-weight: 600; }
  .theme-item .sub { display: block; font-size: .7rem; color: var(--muted); font-weight: 400;
                     line-height: 1.2; margin-top: .05rem; }
  .theme-item .tick { width: 14px; height: 14px; color: var(--link); opacity: 0; flex: 0 0 auto; }
  .theme-item[aria-checked="true"] .tick { opacity: 1; }
  /* A tick belongs to the row it marks, so each column keeps it on its own outer
     edge: leading in the light column, trailing in the dark one. Trailing in both
     left the light column's tick floating in the gutter, where it read as the
     dark column's. */
  .theme-col:first-child .theme-item .tick { order: -1; }
  .theme-toggle:focus-visible, .theme-item:focus-visible { outline: 2px solid var(--link);
                                                           outline-offset: 1px; }

  /* A row's little page: that theme's paper, border and accent, whatever is on. */
  .swatch { flex: 0 0 auto; width: 32px; height: 24px; border-radius: 5px;
            border: 1px solid; display: flex; flex-direction: column; justify-content: center;
            gap: 3px; padding: 0 5px; }
  .swatch i { display: block; height: 2px; border-radius: 2px; }
  .sw-light { background: #fff; border-color: #d0d7de; }
  .sw-light .a { background: #0969da; width: 100%; }
  .sw-light .b { background: #1b1f24; width: 65%; opacity: .45; }
  .sw-dawn { background: #faf4ed; border-color: #e0d4cb; }
  .sw-dawn .a { background: #286983; width: 100%; }
  .sw-dawn .b { background: #575279; width: 65%; opacity: .5; }
  .sw-latte { background: #eff1f5; border-color: #ccd0da; }
  .sw-latte .a { background: #0e5bf4; width: 100%; }
  .sw-latte .b { background: #4c4f69; width: 65%; opacity: .45; }
  .sw-sky { background: #eef5fc; border-color: #cbdcef; }
  .sw-sky .a { background: #1a63b8; width: 100%; }
  .sw-sky .b { background: #1b2a3d; width: 65%; opacity: .45; }
  .sw-mint { background: #f2faf4; border-color: #cfe4d6; }
  .sw-mint .a { background: #17734a; width: 100%; }
  .sw-mint .b { background: #17281d; width: 65%; opacity: .45; }
  .sw-lilac { background: #f9f6fe; border-color: #e0d5f2; }
  .sw-lilac .a { background: #6b3fb8; width: 100%; }
  .sw-lilac .b { background: #2a1d3d; width: 65%; opacity: .45; }
  .sw-midnight { background: #0a0f1a; border-color: #232c3f; }
  .sw-midnight .a { background: #7aa2f7; width: 100%; }
  .sw-midnight .b { background: #dfe6f2; width: 65%; opacity: .4; }
  .sw-ocean { background: #071a2b; border-color: #1b3b55; }
  .sw-ocean .a { background: #56b6ff; width: 100%; }
  .sw-ocean .b { background: #d6e6f5; width: 65%; opacity: .4; }
  .sw-forest { background: #08150f; border-color: #1e3b2c; }
  .sw-forest .a { background: #5fd39a; width: 100%; }
  .sw-forest .b { background: #d9ebde; width: 65%; opacity: .4; }
  .sw-plum { background: #150e1d; border-color: #33254a; }
  .sw-plum .a { background: #c9a1ff; width: 100%; }
  .sw-plum .b { background: #e8ddf5; width: 65%; opacity: .4; }
  .sw-system { border-color: #d0d7de; overflow: hidden; padding: 0;
               background: linear-gradient(100deg, #fff 0 50%, #0a0f1a 50% 100%); }
  .sw-system::before { content: ""; display: block; height: 2px; border-radius: 2px;
                       margin: 5px 0 0 5px; width: 55%;
                       background: linear-gradient(100deg, #0969da 0 50%, #7aa2f7 50% 100%); }
  .theme-sep { height: 1px; background: var(--border); margin: .35rem .4rem; }
  /* Two columns need the width; below this the menu is one list again. */
  @media (max-width: 34rem) {
    .theme-menu { width: min(20rem, calc(100vw - 1.5rem)); }
    .theme-cols { grid-template-columns: 1fr; gap: 0; }
    /* One list again, so one place for the tick: trailing, as in a menuitemradio. */
    .theme-col:first-child .theme-item .tick { order: 0; }
  }
  @media (prefers-reduced-motion: reduce) { .theme-menu { animation: none; } }

`;

/** One row: swatch, name, note, and the tick the script moves. */
function themeItem(theme: Theme): string {
  const swatch =
    theme.id === 'system'
      ? '<span class="swatch sw-system" aria-hidden="true"></span>'
      : `<span class="swatch sw-${theme.id}" aria-hidden="true"><i class="a"></i><i class="b"></i></span>`;
  return `
      <button type="button" role="menuitemradio" class="theme-item" data-choice="${theme.id}" aria-checked="${theme.id === DEFAULT_THEME ? 'true' : 'false'}">
        ${swatch}
        <span class="name">${theme.label}<span class="sub">${theme.note}</span></span>
        <svg class="tick" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8.5l3.5 3.5 7.5-8"/></svg>
      </button>`;
}

/** The two groups that pair as columns; every other group runs full width. */
const COLUMN_GROUPS = ['Light', 'Dark'];

/**
 * The theme control's menu, in one place with its data.
 *
 * System is the default and most readers want it, so it leads: full width under its
 * own heading, then a hairline, then Light and dark side by side. Anything that is
 * neither light nor dark can never be filed under a column it does not belong to.
 *
 * It renders server-side rather than being built by the script: the menu is
 * content, the script only decides which row is checked and what the page wears.
 */
function themeMenu(): string {
  const rows = (group: string) =>
    THEMES.filter((theme) => theme.group === group).map(themeItem).join('');
  let markup = '';
  let group = '';
  for (const theme of THEMES.filter((entry) => !COLUMN_GROUPS.includes(entry.group))) {
    if (theme.group !== group) {
      group = theme.group;
      markup += `
      <p class="group" role="presentation">${group}</p>`;
    }
    markup += themeItem(theme);
  }
  markup += `
      <div class="theme-sep" role="presentation"></div>
      <div class="theme-cols">
        <div class="theme-col">
          <p class="group" role="presentation">Light</p>${rows('Light')}
        </div>
        <div class="theme-col">
          <p class="group" role="presentation">Dark</p>${rows('Dark')}
        </div>
      </div>`;
  return markup;
}

/** The control the shell embeds: the toggle button and the menu it opens. */
export function renderThemeControl(): string {
  return `<div class="theme">
<button type="button" class="theme-toggle" aria-haspopup="menu" aria-expanded="false" aria-label="Theme">${THEME_GLYPHS}</button>
<div class="theme-menu" id="theme-menu" role="menu" aria-label="Theme" hidden>${themeMenu()}
</div>
</div>`;
}

/**
 * Resolves the stored choice before the body is parsed, so a page never paints
 * in the wrong palette and then corrects itself. Kept inline and tiny: the
 * reader's browser gets it with the page, and it is the only script that must
 * run first.
 */
export const THEME_SCRIPT = `<script>
(() => {
  const KEY = 'snowtest-theme';
  const CHOICES = [${THEME_IDS}];
  const root = document.documentElement;
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const read = () => {
    try {
      const saved = sessionStorage.getItem(KEY);
      if (CHOICES.includes(saved)) return saved;
    } catch (error) {}
    return '${DEFAULT_THEME}';
  };
  const apply = (choice) => {
    root.dataset.theme = choice === 'system' ? (dark.matches ? 'midnight' : 'light') : choice;
    root.dataset.themeChoice = choice;
    const toggle = document.querySelector('.theme-toggle');
    if (!toggle) return;
    const label = 'Theme: ' + choice + (choice === 'system' ? ' (follows this device)' : '') +
      ' — change theme';
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
    for (const item of document.querySelectorAll('.theme-item[data-choice]')) {
      item.setAttribute('aria-checked', String(item.dataset.choice === choice));
    }
  };
  const choose = (choice) => {
    apply(choice);
    try { sessionStorage.setItem(KEY, choice); } catch (error) {}
  };
  const menu = () => document.getElementById('theme-menu');
  const toggle = () => document.querySelector('.theme-toggle');
  const close = (refocus) => {
    const list = menu();
    if (!list || list.hidden) return;
    list.hidden = true;
    const button = toggle();
    if (button) {
      button.setAttribute('aria-expanded', 'false');
      if (refocus) button.focus();
    }
  };
  const open = () => {
    const list = menu();
    if (!list) return;
    list.hidden = false;
    const button = toggle();
    if (button) button.setAttribute('aria-expanded', 'true');
    const items = [...list.querySelectorAll('.theme-item')];
    const checked = items.find((item) => item.getAttribute('aria-checked') === 'true') || items[0];
    if (checked) checked.focus();
  };
  apply(read());
  addEventListener('DOMContentLoaded', () => apply(read()));
  dark.addEventListener('change', () => { if (read() === 'system') apply('system'); });
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('.theme-toggle')) {
      const list = menu();
      if (list && list.hidden) open(); else close(false);
      return;
    }
    const item = target.closest('.theme-item[data-choice]');
    if (item) { choose(item.dataset.choice); close(true); return; }
    if (!target.closest('.theme')) close(false);
  });
  document.addEventListener('keydown', (event) => {
    const list = menu();
    if (!list || list.hidden) {
      if (event.key === 'ArrowDown' && document.activeElement === toggle()) {
        event.preventDefault();
        open();
      }
      return;
    }
    const items = [...list.querySelectorAll('.theme-item')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step && index >= 0) {
      event.preventDefault();
      items[(index + step + items.length) % items.length].focus();
    }
    // Left and right move between the columns, not through the list: a group the
    // reader can see deserves a key. Spatial and unexciting on purpose -- left goes
    // left, right goes right, and the edges stay put rather than wrapping, so a key
    // never sends the eye to the far side of the menu. System is in neither column,
    // so it ignores both.
    const across = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (across && index >= 0) {
      const column = document.activeElement && document.activeElement.closest('.theme-col');
      if (column) {
        const columns = [...list.querySelectorAll('.theme-col')];
        const target = columns[columns.indexOf(column) + across];
        if (target) {
          event.preventDefault();
          const inColumn = [...column.querySelectorAll('.theme-item')];
          const inTarget = [...target.querySelectorAll('.theme-item')];
          const row = inColumn.indexOf(document.activeElement);
          inTarget[Math.min(row, inTarget.length - 1)].focus();
        }
      }
    }
    if (event.key === 'Tab') close(false);
  });
})();
</script>`;


/** The three family glyphs; GLYPH_RULES shows the one that matches the choice. */
const THEME_GLYPHS = `<svg class="i-sun" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
        <circle cx="8" cy="8" r="2.9"/>
        <path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.15 1.15M11.65 11.65l1.15 1.15M12.8 3.2l-1.15 1.15M4.35 11.65L3.2 12.8"/>
      </svg><svg class="i-moon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M13.4 9.6A5.9 5.9 0 0 1 6.4 2.6a5.9 5.9 0 1 0 7 7z"/>
      </svg><svg class="i-auto" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <circle cx="8" cy="8" r="5.4"/>
        <path d="M8 2.6a5.4 5.4 0 0 1 0 10.8z" fill="currentColor" stroke="none"/>
      </svg>`;
