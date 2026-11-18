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
import type { Clock } from '../config/config.js';

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
  /** Canonical keys (see catalog.ts). */
  database: string;
  schema: string;
  warehouse: string;
  clientAppId?: string;
  clientAppVersion?: string;
  /** emulated clock, when SNOWTEST_CLOCK is set. */
  clock?: Clock | null;
}

export class Session {
  readonly id: number;
  readonly user: string;
  role: string;
  /** null after the current database (schema) is dropped, as in Snowflake. */
  database: string | null;
  schema: string | null;
  warehouse: string;
  readonly clientAppId: string;
  readonly clientAppVersion: string;
  readonly createdAt = new Date();
  /** Refreshed whenever the session runs a statement; drives idle expiry. */
  lastUsedAt = new Date();
  readonly parameters: Map<string, string>;
  readonly catalog: Catalog;
  /** Frozen or offset clock; null means the host clock. */
  readonly clock: Clock | null;
  /** Parameters the client set itself, as opposed to the defaults above. */
  private readonly explicitParameters = new Set<string>();

  /** Set once by the server so the session can execute statements. */
  connection: unknown = null;

  constructor(options: SessionOptions, catalog: Catalog) {
    this.id = options.id;
    this.user = options.user;
    this.role = options.role;
    this.database = options.database;
    this.schema = options.schema;
    this.warehouse = options.warehouse;
    this.clientAppId = options.clientAppId ?? 'snowtest';
    this.clientAppVersion = options.clientAppVersion ?? '0.1.0';
    this.catalog = catalog;
    this.clock = options.clock ?? null;
    this.parameters = new Map(Object.entries(DEFAULT_PARAMETERS));
  }

  /**
   * Milliseconds the emulated clock reports, or undefined to use the host clock.
   * An offset is resolved per statement, so time still moves during a long test.
   */
  clockMs(): number | undefined {
    if (!this.clock) return undefined;
    return this.clock.kind === 'fixed' ? this.clock.at.getTime() : Date.now() + this.clock.ms;
  }

  /** Session parameters in the `{name, value}` shape clients expect. */
  parameterList(): SessionParameter[] {
    return [...this.parameters.entries()].map(([name, value]) => ({ name, value }));
  }

  setParameter(name: string, value: string): void {
    const key = normalizeName(name);
    this.parameters.set(key, value);
    // Remembered so MULTI_STATEMENT_COUNT is enforced only when the client set
    // it: the default of 1 would otherwise reject every multi-statement script.
    this.explicitParameters.add(key);
  }

  /** MULTI_STATEMENT_COUNT when the client set it; 0 means "whatever the request holds". */
  multiStatementCount(): number | null {
    if (!this.explicitParameters.has('MULTI_STATEMENT_COUNT')) return null;
    const value = Number(this.parameters.get('MULTI_STATEMENT_COUNT'));
    return Number.isInteger(value) && value >= 0 ? value : null;
  }

  getParameter(name: string): string | undefined {
    return this.parameters.get(normalizeName(name));
  }

  /** Fully-qualified name for the current context, used in error messages. */
  contextName(): string {
    return `${this.database}.${this.schema}`;
  }
}

/** Matches the 3600s `validityInSeconds` a login response advertises. */
export const SESSION_IDLE_MS = 60 * 60 * 1000;

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

  /** Undefined for an unknown or idle-expired token, as Snowflake treats a dead session. */
  get(token: string | null | undefined): Session | undefined {
    if (!token) return undefined;
    const session = this.byToken.get(token);
    if (!session) return undefined;
    if (Date.now() - session.lastUsedAt.getTime() > SESSION_IDLE_MS) return undefined;
    return session;
  }

  /** Remove sessions idle past the TTL and hand them back so their connections can be closed. */
  sweep(now = Date.now()): Session[] {
    const idle: Session[] = [];
    for (const [token, session] of this.byToken) {
      if (now - session.lastUsedAt.getTime() > SESSION_IDLE_MS) {
        this.byToken.delete(token);
        idle.push(session);
      }
    }
    return idle;
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
