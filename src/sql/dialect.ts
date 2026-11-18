// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * Snowflake dialect → DuckDB translation.
 *
 * DuckDB already speaks a large subset of Snowflake SQL, so this layer is
 * deliberately narrow: it covers the constructs that appear in real Snowflake
 * queries (variant paths, NVL/IFF/DIV0, TO_* casts, DATEADD/DATEDIFF, LISTAGG,
 * Snowflake DDL decorations, `NUMBER`/`VARIANT` column types) and leaves
 * everything else alone.
 *
 * Anything this layer cannot translate is emitted unchanged, so the failure
 * surfaces as an honest DuckDB syntax error through `mapEngineError` rather
 * than as silently wrong data. Recognised syntax that cannot be emulated
 * faithfully (an unknown format element, say) raises `unsupported()`.
 */

import { normalizeName, type DatabaseDef } from '../engine/catalog.js';
import { compilationError, noCurrentContext, unsupported } from './errors.js';

export interface RewriteContext {
  /** null when the session has no current database/schema. */
  database: string | null;
  schema: string | null;
  role: string;
  user: string;
  warehouse: string;
  account?: string;
  version?: string;
  /** Account databases, for `information_schema.databases`. */
  databases?: ReadonlyArray<Pick<DatabaseDef, 'name' | 'comment' | 'createdAt'>>;
  /** Translate `col:field` variant paths into `json_extract`. */
  variantPaths?: boolean;
  /** `SNOWTEST_CLOCK`: the millisecond instant the clock reports, instead of the host clock. */
  clockMs?: number;
}

/**
 * One place a translation substitutes an approximation of Snowflake for
 * Snowflake. Only genuine divergences are reported: `IFF` as `CASE`, `NVL2`,
 * `ZEROIFNULL`, `DIV0` and `QUALIFY` (which DuckDB answers itself) are faithful,
 * and warning about those would teach a reader to ignore the warnings that matter.
 */
export type Approximation = { feature: string; detail: string };

/** Collects approximations while one statement is translated. */
export type ApproximationSink = (approximation: Approximation) => void;

/** Placeholder marker for text we must not touch (string literals, comments). */
const MARK = '\u0001';
/** Placeholder marker for double-quoted identifiers. */
const IDENT = '\u0002';
const MARKED = /([\u0001\u0002])(\d+)\1/g;

function pushOpaque(parts: string[], value: string, marker = MARK): string {
  parts.push(value);
  return `${marker}${parts.length - 1}${marker}`;
}

/** One Snowflake backslash escape at `sql[at]`; returns the character and the width consumed. */
function readEscape(sql: string, at: number): [string, number] {
  const rest = sql.slice(at + 1);
  let decoded: string;
  let width: number;
  const octal = /^[0-7]{3}/.exec(rest);
  const hex = /^x([0-9A-Fa-f]{2})/.exec(rest);
  const unicode = /^u([0-9A-Fa-f]{4})/.exec(rest);
  if (octal) [decoded, width] = [String.fromCharCode(Number.parseInt(octal[0], 8)), 4];
  else if (hex) [decoded, width] = [String.fromCharCode(Number.parseInt(hex[1], 16)), 4];
  else if (unicode) [decoded, width] = [String.fromCharCode(Number.parseInt(unicode[1], 16)), 6];
  else {
    const simple: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', 0: '\0' };
    [decoded, width] = [simple[rest[0]] ?? rest[0], 2];
  }
  // DuckDB's parser ends a query at a raw NUL.
  if (decoded === '\0') throw unsupported('A NUL character in a string literal');
  return [decoded, width];
}

/**
 * Replace string literals and comments with opaque markers so the rewrite
 * rules never fire inside them. With `decode`, a literal is stored as the
 * DuckDB literal of its Snowflake value (backslash escapes applied).
 */
function maskNonCode(sql: string, parts: string[], decode = false): string {
  let out = '';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === "'") {
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < sql.length) {
        if (sql[j] === '\\' && j + 1 < sql.length) {
          const [decoded, width] = readEscape(sql, j);
          value += decoded;
          j += width;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            value += "'";
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        value += sql[j];
        j += 1;
      }
      // An unterminated literal goes through verbatim, for DuckDB to reject.
      out += pushOpaque(parts, decode && closed ? `'${value.replace(/'/g, "''")}'` : sql.slice(i, j));
      i = j;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      let text = '"';
      while (j < sql.length) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            text += '""';
            j += 2;
            continue;
          }
          text += '"';
          j += 1;
          break;
        }
        text += sql[j];
        j += 1;
      }
      out += text;
      i = j;
      continue;
    }

    if (ch === '$' && sql[i + 1] === '$') {
      const end = sql.indexOf('$$', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += pushOpaque(parts, sql.slice(i, stop));
      i = stop;
      continue;
    }

    if (ch === '-' && sql[i + 1] === '-') {
      let j = sql.indexOf('\n', i);
      if (j === -1) j = sql.length;
      out += pushOpaque(parts, sql.slice(i, j));
      i = j;
      continue;
    }

    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += pushOpaque(parts, sql.slice(i, stop));
      i = stop;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

function unmask(sql: string, parts: string[]): string {
  return sql.replace(MARKED, (_m, _marker: string, idx: string) => parts[Number(idx)] ?? '');
}

/** Resolve opaque markers inside a fragment back to their original text. */
function resolve(arg: string, parts: string[]): string {
  return unmask(arg, parts);
}

/** Mask double-quoted identifiers so name-based rules (types, clocks, session values) skip them. */
function maskIdentifiers(sql: string, parts: string[]): string {
  return sql.replace(/"(?:[^"]|"")*"/g, (identifier) => pushOpaque(parts, identifier, IDENT));
}

function matchParen(sql: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on top-level commas, respecting nested parens and brackets. */
export function splitTopLevel(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0 || out.length > 0) out.push(current.trim());
  return out;
}

function stripQuotes(text: string): string {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Rewrite every call to `name` using `builder`. The builder receives the raw
 * argument fragments (still masked) and the parts table for resolving
 * literals; returning `null` leaves the call untouched.
 */
function replaceCall(
  sql: string,
  name: string,
  parts: string[],
  builder: (args: string[], resolveArg: (a: string) => string) => string | null,
): string {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${name}\\s*\\(`, 'gi');
  let result = sql;

  for (let guard = 0; guard < 200; guard += 1) {
    pattern.lastIndex = 0;
    const match = pattern.exec(result);
    if (!match) break;

    const openIndex = match.index + match[0].length - 1;
    const closeIndex = matchParen(result, openIndex);
    if (closeIndex === -1) break;

    const args = splitTopLevel(result.slice(openIndex + 1, closeIndex));
    const replacement = builder(args, (a) => resolve(a, parts));
    if (replacement === null) {
      // Skip this occurrence by moving the search window past it.
      const consumed = openIndex + 1;
      const rest = replaceCall(result.slice(consumed), name, parts, builder);
      return result.slice(0, consumed) + rest;
    }

    result = result.slice(0, match.index) + match[1] + replacement + result.slice(closeIndex + 1);
  }

  return result;
}

const INTERVAL_UNITS = new Set([
  'year',
  'quarter',
  'month',
  'week',
  'day',
  'hour',
  'minute',
  'second',
  'millisecond',
  'microsecond',
  'nanosecond',
  'yearofweek',
  'dayofweek',
  'dayofyear',
]);

function normalizeUnit(raw: string): string {
  const unit = stripQuotes(raw).toLowerCase();
  if (unit === 'days') return 'day';
  if (unit === 'hours') return 'hour';
  if (unit === 'minutes') return 'minute';
  if (unit === 'seconds') return 'second';
  if (unit === 'months') return 'month';
  if (unit === 'years') return 'year';
  if (unit === 'weeks') return 'week';
  return unit;
}

function intervalUnit(unit: string): string | null {
  switch (unit) {
    case 'year':
    case 'quarter':
    case 'month':
    case 'week':
    case 'day':
    case 'hour':
    case 'minute':
    case 'second':
    case 'millisecond':
    case 'microsecond':
    case 'nanosecond':
      return unit.toUpperCase();
    default:
      return null;
  }
}

/** `name(args) [WITHIN GROUP (ORDER BY ...)] [OVER (...)]`, re-rendered with the ordering and window clause. */
function rewriteOrderedAggregate(
  sql: string,
  name: string,
  build: (args: string[]) => string[] | null,
  render: (args: string[], order: string, over: string) => string,
): string {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${name}\\s*\\(`, 'i');
  let out = '';
  let rest = sql;
  for (;;) {
    const match = pattern.exec(rest);
    if (!match) return out + rest;
    const open = match.index + match[0].length - 1;
    const close = matchParen(rest, open);
    if (close === -1) return out + rest;

    const args = build(
      splitTopLevel(rest.slice(open + 1, close)).map((arg) =>
        rewriteOrderedAggregate(arg, name, build, render),
      ),
    );
    if (args === null) {
      out += rest.slice(0, open + 1);
      rest = rest.slice(open + 1);
      continue;
    }

    let end = close + 1;
    let order = '';
    const within = /^\s*WITHIN\s+GROUP\s*\(/i.exec(rest.slice(end));
    if (within) {
      const withinOpen = end + within[0].length - 1;
      const withinClose = matchParen(rest, withinOpen);
      if (withinClose === -1) return out + rest;
      order = ` ${rest.slice(withinOpen + 1, withinClose).trim()}`;
      end = withinClose + 1;
    }
    let over = '';
    const window = /^\s*OVER\s*\(/i.exec(rest.slice(end));
    if (window) {
      const overClose = matchParen(rest, end + window[0].length - 1);
      if (overClose === -1) return out + rest;
      over = ` ${rest.slice(end, overClose + 1).trim()}`;
      end = overClose + 1;
    }

    out += `${rest.slice(0, match.index)}${match[1]}${render(args, order, over)}`;
    rest = rest.slice(end);
  }
}

const SIMPLE_RENAMES: Array<[RegExp, string]> = [
  [/\bNVL\s*\(/gi, 'COALESCE('],
  [/\bBOOLOR_AGG\s*\(/gi, 'BOOL_OR('],
  [/\bBOOLAND_AGG\s*\(/gi, 'BOOL_AND('],
  [/\bLEAST\s*\(/gi, 'LEAST('],
  [/\bGETDATE\s*\(/gi, 'NOW('],
];

/** Remove every `CLUSTER BY (...)`, nested parentheses included. */
function stripClusterBy(sql: string): string {
  let out = sql;
  for (;;) {
    const match = /\bCLUSTER\s+BY\s*\(/i.exec(out);
    if (!match) return out;
    const close = matchParen(out, match.index + match[0].length - 1);
    if (close === -1) return out;
    out = out.slice(0, match.index) + out.slice(close + 1);
  }
}

function ddlDecorations(sql: string): string {
  let out = sql;
  out = out.replace(/\bCREATE\s+OR\s+REPLACE\s+(TRANSIENT|TEMPORARY|VOLATILE)\s+/gi, 'CREATE OR REPLACE ');
  out = out.replace(/\bCREATE\s+(TRANSIENT|VOLATILE)\s+/gi, 'CREATE ');
  out = stripClusterBy(out);
  out = out.replace(/\bCOPY\s+GRANTS\b/gi, '');
  out = out.replace(/\bDATA_RETENTION_TIME_IN_DAYS\s*=\s*\d+\s*/gi, '');
  out = out.replace(/\bCHANGE_TRACKING\s*=\s*(TRUE|FALSE)\s*/gi, '');
  out = out.replace(/\bENABLE_SCHEMA_EVOLUTION\s*=\s*(TRUE|FALSE)\s*/gi, '');
  return out;
}

/**
 * Fold unquoted identifiers (and keywords, harmlessly) to upper case as Snowflake does.
 * DuckDB reports names as stored, so this is what makes `select a` return `A`.
 */
function foldUnquoted(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === MARK || ch === IDENT) {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch && ch !== MARK && ch !== IDENT && sql[j + 1] === ch) {
          j += 2;
          continue;
        }
        if (sql[j] === ch) break;
        j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*|^[0-9][A-Za-z0-9_.]*/.exec(sql.slice(i, i + 256));
    if (word) {
      const folded = /^[0-9]/.test(word[0]) ? word[0] : word[0].toUpperCase();
      // Type positions already became BLOB; a bare BINARY left is a column, which DuckDB only takes quoted.
      out += folded === 'BINARY' ? '"BINARY"' : folded;
      i += word[0].length;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Qualify bare column names in a MERGE's `insert ... values (...)` list.
 *
 * Snowflake resolves an unqualified value in that position against the source
 * table, and dbt emits exactly that (`values ("order_id", ...)`). DuckDB calls
 * it an ambiguous reference because both sides are in scope, so qualify it with
 * the source alias explicitly.
 */
function qualifyMergeInsertValues(sql: string): string {
  if (!/^\s*merge\s+into\b/i.test(sql)) return sql;

  const alias = /\busing\b[\s\S]*?\bas\s+([A-Za-z_][\w$]*)/i.exec(sql)?.[1];
  if (!alias) return sql;

  const KEYWORDS = new Set(['NULL', 'TRUE', 'FALSE', 'DEFAULT', 'CURRENT_TIMESTAMP', 'CURRENT_DATE']);

  return sql.replace(
    /\b(insert\s*\()([^)]*)(\)\s*values\s*\()([^)]*)(\))/gi,
    (_match, head: string, columns: string, middle: string, values: string, tail: string) => {
      const qualified = splitTopLevel(values)
        .map((value) => {
          const trimmed = value.trim();
          if (/^[A-Za-z_][\w$]*$/.test(trimmed) && !KEYWORDS.has(trimmed.toUpperCase())) {
            return `${alias}.${trimmed}`;
          }
          if (/^\u0002\d+\u0002$/.test(trimmed)) return `${alias}.${trimmed}`;
          return trimmed;
        })
        .join(', ');
      return head + columns + middle + qualified + tail;
    },
  );
}

const SNOWFLAKE_DATA_TYPE = `CASE
  WHEN data_type LIKE 'DECIMAL%' OR data_type IN ('TINYINT','SMALLINT','INTEGER','BIGINT','HUGEINT') THEN 'NUMBER'
  WHEN data_type IN ('DOUBLE','FLOAT','REAL') THEN 'FLOAT'
  WHEN data_type = 'TIMESTAMP WITH TIME ZONE' THEN 'TIMESTAMP_TZ'
  WHEN data_type LIKE 'TIMESTAMP%' THEN 'TIMESTAMP_NTZ'
  WHEN data_type = 'JSON' THEN 'VARIANT'
  WHEN data_type = 'BLOB' THEN 'BINARY'
  WHEN data_type IN ('BOOLEAN','DATE','TIME') THEN data_type
  ELSE 'TEXT' END`;

/** Snowflake-only `information_schema.tables` columns read by dbt docs and schema browsers. */
const SNOWFLAKE_TABLE_COLUMNS =
  `table_comment AS comment, NULL::VARCHAR AS table_owner, NULL::VARCHAR AS clustering_key, ` +
  `NULL::BIGINT AS row_count, NULL::BIGINT AS bytes, NULL::TIMESTAMPTZ AS created, ` +
  `NULL::TIMESTAMPTZ AS last_altered, 'NO' AS is_transient, 'NO' AS is_dynamic, 'NO' AS is_iceberg`;

/** `information_schema.databases`: account-wide, values as in SHOW DATABASES, Snowflake's upper-case column names. */
function databasesView(databases: RewriteContext['databases']): string {
  // A rewrite without a catalog wired in still answers: the account has no
  // databases, rather than failing the statement outright.
  const account = databases ?? [];
  const row = (name: string, comment: string, created: string) =>
    `SELECT ${name}::VARCHAR AS DATABASE_NAME, 'SYSADMIN' AS DATABASE_OWNER, 'NO' AS IS_TRANSIENT, ` +
    `${comment}::VARCHAR AS COMMENT, ${created}::TIMESTAMPTZ AS CREATED, NULL::TIMESTAMPTZ AS LAST_ALTERED, ` +
    `1 AS RETENTION_TIME, 'STANDARD' AS TYPE`;
  if (account.length === 0) return `${row('NULL', 'NULL', 'NULL')} WHERE FALSE`;
  return account
    .map((db) => row(toSqlLiteral(db.name), toSqlLiteral(db.comment), toSqlLiteral(db.createdAt)))
    .join(' UNION ALL ');
}

/**
 * `[DB.]information_schema.<view>` → DuckDB's global information_schema filtered
 * to DB (the session database when unqualified, as in Snowflake): DuckDB only
 * exposes information_schema in its system catalog. `databases` is built from the catalog.
 * Generated text is masked so later rewrite rules leave it alone.
 */
function databaseInformationSchema(
  sql: string,
  ctx: RewriteContext,
  literal: (value: string) => string,
): string {
  return sql.replace(
    /(?<![\w$".])(?:("[^"]+"|[A-Za-z_][\w$]*)\s*\.\s*)?(?:information_schema|"INFORMATION_SCHEMA")\s*\.\s*(columns|tables|views|schemata|databases)\b/gi,
    (_match, database: string | undefined, view: string) => {
      const name = view.toLowerCase();
      const target = database ? normalizeName(database) : ctx.database;
      if (target === null) throw noCurrentContext('database', 'SELECT');
      const catalog = toSqlLiteral(target);
      const body =
        name === 'databases'
          ? databasesView(ctx.databases)
          : name === 'schemata'
          ? `SELECT * FROM information_schema.schemata WHERE catalog_name = ${catalog}`
          : name === 'columns'
            ? `SELECT * REPLACE (${SNOWFLAKE_DATA_TYPE} AS data_type), column_comment AS comment, ` +
              `NULL::VARCHAR AS identity_ordered, NULL::VARCHAR AS data_type_alias ` +
              `FROM information_schema.columns WHERE table_catalog = ${catalog}`
            : name === 'tables'
              ? `SELECT *, ${SNOWFLAKE_TABLE_COLUMNS} ` +
                `FROM information_schema.tables WHERE table_catalog = ${catalog}`
              : `SELECT * FROM information_schema.${name} WHERE table_catalog = ${catalog}`;
      return literal(`(${body})`);
    },
  );
}

/** A Snowflake type and optional `(p[, s])` → DuckDB's spelling; unknown names unchanged. */
function duckType(name: string, args = ''): string {
  const params = args.replace(/\s+/g, '');
  switch (name.toUpperCase()) {
    case 'NUMBER': {
      if (!params) return 'DECIMAL(38,0)';
      const [precision, scale = '0'] = params.slice(1, -1).split(',');
      return `DECIMAL(${precision},${scale})`;
    }
    // Snowflake DECIMAL/NUMERIC without precision is NUMBER(38,0); DuckDB's is (18,3).
    case 'DECIMAL':
    case 'NUMERIC':
      return params ? `${name}${args}` : 'DECIMAL(38,0)';
    case 'VARCHAR':
      return params === '(16777216)' ? 'VARCHAR' : `${name}${args}`;
    case 'STRING':
    case 'TEXT':
      return `VARCHAR${args}`;
    case 'TIMESTAMP':
    case 'DATETIME':
    case 'TIMESTAMP_NTZ': {
      // TIMESTAMP(9) is DuckDB's TIMESTAMP_NS; 7 and 8 would keep 9 digits.
      const digits = fractionDigits(name, params);
      if (digits === 7 || digits === 8) throw unsupported(`${name.toUpperCase()}(${digits})`);
      return storedType(digits === 9 ? 'TIMESTAMP(9)' : 'TIMESTAMP', name, params);
    }
    case 'TIMESTAMP_LTZ':
    case 'TIMESTAMP_TZ':
      return storedType('TIMESTAMPTZ', name, params);
    case 'BINARY':
      return 'BLOB';
    case 'VARIANT':
    case 'OBJECT':
    case 'ARRAY':
      return 'JSON';
    case 'FLOAT':
      return 'DOUBLE';
    case 'TIME':
      return storedType('TIME', name, params);
    default:
      return `${name}${args}`;
  }
}

/** `(n)` fractional-second digits of a date/time type; null when not given. */
function fractionDigits(name: string, params: string): number | null {
  if (!params) return null;
  const digits = /^\((\d)\)$/.exec(params);
  if (!digits) throw compilationError(`${name.toUpperCase()}${params}: precision must be between 0 and 9.`);
  return Number(digits[1]);
}

/**
 * Only column types get here below 6 digits (casts go through `precisionCast`). DuckDB TIME / TIMESTAMPTZ take
 * no precision and TIMESTAMP(0|3) rounds on write, so such a column is refused rather than kept wrong.
 */
function storedType(duck: string, name: string, params: string): string {
  const digits = fractionDigits(name, params);
  if (digits !== null && digits < 6) {
    throw unsupported(`A ${name.toUpperCase()}(${digits}) column (fewer than 6 fractional digits; casts work)`);
  }
  return duck;
}

const TYPE = String.raw`([A-Za-z_][A-Za-z0-9_]*)(\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\))?`;
const NAME_PART = String.raw`(?:\u0002\d+\u0002|[A-Za-z_][\w$]*)`;
const TABLE_REF = String.raw`${NAME_PART}(?:\s*\.\s*${NAME_PART})*`;

type Literal = (value: string) => string;

/**
 * Snowflake `[TRY_]CAST(value AS TIME)`. DuckDB has no TIMESTAMPTZ → TIME cast, so every source goes via
 * TIMETZ (wall clock); strptime then enforces [00:00, 24:00), which TIME parsing misses ('24:00:00') and
 * TIMETZ parsing skips ('25:00'). The emitted TIME is masked so the cast rules do not see it again.
 */
function timeCast(value: string, tryCast: boolean, literal: Literal, digits: number): string {
  const time = literal('TIME');
  let wallClock = `CAST(CAST(${tryCast ? 'TRY_CAST' : 'CAST'}(${value} AS TIMETZ) AS ${time}) AS VARCHAR)`;
  // The text is 'HH:MM:SS[.ffffff]': cutting it truncates to TIME(digits).
  if (digits < 6) wallClock = `left(${wallClock}, ${digits === 0 ? 8 : 9 + digits})`;
  const formats = literal("['%H:%M:%S.%f', '%H:%M:%S']");
  return `CAST(${tryCast ? 'try_strptime' : 'strptime'}(${wallClock}, ${formats}) AS ${time})`;
}

/** Snowflake timestamp types whose casts below 6 digits are truncated with date_trunc, by DuckDB type. */
const TIMESTAMP_TYPES = new Map([
  ['TIMESTAMP', 'TIMESTAMP'],
  ['DATETIME', 'TIMESTAMP'],
  ['TIMESTAMP_NTZ', 'TIMESTAMP'],
  ['TIMESTAMP_LTZ', 'TIMESTAMPTZ'],
  ['TIMESTAMP_TZ', 'TIMESTAMPTZ'],
]);

/**
 * `[TRY_]CAST(operand AS name args)` for TIME(n) and timestamps below 6 digits (DuckDB's TIMESTAMP(0|3)
 * rounds; Snowflake truncates); null for every other type. `operand` is only read when a rewrite is due.
 */
function precisionCast(name: string, args: string | undefined, operand: () => string, tryCast: boolean, literal: Literal): string | null {
  const type = name.toUpperCase();
  const duck = TIMESTAMP_TYPES.get(type);
  if (type !== 'TIME' && duck === undefined) return null;
  const digits = fractionDigits(type, (args ?? '').replace(/\s+/g, ''));
  if (type === 'TIME') return timeCast(operand(), tryCast, literal, digits ?? 9);
  if (digits === null || digits >= 6) return null;
  if (digits !== 0 && digits !== 3) throw unsupported(`${type}(${digits})`);
  const unit = literal(digits === 0 ? "'second'" : "'millisecond'");
  return `date_trunc(${unit}, ${tryCast ? 'TRY_CAST' : 'CAST'}(${operand()} AS ${duck}))`;
}

/** Index of the bracket opening the one closed at `close`. */
function matchOpen(sql: string, close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i -= 1) {
    if (sql[i] === ')' || sql[i] === ']') depth += 1;
    else if (sql[i] === '(' || sql[i] === '[') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Keywords that may sit right before `(` without being a function name. */
const NOT_A_CALL = new Set([
  'SELECT', 'DISTINCT', 'ALL', 'FROM', 'JOIN', 'USING', 'WHERE', 'AND', 'OR', 'NOT', 'ON', 'CASE', 'WHEN', 'THEN',
  'ELSE', 'IN', 'IS', 'LIKE', 'ILIKE', 'BETWEEN', 'AS', 'BY', 'HAVING', 'EXISTS', 'VALUES', 'UNION', 'INTERSECT',
  'EXCEPT', 'MINUS', 'RETURN',
]);
/** Snowflake reserved words (bar NULL/TRUE/FALSE): never a variant source, so `LIMIT :n` is a named bind. */
const RESERVED = new Set([
  'ALL', 'ALTER', 'AND', 'ANY', 'AS', 'BETWEEN', 'BY', 'CASE', 'CAST', 'CHECK', 'COLUMN', 'CONNECT', 'CONSTRAINT',
  'CREATE', 'CROSS', 'CURRENT', 'DELETE', 'DISTINCT', 'DROP', 'ELSE', 'EXISTS', 'FOLLOWING', 'FOR', 'FROM', 'FULL',
  'GRANT', 'GROUP', 'HAVING', 'ILIKE', 'IN', 'INCREMENT', 'INNER', 'INSERT', 'INTERSECT', 'INTO', 'IS', 'JOIN',
  'LATERAL', 'LEFT', 'LIKE', 'LIMIT', 'MINUS', 'NATURAL', 'NOT', 'OF', 'ON', 'OR', 'ORDER', 'QUALIFY', 'REGEXP',
  'REVOKE', 'RIGHT', 'RLIKE', 'ROW', 'ROWS', 'SAMPLE', 'SELECT', 'SET', 'SOME', 'START', 'TABLE', 'TABLESAMPLE',
  'THEN', 'TO', 'TRIGGER', 'TRY_CAST', 'UNION', 'UNIQUE', 'UPDATE', 'USING', 'VALUES', 'WHEN', 'WHENEVER', 'WHERE',
  'WITH',
]);
/** `f(x) OVER (…)`, `f(x) FILTER (…)`, `f(x) WITHIN GROUP (…)`: the clause belongs to the call. */
const CALL_CLAUSE = /\)\s*(?:OVER|FILTER|WITHIN\s+GROUP)\s*$/i;
/** `TIMESTAMP '…'` is one literal. */
const TYPED_LITERAL = /(?<![\w$.])(?:DATE|TIME|TIMESTAMP(?:_NTZ|_LTZ|_TZ)?)\s*$/i;

/** Start of the primary expression ending at `end`: literal, name, call, parentheses, subscript or CASE … END. */
function primaryStart(sql: string, end: number): number {
  const ch = sql[end - 1];
  if (ch === MARK || ch === IDENT) {
    const start = sql.lastIndexOf(ch, end - 2);
    const typed = ch === MARK ? TYPED_LITERAL.exec(sql.slice(0, start)) : null;
    return typed ? typed.index : start;
  }
  if (ch === ')' || ch === ']') {
    const open = matchOpen(sql, end - 1);
    if (open <= 0) return open;
    if (sql[open] === '[' && /[\w$)\]\u0001\u0002]/.test(sql[open - 1])) return primaryStart(sql, open);
    const head = sql.slice(0, open).trimEnd();
    const clause = CALL_CLAUSE.exec(head);
    if (clause) return primaryStart(sql, clause.index + 1);
    if (head.endsWith(IDENT)) return primaryStart(sql, head.length);
    const name = /[A-Za-z_][\w$]*$/.exec(head);
    return name && !NOT_A_CALL.has(name[0].toUpperCase()) ? name.index : open;
  }
  const word = /[\w$]+$/.exec(sql.slice(0, end))?.[0];
  if (!word) return -1;
  const start = end - word.length;
  if (word.toUpperCase() !== 'END') return start;
  let depth = 0;
  for (const keyword of [...sql.slice(0, end).matchAll(/\b(?:CASE|END)\b/gi)].reverse()) {
    depth += keyword[0].toUpperCase() === 'END' ? 1 : -1;
    if (depth === 0) return keyword.index;
  }
  return -1;
}

/** Start of the operand of a postfix `::` cast at `end`: `a.b` chains, earlier casts and `v:path` steps included. */
function castOperandStart(sql: string, end: number): number {
  let i = sql.slice(0, end).trimEnd().length;
  for (;;) {
    i = primaryStart(sql, i);
    if (i <= 0) return i;
    if (sql[i - 1] === '.') {
      i -= 1;
      continue;
    }
    const before = sql.slice(0, i).trimEnd();
    if (!before.endsWith(':')) return i;
    i = before.slice(0, before.endsWith('::') ? -2 : -1).trimEnd().length;
  }
}

const KEY = String.raw`(?:\u0002\d+\u0002|[A-Za-z_][\w$]*)`;

/** JSON path of a variant step (`a.b[0]`, `"Quoted Key"`); keys keep their case. */
function jsonPath(step: string, parts: string[]): string {
  return `$${step.replace(/\[\d+\]|\.?(?:\u0002(\d+)\u0002|([A-Za-z_][\w$]*))/g, (token, ident?: string, name?: string) => {
    if (name) return `.${name}`;
    if (!ident) return token;
    const key = parts[Number(ident)].slice(1, -1).replace(/""/g, '"');
    if (key.includes('"')) throw unsupported('A variant key containing a double quote');
    return `."${key}"`;
  })}`;
}

/** `src:path` → `json_extract(src, '$.path')`; `src` is a name, quoted name or call (not a string: `{'k': v}`). */
function variantPaths(sql: string, parts: string[], literal: Literal, approximations?: ApproximationSink): string {
  const step = new RegExp(String.raw`(?<!:)\s*:\s*(${KEY}(?:\.${KEY}|\[\d+\])*)`, 'g');
  let out = sql;
  for (let match = step.exec(out); match; match = step.exec(out)) {
    const end = match.index;
    let start = out[end - 1] === MARK ? -1 : primaryStart(out, end);
    if (start >= 0 && out[start - 1] !== '.' && RESERVED.has(out.slice(start, end).toUpperCase())) {
      throw unsupported(`Named bind variable ':${unmask(match[1], parts)}' (bind with ? or %s)`);
    }
    while (start > 0 && out[start - 1] === '.') start = primaryStart(out, start - 1);
    if (start > 0 && /::\s*$/.test(out.slice(0, start))) {
      throw unsupported(`A variant path after a :: cast (':${unmask(match[1], parts)}') (parenthesise the cast)`);
    }
    if (start < 0) continue;
    approximations?.({ feature: 'variant path', detail: "translated to json_extract: Snowflake's variant typing is not reproduced" });
    const path = literal(toSqlLiteral(jsonPath(match[1], parts)));
    const replacement = `json_extract(${out.slice(start, end)}, ${path})`;
    out = out.slice(0, start) + replacement + out.slice(end + match[0].length);
    step.lastIndex = start + replacement.length;
  }
  return out;
}

/** Index of the `json_extract(` call spanning `sql[start, end)`, outer parentheses allowed; -1 if none. */
function jsonExtractAt(sql: string, start: number, end: number): number {
  if (start < 0) return -1;
  let s = start;
  let e = end;
  for (;;) {
    while (s < e && /\s/.test(sql[s])) s += 1;
    while (e > s && /\s/.test(sql[e - 1])) e -= 1;
    if (sql[s] !== '(' || matchParen(sql, s) !== e - 1) break;
    s += 1;
    e -= 1;
  }
  return sql.startsWith('json_extract(', s) && matchParen(sql, s + 12) === e - 1 ? s : -1;
}

/**
 * A variant path cast to VARCHAR reads through `json_extract_string`: Snowflake unquotes a JSON string
 * and gives other values as JSON text, which `json_extract` + cast would keep quoted.
 */
function variantStringCasts(sql: string): string {
  let out = sql;
  const rename = (at: number) => `${out.slice(0, at)}json_extract_string${out.slice(at + 12)}`;
  const postfix = /::\s*VARCHAR\b/gi;
  for (let match = postfix.exec(out); match; match = postfix.exec(out)) {
    const operandEnd = out.slice(0, match.index).trimEnd().length;
    if (/\[\s*\u0001\d+\u0001\s*\]$/.test(out.slice(0, operandEnd))) {
      throw unsupported("Casting a bracket variant path (col['key']) to VARCHAR (write col:key::string)");
    }
    const at = jsonExtractAt(out, primaryStart(out, operandEnd), match.index);
    if (at < 0) continue;
    out = rename(at);
    postfix.lastIndex = match.index + 7 + match[0].length;
  }
  const call = /\b(?:TRY_)?CAST\s*\(/gi;
  for (let match = call.exec(out); match; match = call.exec(out)) {
    const open = match.index + match[0].length - 1;
    const close = matchParen(out, open);
    const as = close < 0 ? null : /\s+AS\s+VARCHAR\b(?:\s*\(\s*\d+\s*\))?\s*$/i.exec(out.slice(open + 1, close));
    const at = as ? jsonExtractAt(out, open + 1, open + 1 + as.index) : -1;
    if (at >= 0) out = rename(at);
    call.lastIndex = open + 1;
  }
  return out;
}

/** `x::TIME[(p)]`, `x::TIMESTAMP_TZ(p)`, ... → `precisionCast`, leftmost first so an operand's own casts are already rewritten. */
function postfixPrecisionCasts(sql: string, literal: Literal): string {
  const cast = /::\s*(TIME|TIMESTAMP(?:_[LN]?TZ)?|DATETIME)\b(\s*\(\s*\d+\s*\))?/gi;
  let out = sql;
  for (let match = cast.exec(out); match; match = cast.exec(out)) {
    const [text, name, args] = match;
    const at = match.index;
    let start = -1;
    const rewritten = precisionCast(name, args, () => {
      start = castOperandStart(out, at);
      if (start < 0) throw unsupported(`This ::${name.toUpperCase()} operand; write CAST(... AS ${name.toUpperCase()})`);
      return out.slice(start, at).trim();
    }, false, literal);
    if (rewritten === null) continue;
    const head = out.slice(0, start);
    // `distinct(x)::time`: keep the keyword apart from the emitted CAST.
    const replacement = (/[\w$]$/.test(head) ? ' ' : '') + rewritten;
    out = head + replacement + out.slice(at + text.length);
    cast.lastIndex = start + replacement.length;
  }
  return out;
}

/** `x::type` and `[TRY_]CAST(x AS type)`: the only expression positions that name a type. */
function castTypes(sql: string, literal: Literal): string {
  return castCalls(
    postfixPrecisionCasts(sql, literal).replace(
      new RegExp(`::\\s*${TYPE}`, 'g'),
      (_m, name: string, args?: string) => `::${duckType(name, args)}`,
    ),
    literal,
  );
}

function castCalls(out: string, literal: Literal): string {
  const call = /\b((?:TRY_)?CAST)\s*\(/gi;
  let result = '';
  let last = 0;
  for (let match = call.exec(out); match; match = call.exec(out)) {
    const open = match.index + match[0].length - 1;
    const close = matchParen(out, open);
    if (close === -1) break;
    const inner = castCalls(out.slice(open + 1, close), literal);
    const typed = new RegExp(`^([\\s\\S]*\\b)(AS\\s+)${TYPE}(\\s*)$`, 'i').exec(inner);
    const rewritten = typed && precisionCast(typed[3], typed[4], () => typed[1].trim(), /^TRY_/i.test(match[1]), literal);
    if (rewritten) {
      result += out.slice(last, match.index) + rewritten;
    } else {
      const body = typed ? typed[1] + typed[2] + duckType(typed[3], typed[4]) + typed[5] : inner;
      result += `${out.slice(last, open + 1)}${body})`;
    }
    last = close + 1;
    call.lastIndex = last;
  }
  return result + out.slice(last);
}

/**
 * `name TYPE ...` in a column definition list; constraints are left alone. With `timeCheck`
 * (CREATE TABLE; ADD COLUMN cannot carry one) a TIME column refuses DuckDB's 24:00:00 on insert.
 */
function columnDefinitions(list: string, timeCheck: boolean): string {
  return splitTopLevel(list)
    .map((definition) =>
      /^(?:constraint|primary|unique|foreign|check)\b/i.test(definition)
        ? definition
        : definition.replace(new RegExp(`^(${NAME_PART}\\s+)${TYPE}`), (_m, head: string, name: string, args?: string) => {
            const type = duckType(name, args);
            return timeCheck && type === 'TIME' ? `${head}TIME CHECK (hour(${head.trim()}) < 24)` : head + type;
          }),
    )
    .join(', ');
}

/** Column types in CREATE TABLE (…), ALTER TABLE … ADD, and ALTER TABLE … ALTER … TYPE. */
function columnTypes(sql: string): string {
  const create = new RegExp(
    String.raw`^(\s*create\s+(?:or\s+replace\s+)?(?:(?:local|global)\s+)?(?:temporary\s+|temp\s+)?table\s+(?:if\s+not\s+exists\s+)?${TABLE_REF}\s*)\(`,
    'i',
  ).exec(sql);
  if (create) {
    const open = create[0].length - 1;
    const close = matchParen(sql, open);
    if (close === -1) return sql;
    return `${create[1]}(${columnDefinitions(sql.slice(open + 1, close), true)})${sql.slice(close + 1)}`;
  }

  const alter = String.raw`^(\s*alter\s+table\s+(?:if\s+exists\s+)?${TABLE_REF}\s+`;
  const add = new RegExp(`${alter}add\\s+(?:column\\s+)?(?:if\\s+not\\s+exists\\s+)?)([\\s\\S]*)$`, 'i').exec(sql);
  if (add) return add[1] + columnDefinitions(add[2], false);

  return sql.replace(
    new RegExp(`${alter}(?:alter|modify)\\s+(?:column\\s+)?${NAME_PART}\\s+(?:set\\s+data\\s+)?type\\s+)${TYPE}`, 'i'),
    (_m, head: string, name: string, args?: string) => head + duckType(name, args),
  );
}

/** Snowflake format element → [strftime, strptime]. DuckDB timestamps stop at microseconds. */
const FORMAT_ELEMENTS: Array<[string, string, string]> = (
  [
    ['TZH:TZM', '%z', '%z'],
    ['YYYY', '%Y', '%Y'],
    ['MMMM', '%B', '%B'],
    ['HH24', '%H', '%H'],
    ['HH12', '%I', '%I'],
    ['MON', '%b', '%b'],
    ['FF9', '%n', '%n'],
    ['FF6', '%f', '%f'],
    ['FF3', '%g', '%g'],
    // Bare FF is FF9, Snowflake's default fractional precision.
    ['FF', '%n', '%n'],
    ['YY', '%y', '%y'],
    ['MM', '%m', '%m'],
    ['DD', '%d', '%d'],
    ['DY', '%a', '%a'],
    ['MI', '%M', '%M'],
    ['SS', '%S', '%S'],
    ['AM', '%p', '%p'],
    ['PM', '%p', '%p'],
    // Literal text: dbt's catalog query formats with 'yyyy-mm-dd HH24:MI'||'UTC'.
    ['UTC', 'UTC', 'UTC'],
  ] as Array<[string, string, string]>
).sort((a, b) => b[0].length - a[0].length);

/** The text of a string literal, or of literals joined by `||`; null for anything else. */
function constantText(raw: string): string | null {
  const pieces: string[] = [];
  let rest = raw.trim();
  for (;;) {
    const piece = /^'((?:[^']|'')*)'\s*/.exec(rest);
    if (!piece) return null;
    pieces.push(piece[1].replace(/''/g, "'"));
    rest = rest.slice(piece[0].length);
    if (rest.length === 0) return pieces.join('');
    const join = /^\|\|\s*/.exec(rest);
    if (!join) return null;
    rest = rest.slice(join[0].length);
  }
}

/** Snowflake date/time format literal → strftime/strptime literal; null for 'AUTO'; unknown elements throw. */
function convertFormat(fn: string, raw: string, mode: 'format' | 'parse'): string | null {
  const format = constantText(raw);
  if (format === null) throw unsupported(`${fn} with a non-literal format argument`);
  if (format.toUpperCase() === 'AUTO') return null;

  let out = '';
  let i = 0;
  while (i < format.length) {
    const ch = format[i];
    if (ch === '"') {
      const end = format.indexOf('"', i + 1);
      if (end === -1) throw compilationError(`Unterminated quoted text in ${fn} format '${format}'.`);
      out += format.slice(i + 1, end).replace(/%/g, '%%');
      i = end + 1;
      continue;
    }
    if (!/[A-Za-z0-9]/.test(ch)) {
      out += ch === '%' ? '%%' : ch;
      i += 1;
      continue;
    }
    const upper = format.slice(i).toUpperCase();
    const fraction = /^FF(\d)/.exec(upper);
    if (fraction && !'369'.includes(fraction[1])) {
      throw unsupported(`${fn} format element '${format.slice(i, i + 3)}' (in '${format}')`);
    }
    const element = FORMAT_ELEMENTS.find(([token]) => upper.startsWith(token));
    if (!element) {
      const token = /^(?:HH|[A-Za-z]+|\d+)/i.exec(format.slice(i))?.[0] ?? ch;
      throw unsupported(`${fn} format element '${token}' (in '${format}')`);
    }
    out += mode === 'format' ? element[1] : element[2];
    i += element[0].length;
  }
  return toSqlLiteral(out);
}

/** `date_trunc` unit for a CURRENT_* precision argument; null means no truncation. */
function precisionUnit(fn: string, args: string[]): string | null {
  if (args.length === 0) return null;
  if (args.length > 1 || !/^\d$/.test(args[0])) {
    throw compilationError(`${fn} takes an optional precision between 0 and 9.`);
  }
  const precision = Number(args[0]);
  if (precision >= 6) return null;
  if (precision === 3) return 'millisecond';
  if (precision === 0) return 'second';
  throw unsupported(`${fn} with precision ${precision}`);
}

/** Snowflake's display form of a variant path: `vehicle[0].make` → `['vehicle'][0]['make']`. */
function bracketPath(path: string): string {
  let out = '';
  const segment = /([^.\[\]]+)|\[(\d+)\]/g;
  for (let match = segment.exec(path); match; match = segment.exec(path)) {
    out +=
      match[2] === undefined ? `['${(match[1] ?? '').replace(/'/g, "''")}']` : `[${match[2]}]`;
  }
  return out;
}

/** Keywords that end a table alias, so `… ) WHERE` is not read as `WHERE` being the alias. */
const FLATTEN_ALIAS_STOP = new Set([
  'AS', 'ON', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'GROUP',
  'ORDER', 'HAVING', 'LIMIT', 'QUALIFY', 'WINDOW', 'UNION', 'EXCEPT', 'INTERSECT', 'USING',
  'SAMPLE', 'TABLESAMPLE',
]);

const FLATTEN_ARGUMENTS = new Set(['INPUT', 'PATH', 'OUTER', 'MODE', 'RECURSIVE']);

/**
 * `LATERAL FLATTEN(…)` and `FROM TABLE(FLATTEN(…))` → a `json_each` join that
 * exposes Snowflake's six columns.
 *
 * DuckDB's `json_each` walks the same documents and reports the key, the value
 * and the path of every element, so this is a projection rather than an emulation:
 * `SEQ` is the output row number, `KEY` and `INDEX` split object members from
 * array elements, `PATH` is rebuilt in Snowflake's `['a'][0]` form, `VALUE` is the
 * element itself and `THIS` is the input document.
 *
 * `recursive => TRUE` is refused rather than ignored: it changes which rows come
 * back, and a wrong row count is exactly the failure this server exists to make
 * visible.
 */
function flattenCalls(sql: string, parts: string[], literal: (value: string) => string, approximations?: ApproximationSink): string {
  const str = (value: string) => literal(toSqlLiteral(value));
  const closeBracket = str(']');
  let out = sql;

  for (let guard = 0; guard < 200; guard += 1) {
    const call = /(^|[^A-Za-z0-9_$])FLATTEN\s*\(/i.exec(out);
    if (!call) return out;
    approximations?.({ feature: 'LATERAL FLATTEN', detail: 'translated to json_each: variant typing and the index/this columns can differ' });
    const head = call.index + call[1].length;
    const open = head + /FLATTEN\s*\(/i.exec(out.slice(head))![0].length - 1;
    const close = matchParen(out, open);
    if (close === -1) return out;

    const named = new Map<string, string>();
    for (const raw of splitTopLevel(out.slice(open + 1, close))) {
      if (raw.trim().length === 0) continue;
      const argument = /^([A-Za-z_][\w$]*)\s*=>\s*([\s\S]+)$/.exec(raw.trim());
      if (!argument) {
        throw compilationError('FLATTEN takes named arguments, as in FLATTEN(input => payload:items).');
      }
      const name = argument[1].toUpperCase();
      if (!FLATTEN_ARGUMENTS.has(name)) throw compilationError(`Invalid FLATTEN argument '${argument[1]}'.`);
      named.set(name, argument[2].trim());
    }

    const input = named.get('INPUT');
    if (input === undefined) throw compilationError('FLATTEN requires an input argument.');

    const recursive = named.get('RECURSIVE');
    if (recursive !== undefined && !/^FALSE$/i.test(resolve(recursive, parts).trim())) {
      throw unsupported('FLATTEN with recursive => TRUE');
    }

    const mode = named.get('MODE');
    // FLATTEN expands arrays and objects; a scalar input contributes no rows,
    // which is also what makes `outer => TRUE` worth having.
    let filter = ` WHERE json_type(${input}) IN (${str('ARRAY')}, ${str('OBJECT')})`;
    if (mode !== undefined) {
      const value = stripQuotes(resolve(mode, parts)).toUpperCase();
      if (value !== 'ARRAY' && value !== 'OBJECT' && value !== 'BOTH') {
        throw compilationError(`FLATTEN mode must be ARRAY, OBJECT or BOTH, not '${value}'.`);
      }
      // A mode expands one kind of value only; the other contributes no rows.
      const kinds = value === 'BOTH' ? ['ARRAY', 'OBJECT'] : [value];
      filter =
        kinds.length === 1
          ? ` WHERE json_type(${input}) = ${str(kinds[0])}`
          : ` WHERE json_type(${input}) IN (${kinds.map(str).join(', ')})`;
    }

    const prefix = named.has('PATH')
      ? str(bracketPath(stripQuotes(resolve(named.get('PATH') as string, parts))))
      : str('');
    // json_each reports `fullkey`: `$.name` for an object member, `$[0]` for an array element.
    const arrayElement = `ends_with(j."fullkey", ${closeBracket})`;
    const quote = str("'");
    const path =
      `CASE WHEN ${arrayElement} THEN ${prefix} || substring(j."fullkey", 2)` +
      ` ELSE ${prefix} || ${str('[')} || ${quote} || replace(j."key", ${quote}, ${str("''")}) || ${quote} || ${str(']')} END`;

    const subquery =
      '(SELECT row_number() OVER () AS "SEQ",' +
      ` CASE WHEN ${arrayElement} THEN NULL ELSE j."key" END AS "KEY",` +
      ` ${path} AS "PATH",` +
      ` CASE WHEN ${arrayElement} THEN CAST(j."key" AS INTEGER) ELSE NULL END AS "INDEX",` +
      ` j."value" AS "VALUE", ${input} AS "THIS"` +
      ` FROM json_each(${input}) AS j${filter})`;

    const before = out.slice(0, head);
    const tableWrapper = /\bTABLE\s*\(\s*$/i.exec(before);
    const lateral = /\bLATERAL\s*$/i.exec(before);

    let start = head;
    let end = close + 1;
    let lead = '';

    if (tableWrapper) {
      start = tableWrapper.index;
      const closing = /^\s*\)/.exec(out.slice(end));
      if (closing) end += closing[0].length;
    } else if (lateral) {
      start = lateral.index;
      // `outer => TRUE` keeps a row for input that flattens to nothing.
      const outer =
        named.has('OUTER') && /^TRUE$/i.test(resolve(named.get('OUTER') as string, parts).trim());
      if (outer && /,\s*$/.test(out.slice(0, start))) {
        start = out.slice(0, start).search(/,\s*$/);
        lead = ' LEFT JOIN LATERAL ';
      } else {
        lead = 'LATERAL ';
      }
    }

    let text = out.slice(0, start) + lead + subquery + out.slice(end);
    let at = start + lead.length + subquery.length;
    // A quoted alias reaches this point as a masked identifier (\u0002N\u0002), so
    // both forms count as a name and are never read as a keyword.
    const alias = /^(\s+(?:AS\s+)?)(\u0002\d+\u0002|"[^"]*"|[A-Za-z_][\w$]*)/i.exec(text.slice(at));
    const quotedAlias = alias !== null && (alias[2].startsWith('\u0002') || alias[2].startsWith('"'));
    const aliased = alias !== null && (quotedAlias || !FLATTEN_ALIAS_STOP.has(alias[2].toUpperCase()));
    if (alias !== null && aliased) at += alias[0].length;
    if (lead.trim() === 'LEFT JOIN LATERAL') {
      text = `${text.slice(0, at)} ON TRUE${text.slice(at)}`;
    } else if (!aliased && (tableWrapper !== null || lateral !== null)) {
      const generated = ` AS flatten_${guard}`;
      text = `${text.slice(0, at)}${generated}${text.slice(at)}`;
    }
    out = text;
  }

  return out;
}

/**
 * `SEQ.NEXTVAL`, `SEQ.CURRVAL` and `NEXT VALUE FOR SEQ` → DuckDB's
 * `nextval('DB.SCHEMA.SEQ')`, with the name resolved the way Snowflake resolves
 * it: one part is the current schema, two add the current database.
 */
function sequenceValues(
  sql: string,
  parts: string[],
  literal: (value: string) => string,
  ctx: RewriteContext,
): string {
  const identifier = '(?:\\u0002\\d+\\u0002|[A-Za-z_][\\w$]*)';
  const qualified = `${identifier}(?:\\s*\\.\\s*${identifier}){0,2}`;

  const resolvedName = (reference: string): string => {
    const pieces = reference.split('.').map((piece) => {
      const trimmed = piece.trim();
      const masked = /^\u0002(\d+)\u0002$/.exec(trimmed);
      if (masked) return parts[Number(masked[1])].replace(/^"|"$/g, '').replace(/""/g, '"');
      return trimmed.toUpperCase();
    });
    if (pieces.length === 1) return [ctx.database ?? '', ctx.schema ?? '', ...pieces].join('.');
    if (pieces.length === 2) return [ctx.database ?? '', ...pieces].join('.');
    return pieces.join('.');
  };

  const call = (kind: string, reference: string): string =>
    `${kind.toLowerCase()}(${literal(toSqlLiteral(resolvedName(reference)))})`;

  const values = sql.replace(
    new RegExp(`(?<![\\w$.])(${qualified})\\s*\\.\\s*(NEXTVAL|CURRVAL)\\b`, 'gi'),
    (_match, reference: string, kind: string) => call(kind, reference),
  );
  return values.replace(
    new RegExp(`\\bNEXT\\s+VALUE\\s+FOR\\s+(${qualified})\\b`, 'gi'),
    (_match, reference: string) => call('NEXTVAL', reference),
  );
}

const isStringLiteral = (value: string): boolean => constantText(value) !== null;

/**
 * Translate one statement. `bindings` are positional values for `?`
 * placeholders (the Python connector always rewrites `%s`/`:name` to `?`
 * client-side and sends the values separately).
 */
export function rewrite(
  sql: string,
  ctx: RewriteContext,
  bindings: unknown[] = [],
  approximations?: ApproximationSink,
): string {
  const parts: string[] = [];
  let text = maskNonCode(sql, parts, true);
  const literal = (value: string) => pushOpaque(parts, value);

  // Reads quoted names itself, so it runs before they are masked.
  text = databaseInformationSchema(text, ctx, literal);
  text = maskIdentifiers(text, parts);
  text = sequenceValues(text, parts, literal, ctx);

  // `LATERAL FLATTEN(…)` becomes a correlated `json_each` join. It runs before
  // the variant-path pass, so the input expression is still translated, and so
  // are the columns the subquery exposes.
  text = flattenCalls(text, parts, literal, approximations);

  if (bindings.length > 0) {
    let index = 0;
    text = text.replace(/\?/g, () => {
      const value = index < bindings.length ? bindings[index] : null;
      index += 1;
      return literal(toSqlLiteral(value));
    });
  }

  // Session context functions.
  const sessionValues: Array<[RegExp, string | null]> = [
    [/\bCURRENT_DATABASE\s*(?:\(\s*\))?/gi, ctx.database],
    [/\bCURRENT_SCHEMA\s*(?:\(\s*\))?/gi, ctx.schema],
    [/\bCURRENT_ROLE\s*(?:\(\s*\))?/gi, ctx.role],
    [/\bCURRENT_USER\s*(?:\(\s*\))?/gi, ctx.user],
    [/\bCURRENT_WAREHOUSE\s*(?:\(\s*\))?/gi, ctx.warehouse],
    [/\bCURRENT_ACCOUNT\s*(?:\(\s*\))?/gi, ctx.account ?? 'SNOWTEST'],
    [/\bCURRENT_VERSION\s*(?:\(\s*\))?/gi, ctx.version ?? '8.42.0'],
  ];
  for (const [pattern, value] of sessionValues) {
    text = text.replace(pattern, () => literal(toSqlLiteral(value)));
  }

  // Clock functions. DuckDB knows the bare keywords but not the call forms.
  //
  // With SNOWTEST_CLOCK set, "now" is a fixed instant instead of the host clock.
  // It is spelled epoch_ms(<ms>) rather than a timestamp literal so no later pass
  // has to unpick quotes, and it is resolved per statement, so an offset still
  // moves forward during a long run.
  const clockMs = ctx.clockMs;
  const now = clockMs === undefined ? 'CURRENT_TIMESTAMP' : `epoch_ms(${literal(String(Math.trunc(clockMs)))})`;
  const today = clockMs === undefined ? 'CURRENT_DATE' : `CAST(${now} AS DATE)`;
  const clockTime = clockMs === undefined ? 'current_localtime()' : `CAST(${now} AS TIME)`;

  for (const name of ['CURRENT_TIMESTAMP', 'LOCALTIMESTAMP']) {
    text = replaceCall(text, name, parts, (args) => {
      const unit = precisionUnit(name, args);
      return unit ? `date_trunc(${literal(`'${unit}'`)}, ${now})` : now;
    });
  }
  for (const name of ['CURRENT_TIME', 'LOCALTIME']) {
    text = replaceCall(text, name, parts, (args) => {
      const unit = precisionUnit(name, args);
      if (!unit) return clockTime;
      const from = clockMs === undefined ? 'current_localtimestamp()' : now;
      return `CAST(date_trunc(${literal(`'${unit}'`)}, ${from}) AS TIME)`;
    });
  }
  text = text.replace(/\bLOCALTIMESTAMP\b(?!\s*\()/gi, () => now);
  text = text.replace(/\bCURRENT_TIMESTAMP\b(?!\s*\()/gi, () => now);
  text = text.replace(/\b(?:CURRENT_TIME|LOCALTIME)\b(?!\s*\()/gi, () => clockTime);
  text = text.replace(/\bCURRENT_DATE\b(?!\s*\()/gi, () => today);
  text = replaceCall(text, 'CURRENT_DATE', parts, (args) => {
    if (args.length > 0) throw compilationError('CURRENT_DATE takes no arguments.');
    return today;
  });
  // SYSDATE is the UTC wall clock as TIMESTAMP_NTZ.
  text = replaceCall(text, 'SYSDATE', parts, (args) => {
    if (args.length > 0) throw compilationError('SYSDATE takes no arguments.');
    return `timezone(${literal("'UTC'")}, ${now})`;
  });
  // GETDATE is an alias for CURRENT_TIMESTAMP. It is handled here, before the
  // SIMPLE_RENAMES pass, or it would reach DuckDB as NOW() and ignore
  // SNOWTEST_CLOCK.
  text = replaceCall(text, 'GETDATE', parts, (args) => {
    if (args.length > 0) throw compilationError('GETDATE takes no arguments.');
    return now;
  });

  text = castTypes(text, literal);

  for (const [pattern, replacement] of SIMPLE_RENAMES) {
    text = text.replace(pattern, replacement);
  }

  text = replaceCall(text, 'IFF', parts, (args) => {
    if (args.length !== 3) return null;
    return `CASE WHEN ${args[0]} THEN ${args[1]} ELSE ${args[2]} END`;
  });

  text = replaceCall(text, 'NVL2', parts, (args) => {
    if (args.length !== 3) return null;
    return `CASE WHEN ${args[0]} IS NULL THEN ${args[2]} ELSE ${args[1]} END`;
  });

  text = replaceCall(text, 'ZEROIFNULL', parts, (args) => {
    if (args.length !== 1) return null;
    return `COALESCE(${args[0]}, 0)`;
  });

  text = replaceCall(text, 'NULLIFZERO', parts, (args) => {
    if (args.length !== 1) return null;
    return `NULLIF(${args[0]}, 0)`;
  });

  text = replaceCall(text, 'DIV0', parts, (args) => {
    if (args.length !== 2) return null;
    return `COALESCE(${args[0]} / NULLIF(${args[1]}, 0), 0)`;
  });

  // dbt's catalog query formats `convert_timezone('UTC', last_altered)`.
  text = replaceCall(text, 'CONVERT_TIMEZONE', parts, (args) => {
    if (args.length !== 2 && args.length !== 3) return null;
    approximations?.({ feature: 'CONVERT_TIMEZONE', detail: 'translated to timezone(): session timezone defaults and DST edges can differ' });
    if (args.length === 2) return `timezone(${args[0]}, ${args[1]})`;
    return `timezone(${args[1]}, timezone(${args[0]}, ${args[2]}))`;
  });

  text = replaceCall(text, 'EQUAL_NULL', parts, (args) => {
    if (args.length !== 2) return null;
    return `(${args[0]} IS NOT DISTINCT FROM ${args[1]})`;
  });

  text = replaceCall(text, 'SQUARE', parts, (args) => {
    if (args.length !== 1) return null;
    return `((${args[0]}) * (${args[0]}))`;
  });

  text = replaceCall(text, 'DECODE', parts, (args) => {
    if (args.length < 3) return null;
    const subject = args[0];
    const rest = args.slice(1);
    const clauses: string[] = [];
    let fallback = 'NULL';
    for (let i = 0; i < rest.length; i += 2) {
      const when = rest[i];
      const then = rest[i + 1];
      if (then === undefined) {
        fallback = when;
        break;
      }
      clauses.push(`WHEN ${subject} IS NOT DISTINCT FROM ${when} THEN ${then}`);
    }
    return `CASE ${clauses.join(' ')} ELSE ${fallback} END`;
  });

  const castCall = (tryCast: boolean, value: string, type: string) =>
    `${tryCast ? 'TRY_CAST' : 'CAST'}(${value} AS ${type})`;

  for (const name of ['TO_VARCHAR', 'TO_CHAR', 'TO_TEXT']) {
    text = replaceCall(text, name, parts, (args, resolveArg) => {
      if (args.length === 1) return castCall(false, args[0], 'VARCHAR');
      if (args.length !== 2) return null;
      const format = convertFormat(name, resolveArg(args[1]), 'format');
      return format === null ? castCall(false, args[0], 'VARCHAR') : `strftime(${args[0]}, ${literal(format)})`;
    });
  }

  for (const [name, tryCast] of [['TRY_TO_BOOLEAN', true], ['TO_BOOLEAN', false]] as const) {
    text = replaceCall(text, name, parts, (args) =>
      args.length === 1 ? castCall(tryCast, args[0], 'BOOLEAN') : null,
    );
  }

  text = replaceCall(text, 'TO_BINARY', parts, (args, resolveArg) => {
    if (args.length === 0 || args.length > 2) return null;
    const format = args.length === 2 ? resolveArg(args[1]).trim().toUpperCase() : "'HEX'";
    if (format === "'HEX'") return `unhex(${args[0]})`;
    if (format === "'BASE64'") return `from_base64(${args[0]})`;
    if (format === "'UTF-8'" || format === "'UTF8'") return `encode(${args[0]})`;
    throw unsupported(`TO_BINARY format ${format}`);
  });

  for (const [name, tryCast] of [['TRY_TO_DATE', true], ['TO_DATE', false]] as const) {
    text = replaceCall(text, name, parts, (args, resolveArg) => {
      if (args.length === 1) return castCall(tryCast, args[0], 'DATE');
      if (args.length !== 2) return null;
      const format = convertFormat(name, resolveArg(args[1]), 'parse');
      if (format === null) return castCall(tryCast, args[0], 'DATE');
      return `CAST(${tryCast ? 'try_strptime' : 'strptime'}(${args[0]}, ${literal(format)}) AS DATE)`;
    });
  }

  for (const [base, type] of [
    ['TO_TIMESTAMP', 'TIMESTAMP'],
    ['TO_TIMESTAMP_NTZ', 'TIMESTAMP'],
    ['TO_TIMESTAMP_LTZ', 'TIMESTAMP'],
    ['TO_TIMESTAMP_TZ', 'TIMESTAMPTZ'],
  ]) {
    for (const [name, tryCast] of [[`TRY_${base}`, true], [base, false]] as const) {
      text = replaceCall(text, name, parts, (args, resolveArg) => {
        if (args.length === 1) return castCall(tryCast, args[0], type);
        if (args.length !== 2) return null;
        const second = resolveArg(args[1]).trim();
        // Numeric second argument: the scale of an epoch value (0 = seconds, 3 = ms, ...).
        if (/^\d$/.test(second)) {
          const scale = Number(second);
          const micros =
            scale <= 6 ? `CAST(${args[0]} AS BIGINT) * ${10 ** (6 - scale)}` : `CAST(${args[0]} AS BIGINT) // ${10 ** (scale - 6)}`;
          return castCall(tryCast, `make_timestamp(${micros})`, type);
        }
        const format = convertFormat(name, second, 'parse');
        if (format === null) return castCall(tryCast, args[0], type);
        return `CAST(${tryCast ? 'try_strptime' : 'strptime'}(${args[0]}, ${literal(format)}) AS ${type})`;
      });
    }
  }

  for (const base of ['TO_NUMBER', 'TO_DECIMAL', 'TO_NUMERIC']) {
    for (const [name, tryCast] of [[`TRY_${base}`, true], [base, false]] as const) {
      text = replaceCall(text, name, parts, (args, resolveArg) => {
        if (args.length === 0 || args.length > 3) return null;
        if (args.slice(1).some((arg) => isStringLiteral(resolveArg(arg)))) {
          throw unsupported(`${name} with a format argument`);
        }
        const precision = args[1] ?? '38';
        const scale = args[2] ?? '0';
        return castCall(tryCast, args[0], `DECIMAL(${precision}, ${scale})`);
      });
    }
  }

  for (const [name, tryCast] of [['TRY_TO_DOUBLE', true], ['TO_DOUBLE', false]] as const) {
    text = replaceCall(text, name, parts, (args) => {
      if (args.length === 2) throw unsupported(`${name} with a format argument`);
      return args.length === 1 ? castCall(tryCast, args[0], 'DOUBLE') : null;
    });
  }

  for (const name of ['DATEADD', 'DATE_ADD', 'TIMESTAMPADD']) {
    text = replaceCall(text, name, parts, (args, resolveArg) => {
      if (args.length !== 3) return null;
      const unit = intervalUnit(normalizeUnit(resolveArg(args[0])));
      if (!unit) return null;
      return `(${args[2]} + (${args[1]}) * INTERVAL 1 ${unit})`;
    });
  }

  for (const name of ['DATEDIFF', 'DATE_DIFF', 'TIMESTAMPDIFF']) {
    text = replaceCall(text, name, parts, (args, resolveArg) => {
      if (args.length !== 3) return null;
      const unit = normalizeUnit(resolveArg(args[0]));
      if (!INTERVAL_UNITS.has(unit)) return null;
      return `date_diff('${unit}', ${args[1]}, ${args[2]})`;
    });
  }

  text = rewriteOrderedAggregate(
    text,
    'LISTAGG',
    (args) => (args.length === 1 ? [args[0], "''"] : args.length === 2 ? args : null),
    (args, order, over) => `string_agg(${args.join(', ')}${order})${over}`,
  );
  // Snowflake's ARRAY_AGG skips NULLs and yields [] for no input; DuckDB keeps NULLs and yields NULL.
  text = rewriteOrderedAggregate(
    text,
    'ARRAY_AGG',
    (args) => (args.length === 1 ? args : null),
    ([arg], order, over) =>
      `COALESCE(array_agg(${arg}${order}) FILTER (WHERE ${arg.replace(/^DISTINCT\s+/i, '')} IS NOT NULL)${over}, [])`,
  );

  text = replaceCall(text, 'ARRAY_CONSTRUCT', parts, (args) => `list_value(${args.join(', ')})`);
  text = replaceCall(text, 'OBJECT_CONSTRUCT', parts, (args) => `json_object(${args.join(', ')})`);
  text = replaceCall(text, 'PARSE_JSON', parts, (args) =>
    args.length === 1 ? `TRY_CAST(${args[0]} AS JSON)` : null,
  );
  text = replaceCall(text, 'TO_JSON', parts, (args) =>
    args.length === 1 ? `CAST(${args[0]} AS JSON)` : null,
  );

  if (ctx.variantPaths !== false) {
    // `col:field[.sub|[n]]…` / `"Col":field` / `f(x):field` variant access → json_extract.
    text = variantStringCasts(variantPaths(text, parts, literal, approximations));
  }

  text = ddlDecorations(text);
  text = columnTypes(text);
  text = qualifyMergeInsertValues(text);
  text = foldUnquoted(text);

  return unmask(text, parts);
}

export interface ColumnListCtas {
  /** Target table as written. */
  table: string;
  ifNotExists: boolean;
  /** `CREATE [OR REPLACE] TABLE t (cols)` with unenforced constraints removed. */
  create: string;
  /** The query after `AS`, outer parentheses removed. */
  query: string;
}

/** Constraints Snowflake records but does not enforce (only NOT NULL is enforced). */
const INLINE_CONSTRAINT =
  /\s+(?:constraint\s+(?:"[^"]*"|[\w$]+)\s+)?(?:primary\s+key|unique|foreign\s+key|references\s+[\w$".]+(?:\s*\([^)]*\))?)(?:\s+(?:not\s+)?enforced|\s+(?:no)?rely|\s+(?:not\s+)?deferrable|\s+initially\s+(?:deferred|immediate)|\s+enable|\s+disable|\s+(?:no)?validate)*/gi;

/** Split dbt's contract DDL, `CREATE TABLE t (cols) AS (query)`; DuckDB has no CTAS with a column list. */
export function splitColumnListCtas(sql: string): ColumnListCtas | null {
  const parts: string[] = [];
  const masked = maskNonCode(sql, parts);
  const head =
    /^\s*create\s+(?:or\s+replace\s+)?(?:(?:local|global)\s+)?(?:transient\s+|temporary\s+|temp\s+|volatile\s+)?table\s+(if\s+not\s+exists\s+)?((?:"[^"]*"|[\w$]+)(?:\s*\.\s*(?:"[^"]*"|[\w$]+))*)\s*\(/i.exec(
      masked,
    );
  if (!head) return null;

  const open = head[0].length - 1;
  const close = matchParen(masked, open);
  if (close === -1) return null;

  const after = masked.slice(close + 1);
  const as = /\bAS\b/i.exec(after);
  if (!as) return null;
  // Only decorations may sit between the column list and AS; anything else goes to DuckDB unchanged.
  if (ddlDecorations(after.slice(0, as.index)).trim().length > 0) return null;

  const columns = splitTopLevel(masked.slice(open + 1, close))
    .filter((column) => !/^(?:constraint\b|primary\s+key\b|unique\b|foreign\s+key\b)/i.test(column))
    .map((column) => column.replace(INLINE_CONSTRAINT, ''));

  let query = after.slice(as.index + as[0].length).trim();
  if (query.startsWith('(') && matchParen(query, 0) === query.length - 1) {
    query = query.slice(1, -1).trim();
  }

  return {
    table: unmask(head[2], parts),
    ifNotExists: Boolean(head[1]),
    create: unmask(`${masked.slice(0, open)}(${columns.join(', ')})`, parts),
    query: unmask(query, parts),
  };
}

/** Render a JavaScript value as a SQL literal. */
export function toSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return `'${value.toISOString().replace('T', ' ').replace('Z', '')}'`;
  if (typeof value === 'object') {
    if (Array.isArray(value) || Buffer.isBuffer(value)) {
      if (Buffer.isBuffer(value)) return `'${value.toString('hex')}'`;
      return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
    }
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}
