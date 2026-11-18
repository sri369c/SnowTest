// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * Statement interceptor.
 *
 * Every statement a client sends — driver protocol or SQL API v2 — reaches the
 * router through this one wrapper. It exists so the work that happens *around*
 * every statement has a single home: the timing, the
 * `SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY` row, and the model-fidelity ledger.
 *
 * It knows nothing about SQL semantics. The router hands it a callback for
 * running the statement and another for translating it without running it; the
 * interceptor decides what to record, and in `strict` mode whether to allow it
 * at all.
 *
 * Bookkeeping never fails a client's statement: if a history or ledger write
 * breaks, the warning lands in the server log and the result still reaches the
 * caller. `strict` is the one place this module deliberately fails a statement,
 * and it does so before anything executes.
 */

import type { FidelityMode } from './config/server-config.js';
import type { Catalog } from './engine/catalog.js';
import type { Engine } from './engine/engine.js';
import type { Session } from './engine/session.js';
import type { Approximation, ApproximationSink } from './sql/dialect.js';
import { SnowflakeError, compilationError } from './sql/errors.js';
import type { Outcome } from './sql/outcome.js';

/** Everything the router is told about a statement beyond the SQL itself. */
export interface ExecuteOptions {
  bindings?: unknown[];
  /** Set by the interceptor: where a translation reports what it approximated. */
  notes?: ApproximationSink;
}

/** QUERY_HISTORY keeps only the head of a long statement. */
const HISTORY_TEXT_LIMIT = 200;

export interface InterceptionInput {
  statement: string;
  /** The dbt node that sent it, read from the raw text before comments are stripped. */
  nodeId: string | null;
  session: Session;
  /** Run the statement; the sink is passed through so notes are collected as it translates. */
  route: (notes?: ApproximationSink) => Promise<Outcome>;
  /** Translate without executing, so `strict` can decide before anything runs. */
  translate: (notes: ApproximationSink) => void;
}

export class StatementInterceptor {
  constructor(
    private readonly engine: Engine,
    private readonly catalog: Catalog,
    /** Read per statement, so changing the mode takes effect on the next query. */
    private readonly mode: () => FidelityMode,
  ) {}

  async run(input: InterceptionInput): Promise<Outcome> {
    const mode = this.mode();
    const nodeId = input.nodeId;
    const approximated: Approximation[] = [];
    const sink: ApproximationSink = (note) => approximated.push(note);
    const tracking = mode !== 'off';

    if (mode === 'strict') {
      // The decision has to come before execution, so the translation runs once
      // here with nothing behind it. Strict pays that second pass on purpose.
      input.translate(sink);
      if (approximated.length > 0) {
        const names = [...new Set(approximated.map((note) => note.feature))].join(', ');
        throw compilationError(
          `snowtest fidelity is strict: this statement would approximate ${names}.\n` +
            'Run with --fidelity report to allow it, or send this model to a real Snowflake run.',
        );
      }
    }

    const verb = this.verbOf(input.statement);
    const startedAt = new Date();
    const startedMs = Date.now();
    try {
      const outcome = await input.route(tracking ? sink : undefined);
      await this.noteQuery(input.statement, verb, input.session, startedAt, Date.now() - startedMs, outcome, null);
      if (tracking) await this.noteFidelity(nodeId, approximated);
      return outcome;
    } catch (error) {
      await this.noteQuery(input.statement, verb, input.session, startedAt, Date.now() - startedMs, null, error);
      if (tracking) await this.noteFidelity(nodeId, approximated);
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
        // A refusal that is this stub's limit says so, instead of presenting
        // itself as a compile error in the client's SQL.
        errorCode: failure ? (failure.snowtestLimit ? 'SNOWTEST_LIMIT' : failure.code) : error ? 'SNOWTEST_INTERNAL' : null,
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

  /** Note this statement against the model that sent it, if one is named. */
  private async noteFidelity(nodeId: string | null, approximated: Approximation[]): Promise<void> {
    if (!nodeId) return;
    try {
      await this.engine.recordFidelity({
        nodeId,
        constructs: [...new Set(approximated.map((note) => note.feature))],
      });
    } catch (ledgerError) {
      process.stderr.write(`snowtest: model fidelity write failed: ${String(ledgerError)}\n`);
    }
  }
}

/** The `node_id` dbt stamps into each query comment, if this statement carries one. */
export function nodeIdOf(statement: string): string | null {
  const marker = '"node_id"';
  const at = statement.indexOf(marker);
  if (at === -1) return null;
  const rest = statement.slice(at + marker.length);
  const colon = rest.indexOf(':');
  if (colon === -1) return null;
  const quote = rest.indexOf('"', colon);
  if (quote === -1) return null;
  const end = rest.indexOf('"', quote + 1);
  if (end === -1) return null;
  const value = rest.slice(quote + 1, end).trim();
  return value.length > 0 ? value : null;
}
