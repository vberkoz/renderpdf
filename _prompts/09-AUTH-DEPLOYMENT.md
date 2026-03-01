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
aws s3 ls s3://renderpdf-dashboard-*/
```

## Success Criteria
- All Lambda functions deployed
- Cognito configured with Google
- Dashboard accessible via S3 URL
- CORS configured correctly
- Environment variables set properly

---

## Current Deployment Status

### ✅ Deployed Components

**Infrastructure:**
- S3 buckets: PDFs, landing, dashboard (separate buckets)
- DynamoDB tables: usage tracking, API keys with GSI
- Lambda functions: PDF generation, authorizer, API keys
- API Gateway with custom authorizer
- CloudFront distributions: landing, dashboard
- Route53 DNS records
- SSL certificates
- Cognito User Pool with Google OAuth

**Lambda Functions:**
- `renderpdf-generate` - PDF generation (2048MB, 60s timeout)
- `renderpdf-authorizer` - API key validation (256MB, 10s timeout)
- `renderpdf-apikeys` - API key management (256MB, 10s timeout)

**Frontend:**
- Landing page at https://renderpdf.vberkoz.com
- Dashboard at https://dashboard.renderpdf.vberkoz.com
- API at https://api.renderpdf.vberkoz.com

### 🔧 Required Configuration

**1. Google OAuth Setup:**

Create OAuth 2.0 Client ID in Google Cloud Console:
- Application type: Web application
- Authorized redirect URI:
  ```
  https://renderpdf-auth-653268860643.auth.us-east-1.amazoncognito.com/oauth2/idpresponse
  ```

Update `parameters.json`:
```json
[
  {
    "ParameterKey": "GoogleClientId",
    "ParameterValue": "YOUR_GOOGLE_CLIENT_ID"
  },
  {
    "ParameterKey": "GoogleClientSecret",
    "ParameterValue": "YOUR_GOOGLE_CLIENT_SECRET"
  }
]
```

**2. Update Cognito Callback URL:**

```bash
aws cognito-idp update-user-pool-client \
  --user-pool-id us-east-1_kW5g1rpG7 \
  --client-id 756oip5460mrcai5kptbune4b5 \
  --callback-urls "https://dashboard.renderpdf.vberkoz.com/auth/callback" \
  --logout-urls "https://dashboard.renderpdf.vberkoz.com" \
  --allowed-o-auth-flows implicit \
  --allowed-o-auth-scopes email openid profile \
  --allowed-o-auth-flows-user-pool-client \
  --supported-identity-providers Google \
  --region us-east-1 \
  --profile basil
```

### 📊 AWS Resources

**Cognito:**
- User Pool: `renderpdf-users` (us-east-1_kW5g1rpG7)
- Client ID: 756oip5460mrcai5kptbune4b5
- Domain: renderpdf-auth-653268860643

**DynamoDB Tables:**
- `renderpdf-usage` - PDF generation tracking
- `renderpdf-apikeys` - API key storage with GSI1 for lookups

**S3 Buckets:**
- `renderpdf-pdfs-653268860643` - Generated PDFs
- `renderpdf-website-653268860643` - Landing page
- `renderpdf-dashboard-653268860643` - Dashboard files

### 🚀 Deployment Steps

1. Configure Google OAuth credentials in `parameters.json`
2. Update Cognito callback URL (command above)
3. Run `./deploy.sh` to deploy all changes
4. Wait for DNS/SSL certificate propagation (~5-10 minutes)
5. Test authentication flow at https://dashboard.renderpdf.vberkoz.com
6. Generate API key and test PDF generation

### 🧪 Testing

```bash
# Test PDF generation API
./test-api.sh

# Test Lambda functions
cd api && go test -v
cd ../auth && go test -v

# Validate CloudFormation
aws cloudformation validate-template --template-body file://cloudformation.yaml

# Check deployed files
aws s3 ls s3://renderpdf-dashboard-653268860643/ --profile basil
```

### 📝 Implementation Notes

- All Lambda functions use Docker images stored in ECR
- API Gateway uses custom authorizer for x-api-key validation
- Dashboard uses implicit OAuth grant flow (tokens in URL hash)
- API keys are SHA-256 hashed before storage
- CloudFront provides CDN and SSL termination
- Separate S3 buckets for landing and dashboard
- Dashboard default root object: login.html
