#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${E2E_PORT:-18787}"
export PORT
export E2E_BASE_URL="${E2E_BASE_URL:-http://127.0.0.1:${PORT}}"

LOG_FILE="$(mktemp -t cf-ai-docs-runn.XXXXXX.log)"
SERVER_PID=""

cleanup() {
	if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
		kill "${SERVER_PID}" 2>/dev/null || true
		wait "${SERVER_PID}" 2>/dev/null || true
	fi
	rm -f "${LOG_FILE}"
}
trap cleanup EXIT

cd "${ROOT_DIR}"

bun src/local-dev.ts >"${LOG_FILE}" 2>&1 &
SERVER_PID="$!"

for _ in {1..80}; do
	if curl -fsS "${E2E_BASE_URL}/health" >/dev/null 2>&1; then
		break
	fi
	if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
		cat "${LOG_FILE}" >&2
		exit 1
	fi
	sleep 0.1
done

if ! curl -fsS "${E2E_BASE_URL}/health" >/dev/null 2>&1; then
	cat "${LOG_FILE}" >&2
	echo "mock server did not become ready: ${E2E_BASE_URL}" >&2
	exit 1
fi

RUNN_BIN="${RUNN_BIN:-runn}"

if command -v "${RUNN_BIN}" >/dev/null 2>&1; then
	"${RUNN_BIN}" run e2e/runn/*.yml
else
	echo "runn is not installed." >&2
	echo "Install with: brew install k1LoW/tap/runn" >&2
	exit 1
fi
