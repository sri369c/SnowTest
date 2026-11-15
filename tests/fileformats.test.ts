// Copyright (c) 2026 Srinivas Chaturvedula

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServer, type SnowtestServer } from '../src/server.js';

interface ApiResult {
  status: number;
  body: { data?: unknown[][]; message?: string };
}

async function sql(server: SnowtestServer, statement: string): Promise<ApiResult> {
  const response = await server.app.request('/api/v2/statements', {
    method: 'POST',
    headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ statement }),
  });
  return { status: response.status, body: (await response.json()) as ApiResult['body'] };
}

async function rows(server: SnowtestServer, statement: string): Promise<unknown[][]> {
  const result = await sql(server, statement);
  if (result.status !== 200) throw new Error(`${statement}: ${result.body.message}`);
  return result.body.data ?? [];
}

/** `SHOW <object>` answers with the name in column 1, type in column 4. */
const nameOf = (row: unknown[]): unknown => row[1];
const typeOf = (row: unknown[]): unknown => row[4];
/** The property table answers as [parent_property, property, property_type, value, default]. */
const propertyMap = (rows: unknown[][]): Map<unknown, unknown> =>
  new Map(rows.map((row) => [row[1], row[3]]));

describe('file formats and DESCRIBE metadata objects', () => {
  let server: SnowtestServer;
  beforeAll(async () => {
    server = await createServer({ dataDir: null });
  });
  afterAll(async () => {
    await server.close();
  });

  it('records a created format and lists it', async () => {
    const created = await sql(
      server,
      "CREATE FILE FORMAT SNOWTEST.PUBLIC.CSV_FMT TYPE = CSV FIELD_DELIMITER = '|' SKIP_HEADER = 1",
    );
    expect(created.status).toBe(200);

    const listed = await rows(server, 'SHOW FILE FORMATS');
    expect(listed).toHaveLength(1);
    expect(nameOf(listed[0])).toBe('CSV_FMT');
    expect(typeOf(listed[0])).toBe('CSV');
  });

  it('describes a format as the type, its options, the owner and the creation time', async () => {
    const described = await rows(server, 'DESCRIBE FILE FORMAT SNOWTEST.PUBLIC.CSV_FMT');
    expect(described).toHaveLength(5);
    expect(described.map((row) => row[1])).toEqual([
      'type',
      'field_delimiter',
      'skip_header',
      'owner',
      'create_on',
    ]);
    expect(described[0][3]).toBe('CSV');
    expect(described[1][3], 'quote-free value').toBe('|');
    expect(described[2][3]).toBe('1');
  });

  it('describes a stage', async () => {
    expect((await sql(server, 'CREATE STAGE SNOWTEST.PUBLIC.DESC_STAGE')).status).toBe(200);
    const properties = propertyMap(await rows(server, 'DESCRIBE STAGE SNOWTEST.PUBLIC.DESC_STAGE'));
    expect(properties.get('type')).toBe('INTERNAL');
    expect(properties.get('has_credentials')).toBe('FALSE');
    expect(properties.get('directory_enabled')).toBe('FALSE');
    expect(properties.has('owner')).toBe(true);

    const again = propertyMap(await rows(server, 'DESCRIBE STAGE SNOWTEST.PUBLIC.DESC_STAGE'));
    expect(again.get('create_on'), 'create_on is the stage\'s creation time, not this call\'s').toBe(
      properties.get('create_on'),
    );
  });

  it('drops a format, and then cannot find it', async () => {
    expect((await sql(server, 'DROP FILE FORMAT SNOWTEST.PUBLIC.CSV_FMT')).status).toBe(200);
    expect(await rows(server, 'SHOW FILE FORMATS')).toHaveLength(0);

    const missing = await sql(server, 'DESCRIBE FILE FORMAT SNOWTEST.PUBLIC.CSV_FMT');
    expect(missing.status).toBe(422);
    expect(missing.body.message).toContain("Object 'SNOWTEST.PUBLIC.CSV_FMT'");
  });

  it('takes a format with its schema', async () => {
    await sql(server, 'CREATE FILE FORMAT SNOWTEST.PUBLIC.GONE TYPE = JSON');
    await sql(server, 'DROP SCHEMA SNOWTEST.PUBLIC');
    await sql(server, 'CREATE SCHEMA SNOWTEST.PUBLIC');
    expect(await rows(server, 'SHOW FILE FORMATS IN SCHEMA SNOWTEST.PUBLIC')).toHaveLength(0);
  });

  it('refuses DESCRIBE SEQUENCE as a missing object, not as unimplemented syntax', async () => {
    const result = await sql(server, 'DESCRIBE SEQUENCE SNOWTEST.PUBLIC.SEQ1');
    expect(result.status).toBe(422);
    expect(result.body.message).toContain("Object 'SNOWTEST.PUBLIC.SEQ1'");
  });

  it('still describes a table, and a bare DESCRIBE still means a table', async () => {
    await sql(server, 'CREATE TABLE SNOWTEST.PUBLIC.DESC_T (id NUMBER NOT NULL)');
    for (const statement of ['DESCRIBE TABLE SNOWTEST.PUBLIC.DESC_T', 'DESCRIBE SNOWTEST.PUBLIC.DESC_T']) {
      const described = await rows(server, statement);
      expect(described.map((row) => row[0])).toEqual(['ID']);
      expect(described[0][3], 'null?').toBe('N');
    }
  });
});
