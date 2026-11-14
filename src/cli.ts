#!/usr/bin/env node
// Copyright (c) 2026 Srinivas Chaturvedula

/** Command-line entry point: `snowtest [--port 8080]`. */

import { createServer } from './server.js';
import { loadConfig, parsePort, type SnowtestConfig } from './config.js';
import { OPTIONS, helpText } from './options.js';
import { SERVER_VERSION } from './protocol.js';
import { PACKAGE_VERSION } from './version.js';

function fail(message: string): never {
  console.error(`snowtest: ${message}\nRun 'snowtest --help' for the list of flags.`);
  process.exit(2);
}

/** Parse against the option table: unknown flags, stray arguments and missing values are errors. */
function parseFlags(argv: string[]): Record<string, string> {
  const known = new Map(OPTIONS.map((option) => [option.flag.slice(2), option]));
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) fail(`unexpected argument '${arg}'`);
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
    const option = known.get(key);
    if (!option) fail(`unknown flag '--${key}'`);

    if (!option.argument) {
      if (inlineValue !== undefined && inlineValue !== 'true' && inlineValue !== 'false') {
        fail(`--${key} takes no value or =true/=false, got '${inlineValue}'`);
      }
      flags[key] = inlineValue ?? 'true';
      continue;
    }
    const value = inlineValue ?? argv[i + 1];
    if (value === undefined || (inlineValue === undefined && value.startsWith('--'))) {
      fail(`--${key} needs a value`);
    }
    if (inlineValue === undefined) i += 1;
    flags[key] = value;
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));

if (flags.version === 'true') {
  console.log(`snowtest ${PACKAGE_VERSION} (emulating Snowflake ${SERVER_VERSION})`);
  process.exit(0);
}

if (flags.help === 'true') {
  console.log(helpText());
  process.exit(0);
}

/** Map the flags onto config fields through the shared option table. */
function configOverrides(parsed: Record<string, string>): Partial<SnowtestConfig> {
  const overrides: Record<string, unknown> = {};
  for (const option of OPTIONS) {
    if (!option.configKey) continue;
    const raw = parsed[option.flag.replace(/^--/, '')];
    if (raw === undefined) continue;
    if (option.type === 'boolean') overrides[option.configKey] = raw === 'true';
    else if (option.type === 'number') overrides[option.configKey] = parsePort(raw, option.flag);
    else overrides[option.configKey] = raw;
  }
  return overrides as Partial<SnowtestConfig>;
}

let config: SnowtestConfig;
try {
  config = loadConfig(configOverrides(flags));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const server = await createServer(config);
const running = await server.listen();
console.log(`snowtest ${PACKAGE_VERSION} listening on http://${running.host}:${running.port}`);
console.log(`  emulating Snowflake ${SERVER_VERSION}`);
console.log(`  account=${config.account} default=${config.defaultDatabase}.${config.defaultSchema}`);

let shuttingDown = false;

/** Exit non-zero when either half of the shutdown failed, so supervisors notice. */
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nshutting down (${signal})…`);
  let failed = false;
  const steps: Array<[string, () => Promise<void>]> = [
    ['listener', () => running.close()],
    ['engine', () => server.close()],
  ];
  for (const [what, close] of steps) {
    try {
      await close();
    } catch (error) {
      failed = true;
      console.error(`could not close the ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  process.exit(failed ? 1 : 0);
};

// Consume the promise: dropping it with `void` would leave a rejection unhandled
// and the process half-closed.
const onSignal = (signal: string): void => {
  shutdown(signal).catch((error: unknown) => {
    console.error(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
};

process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));
