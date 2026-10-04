#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

CHECK_MODE=0
if [ "${1:-}" = "--check" ]; then
  CHECK_MODE=1
fi

echo "=== Running formatters across renderpdf ==="

# 1. Format Go code
echo "--> Formatting Go code in api/ and auth/..."
if [ "${CHECK_MODE}" -eq 1 ]; then
  diff_api=$(cd "${ROOT_DIR}/api" && gofmt -l .)
  diff_auth=$(cd "${ROOT_DIR}/auth" && gofmt -l .)
  if [ -n "${diff_api}" ] || [ -n "${diff_auth}" ]; then
    echo "Error: Unformatted Go files found:"
    [ -n "${diff_api}" ] && echo "api/: ${diff_api}"
    [ -n "${diff_auth}" ] && echo "auth/: ${diff_auth}"
    exit 1
  fi
else
  (cd "${ROOT_DIR}/api" && go fmt ./...)
  (cd "${ROOT_DIR}/auth" && go fmt ./...)
fi

# 2. Format JS, JSON, YAML with Prettier if available
if command -v prettier >/dev/null 2>&1; then
  echo "--> Running Prettier..."
  PRETTIER_ARGS="--ignore-path ${ROOT_DIR}/.prettierignore"
  if [ "${CHECK_MODE}" -eq 1 ]; then
    PRETTIER_ACTION="--check"
  else
    PRETTIER_ACTION="--write"
  fi
  (cd "${ROOT_DIR}" && prettier ${PRETTIER_ACTION} ${PRETTIER_ARGS} \
    "analytics/**/*.js" \
    "webhooks/**/*.js" \
    "dashboard/**/*.js" \
    "scripts/**/*.js" \
    "*.json" \
    "*.yaml" \
    "*.yml" \
    >/dev/null 2>&1 || true)
fi

echo "=== Formatting complete ==="
