<!-- Copyright (c) 2026 Srinivas Chaturvedula -->

# snowtest

A Snowflake-compatible stub server, so systems that expect a real Snowflake
account can be tested against a local process instead.

It is **not** a Snowflake replacement. It is a testing simulator: point a
client's host/port at it and it answers the way Snowflake does, well enough for
integration tests, local development and CI — with no account, no warehouse
cost and no network.

```python
import snowflake.connector

conn = snowflake.connector.connect(
    account="SNOWTEST", user="test", password="test",
    host="127.0.0.1", port=3030, protocol="http",
    database="SNOWTEST", schema="PUBLIC", warehouse="SNOWTEST_WH",
)
```

## Quick start

No Node install required — run it as a container. Podman and Docker both work;
`setup.py` handles the build, the port, and the shared stage directory for you:

```bash
./setup.py up        # start it (creating the container only if it is missing), wait until healthy
./setup.py redeploy  # after a code change: replace the container, clear stages, rebuild, seed
                     # --no-rebuild / --no-recreate / --no-seed-examples leave a part out
./setup.py status    # engine, store, machine, Desktop pipe, container state, health
./setup.py reset     # drop all data (persisted files too) and recreate the catalog
./setup.py down        # stop it; nothing is removed (container, volume and stages stay)
```

Data survives restarts: `setup.py` mounts a named volume `<name>-data` and
sets `SNOWTEST_DATA_DIR`, so every database is a DuckDB file there. Pass
`--no-persist` for an in-memory instance that starts clean every time.

Several teams (or branches) can each run their own instance side by side:

```bash
./setup.py up --name team-a --port 3131 --network team-a-net
```

`--name` (default `snowtest`) names the container and derives its data volume
(`team-a-data`) and stage directory (`<repo>/.snowtest/team-a/stages`). Every
subcommand takes the same `--name`/`--port`, e.g. `./setup.py reset --name
team-a --port 3131`. Invalid names or ports are refused.

| Where the client runs | URL |
|---|---|
| host | `http://localhost:3030` (`--port` changes the host side; published on `127.0.0.1` unless `--bind` widens it) |
| another container on `snowtest-network` | `http://snowtest:3030` |

`./setup.py status` answers "is it deployed, and where?" — including which store
it went into, because one Podman machine can hold two (rootful and rootless) and
they have separate containers, volumes and images:

```text
engine     podman
machine    podman-machine-srinivas: running
store      <graphroot from podman info> (rootless)
container  snowtest: running
ports      3030/tcp -> 127.0.0.1:3030
pipe       \\.\pipe\podman-machine-srinivas: ok
health     ok  {"status": "ok", ...}
```

It also exits non-zero when the container answers but the machine's Windows pipe
is missing: that is the state where a shell works and Podman Desktop shows an
empty GUI. `podman machine stop && podman machine start` brings the pipe back.

Open `http://localhost:3030/` in a browser for a one-page reminder of the
connection values, client snippets and limits.

`setup.py` joins `--network` (default `snowtest-network`, created if
missing) and sets `SNOWTEST_PORT=3030`; `compose.yaml` uses the same network,
port and `snowtest-data` volume.

A stopped machine takes the container with it. After `podman machine start`,
`./setup.py up` starts the existing container in place (no rebuild, no recreate);
`podman start snowtest` is the same thing without the summary.

The bare image defaults to port 8080 unless `SNOWTEST_PORT` is set, and to
in-memory storage unless `SNOWTEST_DATA_DIR` is.

By hand, if you would rather see every flag:

```bash
podman build --layers=false --format docker -t snowtest:3.3.0 .
podman network create snowtest-network   # once
podman run -d --name snowtest --network snowtest-network \
  -p 127.0.0.1:3030:3030 -e SNOWTEST_PORT=3030 \
  -v snowtest-data:/var/lib/snowtest/data -e SNOWTEST_DATA_DIR=/var/lib/snowtest/data \
  --userns=keep-id:uid=1000,gid=1000 snowtest:3.3.0
```

`--layers=false` keeps no intermediate images behind, so the image list stays
clean; the trade-off is that each build reruns `npm ci` instead of reusing a
cache. `--format docker` is what records the Dockerfile's health check.

Under Git Bash, prefix these with `MSYS_NO_PATHCONV=1`: MSYS otherwise rewrites
`/var/lib/snowtest/data` into a Windows path and startup fails with
`EACCES … mkdir '/app/C:'`.

`docker build` / `docker run` are the same apart from `--userns`. Compose works
too: `docker compose up -d` or `podman compose up -d`; its stages live in the
`snowtest-stages` volume, which a host-side client cannot reach (see
[Seeds and staged files](#seeds-and-staged-files)). To run from source
instead (needs Node 20+): `npm install && npm start`.

The `/_snowtest/*` endpoints (`reset`, `seed`, `exec`) are unauthenticated and
change the account, so keep the published port on localhost: anything that can
reach it can wipe the data.

Then connect from anything that speaks Snowflake:

```bash
curl -s -X POST 'http://localhost:3030/api/v2/statements' \
  -H 'Authorization: Bearer test' \
  -H 'Content-Type: application/json' \
  -d '{"statement":"SELECT 1 AS n"}' | jq
```

## What it speaks

| Surface | Status | Used by |
|---|---|---|
| Driver protocol (`/session/v1/login-request`, `/queries/v1/query-request`, heartbeat, token refresh, logout, `GET /monitoring/queries/<id>`) | Implemented, including gzip-encoded request bodies; `snowflake-connector-python` 5.1 is pinned in the test suite, 3.16 and 4.8 were checked manually | Python connector, Snowpark, JDBC-style clients |
| Key-pair (JWT) login, with optional signature verification | Implemented — see [Key-pair authentication](#key-pair-service-account-authentication) | dbt, service accounts |
| Connector `execute_async` + `get_results_from_sfqid` | **Not supported** — see Limits | — |
| SQL REST API v2 (`/api/v2/statements`, async handles, cancel) | Implemented | HTTP integrations, curl, custom services |
| SQL execution | DuckDB, with a Snowflake dialect layer, including `LATERAL FLATTEN` / `TABLE(FLATTEN(…))` over `json_each` | — |
| `SHOW` / `DESCRIBE` / `USE` / `ALTER SESSION` | Implemented — incl. `SHOW TERSE OBJECTS/SCHEMAS/TABLES/VIEWS`, `SHOW PRIMARY/UNIQUE/IMPORTED KEYS` (always empty), `[<DB>.]information_schema.{columns,tables,views,schemata,databases}` (incl. Snowflake-only `tables` columns read by `dbt docs generate`) | dbt, BI tools (SQLAlchemy reflection) and driver discovery |
| Account DDL (databases, schemas, warehouses, roles, stages, file formats) | Implemented; file formats are held in memory | — |
| Sequences (`CREATE`/`DROP SEQUENCE`, `seq.NEXTVAL`, `NEXT VALUE FOR`, `SHOW`/`DESCRIBE SEQUENCE`) | Implemented on DuckDB's own sequences; a value is handed out even if the transaction rolls back, as in Snowflake | — |
| `DESCRIBE STAGE`, `DESCRIBE FILE FORMAT`, `SHOW FILE FORMATS` | Implemented — Snowflake's five-column property table for a stage or a format | — |
| `GRANT` / `REVOKE`, `SHOW GRANTS` | Implemented as a record, never as enforcement — see Limits | dbt `grants:` configs |
| Staged files: `CREATE STAGE`, `PUT`, `GET`, `LIST`, `REMOVE`, `COPY INTO` | Implemented via local-filesystem stages | `dbt seed`, staged loads |
| ODBC | **Not supported** | Power BI, Excel, Tableau |

Each Snowflake database maps to its own DuckDB catalog (in memory, or one file
per database under `SNOWTEST_DATA_DIR`), so `DB.SCHEMA.TABLE`
resolves natively and `USE DATABASE`/`USE SCHEMA` behave per session while the
data itself is shared across connections.

Once it is running, the server documents itself: `/operations` lists every
endpoint, statement and function with its gaps and the release each support
arrived in, `/configuration` covers flags,
the launcher, the control plane and staged files, and `/troubleshooting` lists
common failures. All are rendered from the running build, so they cannot
describe a different version. Where this file and those pages disagree, the
pages are right.

## Connecting

### Python connector

```python
import snowflake.connector

conn = snowflake.connector.connect(
    account="SNOWTEST",
    user="test_user",
    password="test_password",
    host="127.0.0.1",
    port=3030,
    protocol="http",          # no TLS by default
    database="SNOWTEST",
    schema="PUBLIC",
    warehouse="SNOWTEST_WH",
)
cur = conn.cursor()
cur.execute("SELECT CURRENT_DATABASE(), CURRENT_SCHEMA()")
print(cur.fetchall())
```

`insecure_mode=True` and `ocsp_fail_open=True` help if your client insists on
OCSP checks.

### Key-pair (service account) authentication

Key-pair RSA is the normal way a service account reaches Snowflake, and it is
what dbt uses. Generate a pair and give the client the private half:

```bash
openssl genrsa -out rsa_key.p8 2048
openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub
```

```python
conn = snowflake.connector.connect(
    account="SNOWTEST",
    user="DBT_SVC",
    authenticator="snowflake_jwt",
    private_key_file="rsa_key.p8",
    host="127.0.0.1", port=3030, protocol="http",
    database="SNOWTEST", schema="PUBLIC",
)
```

By default any credential is accepted — **including a JWT signed by any key** —
which keeps SQL-only tests simple. Register the **public** key and the login
path starts checking like the real thing:

```bash
./setup.py redeploy --public-key rsa_key.pub --users DBT_SVC
```

(`--public-key` sets `SNOWTEST_JWT_PUBLIC_KEY`; `--users` sets the
`SNOWTEST_USERS` login allow-list.)

- a token signed by the matching private key is accepted;
- a token signed by any other key is rejected with `390100` / SQLSTATE `28000`;
- an expired token is rejected;
- the `iss` claim's user must match the login name.

So "does our key-pair setup work, and does a wrong key get refused?" becomes a
real assertion instead of a rubber stamp. `tests/dbt/verify.py` checks both.

### dbt

The bundled project in `tests/dbt/` runs over key-pair auth (`npm run
test:dbt`); see [dbt compatibility](#dbt-compatibility) for what has been
verified.

```yaml
# profiles.yml — what `./setup.py redeploy --public-key … --write-profile DIR` writes
snowtest:
  target: dev
  outputs:
    dev:
      type: snowflake
      account: SNOWTEST
      user: DBT_SVC
      authenticator: snowflake_jwt
      private_key_path: /absolute/path/to/rsa_key.p8
      database: SNOWTEST
      schema: PUBLIC
      warehouse: SNOWTEST_WH
      role: SYSADMIN
      threads: 4
      host: 127.0.0.1     # `snowtest` from another container
      port: 3030
      protocol: http
```

`host`, `port`, `protocol` and `private_key_path` are ordinary dbt-snowflake
profile keys, so nothing in your project changes. Any schema works (dbt creates
it); the bundled `tests/dbt/profiles.yml` uses `DBT_TEST` on port 18081.

What dbt exercises on every run, and what snowtest answers: `SHOW TERSE
SCHEMAS`, `SHOW OBJECTS IN SCHEMA`, `SHOW USER FUNCTIONS`, `DESCRIBE TABLE`,
`CREATE OR REPLACE VIEW`, `CREATE OR REPLACE TRANSIENT TABLE`, `MERGE`,
`BEGIN`/`COMMIT`, and dbt's `/* {...} */` query comments on every statement.

### dbt compatibility

`npm run test:dbt` pins **dbt-core 1.12.7 + dbt-snowflake 1.12.5** in
`tests/dbt/run.sh` and runs them over key-pair auth: `dbt debug`, `dbt seed`
twice, view / table / incremental models, four schema tests, and the stage cycle.

The rows below were checked by hand on an earlier pin (dbt-core 1.12.6,
dbt-snowflake 1.12.4, password auth); the suite does not cover them:

| Command / feature | Result |
|---|---|
| `dbt run`: table with `transient`, `copy_grants`, `cluster_by`, `automatic_clustering` | pass |
| `dbt run`: incremental `delete+insert`, `append` (second run included) | pass |
| `dbt run`: `contract: enforced` with `not_null` / `primary_key` constraints | pass; a NULL in a `not_null` column fails the model |
| `dbt snapshot`: `timestamp` and `check` strategies (second run closes changed rows) | pass |
| `dbt source freshness` (`loaded_at_field`) | pass |
| `dbt docs generate`, `dbt run-operation` | pass |

Not supported: dynamic tables, materialized views, Python models, Iceberg
tables. A `grants:` config runs now: the `GRANT`s are recorded and never
enforced (see Limits). `CREATE TABLE … CLONE` works as a full
copy (see Limits); `dbt clone` has not been run against it, and
`CREATE DATABASE | SCHEMA … CLONE` is refused. Source freshness needs `loaded_at_field`:
warehouse-metadata freshness reads `last_altered`, which is always NULL here. The
adapter's per-model status reads `00000 1` where Snowflake prints `SUCCESS 1`.

### Seeds and staged files

`dbt seed` works: dbt creates the table and loads rows with `INSERT OVERWRITE`
batches, which snowtest answers by clearing and inserting.

Anything that lands in a stage goes through `PUT`/`GET`, using the connector's
local-filesystem stage support — the client copies files straight into the
stage's directory on disk, with no object storage to emulate:

```python
cur.execute("create or replace stage SNOWTEST.PUBLIC.RAW")
cur.execute(f"put file://{path} @SNOWTEST.PUBLIC.RAW/ auto_compress=false")
cur.execute("list @SNOWTEST.PUBLIC.RAW")
cur.execute("""
    copy into SNOWTEST.PUBLIC.ORDERS from @SNOWTEST.PUBLIC.RAW/
    file_format = (type = csv skip_header = 1)
""")
cur.execute(f"get @SNOWTEST.PUBLIC.RAW/ file://{target_dir}/")
```

Each stage owns a directory under `SNOWTEST_STAGE_ROOT`: `<repo>/.snowtest/<name>/stages`
via `setup.py` (bind-mounted at the same path, so a host-side client works), the
`snowtest-stages` volume under compose (reachable only from containers that
mount it at the same path), `/var/lib/snowtest/stages` in the bare image, or a
process-scoped temp directory when run from source. With `SNOWTEST_DATA_DIR`
set, stage definitions are restored at startup; the files are whatever the
stage root still holds.

### TLS

The server speaks plain HTTP. Clients that refuse `http://` need a TLS
terminator in front (nginx, caddy, `stunnel`) or a client configured for
insecure transport. TLS is not built in yet.

## Control plane

| Endpoint | Purpose |
|---|---|
| `GET /_snowtest/health` | Liveness probe |
| `GET /_snowtest/state` | Current databases, schemas, warehouses, roles, sessions |
| `POST /_snowtest/seed` | Run a SQL script (`{"sql": "..."}`) on a scratch session; with no `sql` in the body, load the bundled `data/examples.sql` |
| `POST /_snowtest/reset` | Drop all data, persisted database files included, and recreate the configured catalog |

`POST /_snowtest/reset` between tests is the closest thing to a clean
Snowflake account:

```python
requests.post("http://localhost:3030/_snowtest/reset")
```

The bundled example dataset loads the same way, with an empty body: five tables
under `SNOWTEST.EXAMPLES`, built with `CREATE OR REPLACE`, so reseeding replaces
them rather than appending and a second run leaves the same rows. On the landing
page the `POST /_snowtest/seed` row on the **Control plane** tab is a button that
asks first.

```bash
curl -s -X POST http://localhost:3030/_snowtest/seed \
  -H 'Content-Type: application/json' -d '{}'
```

## Configuration

Flags override environment variables. `setup.py` and `compose.yaml` set
`SNOWTEST_PORT=3030`; the defaults below are the server's own.

| Flag | Env | Default |
|---|---|---|
| `--port` | `SNOWTEST_PORT` | `8080` (`3030` via `setup.py` / compose); `0` picks a free one |
| `--host` | `SNOWTEST_HOST` | `0.0.0.0` |
| `--account` | `SNOWTEST_ACCOUNT` | `SNOWTEST` |
| `--database` | `SNOWTEST_DATABASE` | `SNOWTEST` |
| `--schema` | `SNOWTEST_SCHEMA` | `PUBLIC` |
| `--warehouse` | `SNOWTEST_WAREHOUSE` | `SNOWTEST_WH` |
| `--data-dir` | `SNOWTEST_DATA_DIR` | unset: in memory (`/var/lib/snowtest/data` via `setup.py` / compose) |
| `--verbose` | `SNOWTEST_VERBOSE` | off |
| — | `SNOWTEST_ROLE` | `SYSADMIN` (role handed to a session that does not ask for one) |
| — | `SNOWTEST_STAGE_ROOT` | temp dir, per process |
| — | `SNOWTEST_CLOCK` | unset: the host clock |

`SNOWTEST_DATABASES`, `SNOWTEST_WAREHOUSES`, `SNOWTEST_ROLES` and
`SNOWTEST_USERS` take comma-separated lists.

Bad values stop the server at startup instead of falling back: an unknown flag,
a flag missing its value, a port outside 1–65535 (flag or `SNOWTEST_PORT`), or a
`SNOWTEST_VERBOSE` other than `1`/`true`/`0`/`false`.

With `SNOWTEST_DATA_DIR` set, each database is `<dir>/<name>.duckdb` and stage
definitions are kept in `<dir>/stages.json`; all of it is reattached at startup,
`DROP DATABASE` deletes the file, `DROP DATABASE` / `DROP SCHEMA` also drop the
stages inside, and `POST /_snowtest/reset` deletes them all. A quoted name keeps
its case on disk (`"mydb"` is `mydb.duckdb`); file names are URL-encoded, so
`"my db"` is `my%20db.duckdb`.

`setup.py` flags shared by every subcommand: `--name` (default `snowtest`),
`--port` (host side, default 3030), `--bind` (host address, default `127.0.0.1`:
the control plane is unauthenticated, so widening this is a deliberate act),
`--network` (default `snowtest-network`),
`--persist`/`--no-persist` (default on), `--image`, `--stage-root`,
`--public-key`, `--users`, `--env KEY=VALUE`, `--engine` (default `auto`),
`--selinux` (default `auto`), `--userns` (default `auto`), `--timeout`
(seconds to wait for health, default 60), `--dry-run`.

`SNOWTEST_JWT_PUBLIC_KEY` takes a path to a PEM public key (or inline PEM). When
set, key-pair logins must carry a JWT signed by the matching private key; when
unset, tokens are not verified.

## SQL support

DuckDB supplies real execution: joins, window functions, `QUALIFY`, CTEs,
`MERGE`, recursive CTEs. The dialect layer translates the Snowflake constructs
that appear in practice:

- `IFF`, `NVL`, `NVL2`, `ZEROIFNULL`, `NULLIFZERO`, `DIV0`, `EQUAL_NULL`,
  `DECODE` (NULL matches NULL), `DATEADD`, `DATEDIFF`, `CONVERT_TIMEZONE`,
  `ARRAY_CONSTRUCT`, `OBJECT_CONSTRUCT`, `PARSE_JSON`, `payload:path` variant access
  (`t.v:a.b`, `v:a[0]`, `parse_json(s):k`, quoted keys `v:"Key"` / `v:a."Q"`; a
  key containing `"` is an error). A path cast to string (`::string`/`varchar`/
  `text`, `[TRY_]CAST(... AS ...)`) gives a string unquoted and any other value
  as JSON text. `v:a::string:b` is an error (write `(v:a::variant):b`), as is a
  `:name` bind after a keyword (`LIMIT :n`); bind with `?` or `%s`.
- `LISTAGG` / `ARRAY_AGG ... WITHIN GROUP (ORDER BY ...)`, with the order kept;
  `ARRAY_AGG` skips NULLs and returns `[]` for no rows.
- `CURRENT_TIMESTAMP`, `LOCALTIMESTAMP`, `CURRENT_TIME`, `LOCALTIME`,
  `CURRENT_DATE`, `SYSDATE` (UTC, NTZ), bare or with `()`; precision 0, 3 or 6–9.
- `TO_VARCHAR`/`TO_CHAR`, `TO_DATE`, `TO_TIMESTAMP[_NTZ|_LTZ|_TZ]`, `TO_NUMBER`/
  `TO_DECIMAL`/`TO_NUMERIC`, `TO_DOUBLE`, `TO_BOOLEAN`, `TO_BINARY`, and their
  `TRY_` variants, which return NULL on bad input. Date/time formats are
  translated (`YYYY`, `YY`, `MM`, `MON`, `MMMM`, `DD`, `DY`, `HH24`, `HH12`,
  `AM`/`PM`, `MI`, `SS`, `FF3`, `FF6`, `FF9`, `FF` (= `FF9`), `TZH:TZM`,
  `"quoted text"`); any other element (`HH`, `FF1`, ...), and any number format
  model, is an error naming it.
- `NUMBER`, `DECIMAL`, `NUMERIC` without a scale are `NUMBER(38,0)`, so
  `'1.5'::number` is `2`; `VARIANT`, `OBJECT`, `ARRAY`, `STRING`, `BINARY`,
  `FLOAT`, `TIMESTAMP_NTZ` and friends map to DuckDB types. Types are mapped only
  where a type is named (`::`, `CAST(... AS ...)`, column definitions in
  `CREATE TABLE` / `ALTER TABLE ... ADD | ... TYPE`), so a column called `number`
  stays a column; quoted identifiers are never rewritten. A cast to `TIME`
  accepts `TIMESTAMP_TZ`/`LTZ` (UTC wall clock; the engine runs in UTC whatever
  the host zone) and refuses `24:00:00` (`TRY_CAST` gives NULL). Casts to
  `TIME(n)` truncate to n fractional digits (0–9; 6 and up keep microseconds),
  casts to `TIMESTAMP_NTZ`/`LTZ`/`TZ(0|3)` truncate. Columns need n of 6–9:
  DuckDB stores TIME/TZ in microseconds and rounds `TIMESTAMP(0|3)` on write,
  so a lower precision is an error, never silently wrong. `TIMESTAMP_NTZ(9)` is
  nanoseconds, `(7)`/`(8)` and any other n are an error. `DESCRIBE` reports `(9)`.
  `CREATE TABLE ... AS SELECT x::timestamp_ntz(0)` columns are full precision:
  later fractional INSERT/MERGE values are kept, not truncated.
  `CREATE TABLE` TIME columns
  refuse `24:00:00` on insert, columns added by `ALTER TABLE ... ADD` fail only
  when such a value is read. A `::time` operand is a name, literal (typed too:
  `TIMESTAMP '...'`), call (with `OVER`/`FILTER`/`WITHIN GROUP`), parenthesised
  expression, `CASE ... END`, variant path or earlier cast; anything else, write
  `CAST(... AS TIME)`. Unparseable dates, times and timestamps fail with SQLSTATE
  `22007` (code `100038`; Snowflake's own date/time codes are not reproduced).
- String literals take Snowflake backslash escapes (`'it\'s'`, `'C:\\x'`, `\n`,
  `\t`, `\xhh`, `\uhhhh`, octal); a NUL (`\0`) is refused.
- `TRANSIENT` tables; `CLUSTER BY` and `COPY GRANTS` on `CREATE` are dropped;
  `ALTER TABLE ... CLUSTER BY | DROP CLUSTERING KEY | SUSPEND/RESUME RECLUSTER`
  are accepted no-ops.
- `CREATE TABLE t (col type NOT NULL, ...) AS SELECT` (dbt contracts): NOT NULL
  is enforced, primary/unique/foreign keys are dropped as Snowflake does not
  enforce them; the query runs first, so `CREATE OR REPLACE TABLE t (...) AS
  SELECT ... FROM t` reads the old rows.
- `ALTER TABLE ... RENAME TO` (across schemas and databases too; across
  databases the copy is committed and row-count verified, then the source
  dropped) and `ALTER TABLE ... SWAP WITH` (within one database; across
  databases it is an error).
- `DROP DATABASE` / `DROP SCHEMA` error on a missing object unless `IF EXISTS`;
  `DROP SCHEMA` cascades by default and `RESTRICT` refuses a non-empty schema
  (`002003`, SQLSTATE `2BP01`).
  Dropping the session's current database leaves it with none
  (`CURRENT_DATABASE()` is NULL; unqualified names fail with `090105`, or
  `090106` with a database but no current schema — `IF [NOT] EXISTS` included).
- `BEGIN` / `COMMIT` / `ROLLBACK` are real, on the session's own connection. A
  rolled-back load leaves nothing behind, and a statement that fails inside a
  transaction aborts it until the client rolls back. Account objects (databases,
  schemas, warehouses, roles, stages) are created outside the transaction, so a
  rollback does not undo them.
- A request holding several `;`-separated statements is split and routed per
  statement; separators inside strings, quoted names, comments and `$$…$$` do
  not split. The driver protocol answers with the last result and the SQL API
  with one result per statement. `MULTI_STATEMENT_COUNT` is enforced when the
  client sets it.
- `CREATE TABLE … CLONE …` copies columns and rows into a new table. It is a
  copy, not Snowflake's zero-copy clone; `AT`/`BEFORE` and
  `CREATE DATABASE | SCHEMA … CLONE` are refused rather than approximated.
- `SNOWTEST_CLOCK` freezes the emulated clock (an ISO instant) or shifts it
  (`+30m`, `-2h`, `+1d`). `CURRENT_TIMESTAMP`, `LOCALTIMESTAMP`, `CURRENT_TIME`,
  `LOCALTIME`, `CURRENT_DATE` and `SYSDATE` all follow it, so a test that asks
  for "now" stops depending on the day it runs.
- `USE DATABASE` / `USE SCHEMA` on a missing object fails with `002043`; it
  never creates one.
- `SHOW STAGES` lists the current schema by default, every schema with
  `IN DATABASE [db]`, and everything with `IN ACCOUNT`.
- Unquoted identifiers fold to upper case everywhere, columns and aliases
  included: `select a` returns column `A`, `select a as "x"` returns `x`.

Anything untranslatable is passed through unchanged and fails with an honest
Snowflake-shaped error; syntax recognised but not emulated fails with
`... is not supported on snowtest`. Neither returns silently wrong data.

### Query history

Every statement is timed and noted in `SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY`, so
timings are a table you can query rather than a log line you have to scrape:

```sql
select query_text, total_elapsed_time, rows_produced, execution_status
from snowflake.account_usage.query_history
order by query_id desc limit 20;
```

`total_elapsed_time` is milliseconds of wall clock around the statement, closed
before the row is written, so a query never pays for its own bookkeeping. Failed
statements are in there too, with `execution_status = 'FAIL'` and the code and
message the client was given.

The landing page has a **Query timings** tab for reading it without a client: the
latest 50 statements newest first, under a line giving the table's total row
count (and, past 50, how many of them are on screen), with its own **Refresh**
that updates that pane in place. Nothing is pruned: rows stay until you empty the
table from the **Clear Data** tab (or `POST /_snowtest/queries/clear`), and a
reset empties it along with everything else. Both clear actions ask first, in a
modal; the reset one only enables its button once you type `Delete All Data`
exactly.

## Limits

Being explicit, because a stub that quietly lies is worse than no stub:

- **Not a security boundary by default.** Without `SNOWTEST_JWT_PUBLIC_KEY`
  any password is accepted and tokens are not verified. With a key configured,
  key-pair JWTs are signature-checked — but there is still no user, role or
  privilege model, and no TLS. Never expose it publicly or point real
  credentials at it.
- No warehouse sizing, compute, queues or cost behaviour — timing and cost
  metadata are plausible constants.
- No streams, tasks, dynamic tables, replication, Snowpark, Snowpipe Streaming,
  stored procedures or UDF execution.
- Staged transfer uses local-filesystem stages, which the connector copies into
  directly: no cloud object storage, no presigned URLs, no client-side
  encryption. An upload given a path prefix is flattened to the stage root (the
  client drops the prefix); `LIST`, `COPY INTO`, `GET` and `REMOVE` tolerate a
  directory-style prefix for that reason.
- `COPY INTO` reads CSV, JSON and Parquet through DuckDB's readers. File-format
  options beyond `TYPE`, `SKIP_HEADER`, `FIELD_DELIMITER`,
  `FIELD_OPTIONALLY_ENCLOSED_BY` and `NULL_IF` are ignored.
- User stages (`@~`) and table stages (`@%table`) are not implemented.
- Transactions cover table DDL and DML, per session. Account-level DDL is
  outside them, and there is no cross-session isolation to configure: another
  session sees committed rows only, which is what Snowflake does too.
- `GRANT` and `REVOKE` are recorded, and reported back by `SHOW GRANTS`, and
  nothing else: no statement is authorised or refused, and a grant on an object
  that does not exist is accepted. That is what makes a dbt `grants:` block run
  instead of failing on DuckDB's grammar. A renamed table or view keeps its
  grants under the old name.
- `CREATE FILE FORMAT` is recorded and never applied: `SHOW FILE FORMATS` and
  `DESCRIBE FILE FORMAT` report the `TYPE` and options as written, `COPY INTO`
  still reads its own option list, and a format lives in memory, so a restart
  forgets it.
- Sequences run on DuckDB's own: `CREATE`/`DROP SEQUENCE`, `seq.NEXTVAL`,
  `NEXT VALUE FOR seq`, `seq.CURRVAL`, `SHOW SEQUENCES` and `DESCRIBE SEQUENCE`.
  A value is not rolled back with a failed transaction, which is Snowflake's rule
  too, and `CURRVAL` is per session. `ALTER SEQUENCE … RESTART [WITH n]` and `…
  SET INCREMENT [BY] n` rewrite the definition, keeping the next value on a `SET`.
  `ORDER`/`NOORDER` and `COMMENT` are accepted and not stored; any other option,
  `CACHE` and `RENAME TO` included, is refused rather than ignored.
- A column named `nextval` or `currval` referred to with a qualifier is read as a
  sequence reference: `t.nextval` becomes `nextval('…t')`. A bare `nextval`
  column is untouched.
- `LATERAL FLATTEN` and `TABLE(FLATTEN(…))` become a `json_each` join.
  `recursive => TRUE` is refused, because it changes which rows come back, and
  `SEQ` is the output row number rather than a stored sequence.
- No ODBC.
- `ALTER SCHEMA ... RENAME TO` is not supported (it errors).
- `ALTER SCHEMA ... SWAP WITH` is not supported (it errors).
- Bracket variant paths cast to string (`col['a']::string`) are not supported (they error); write `col:a::string`.
- DuckDB's catalog ignores case, so `"orders"` and `ORDERS` cannot coexist in
  one schema (the second `CREATE` fails), and a query names either one.
  Metadata (`DESCRIBE`, `SHOW`) matches the stored name exactly.
- The `24:00:00` CHECK on `CREATE TABLE` TIME columns is lost when the table
  is renamed across schemas or databases (it is copied), and while it is there
  `ALTER TABLE ... ALTER COLUMN ... TYPE` on that column fails.
- The connector's `execute_async` + `get_results_from_sfqid` result polling
  is not implemented. Use the SQL API v2 async path
  (`POST /api/v2/statements?async=true`, then `GET /api/v2/statements/{handle}`),
  which is tested.
- Result paging returns a single partition; `arrow` result format is not
  emitted (JSON only).
- Client protocols are version-sensitive. `tests/compat/run.sh` pins
  `snowflake-connector-python==5.1.*`; `tests/dbt/run.sh` pins 4.8, because the
  stage-transfer checks only mean something on 4.x. Each installs in one resolve
  with its adapter, so a client release that changes the wire format fails
  loudly.

## Tests

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest: SQL translation, statements run through DuckDB, persistence, config, pages
npm run test:py       # real Python connector suite, on its own server or one already up
npm run test:dbt      # dbt-snowflake over key-pair: debug, run x2, seed x2, test, verify, stages
```

`npm run test:py` is the important one: it connects with the official
`snowflake-connector-python` and checks login, DDL, DML, types, `DESCRIBE`,
`SHOW`, variant access, bind parameters, error codes, async execution, database
isolation and reconnects.

Both Python suites first look for a server that is already healthy on their port
and use it as it stands, so a suite can be pointed at the container you have
open:

```bash
SNOWTEST_TEST_PORT=3030 npm run test:py   # compat suite against the running container
SNOWTEST_DBT_PORT=3030 npm run test:dbt   # dbt against it, needs the public key
```

With nothing answering they start their own on 18080 and 18081 and stop it on
exit; a server they did not start is left running. Written against a container,
the statements land in its `SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY` and stay
there, along with whatever objects the suite creates — the compat suite leaves a
`COMPAT_DB` database, the dbt suite `DBT_TEST` and `STAGING` under `SNOWTEST`. The
dbt suite also checks that an unregistered key is refused, so an instance started
without `SNOWTEST_JWT_PUBLIC_KEY` fails that one check by accepting every key.

`npx tsx scripts/dump-response.ts "SHOW TABLES"` prints a raw driver-protocol
response, which is the fastest way to debug a wire-format question.

## Layout

```
src/server.ts      HTTP routes: driver protocol, SQL API v2, control plane, pages
src/meta.ts        statement router: SHOW/DESCRIBE/USE/DDL vs DuckDB
src/engine.ts      DuckDB instance, per-session connections, catalog metadata
src/persist.ts     SNOWTEST_DATA_DIR: database files and stage definitions
src/stage.ts       stage directories on disk (PUT/GET/LIST/COPY INTO backing)
src/dialect.ts     Snowflake → DuckDB SQL translation
src/types.ts       type mapping and per-surface row encoding
src/protocol.ts    response envelopes
src/errors.ts      Snowflake-shaped errors (code, SQLSTATE)
src/home.ts        the landing page served at /
src/operations.ts  supported-operations reference at /operations, from data
src/usage.ts       /configuration and /troubleshooting pages
src/browse.ts      catalog browser at /browse
src/options.ts     flags and environment, shared by --help and /configuration
src/page.ts        shared HTML shell and stylesheet
src/catalog.ts     databases, schemas, warehouses, roles, stages
src/session.ts     session state and parameter registry
src/config.ts      defaults and environment resolution
src/version.ts     snowtest's own version, read from package.json
src/cli.ts         command-line entry point
setup.py           container lifecycle: up, redeploy, down, status, logs, reset, build
compose.yaml       container service definition
Dockerfile         container image build
data/examples.sql  sample dataset
tests/             vitest units, then the Python connector and dbt suites
scripts/           debugging helpers
docs/              design notes
.snowtest/         per-instance stage directories created by setup.py
```

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Srinivas Chaturvedula.
