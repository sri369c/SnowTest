// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * Debug helper: drive the server directly and print raw driver-protocol
 * responses (rowtype, rowset, message) for a list of statements.
 *
 * Usage: npx tsx scripts/dump-response.ts "SHOW TABLES" "DESCRIBE TABLE t"
 */

import { createServer } from '../src/server.js';

const PORT = 18099;
const statements = process.argv.slice(2);
if (statements.length === 0) {
  statements.push("SELECT 1 AS id, 'alice' AS customer, TRUE AS is_paid");
}

const server = await createServer({ port: PORT, verbose: false });
const running = await server.listen(PORT, '127.0.0.1');
const base = `http://127.0.0.1:${running.port}`;

const loginResponse = await fetch(
  `${base}/session/v1/login-request?databaseName=SNOWTEST&schemaName=PUBLIC&warehouseName=SNOWTEST_WH&roleName=SYSADMIN`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      data: { ACCOUNT_NAME: 'SNOWTEST', LOGIN_NAME: 'test', PASSWORD: 'test', CLIENT_APP_ID: 'dump' },
    }),
  },
);
const loginBody = (await loginResponse.json()) as { data?: { token?: string } };
const token = loginBody.data?.token ?? '';

async function query(sql: string) {
  const response = await fetch(`${base}/queries/v1/query-request`, {
    method: 'POST',
    headers: { authorization: `Snowflake Token="${token}"`, 'content-type': 'application/json' },
    body: JSON.stringify({ sqlText: sql, sequenceId: 0, isInternal: false, describeOnly: false }),
  });
  const text = await response.text();
  const parsed = JSON.parse(text) as {
    success: boolean;
    data?: { rowtype?: Array<{ name: string; type: string; scale: number | null }>; rowset?: unknown };
    message?: string;
  };

  console.log(`\n=== ${sql} ===`);
  if (!parsed.success) {
    console.log('FAILED:', parsed.message);
    return;
  }
  console.log(
    'types:',
    (parsed.data?.rowtype ?? []).map((c) => `${c.name}:${c.type}${c.scale !== null ? `(s${c.scale})` : ''}`).join(', '),
  );
  console.log('rowset:', JSON.stringify(parsed.data?.rowset));
}

await query('CREATE OR REPLACE TABLE dump_t (x INTEGER, ts TIMESTAMP, v VARCHAR)');
await query('INSERT INTO dump_t VALUES (1, TIMESTAMP \'2024-01-15 10:30:00\', \'a\')');

for (const statement of statements) {
  await query(statement);
}

await running.close();
await server.close();
