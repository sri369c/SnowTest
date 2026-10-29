#!/usr/bin/env node
// Copyright (c) 2026 Srinivas Chaturvedula

/** Command-line entry point: `snowtest [--port 8080]`. */

import { createServer } from './server.js';
import { loadConfig } from './config.js';
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
  console.log(`snowtest — a Snowflake-compatible stub server

Usage: snowtest [options]

Options:
  --port <n>          Port to listen on (default 8080, env SNOWTEST_PORT)
  --host <addr>       Bind address (default 0.0.0.0, env SNOWTEST_HOST)
  --account <name>    Account name reported to clients (default SNOWTEST)
  --database <name>   Default database (default SNOWTEST)
  --schema <name>     Default schema (default PUBLIC)
  --warehouse <name>  Default warehouse (default SNOWTEST_WH)
  --verbose           Log every request
  --version           Print the snowtest and emulated Snowflake versions
  --help              Show this message

Connect with the Python connector:

  snowflake.connector.connect(
      account="SNOWTEST", user="test", password="test",
      host="localhost", port=8080, protocol="http",
      database="SNOWTEST", schema="PUBLIC", warehouse="SNOWTEST_WH",
  )
`);
  process.exit(0);
}

const config = loadConfig({
  ...(flags.port ? { port: Number.parseInt(flags.port, 10) } : {}),
  ...(flags.host ? { host: flags.host } : {}),
  ...(flags.account ? { account: flags.account } : {}),
  ...(flags.database ? { defaultDatabase: flags.database } : {}),
  ...(flags.schema ? { defaultSchema: flags.schema } : {}),
  ...(flags.warehouse ? { defaultWarehouse: flags.warehouse } : {}),
  ...(flags.verbose === 'true' ? { verbose: true } : {}),
});

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
