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
 * than as silently wrong data.
 */

import { normalizeName } from './catalog.js';

export interface RewriteContext {
  database: string;
  schema: string;
  role: string;
  user: string;
  warehouse: string;
  account?: string;
  version?: string;
  /** Translate `col:field` variant paths into `json_extract`. */
  variantPaths?: boolean;
}

/** Placeholder marker for text we must not touch (string literals, comments). */
const MARK = '\u0001';

function pushOpaque(parts: string[], value: string): string {
  parts.push(value);
  return `${MARK}${parts.length - 1}${MARK}`;
}

/**
 * Replace string literals and comments with opaque markers so the rewrite
 * rules never fire inside them. Double-quoted identifiers stay visible because
 * they are code (and `col:"Field"` is a legitimate variant path).
 */
function maskNonCode(sql: string, parts: string[]): string {
  let out = '';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === "'") {
      let j = i + 1;
      let text = "'";
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            text += "''";
            j += 2;
            continue;
          }
          text += "'";
          j += 1;
          break;
        }
        text += sql[j];
        j += 1;
      }
      out += pushOpaque(parts, text);
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
  if (!sql.includes(MARK)) return sql;
  return sql.replace(/\u0001(\d+)\u0001/g, (_m, idx: string) => parts[Number(idx)] ?? '');
}

/** Resolve opaque markers inside a fragment back to their original text. */
function resolve(arg: string, parts: string[]): string {
  return arg.replace(/\u0001(\d+)\u0001/g, (_m, idx: string) => parts[Number(idx)] ?? '');
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

/** Strip Snowflake's `WITHIN GROUP (ORDER BY ...)` from aggregates. */
function stripWithinGroup(sql: string): string {
  let result = sql;
  for (let guard = 0; guard < 100; guard += 1) {
    const match = /\bWITHIN\s+GROUP\s*\(/i.exec(result);
    if (!match) break;
    const openIndex = match.index + match[0].length - 1;
    const closeIndex = matchParen(result, openIndex);
    if (closeIndex === -1) break;
    result = result.slice(0, match.index) + result.slice(closeIndex + 1);
  }
  return result;
}

const SIMPLE_RENAMES: Array<[RegExp, string]> = [
  [/\bNVL\s*\(/gi, 'COALESCE('],
  [/\bBOOLOR_AGG\s*\(/gi, 'BOOL_OR('],
  [/\bBOOLAND_AGG\s*\(/gi, 'BOOL_AND('],
  [/\bLEAST\s*\(/gi, 'LEAST('],
  [/\bGETDATE\s*\(/gi, 'NOW('],
  [/\bSYSDATE\s*\(/gi, 'NOW('],
];

function ddlDecorations(sql: string): string {
  let out = sql;
  out = out.replace(/\bCREATE\s+OR\s+REPLACE\s+(TRANSIENT|TEMPORARY|VOLATILE)\s+/gi, 'CREATE OR REPLACE ');
  out = out.replace(/\bCREATE\s+(TRANSIENT|VOLATILE)\s+/gi, 'CREATE ');
  out = out.replace(/\bCLUSTER\s+BY\s*\([^)]*\)/gi, '');
  out = out.replace(/\bCOPY\s+GRANTS\b/gi, '');
  out = out.replace(/\bDATA_RETENTION_TIME_IN_DAYS\s*=\s*\d+\s*/gi, '');
  out = out.replace(/\bCHANGE_TRACKING\s*=\s*(TRUE|FALSE)\s*/gi, '');
  out = out.replace(/\bENABLE_SCHEMA_EVOLUTION\s*=\s*(TRUE|FALSE)\s*/gi, '');
  return out;
}

/**
 * Fold unquoted object names to upper case, the way Snowflake does.
 *
 * DuckDB is case-insensitive but case-*preserving*: `create view db.s.t` stores
 * `t` verbatim. Clients that read object names back (dbt caches them from
 * `SHOW TERSE OBJECTS` and then looks up `T`) only see an approximate match and
 * refuse to proceed, so the names have to be folded at creation time.
 */
function foldIdentifierCase(sql: string): string {
  const fold = (identifier: string): string =>
    identifier
      .split('.')
      .map((part) => (part.startsWith('"') ? part : part.toUpperCase()))
      .join('.');

  const name = '([A-Za-z_][\\w$]*(?:\\.[A-Za-z_][\\w$]*)*)';

  let out = sql.replace(
    new RegExp(
      `\\b(CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:TRANSIENT\\s+|TEMPORARY\\s+|TEMP\\s+)?(?:TABLE|VIEW)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)${name}`,
      'gi',
    ),
    (_match, prefix: string, target: string) => prefix + fold(target),
  );

  out = out.replace(
    new RegExp(`\\b(DROP\\s+(?:TABLE|VIEW)\\s+(?:IF\\s+EXISTS\\s+)?)${name}`, 'gi'),
    (_match, prefix: string, target: string) => prefix + fold(target),
  );

  out = out.replace(
    new RegExp(`\\b(ALTER\\s+TABLE\\s+)${name}(\\s+RENAME\\s+TO\\s+)${name}`, 'gi'),
    (_match, head: string, from: string, middle: string, to: string) =>
      head + fold(from) + middle + fold(to),
  );

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
          if (/^"[^"]+"$/.test(trimmed)) return `${alias}.${trimmed}`;
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

/**
 * `[DB.]information_schema.<view>` → DuckDB's global information_schema filtered
 * to DB (the session database when unqualified, as in Snowflake): DuckDB only
 * exposes information_schema in its system catalog.
 * Generated text is masked so later rewrite rules leave it alone.
 */
function databaseInformationSchema(
  sql: string,
  currentDatabase: string,
  literal: (value: string) => string,
): string {
  return sql.replace(
    /(?<![\w$".])(?:("[^"]+"|[A-Za-z_][\w$]*)\s*\.\s*)?(?:information_schema|"INFORMATION_SCHEMA")\s*\.\s*(columns|tables|views|schemata)\b/gi,
    (_match, database: string | undefined, view: string) => {
      const name = view.toLowerCase();
      const catalog = toSqlLiteral(database ? normalizeName(database) : currentDatabase);
      const body =
        name === 'schemata'
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

function columnTypes(sql: string): string {
  let out = sql;
  out = out.replace(/\bNUMBER\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/gi, 'DECIMAL($1,$2)');
  out = out.replace(/\bNUMBER\s*\(\s*(\d+)\s*\)/gi, 'DECIMAL($1,0)');
  out = out.replace(/\bNUMBER\b(?!\s*\()/gi, 'DECIMAL(38,0)');
  out = out.replace(/\bVARCHAR\s*\(\s*16777216\s*\)/gi, 'VARCHAR');
  out = out.replace(/\bTIMESTAMP_NTZ\b/gi, 'TIMESTAMP');
  out = out.replace(/\bTIMESTAMP_(LTZ|TZ)\b/gi, 'TIMESTAMPTZ');
  out = out.replace(/\bBINARY\b/gi, 'BLOB');
  out = out.replace(/\bSTRING\b/gi, 'VARCHAR');
  out = out.replace(/\bVARIANT\b/gi, 'JSON');
  return out;
}

function castAliases(sql: string): string {
  let out = sql;
  out = out.replace(/::\s*(string|text)\b/gi, '::VARCHAR');
  out = out.replace(/::\s*number\b/gi, '::DOUBLE');
  out = out.replace(/::\s*(variant|object|array)\b/gi, '::JSON');
  out = out.replace(/::\s*timestamp_ntz\b/gi, '::TIMESTAMP');
  out = out.replace(/::\s*timestamp_(ltz|tz)\b/gi, '::TIMESTAMPTZ');
  out = out.replace(/::\s*binary\b/gi, '::BLOB');
  out = out.replace(/::\s*float\b/gi, '::DOUBLE');
  return out;
}

/**
 * Translate one statement. `bindings` are positional values for `?`
 * placeholders (the Python connector always rewrites `%s`/`:name` to `?`
 * client-side and sends the values separately).
 */
export function rewrite(
  sql: string,
  ctx: RewriteContext,
  bindings: unknown[] = [],
): string {
  const parts: string[] = [];
  let text = maskNonCode(sql, parts);
  const literal = (value: string) => pushOpaque(parts, value);

  if (bindings.length > 0) {
    let index = 0;
    text = text.replace(/\?/g, () => {
      const value = index < bindings.length ? bindings[index] : null;
      index += 1;
      return literal(toSqlLiteral(value));
    });
  }

  text = databaseInformationSchema(text, ctx.database, literal);

  // Session context functions.
  const sessionValues: Array<[RegExp, string]> = [
    [/\bCURRENT_DATABASE\s*(?:\(\s*\))?/gi, ctx.database],
    [/\bCURRENT_SCHEMA\s*(?:\(\s*\))?/gi, ctx.schema],
    [/\bCURRENT_ROLE\s*(?:\(\s*\))?/gi, ctx.role],
    [/\bCURRENT_USER\s*(?:\(\s*\))?/gi, ctx.user],
    [/\bCURRENT_WAREHOUSE\s*(?:\(\s*\))?/gi, ctx.warehouse],
    [/\bCURRENT_ACCOUNT\s*(?:\(\s*\))?/gi, ctx.account ?? 'SNOWTEST'],
    [/\bCURRENT_VERSION\s*(?:\(\s*\))?/gi, ctx.version ?? '8.42.0'],
  ];
  for (const [pattern, value] of sessionValues) {
    text = text.replace(pattern, () => literal(`'${value.replace(/'/g, "''")}'`));
  }

  text = castAliases(text);

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
    if (args.length === 2) return `timezone(${args[0]}, ${args[1]})`;
    if (args.length === 3) return `timezone(${args[1]}, timezone(${args[0]}, ${args[2]}))`;
    return null;
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
      clauses.push(`WHEN ${subject} = ${when} THEN ${then}`);
    }
    return `CASE ${clauses.join(' ')} ELSE ${fallback} END`;
  });

  // TO_VARCHAR(x[, fmt]) and friends: keep the value, drop the format string.
  for (const [names, target] of [
    [['TO_VARCHAR', 'TO_CHAR', 'TO_TEXT'], 'VARCHAR'],
    [['TO_BOOLEAN'], 'BOOLEAN'],
    [['TO_DATE'], 'DATE'],
    [['TO_TIMESTAMP', 'TO_TIMESTAMP_NTZ', 'TO_TIMESTAMP_LTZ', 'TRY_TO_TIMESTAMP'], 'TIMESTAMP'],
    [['TO_BINARY'], 'BLOB'],
  ] as Array<[string[], string]>) {
    for (const name of names) {
      text = replaceCall(text, name, parts, (args) => {
        if (args.length === 0) return null;
        return `CAST(${args[0]} AS ${target})`;
      });
    }
  }

  for (const name of ['TO_NUMBER', 'TO_DECIMAL', 'TO_NUMERIC', 'TRY_TO_NUMBER']) {
    text = replaceCall(text, name, parts, (args) => {
      if (args.length === 0) return null;
      if (args.length >= 3) return `CAST(${args[0]} AS DECIMAL(${args[1]}, ${args[2]}))`;
      if (args.length === 2) return `CAST(${args[0]} AS DECIMAL(${args[1]}, 0))`;
      return `CAST(${args[0]} AS DECIMAL(38, 0))`;
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

  text = replaceCall(text, 'LISTAGG', parts, (args) => {
    if (args.length === 0) return null;
    if (args.length === 1) return `string_agg(${args[0]}, '')`;
    return `string_agg(${args[0]}, ${args[1]})`;
  });

  text = replaceCall(text, 'ARRAY_CONSTRUCT', parts, (args) => `list_value(${args.join(', ')})`);
  text = replaceCall(text, 'OBJECT_CONSTRUCT', parts, (args) => `json_object(${args.join(', ')})`);
  text = replaceCall(text, 'PARSE_JSON', parts, (args) =>
    args.length === 1 ? `TRY_CAST(${args[0]} AS JSON)` : null,
  );
  text = replaceCall(text, 'TO_JSON', parts, (args) =>
    args.length === 1 ? `CAST(${args[0]} AS JSON)` : null,
  );

  if (ctx.variantPaths !== false) {
    // `col:field` / `col:"Field"` variant access → json_extract.
    text = text.replace(
      /(?<!:)([A-Za-z_][A-Za-z0-9_$]*|"[^"]*")\s*:\s*([A-Za-z_][A-Za-z0-9_$]*)/g,
      (whole, source: string, field: string) => {
        if (/^(https?|s3|file)$/i.test(field)) return whole;
        return `json_extract(${source}, '$.${field}')`;
      },
    );

    // `payload:region::string` must unquote: Snowflake's variant-to-string cast
    // strips the JSON quotes, while json_extract keeps them.
    text = text.replace(
      /json_extract\(([^,]+),\s*('\$\.[^']*')\)\s*::\s*VARCHAR/g,
      'json_extract_string($1, $2)',
    );
    text = text.replace(
      /CAST\(json_extract\(([^,]+),\s*('\$\.[^']*')\)\s+AS\s+VARCHAR\)/gi,
      'json_extract_string($1, $2)',
    );
  }

  text = stripWithinGroup(text);
  text = ddlDecorations(text);
  text = columnTypes(text);
  text = foldIdentifierCase(text);
  text = qualifyMergeInsertValues(text);

  return unmask(text, parts);
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
