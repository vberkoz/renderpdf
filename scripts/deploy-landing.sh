#!/bin/bash

set -e

export AWS_PAGER=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

STACK_NAME="renderpdf"
REGION="us-east-1"
PROFILE="basil"

echo "Getting stack outputs..."
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

echo "Deploying landing page to S3 bucket: ${WEBSITE_BUCKET}"
aws s3 sync "${ROOT_DIR}/landing/" s3://${WEBSITE_BUCKET}/ \
  --profile ${PROFILE} \
  --cache-control "no-cache" \
  --delete

if [ -n "$CLOUDFRONT_ID" ]; then
  echo "Invalidating CloudFront cache (Distribution ID: ${CLOUDFRONT_ID})..."
  INVALIDATION_ID=$(aws cloudfront create-invalidation \
    --distribution-id ${CLOUDFRONT_ID} \
    --paths "/*" \
    --profile ${PROFILE} \
    --query 'Invalidation.Id' \
    --output text)
  echo "Invalidation created: ${INVALIDATION_ID}"
else
  echo "Warning: CloudFront distribution ID not found, skipping cache invalidation"
fi

echo ""
echo "Landing page deployment complete!"
echo "URL: https://$(aws cloudformation describe-stacks \
  --stack-name ${STACK_NAME} \
  --region ${REGION} \
  --profile ${PROFILE} \
  --query 'Stacks[0].Outputs[?OutputKey==`LandingURL`].OutputValue' \
  --output text 2>/dev/null)"
