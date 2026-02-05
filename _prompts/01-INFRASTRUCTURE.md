# MODULE 1: INFRASTRUCTURE (CloudFormation) - IDEMPOTENT
**Reference:** 00-MASTER-PLAN.md

**AI Context:** CloudFormation YAML syntax, AWS resource definitions, IAM least-privilege
**Focus:** Infrastructure as Code, avoid console-based instructions

## Reasoning
Infrastructure must be:
- **Reproducible**: CloudFormation ensures consistent deployments
- **Secure**: Least-privilege IAM, no public write access
- **Cost-optimized**: S3 lifecycle policies, DynamoDB on-demand
- **Maintainable**: Clear resource naming, proper outputs

Decision logic:
- If stack exists: Validate current state, update only changed resources
- If missing resources: Add incrementally, preserve existing data
- If misconfigured: Fix permissions/settings without recreation
- Always: Validate template syntax before deployment

## State Detection
- Check if `cloudformation.yaml` exists and is valid
- Verify CloudFormation stack status
- Confirm S3 bucket and DynamoDB table exist
- Validate IAM roles and permissions

## Tasks (Conditional)
1. **If missing**: Create CloudFormation template (`cloudformation.yaml`) with:
   - S3 bucket for PDF storage (public read access)
   - DynamoDB table (partition key: `requestId`)
   - Lambda execution role with S3/DynamoDB permissions
   - Lambda function resource
   - API Gateway REST API with `/generate` POST endpoint
2. **If exists**: Validate and update only changed resources
3. **Always**: Output API Gateway URL

## Verification
```bash
aws cloudformation validate-template --template-body file://cloudformation.yaml
aws cloudformation describe-stacks --stack-name renderpdf
```

## Success Criteria
- Template validates successfully
- Stack exists and is in UPDATE_COMPLETE or CREATE_COMPLETE state
- All IAM permissions are minimal (least privilege)
- Outputs section includes API URL
