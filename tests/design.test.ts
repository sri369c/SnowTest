// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * §12 of the design document lists architectural limits. It is not a second
 * copy of `/operations`, and this test keeps it that way.
 *
 * The copy is what went wrong before: "several `;`-separated statements are not
 * split" sat in the limitations list long after `splitStatements` made it
 * false. Prose has no build step, so nothing caught it. The operations table
 * does have one: it is data, rendered into the page and read by the tests.
 *
 * So §12 is pinned to the limits that cannot be rows, and the forbidden list
 * names the gaps the table already owns. A new bullet fails this test until
 * someone decides deliberately where the fact belongs.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const design = readFileSync(fileURLToPath(new URL('../docs/design.md', import.meta.url)), 'utf8');

/** The architectural limits §12 may carry, each by a marker that stays put. */
const LIMITS = [
  'Not a security boundary',
  'In memory by default',
  'Single result partition',
  'No replication',
];

/** Gaps the operations table owns, so §12 must not restate them. */
const OWNED_ELSEWHERE = [
  'COPY INTO @stage',
  'execute_async',
  'file format',
  'UDF',
  'stored procedure',
  'Snowpipe',
  'ODBC',
  'FLATTEN',
  'warehouse',
  'GRANT',
];

function section(heading: string): string {
  const start = design.indexOf(heading);
  expect(start, `${heading} is missing from docs/design.md`).toBeGreaterThanOrEqual(0);
  const rest = design.slice(start + heading.length);
  const end = rest.search(/\r?\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('§12 known limitations', () => {
  const limits = section('## 12. Known limitations');
  const bullets = limits.split(/\r?\n/).filter((line) => line.startsWith('- '));

  it('carries exactly the architectural limits', () => {
    expect(bullets.length, `§12 has ${bullets.length} bullets, expected ${LIMITS.length}`).toBe(LIMITS.length);
    for (const marker of LIMITS) {
      expect(limits, `§12 lost "${marker}"`).toContain(marker);
    }
  });

  it('sends statement-level gaps to the reference instead of restating them', () => {
    expect(limits).toContain('/operations');
    expect(limits).toContain('Not supported');
    expect(limits).toContain('src/operations.ts');
  });

  it('names no gap the operations table already owns', () => {
    for (const owned of OWNED_ELSEWHERE) {
      expect(
        limits.toLowerCase(),
        `§12 restates "${owned}", which /operations lists`,
      ).not.toContain(owned.toLowerCase());
    }
  });
});
