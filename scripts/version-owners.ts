// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * Every place the project's version lives, in one list.
 *
 * A tag, a lockfile and a compose fallback cannot read each other, so the number
 * is written in more than one file. Keeping the list here means
 * `npm run bump-version` writes all of them from parsed values, and
 * `tests/versions.test.ts` fails when one drifts — instead of a find/replace that
 * matches two lines and quietly changes one of them.
 *
 * Two shapes only: a JSON pointer, or the single regex whose first group holds
 * the version. Both are read back exactly the way they were written, because the
 * writer and the checker are the same code.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, resolved from this file rather than the working directory. */
export const ROOT = fileURLToPath(new URL('..', import.meta.url));

interface OwnerBase {
  /** Path relative to the repository root. */
  file: string;
  /** What this place is for, printed by the bump report. */
  what: string;
}

export type VersionOwner =
  | (OwnerBase & { pointer: string[] })
  | (OwnerBase & { pattern: RegExp });

/** The manifest: the version of record, and the tag `setup.py` builds. */
export const MANIFEST: VersionOwner = {
  file: 'package.json',
  pointer: ['version'],
  what: 'the manifest, and the image tag setup.py builds',
};

export const VERSION_OWNERS: VersionOwner[] = [
  MANIFEST,
  { file: 'package-lock.json', pointer: ['version'], what: 'the lockfile root' },
  { file: 'package-lock.json', pointer: ['packages', '', 'version'], what: 'the lockfile entry for this package' },
  {
    file: 'compose.yaml',
    pattern: /snowtest:\$\{SNOWTEST_VERSION:-([^}]+)\}/,
    what: 'the image-tag fallback',
  },
];

function valueAt(document: unknown, pointer: string[]): unknown {
  let current: unknown = document;
  for (const key of pointer) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setAt(document: unknown, pointer: string[], value: string): void {
  const parent = pointer
    .slice(0, -1)
    .reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, document as Record<string, unknown>);
  parent[pointer[pointer.length - 1] as string] = value;
}

/** Every match of a one-group pattern, so a second occurrence cannot be missed. */
function occurrences(pattern: RegExp, text: string): RegExpExecArray[] {
  const scan = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
  const found: RegExpExecArray[] = [];
  let match = scan.exec(text);
  while (match !== null) {
    found.push(match);
    match = scan.exec(text);
  }
  return found;
}

/** The version this place currently says. Throws rather than returning a guess. */
export function readOwner(owner: VersionOwner): string {
  const text = readFileSync(join(ROOT, owner.file), 'utf8');

  if ('pointer' in owner) {
    const value = valueAt(JSON.parse(text), owner.pointer);
    if (typeof value !== 'string') {
      throw new Error(`${owner.file} has no string at ${owner.pointer.join('.')}`);
    }
    return value;
  }

  const found = occurrences(owner.pattern, text);
  if (found.length !== 1) {
    throw new Error(`${owner.file} (${owner.what}) matched ${found.length} times; expected exactly one`);
  }
  const value = found[0][1];
  if (value === undefined) throw new Error(`${owner.file}: the pattern for ${owner.what} captured nothing`);
  return value;
}

/**
 * Write `version` into one place.
 *
 * JSON is parsed, edited and re-serialised; the file is only touched if
 * re-serialising it *unchanged* reproduces it byte for byte, so a lockfile npm
 * formatted differently is refused instead of being reformatted wholesale.
 */
export function writeOwner(owner: VersionOwner, version: string): void {
  const path = join(ROOT, owner.file);
  const text = readFileSync(path, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const keepEol = (value: string): string => (eol === '\n' ? value : value.replace(/\n/g, eol));

  if ('pointer' in owner) {
    const document = JSON.parse(text) as unknown;
    const current = valueAt(document, owner.pointer);
    if (typeof current !== 'string') {
      throw new Error(`${owner.file} has no string at ${owner.pointer.join('.')}`);
    }
    if (keepEol(`${JSON.stringify(document, null, 2)}\n`) !== text) {
      throw new Error(`${owner.file} is not two-space JSON with a trailing newline; refusing to reformat it`);
    }
    if (current === version) return;

    setAt(document, owner.pointer, version);
    writeFileSync(path, keepEol(`${JSON.stringify(document, null, 2)}\n`), 'utf8');
    return;
  }

  const found = occurrences(owner.pattern, text);
  if (found.length !== 1) {
    throw new Error(`${owner.file} (${owner.what}) matched ${found.length} times; expected exactly one`);
  }
  const match = found[0];
  const captured = match[1];
  if (captured === undefined) throw new Error(`${owner.file}: the pattern for ${owner.what} captured nothing`);
  if (captured === version) return;

  const rewritten = match[0].replace(captured, version);
  writeFileSync(
    path,
    text.slice(0, match.index) + rewritten + text.slice(match.index + match[0].length),
    'utf8',
  );
}
