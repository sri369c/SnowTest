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

  /**
   * Set when the refusal is a limit of this stub rather than a mistake in the
   * client SQL. The caller can then say "snowtest cannot answer that" instead of
   * handing over a compile error that accuses the query.
   */
  snowtestLimit: string | null = null;

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

/** `002003` — object does not exist or not authorized; `USE` reports Snowflake's nameless `002043`. */
export function objectNotFound(kind: string, name: string, code: '002003' | '002043' = '002003'): SnowflakeError {
  return new SnowflakeError(
    code,
    code === '002043'
      ? 'SQL compilation error:\nObject does not exist, or operation cannot be performed.'
      : `SQL compilation error:\nObject '${name}' does not exist or not authorized.`,
    kind.toUpperCase() === 'TABLE' ? '42S02' : '02000',
    'compile',
  );
}

/** Snowflake syntax snowtest recognises but cannot emulate faithfully. */
export function unsupported(feature: string): SnowflakeError {
  const error = new SnowflakeError(
    '002003',
    `SQL compilation error:
${feature} is not supported on snowtest.`,
    '0A000',
    'compile',
  );
  error.snowtestLimit = feature;
  return error;
}

/** `090105` / `090106` — an unqualified name with no current database / schema. */
export function noCurrentContext(scope: 'database' | 'schema', operation: string): SnowflakeError {
  return new SnowflakeError(
    scope === 'database' ? '090105' : '090106',
    `Cannot perform ${operation}. This session does not have a current ${scope}. ` +
      `Call 'USE ${scope.toUpperCase()}', or use a qualified name.`,
    '22000',
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

/**
 * `390201` — login asked for a database/schema/warehouse that does not exist
 * (connector `validate_default_parameters=True`). Code and message as reported by
 * Snowflake, e.g. https://github.com/snowflakedb/gosnowflake/issues/640 and
 * https://github.com/snowflakedb/terraform-provider-snowflake/issues/1099. The
 * server-side sqlState is unverified: 08004 is what gosnowflake reports (.NET says 08006).
 */
export function loginObjectNotFound(kind: 'database' | 'schema' | 'warehouse'): SnowflakeError {
  return new SnowflakeError('390201', `The requested ${kind} does not exist or not authorized.`, '08004', 'auth');
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

  if (/NOT NULL constraint failed/i.test(raw)) {
    return new SnowflakeError('100072', `NULL result in a non-nullable column:\n${message}`, '22000', 'runtime');
  }
  if (/Table with name .* does not exist|Table .* does not exist|does not exist/i.test(raw)) {
    return new SnowflakeError('002003', `SQL compilation error:\n${message}`, '42S02', 'compile');
  }
  if (/Referenced column .* not found|Column .* does not exist|Binder Error/i.test(raw)) {
    return new SnowflakeError('002003', `SQL compilation error:\n${message}`, '42S22', 'compile');
  }
  if (/Catalog Error/i.test(raw)) {
    return new SnowflakeError('002003', `SQL compilation error:\n${message}`, '3F000', 'compile');
  }
  // e.g. DROP SCHEMA … RESTRICT on a schema that still holds objects.
  if (/Dependency Error/i.test(raw)) {
    return compilationError(message.replace(/^Dependency Error:\s*/i, ''), '2BP01');
  }
  // Snowflake's date/time codes (100040 date, 100035 timestamp, ...) are unverified here; 22007 is the SQL standard state.
  // DuckDB casts: "invalid date field format", "time field value out of range", ...
  if (/Conversion Error: (?:invalid )?(?:date|time|timestamp)\w* field/i.test(raw)) {
    return new SnowflakeError('100038', `Date/time value is not recognized:\n${message}`, '22007', 'runtime');
  }
  if (/Conversion Error: Malformed JSON/i.test(raw)) {
    return new SnowflakeError('100069', `Error parsing JSON: ${message.replace(/^Conversion Error:\s*/i, '')}`, '22P02', 'runtime');
  }
  if (/Conversion Error|Could not convert/i.test(raw)) {
    return new SnowflakeError('100038', `Numeric value is not recognized:\n${message}`, '22018', 'runtime');
  }
  // strptime: TIME casts (dialect.ts timeCast) and TO_DATE/TO_TIMESTAMP with a format.
  if (/Could not parse string .* according to format specifier/i.test(raw)) {
    return new SnowflakeError('100038', `Date/time value is not recognized:\n${message}`, '22007', 'runtime');
  }
  // The CHECK dialect.ts puts on CREATE TABLE TIME columns.
  if (/CHECK constraint failed .*"hour"\(/i.test(raw)) {
    return new SnowflakeError('100038', `Time value is out of range [00:00:00, 24:00:00):\n${message}`, '22007', 'runtime');
  }
  if (/division by zero/i.test(raw)) {
    return new SnowflakeError('100051', `Division by zero:\n${message}`, '22012', 'runtime');
  }
  if (/Parser Error|syntax error/i.test(raw)) {
    return new SnowflakeError('001003', `SQL syntax error:\n${message}`, '42000', 'compile');
  }
  return new SnowflakeError('000000', message, '42000', 'runtime');
}
