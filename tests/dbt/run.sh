#!/usr/bin/env bash
# Copyright (c) 2026 Srinivas Chaturvedula

# End-to-end check: dbt-snowflake authenticating with an RSA key pair against
# snowtest, then running view / table / incremental models and schema tests.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT=$(pwd)

# dbt and the check scripts print non-ASCII text; Windows consoles default to a
# legacy code page and would fail with UnicodeEncodeError without this.
export PYTHONUTF8=1

PORT="${SNOWTEST_DBT_PORT:-18081}"
LOG="/tmp/snowtest-dbt.log"
KEY="$ROOT/tests/dbt/keys/rsa_key.p8"
PUB="$ROOT/tests/dbt/keys/rsa_key.pub"
BAD_KEY="/tmp/snowtest-bad-key.p8"
PY="$ROOT/.venv/bin/python"
DBT="$ROOT/.venv/bin/dbt"
DBT_ARGS=(--project-dir "$ROOT/tests/dbt" --profiles-dir "$ROOT/tests/dbt")

if [ ! -x "$PY" ]; then
  python3 -m venv .venv
fi
# All three pins come from versions.json, the one file that owns them. Stage
# transfers answer with a LOCAL_FS location, which connector 4.x implements and
# 5.x rejects outright ("Unknown location type: LOCAL_FS"), so the staged-file
# checks only mean something on 4.x. Override with SNOWTEST_DBT_CONNECTOR.
CONNECTOR="${SNOWTEST_DBT_CONNECTOR:-$(node -p "require('./versions.json').connector")}"
if [ -z "${CONNECTOR}" ]; then
  echo "versions.json has no \"connector\" pin" >&2
  exit 1
fi

# dbt-snowflake allows a pre-release core, so an unpinned resolve installs a
# beta. The guard compares what .venv holds against the pins, not just whether
# dbt imports, or a stale venv keeps a pair nothing else claims.
DBT_CORE=$(node -p "require('./versions.json').dbt.core")
DBT_ADAPTER=$(node -p "require('./versions.json').dbt.snowflake")
HAVE=$("$PY" - <<'PY' 2>/dev/null || true
from importlib.metadata import version, PackageNotFoundError


def have(name):
    try:
        return version(name)
    except PackageNotFoundError:
        return "missing"


print(have("dbt-core"), have("dbt-snowflake"))
PY
)

if [ "$HAVE" != "$DBT_CORE $DBT_ADAPTER" ]; then
  echo "dbt in .venv: ${HAVE:-nothing}; installing dbt-core ${DBT_CORE} + dbt-snowflake ${DBT_ADAPTER}…"
  # One resolve so the three pins are honoured together.
  "$PY" -m pip install -q --disable-pip-version-check \
    "snowflake-connector-python==${CONNECTOR}" "dbt-snowflake==${DBT_ADAPTER}" "dbt-core==${DBT_CORE}"
fi

if [ ! -f "$KEY" ]; then
  mkdir -p "$(dirname "$KEY")"
  openssl genrsa -out "$KEY" 2048
  openssl rsa -in "$KEY" -pubout -out "$PUB"
fi
[ -f "$BAD_KEY" ] || openssl genrsa -out "$BAD_KEY" 2048 2>/dev/null

export SNOWTEST_PORT="$PORT"
export SNOWTEST_JWT_PUBLIC_KEY="$PUB"
export SNOWTEST_DBT_KEY="$KEY"
export SNOWTEST_BAD_KEY="$BAD_KEY"

rm -rf "$ROOT/tests/dbt/target" "$ROOT/tests/dbt/logs"

healthy() { curl -sf "http://127.0.0.1:${PORT}/_snowtest/health" >/dev/null 2>&1; }

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# A server already answering on this port is used as it stands, so a suite can be
# pointed at a running instance and leave its data and timings behind. Only a
# missing server is started, and only a started one is stopped on exit.
if healthy; then
  echo "reusing the snowtest already answering on port ${PORT}"
  echo "note: this suite logs in with the key pair in tests/dbt/keys and then checks that"
  echo "      an unregistered key is refused, so that instance must have been started with"
  echo "      the matching public key (SNOWTEST_JWT_PUBLIC_KEY). Started without one, it"
  echo "      accepts every key and that negative check fails."
else
  echo "building…"
  npm run build >/dev/null

  echo "starting snowtest on ${PORT} with key-pair verification (log: ${LOG})"
  node dist/cli.js --port "$PORT" --verbose >"$LOG" 2>&1 &
  SERVER_PID=$!

  for _ in $(seq 1 80); do
    healthy && break
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "server exited during startup:" >&2
      cat "$LOG" >&2
      exit 1
    fi
    sleep 0.25
  done
  if ! healthy; then
    echo "server never became ready:" >&2
    cat "$LOG" >&2
    exit 1
  fi
fi

FAILED=0
step() {
  local name="$1"
  shift
  echo ""
  echo "=== ${name} ==="
  if "$@"; then
    return 0
  fi
  FAILED=$((FAILED + 1))
  echo ">>> ${name} FAILED"
  if [ -n "${SERVER_PID}" ]; then
    echo "--- server log (last 25 lines) ---"
    tail -25 "$LOG" || true
  fi
  return 0
}

step "dbt debug (key-pair login + select 1)" "$DBT" debug "${DBT_ARGS[@]}"
step "dbt run #1 (view + table + incremental create)" "$DBT" run "${DBT_ARGS[@]}"
step "dbt run #2 (incremental merge path)" "$DBT" run "${DBT_ARGS[@]}"
step "dbt seed (create + INSERT OVERWRITE with bindings)" "$DBT" seed "${DBT_ARGS[@]}"
step "dbt seed again (overwrite must not duplicate rows)" "$DBT" seed "${DBT_ARGS[@]}"
step "dbt test (not_null / unique)" "$DBT" test "${DBT_ARGS[@]}"
step "query results back over the driver protocol" "$PY" tests/dbt/verify.py
step "staged files (PUT / LIST / COPY INTO / GET)" "$PY" tests/dbt/stage_test.py

if [ "$FAILED" -ne 0 ]; then
  echo ""
  echo "${FAILED} step(s) failed"
  exit 1
fi

echo ""
echo "dbt key-pair suite passed"
