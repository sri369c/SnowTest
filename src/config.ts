// Copyright (c) 2026 Srinivas Chaturvedula

/** Server configuration, resolved from flags and environment. */

import { readFileSync } from 'node:fs';

import { normalizeName } from './engine/catalog.js';

/** `SNOWTEST_CLOCK`: a frozen instant, or an offset that keeps moving. */
export type Clock = { kind: 'fixed'; at: Date } | { kind: 'offset'; ms: number };

export interface SnowtestConfig {
  port: number;
  host: string;
  account: string;
  /** Default database/schema/warehouse handed to a client that does not ask for one. */
  defaultDatabase: string;
  defaultSchema: string;
  defaultWarehouse: string;
  defaultRole: string;
  /** Fixed account/user list; empty means "accept any credentials". */
  users: string[];
  /**
   * PEM public key (or path to one), optionally RSA. When set, key-pair logins
   * must carry a JWT signed by the matching private key; when null, any
   * credential is accepted and tokens are not verified.
   */
  jwtPublicKey: string | null;
  /** Extra databases created at boot. */
  databases: Array<{ name: string; schemas: string[] }>;
  warehouses: string[];
  roles: string[];
  /** Verbose per-request logging (never logs passwords). */
  verbose: boolean;
  /** Directory for file-backed databases; null keeps everything in memory. */
  dataDir: string | null;
  /** Emulated clock; null uses the host clock. */
  clock: Clock | null;
}

/** Baseline values; `--help` and the `/configuration` page render these as the defaults. */
export const DEFAULTS: SnowtestConfig = {
  port: 8080,
  host: '0.0.0.0',
  account: 'SNOWTEST',
  defaultDatabase: 'SNOWTEST',
  defaultSchema: 'PUBLIC',
  defaultWarehouse: 'SNOWTEST_WH',
  defaultRole: 'SYSADMIN',
  users: [],
  jwtPublicKey: null,
  databases: [{ name: 'SNOWTEST', schemas: ['PUBLIC'] }],
  warehouses: ['SNOWTEST_WH'],
  roles: ['ACCOUNTADMIN', 'SYSADMIN', 'PUBLIC'],
  verbose: false,
  dataDir: null,
  clock: null,
};

/** A TCP port, 1–65535, or 0 to let the OS pick a free one. Anything else is a startup error. */
export function parsePort(value: string, source: string): number {
  const port = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${source} must be a port number between 1 and 65535, or 0 for a free port, got '${value}'.`);
  }
  return port;
}

/**
 * `SNOWTEST_CLOCK` freezes or shifts the emulated clock, so a test that depends on
 * `CURRENT_TIMESTAMP` stops depending on the day it runs.
 *
 * An ISO instant (`2026-01-31T09:00:00Z`, or `2026-01-31 09:00:00` in local time)
 * is frozen; `+30m`, `-2h`, `+45s`, `+1d` shift the host clock, which keeps moving.
 */
export function parseClock(value: string | undefined): Clock | null {
  if (!value || value.trim().length === 0) return null;
  const text = value.trim();
  const offset = /^([+-])(\d+)([smhd])$/i.exec(text);
  if (offset) {
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      offset[3].toLowerCase() as 's' | 'm' | 'h' | 'd'
    ];
    const ms = Number(offset[2]) * unit;
    return { kind: 'offset', ms: offset[1] === '-' ? -ms : ms };
  }
  const parsed = Date.parse(text.includes('T') ? text : text.replace(' ', 'T'));
  if (!Number.isNaN(parsed)) return { kind: 'fixed', at: new Date(parsed) };
  throw new Error(
    `SNOWTEST_CLOCK must be an ISO instant or an offset like '+30m', got '${value}'.`,
  );
}

function readBoolean(value: string | undefined, name: string): boolean {
  // Env values arrive in whatever case the shell uses; TRUE is as valid as true.
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '' || normalized === '0' || normalized === 'false') return false;
  if (normalized === '1' || normalized === 'true') return true;
  throw new Error(`${name} must be 1, true, 0 or false, got '${value}'.`);
}

/**
 * Accept either inline PEM or a path. A path that cannot be read is a startup
 * error on purpose: silently disabling verification would make an auth test
 * pass for the wrong reason.
 */
function readPublicKey(value: string | undefined): string | null {
  if (!value || value.trim().length === 0) return null;
  if (value.includes('-----BEGIN')) return value;
  try {
    return readFileSync(value, 'utf8');
  } catch (error) {
    throw new Error(
      `SNOWTEST_JWT_PUBLIC_KEY points at '${value}' but it could not be read: ${String(error)}`,
    );
  }
}

function readList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

export function loadConfig(overrides: Partial<SnowtestConfig> = {}): SnowtestConfig {
  const env = process.env;
  const config: SnowtestConfig = {
    ...DEFAULTS,
    port: env.SNOWTEST_PORT ? parsePort(env.SNOWTEST_PORT, 'SNOWTEST_PORT') : DEFAULTS.port,
    host: env.SNOWTEST_HOST ?? DEFAULTS.host,
    account: env.SNOWTEST_ACCOUNT ?? DEFAULTS.account,
    defaultDatabase: env.SNOWTEST_DATABASE ?? DEFAULTS.defaultDatabase,
    defaultSchema: env.SNOWTEST_SCHEMA ?? DEFAULTS.defaultSchema,
    defaultWarehouse: env.SNOWTEST_WAREHOUSE ?? DEFAULTS.defaultWarehouse,
    defaultRole: env.SNOWTEST_ROLE ?? DEFAULTS.defaultRole,
    databases: (readList(env.SNOWTEST_DATABASES) ?? [DEFAULTS.defaultDatabase]).map((name) => ({
      name,
      schemas: ['PUBLIC'],
    })),
    warehouses: readList(env.SNOWTEST_WAREHOUSES) ?? DEFAULTS.warehouses,
    roles: readList(env.SNOWTEST_ROLES) ?? DEFAULTS.roles,
    jwtPublicKey: readPublicKey(env.SNOWTEST_JWT_PUBLIC_KEY),
    verbose: readBoolean(env.SNOWTEST_VERBOSE, 'SNOWTEST_VERBOSE'),
    dataDir: env.SNOWTEST_DATA_DIR || DEFAULTS.dataDir,
    clock: parseClock(env.SNOWTEST_CLOCK),
    ...overrides,
  };

  const users = readList(env.SNOWTEST_USERS);
  if (users) config.users = users;
  if (overrides.jwtPublicKey !== undefined) config.jwtPublicKey = overrides.jwtPublicKey;
  if (overrides.databases) config.databases = overrides.databases;

  // Identifiers become canonical keys here, once; nothing downstream re-folds them.
  config.defaultDatabase = normalizeName(config.defaultDatabase);
  config.defaultSchema = normalizeName(config.defaultSchema);
  config.defaultWarehouse = normalizeName(config.defaultWarehouse);
  config.defaultRole = normalizeName(config.defaultRole);
  config.databases = config.databases.map((db) => ({
    name: normalizeName(db.name),
    schemas: db.schemas.map(normalizeName),
  }));
  config.warehouses = config.warehouses.map(normalizeName);
  config.roles = config.roles.map(normalizeName);

  // The default database must exist, or every unqualified query fails.
  if (!config.databases.some((db) => db.name === config.defaultDatabase)) {
    config.databases.push({ name: config.defaultDatabase, schemas: [config.defaultSchema] });
  }
  return config;
}
