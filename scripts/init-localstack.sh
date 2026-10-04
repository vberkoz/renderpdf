#!/bin/bash
set -e

REGION="${AWS_REGION:-us-east-1}"

echo "Initializing LocalStack resources for RenderPDF..."

# S3 Buckets
awslocal s3 mb s3://renderpdf-test-pdfs --region "${REGION}" 2>/dev/null || true
awslocal s3 mb s3://renderpdf-test-packages --region "${REGION}" 2>/dev/null || true

# SQS Queues
awslocal sqs create-queue --queue-name renderpdf-webhook-queue --region "${REGION}" 2>/dev/null || true
awslocal sqs create-queue --queue-name renderpdf-batch-queue --region "${REGION}" 2>/dev/null || true

# DynamoDB Usage Table
awslocal dynamodb create-table \
  --table-name renderpdf-test-usage \
  --attribute-definitions AttributeName=requestId,AttributeType=S AttributeName=timestamp,AttributeType=N \
  --key-schema AttributeName=requestId,KeyType=HASH AttributeName=timestamp,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --region "${REGION}" 2>/dev/null || true

# DynamoDB API Keys Table
awslocal dynamodb create-table \
  --table-name renderpdf-test-keys \
  --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --region "${REGION}" 2>/dev/null || true

# DynamoDB Templates Table
awslocal dynamodb create-table \
  --table-name renderpdf-test-templates \
  --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --region "${REGION}" 2>/dev/null || true

# DynamoDB Document Store Table
awslocal dynamodb create-table \
  --table-name renderpdf-test-document-store \
  --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S AttributeName=GSI1PK,AttributeType=S AttributeName=GSI1SK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
  --global-secondary-indexes "IndexName=AccountIndex,KeySchema=[{AttributeName=GSI1PK,KeyType=HASH},{AttributeName=GSI1SK,KeyType=RANGE}],Projection={ProjectionType=ALL}" \
  --billing-mode PAY_PER_REQUEST \
  --region "${REGION}" 2>/dev/null || true

echo "LocalStack resources initialized successfully."
