# MODULE 7: AUTHENTICATION LAMBDA FUNCTIONS
**Reference:** 06-AUTH-INFRASTRUCTURE.md

## Tasks
1. Create `auth/` folder structure:
   ```
   auth/
   ├── authorizer.go      # Lambda authorizer
   ├── api-keys.go        # API key management
   ├── oauth-callback.go  # OAuth callback handler
   └── go.mod
   ```

2. Implement `auth/authorizer.go`:
   - Lambda authorizer function
   - Validates API key from `x-api-key` header
   - Hashes incoming key and looks up in DynamoDB (GSI1)
   - Checks `isActive` status
   - Updates `lastUsed` timestamp
   - Returns IAM policy (Allow/Deny)
   - Adds `userId` to context for downstream Lambda

3. Implement `auth/oauth-callback.go`:
   - Handler for `/auth/callback` endpoint
   - Receives authorization code from Cognito
   - Exchanges code for tokens (id_token, access_token)
   - Decodes id_token to extract email and sub
   - Returns tokens as JSON
   - No Cognito authorizer (public endpoint)

4. Implement `auth/api-keys.go`:
   - POST `/api-keys` - Generate new API key
     - Requires Cognito authentication
     - Generates UUID for keyId
     - Generates secure random API key
     - Hashes key before storage
     - Stores in DynamoDB with user's Cognito sub
     - Returns unhashed key (only time it's visible)
   - GET `/api-keys` - List user's API keys
     - Query by `PK=USER#{sub}`
     - Returns masked keys (last 4 chars visible)
   - DELETE `/api-keys/{id}` - Revoke API key
     - Sets `isActive=false`

5. Update `api/main.go`:
   - Extract `userId` from authorizer context
   - Use for tracking PDF generation by user

## Verification
```bash
cd auth && go test -v
```

## Success Criteria
- Authorizer validates API keys correctly
- OAuth callback exchanges tokens
- API key CRUD operations work
- Keys are securely hashed (SHA-256)
- Proper error handling for invalid keys
