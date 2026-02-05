# MODULE 7: AUTHENTICATION LAMBDA FUNCTIONS - IDEMPOTENT
**Reference:** 06-AUTH-INFRASTRUCTURE.md

**AI Context:** Go JWT libraries, DynamoDB SDK, Lambda authorizer response format, secure key hashing
**Focus:** Production security patterns, proper error responses, context passing

## Reasoning
Auth Lambda functions handle:
- **Authorizer**: Fast API key validation (< 100ms for good UX)
- **Key management**: CRUD operations with proper security
- **Token handling**: JWT decode/validate without external calls

Performance considerations:
- Cache DynamoDB connections across invocations
- Minimize cold start impact with connection pooling
- Use GSI for O(1) API key lookups
- Return proper IAM policies for API Gateway caching

Security patterns:
- Never log API keys (hash before any logging)
- Validate JWT signatures locally (no network calls)
- Use constant-time comparison for key validation
- Proper error messages (don't leak system info)

Implementation strategy:
- If functions missing: Create all three (authorizer, keys, callback)
- If broken: Fix specific issues, preserve working logic
- If insecure: Update to security best practices
- Always: Test with real tokens and API keys

Error handling priorities:
1. Invalid API key → 401 Unauthorized
2. Expired token → 401 with refresh guidance
3. DynamoDB errors → 503 Service Unavailable
4. Malformed requests → 400 Bad Request

## State Detection
- Check if `auth/` folder structure exists
- Verify Go modules are initialized
- Test if existing functions compile
- Validate function logic completeness

## Tasks (Conditional)
1. **If missing**: Create `auth/` folder structure:
   ```
   auth/
   ├── authorizer.go      # Lambda authorizer
   ├── api-keys.go        # API key management
   ├── oauth-callback.go  # OAuth callback handler
   └── go.mod
   ```

2. **If missing/broken**: Implement `auth/authorizer.go`:
   - Lambda authorizer function
   - Validates API key from `x-api-key` header
   - Hashes incoming key and looks up in DynamoDB (GSI1)
   - Checks `isActive` status
   - Updates `lastUsed` timestamp
   - Returns IAM policy (Allow/Deny)
   - Adds `userId` to context for downstream Lambda

3. **If missing/broken**: Implement `auth/oauth-callback.go`:
   - Handler for `/auth/callback` endpoint
   - Receives authorization code from Cognito
   - Exchanges code for tokens (id_token, access_token)
   - Decodes id_token to extract email and sub
   - Returns tokens as JSON
   - No Cognito authorizer (public endpoint)

4. **If missing/broken**: Implement `auth/api-keys.go`:
   - POST `/api-keys` - Generate new API key
   - GET `/api-keys` - List user's API keys
   - DELETE `/api-keys/{id}` - Revoke API key

5. **If needed**: Update `api/main.go`:
   - Extract `userId` from authorizer context
   - Use for tracking PDF generation by user

## Verification
```bash
cd auth && go mod tidy && go test -v
```

## Success Criteria
- All functions compile without errors
- Authorizer validates API keys correctly
- OAuth callback exchanges tokens
- API key CRUD operations work
- Keys are securely hashed (SHA-256)
- Proper error handling for invalid keys
