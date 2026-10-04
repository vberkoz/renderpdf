#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=== Running all local offline verification suites ==="

echo "--> [1/7] Shell script syntax..."
"${SCRIPT_DIR}/verify-shell.sh"

echo "--> [2/7] API Go tests..."
"${SCRIPT_DIR}/verify-api.sh"

echo "--> [3/7] Auth Go tests..."
"${SCRIPT_DIR}/verify-auth.sh"

echo "--> [4/7] Analytics Node.js unit tests..."
(cd "${ROOT_DIR}/analytics" && npm test)

echo "--> [5/7] Dashboard/Landing tests & Node syntax checks..."
(cd "${ROOT_DIR}" && node --test dashboard/*.test.js)
(cd "${ROOT_DIR}" && node --test landing/*.test.js)
(cd "${ROOT_DIR}" && node --check landing/landing.js)
(cd "${ROOT_DIR}" && node --check landing/playground-templates.js)
(cd "${ROOT_DIR}" && node --check webhooks/index.js)
(cd "${ROOT_DIR}" && node --check auth/account-linker/index.js)

echo "--> [6/7] Static UI integrity..."
(cd "${ROOT_DIR}" && node "${SCRIPT_DIR}/verify-static-ui.js")

echo "--> [7/7] Infrastructure template..."
"${SCRIPT_DIR}/verify-infra.sh"

echo "=== All verification suites passed successfully! ==="
