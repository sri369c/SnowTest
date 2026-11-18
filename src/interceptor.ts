// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * Statement interceptor.
 *
 * Every statement a client sends — driver protocol or SQL API v2 — reaches the
 * router through this one wrapper. It exists so the work that happens *around*
 * every statement has a single home instead of leaking into the protocol
 * handlers: timing and the `SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY` row.
 *
 * It knows nothing about SQL semantics. It hands the statement to a callback
 * and records what happened to it; the router keeps routing.
 *
 * Bookkeeping never fails a client's statement: if the history write breaks,
 * the warning lands in the server log and the result still reaches the caller.
 * The record is a convenience here, not a participant.
 */

import type { Catalog } from './engine/catalog.js';
import type { Engine } from './engine/engine.js';
import type { Session } from './engine/session.js';
import { SnowflakeError } from './sql/errors.js';
import type { Outcome } from './sql/outcome.js';

/** QUERY_HISTORY keeps only the head of a long statement. */
const HISTORY_TEXT_LIMIT = 200;

export class StatementInterceptor {
  constructor(
    private readonly engine: Engine,
    private readonly catalog: Catalog,
  ) {}

  /**
   * Run one statement, timing it around the work and noting it afterwards.
   *
   * The clock closes before the history write, so the row reports the
   * statement's cost and not the cost of recording it.
   */
  async run(statement: string, session: Session, route: () => Promise<Outcome>): Promise<Outcome> {
    const verb = this.verbOf(statement);
    const startedAt = new Date();
    const startedMs = Date.now();
    try {
      const outcome = await route();
      await this.noteQuery(statement, verb, session, startedAt, Date.now() - startedMs, outcome, null);
      return outcome;
    } catch (error) {
      await this.noteQuery(statement, verb, session, startedAt, Date.now() - startedMs, null, error);
      throw error;
    }
  }

  /** The leading keyword, uppercased: `SELECT`, `INSERT`, `SHOW`. */
  private verbOf(statement: string): string {
    return /^([a-z]+)/i.exec(statement)?.[1]?.toUpperCase() ?? '';
  }

  /** Note one statement in SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY. */
  private async noteQuery(
    statement: string,
    verb: string,
    session: Session,
    startedAt: Date,
    elapsedMs: number,
    outcome: Outcome | null,
    error: unknown,
  ): Promise<void> {
    const failure = error instanceof SnowflakeError ? error : null;
    try {
      await this.engine.recordQuery({
        queryText:
          statement.length > HISTORY_TEXT_LIMIT
            ? `${statement.slice(0, HISTORY_TEXT_LIMIT - 3)}...`
            : statement,
        databaseName: session.database,
        schemaName: session.schema,
        queryType: verb,
        sessionId: session.id,
        userName: session.user,
        roleName: session.role,
        warehouseName: session.warehouse || null,
        warehouseSize: this.catalog.warehouses.get(session.warehouse)?.size ?? null,
        executionStatus: error ? 'FAIL' : 'SUCCESS',
        errorCode: failure?.code ?? (error ? 'SNOWTEST_INTERNAL' : null),
        errorMessage: failure?.message ?? (error ? String(error) : null),
        startedAt,
        endedAt: new Date(),
        totalElapsedTime: elapsedMs,
        rowsProduced: outcome ? outcome.rows.length || outcome.rowsAffected : 0,
      });
    } catch (historyError) {
      process.stderr.write(`snowtest: query history write failed: ${String(historyError)}\n`);
    }
  }
}
