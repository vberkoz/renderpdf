#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
EXAMPLES_DIR="${ROOT_DIR}/doc-examples"

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

echo "📍 API URL: $API_URL"

test_html() {
  local name=$1
  local html=$2
  echo -n "Testing $name... "

  start=$(date +%s)
  response=$(curl -s -X POST "$API_URL/render-html" \
    -H "Content-Type: application/json" \
    -d "{\"html\":\"$html\"}")

  http_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/render-html" \
    -H "Content-Type: application/json" \
    -d "{\"html\":\"$html\"}")

  body="$response"
  end=$(date +%s)
  duration=$((end - start))

  if [ "$http_code" != "200" ]; then
    echo "❌ FAILED (HTTP $http_code)"
    echo "Response: $body"
    return 1
  fi

  request_id=$(echo "$body" | grep -o '"requestId":"[^"]*"' | cut -d'"' -f4)
  pdf_url=$(echo "$body" | grep -o '"url":"[^"]*"' | cut -d'"' -f4)
  size=$(echo "$body" | grep -o '"size":[0-9]*' | cut -d':' -f2)

  if [ -z "$pdf_url" ] || [ -z "$size" ]; then
    echo "❌ FAILED (Invalid response)"
    return 1
  fi

  curl -s "$pdf_url" -o "/tmp/test-$request_id.pdf"

  if ! file "/tmp/test-$request_id.pdf" | grep -q "PDF"; then
    echo "❌ FAILED (Invalid PDF)"
    return 1
  fi

  echo "✅ PASSED (${duration}s, ${size} bytes)"
  rm "/tmp/test-$request_id.pdf"
}

test_html "Simple HTML" "<h1>Hello World</h1>"
test_html "Complex HTML" "<!DOCTYPE html><html><head><style>body{font-family:Arial}table{border-collapse:collapse}th,td{border:1px solid black;padding:8px}</style></head><body><h1>Invoice</h1><table><tr><th>Item</th><th>Price</th></tr><tr><td>Service</td><td>\$100</td></tr></table></body></html>"

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
{"templateId":"${template_id}","variables":{"customer":{"name":"Ada Lovelace"},"invoice":{"number":"INV-SMOKE-1"}}}
EOF
  http_code=$(curl -sS -o "${response_file}" -w "%{http_code}" -X POST "${API_URL}/render-template" -H "Content-Type: application/json" -H "Authorization: Bearer ${RENDERPDF_API_KEY}" --data-binary @"${request_file}")
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

if [ -f "${EXAMPLES_DIR}/invoice.html" ]; then
  echo -n "Testing Invoice Example... "
  start=$(date +%s)
  response=$(curl -s -X POST "$API_URL/render-html" \
    -H "Content-Type: application/json" \
    --data-binary @- <<EOF
{"html":$(jq -Rs . < "${EXAMPLES_DIR}/invoice.html")}
EOF
)
  http_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/render-html" \
    -H "Content-Type: application/json" \
    --data-binary @- <<EOF
{"html":$(jq -Rs . < "${EXAMPLES_DIR}/invoice.html")}
EOF
)
  end=$(date +%s)
  duration=$((end - start))

  if [ "$http_code" != "200" ]; then
    echo "❌ FAILED (HTTP $http_code)"
  else
    size=$(echo "$response" | grep -o '"size":[0-9]*' | cut -d':' -f2)
    echo "✅ PASSED (${duration}s, ${size} bytes)"
  fi
fi

if [ -f "${EXAMPLES_DIR}/report.html" ]; then
  echo -n "Testing Report Example... "
  start=$(date +%s)
  response=$(curl -s -X POST "$API_URL/render-html" \
    -H "Content-Type: application/json" \
    --data-binary @- <<EOF
{"html":$(jq -Rs . < "${EXAMPLES_DIR}/report.html")}
EOF
)
  http_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/render-html" \
    -H "Content-Type: application/json" \
    --data-binary @- <<EOF
{"html":$(jq -Rs . < "${EXAMPLES_DIR}/report.html")}
EOF
)
  end=$(date +%s)
  duration=$((end - start))

  if [ "$http_code" != "200" ]; then
    echo "❌ FAILED (HTTP $http_code)"
  else
    size=$(echo "$response" | grep -o '"size":[0-9]*' | cut -d':' -f2)
    echo "✅ PASSED (${duration}s, ${size} bytes)"
  fi
fi

echo ""
echo "✅ ALL TESTS PASSED"
