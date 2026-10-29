// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * DuckDB types → Snowflake type metadata and row encoding.
 *
 * Two encodings are needed:
 *  - the SQL REST API v2 "jsonv2" shape (uppercase-ish type names, `fixed`,
 *    `real`, `text`, `timestamp_ntz` …)
 *  - the driver `rowtype` shape (lowercase, plus database/schema/table)
 *
 * Snowflake sends numbers and timestamps as JSON *strings*, and clients rely
 * on that (the Python connector runs `int()`/`Decimal()` on them). Sending real
 * JSON numbers mostly works but loses 38-digit precision, so we stringify.
 */

export interface SnowflakeColumn {
  name: string;
  /** Snowflake logical type, e.g. `fixed`, `text`, `timestamp_ntz`. */
  type: string;
  precision: number | null;
  scale: number | null;
  byteLength: number | null;
  length: number | null;
  nullable: boolean;
  database: string;
  schema: string;
  table: string;
}

const INTEGER_TYPES = new Set([
  'TINYINT',
  'SMALLINT',
  'INTEGER',
  'BIGINT',
  'HUGEINT',
  'UTINYINT',
  'USMALLINT',
  'UINTEGER',
  'UBIGINT',
  'UHUGEINT',
  'INT',
  'INT4',
  'INT8',
  'INT1',
  'INT2',
  'SHORT',
  'LONG',
  'SIGNED',
]);

/** Extract `(p, s)` from `DECIMAL(10,2)`, tolerating `DECIMAL(10, 2)`. */
function decimalSize(duckType: string): { precision: number; scale: number } | null {
  const match = /^DECIMAL\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/i.exec(duckType.trim());
  if (!match) return null;
  return { precision: Number(match[1]), scale: Number(match[2] ?? 0) };
}

/**
 * Map a DuckDB logical type name to Snowflake's type vocabulary plus the
 * precision/scale/length metadata clients use to decode values.
 */
export function toSnowflakeType(duckType: string): {
  type: string;
  precision: number | null;
  scale: number | null;
  byteLength: number | null;
  length: number | null;
} {
  const raw = duckType.trim();
  const upper = raw.toUpperCase();

  const decimal = decimalSize(upper);
  if (decimal) {
    return { type: 'fixed', precision: decimal.precision, scale: decimal.scale, byteLength: null, length: null };
  }

  const base = upper.replace(/\(.*$/, '').trim();

  if (INTEGER_TYPES.has(base)) {
    return { type: 'fixed', precision: 38, scale: 0, byteLength: null, length: null };
  }
  if (base === 'DOUBLE' || base === 'FLOAT' || base === 'REAL' || base === 'FLOAT4' || base === 'FLOAT8') {
    return { type: 'real', precision: null, scale: null, byteLength: null, length: null };
  }
  if (base === 'BOOLEAN' || base === 'BOOL' || base === 'LOGICAL') {
    return { type: 'boolean', precision: null, scale: null, byteLength: null, length: null };
  }
  if (upper === 'TIMESTAMP WITH TIME ZONE' || base === 'TIMESTAMPTZ' || base === 'TIMESTAMP_TZ') {
    return { type: 'timestamp_tz', precision: 0, scale: 9, byteLength: null, length: null };
  }
  if (base === 'TIMESTAMP' || base === 'DATETIME' || base === 'TIMESTAMP_S' || base === 'TIMESTAMP_MS' || base === 'TIMESTAMP_NS') {
    return { type: 'timestamp_ntz', precision: 0, scale: 9, byteLength: null, length: null };
  }
  if (base === 'DATE') {
    return { type: 'date', precision: null, scale: null, byteLength: null, length: null };
  }
  if (base === 'TIME' || base === 'TIME WITH TIME ZONE' || base === 'TIMETZ') {
    return { type: 'time', precision: 0, scale: 9, byteLength: null, length: null };
  }
  if (base === 'BLOB' || base === 'BYTEA' || base === 'BINARY' || base === 'VARBINARY') {
    return { type: 'binary', precision: null, scale: null, byteLength: 8388608, length: 8388608 };
  }
  if (base === 'JSON') {
    return { type: 'variant', precision: null, scale: null, byteLength: 16777216, length: 16777216 };
  }
  if (base === 'STRUCT' || base === 'UNION') {
    return { type: 'object', precision: null, scale: null, byteLength: 16777216, length: 16777216 };
  }
  if (base === 'MAP') {
    return { type: 'object', precision: null, scale: null, byteLength: 16777216, length: 16777216 };
  }
  if (base === 'LIST' || base === 'ARRAY' || raw.endsWith('[]')) {
    return { type: 'array', precision: null, scale: null, byteLength: 16777216, length: 16777216 };
  }
  if (base === 'BIT' || base === 'BITSTRING') {
    return { type: 'text', precision: null, scale: null, byteLength: null, length: 16777216 };
  }
  if (base === 'INTERVAL') {
    return { type: 'text', precision: null, scale: null, byteLength: null, length: 16777216 };
  }
  // VARCHAR, UUID, ENUM, anything else textual.
  return { type: 'text', precision: null, scale: null, byteLength: null, length: 16777216 };
}

/**
 * Render a DuckDB type the way Snowflake spells it in DDL/metadata output.
 * dbt and other tools parse these strings, so `INTEGER` would be unhelpful
 * where Snowflake says `NUMBER(38,0)`.
 */
export function toSnowflakeTypeName(duckType: string): string {
  const mapped = toSnowflakeType(duckType);
  switch (mapped.type) {
    case 'fixed':
      return mapped.scale && mapped.scale > 0
        ? `NUMBER(${mapped.precision},${mapped.scale})`
        : 'NUMBER(38,0)';
    case 'real':
      return 'FLOAT';
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'DATE';
    case 'time':
      return 'TIME(9)';
    case 'timestamp_ntz':
      return 'TIMESTAMP_NTZ(9)';
    case 'timestamp_ltz':
    case 'timestamp_tz':
      return 'TIMESTAMP_TZ(9)';
    case 'binary':
      return 'BINARY(8388608)';
    case 'variant':
      return 'VARIANT';
    case 'object':
      return 'OBJECT';
    case 'array':
      return 'ARRAY';
    default:
      return 'VARCHAR(16777216)';
  }
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

export function formatTimestamp(value: Date): string {
  return (
    `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())} ` +
    `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}.` +
    `${pad(value.getUTCMilliseconds(), 3)}000000`
  );
}

export function formatDate(value: Date): string {
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
}

export function formatTime(value: Date): string {
  return `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
}

/** Render a JS value the way Snowflake would put it on the wire. */
export function encodeValue(value: unknown, column: SnowflakeColumn): unknown {
  if (value === null || value === undefined) return null;

  switch (column.type) {
    case 'fixed': {
      if (typeof value === 'bigint') return value.toString();
      if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
      if (typeof value === 'string') return value;
      if (value instanceof Date) return String(value.getTime());
      return String(value);
    }
    case 'real': {
      if (typeof value === 'number') return String(value);
      return String(value);
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') return value.toLowerCase() === 'true';
      return Boolean(value);
    }
    case 'date': {
      if (value instanceof Date) return formatDate(value);
      return String(value);
    }
    case 'time': {
      if (value instanceof Date) return formatTime(value);
      return String(value);
    }
    case 'timestamp_ntz':
    case 'timestamp_ltz':
    case 'timestamp_tz': {
      if (value instanceof Date) return formatTimestamp(value);
      return String(value).replace('T', ' ').replace(/Z$/, '');
    }
    case 'binary': {
      if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
      if (Buffer.isBuffer(value)) return value.toString('hex');
      return String(value);
    }
    case 'variant':
    case 'object':
    case 'array': {
      if (typeof value === 'string') return value;
      return JSON.stringify(value);
    }
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

export function encodeRowset(rows: unknown[][], columns: SnowflakeColumn[]): unknown[][] {
  return rows.map((row) => row.map((value, index) => encodeValue(value, columns[index])));
}

/** Epoch seconds with 9 fractional digits, the JSON protocol's timestamp form. */
function epochSecondsString(value: Date): string {
  const milliseconds = value.getTime();
  const seconds = Math.floor(milliseconds / 1000);
  const nanos = Math.abs(milliseconds % 1000) * 1_000_000;
  return `${seconds}.${String(nanos).padStart(9, '0')}`;
}

/** Days since the Unix epoch, the JSON protocol's date form. */
function epochDaysString(value: Date): string {
  return String(Math.floor(value.getTime() / 86_400_000));
}

/** Fractional seconds since midnight, the JSON protocol's time form. */
function timeSecondsString(value: Date): string {
  const milliseconds =
    value.getUTCHours() * 3_600_000 +
    value.getUTCMinutes() * 60_000 +
    value.getUTCSeconds() * 1000 +
    value.getUTCMilliseconds();
  const seconds = Math.floor(milliseconds / 1000);
  const nanos = (milliseconds % 1000) * 1_000_000;
  return `${seconds}.${String(nanos).padStart(9, '0')}`;
}

function driverValue(value: unknown, column: SnowflakeColumn | undefined): unknown {
  if (value === null || value === undefined) return null;
  const type = column?.type ?? 'text';

  switch (type) {
    case 'fixed':
    case 'real':
      return typeof value === 'bigint' ? value.toString() : String(value);
    case 'boolean':
      // Snowflake sends booleans as the strings "TRUE"/"FALSE". The 4.x
      // connector decodes with `value in ("1", "TRUE")`, so lowercase text is
      // silently turned into False; 5.x requires a string too. Both are happy
      // with the upper-case form.
      if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
      return String(value).toLowerCase() === 'true' ? 'TRUE' : 'FALSE';
    case 'date':
      return value instanceof Date ? epochDaysString(value) : String(value);
    case 'time':
      return value instanceof Date ? timeSecondsString(value) : String(value);
    case 'timestamp_ntz':
      // NTZ is a bare fractional epoch; a formatted string is rejected.
      return value instanceof Date ? epochSecondsString(value) : String(value);
    case 'timestamp_ltz':
    case 'timestamp_tz': {
      // LTZ/TZ carry a display offset after the epoch (minutes east of UTC,
      // biased by one day, so UTC is 1440). The connector splits on the space
      // and fails the whole result set if the second part is missing.
      if (value instanceof Date) return `${epochSecondsString(value)} 1440`;
      return String(value);
    }
    case 'binary':
      if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
      if (Buffer.isBuffer(value)) return value.toString('hex');
      return String(value);
    case 'variant':
    case 'object':
    case 'array':
      return typeof value === 'string' ? value : JSON.stringify(value);
    default:
      return typeof value === 'object' && !(value instanceof Date)
        ? JSON.stringify(value)
        : String(value);
  }
}

/**
 * Encode a rowset for the driver protocol.
 *
 * The JSON result format is numeric: booleans are the strings "true"/"false",
 * timestamps are fractional epoch seconds, dates are epoch days and times are
 * fractional seconds since midnight. Clients format them using `rowtype`.
 */
export function toDriverRowset(rows: unknown[][], columns: SnowflakeColumn[]): unknown[][] {
  return rows.map((row) => row.map((value, index) => driverValue(value, columns[index])));
}

/** The SQL REST API v2 returns human-readable formatted values instead. */
export function toApiV2Rowset(rows: unknown[][], columns: SnowflakeColumn[]): unknown[][] {
  return rows.map((row) => row.map((value, index) => encodeValue(value, columns[index])));
}

/** Column metadata for the SQL REST API v2 `resultSetMetaData.rowType`. */
export function toApiV2RowType(columns: SnowflakeColumn[]): Array<Record<string, unknown>> {
  return columns.map((column) => ({
    name: column.name,
    database: column.database,
    schema: column.schema,
    table: column.table,
    type: column.type,
    length: column.length,
    byteLength: column.byteLength,
    precision: column.precision,
    scale: column.scale,
    nullable: column.nullable,
  }));
}

/** Column metadata for the driver `rowtype` (lowercase types, snake fields). */
export function toDriverRowType(columns: SnowflakeColumn[]): Array<Record<string, unknown>> {
  return columns.map((column) => ({
    name: column.name,
    type: column.type,
    length: column.length,
    byteLength: column.byteLength,
    precision: column.precision,
    scale: column.scale,
    nullable: column.nullable,
    database: column.database,
    schema: column.schema,
    table: column.table,
  }));
}
