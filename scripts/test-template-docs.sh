#!/bin/bash

# Executable form of the template API examples. Keep it aligned with
# landing/docs/api/index.html and README.md.
set -euo pipefail

if [ -z "${RENDERPDF_API_URL:-}" ]; then
  API_URL="https://renderpdf.vberkoz.com/api/v1"
else
  API_URL="$RENDERPDF_API_URL"
fi
API_URL="${API_URL%/}"

if [ -z "${RENDERPDF_API_KEY:-}" ]; then
  echo "RENDERPDF_API_KEY is required" >&2
  exit 2
fi

template_id=""
cleanup() {
  if [ -n "$template_id" ]; then
    curl -sS -o /dev/null -X DELETE "$API_URL/templates/$template_id" \
      -H "Authorization: Bearer $RENDERPDF_API_KEY" || true
  fi
}
trap cleanup EXIT

template=$(curl -sS -X POST "$API_URL/templates" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RENDERPDF_API_KEY" \
  -d '{"name":"Documentation invoice","type":"invoice","html":"<!doctype html><html><body><h1>Invoice {{invoice.number}}</h1><p>{{customer.name}}</p></body></html>"}')
template_id=$(jq -er '.id' <<<"$template")

rendered=$(curl -sS -X POST "$API_URL/render-template" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RENDERPDF_API_KEY" \
  -d "{\"templateId\":\"$template_id\",\"variables\":{\"invoice\":{\"number\":\"INV-1042\"},\"customer\":{\"name\":\"Ada & Sons\"}}}")
pdf_url=$(jq -er '.url' <<<"$rendered")
curl -fsSL "$pdf_url" | file - | grep -q PDF

updated=$(curl -sS -X PUT "$API_URL/templates/$template_id" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RENDERPDF_API_KEY" \
  -d '{"name":"Updated documentation invoice","type":"invoice","html":"<!doctype html><html><body><p>{{customer.name}}</p></body></html>"}')
jq -e '.version == 2' <<<"$updated" >/dev/null

curl -fsS -o /dev/null -X DELETE "$API_URL/templates/$template_id" \
  -H "Authorization: Bearer $RENDERPDF_API_KEY"
template_id=""
echo "Template documentation examples passed"
