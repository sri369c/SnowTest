// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * Snowflake-shaped errors.
 *
 * Snowflake reports failures as a numeric `code`, a five-character `sqlState`
 * and a vendor `message`. Clients branch on all three (dbt, for instance,
 * pattern-matches the message and state), so we never collapse them into a
 * bare HTTP 500.
 */

export type ErrorKind = 'compile' | 'runtime' | 'auth' | 'protocol';

export class SnowflakeError extends Error {
  readonly code: string;
  readonly sqlState: string;
  readonly kind: ErrorKind;

  constructor(code: string, message: string, sqlState = '42000', kind: ErrorKind = 'compile') {
    super(message);
    this.name = 'SnowflakeError';
    this.code = code;
    this.sqlState = sqlState;
    this.kind = kind;
  }

  /** The `{code, message, sqlState}` triple used by both the SQL API and the drivers. */
  toJSON(): { code: string; message: string; sqlState: string } {
    return { code: this.code, message: this.message, sqlState: this.sqlState };
  }
}

/** `002003` — SQL compilation error, Snowflake's catch-all for bad SQL. */
export function compilationError(message: string, sqlState = '42000'): SnowflakeError {
  return new SnowflakeError('002003', `SQL compilation error:\n${message}`, sqlState, 'compile');
}

/** `002043` — object does not exist or not authorized. */
export function objectNotFound(kind: string, name: string): SnowflakeError {
  return new SnowflakeError(
    '002003',
    `SQL compilation error:\nObject '${name}' does not exist or not authorized.`,
    kind.toUpperCase() === 'TABLE' ? '42S02' : '02000',
    'compile',
  );
}

/** `390100` — session expired, used to make clients reauthenticate. */
export function sessionExpired(): SnowflakeError {
  return new SnowflakeError('390111', 'Session no longer exists.', '08000', 'auth');
}

export function authError(message = 'Incorrect username or password was specified.'): SnowflakeError {
  return new SnowflakeError('390100', message, '28000', 'auth');
}

export function protocolError(message: string): SnowflakeError {
  return new SnowflakeError('000000', message, '08000', 'protocol');
}

/**
 * Translate a DuckDB failure into something a Snowflake client recognises.
 * We keep DuckDB's own wording (it is genuinely useful when debugging a test)
 * but attach the Snowflake code/state that clients actually branch on.
 */
export function mapEngineError(error: unknown): SnowflakeError {
  if (error instanceof SnowflakeError) return error;
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/^.*?Error:\s*/, (m) => m).trim();

  if (/Table with name .* does not exist|Table .* does not exist|does not exist/i.test(raw)) {
    return new SnowflakeError('002003', `SQL compilation error:\n${message}`, '42S02', 'compile');
  }
  if (/Referenced column .* not found|Column .* does not exist|Binder Error/i.test(raw)) {
    return new SnowflakeError('002003', `SQL compilation error:\n${message}`, '42S22', 'compile');
  }
  if (/Catalog Error/i.test(raw)) {
    return new SnowflakeError('002003', `SQL compilation error:\n${message}`, '3F000', 'compile');
  }
  if (/Conversion Error|Could not convert/i.test(raw)) {
    return new SnowflakeError('100038', `Numeric value is not recognized:\n${message}`, '22018', 'runtime');
  }
  if (/division by zero/i.test(raw)) {
    return new SnowflakeError('100051', `Division by zero:\n${message}`, '22012', 'runtime');
  }
  if (/Parser Error|syntax error/i.test(raw)) {
    return new SnowflakeError('001003', `SQL syntax error:\n${message}`, '42000', 'compile');
  }
  return new SnowflakeError('000000', message, '42000', 'runtime');
}
