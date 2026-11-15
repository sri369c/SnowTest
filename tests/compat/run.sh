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
  ./.venv/bin/pip install -q --disable-pip-version-check 'snowflake-connector-python==5.1.*'
fi

healthy() { curl -sf "http://127.0.0.1:${PORT}/_snowtest/health" >/dev/null 2>&1; }

SERVER_PID=""
cleanup() {
  if [ -n "${SERVER_PID}" ] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# A server already answering on this port (a container left running, say) is used
# as it stands: its data and its timings table are the reason to point a suite at
# it, and stopping it here would throw that away. Only a missing server is started.
if healthy; then
  echo "reusing the snowtest already answering on port ${PORT}"
else
  echo "building…"
  npm run build >/dev/null

  # Run the built binary directly: `npx tsx` spawns a child, so killing the
  # wrapper leaves an orphaned server holding the port and serving stale code.
  echo "starting snowtest on port ${PORT} (log: ${LOG})"
  node dist/cli.js --port "${PORT}" --verbose >"${LOG}" 2>&1 &
  SERVER_PID=$!

  for _ in $(seq 1 80); do
    healthy && break
    if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
      echo "server exited during startup:" >&2
      cat "${LOG}" >&2
      exit 1
    fi
    sleep 0.25
  done

  if ! healthy; then
    echo "server never became ready:" >&2
    cat "${LOG}" >&2
    exit 1
  fi
fi

set +e
./.venv/bin/python tests/compat/connect_test.py "${PORT}"
STATUS=$?
set -e

if [ "${STATUS}" -ne 0 ] && [ -n "${SERVER_PID}" ]; then
  echo ""
  echo "=== server log (last 60 lines) ==="
  tail -60 "${LOG}"
fi

exit "${STATUS}"
