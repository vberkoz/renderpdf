# MODULE 8: USER DASHBOARD
**Reference:** 07-AUTH-LAMBDA.md

## Tasks
1. Create `dashboard/` folder structure:
   ```
   dashboard/
   ├── index.html       # Main dashboard page
   ├── login.html       # Login page
   ├── callback.html    # OAuth callback handler
   ├── style.css        # Dashboard styles
   └── app.js           # Dashboard logic
   ```

2. Implement `dashboard/login.html`:
   - Google Sign-In button
   - Redirects to Cognito hosted UI:
     ```javascript
     const authUrl = `${COGNITO_DOMAIN}/oauth2/authorize?` +
       `identity_provider=Google&` +
       `redirect_uri=${CALLBACK_URL}&` +
       `response_type=token&` +  // Implicit grant
       `client_id=${CLIENT_ID}&` +
       `scope=email+openid+profile`;
     ```

3. Implement `dashboard/callback.html`:
   - Parses tokens from URL hash fragment:
     ```javascript
     const hash = window.location.hash.substring(1);
     const params = new URLSearchParams(hash);
     const idToken = params.get('id_token');
     const accessToken = params.get('access_token');
     ```
   - Decodes id_token to get user email
   - Stores tokens in localStorage
   - Redirects to dashboard

4. Implement `dashboard/index.html`:
   - Protected route (checks localStorage for tokens)
   - Header: user email + logout button
   - API Keys section:
     - List existing keys (masked: `sk_...xyz123`)
     - "Generate New Key" button
     - Copy to clipboard button
     - Revoke button (sets isActive=false)
   - Test API section:
     - HTML textarea input
     - "Generate PDF" button
     - Uses selected API key
     - Downloads PDF on success

5. Implement `dashboard/app.js`:
   - Authentication check on page load
   - API key CRUD functions:
     ```javascript
     async function generateApiKey() {
       const response = await fetch(`${API_URL}/api-keys`, {
         method: 'POST',
         headers: { 'Authorization': `Bearer ${idToken}` }
       });
       return response.json();
     }
     ```
   - Token refresh logic (if needed)
   - Logout clears localStorage

6. Implement `dashboard/style.css`:
   - Clean, modern UI (similar to FuelSync)
   - Card-based layout for API keys
   - Mobile responsive
   - Dark/light theme support

## Verification
```bash
open dashboard/login.html
```
Test: login → generate key → test API → logout

## Success Criteria
- Google Sign-In redirects to Cognito
- Tokens parsed from URL hash
- API keys display and generate
- Copy to clipboard works
- Revoke updates UI immediately
- Logout clears session
- Mobile responsive
