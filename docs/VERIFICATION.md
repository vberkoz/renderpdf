# VERIFICATION.md

Verification index for this repository.

## Current Testable Areas

- `api/`
  - Go package tests exist.
- `auth/`
  - Go package tests exist.
- `infra/`
  - CloudFormation template validation exists.
- deployed API
  - smoke test exists through `scripts/test-api.sh`
  - authenticated persistence integration test exists through `scripts/test-sources-files.sh`
- `analytics/`
  - Node.js syntax and container build validation should run from the analytics folder.

## Standard Verification Commands

### API

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-api.sh
```

Runs:

```bash
cd /Users/basilsergius/projects/renderpdf/api && go test ./...
```

### Auth

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-auth.sh
```

Runs:

```bash
cd /Users/basilsergius/projects/renderpdf/auth && go test ./...
```

### Infrastructure

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-infra.sh
```

Runs:

```bash
cd /Users/basilsergius/projects/renderpdf && aws cloudformation validate-template --template-body file://infra/cloudformation.yaml
```

CloudFormation only accepts 51,200 bytes for an inline template body. The
current template is larger, so set a private temporary-validation bucket to
validate the complete template by URL; the script removes its temporary object
afterwards:

```bash
cd /Users/basilsergius/projects/renderpdf && \
  RENDERPDF_TEMPLATE_VALIDATION_BUCKET='your-private-bucket' \
  ./scripts/verify-infra.sh
```

### Shell Script Syntax

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-shell.sh
```

Runs syntax checks for the deploy, test, and verification wrappers.

### Static UI Structure

```bash
cd /Users/basilsergius/projects/renderpdf && node scripts/verify-static-ui.js
```

Checks every HTML page under `landing/` and `dashboard/` without deployment,
network access, or AWS credentials. It catches duplicate IDs, broken in-page
anchors, dashboard navigation views with no target element, skipped heading
levels, duplicate numbered documentation headings, and missing local stylesheet
references. External stylesheets are intentionally not fetched.

### Deployed API Smoke Test

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-deployed-api.sh
```

Runs:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/test-api.sh
```

To include the authenticated template lifecycle (create, render, update, and
delete), provide a valid API key:

```bash
cd /Users/basilsergius/projects/renderpdf && RENDERPDF_API_KEY='your-key' ./scripts/test-api.sh
```

### Template Documentation Examples

Run the executable public examples against production, or set
`RENDERPDF_API_URL` to another deployed environment:

```bash
cd /Users/basilsergius/projects/renderpdf && RENDERPDF_API_KEY='your-key' ./scripts/test-template-docs.sh
```

### Sources, Files, and Private PDFs Integration Test

This is a real deployed integration test. It creates and updates a saved source,
renders it through the stored-source variant of `/api/v1/render`, verifies that
the resulting PDF requires a signed URL, checks the file record/download path,
and confirms that a second account cannot read the source or PDF.

```bash
cd /Users/basilsergius/projects/renderpdf && \
  RENDERPDF_API_KEY='primary-account-key' \
  RENDERPDF_SECONDARY_API_KEY='different-account-key' \
  ./scripts/test-sources-files.sh
```

Set `RENDERPDF_API_URL` to test a non-default deployed environment. The script
cleans up the source and rendered PDF it creates and never prints source content
or signed URLs. Set `RENDERPDF_TEST_EXPIRED_URL=1` to include the approximately
15-minute signed-URL expiry check.

## Area-by-Area Guidance

### How To Test `api/`

- Run:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-api.sh
```

- Optional deployed check after backend changes:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-deployed-api.sh
```

- Notes:
  - `api/main_test.go` may skip if Chrome is unavailable in the local environment.
  - For package uploads, verify a ZIP containing `index.html`, a relative stylesheet, and a relative image: create it through `/api/v1/files/upload`, PUT the ZIP to `uploadUrl`, then send its `uploadId` in an `upload` source to `/api/v1/render`.
  - Confirm that an archive containing `../` paths or a missing entrypoint receives a 422 response.

### How To Test `auth/`

- Run:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-auth.sh
```

- Notes:
- `scripts/verify-auth.sh` runs the shared-helper tests plus the build-tagged authorizer and API-key-management tests.
  - there is no committed end-to-end auth verification script today

### Analytics

- Run:

```bash
cd /Users/basilsergius/projects/renderpdf/analytics && node --check index.js
```

### Webhooks

- Run:

```bash
cd /Users/basilsergius/projects/renderpdf/webhooks && node --check index.js
```

- After deployment, post an authenticated render request with a test HTTPS webhook endpoint and confirm a `pdf.completed` event arrives. Confirm non-2xx responses are retried and eventually appear in the webhook DLQ.

- Manual checks after deployment:
  - open `/app/stats` and sign in with the configured `StatsAllowedEmail` account
  - confirm aggregate PDF requests and bytes load
  - confirm another Cognito account receives an access-denied response
  - refresh and confirm a `stats_view` event is saved

### How To Test `dashboard/`

- Run the local structural check first:

```bash
cd /Users/basilsergius/projects/renderpdf && node scripts/verify-static-ui.js
```

- Manual verification checklist:
  - review `/Users/basilsergius/projects/renderpdf/dashboard/login.html`
  - review `/Users/basilsergius/projects/renderpdf/dashboard/callback.html`
  - review `/Users/basilsergius/projects/renderpdf/dashboard/index.html`
  - review `/Users/basilsergius/projects/renderpdf/dashboard/app.js`
  - if deployed auth flow testing is intended, use:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/deploy.sh
```

- Then verify manually:
  - login redirect starts correctly
  - callback stores tokens and redirects
  - dashboard loads at `https://renderpdf.vberkoz.com/app/`
  - key list loads
  - key generation works
  - revoke flow works
  - test PDF generation flow works
  - templates load, save, render, and delete without pasting an API key
  - Document JSON sample previews, invalid JSON shows an inline error, and a valid request returns a PDF download link

### How To Test `landing/`

- Run the local structural check first:

```bash
cd /Users/basilsergius/projects/renderpdf && node scripts/verify-static-ui.js
```

- Manual verification checklist:
  - review `/Users/basilsergius/projects/renderpdf/landing/index.html`
  - if deployment-backed verification is intended, use:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/deploy-landing.sh
```

- Then verify manually:
  - landing page loads
  - docs page loads at `https://renderpdf.vberkoz.com/docs/api`
  - legal pages load at `/terms`, `/privacy`, `/refund`, and `/cancellation`
  - demo form submits successfully
  - returned PDF link opens

### How To Validate Infrastructure Safely

- Safe template validation:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-infra.sh
```

- Safe shell syntax validation:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-shell.sh
```

- Notes:
  - template validation checks CloudFormation syntax and structure only
  - it does not prove deploy success

## Missing Coverage

- `dashboard/`
  - no automated UI or auth-flow test script
- `landing/`
  - no browser-based page-level verification script
- `auth/`
  - no committed end-to-end auth verification script such as `test-auth.sh`
- full system
  - no single committed script that verifies auth plus dashboard plus landing end-to-end

## Canonical Verification Script Names

- `/Users/basilsergius/projects/renderpdf/scripts/verify-api.sh`
- `/Users/basilsergius/projects/renderpdf/scripts/verify-auth.sh`
- `/Users/basilsergius/projects/renderpdf/scripts/verify-infra.sh`
- `/Users/basilsergius/projects/renderpdf/scripts/verify-shell.sh`
- `/Users/basilsergius/projects/renderpdf/scripts/verify-static-ui.js`
- `/Users/basilsergius/projects/renderpdf/scripts/verify-deployed-api.sh`
