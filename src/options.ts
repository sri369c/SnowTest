// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * The option table, shared by `snowtest --help` and the `/usage` page.
 *
 * Flags and environment variables were declared twice before — once in the
 * help text, once in whatever documentation was current — and the two drifted.
 * They are data now: the CLI renders its help from this table, the page renders
 * its configuration section from it, and a test checks that neither can list a
 * flag the other does not.
 */

import { DEFAULTS, type SnowtestConfig } from './config.js';

export interface OptionSpec {
  /** Long flag, with the `--`. */
  flag: string;
  /** Placeholder shown after the flag, e.g. `<n>`. */
  argument?: string;
  /** Environment variable the flag overrides, when it has one. */
  env?: string;
  /** Default as a reader should see it; omitted for the flags that just print. */
  default?: string;
  description: string;
  /** Where the value lands in the server config, for flags that change it. */
  configKey?: keyof SnowtestConfig;
  type?: 'string' | 'number' | 'boolean';
}

export const OPTIONS: OptionSpec[] = [
  {
    flag: '--port',
    argument: '<n>',
    env: 'SNOWTEST_PORT',
    default: String(DEFAULTS.port),
    description: 'Port to listen on',
    configKey: 'port',
    type: 'number',
  },
  {
    flag: '--host',
    argument: '<addr>',
    env: 'SNOWTEST_HOST',
    default: DEFAULTS.host,
    description: 'Bind address',
    configKey: 'host',
    type: 'string',
  },
  {
    flag: '--account',
    argument: '<name>',
    env: 'SNOWTEST_ACCOUNT',
    default: DEFAULTS.account,
    description: 'Account name reported to clients',
    configKey: 'account',
    type: 'string',
  },
  {
    flag: '--database',
    argument: '<name>',
    env: 'SNOWTEST_DATABASE',
    default: DEFAULTS.defaultDatabase,
    description: 'Default database',
    configKey: 'defaultDatabase',
    type: 'string',
  },
  {
    flag: '--schema',
    argument: '<name>',
    env: 'SNOWTEST_SCHEMA',
    default: DEFAULTS.defaultSchema,
    description: 'Default schema',
    configKey: 'defaultSchema',
    type: 'string',
  },
  {
    flag: '--warehouse',
    argument: '<name>',
    env: 'SNOWTEST_WAREHOUSE',
    default: DEFAULTS.defaultWarehouse,
    description: 'Default warehouse',
    configKey: 'defaultWarehouse',
    type: 'string',
  },
  {
    flag: '--verbose',
    env: 'SNOWTEST_VERBOSE',
    default: 'off',
    description: 'Log every request; passwords are never logged',
    configKey: 'verbose',
    type: 'boolean',
  },
  {
    flag: '--version',
    description: 'Print the snowtest version and the emulated Snowflake version',
  },
  { flag: '--help', description: 'Show this message' },
];

export interface EnvOnlySpec {
  name: string;
  default: string;
  description: string;
}

/** Variables with no flag: read once at boot. */
export const ENV_ONLY: EnvOnlySpec[] = [
  {
    name: 'SNOWTEST_DATABASES',
    default: DEFAULTS.defaultDatabase,
    description: 'Comma-separated databases created at boot.',
  },
  {
    name: 'SNOWTEST_WAREHOUSES',
    default: DEFAULTS.warehouses.join(','),
    description: 'Comma-separated warehouses.',
  },
  {
    name: 'SNOWTEST_ROLES',
    default: DEFAULTS.roles.join(','),
    description: 'Comma-separated roles.',
  },
  {
    name: 'SNOWTEST_ROLE',
    default: DEFAULTS.defaultRole,
    description: 'Default role handed to a new session.',
  },
  {
    name: 'SNOWTEST_USERS',
    default: 'unset — any name is accepted',
    description: 'Comma-separated login allow-list; other names are refused at login.',
  },
  {
    name: 'SNOWTEST_JWT_PUBLIC_KEY',
    default: 'unset — tokens are not verified',
    description: 'Path to a PEM public key, or inline PEM. When set, key-pair logins are signature-checked.',
  },
  {
    name: 'SNOWTEST_STAGE_ROOT',
    default: 'a temp directory per process',
    description: 'Directory that backs internal stages.',
  },
];

const HELP_WIDTH = 22;

/** One description line per flag, in the shape `--help` prints. */
export function helpText(): string {
  const lines = OPTIONS.map((option) => {
    const usage = [option.flag, option.argument].filter(Boolean).join(' ');
    const notes = [
      option.default ? `default ${option.default}` : null,
      option.env ? `env ${option.env}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    const text = notes ? `${option.description} (${notes})` : option.description;
    return `  ${usage.padEnd(HELP_WIDTH)}${text}`;
  });

  return `snowtest — a Snowflake-compatible stub server

Usage: snowtest [options]

Options:
${lines.join('\n')}

Connect with the Python connector:

  snowflake.connector.connect(
      account="${DEFAULTS.account}", user="test", password="test",
      host="localhost", port=${DEFAULTS.port}, protocol="http",
      database="${DEFAULTS.defaultDatabase}", schema="${DEFAULTS.defaultSchema}",
      warehouse="${DEFAULTS.defaultWarehouse}",
  )
`;
}
