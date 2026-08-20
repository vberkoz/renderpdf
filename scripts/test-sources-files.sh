#!/bin/bash

# Exercises the deployed persistence surface with two real API-key identities.
# It deliberately avoids printing request bodies, document content, or signed URLs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REGION="${AWS_REGION:-us-east-1}"
PROFILE="${AWS_PROFILE:-basil}"
STACK_NAME="${RENDERPDF_STACK_NAME:-renderpdf}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_command aws
require_command curl
require_command file
require_command jq

: "${RENDERPDF_API_KEY:?Set RENDERPDF_API_KEY to a primary API key.}"
: "${RENDERPDF_SECONDARY_API_KEY:?Set RENDERPDF_SECONDARY_API_KEY to an API key for a different account.}"

API_URL="${RENDERPDF_API_URL:-}"
if [ -z "${API_URL}" ]; then
  API_URL="$(aws cloudformation describe-stacks --stack-name "${STACK_NAME}" --region "${REGION}" --profile "${PROFILE}" --query 'Stacks[0].Outputs[?OutputKey==`ApiURL`].OutputValue' --output text)"
fi
API_URL="${API_URL%/}"
if [ -z "${API_URL}" ] || [ "${API_URL}" = "None" ]; then
  echo "Could not determine the deployed API URL." >&2
  exit 1
fi

response_file="$(mktemp -t renderpdf-sources-files-response.XXXXXX)"
pdf_file="$(mktemp -t renderpdf-sources-files-output.XXXXXX)"
source_id=""
file_id=""

cleanup() {
  if [ -n "${file_id}" ]; then
    curl -sS -o /dev/null -X DELETE "${API_URL}/files/${file_id}" -H "Authorization: Bearer ${RENDERPDF_API_KEY}" || true
  fi
  if [ -n "${source_id}" ]; then
    curl -sS -o /dev/null -X DELETE "${API_URL}/sources/${source_id}" -H "Authorization: Bearer ${RENDERPDF_API_KEY}" || true
  fi
  rm -f "${response_file}" "${pdf_file}"
}
trap cleanup EXIT

api_request() {
  local method="$1"
  local path="$2"
  local key="$3"
  local payload="${4:-}"
  local args=(-sS -o "${response_file}" -w "%{http_code}" -X "${method}" "${API_URL}${path}" -H "Authorization: Bearer ${key}")
  if [ -n "${payload}" ]; then
    args+=(-H "Content-Type: application/json" --data-binary "${payload}")
  fi
  curl "${args[@]}"
}

expect_status() {
  local expected="$1"
  local actual="$2"
  local name="$3"
  if [ "${actual}" != "${expected}" ]; then
    echo "FAIL: ${name} (HTTP ${actual}, expected ${expected})" >&2
    jq -c . < "${response_file}" 2>/dev/null || true
    exit 1
  fi
  echo "PASS: ${name}"
}

source_definition="$(jq -cn '{name:"sources-files-integration",definition:{version:"1",source:{type:"html",content:"<main><h1>{{customer.name}}</h1></main>"},css:"body { font-family: Arial, sans-serif; }",data:{customer:{name:"Default customer"}},options:{format:"A4",margin:"18mm"}}}')"

code="$(api_request POST /sources "${RENDERPDF_API_KEY}" "${source_definition}")"
expect_status 201 "${code}" "create saved source"
source_id="$(jq -r '.id // empty' < "${response_file}")"
if [[ ! "${source_id}" =~ ^src_ ]] || jq -e 'has("definition")' < "${response_file}" >/dev/null; then
  echo "FAIL: source creation returned an invalid or content-bearing metadata response" >&2
  exit 1
fi

code="$(api_request GET /sources "${RENDERPDF_API_KEY}")"
expect_status 200 "${code}" "list saved sources"
jq -e --arg id "${source_id}" '.sources | any(.id == $id)' < "${response_file}" >/dev/null

code="$(api_request GET "/sources/${source_id}" "${RENDERPDF_API_KEY}")"
expect_status 200 "${code}" "read source metadata"
jq -e --arg id "${source_id}" '.id == $id and (has("definition") | not)' < "${response_file}" >/dev/null

code="$(api_request GET "/sources/${source_id}" "${RENDERPDF_SECONDARY_API_KEY}")"
expect_status 404 "${code}" "deny cross-account source access"

updated_definition="$(jq -cn '{name:"sources-files-integration-updated",definition:{version:"1",source:{type:"html",content:"<main><h1>{{customer.name}}</h1></main>"},css:"body { font-family: Arial, sans-serif; }",data:{customer:{name:"Updated default"}},options:{format:"A4",margin:"18mm"}}}')"
code="$(api_request PUT "/sources/${source_id}" "${RENDERPDF_API_KEY}" "${updated_definition}")"
expect_status 200 "${code}" "update saved source"

render_request="$(jq -cn --arg id "${source_id}" '{version:"1",source:{type:"stored",id:$id},data:{customer:{name:"Integration customer"}}}')"
code="$(api_request POST /render "${RENDERPDF_API_KEY}" "${render_request}")"
expect_status 200 "${code}" "render stored source"
request_id="$(jq -r '.requestId // empty' < "${response_file}")"
pdf_url="$(jq -r '.url // empty' < "${response_file}")"
if [ -z "${request_id}" ] || [ -z "${pdf_url}" ] || [[ "${pdf_url}" != *"X-Amz-Signature="* ]]; then
  echo "FAIL: render did not return a signed private PDF URL" >&2
  exit 1
fi
file_id="file_${request_id}"

curl -fsSL "${pdf_url}" -o "${pdf_file}"
if ! file "${pdf_file}" | grep -q 'PDF'; then
  echo "FAIL: signed URL did not return a PDF" >&2
  exit 1
fi
unsigned_url="${pdf_url%%\?*}"
unsigned_code="$(curl -sS -o /dev/null -w "%{http_code}" "${unsigned_url}")"
if [ "${unsigned_code}" -lt 400 ]; then
  echo "FAIL: rendered PDF is publicly accessible" >&2
  exit 1
fi
echo "PASS: PDF requires a signed URL"

code="$(api_request GET /files "${RENDERPDF_API_KEY}")"
expect_status 200 "${code}" "list private files"
jq -e --arg id "${file_id}" '.files | any(.id == $id and .kind == "rendered_pdf")' < "${response_file}" >/dev/null

code="$(api_request GET "/files/${file_id}/download" "${RENDERPDF_API_KEY}")"
expect_status 200 "${code}" "issue signed PDF download"
download_url="$(jq -r '.url // empty' < "${response_file}")"
if [ -z "${download_url}" ] || [[ "${download_url}" != *"X-Amz-Expires="* ]]; then
  echo "FAIL: file download did not return an expiring signed URL" >&2
  exit 1
fi

if [ "${RENDERPDF_TEST_EXPIRED_URL:-0}" = "1" ]; then
  expiry_seconds="$(printf '%s' "${download_url}" | sed -n 's/.*[?&]X-Amz-Expires=\\([0-9][0-9]*\\).*/\\1/p')"
  if [ -z "${expiry_seconds}" ]; then
    echo "FAIL: could not determine signed URL expiry" >&2
    exit 1
  fi
  echo "Waiting ${expiry_seconds}s to verify signed URL expiry..."
  sleep "$((expiry_seconds + 5))"
  expired_code="$(curl -sS -o /dev/null -w "%{http_code}" "${download_url}")"
  if [ "${expired_code}" -lt 400 ]; then
    echo "FAIL: signed PDF URL remained valid after its expiry" >&2
    exit 1
  fi
  echo "PASS: expired signed URL is denied"
fi

code="$(api_request GET "/files/${file_id}/download" "${RENDERPDF_SECONDARY_API_KEY}")"
expect_status 404 "${code}" "deny cross-account file download"

code="$(api_request DELETE "/files/${file_id}" "${RENDERPDF_API_KEY}")"
expect_status 204 "${code}" "delete private PDF"
file_id=""

code="$(api_request DELETE "/sources/${source_id}" "${RENDERPDF_API_KEY}")"
expect_status 204 "${code}" "delete saved source"
source_id=""

echo "All sources/files/private-PDF integration tests passed."
