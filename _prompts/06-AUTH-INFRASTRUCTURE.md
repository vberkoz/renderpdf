# MODULE 6: AUTHENTICATION INFRASTRUCTURE
**Reference:** 01-INFRASTRUCTURE.md

## Tasks
1. Update `cloudformation.yaml` to add:
   - AWS Cognito User Pool with Google OAuth provider
   - User Pool Client configured for implicit grant flow
   - User Pool Domain (e.g., `renderpdf-auth`)
   - DynamoDB table for API keys (partition key: `PK`, sort key: `SK`)
   - Lambda authorizer function for API Gateway
   - Update API Gateway to use Lambda authorizer for `/generate` endpoint

2. Configure Google OAuth:
   - Parameters: `GoogleClientId` and `GoogleClientSecret`
   - Identity provider: Google
   - Scopes: `email`, `openid`, `profile`
   - Callback URLs: dashboard URL + `/auth/callback`
   - Logout URLs: dashboard URL
   - OAuth flows: implicit grant (returns tokens in URL fragment)

3. API Key table schema (single table design):
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
```

## Success Criteria
- Cognito User Pool created with Google provider
- Implicit grant flow configured
- API keys table with GSI for key lookup
- Lambda authorizer validates API keys
- Outputs include Cognito domain and client ID
