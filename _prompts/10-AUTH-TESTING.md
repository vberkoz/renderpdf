# MODULE 10: AUTHENTICATION E2E TESTING - IDEMPOTENT
**Reference:** 09-AUTH-DEPLOYMENT.md

**AI Context:** HTTP status code validation, API key lifecycle testing, OAuth flow verification
**Focus:** Comprehensive test coverage, edge case handling, clear failure reporting

## Reasoning
Auth testing must validate:
- **API key lifecycle**: Generate → Use → Revoke → Verify blocked
- **Authorization flow**: Valid keys pass, invalid keys fail
- **Edge cases**: Expired tokens, malformed keys, rate limits
- **Integration**: Full flow from dashboard to PDF generation

Test strategy priorities:
1. **API key validation**: Core security mechanism
2. **Error responses**: Proper HTTP codes and messages
3. **Performance**: Authorizer response times
4. **Security**: Key revocation effectiveness
5. **User flow**: Dashboard → generate key → use for PDF

Automation approach:
- **API tests**: Scriptable with curl/bash
- **Dashboard tests**: Manual checklist (browser-dependent)
- **Security tests**: Attempt unauthorized access
- **Performance tests**: Measure authorizer latency

Implementation strategy:
- If tests missing: Create comprehensive test suite
- If tests outdated: Update for current API endpoints
- If tests failing: Identify root cause, fix issues
- Always: Test both positive and negative scenarios

Critical test cases:
1. Valid API key → 200 response
2. Invalid API key → 401 Unauthorized
3. Revoked API key → 401 Unauthorized
4. Missing API key → 401 Unauthorized
5. Malformed API key → 401 Unauthorized
6. PDF generation with valid key → Success

## State Detection
- Check if test scripts exist
- Verify API endpoints are accessible
- Test existing API keys functionality
- Validate dashboard authentication flow

## Tasks (Conditional)
1. **If missing**: Create `test-auth.sh`:
   - Test API key generation endpoint
   - Test API key validation
   - Test PDF generation with API key
   - Test invalid/revoked key rejection
   - Test rate limiting (if implemented)

2. **If missing**: Create `test-dashboard.sh`:
   - Manual test checklist:
     - [ ] Google login redirects correctly
     - [ ] Dashboard loads after authentication
     - [ ] Generate API key creates new key
     - [ ] Copy to clipboard works
     - [ ] API key works for PDF generation
     - [ ] Revoke key disables access
     - [ ] Logout clears session

3. **If exists**: Run tests and report results

## Verification
```bash
./test-auth.sh
./test-dashboard.sh
```

## Success Criteria
- API key authentication works end-to-end
- Invalid keys are rejected with 401
- Revoked keys cannot be used
- Dashboard flow completes successfully
- All edge cases handled (expired tokens, etc.)
- Output: "AUTH TESTS PASSED ✓"
