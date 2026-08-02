#!/bin/bash

set -e

export AWS_PAGER=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMPLATE_FILE="${ROOT_DIR}/infra/cloudformation.yaml"
PARAMETERS_FILE="${ROOT_DIR}/parameters.json"
FALLBACK_PARAMETERS_FILE="${ROOT_DIR}/infra/parameters.json"

STACK_NAME="renderpdf"
ANALYTICS_FUNCTION_NAME="${STACK_NAME}-analytics-node"
REGION="us-east-1"
PROFILE="basil"
ACCOUNT_ID=$(aws sts get-caller-identity --profile ${PROFILE} --query Account --output text)
ECR_REPO="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${STACK_NAME}"

push_image_with_retry() {
  local image="$1"
  local attempt=1
  local max_attempts=3

  while true; do
    if docker push "${image}"; then
      return 0
    fi

    if [ "${attempt}" -ge "${max_attempts}" ]; then
      return 1
    fi

    local delay=$((attempt * 5))
    echo "Push failed for ${image}; retrying in ${delay}s..."
    sleep "${delay}"
    attempt=$((attempt + 1))
  done
}

echo "Building Docker image..."
cd "${ROOT_DIR}/api"
docker build --platform linux/amd64 -t ${STACK_NAME}:latest .

echo "Building auth Lambda images..."
cd "${ROOT_DIR}/auth"
docker build --platform linux/amd64 -f Dockerfile.authorizer -t ${STACK_NAME}-authorizer:latest .
docker build --platform linux/amd64 -f Dockerfile.apikeys -t ${STACK_NAME}-apikeys:latest .

ANALYTICS_ZIP="$(mktemp -t renderpdf-analytics.XXXXXX).zip"
trap 'rm -f "${ANALYTICS_ZIP}"' EXIT
echo "Packaging native Node.js analytics Lambda..."
cd "${ROOT_DIR}/analytics"
zip -q -j "${ANALYTICS_ZIP}" index.js package.json

echo "Creating ECR repository if not exists..."
aws ecr describe-repositories --repository-names ${STACK_NAME} --region ${REGION} --profile ${PROFILE} 2>/dev/null || \
  aws ecr create-repository --repository-name ${STACK_NAME} --region ${REGION} --profile ${PROFILE}

aws ecr describe-repositories --repository-names ${STACK_NAME}-authorizer --region ${REGION} --profile ${PROFILE} 2>/dev/null || \
  aws ecr create-repository --repository-name ${STACK_NAME}-authorizer --region ${REGION} --profile ${PROFILE}

aws ecr describe-repositories --repository-names ${STACK_NAME}-apikeys --region ${REGION} --profile ${PROFILE} 2>/dev/null || \
  aws ecr create-repository --repository-name ${STACK_NAME}-apikeys --region ${REGION} --profile ${PROFILE}

echo "Logging into ECR..."
aws ecr get-login-password --region ${REGION} --profile ${PROFILE} | docker login --username AWS --password-stdin ${ECR_REPO}

echo "Tagging and pushing image..."
docker tag ${STACK_NAME}:latest ${ECR_REPO}:latest
push_image_with_retry "${ECR_REPO}:latest"

docker tag ${STACK_NAME}-authorizer:latest ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${STACK_NAME}-authorizer:latest
push_image_with_retry "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${STACK_NAME}-authorizer:latest"

docker tag ${STACK_NAME}-apikeys:latest ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${STACK_NAME}-apikeys:latest
push_image_with_retry "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${STACK_NAME}-apikeys:latest"

echo "Deploying CloudFormation stack..."
if [ -f "${PARAMETERS_FILE}" ]; then
  aws cloudformation deploy \
    --template-file "${TEMPLATE_FILE}" \
    --stack-name ${STACK_NAME} \
    --capabilities CAPABILITY_IAM \
    --region ${REGION} \
    --profile ${PROFILE} \
    --parameter-overrides "file://${PARAMETERS_FILE}"
elif [ -f "${FALLBACK_PARAMETERS_FILE}" ]; then
  aws cloudformation deploy \
    --template-file "${TEMPLATE_FILE}" \
    --stack-name ${STACK_NAME} \
    --capabilities CAPABILITY_IAM \
    --region ${REGION} \
    --profile ${PROFILE} \
    --parameter-overrides "file://${FALLBACK_PARAMETERS_FILE}"
else
  aws cloudformation deploy \
    --template-file "${TEMPLATE_FILE}" \
    --stack-name ${STACK_NAME} \
    --capabilities CAPABILITY_IAM \
    --region ${REGION} \
    --profile ${PROFILE}
fi

echo "Updating Lambda function with new image..."
aws lambda update-function-code \
  --function-name ${STACK_NAME}-generate \
  --image-uri ${ECR_REPO}:latest \
  --region ${REGION} \
  --profile ${PROFILE} \
  --query 'LastUpdateStatus' \
  --output text

aws lambda update-function-code \
  --function-name ${STACK_NAME}-trial-generate \
  --image-uri ${ECR_REPO}:latest \
  --region ${REGION} \
  --profile ${PROFILE} \
  --query 'LastUpdateStatus' \
  --output text

aws lambda update-function-code \
  --function-name ${STACK_NAME}-authorizer \
  --image-uri ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${STACK_NAME}-authorizer:latest \
  --region ${REGION} \
  --profile ${PROFILE} \
  --query 'LastUpdateStatus' \
  --output text 2>/dev/null || echo "Authorizer function not yet created"

aws lambda update-function-code \
  --function-name ${STACK_NAME}-apikeys \
  --image-uri ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${STACK_NAME}-apikeys:latest \
  --region ${REGION} \
  --profile ${PROFILE} \
  --query 'LastUpdateStatus' \
  --output text 2>/dev/null || echo "API keys function not yet created"

aws lambda update-function-code \
  --function-name ${ANALYTICS_FUNCTION_NAME} \
  --zip-file fileb://${ANALYTICS_ZIP} \
  --region ${REGION} \
  --profile ${PROFILE} \
  --query 'LastUpdateStatus' \
  --output text 2>/dev/null || echo "Analytics function not yet created"

echo "Waiting for Lambda update to complete..."
aws lambda wait function-updated \
  --function-name ${STACK_NAME}-generate \
  --region ${REGION} \
  --profile ${PROFILE}

aws lambda wait function-updated \
  --function-name ${STACK_NAME}-trial-generate \
  --region ${REGION} \
  --profile ${PROFILE}

aws lambda wait function-updated \
  --function-name ${ANALYTICS_FUNCTION_NAME} \
  --region ${REGION} \
  --profile ${PROFILE} 2>/dev/null || true

echo "Getting stack outputs..."
WEBSITE_BUCKET=$(aws cloudformation describe-stacks --stack-name ${STACK_NAME} --region ${REGION} --profile ${PROFILE} --query 'Stacks[0].Outputs[?OutputKey==`WebsiteBucketName`].OutputValue' --output text 2>/dev/null || echo "")
CLOUDFRONT_ID=$(aws cloudformation describe-stacks --stack-name ${STACK_NAME} --region ${REGION} --profile ${PROFILE} --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDistributionId`].OutputValue' --output text 2>/dev/null || echo "")
if [ -z "$WEBSITE_BUCKET" ]; then
  echo "Error: Could not find WebsiteBucketName in stack outputs"
  exit 1
fi

if [ -n "$WEBSITE_BUCKET" ]; then
  echo "Deploying landing page to S3..."
  aws s3 sync "${ROOT_DIR}/landing/" s3://${WEBSITE_BUCKET}/ --profile ${PROFILE} --cache-control "no-cache"
  echo "Deploying dashboard app to main site..."
  aws s3 sync "${ROOT_DIR}/dashboard/" s3://${WEBSITE_BUCKET}/app/ --profile ${PROFILE} --cache-control "no-cache"
fi

if [ -n "$CLOUDFRONT_ID" ]; then
  echo "Invalidating landing CloudFront cache..."
  aws cloudfront create-invalidation --distribution-id ${CLOUDFRONT_ID} --paths "/*" --profile ${PROFILE} --query 'Invalidation.Id' --output text
fi

echo "Deployment complete!"
aws cloudformation describe-stacks --stack-name ${STACK_NAME} --region ${REGION} --profile ${PROFILE} --query 'Stacks[0].Outputs' --output json
