// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * The version pins and the release record, checked against the files that own
 * them.
 *
 * `versions.json` says which connector and dbt versions the suites run against.
 * The two runners read it directly. `compose.yaml` and `ci.yml` are checked here
 * instead, and `docs/design.md` describes the pins in prose, so it is checked
 * too: a version written in four places is a version that disagrees with itself
 * eventually, which is exactly what happened when the connector pin said 5.1 in
 * the document and ran 4.8 in the suite.
 *
 * The release notes are the record of which releases exist. `since:` values in
 * the operations table and the package version are both checked against that
 * directory, so a release cannot be claimed without a note.
 */

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { GROUPS } from '../src/pages/operations.js';
import { ROOT, VERSION_OWNERS, readOwner } from '../scripts/version-owners.js';

const SEMVER = /^\d+\.\d+\.\d+$/;

const path = (relative: string): string => fileURLToPath(new URL(`../${relative}`, import.meta.url));
const read = (relative: string): string => readFileSync(path(relative), 'utf8');

const versions = JSON.parse(read('versions.json')) as {
  connector: string;
  dbt: { core: string; snowflake: string };
};

const manifest = JSON.parse(read('package.json')) as { version: string; engines?: { node?: string } };

function releaseNotes(): string[] {
  return readdirSync(path('release_notes'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
    .filter((name) => SEMVER.test(name));
}

function compare(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

describe('versions.json', () => {
  it('pins a released connector and a released dbt pair', () => {
    expect(versions.connector, 'connector').toMatch(SEMVER);
    expect(versions.dbt.core, 'dbt.core').toMatch(SEMVER);
    expect(versions.dbt.snowflake, 'dbt.snowflake').toMatch(SEMVER);
  });

  it('pins a GA connector, not a pre-release', () => {
    expect(versions.connector).not.toContain('-');
  });
});

describe('the suites read the pins', () => {
  it('takes the connector from versions.json rather than hardcoding it', () => {
    const compat = read('tests/compat/run.sh');
    expect(compat).toContain('versions.json');
    expect(compat).toContain('SNOWTEST_CONNECTOR');
    expect(compat, 'a literal requirement outranks the pin').not.toMatch(/snowflake-connector-python==\d/);
  });

  it('takes the dbt pair from versions.json rather than hardcoding it', () => {
    const dbt = read('tests/dbt/run.sh');
    expect(dbt).toContain('versions.json');
    expect(dbt, 'DBT_CORE is assigned a literal').not.toMatch(/DBT_CORE=\d/);
    expect(dbt, 'DBT_ADAPTER is assigned a literal').not.toMatch(/DBT_ADAPTER=\d/);
    expect(dbt, 'the connector default is a literal').not.toMatch(/:-\d+\.\d+/);
  });
});

describe('CI reads the pins', () => {
  it('resolves them from versions.json instead of a matrix literal', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('versions.json');
    expect(ci).toContain('needs.versions.outputs.connector');
    expect(ci, 'a connector version is hardcoded in the matrix').not.toMatch(/connector:\s*'\d/);
  });
});

describe('every place the version lives agrees', () => {
  // The list is the point: add a place there, not a find/replace here.
  it('is a list, not one file with a comment in it', () => {
    expect(VERSION_OWNERS.length).toBeGreaterThan(1);
    expect(new Set(VERSION_OWNERS.map((owner) => owner.file)).size).toBeGreaterThan(1);
  });

  for (const owner of VERSION_OWNERS) {
    it(`holds the package version in ${owner.file} (${owner.what})`, () => {
      expect(readOwner(owner)).toBe(manifest.version);
    });
  }

  // A place that owns the version has to be in the list; any other file that
  // spells it out is either a stale copy or a place that needs an entry.
  const allowed = new Set([
    ...VERSION_OWNERS.map((owner) => owner.file),
    `release_notes/${manifest.version}.md`,
    // `since:` names the release a feature shipped in, which is not an owner.
    'src/pages/operations.ts',
  ]);

  const git = (() => {
    try {
      execSync('git rev-parse --verify HEAD', { cwd: ROOT, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!git)('spells it nowhere else in tracked files', () => {
    let tracked: string[] = [];
    try {
      tracked = execSync(`git grep -lF -- ${manifest.version}`, { cwd: ROOT, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .map((file) => file.trim().replace(/\\/g, '/'));
    } catch {
      tracked = [];
    }

    expect(
      tracked.filter((file) => !allowed.has(file)),
      `these files spell out ${manifest.version} but are not in scripts/version-owners.ts`,
    ).toEqual([]);
  });
});

describe('docs/design.md agrees', () => {
  const design = read('docs/design.md');

  it('names the pinned connector in its status line', () => {
    const status = design.split(/\r?\n/).slice(0, 12).join(' ');
    expect(status).toContain(versions.connector);
  });

  it('points at the file rather than only restating it', () => {
    expect(design).toContain('versions.json');
  });

  it('carries no claim of a different connector pin', () => {
    for (const stale of ['connector 5.1', '5.1 is pinned', '3.16 and 4.8']) {
      expect(design, `design.md still says "${stale}"`).not.toContain(stale);
    }
  });

  it('names the pinned dbt pair', () => {
    expect(design).toContain(versions.dbt.core);
    expect(design).toContain(versions.dbt.snowflake);
  });
});

describe('release notes are the record of releases', () => {
  const notes = releaseNotes();

  it('has a note per release', () => {
    expect(notes.length).toBeGreaterThan(0);
  });

  it('dates every operations row to a release that has a note', () => {
    for (const group of GROUPS) {
      for (const row of group.rows) {
        expect(row.since, `${group.id}: ${row.syntax}`).toMatch(SEMVER);
        expect(
          notes.includes(row.since),
          `${group.id}: ${row.syntax} says ${row.since}, and there is no release_notes/${row.since}.md`,
        ).toBe(true);
      }
    }
  });

  it('has a note for the version being published', () => {
    expect(manifest.version).toMatch(SEMVER);
    expect(
      notes.includes(manifest.version),
      `package.json is ${manifest.version} and there is no release_notes/${manifest.version}.md`,
    ).toBe(true);
  });

  it('carries no note for a version newer than the package', () => {
    const newest = [...notes].sort(compare).at(-1);
    expect(newest).toBe(manifest.version);
  });
});

describe('node is one version everywhere', () => {
  // The toolchain in dev-tools runs node 24, so the image and CI do too: one
  // runtime, not three numbers with three owners that nobody compares.
  const MAJOR = '24';

  it('builds every image stage on it', () => {
    const stages = read('Dockerfile').match(/^FROM .*/gm) ?? [];
    expect(stages.length, 'the Dockerfile has no FROM line').toBeGreaterThan(0);
    const pinned = new RegExp(`^FROM node:${MAJOR}\\b`);
    for (const stage of stages) expect(stage).toMatch(pinned);
  });

  it('runs every CI job on it', () => {
    const lines = read('.github/workflows/ci.yml')
      .split(/\r?\n/)
      .filter((line) => line.includes('node-version:'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toContain(`node-version: ${MAJOR}`);
  });

  it('declares it as the floor for a consumer', () => {
    expect(manifest.engines?.node).toBe(`>=${MAJOR}`);
  });
});
