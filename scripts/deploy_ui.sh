#!/bin/bash

set -e

export AWS_PAGER=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

STACK_NAME="renderpdf"
REGION="us-east-1"
PROFILE="basil"

echo "=================================================="
echo "  Deploying RenderPDF UI Surfaces"
echo "  - Landing Marketing Site (/)"
echo "  - API Documentation (/docs/api/)"
echo "  - Auth (Login / Callback) (/app/login, /app/callback)"
echo "  - Client Developer Dashboard (/app/)"
echo "  - Admin Governance & Analytics Console (/app/admin/)"
echo "=================================================="

echo "Getting stack outputs for '${STACK_NAME}' (${REGION})..."
WEBSITE_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name ${STACK_NAME} \
  --region ${REGION} \
  --profile ${PROFILE} \
  --query 'Stacks[0].Outputs[?OutputKey==`WebsiteBucketName`].OutputValue' \
  --output text 2>/dev/null || echo "")

CLOUDFRONT_ID=$(aws cloudformation describe-stacks \
  --stack-name ${STACK_NAME} \
  --region ${REGION} \
  --profile ${PROFILE} \
  --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDistributionId`].OutputValue' \
  --output text 2>/dev/null || echo "")

if [ -z "$WEBSITE_BUCKET" ]; then
  echo "Error: Could not find WebsiteBucketName in stack outputs"
  echo "Make sure the CloudFormation stack '${STACK_NAME}' exists and has been deployed"
  exit 1
fi

echo ""
echo "[1/4] Deploying landing, docs, styles, and shared assets..."
echo "      Source: ${ROOT_DIR}/landing/"
echo "      Target: s3://${WEBSITE_BUCKET}/"
aws s3 sync "${ROOT_DIR}/landing/" "s3://${WEBSITE_BUCKET}/" \
  --profile ${PROFILE} \
  --cache-control "no-cache"

echo ""
echo "[2/4] Deploying client dashboard, auth pages, and admin console..."
echo "      Source: ${ROOT_DIR}/dashboard/"
echo "      Target: s3://${WEBSITE_BUCKET}/app/"
aws s3 sync "${ROOT_DIR}/dashboard/" "s3://${WEBSITE_BUCKET}/app/" \
  --profile ${PROFILE} \
  --cache-control "no-cache"

echo ""
echo "[3/4] Verifying critical surface presence on S3..."
aws s3 ls "s3://${WEBSITE_BUCKET}/index.html" --profile ${PROFILE} >/dev/null && echo "  ✔ Landing page (/)"
aws s3 ls "s3://${WEBSITE_BUCKET}/docs/api/index.html" --profile ${PROFILE} >/dev/null && echo "  ✔ API Documentation (/docs/api/)"
aws s3 ls "s3://${WEBSITE_BUCKET}/app/login.html" --profile ${PROFILE} >/dev/null && echo "  ✔ Auth Login (/app/login)"
aws s3 ls "s3://${WEBSITE_BUCKET}/app/callback.html" --profile ${PROFILE} >/dev/null && echo "  ✔ Auth Callback (/app/callback)"
aws s3 ls "s3://${WEBSITE_BUCKET}/app/index.html" --profile ${PROFILE} >/dev/null && echo "  ✔ Client Developer Dashboard (/app/)"
aws s3 ls "s3://${WEBSITE_BUCKET}/app/admin/index.html" --profile ${PROFILE} >/dev/null && echo "  ✔ Admin Governance & Analytics Console (/app/admin/)"

echo ""
if [ -n "$CLOUDFRONT_ID" ]; then
  echo "[4/4] Invalidating CloudFront edge cache (Distribution ID: ${CLOUDFRONT_ID})..."
  INVALIDATION_ID=$(aws cloudfront create-invalidation \
    --distribution-id ${CLOUDFRONT_ID} \
    --paths "/*" \
    --profile ${PROFILE} \
    --query 'Invalidation.Id' \
    --output text)
  echo "  ✔ Invalidation created: ${INVALIDATION_ID}"
else
  echo "[4/4] Warning: CloudFront distribution ID not found, skipping edge cache invalidation"
fi

LANDING_URL=$(aws cloudformation describe-stacks \
  --stack-name ${STACK_NAME} \
  --region ${REGION} \
  --profile ${PROFILE} \
  --query 'Stacks[0].Outputs[?OutputKey==`LandingURL`].OutputValue' \
  --output text 2>/dev/null || echo "")

echo ""
echo "=================================================="
echo "  All UI Surfaces Successfully Deployed!"
if [ -n "$LANDING_URL" ]; then
  echo "  Landing Site:      https://${LANDING_URL}/"
  echo "  API Documentation: https://${LANDING_URL}/docs/api/"
  echo "  Auth / Sign In:    https://${LANDING_URL}/app/login"
  echo "  Client Dashboard:  https://${LANDING_URL}/app/"
  echo "  Admin Console:     https://${LANDING_URL}/app/admin/"
fi
echo "=================================================="
