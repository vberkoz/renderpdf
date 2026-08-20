#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REGION="${AWS_REGION:-us-east-1}"
PROFILE="${AWS_PROFILE:-basil}"
TEMPLATE_PATH="${ROOT_DIR}/infra/cloudformation.yaml"
INLINE_TEMPLATE_LIMIT=51200

if [ "$(wc -c < "${TEMPLATE_PATH}")" -le "${INLINE_TEMPLATE_LIMIT}" ]; then
  aws cloudformation validate-template \
    --template-body "file://${TEMPLATE_PATH}" \
    --region "${REGION}" \
    --profile "${PROFILE}"
  exit 0
fi

if [ -z "${RENDERPDF_TEMPLATE_VALIDATION_BUCKET:-}" ]; then
  echo "The template exceeds CloudFormation's 51,200-byte inline limit." >&2
  echo "Set RENDERPDF_TEMPLATE_VALIDATION_BUCKET to a private bucket for a temporary validation object." >&2
  exit 1
fi

validation_key="validation/cloudformation-$(date +%s)-$$.yaml"
cleanup() {
  aws s3 rm "s3://${RENDERPDF_TEMPLATE_VALIDATION_BUCKET}/${validation_key}" --region "${REGION}" --profile "${PROFILE}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

aws s3 cp "${TEMPLATE_PATH}" "s3://${RENDERPDF_TEMPLATE_VALIDATION_BUCKET}/${validation_key}" --region "${REGION}" --profile "${PROFILE}" >/dev/null
aws cloudformation validate-template \
  --template-url "https://${RENDERPDF_TEMPLATE_VALIDATION_BUCKET}.s3.${REGION}.amazonaws.com/${validation_key}" \
  --region "${REGION}" \
  --profile "${PROFILE}"
