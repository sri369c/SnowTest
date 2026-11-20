// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * Every construct the translation reports as approximate, in one place.
 *
 * A feature name lands in `QUERY_HISTORY.fidelity` and `MODEL_FIDELITY.construct`,
 * and `strict` refuses on it. Add a construct here first; `dialect.ts` reports it
 * with `approximation(name)`, which throws on a name not listed. Faithful rewrites
 * (`IFF`, `NVL2`, `DIV0`, `DECODE`, `GREATEST`, `OBJECT_CONSTRUCT`, …) do not belong.
 */

/** One place a translation substitutes an approximation of Snowflake for Snowflake. */
export type Approximation = { feature: string; detail: string };

/** Collects approximations while one statement is translated. */
export type ApproximationSink = (approximation: Approximation) => void;

/** Grouped by divergence: every name in a group shares its detail. */
const GROUPS = [
  {
    features: ['variant path'],
    detail: "translated to json_extract: Snowflake's variant typing is not reproduced",
  },
  {
    features: ['LATERAL FLATTEN'],
    detail: 'translated to json_each: variant typing and the index/this columns can differ',
  },
  {
    features: ['CONVERT_TIMEZONE'],
    detail: 'translated to timezone(): session timezone defaults and DST edges can differ',
  },
  {
    features: ['CURRENT_TIMESTAMP', 'LOCALTIMESTAMP', 'GETDATE'],
    detail: 'DuckDB clock: session TIMEZONE ignored, offset always UTC',
  },
  {
    // Cast spellings as written: `::TIMESTAMP_TZ`, `CAST(… AS TIMESTAMPTZ)`, …
    features: ['TIMESTAMP_LTZ', 'TIMESTAMP_TZ', 'TIMESTAMPLTZ', 'TIMESTAMPTZ'],
    detail: 'cast to TIMESTAMPTZ: session TIMEZONE ignored, offset always UTC',
  },
  {
    features: ['TO_TIMESTAMP_LTZ', 'TRY_TO_TIMESTAMP_LTZ'],
    detail: 'translated to TIMESTAMP: session TIMEZONE ignored',
  },
  {
    features: ['TO_TIMESTAMP_TZ', 'TRY_TO_TIMESTAMP_TZ'],
    detail: 'translated to TIMESTAMPTZ: session TIMEZONE ignored',
  },
  {
    features: ['TO_VARCHAR', 'TO_CHAR', 'TO_TEXT'],
    detail: "CAST AS VARCHAR: not Snowflake's default output format (.FF3, TZ offset)",
  },
  {
    features: ['DATEADD', 'DATE_ADD', 'TIMESTAMPADD'],
    detail: 'DATE + INTERVAL returns TIMESTAMP; Snowflake returns DATE',
  },
  {
    features: ['TYPEOF'],
    detail: "DuckDB typeof(): returns DuckDB type names (JSON), not Snowflake's variant types",
  },
  {
    features: ['HASH'],
    detail: "DuckDB hash(): different values from Snowflake's HASH",
  },
  {
    features: ['ARRAY_CONSTRUCT'],
    detail: 'NULL element: DuckDB keeps NULL, Snowflake stores undefined',
  },
  {
    // An operator, not a call: there is no rewrite to hang the note on, and the
    // value itself is not fixed either. Reported only for two integer literals,
    // the one case this pass can type without asking the catalog.
    features: ['integer division'],
    detail: 'DuckDB divides in double precision: 1/3 is 0.3333333333333333 where Snowflake returns 0.333333',
  },
] as const;

export type ApproximatedFeature = (typeof GROUPS)[number]['features'][number];

const DETAILS = new Map<string, string>(
  GROUPS.flatMap((group) => group.features.map((feature): [string, string] => [feature, group.detail])),
);

/** The registered approximation for `feature`. Unlisted names throw: a typo must not reach the ledger. */
export function approximation(feature: ApproximatedFeature): Approximation {
  const detail = DETAILS.get(feature);
  if (detail === undefined) throw new Error(`snowtest: approximation '${feature}' is not registered in approximations.ts`);
  return { feature, detail };
}
