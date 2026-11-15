// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * Snowtest HTTP server.
 *
 * Three surfaces over one statement router:
 *  - `/session/v1/*` + `/queries/v1/*`  the (undocumented) driver protocol used
 *    by snowflake-connector-python, dbt, Snowpark clients and JDBC
 *  - `/api/v2/statements/*`             the documented SQL REST API v2
 *  - `/_snowtest/*`                     control plane for tests
 */

import { createPublicKey, randomUUID, verify as verifySignature } from 'node:crypto';
import { createServer as createNodeServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { gunzipSync, inflateSync } from 'node:zlib';

import { Hono, type Context } from 'hono';

import { Catalog, normalizeName } from './catalog.js';
import { loadConfig, type SnowtestConfig } from './config.js';
import { Engine, quoteIdent, type EngineConnection } from './engine.js';
import {
  SnowflakeError,
  authError,
  loginObjectNotFound,
  mapEngineError,
  protocolError,
  sessionExpired,
} from './errors.js';
import {
  PREVIEW_LIMIT,
  renderMissing,
  renderPreview,
  renderSchema,
  type BrowseTable,
} from './browse.js';
import { renderHome, type HomeDatabaseState } from './home.js';
import { renderOperations } from './operations.js';
import { renderConfiguration, renderTroubleshooting } from './usage.js';
import { PACKAGE_VERSION } from './version.js';
import { StatementRouter, type Outcome } from './meta.js';
import { DataDir } from './persist.js';
import {
  SERVER_VERSION,
  driverErrorResponse,
  driverQueryResponse,
  loginResponse,
  sqlApiErrorBody,
  sqlApiMultiResult,
  sqlApiResult,
  successEnvelope,
  tokenResponse,
} from './protocol.js';
import { Session, SessionRegistry } from './session.js';
import { StageStore } from './stage.js';

interface StoredStatement {
  outcome: Outcome;
  session: Session;
  queryId: string;
  createdAt: number;
  consumed: boolean;
}

export interface SnowtestServer {
  app: Hono;
  engine: Engine;
  catalog: Catalog;
  sessionRegistry: SessionRegistry;
  config: SnowtestConfig;
  listen(port?: number, host?: string): Promise<{ port: number; host: string; close: () => Promise<void> }>;
  close(): Promise<void>;
}

const randomToken = (): string => randomUUID().replace(/-/g, '');

const log = (...args: unknown[]): void => console.log(new Date().toISOString(), ...args);

/** Collapse whitespace and cap length so text stays on one log line. */
function oneLine(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function logQuery(
  surface: 'driver' | 'api',
  session: Session,
  startedAt: number,
  sql: string,
  result: Outcome | SnowflakeError,
): void {
  const status =
    result instanceof SnowflakeError
      ? `error ${result.code} ${oneLine(result.message, 200)}`
      : `ok rows=${result.rows.length}${result.rowsAffected ? ` affected=${result.rowsAffected}` : ''}`;
  log(
    `query ${surface} session=${session.id} user=${session.user} ${Date.now() - startedAt}ms ${status} sql="${oneLine(sql)}"`,
  );
}

interface TokenCheck {
  ok: boolean;
  user?: string;
  reason?: string;
}

function base64UrlDecode(part: string): Buffer {
  return Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Build a JWT checker from a configured public key, or `null` when snowtest is
 * running in its permissive default mode.
 *
 * Key-pair auth is how service accounts normally reach Snowflake: the client
 * signs a short-lived JWT with its private key and Snowflake checks it against
 * the public key registered on the user. Verifying the signature is what makes
 * "does my key-pair setup actually work, and is a wrong key rejected?" a real
 * test instead of a stub that accepts anything.
 */
function createJwtVerifier(publicKeyPem: string | null): ((token: string) => TokenCheck) | null {
  if (!publicKeyPem) return null;

  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey(publicKeyPem);
  } catch (error) {
    throw new Error(`SNOWTEST_JWT_PUBLIC_KEY is not a valid public key: ${String(error)}`);
  }

  return (token: string): TokenCheck => {
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed token' };

    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(base64UrlDecode(parts[0]).toString('utf8')) as Record<string, unknown>;
      payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8')) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: 'malformed token' };
    }

    const alg = String(header.alg ?? '');
    const hash = alg === 'RS256' ? 'sha256' : alg === 'RS384' ? 'sha384' : alg === 'RS512' ? 'sha512' : null;
    if (!hash) return { ok: false, reason: `unsupported algorithm '${alg}'` };

    let valid = false;
    try {
      valid = verifySignature(
        hash,
        Buffer.from(`${parts[0]}.${parts[1]}`),
        key,
        base64UrlDecode(parts[2]),
      );
    } catch {
      return { ok: false, reason: 'signature verification failed' };
    }
    if (!valid) return { ok: false, reason: 'signature verification failed' };

    // Both claims are required: Snowflake rejects a JWT without `exp`, and without
    // `iss` it cannot tell which account and user signed it.
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) {
      return { ok: false, reason: 'token expired or missing exp' };
    }

    // Snowflake's issuer is `ACCOUNT.USER.SHA256:<fingerprint>`.
    const issuer = typeof payload.iss === 'string' ? payload.iss : '';
    const user = issuer.includes('.') ? issuer.split('.')[1] : undefined;
    if (!user) return { ok: false, reason: 'issuer is missing the account and user' };
    return { ok: true, user };
  };
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const driverMatch = /Snowflake\s+Token\s*=\s*"([^"]*)"/i.exec(header);
  if (driverMatch) return driverMatch[1];
  const bearer = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (bearer) return bearer[1].trim();
  return header.trim() || null;
}

/** Decode a JWT payload without verifying it; we only need `iss` and `exp`. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The Python connector sends positional bindings as a map of
 * `{"1": {"type": "TEXT", "value": "..."}}`. We flatten them into positional
 * values, coercing numerics so `?` substitution produces valid SQL.
 */
function normalizeBindings(raw: unknown): unknown[] {
  if (!raw || typeof raw !== 'object') return [];
  const entries = Object.entries(raw as Record<string, unknown>);
  entries.sort((a, b) => Number(a[0]) - Number(b[0]));
  return entries.map(([, value]) => coerceBinding(value));
}

function coerceBinding(value: unknown): unknown {
  if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    const binding = value as { type?: string; value?: unknown };
    const type = String(binding.type ?? '').toLowerCase();
    const raw = binding.value;
    if (raw === null || raw === undefined) return null;
    if (type === 'fixed' || type === 'real') {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : raw;
    }
    if (type === 'boolean') return raw === true || raw === 'true';
    if (type === 'variant' || type === 'object' || type === 'array') {
      return typeof raw === 'string' ? raw : JSON.stringify(raw);
    }
    return raw;
  }
  return value ?? null;
}

function errorStatus(error: SnowflakeError): 400 | 401 | 404 | 422 {
  if (error.kind === 'auth') return 401;
  if (error.kind === 'protocol') return 400;
  return 422;
}

/** Drivers gzip their bodies; cap both the bytes received and the bytes decoded. */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_DECODED_BYTES = 128 * 1024 * 1024;

type ParsedJson = { ok: true; body: Record<string, unknown> } | { ok: false };

async function readJson(context: Context): Promise<ParsedJson> {
  try {
    const body = await context.req.json();
    return {
      ok: true,
      body: body && typeof body === 'object' ? (body as Record<string, unknown>) : {},
    };
  } catch {
    // An unparseable body is a client error, not an empty one: reporting it as
    // empty turns every missing field into the wrong diagnosis.
    return { ok: false };
  }
}

export async function createServer(overrides: Partial<SnowtestConfig> = {}): Promise<SnowtestServer> {
  const config = loadConfig(overrides);
  const verifyJwt = createJwtVerifier(config.jwtPublicKey);
  const catalog = new Catalog({
    databases: config.databases,
    warehouses: config.warehouses,
    roles: config.roles,
  });
  const dataDir = config.dataDir ? await DataDir.open(config.dataDir) : null;
  const engine = await Engine.create(dataDir);
  const statements = new Map<string, StoredStatement>();
  // Results of statements submitted with asyncExec, served via getResultUrl.
  const asyncResults = new Map<string, { outcome: Outcome; session: Session }>();
  // The connector's async path polls /monitoring/queries for a query's state.
  const queryLog = new Map<
    string,
    {
      sqlText: string;
      sessionId: number;
      warehouse: string;
      startedAt: number;
      finishedAt: number;
      state: string;
      errorMessage: string | null;
    }
  >();
  const sessions = new SessionRegistry();
  const router = new StatementRouter(engine, catalog, new StageStore(), dataDir, (database) => {
    // Dropping a database invalidates every session's context, not just the caller's.
    for (const session of sessions.all()) {
      if (session.database === database) {
        session.database = null;
        session.schema = null;
      }
    }
  });

  // Statement handles and query records are caches, not history: keep them bounded
  // so a long-lived server cannot grow without limit. Map iteration is insert order.
  const MAX_STATEMENTS = 256;
  const MAX_QUERY_RECORDS = 1024;
  const STATEMENT_RETENTION_MS = 24 * 60 * 60 * 1000;
  let requests = 0;

  const pruneOldest = <T>(map: Map<string, T>, max: number): void => {
    while (map.size > max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) return;
      map.delete(oldest);
    }
  };

  const closeSession = (session: Session): void => {
    const connection = session.connection as EngineConnection | null;
    connection?.close();
    session.connection = null;
  };

  /** Idle sessions hold a DuckDB connection open; expire them as Snowflake would. */
  const sweepSessions = (): void => {
    for (const idle of sessions.sweep()) {
      log(`session expired session=${idle.id} user=${idle.user}`);
      closeSession(idle);
    }
  };

  // Persisted databases come back first, so their schemas and stages can be restored.
  const persisted = dataDir ? await dataDir.databases() : [];
  for (const name of persisted) catalog.createDatabase(name);
  for (const database of catalog.databases.values()) {
    await engine.attachDatabase(database.name);
    for (const schema of database.schemas.keys()) {
      await engine.createSchema(database.name, schema);
    }
  }
  if (dataDir) {
    for (const database of catalog.databases.values()) {
      for (const schema of await engine.listSchemas(database.name)) {
        catalog.createSchema(database.name, schema);
      }
    }
    for (const stage of await dataDir.loadStages()) {
      if (!catalog.getSchema(stage.database, stage.schema)) {
        throw new Error(`Persisted stage ${stage.database}.${stage.schema}.${stage.name} has no schema.`);
      }
      catalog.createStage({
        ...stage,
        directory: await router.stages.directoryFor(stage.database, stage.schema, stage.name),
      });
    }
    log(`data dir ${dataDir.root}: restored ${persisted.length} database file(s), ${catalog.stages.size} stage(s)`);
  }

  const app = new Hono();

  app.use('*', async (c, next) => {
    const startedAt = Date.now();
    await next();
    if (config.verbose) {
      log(`${c.req.method} ${new URL(c.req.url).pathname} → ${c.res.status} ${Date.now() - startedAt}ms`);
    }
  });

  // Replaces Hono's default handler so uncaught route errors are timestamped.
  app.onError((error, c) => {
    log(`error 500 ${c.req.method} ${new URL(c.req.url).pathname}:`, error.stack ?? String(error));
    return c.text('Internal Server Error', 500);
  });

  // ---------------------------------------------------------------------------
  // Landing page: what this process is, and how to point a client at it.
  // ---------------------------------------------------------------------------

  app.get('/', async (c) => {
    // Counts come from the engine on every load, so the page never advertises a
    // state the server does not actually have. A database that cannot be read
    // must not take the landing page down with it.
    const databases: HomeDatabaseState[] = [];
    for (const database of catalog.snapshot().databases) {
      const schemas: HomeDatabaseState['schemas'] = [];
      for (const schema of database.schemas) {
        let tables = 0;
        let views = 0;
        try {
          const objects = await engine.listTables(database.name, schema);
          tables = objects.filter((object) => object.kind === 'TABLE').length;
          views = objects.filter((object) => object.kind === 'VIEW').length;
        } catch {
          // Leave the counts at zero rather than failing the whole page.
        }
        schemas.push({ name: schema, tables, views });
      }
      databases.push({ name: database.name, schemas });
    }

    return c.html(
      renderHome(config, new URL(c.req.url).origin, SERVER_VERSION, {
        databases,
        warehouses: [...catalog.warehouses.keys()].sort(),
        roles: [...catalog.roles.keys()].sort(),
        stages: catalog.stages.size,
        sessions: sessions.all().map((session) => ({
          user: session.user,
          database: session.database,
          schema: session.schema,
          role: session.role,
          createdAt: session.createdAt,
        })),
      }),
    );
  });

  // The reference the landing page links to. Static content, rendered from
  // `src/operations.ts` so the summary on `/` and this page share one source.
  app.get('/operations', (c) => c.html(renderOperations(SERVER_VERSION)));

  // Flags and environment rendered from the same option table the CLI prints in
  // `--help`; `/usage` is the old address and redirects so bookmarks keep working.
  app.get('/configuration', (c) => c.html(renderConfiguration(SERVER_VERSION)));
  app.get('/usage', (c) => c.redirect('/configuration', 301));
  app.get('/troubleshooting', (c) => c.html(renderTroubleshooting(SERVER_VERSION)));

  // ---------------------------------------------------------------------------
  // Catalog browser, read-only: the counts on `/` are a link into the data.
  // Object names are resolved against the catalog, so nothing a URL carries is
  // ever pasted into SQL; the resolved name is quoted before it is used.
  // ---------------------------------------------------------------------------

  /** Row count for one table; the caller reuses a single connection for the page. */
  const countRows = async (connection: EngineConnection, target: string): Promise<number | null> => {
    try {
      const result = await connection.execute(`SELECT count(*) FROM ${target}`);
      return Number(result.rows[0]?.[0] ?? 0);
    } catch {
      // A view over a dropped table, or a type count() cannot handle: show no
      // number rather than failing the whole list.
      return null;
    }
  };

  app.get('/browse/:database/:schema', async (c) => {
    const database = normalizeName(c.req.param('database'));
    const schema = normalizeName(c.req.param('schema'));
    if (!catalog.getSchema(database, schema)) {
      return c.html(
        renderMissing('Schema not found', `No schema ${database}.${schema} in this account.`),
        404,
      );
    }
    const objects = await engine.listTables(database, schema);
    const tables: BrowseTable[] = [];
    // One connection for the whole page: one per table meant N connections per load.
    const connection = await engine.newConnection();
    try {
      for (const object of objects) {
        tables.push({
          name: object.name,
          kind: object.kind,
          rows: await countRows(
            connection,
            `${quoteIdent(database)}.${quoteIdent(schema)}.${quoteIdent(object.name)}`,
          ),
        });
      }
    } finally {
      connection.close();
    }
    return c.html(renderSchema(database, schema, tables));
  });

  app.get('/browse/:database/:schema/:table', async (c) => {
    const database = normalizeName(c.req.param('database'));
    const schema = normalizeName(c.req.param('schema'));
    if (!catalog.getSchema(database, schema)) {
      return c.html(
        renderMissing('Schema not found', `No schema ${database}.${schema} in this account.`),
        404,
      );
    }
    const requested = c.req.param('table').toUpperCase();
    const object = (await engine.listTables(database, schema)).find(
      (entry) => entry.name.toUpperCase() === requested,
    );
    if (!object) {
      return c.html(
        renderMissing(
          'Object not found',
          `No table or view named ${requested} in ${database}.${schema}.`,
        ),
        404,
      );
    }

    const target = `${quoteIdent(database)}.${quoteIdent(schema)}.${quoteIdent(object.name)}`;
    const connection = await engine.newConnection();
    try {
      const total = await connection.execute(`SELECT count(*) FROM ${target}`);
      const result = await connection.execute(`SELECT * FROM ${target} LIMIT ${PREVIEW_LIMIT}`);
      return c.html(
        renderPreview({
          database,
          schema,
          table: object.name,
          kind: object.kind,
          columns: result.columns.map((column) => ({
            name: column.name,
            duckType: column.duckType,
          })),
          rows: result.rows,
          total: Number(total.rows[0]?.[0] ?? 0),
        }),
      );
    } catch (error) {
      const message = error instanceof SnowflakeError ? error.message : String(error);
      return c.html(renderMissing('Preview failed', message), 500);
    } finally {
      connection.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Health / control plane
  // ---------------------------------------------------------------------------

  // The two versions are named explicitly so neither can be mistaken for the
  // other: the Snowflake release this stub imitates, and snowtest itself.
  app.get('/_snowtest/health', (c) =>
    c.json({
      status: 'ok',
      emulatedSnowflakeVersion: SERVER_VERSION,
      snowtestVersion: PACKAGE_VERSION,
    }),
  );

  app.get('/_snowtest/state', (c) =>
    c.json({
      ...catalog.snapshot(),
      sessions: sessions.size,
      activeSession: sessions.all().map((session) => ({
        id: session.id,
        user: session.user,
        database: session.database,
        schema: session.schema,
        role: session.role,
        warehouse: session.warehouse,
      })),
    }),
  );

  app.post('/_snowtest/seed', async (c) => {
    const parsed = await readJson(c);
    if (!parsed.ok) return c.json({ error: 'Request body must be JSON.' }, 400);
    const body = parsed.body;
    const sql = typeof body.sql === 'string' ? body.sql : '';
    if (!sql) return c.json({ error: 'Provide {"sql": "<statements>"}' }, 400);

    const session = new Session(
      {
        id: sessions.allocateId(),
        user: 'SNOWTEST_SEED',
        role: config.defaultRole,
        database: config.defaultDatabase,
        schema: config.defaultSchema,
        warehouse: config.defaultWarehouse,
        clock: config.clock,
      },
      catalog,
    );

    let executed = 0;
    for (const statement of sql.split(/;\s*(?:\r?\n|$)/)) {
      const trimmed = statement.trim();
      if (!trimmed) continue;
      await router.execute(trimmed, session);
      executed += 1;
    }
    // Seeding runs on its own session, so its connection is this handler's to close.
    closeSession(session);
    return c.json({ executed });
  });

  app.post('/_snowtest/reset', async (c) => {
    for (const session of sessions.all()) closeSession(session);
    for (const database of [...catalog.databases.keys()]) {
      await engine.detachDatabase(database);
    }
    catalog.databases.clear();
    await dataDir?.clear();

    // Account objects and statement handles created by a test must not survive
    // a reset either: "the closest thing to a clean Snowflake account" is the
    // whole point of this endpoint.
    for (const stage of catalog.stages.values()) {
      if (stage.directory) await router.stages.removeAll(stage.directory);
    }
    catalog.stages.clear();
    catalog.warehouses.clear();
    catalog.roles.clear();
    for (const warehouse of config.warehouses) catalog.createWarehouse(warehouse);
    for (const role of config.roles) catalog.createRole(role);
    statements.clear();
    asyncResults.clear();
    queryLog.clear();

    for (const database of config.databases) {
      catalog.createDatabase(database.name);
      await engine.attachDatabase(database.name);
      for (const schema of database.schemas) {
        catalog.createSchema(database.name, schema);
        await engine.createSchema(database.name, schema);
      }
    }
    return c.json({ reset: true });
  });

  // ---------------------------------------------------------------------------
  // Driver protocol: session lifecycle
  // ---------------------------------------------------------------------------

  const establishSession = async (c: Context, body: Record<string, unknown>): Promise<Session> => {
    const url = new URL(c.req.url);
    // The driver protocol historically wraps its payload in `data`. Newer
    // connectors (5.x) send the same fields at the top level, so accept both
    // shapes — otherwise the login name and JWT are silently invisible.
    const nested = body.data;
    const data = (nested && typeof nested === 'object' ? nested : body) as Record<string, unknown>;
    const user = String(data.LOGIN_NAME ?? data.loginName ?? 'SNOWTEST_USER');
    const clientAppId = String(data.CLIENT_APP_ID ?? 'snowtest');
    const clientAppVersion = String(data.CLIENT_APP_VERSION ?? '0.1.0');

    // Only client-supplied names are folded; config defaults are already canonical.
    const requestedDatabase = url.searchParams.get('databaseName') || String(data.DATABASE_NAME ?? '');
    const requestedSchema = url.searchParams.get('schemaName') || String(data.SCHEMA_NAME ?? '');
    const requestedWarehouse = url.searchParams.get('warehouseName') || String(data.WAREHOUSE_NAME ?? '');
    const requestedRole = url.searchParams.get('roleName') || String(data.ROLE_NAME ?? '');

    if (config.users.length > 0 && !config.users.map((u) => u.toUpperCase()).includes(user.toUpperCase())) {
      throw authError();
    }

    const rawToken =
      data.TOKEN ?? data.token ?? body.TOKEN ?? body.token ?? data.SESSION_TOKEN ?? data.sessionToken;
    const authToken = typeof rawToken === 'string' ? rawToken : '';

    if (config.verbose) {
      const shape = authToken
        ? `len=${authToken.length} dots=${authToken.split('.').length - 1}`
        : 'absent';
      log(
        `login detail user=${user} authenticator=${String(data.AUTHENTICATOR ?? '')} token=${shape} ` +
          `dataKeys=${Object.keys(data).sort().join(',')}`,
      );
    }

    if (verifyJwt) {
      const renewal = authToken ? sessions.get(authToken) : undefined;
      if (renewal) {
        // A client re-presenting a session token we issued (renewal, or a pooled
        // connection) has already proven its identity; it must not re-sign.
        if (renewal.user.toUpperCase() !== user.toUpperCase()) {
          throw authError(`Session token is not valid for user '${user}'.`);
        }
        return renewal;
      }
      const check = verifyJwt(authToken);
      if (!check.ok) {
        throw authError(`JWT token is invalid: ${check.reason ?? 'verification failed'}.`);
      }
      if (check.user && check.user.toUpperCase() !== user.toUpperCase()) {
        throw authError(`JWT token is not valid for user '${user}'.`);
      }
    }

    const database = normalizeName(requestedDatabase) || config.defaultDatabase;
    const schema = normalizeName(requestedSchema) || config.defaultSchema;
    const warehouse = normalizeName(requestedWarehouse) || config.defaultWarehouse;

    // The connector sends CLIENT_VALIDATE_DEFAULT_PARAMETERS=true for
    // validate_default_parameters=True: unknown database/schema/warehouse fails the login.
    // Checked after authentication so credential errors still take precedence.
    const sessionParameters = data.SESSION_PARAMETERS as Record<string, unknown> | undefined;
    if (sessionParameters?.CLIENT_VALIDATE_DEFAULT_PARAMETERS === true) {
      if (!catalog.getDatabase(database)) throw loginObjectNotFound('database');
      if (!catalog.getSchema(database, schema)) throw loginObjectNotFound('schema');
      if (!catalog.warehouses.has(warehouse)) throw loginObjectNotFound('warehouse');
    }

    // Otherwise login creates the requested (or default) database, schema and warehouse if unknown.
    if (!catalog.getDatabase(database)) {
      catalog.createDatabase(database);
      await engine.attachDatabase(database);
      catalog.createSchema(database, 'PUBLIC');
      await engine.createSchema(database, 'PUBLIC');
    }
    if (!catalog.getSchema(database, schema)) {
      catalog.createSchema(database, schema);
      await engine.createSchema(database, schema);
    }
    if (!catalog.warehouses.has(warehouse)) catalog.createWarehouse(warehouse);

    return new Session(
      {
        id: sessions.allocateId(),
        user,
        role: normalizeName(requestedRole) || config.defaultRole,
        database,
        schema,
        warehouse,
        clientAppId,
        clientAppVersion,
        clock: config.clock,
      },
      catalog,
    );
  };

  app.post('/session/v1/login-request', async (c) => {
    const parsed = await readJson(c);
    if (!parsed.ok) {
      return c.json(driverErrorResponse(protocolError('Request body is not valid JSON.')), 400);
    }
    const body = parsed.body;
    sweepSessions();
    const nested = body.data;
    const data = (nested && typeof nested === 'object' ? nested : body) as Record<string, unknown>;
    const user = String(data.LOGIN_NAME ?? data.loginName ?? 'SNOWTEST_USER');
    try {
      const session = await establishSession(c, body);
      const token = randomToken();
      const masterToken = randomToken();
      sessions.create(token, session);
      log(
        `login ok session=${session.id} user=${session.user} account=${String(data.ACCOUNT_NAME ?? '-')} ` +
          `authenticator=${String(data.AUTHENTICATOR ?? '-')} ${session.database}.${session.schema} role=${session.role}`,
      );
      return c.json(loginResponse(session, token, masterToken));
    } catch (error) {
      const failure = mapEngineError(error);
      log(`login failed user=${user}: ${oneLine(failure.message, 200)}`);
      return c.json(driverErrorResponse(failure));
    }
  });

  // Token renewal: the connector reuses the existing session.
  app.get('/session/v1/login-request', async (c) => {
    try {
      const token = bearerToken(c.req.header('authorization'));
      const session = sessions.get(token);
      if (!session) throw sessionExpired();
      const renewed = randomToken();
      sessions.delete(token as string);
      sessions.create(renewed, session);
      if (config.verbose) log(`token renew session=${session.id} user=${session.user}`);
      return c.json(loginResponse(session, renewed, randomToken()));
    } catch (error) {
      return c.json(driverErrorResponse(mapEngineError(error)));
    }
  });

  app.post('/session/token-request', async (c) => {
    try {
      const token = bearerToken(c.req.header('authorization'));
      const session = sessions.get(token);
      if (!session) throw sessionExpired();
      const renewed = randomToken();
      sessions.delete(token as string);
      sessions.create(renewed, session);
      if (config.verbose) log(`token renew session=${session.id} user=${session.user}`);
      return c.json(tokenResponse(session, renewed, randomToken()));
    } catch (error) {
      return c.json(driverErrorResponse(mapEngineError(error)));
    }
  });

  app.post('/session/heartbeat', (c) => c.json(successEnvelope({ sessionId: 0 })));

  app.post('/session', (c) => {
    const token = bearerToken(c.req.header('authorization'));
    if (token) {
      const session = sessions.delete(token);
      if (session) {
        log(`logout session=${session.id} user=${session.user}`);
        closeSession(session);
      }
    }
    return c.json(successEnvelope(null));
  });

  app.get('/session', (c) => {
    const token = bearerToken(c.req.header('authorization'));
    const session = token ? sessions.delete(token) : undefined;
    if (session) {
      log(`logout session=${session.id} user=${session.user}`);
      // GET logout releases the connection too; otherwise every driver logout leaks one.
      closeSession(session);
    }
    return c.json(successEnvelope(null));
  });

  app.post('/telemetry/send', (c) => c.json({ success: true }));

  // ---------------------------------------------------------------------------
  // Driver protocol: queries
  // ---------------------------------------------------------------------------

  app.post('/queries/v1/query-request', async (c) => {
    const token = bearerToken(c.req.header('authorization'));
    const session = sessions.get(token);
    if (!session) {
      return c.json(driverErrorResponse(sessionExpired()));
    }

    const parsed = await readJson(c);
    if (!parsed.ok) {
      return c.json(driverErrorResponse(protocolError('Request body is not valid JSON.')), 400);
    }
    const body = parsed.body;
    const sql = String(body.sqlText ?? '');
    const describeOnly = body.describeOnly === true;
    const queryId = randomUUID();

    const startedAt = Date.now();
    try {
      const outcomes = await router.executeMany(sql, session, {
        bindings: normalizeBindings(body.bindings),
      });
      // The driver protocol carries one result: Snowflake answers with the last
      // statement's, which is what a script's caller actually reads.
      const outcome = outcomes[outcomes.length - 1];
      if (!outcome) throw new SnowflakeError('000000', 'No statement was executed.', '42000');
      logQuery('driver', session, startedAt, sql, outcome);

      // PUT/GET: the client acts on this descriptor directly (it moves the
      // bytes), so the response data *is* the file-transfer payload.
      if (outcome.fileTransfer) {
        return c.json({
          success: true,
          data: {
            ...outcome.fileTransfer,
            queryId,
            sessionId: session.id,
            total: 0,
            returned: 0,
            rowtype: [],
            rowset: [],
            finalDatabaseName: session.database,
            finalSchemaName: session.schema,
            finalWarehouseName: session.warehouse,
            finalRoleName: session.role,
          },
          message: null,
        });
      }

      if (describeOnly) {
        outcome.rows = [];
      }
      queryLog.set(queryId, {
        sqlText: sql,
        sessionId: session.id,
        warehouse: session.warehouse,
        startedAt,
        finishedAt: Date.now(),
        state: 'SUCCESS',
        errorMessage: null,
      });
      pruneOldest(queryLog, MAX_QUERY_RECORDS);

      // Async submissions must advertise where the result can be polled;
      // the connector refuses to fall back to an inline rowset here.
      if (body.asyncExec === true) {
        asyncResults.set(queryId, { outcome, session });
        pruneOldest(asyncResults, MAX_QUERY_RECORDS);
        return c.json({
          success: true,
          data: {
            queryId,
            getResultUrl: `/queries/v1/query-result/${queryId}`,
            sqlState: '00000',
            statementTypeId: outcome.statementTypeId,
            version: 1,
            queryResultFormat: 'json',
            queryAbortsAfterSecs: null,
          },
          message: null,
        });
      }

      return c.json(driverQueryResponse(session, outcome, queryId));
    } catch (error) {
      const failure = mapEngineError(error);
      logQuery('driver', session, startedAt, sql, failure);
      queryLog.set(queryId, {
        sqlText: sql,
        sessionId: session.id,
        warehouse: session.warehouse,
        startedAt,
        finishedAt: Date.now(),
        state: 'FAILED',
        errorMessage: failure.message,
      });
      pruneOldest(queryLog, MAX_QUERY_RECORDS);
      return c.json(driverErrorResponse(failure));
    }
  });

  app.all('/queries/v1/query-result/:queryId', (c) => {
    const queryId = c.req.param('queryId');
    const entry = asyncResults.get(queryId);
    if (!entry) {
      return c.json(
        driverErrorResponse(
          new SnowflakeError('000000', `Result for query ${queryId} is not available.`, '42000'),
        ),
        404,
      );
    }
    return c.json(driverQueryResponse(entry.session, entry.outcome, queryId));
  });

  app.get('/monitoring/queries/*', (c) => {
    const segments = new URL(c.req.url).pathname.split('/').filter(Boolean);
    const last = segments.at(-1) ?? '';
    const matching = queryLog.has(last)
      ? [[last, queryLog.get(last)!] as const]
      : [...queryLog.entries()].filter(([id]) => id === last || id.startsWith(last));

    const queries = matching.map(([id, entry]) => ({
      id,
      queryId: id,
      sqlText: entry.sqlText,
      state: entry.state,
      status: entry.state === 'SUCCESS' ? 'SUCCESS' : 'FAILED_WITH_ERROR',
      errorCode: entry.state === 'FAILED' ? '1' : '0',
      errorMessage: entry.errorMessage,
      startTime: entry.startedAt,
      endTime: entry.finishedAt,
      totalDuration: Math.max(0, entry.finishedAt - entry.startedAt),
      sessionId: entry.sessionId,
      warehouseId: 1,
      warehouseName: entry.warehouse,
      warehouseExternalSize: '0',
      warehouseServerType: 'STANDARD',
      queryAbortsAfterSecs: null,
    }));

    return c.json({ success: true, data: { queries }, message: null });
  });

  app.post('/queries/v1/abort-request', (c) => c.json(successEnvelope({ queryId: null })));

  // ---------------------------------------------------------------------------
  // SQL REST API v2
  // ---------------------------------------------------------------------------

  const runSqlApi = async (c: Context) => {
    const header = c.req.header('authorization');
    const token = bearerToken(header);
    if (!token) {
      return c.json(
        sqlApiErrorBody(new SnowflakeError('390303', 'Invalid OAuth access token.', '08000', 'auth')),
        401,
      );
    }

    if (verifyJwt) {
      const check = verifyJwt(token);
      if (!check.ok) {
        return c.json(
          sqlApiErrorBody(new SnowflakeError('390303', 'JWT token is invalid.', '08000', 'auth')),
          401,
        );
      }
    }

    const payload = decodeJwtPayload(token);
    if (payload && typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) {
      return c.json(
        sqlApiErrorBody(new SnowflakeError('390303', 'JWT token is invalid.', '08000', 'auth')),
        401,
      );
    }

    const parsed = await readJson(c);
    if (!parsed.ok) {
      return c.json(sqlApiErrorBody(protocolError('Request body is not valid JSON.')), 400);
    }
    const body = parsed.body;
    const statement = String(body.statement ?? '').trim();
    if (!statement) {
      return c.json(
        sqlApiErrorBody(new SnowflakeError('000000', 'Missing required field: statement.', '42000')),
        400,
      );
    }

    const claims = payload ?? {};
    const issuer = typeof claims.iss === 'string' ? claims.iss : '';
    const user = issuer.includes('.') ? issuer.split('.')[1] : issuer || 'SNOWTEST_USER';

    // Config defaults are already canonical; folding them again would lose quoted case.
    const requested = (key: string): string => normalizeName(String(body[key] ?? ''));
    const database = requested('database') || config.defaultDatabase;
    const schema = requested('schema') || config.defaultSchema;
    const session = new Session(
      {
        id: sessions.allocateId(),
        user: user.toUpperCase(),
        role: requested('role') || config.defaultRole,
        database,
        schema,
        warehouse: requested('warehouse') || config.defaultWarehouse,
        clock: config.clock,
      },
      catalog,
    );

    const bindings: unknown[] = [];
    const rawBindings = body.bindings as Record<string, unknown> | undefined;
    if (rawBindings && typeof rawBindings === 'object') {
      const entries = Object.entries(rawBindings).sort((a, b) => Number(a[0]) - Number(b[0]));
      for (const [, value] of entries) {
        const binding = value as { type?: string; value?: unknown };
        bindings.push(coerceBinding({ type: binding?.type, value: binding?.value }));
      }
    }

    if (!catalog.getDatabase(database)) {
      catalog.createDatabase(database);
      await engine.attachDatabase(database);
      catalog.createSchema(database, 'PUBLIC');
      await engine.createSchema(database, 'PUBLIC');
    }
    if (!catalog.getSchema(database, schema)) {
      catalog.createSchema(database, schema);
      await engine.createSchema(database, schema);
    }

    const statementHandle = randomUUID().replace(/-/g, '').toUpperCase();
    const queryId = randomUUID();
    const asynchronous = c.req.query('async') === 'true';

    const startedAt = Date.now();
    try {
      const outcomes = await router.executeMany(statement, session, { bindings });
      const outcome = outcomes[outcomes.length - 1];
      if (!outcome) throw new SnowflakeError('000000', 'No statement was executed.', '42000');
      logQuery('api', session, startedAt, statement, outcome);
      // A script gets one result object per statement, which is the shape the SQL
      // API documents; a single statement keeps the flat body clients expect.
      const response =
        outcomes.length > 1
          ? sqlApiMultiResult(session, outcomes, queryId, statementHandle)
          : sqlApiResult(session, outcome, queryId, statementHandle);
      statements.set(statementHandle, {
        outcome,
        session,
        queryId,
        createdAt: Date.now(),
        consumed: false,
      });
      pruneOldest(statements, MAX_STATEMENTS);

      if (asynchronous) {
        return c.json(
          {
            statementHandle,
            statementStatusUrl: `/api/v2/statements/${statementHandle}`,
            queryId,
            sqlState: '00000',
            message: 'Statement submitted successfully.',
          },
          202,
        );
      }
      return c.json(response);
    } catch (error) {
      const failure = mapEngineError(error);
      logQuery('api', session, startedAt, statement, failure);
      return c.json(sqlApiErrorBody(failure, statementHandle), errorStatus(failure));
    } finally {
      // The handle keeps this session's metadata, never its connection: leaving it
      // open leaks one connection per statement and, on Windows, keeps the
      // database files locked after the server closes.
      closeSession(session);
    }
  };

  app.post('/api/v2/statements', runSqlApi);

  app.get('/api/v2/statements/:handle', (c) => {
    const handle = c.req.param('handle');
    const stored = statements.get(handle);
    if (stored && Date.now() - stored.createdAt > STATEMENT_RETENTION_MS) {
      statements.delete(handle);
      return c.json(
        sqlApiErrorBody(
          new SnowflakeError('000000', `Statement ${handle} has expired.`, '42000'),
          handle,
        ),
        404,
      );
    }
    if (!stored) {
      return c.json(
        sqlApiErrorBody(
          new SnowflakeError('000000', `Statement handle ${handle} not found.`, '42000'),
          handle,
        ),
        404,
      );
    }
    if (c.req.query('async') === 'true' && !stored.consumed) {
      stored.consumed = true;
      return c.json(
        { statementHandle: handle, sqlState: '00000', message: 'Statement is still running.' },
        202,
      );
    }
    return c.json(sqlApiResult(stored.session, stored.outcome, stored.queryId, handle));
  });

  app.post('/api/v2/statements/:handle/cancel', (c) => {
    const handle = c.req.param('handle');
    statements.delete(handle);
    return c.json({ code: '000604', message: 'Statement cancelled.', statementHandle: handle });
  });

  app.all('*', (c) => {
    log(`unmatched ${c.req.method} ${new URL(c.req.url).pathname}`);
    return c.json({ error: 'Not found', path: new URL(c.req.url).pathname }, 404);
  });

  const server: SnowtestServer = {
    app,
    engine,
    catalog,
    sessionRegistry: sessions,
    config,
    async listen(port = config.port, host = config.host) {
      const handler = async (req: IncomingMessage, res: ServerResponse) => {
        requests += 1;
        if (requests % 64 === 0) sweepSessions();
        try {
          const chunks: Buffer[] = [];
          let received = 0;
          for await (const chunk of req) {
            received += (chunk as Buffer).length;
            // Refuse oversized bodies instead of buffering whatever arrives.
            if (received > MAX_REQUEST_BYTES) {
              res.writeHead(413, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: `Request body exceeds ${MAX_REQUEST_BYTES} bytes.` }));
              return;
            }
            chunks.push(chunk as Buffer);
          }
          let body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

          const url = `http://${req.headers.host ?? `${host}:${port}`}${req.url ?? '/'}`;
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (Array.isArray(value)) headers.set(key, value.join(', '));
            else if (value !== undefined) headers.set(key, value);
          }

          // Snowflake drivers gzip their request bodies (the Python connector
          // sends `Content-Encoding: gzip` on every call, login included).
          // Decode at the HTTP boundary so nothing downstream sees binary.
          const encoding = String(req.headers['content-encoding'] ?? '').toLowerCase();
          if (body && body.length > 0 && encoding) {
            try {
              // `maxOutputLength` stops a small compressed body expanding without
              // bound on the event loop.
              if (encoding.includes('gzip')) body = gunzipSync(body, { maxOutputLength: MAX_DECODED_BYTES });
              else if (encoding.includes('deflate')) body = inflateSync(body, { maxOutputLength: MAX_DECODED_BYTES });
            } catch (error) {
              log(`error 400 ${req.method} ${req.url}: could not decode '${encoding}' body: ${String(error)}`);
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(
                JSON.stringify({ error: `Could not decode '${encoding}' request body: ${String(error)}` }),
              );
              return;
            }
            headers.delete('content-encoding');
            headers.delete('content-length');
          }

          const request = new Request(url, {
            method: req.method ?? 'GET',
            headers,
            body: body && body.length > 0 ? new Uint8Array(body) : undefined,
          });

          const response = await app.fetch(request);
          const payload = Buffer.from(await response.arrayBuffer());
          const outHeaders: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            outHeaders[key] = value;
          });
          res.writeHead(response.status, outHeaders);
          res.end(payload);
        } catch (error) {
          log(`error 500 ${req.method} ${req.url}:`, error instanceof Error ? (error.stack ?? error.message) : String(error));
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(error) }));
        }
      };

      const httpServer = createNodeServer((req, res) => {
        void handler(req, res);
      });

      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => resolve());
      });

      const address = httpServer.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;

      return {
        port: actualPort,
        host,
        close: async () => {
          await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        },
      };
    },
    async close() {
      for (const session of sessions.all()) closeSession(session);
      await engine.close();
    },
  };

  return server;
}
