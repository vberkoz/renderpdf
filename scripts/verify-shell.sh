#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${ROOT_DIR}"
bash -n deploy.sh deploy-landing.sh test-api.sh scripts/deploy.sh scripts/deploy-landing.sh scripts/test-api.sh scripts/test-template-docs.sh scripts/verify-api.sh scripts/verify-auth.sh scripts/verify-infra.sh scripts/verify-shell.sh scripts/verify-deployed-api.sh
