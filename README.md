<!-- Copyright (c) 2026 Srinivas Chaturvedula -->

# snowtest

A Snowflake-compatible stub server. Point a client's host and port at it and it
answers the way Snowflake does — no account, no warehouse cost, no network — well
enough for integration tests, local development and CI.

## Bring it up

```bash
./setup.py up        # start it on 127.0.0.1:3030, creating the container if it is missing
./setup.py down      # stop it; nothing is removed
```

Data lives in the `snowtest-data` volume and survives restarts. After a code
change, `./setup.py redeploy` rebuilds the image, replaces the container and
reloads the example tables. `./setup.py --help` has the rest.

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
approximation rather than exactly: variant paths, `FLATTEN` and
`CONVERT_TIMEZONE`. Every statement gets a verdict for that — `verified`, or
`approximate` with the constructs named — and faithful rewrites (`IFF`, `NVL2`,
`ZEROIFNULL`, `NULLIFZERO`, `DIV0`, `DECODE`) are not reported, because noise is
how a reader learns to skip the warnings that matter.

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
[the 5.0.0 release notes](release_notes/5.0.0.md).

MIT, see [LICENSE](LICENSE).
