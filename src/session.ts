// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * Per-connection session state.
 *
 * A Snowflake session carries the current database/schema/role/warehouse plus
 * session parameters. Snowtest keeps one of these per authenticated client and
 * one dedicated DuckDB connection, so `USE DATABASE` in one test cannot leak
 * into another.
 */

import { Catalog, normalizeName } from './catalog.js';

export interface SessionParameter {
  name: string;
  value: string;
}

const DEFAULT_PARAMETERS: Record<string, string> = {
  AUTOCOMMIT: 'true',
  CLIENT_SESSION_KEEP_ALIVE: 'false',
  CLIENT_SESSION_KEEP_ALIVE_HEARTBEAT_FREQUENCY: '3600',
  CLIENT_TELEMETRY_ENABLED: 'false',
  DATE_OUTPUT_FORMAT: 'YYYY-MM-DD',
  DATE_INPUT_FORMAT: 'AUTO',
  TIME_OUTPUT_FORMAT: 'HH24:MI:SS',
  TIMESTAMP_OUTPUT_FORMAT: 'YYYY-MM-DD HH24:MI:SS.FF3 TZHTZM',
  TIMESTAMP_LTZ_OUTPUT_FORMAT: '',
  TIMESTAMP_NTZ_OUTPUT_FORMAT: 'YYYY-MM-DD HH24:MI:SS.FF3',
  TIMESTAMP_TZ_OUTPUT_FORMAT: '',
  TIMEZONE: 'America/Los_Angeles',
  QUERY_TAG: '',
  STATEMENT_TIMEOUT_IN_SECONDS: '172800',
  MULTI_STATEMENT_COUNT: '1',
  LOCK_TIMEOUT: '43200',
  QUOTED_IDENTIFIERS_IGNORE_CASE: 'false',
  STRICT_JSON_OUTPUT: 'false',
};

export interface SessionOptions {
  id: number;
  user: string;
  role: string;
  database: string;
  schema: string;
  warehouse: string;
  clientAppId?: string;
  clientAppVersion?: string;
}

export class Session {
  readonly id: number;
  readonly user: string;
  role: string;
  database: string;
  schema: string;
  warehouse: string;
  readonly clientAppId: string;
  readonly clientAppVersion: string;
  readonly createdAt = new Date();
  readonly parameters: Map<string, string>;
  readonly catalog: Catalog;

  /** Set once by the server so the session can execute statements. */
  connection: unknown = null;

  constructor(options: SessionOptions, catalog: Catalog) {
    this.id = options.id;
    this.user = options.user;
    this.role = options.role;
    this.database = normalizeName(options.database);
    this.schema = normalizeName(options.schema);
    this.warehouse = normalizeName(options.warehouse);
    this.clientAppId = options.clientAppId ?? 'snowtest';
    this.clientAppVersion = options.clientAppVersion ?? '0.1.0';
    this.catalog = catalog;
    this.parameters = new Map(Object.entries(DEFAULT_PARAMETERS));
  }

  /** Session parameters in the `{name, value}` shape clients expect. */
  parameterList(): SessionParameter[] {
    return [...this.parameters.entries()].map(([name, value]) => ({ name, value }));
  }

  setParameter(name: string, value: string): void {
    this.parameters.set(normalizeName(name), value);
  }

  getParameter(name: string): string | undefined {
    return this.parameters.get(normalizeName(name));
  }

  /** Fully-qualified name for the current context, used in error messages. */
  contextName(): string {
    return `${this.database}.${this.schema}`;
  }
}

export class SessionRegistry {
  private readonly byToken = new Map<string, Session>();
  private nextId = 1;

  create(token: string, session: Session): Session {
    this.byToken.set(token, session);
    return session;
  }

  allocateId(): number {
    return this.nextId++;
  }

  get(token: string | null | undefined): Session | undefined {
    if (!token) return undefined;
    return this.byToken.get(token);
  }

  delete(token: string): Session | undefined {
    const session = this.byToken.get(token);
    this.byToken.delete(token);
    return session;
  }

  get size(): number {
    return this.byToken.size;
  }

  all(): Session[] {
    return [...this.byToken.values()];
  }
}
