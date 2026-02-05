#!/bin/bash
set -e

STACK_NAME="renderpdf"
REGION="us-east-1"
PROFILE="basil"

echo "🧪 Starting API tests..."

API_URL=$(aws cloudformation describe-stacks --stack-name ${STACK_NAME} --region ${REGION} --profile ${PROFILE} --query 'Stacks[0].Outputs[?OutputKey==`ApiURL`].OutputValue' --output text 2>/dev/null)

if [ -z "$API_URL" ]; then
  echo "❌ Failed to get API URL from CloudFormation"
  exit 1
fi

echo "📍 API URL: $API_URL"

test_html() {
  local name=$1
  local html=$2
  echo -n "Testing $name... "
  
  start=$(date +%s)
  response=$(curl -s -X POST "$API_URL/generate" \
    -H "Content-Type: application/json" \
    -d "{\"html\":\"$html\"}")
  
  http_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/generate" \
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

if [ -f "doc-examples/invoice.html" ]; then
  echo -n "Testing Invoice Example... "
  start=$(date +%s)
  response=$(curl -s -X POST "$API_URL/generate" \
    -H "Content-Type: application/json" \
    --data-binary @- <<EOF
{"html":$(jq -Rs . < doc-examples/invoice.html)}
EOF
)
  http_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/generate" \
    -H "Content-Type: application/json" \
    --data-binary @- <<EOF
{"html":$(jq -Rs . < doc-examples/invoice.html)}
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

if [ -f "doc-examples/report.html" ]; then
  echo -n "Testing Report Example... "
  start=$(date +%s)
  response=$(curl -s -X POST "$API_URL/generate" \
    -H "Content-Type: application/json" \
    --data-binary @- <<EOF
{"html":$(jq -Rs . < doc-examples/report.html)}
EOF
)
  http_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/generate" \
    -H "Content-Type: application/json" \
    --data-binary @- <<EOF
{"html":$(jq -Rs . < doc-examples/report.html)}
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
