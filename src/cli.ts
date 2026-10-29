#!/usr/bin/env node
// Copyright (c) 2026 Srinivas Chaturvedula

/** Command-line entry point: `snowtest [--port 8080]`. */

import { createServer } from './server.js';
import { loadConfig, type SnowtestConfig } from './config.js';
import { OPTIONS, helpText } from './options.js';
import { SERVER_VERSION } from './protocol.js';
import { PACKAGE_VERSION } from './version.js';

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [key, inlineValue] = arg.slice(2).split('=');
    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = 'true';
    }
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

/**
 * Map the flags onto config fields through the shared option table, so a flag
 * that is offered by `--help` cannot be silently ignored on the way in.
 */
function configOverrides(parsed: Record<string, string>): Partial<SnowtestConfig> {
  const overrides: Record<string, unknown> = {};
  for (const option of OPTIONS) {
    if (!option.configKey) continue;
    const raw = parsed[option.flag.replace(/^--/, '')];
    if (raw === undefined) continue;
    if (option.type === 'boolean') {
      if (raw === 'true') overrides[option.configKey] = true;
      continue;
    }
    if (option.type === 'number') {
      const parsedNumber = Number.parseInt(raw, 10);
      if (Number.isFinite(parsedNumber)) overrides[option.configKey] = parsedNumber;
      continue;
    }
    overrides[option.configKey] = raw;
  }
  return overrides as Partial<SnowtestConfig>;
}

const config = loadConfig(configOverrides(flags));

const server = await createServer(config);
const running = await server.listen();
console.log(`snowtest ${PACKAGE_VERSION} listening on http://${running.host}:${running.port}`);
console.log(`  emulating Snowflake ${SERVER_VERSION}`);
console.log(`  account=${config.account} default=${config.defaultDatabase}.${config.defaultSchema}`);

const shutdown = async () => {
  console.log('\nshutting down…');
  await running.close();
  await server.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
