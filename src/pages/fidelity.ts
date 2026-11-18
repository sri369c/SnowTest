// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * The Settings page at `/settings`, and the pieces it renders.
 *
 * It is a top-level page rather than a tab under Configuration: a control that
 * changes how the server behaves is not a footnote to a reference table, and the
 * nav is where a person looks for it. The dropdown sits above everything else for
 * the same reason — the thing you came to change should not need scrolling.
 *
 * The page renders from `FidelityState`, which the server keeps; the script posts
 * the chosen value and repeats the impact sentence the server sends back, so what
 * the page promises and what the server did are the same sentence.
 */

import { FIDELITY_IMPACT, FIDELITY_MODES, type FidelityState } from '../config/fidelity.js';
import { escapeHtml, renderPage } from './page.js';

/** What the page renders when it is asked for without a live state (tests, docs). */
export const DEFAULT_FIDELITY_STATE: FidelityState = {
  mode: 'report',
  saved: null,
  pinned: false,
  persisted: false,
};

interface ModeRow {
  mode: (typeof FIDELITY_MODES)[number];
  /** One sentence: what the mode is for. */
  what: string;
  /** What a statement gets, and what the account records. */
  result: string;
}

const MODES: ModeRow[] = [
  {
    mode: 'off',
    what: 'Does no fidelity work at all.',
    result:
      'Statements run exactly as in 4.x. <code>QUERY_HISTORY</code> still records them; nothing is written to <code>MODEL_FIDELITY</code>.',
  },
  {
    mode: 'report',
    what: 'Records what each model needed approximated, and never stops a query.',
    result:
      'Every statement runs. Each dbt model gains a verdict, <code>verified</code> or <code>approximate</code>, with the constructs named. The default.',
  },
  {
    mode: 'strict',
    what: 'Refuses a statement before it executes when the translation would approximate something.',
    result:
      'A dbt run stops on the first such model with a compile error naming the construct. Nothing is executed or recorded for the refused statement.',
  },
];

/** Why the current value is the current value. */
function sourceNote(state: FidelityState): string {
  if (state.pinned) {
    return 'Pinned at start-up by <code>--fidelity</code> or <code>SNOWTEST_FIDELITY</code>. Unset it and restart to change the mode here.';
  }
  if (state.saved !== null) {
    return state.persisted
      ? 'Saved in <code>settings.json</code> beside the databases, so it survives a restart.'
      : 'Held in memory: this server has no data directory, so a restart returns to the default.';
  }
  return state.persisted
    ? 'The built-in default. A value you apply is saved beside the databases and outlives a restart.'
    : 'The built-in default. This server has no data directory, so an applied value lasts only while the process runs.';
}

/** The control: dropdown, Apply, and the confirmation, at the top of the page. */
function control(state: FidelityState): string {
  const options = FIDELITY_MODES.map(
    (mode) =>
      `<option value="${mode}"${mode === state.mode ? ' selected' : ''}>${mode}${mode === 'report' ? ' (default)' : ''}</option>`,
  ).join('');
  const lock = state.pinned ? ' disabled' : '';
  const impacts = JSON.stringify(FIDELITY_IMPACT).replace(/</g, '\\u003c');

  return `<div class="settings-control">
  <div class="settings-control-row">
    <label for="fidelity-value">Fidelity mode</label>
    <select id="fidelity-value"${lock}>${options}</select>
    <button class="refresh" type="button" id="fidelity-apply"${lock}>Apply</button>
  </div>
  <p class="settings-current">
    In force now: <code id="fidelity-current">${escapeHtml(state.mode)}</code>
    <span class="muted" id="fidelity-source">${sourceNote(state)}</span>
  </p>
  <p class="muted" id="fidelity-impact">${escapeHtml(FIDELITY_IMPACT[state.mode])}</p>
  <div class="ok" id="fidelity-ok" role="status" hidden></div>
</div>

<script>
(() => {
  const select = document.getElementById('fidelity-value');
  const apply = document.getElementById('fidelity-apply');
  const impact = document.getElementById('fidelity-impact');
  const status = document.getElementById('fidelity-ok');
  const current = document.getElementById('fidelity-current');
  const source = document.getElementById('fidelity-source');
  const impacts = ${impacts};
  if (!select || !apply || !impact || !status) return;

  const describe = () => { impact.textContent = impacts[select.value] || ''; };
  select.addEventListener('change', describe);
  describe();

  apply.addEventListener('click', async () => {
    if (apply.disabled) return;
    const before = apply.textContent;
    apply.disabled = true;
    apply.classList.add('busy');
    apply.textContent = 'Applying…';
    status.hidden = true;
    status.classList.remove('err-note');
    try {
      const response = await fetch('/_snowtest/fidelity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: select.value }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'HTTP ' + response.status);
      if (current) current.textContent = body.mode;
      if (source) {
        source.textContent = body.persisted
          ? 'Saved in settings.json beside the databases, so it survives a restart.'
          : 'Held in memory: this server has no data directory, so a restart returns to the default.';
      }
      status.textContent = 'Applied: fidelity is now ' + body.mode + '. ' + body.impact;
      status.hidden = false;
    } catch (error) {
      status.textContent = 'Not applied: ' + error.message;
      status.classList.add('err-note');
      status.hidden = false;
    } finally {
      apply.disabled = false;
      apply.classList.remove('busy');
      apply.textContent = before;
    }
  });
})();
</script>`;
}

/** The reference half: what each mode does to a statement. */
function modeTable(): string {
  const rows = MODES.map(
    (row) =>
      `      <tr><td><code>${row.mode}</code></td><td>${row.what}</td><td>${row.result}</td></tr>`,
  ).join('\n');
  return `<table class="fidelitymodes">
  <thead>
    <tr><th scope="col">Mode</th><th scope="col">What it does</th><th scope="col">What you get</th></tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}

/** The page served at `/settings`. */
export function renderSettings(version: string, state: FidelityState = DEFAULT_FIDELITY_STATE): string {
  const body = `<h1>Settings</h1>
<p class="lede">
  What this server keeps for you, and what each choice does. The interceptor reads
  every setting per statement, so an applied value takes effect on the next query —
  no restart, no reseed. A reset rebuilds the catalog and leaves these alone.
</p>

${control(state)}

<h2>What each mode does</h2>
<p class="muted">
  Model fidelity decides what happens around every statement a client sends: what
  is recorded about it, and whether it is allowed to run at all.
</p>

${modeTable()}

<p class="muted">
  Model verdicts and the constructs behind them are served at
  <code>GET /_snowtest/models</code> and kept in
  <code>SNOWFLAKE.ACCOUNT_USAGE.MODEL_FIDELITY</code>.
</p>`;

  return renderPage({ title: 'snowtest — settings', body, version, nav: 'settings' });
}
