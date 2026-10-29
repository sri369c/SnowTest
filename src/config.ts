// Copyright (c) 2026 Srinivas Chaturvedula

/** Server configuration, resolved from flags and environment. */

import { readFileSync } from 'node:fs';

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
}

/** Baseline values; `--help` and the `/usage` page render these as the defaults. */
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
};

function readNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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
    port: readNumber(env.SNOWTEST_PORT, DEFAULTS.port),
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
    verbose: env.SNOWTEST_VERBOSE === '1' || env.SNOWTEST_VERBOSE === 'true',
    ...overrides,
  };

  const users = readList(env.SNOWTEST_USERS);
  if (users) config.users = users;
  if (overrides.jwtPublicKey !== undefined) config.jwtPublicKey = overrides.jwtPublicKey;
  if (overrides.databases) config.databases = overrides.databases;

  // The default database must exist, or every unqualified query fails.
  if (!config.databases.some((db) => db.name.toUpperCase() === config.defaultDatabase.toUpperCase())) {
    config.databases.push({ name: config.defaultDatabase, schemas: [config.defaultSchema] });
  }
  return config;
}
