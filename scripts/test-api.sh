#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

STACK_NAME="renderpdf"
REGION="us-east-1"
PROFILE="basil"

echo "🧪 Starting API tests..."

API_URL=$(aws cloudformation describe-stacks --stack-name ${STACK_NAME} --region ${REGION} --profile ${PROFILE} --query 'Stacks[0].Outputs[?OutputKey==`ApiURL`].OutputValue' --output text 2>/dev/null)

if [ -z "$API_URL" ]; then
  echo "❌ Failed to get API URL from CloudFormation"
  exit 1
fi

API_URL="${API_URL%/}"
TRIAL_RENDER_URL="${API_URL}/trial/render"
TRIAL_QUOTA_URL="${API_URL}/trial/quota"
RENDER_URL="${API_URL}/render"

echo "📍 API URL: $API_URL"

test_trial_quota() {
  local response_file http_code remaining
  response_file=$(mktemp -t renderpdf-trial-quota.XXXXXX)
  trap 'rm -f "${response_file}"' RETURN

  echo -n "Testing trial quota endpoint... "
  http_code=$(curl -sS -o "${response_file}" -w "%{http_code}" "$TRIAL_QUOTA_URL")
  if [ "$http_code" != "200" ]; then
    echo "❌ FAILED (HTTP $http_code)"
    cat "${response_file}"
    return 1
  fi
  remaining=$(jq -r '.remaining // empty' < "${response_file}")
  if ! [[ "$remaining" =~ ^[0-9]+$ ]]; then
    echo "❌ FAILED (invalid quota response)"
    cat "${response_file}"
    return 1
  fi
  echo "✅ PASSED (${remaining} remaining)"
}

test_trial_html() {
  local name=$1
  local html=$2
  local request_file response_file http_code body request_id pdf_url size
  request_file=$(mktemp -t renderpdf-trial-request.XXXXXX)
  response_file=$(mktemp -t renderpdf-trial-response.XXXXXX)
  trap 'rm -f "${request_file}" "${response_file}"' RETURN
  jq -n --arg html "$html" '{html: $html}' > "${request_file}"

  echo -n "Testing $name through the trial endpoint... "

  start=$(date +%s)
  http_code=$(curl -sS -o "${response_file}" -w "%{http_code}" -X POST "$TRIAL_RENDER_URL" \
    -H "Content-Type: application/json" \
    --data-binary @"${request_file}")
  body=$(<"${response_file}")
  end=$(date +%s)
  duration=$((end - start))

  if [ "$http_code" != "200" ]; then
    echo "❌ FAILED (HTTP $http_code)"
    echo "Response: $body"
    return 1
  fi

  request_id=$(jq -r '.requestId // empty' <<<"$body")
  pdf_url=$(jq -r '.url // empty' <<<"$body")
  size=$(jq -r '.size // empty' <<<"$body")

  if [ -z "$pdf_url" ] || [ -z "$size" ]; then
    echo "❌ FAILED (Invalid response)"
    return 1
  fi

  curl -fsSL "$pdf_url" -o "/tmp/test-$request_id.pdf"

  if ! file "/tmp/test-$request_id.pdf" | grep -q "PDF"; then
    echo "❌ FAILED (Invalid PDF)"
    return 1
  fi

  echo "✅ PASSED (${duration}s, ${size} bytes)"
  rm "/tmp/test-$request_id.pdf"
}

test_trial_quota
test_trial_html "Simple HTML" "<h1>Hello World</h1>"

test_template_lifecycle() {
  if [ -z "${RENDERPDF_API_KEY:-}" ]; then
    echo "ℹ️  Skipping authenticated template lifecycle test (set RENDERPDF_API_KEY to enable it)"
    return 0
  fi

  local response template_id="" rendered_url http_code
  local request_file response_file
  request_file=$(mktemp -t renderpdf-template-request.XXXXXX)
  response_file=$(mktemp -t renderpdf-template-response.XXXXXX)
  cleanup_template_lifecycle() {
    if [ -n "${template_id}" ]; then
      curl -sS -o /dev/null -X DELETE "${API_URL}/templates/${template_id}" -H "Authorization: Bearer ${RENDERPDF_API_KEY}" || true
    fi
    rm -f "${request_file}" "${response_file}"
  }
  trap cleanup_template_lifecycle RETURN

  echo -n "Testing template create... "
  cat > "${request_file}" <<'EOF'
{"name":"Deployment smoke template","type":"invoice","html":"<!doctype html><html><body><h1>{{customer.name}}</h1><p>{{invoice.number}}</p></body></html>"}
EOF
  http_code=$(curl -sS -o "${response_file}" -w "%{http_code}" -X POST "${API_URL}/templates" -H "Content-Type: application/json" -H "Authorization: Bearer ${RENDERPDF_API_KEY}" --data-binary @"${request_file}")
  if [ "${http_code}" != "201" ]; then
    echo "❌ FAILED (HTTP ${http_code})"
    cat "${response_file}"
    return 1
  fi
  template_id=$(jq -r '.id // empty' < "${response_file}")
  if [ -z "${template_id}" ]; then
    echo "❌ FAILED (missing template id)"
    return 1
  fi
  echo "✅ PASSED"

  echo -n "Testing template render... "
  cat > "${request_file}" <<EOF
{"version":"1","source":{"type":"template","templateId":"${template_id}","variables":{"customer":{"name":"Ada Lovelace"},"invoice":{"number":"INV-SMOKE-1"}}}}
EOF
  http_code=$(curl -sS -o "${response_file}" -w "%{http_code}" -X POST "${RENDER_URL}" -H "Content-Type: application/json" -H "Authorization: Bearer ${RENDERPDF_API_KEY}" --data-binary @"${request_file}")
  if [ "${http_code}" != "200" ]; then
    echo "❌ FAILED (HTTP ${http_code})"
    cat "${response_file}"
    return 1
  fi
  rendered_url=$(jq -r '.url // empty' < "${response_file}")
  if [ -z "${rendered_url}" ] || ! curl -fsSL "${rendered_url}" | file - | grep -q "PDF"; then
    echo "❌ FAILED (render did not return a PDF)"
    return 1
  fi
  echo "✅ PASSED"

  echo -n "Testing template update... "
  cat > "${request_file}" <<'EOF'
{"name":"Updated deployment smoke template","type":"invoice","html":"<!doctype html><html><body><p>{{customer.name}}</p></body></html>"}
EOF
  http_code=$(curl -sS -o "${response_file}" -w "%{http_code}" -X PUT "${API_URL}/templates/${template_id}" -H "Content-Type: application/json" -H "Authorization: Bearer ${RENDERPDF_API_KEY}" --data-binary @"${request_file}")
  if [ "${http_code}" != "200" ]; then
    echo "❌ FAILED (HTTP ${http_code})"
    cat "${response_file}"
    return 1
  fi
  echo "✅ PASSED"

  echo -n "Testing template delete... "
  http_code=$(curl -sS -o "${response_file}" -w "%{http_code}" -X DELETE "${API_URL}/templates/${template_id}" -H "Authorization: Bearer ${RENDERPDF_API_KEY}")
  if [ "${http_code}" != "204" ]; then
    echo "❌ FAILED (HTTP ${http_code})"
    cat "${response_file}"
    return 1
  fi
  template_id=""
  echo "✅ PASSED"
}

test_template_lifecycle

echo ""
echo "✅ ALL TESTS PASSED"
