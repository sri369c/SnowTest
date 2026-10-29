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
./setup.py up        # build, start, wait until healthy, seed example tables, print the dbt profile
./setup.py redeploy  # after a code change: down, reset, rebuild, up (+ seed; --no-seed-examples skips)
./setup.py status    # container state plus /_snowtest/health
./setup.py down      # stop and remove
```

| Where the client runs | URL |
|---|---|
| host | `http://localhost:3030` (`--port` changes the host side) |
| another container on `snowtest-network` | `http://snowtest:3030` |

Open `http://localhost:3030/` in a browser for a one-page reminder of the
connection values, client snippets and limits.

`setup.py` joins `--network` (default `snowtest-network`, created if
missing) and sets `SNOWTEST_PORT=3030`; `compose.yaml` does the same. The bare
image defaults to port 8080 unless `SNOWTEST_PORT` is set.

By hand, if you would rather see every flag:

```bash
podman build -t snowtest:1.0.0 .
podman network create snowtest-network   # once
podman run -d --name snowtest --network snowtest-network \
  -p 3030:3030 -e SNOWTEST_PORT=3030 \
  --userns=keep-id:uid=1000,gid=1000 snowtest:1.0.0
```

`docker build` / `docker run` are the same apart from `--userns`. Compose works
too: `docker compose up -d` or `podman compose up -d`. To run from source
instead (needs Node 20+): `npm install && npm start`.

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
| Driver protocol (`/session/v1/login-request`, `/queries/v1/query-request`, heartbeat, token refresh, logout, `/monitoring/queries`) | Implemented, verified against `snowflake-connector-python` 4.8 and 5.1, including gzip-encoded request bodies | Python connector, Snowpark, JDBC-style clients |
| Key-pair (JWT) login, with optional signature verification | Implemented — see [Key-pair authentication](#key-pair-service-account-authentication) | dbt, service accounts |
| Connector `execute_async` + `get_results_from_sfqid` | **Not supported** — see Limits | — |
| SQL REST API v2 (`/api/v2/statements`, async handles, cancel) | Implemented | HTTP integrations, curl, custom services |
| SQL execution | DuckDB, with a Snowflake dialect layer | — |
| `SHOW` / `DESCRIBE` / `USE` / `ALTER SESSION` | Implemented — incl. `SHOW TERSE OBJECTS/SCHEMAS/TABLES/VIEWS`, `SHOW PRIMARY/UNIQUE/IMPORTED KEYS` (always empty), `[<DB>.]information_schema.{columns,tables,views,schemata}` (incl. Snowflake-only `tables` columns read by `dbt docs generate`) | dbt, BI tools (SQLAlchemy reflection) and driver discovery |
| Account DDL (databases, schemas, warehouses, roles, stages) | Implemented | — |
| Staged files: `CREATE STAGE`, `PUT`, `GET`, `LIST`, `REMOVE`, `COPY INTO` | Implemented via local-filesystem stages | `dbt seed`, staged loads |
| ODBC | **Not supported** | Power BI, Excel, Tableau |

Each Snowflake database maps to its own DuckDB catalog, so `DB.SCHEMA.TABLE`
resolves natively and `USE DATABASE`/`USE SCHEMA` behave per session while the
data itself is shared across connections.

Once it is running, the server documents itself: `/operations` lists every
endpoint, statement and function with its gaps, and `/usage` covers
configuration, the launcher, staged files and troubleshooting. Both are rendered
from the running build, so they cannot describe a different version. Where this
file and those pages disagree, the pages are right.

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
./setup.py up --recreate --public-key rsa_key.pub --users DBT_SVC
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

Verified end to end against **dbt-core 1.12 + dbt-snowflake 1.12** with key-pair
auth: `dbt debug`, `dbt run` (view, table and incremental models — including the
second run's `merge`), `dbt test`, and re-querying the results all pass. The
project lives in `tests/dbt/`; `npm run test:dbt` runs the whole flow.

```yaml
# profiles.yml — what `./setup.py up --public-key … --write-profile DIR` writes
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
SCHEMAS`, `SHOW TERSE OBJECTS IN SCHEMA`, `SHOW USER FUNCTIONS`, `DESCRIBE
TABLE`, `CREATE OR REPLACE VIEW`, `CREATE OR REPLACE TRANSIENT TABLE`,
`MERGE`, transactions, and dbt's `/* {...} */` query comments on every statement.

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

Each stage owns a directory under `SNOWTEST_STAGE_ROOT`: `<repo>/.snowtest/stages`
via `setup.py` (bind-mounted at the same path), `/var/lib/snowtest/stages` in the
bare image, or a process-scoped temp directory when run from source.

### TLS

The server speaks plain HTTP. Clients that refuse `http://` need a TLS
terminator in front (nginx, caddy, `stunnel`) or a client configured for
insecure transport. TLS is not built in yet.

## Control plane

| Endpoint | Purpose |
|---|---|
| `GET /_snowtest/health` | Liveness probe |
| `GET /_snowtest/state` | Current databases, schemas, warehouses, roles, sessions |
| `POST /_snowtest/seed` | Run a SQL script (`{"sql": "..."}`) on a scratch session |
| `POST /_snowtest/reset` | Drop all data and recreate the configured catalog |

`POST /_snowtest/reset` between tests is the closest thing to a clean
Snowflake account:

```python
requests.post("http://localhost:3030/_snowtest/reset")
```

## Configuration

Flags override environment variables. `setup.py` and `compose.yaml` set
`SNOWTEST_PORT=3030`; the defaults below are the server's own.

| Flag | Env | Default |
|---|---|---|
| `--port` | `SNOWTEST_PORT` | `8080` (`3030` via `setup.py` / compose) |
| `--host` | `SNOWTEST_HOST` | `0.0.0.0` |
| `--account` | `SNOWTEST_ACCOUNT` | `SNOWTEST` |
| `--database` | `SNOWTEST_DATABASE` | `SNOWTEST` |
| `--schema` | `SNOWTEST_SCHEMA` | `PUBLIC` |
| `--warehouse` | `SNOWTEST_WAREHOUSE` | `SNOWTEST_WH` |
| `--verbose` | `SNOWTEST_VERBOSE` | off |
| — | `SNOWTEST_STAGE_ROOT` | temp dir, per process |

`SNOWTEST_DATABASES`, `SNOWTEST_WAREHOUSES`, `SNOWTEST_ROLES` and
`SNOWTEST_USERS` take comma-separated lists.

`SNOWTEST_JWT_PUBLIC_KEY` takes a path to a PEM public key (or inline PEM). When
set, key-pair logins must carry a JWT signed by the matching private key; when
unset, tokens are not verified.

## SQL support

DuckDB supplies real execution: joins, window functions, `QUALIFY`, CTEs,
`MERGE`, recursive CTEs. The dialect layer translates the Snowflake constructs
that appear in practice:

`IFF`, `NVL`, `NVL2`, `ZEROIFNULL`, `NULLIFZERO`, `DIV0`, `EQUAL_NULL`,
`DECODE`, `LISTAGG ... WITHIN GROUP`, `DATEADD`, `DATEDIFF`, `CONVERT_TIMEZONE`, `TO_VARCHAR`,
`TO_NUMBER`, `TO_DATE`, `TO_TIMESTAMP`, `TO_BOOLEAN`, `ARRAY_CONSTRUCT`,
`OBJECT_CONSTRUCT`, `PARSE_JSON`, `payload:path` variant access,
`::string`/`::number`/`::variant` casts, `NUMBER`/`VARIANT`/`TIMESTAMP_NTZ`
column types, `TRANSIENT` tables, `CLUSTER BY`, `COPY GRANTS`.

Anything untranslatable is passed through unchanged and fails with an honest
Snowflake-shaped error rather than silently returning wrong data.

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
- No ODBC.
- The connector's `execute_async` + `get_results_from_sfqid` result polling
  is not implemented. Use the SQL API v2 async path
  (`POST /api/v2/statements?async=true`, then `GET /api/v2/statements/{handle}`),
  which is tested.
- Result paging returns a single partition; `arrow` result format is not
  emitted (JSON only).
- Client protocols are version-sensitive. The suite pins
  `snowflake-connector-python` and will fail loudly if a connector release
  changes the wire format.

## Tests

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest: dialect translation
npm run test:py       # boots the server, runs the real Python connector suite
npm run test:dbt      # dbt-snowflake over key-pair: debug, run, run, seed, test, stages
```

`npm run test:py` is the important one: it starts the server, connects with the
official `snowflake-connector-python`, and checks login, DDL, DML, types,
`DESCRIBE`, `SHOW`, variant access, bind parameters, error codes, async
execution, database isolation and reconnects.

`npx tsx scripts/dump-response.ts "SHOW TABLES"` prints a raw driver-protocol
response, which is the fastest way to debug a wire-format question.

## Layout

```
src/server.ts      HTTP routes: driver protocol, SQL API v2, control plane, pages
src/meta.ts        statement router: SHOW/DESCRIBE/USE/DDL vs DuckDB
src/engine.ts      DuckDB instance, per-session connections, catalog metadata
src/dialect.ts     Snowflake → DuckDB SQL translation
src/types.ts       type mapping and per-surface row encoding
src/protocol.ts    response envelopes
src/home.ts        the landing page served at /
src/operations.ts  supported-operations reference at /operations, from data
src/usage.ts       configuration and troubleshooting at /usage
src/browse.ts      catalog browser at /browse
src/options.ts     flags and environment, shared by --help and /usage
src/page.ts        shared HTML shell and stylesheet
src/catalog.ts     databases, schemas, warehouses, roles, stages
src/session.ts     session state and parameter registry
src/config.ts      defaults and environment resolution
src/cli.ts         command-line entry point
setup.py           container lifecycle: build, up, down, status, logs, reset
compose.yaml       container service definition
Dockerfile         container image build
data/examples.sql  sample dataset
tests/             vitest units, then the Python connector and dbt suites
scripts/           debugging helpers
docs/              design notes
```

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Srinivas Chaturvedula.
