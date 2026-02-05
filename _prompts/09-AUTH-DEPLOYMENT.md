# MODULE 9: AUTHENTICATION DEPLOYMENT
**Reference:** 08-DASHBOARD.md

## Tasks
1. Update `deploy.sh` to:
   - Build auth Lambda functions (authorizer + api-keys)
   - Package both Lambda functions
   - Prompt for Google OAuth credentials (or read from env)
   - Deploy updated CloudFormation stack
   - Output Cognito domain URL and dashboard URL

2. Create `setup-google-oauth.sh`:
   - Instructions to create Google OAuth app
   - Required scopes: email, profile, openid
   - Callback URL format
   - Store credentials in AWS Systems Manager Parameter Store

3. Update S3 bucket to host dashboard:
   - Enable static website hosting
   - Upload dashboard files
   - Configure CORS for API calls

## Verification
```bash
./deploy.sh
```
Should output:
- API Gateway URL
- Cognito Domain URL
- Dashboard URL

## Success Criteria
- All Lambda functions deployed
- Cognito configured with Google
- Dashboard accessible via S3 URL
- CORS configured correctly
- Environment variables set properly
