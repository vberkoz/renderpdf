# MODULE 10: AUTHENTICATION E2E TESTING
**Reference:** 09-AUTH-DEPLOYMENT.md

## Tasks
1. Create `test-auth.sh`:
   - Test API key generation endpoint
   - Test API key validation
   - Test PDF generation with API key
   - Test invalid/revoked key rejection
   - Test rate limiting (if implemented)

2. Create `test-dashboard.sh`:
   - Automated browser tests (optional: use Playwright/Puppeteer)
   - Or manual test checklist:
     - [ ] Google login redirects correctly
     - [ ] Dashboard loads after authentication
     - [ ] Generate API key creates new key
     - [ ] Copy to clipboard works
     - [ ] API key works for PDF generation
     - [ ] Revoke key disables access
     - [ ] Logout clears session

## Verification
```bash
./test-auth.sh
```
Output: "AUTH TESTS PASSED ✓"

## Success Criteria
- API key authentication works end-to-end
- Invalid keys are rejected with 401
- Revoked keys cannot be used
- Dashboard flow completes successfully
- All edge cases handled (expired tokens, etc.)
