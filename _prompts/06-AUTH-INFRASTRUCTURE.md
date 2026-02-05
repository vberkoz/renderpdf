# MODULE 6: AUTHENTICATION INFRASTRUCTURE - IDEMPOTENT
**Reference:** 01-INFRASTRUCTURE.md

**AI Context:** AWS Cognito configuration, OAuth 2.0 implicit grant flow, DynamoDB single-table design
**Focus:** Security best practices, proper token handling, GSI design patterns

## Reasoning
Authentication requirements:
- **User experience**: Google OAuth for familiar login flow
- **Security**: API keys for service access, not user credentials
- **Scalability**: Cognito handles user management automatically
- **Cost**: Implicit grant avoids backend token exchange

Architecture decisions:
- **Implicit grant over authorization code**: Simpler for SPA, tokens in URL hash
- **API keys over JWT**: Easier revocation, usage tracking
- **Single table design**: Efficient queries, cost optimization
- **GSI for key lookup**: Fast API key validation

Security considerations:
- Hash API keys before storage (SHA-256)
- Short-lived Cognito tokens (1 hour)
- API keys don't expire (user-controlled)
- Proper CORS configuration
- No sensitive data in client-side code

Implementation strategy:
- If Cognito missing: Create full auth infrastructure
- If misconfigured: Fix OAuth settings, preserve users
- If table missing: Create with proper GSI design
- Always: Validate Google OAuth configuration

## State Detection
- Check if Cognito User Pool exists
- Verify Google OAuth provider configuration
- Confirm API keys DynamoDB table exists
- Validate Lambda authorizer deployment
- Test API Gateway authorizer integration

## Tasks (Conditional)
1. **If missing**: Update `cloudformation.yaml` to add:
   - AWS Cognito User Pool with Google OAuth provider
   - User Pool Client configured for implicit grant flow
   - User Pool Domain (e.g., `renderpdf-auth`)
   - DynamoDB table for API keys (partition key: `PK`, sort key: `SK`)
   - Lambda authorizer function for API Gateway
   - Update API Gateway to use Lambda authorizer for `/generate` endpoint

2. **If exists**: Update only missing/misconfigured components

3. **Always verify**: Google OAuth configuration:
   - Parameters: `GoogleClientId` and `GoogleClientSecret`
   - Identity provider: Google
   - Scopes: `email`, `openid`, `profile`
   - Callback URLs: dashboard URL + `/auth/callback`
   - Logout URLs: dashboard URL
   - OAuth flows: implicit grant (returns tokens in URL fragment)

4. **Validate**: API Key table schema (single table design):
   - `PK`: `USER#{cognitoSub}` or `APIKEY#{hashedKey}`
   - `SK`: `APIKEY#{keyId}` or `METADATA`
   - `apiKey` (string) - Hashed API key
   - `keyId` (string) - UUID for display
   - `createdAt` (timestamp)
   - `lastUsed` (timestamp)
   - `isActive` (boolean)
   - GSI1PK: `APIKEY#{hashedKey}` for lookup

## Verification
```bash
aws cloudformation validate-template --template-body file://cloudformation.yaml
aws cognito-idp describe-user-pool --user-pool-id <pool-id>
```

## Success Criteria
- Cognito User Pool exists with Google provider
- Implicit grant flow configured correctly
- API keys table with GSI for key lookup
- Lambda authorizer validates API keys
- Outputs include Cognito domain and client ID
