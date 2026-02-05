# MODULE 1: INFRASTRUCTURE (CloudFormation)
**Reference:** 00-MASTER-PLAN.md

## Tasks
1. Define CloudFormation template (`cloudformation.yaml`) with:
   - S3 bucket for PDF storage (public read access)
   - DynamoDB table (partition key: `requestId`)
   - Lambda execution role with S3/DynamoDB permissions
   - Lambda function resource
   - API Gateway REST API with `/generate` POST endpoint
2. Output: API Gateway URL

## Verification
```bash
aws cloudformation validate-template --template-body file://cloudformation.yaml
```
Must return valid JSON without errors.

## Success Criteria
- Template validates successfully
- All IAM permissions are minimal (least privilege)
- Outputs section includes API URL
