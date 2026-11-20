// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * Write the project version everywhere it lives, from the list in
 * `version-owners.ts`.
 *
 *   npm run bump-version                 report what each place says
 *   npm run bump-version 5.3.0           write 5.3.0 into every place
 *   npm run bump-version 5.3.0 --dry-run print the plan, write nothing
 *
 * It also creates `release_notes/<version>.md` if it is missing, because the
 * guard test will not let the manifest claim a version that has no note.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MANIFEST, ROOT, VERSION_OWNERS, readOwner, writeOwner } from './version-owners.js';

const SEMVER = /^\d+\.\d+\.\d+$/;

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg.startsWith('--') && arg !== '--dry-run');
if (unknown.length > 0) {
  console.error(`unknown option '${unknown[0]}'; the only flag is --dry-run`);
  process.exit(2);
}

const dryRun = args.includes('--dry-run');
const requested = args.find((arg) => !arg.startsWith('--'));

if (requested !== undefined && !SEMVER.test(requested)) {
  console.error(`'${requested}' is not a version; expected MAJOR.MINOR.PATCH`);
  process.exit(2);
}

const current = VERSION_OWNERS.map((owner) => ({ owner, version: readOwner(owner) }));
const agreed = new Set(current.map((place) => place.version));
const target = requested ?? readOwner(MANIFEST);

const width = Math.max(...current.map((place) => place.owner.file.length));
console.log(`version: ${target}${dryRun ? '   (dry run)' : ''}`);
for (const place of current) {
  console.log(`  ${place.owner.file.padEnd(width)}  ${place.version}  ${place.owner.what}`);
}

if (agreed.size > 1) {
  console.log(`\nthey disagree: ${[...agreed].join(', ')}`);
} else {
  console.log(`\nall ${current.length} places say ${[...agreed][0]}`);
}

if (requested === undefined) {
  // Report only. A disagreement is what the guard test exists to catch.
  process.exit(agreed.size === 1 ? 0 : 1);
}

if (dryRun) {
  const changes = current.filter((place) => place.version !== target);
  if (changes.length === 0) {
    console.log('nothing to change');
  } else {
    for (const place of changes) {
      console.log(`  would set ${place.owner.file} (${place.owner.what}): ${place.version} -> ${target}`);
    }
  }
  const note = join(ROOT, 'release_notes', `${target}.md`);
  console.log(existsSync(note) ? `  release note ${target} exists` : `  would create release_notes/${target}.md`);
  process.exit(0);
}

for (const place of current) writeOwner(place.owner, target);

const note = join(ROOT, 'release_notes', `${target}.md`);
if (existsSync(note)) {
  console.log(`release note release_notes/${target}.md exists`);
} else {
  writeFileSync(
    note,
    `# snowtest ${target} — Release Notes\n\n**Release date:** unreleased.\n\n## What changed\n\n## Upgrading\n\nNothing to do.\n`,
    'utf8',
  );
  console.log(`created release_notes/${target}.md`);
}

// Read everything back: the writer and the checker are the same code, so this is
// the check the test will make, made now.
const after = VERSION_OWNERS.map((owner) => ({ owner, version: readOwner(owner) }));
const wrong = after.filter((place) => place.version !== target);
if (wrong.length > 0) {
  for (const place of wrong) console.error(`  still ${place.version}: ${place.owner.file} (${place.owner.what})`);
  process.exit(1);
}
console.log(`wrote ${target} into all ${after.length} places`);
