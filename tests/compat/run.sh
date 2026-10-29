#!/usr/bin/env bash
# Copyright (c) 2026 Srinivas Chaturvedula

# Boot snowtest, run the Python connector compatibility suite against it, stop it.
set -euo pipefail

cd "$(dirname "$0")/../.."

# The suite prints non-ASCII status text; Windows consoles default to a legacy
# code page and would fail with UnicodeEncodeError without this.
export PYTHONUTF8=1

PORT="${SNOWTEST_TEST_PORT:-18080}"
LOG="${SNOWTEST_TEST_LOG:-/tmp/snowtest-compat.log}"

if [ ! -x .venv/bin/python ]; then
  echo "creating .venv and installing snowflake-connector-python…"
  python3 -m venv .venv
  ./.venv/bin/pip install -q --disable-pip-version-check snowflake-connector-python
fi

echo "building…"
npm run build >/dev/null

# Run the built binary directly: `npx tsx` spawns a child, so killing the
# wrapper leaves an orphaned server holding the port and serving stale code.
echo "starting snowtest on port ${PORT} (log: ${LOG})"
node dist/cli.js --port "${PORT}" --verbose >"${LOG}" 2>&1 &
SERVER_PID=$!

cleanup() {
  if kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

for _ in $(seq 1 80); do
  if curl -sf "http://127.0.0.1:${PORT}/_snowtest/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "server exited during startup:" >&2
    cat "${LOG}" >&2
    exit 1
  fi
  sleep 0.25
done

if ! curl -sf "http://127.0.0.1:${PORT}/_snowtest/health" >/dev/null 2>&1; then
  echo "server never became ready:" >&2
  cat "${LOG}" >&2
  exit 1
fi

set +e
./.venv/bin/python tests/compat/connect_test.py "${PORT}"
STATUS=$?
set -e

if [ "${STATUS}" -ne 0 ]; then
  echo ""
  echo "=== server log (last 60 lines) ==="
  tail -60 "${LOG}"
fi

exit "${STATUS}"
