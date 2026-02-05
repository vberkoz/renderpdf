# MODULE 9: AUTHENTICATION DEPLOYMENT - IDEMPOTENT
**Reference:** 08-DASHBOARD.md

**AI Context:** S3 static website hosting, CORS policy configuration, AWS Systems Manager parameters
**Focus:** Secure credential handling, automated deployment, environment separation

## Reasoning
Auth deployment challenges:
- **Credential security**: Google OAuth secrets must be protected
- **Environment separation**: Dev/prod configurations
- **Static hosting**: Dashboard files need proper CORS
- **Dependency management**: Multiple Lambda functions to deploy

Deployment strategy:
- **Credentials**: Use AWS Systems Manager Parameter Store (encrypted)
- **Build order**: Infrastructure → Lambda functions → Dashboard upload
- **CORS configuration**: Allow dashboard domain for API calls
- **Cache invalidation**: Clear CloudFront/browser caches after updates

Security considerations:
- Never commit OAuth secrets to git
- Use IAM roles for deployment permissions
- Validate HTTPS-only for production
- Proper S3 bucket policies (no public write)

Implementation strategy:
- If deployment missing: Create complete auth deployment
- If credentials missing: Prompt for setup, store securely
- If CORS broken: Fix configuration, test API calls
- Always: Verify dashboard loads and auth flow works

Validation steps:
1. Lambda functions deployed successfully
2. Cognito configured with Google provider
3. Dashboard accessible via S3 URL
4. CORS allows API calls from dashboard
5. OAuth flow completes end-to-end

## State Detection
- Check if auth Lambda functions are deployed
- Verify Google OAuth credentials exist
- Test S3 static website hosting status
- Validate CORS configuration

## Tasks (Conditional)
1. **If missing**: Update `deploy.sh` to:
   - Build auth Lambda functions (authorizer + api-keys)
   - Package both Lambda functions
   - Prompt for Google OAuth credentials (or read from env)
   - Deploy updated CloudFormation stack
   - Output Cognito domain URL and dashboard URL

2. **If missing**: Create `setup-google-oauth.sh`:
   - Instructions to create Google OAuth app
   - Required scopes: email, profile, openid
   - Callback URL format
   - Store credentials in AWS Systems Manager Parameter Store

3. **If needed**: Update S3 bucket to host dashboard:
   - Enable static website hosting
   - Upload dashboard files
   - Configure CORS for API calls

## Verification
```bash
./deploy.sh
aws s3 ls s3://bucket-name/dashboard/
```

## Success Criteria
- All Lambda functions deployed
- Cognito configured with Google
- Dashboard accessible via S3 URL
- CORS configured correctly
- Environment variables set properly
