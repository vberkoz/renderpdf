# MODULE 8: USER DASHBOARD - IDEMPOTENT
**Reference:** 07-AUTH-LAMBDA.md

**AI Context:** Browser localStorage, URL hash parsing, JWT decode (client-side), CORS handling
**Focus:** Client-side token management, secure storage patterns, error handling

## Reasoning
Dashboard must handle:
- **OAuth flow**: Implicit grant with hash fragment parsing
- **Token management**: Store securely, handle expiration
- **API key lifecycle**: Generate, display (once), revoke
- **User experience**: Clear feedback, error recovery

Security considerations:
- Tokens in localStorage (acceptable for implicit grant)
- API keys shown only once (copy-to-clipboard)
- No sensitive data in URL or console logs
- Proper logout (clear all stored data)

UX flow optimization:
1. **Login**: Redirect to Cognito → Google → callback
2. **Token parsing**: Extract from URL hash, store locally
3. **Dashboard load**: Check tokens, redirect if missing
4. **Key management**: Generate/list/revoke with clear feedback
5. **API testing**: Built-in form to test PDF generation

Implementation strategy:
- If missing: Create complete auth flow
- If broken: Fix specific issues (token parsing, API calls)
- If outdated: Update to match current API endpoints
- Always: Test full flow from login to PDF generation

Error scenarios to handle:
- OAuth errors (user cancellation, invalid config)
- Expired tokens (redirect to login)
- API failures (network, server errors)
- Invalid responses (malformed JSON)

## State Detection
- Check if `dashboard/` folder structure exists
- Verify HTML/CSS/JS files are complete
- Test authentication flow functionality
- Validate API integration works

## Tasks (Conditional)
1. **If missing**: Create `dashboard/` folder structure:
   ```
   dashboard/
   ├── index.html       # Main dashboard page
   ├── login.html       # Login page
   ├── callback.html    # OAuth callback handler
   ├── style.css        # Dashboard styles
   └── app.js           # Dashboard logic
   ```

2. **If missing/broken**: Implement authentication pages:
   - `login.html` - Google Sign-In with Cognito redirect
   - `callback.html` - Parse tokens from URL hash
   - `index.html` - Protected dashboard with API key management

3. **If missing/broken**: Implement `app.js`:
   - Authentication check on page load
   - API key CRUD functions
   - Token refresh logic
   - Logout functionality

4. **If missing/outdated**: Implement `style.css`:
   - Clean, modern UI
   - Card-based layout for API keys
   - Mobile responsive
   - Dark/light theme support

5. **If exists**: Test and update only broken functionality

## Verification
```bash
open dashboard/login.html
# Manual test: login → generate key → test API → logout
```

## Success Criteria
- Google Sign-In redirects to Cognito correctly
- Tokens parsed from URL hash successfully
- API keys display and generate properly
- Copy to clipboard works
- Revoke updates UI immediately
- Logout clears session
- Mobile responsive design
