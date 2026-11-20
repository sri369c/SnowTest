<!-- Copyright (c) 2026 Srinivas Chaturvedula -->

# SnowTest

Snowflake, minus the cloud bill. SnowTest is a local Snowflake look-alike powered
by DuckDB, so you can run your connectors, Snowpark and dbt projects on your
laptop. Your data survives restarts, and your wallet survives too.

## Bring it up

```bash
./setup.py up        # start it on 127.0.0.1:3030, creating the container if it is missing
./setup.py down      # stop it; nothing is removed
```

Data lives in the `snowtest-data` volume and survives restarts. After a code
change, `./setup.py redeploy` rebuilds the image, replaces the container,
reloads the example tables and runs the instance's own self test, failing the
command if a check does; `--no-verify` leaves that out. `./setup.py --help`
has the rest.

Then open <http://localhost:3030/> for the connection values, client snippets,
live state, and the buttons that clear or reseed the data.

## Use it

```python
import snowflake.connector

conn = snowflake.connector.connect(
    account="SNOWTEST", user="test", password="test",
    host="127.0.0.1", port=3030, protocol="http",
    database="SNOWTEST", schema="PUBLIC", warehouse="SNOWTEST_WH",
)
```

```bash
curl -s -X POST 'http://localhost:3030/api/v2/statements' \
  -H 'Authorization: Bearer test' -H 'Content-Type: application/json' \
  -d '{"statement":"SELECT 1 AS n"}'
```

- Any credential is accepted, including a JWT signed by any key.
  `./setup.py redeploy --public-key rsa_key.pub --users DBT_SVC` starts verifying
  them instead.
- Five example tables sit under `SNOWTEST.EXAMPLES`. `POST /_snowtest/seed` with
  an empty body reloads them; `POST /_snowtest/reset` gives you a clean account.
- No TLS, and the control endpoints are unauthenticated: keep it on localhost.

Everything else — every supported statement, every flag, every known gap — is on
the running server itself: `/operations`, `/configuration`, `/troubleshooting`.
`/self-test` runs a set of checks against the instance it is served from, and
`/settings` changes how it behaves while it runs.

## Translation fidelity

Emulating Snowflake with DuckDB means a few constructs are translated by
approximation rather than exactly: variant paths, `FLATTEN`,
`CONVERT_TIMEZONE`, the session clock (`CURRENT_TIMESTAMP`, `LOCALTIMESTAMP`,
`GETDATE`) and `TIMESTAMP_LTZ`/`TIMESTAMP_TZ` casts and `TO_TIMESTAMP_LTZ`/`_TZ`
(DuckDB ignores the session `TIMEZONE`), `TYPEOF` (DuckDB type names), and
`DATEADD` on a visible DATE (`::DATE`, `CAST(… AS DATE)`, `CURRENT_DATE`) by a
day-or-larger unit (returns a timestamp), `TO_VARCHAR`/`TO_CHAR` of a visible
timestamp without a format (DuckDB's text, not `.FF3`), `HASH` (different
values) and `ARRAY_CONSTRUCT` with a `NULL` element. Every statement gets a verdict for that — `verified`, or
`approximate` with the constructs named — and faithful rewrites (`IFF`, `NVL2`,
`ZEROIFNULL`, `NULLIFZERO`, `DIV0`, `DECODE`, `GREATEST`/`LEAST`,
`OBJECT_CONSTRUCT`, `PARSE_JSON`, `DATEDIFF`) are not reported, because noise is
how a reader learns to skip the warnings that matter.

Some differences are fixed rather than reported: NULLs sort first in a
descending `ORDER BY` (so `ROW_NUMBER() … ORDER BY x DESC` keeps the row
Snowflake keeps), `GREATEST`/`LEAST` return NULL when any argument is NULL,
`OBJECT_CONSTRUCT` drops SQL-NULL pairs and sorts keys, `PARSE_JSON` fails on
malformed JSON (`TRY_PARSE_JSON` returns NULL), and `DATEDIFF(week, …)` counts
Monday boundaries. One divergence has no rewrite to hang a note on, because it
is an operator rather than a function: integer division returns a double (`1/3`
→ `0.3333333333333333`, not `0.333333`). It is reported whenever both operands
are integer literals — the only case this pass can type without the catalog — so
`AMOUNT/2` stays silent instead of guessing at a column's type.

`--fidelity <off|report|strict>` (or `SNOWTEST_FIDELITY`) decides what happens:

| mode | what it does |
| --- | --- |
| `off` | no fidelity pass; 4.x behaviour end to end |
| `report` | the default: the statement runs and the verdict is recorded |
| `strict` | a statement leaning on an approximation is refused before it runs |

The verdict is written into `QUERY_HISTORY.fidelity` with the timing, grouped by
dbt model in `SNOWFLAKE.ACCOUNT_USAGE.MODEL_FIDELITY`, and shown as a chip in
the Query timings table on the landing page, which can be narrowed to statements
a dbt model sent. `/settings` switches the mode without a restart;
`POST /_snowtest/fidelity` does the same from curl. The reasoning, the upgrade
path for an existing volume and the per-model ledger are all in
[the 5.0.0 release notes](release_notes/5.0.0.md); the constructs added in
5.0.1 are in [its release notes](release_notes/5.0.1.md).

MIT, see [LICENSE](LICENSE).
