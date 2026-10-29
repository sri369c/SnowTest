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
  "$PY" -m pip install -q --disable-pip-version-check snowflake-connector-python
fi
if ! "$PY" -c "import dbt.adapters.snowflake" >/dev/null 2>&1; then
  echo "installing dbt-snowflake into .venv…"
  "$PY" -m pip install -q --disable-pip-version-check dbt-snowflake
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

echo "building…"
npm run build >/dev/null

echo "starting snowtest on ${PORT} with key-pair verification (log: ${LOG})"
node dist/cli.js --port "$PORT" --verbose >"$LOG" 2>&1 &
SERVER_PID=$!
cleanup() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

for _ in $(seq 1 80); do
  curl -sf "http://127.0.0.1:${PORT}/_snowtest/health" >/dev/null 2>&1 && break
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "server exited during startup:" >&2
    cat "$LOG" >&2
    exit 1
  fi
  sleep 0.25
done
if ! curl -sf "http://127.0.0.1:${PORT}/_snowtest/health" >/dev/null 2>&1; then
  echo "server never became ready:" >&2
  cat "$LOG" >&2
  exit 1
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
  echo "--- server log (last 25 lines) ---"
  tail -25 "$LOG" || true
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
