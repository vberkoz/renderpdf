#!/bin/bash

set -e

export AWS_PAGER=""

STACK_NAME="renderpdf"
REGION="us-east-1"
PROFILE="basil"
ACCOUNT_ID=$(aws sts get-caller-identity --profile ${PROFILE} --query Account --output text)
ECR_REPO="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${STACK_NAME}"

echo "Building Docker image..."
cd api
docker build --platform linux/amd64 -t ${STACK_NAME}:latest .

echo "Creating ECR repository if not exists..."
aws ecr describe-repositories --repository-names ${STACK_NAME} --region ${REGION} --profile ${PROFILE} 2>/dev/null || \
  aws ecr create-repository --repository-name ${STACK_NAME} --region ${REGION} --profile ${PROFILE}

echo "Logging into ECR..."
aws ecr get-login-password --region ${REGION} --profile ${PROFILE} | docker login --username AWS --password-stdin ${ECR_REPO}

echo "Tagging and pushing image..."
docker tag ${STACK_NAME}:latest ${ECR_REPO}:latest
docker push ${ECR_REPO}:latest

cd ..

echo "Deploying CloudFormation stack..."
if [ -f "parameters.json" ]; then
  aws cloudformation deploy \
    --template-file cloudformation.yaml \
    --stack-name ${STACK_NAME} \
    --capabilities CAPABILITY_IAM \
    --region ${REGION} \
    --profile ${PROFILE} \
    --parameter-overrides file://parameters.json
else
  aws cloudformation deploy \
    --template-file cloudformation.yaml \
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

echo "Waiting for Lambda update to complete..."
aws lambda wait function-updated \
  --function-name ${STACK_NAME}-generate \
  --region ${REGION} \
  --profile ${PROFILE}

echo "Getting stack outputs..."
WEBSITE_BUCKET=$(aws cloudformation describe-stacks --stack-name ${STACK_NAME} --region ${REGION} --profile ${PROFILE} --query 'Stacks[0].Outputs[?OutputKey==`WebsiteBucketName`].OutputValue' --output text 2>/dev/null || echo "")
CLOUDFRONT_ID=$(aws cloudformation describe-stacks --stack-name ${STACK_NAME} --region ${REGION} --profile ${PROFILE} --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDistributionId`].OutputValue' --output text 2>/dev/null || echo "")

if [ -n "$WEBSITE_BUCKET" ]; then
  echo "Deploying landing page to S3..."
  aws s3 sync landing/ s3://${WEBSITE_BUCKET}/ --profile ${PROFILE} --delete --cache-control "no-cache"
  
  if [ -n "$CLOUDFRONT_ID" ]; then
    echo "Invalidating CloudFront cache..."
    aws cloudfront create-invalidation --distribution-id ${CLOUDFRONT_ID} --paths "/*" --profile ${PROFILE} --query 'Invalidation.Id' --output text
  fi
fi

echo "Deployment complete!"
aws cloudformation describe-stacks --stack-name ${STACK_NAME} --region ${REGION} --profile ${PROFILE} --query 'Stacks[0].Outputs' --output json
