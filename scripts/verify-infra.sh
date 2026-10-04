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
  if [ "${RENDERPDF_REQUIRE_REMOTE_INFRA_VERIFY:-0}" = "1" ]; then
    echo "The template exceeds CloudFormation's 51,200-byte inline limit." >&2
    echo "Set RENDERPDF_TEMPLATE_VALIDATION_BUCKET to a private bucket for a temporary validation object." >&2
    exit 1
  fi

  echo "Notice: CloudFormation template exceeds 51,200-byte inline limit ($(wc -c < "${TEMPLATE_PATH}" | tr -d ' ') bytes)."
  
  # Check local YAML syntax via cfn-lint, python3 yaml, ruby, or structural fallback
  if command -v cfn-lint >/dev/null 2>&1; then
    cfn-lint "${TEMPLATE_PATH}"
    echo "Local CloudFormation syntax validated via cfn-lint."
  elif python3 -c "import yaml; yaml.safe_load(open('${TEMPLATE_PATH}'))" 2>/dev/null; then
    echo "Local YAML syntax validated via python3 yaml.safe_load."
  elif ruby -ryaml -e "YAML.load_file('${TEMPLATE_PATH}')" 2>/dev/null; then
    echo "Local YAML syntax validated via ruby yaml."
  else
    if ! grep -q "AWSTemplateFormatVersion" "${TEMPLATE_PATH}" || ! grep -q "Resources:" "${TEMPLATE_PATH}"; then
      echo "Error: ${TEMPLATE_PATH} missing required CloudFormation sections (AWSTemplateFormatVersion or Resources)." >&2
      exit 1
    fi
    if grep -qE "^<{7}|^>{7}" "${TEMPLATE_PATH}"; then
      echo "Error: ${TEMPLATE_PATH} contains unresolved git merge conflict markers." >&2
      exit 1
    fi
    echo "Local structural validation passed (format version, resources section, conflict markers verified)."
  fi

  echo "To perform live remote validation against AWS API, set RENDERPDF_TEMPLATE_VALIDATION_BUCKET."
  exit 0
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
