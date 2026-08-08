#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REGION="${AWS_REGION:-us-east-1}"
PROFILE="${AWS_PROFILE:-basil}"

aws cloudformation validate-template \
  --template-body "file://${ROOT_DIR}/infra/cloudformation.yaml" \
  --region "${REGION}" \
  --profile "${PROFILE}"
