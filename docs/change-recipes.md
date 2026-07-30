# change-recipes.md

Common modification recipes for AI agents working in this repository.

## Add A New API Endpoint In `api/`

### Files Usually Touched

- `/Users/basilsergius/projects/renderpdf/api/main.go`
- `/Users/basilsergius/projects/renderpdf/api/main_test.go`
- `/Users/basilsergius/projects/renderpdf/infra/cloudformation.yaml`
- `/Users/basilsergius/projects/renderpdf/scripts/deploy.sh`
- `/Users/basilsergius/projects/renderpdf/docs/VERIFICATION.md` if the verification flow changes

### Files Usually Not Touched

- `/Users/basilsergius/projects/renderpdf/auth/**`
- `/Users/basilsergius/projects/renderpdf/dashboard/**`
- `/Users/basilsergius/projects/renderpdf/landing/**`
- `/Users/basilsergius/projects/renderpdf/api/renderpdf`

### Validation Steps

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-api.sh
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-infra.sh
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-shell.sh
```

Optional deployed check:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-deployed-api.sh
```

### Rollback Considerations

- Revert `api/main.go` and any matching route/resource changes in `infra/cloudformation.yaml` together.
- If deployment script behavior changed, revert `scripts/deploy.sh` in the same rollback.
- If the endpoint changed a contract already used by a frontend, revert the caller and server together.

### Common Mistakes

- Adding route logic in a second Go entrypoint instead of `api/main.go`
- Forgetting the matching API Gateway or Lambda wiring in `infra/cloudformation.yaml`
- Editing `api/renderpdf` instead of source files
- Changing the JSON response shape without updating consumers

## Change Auth Logic In `auth/`

### Files Usually Touched

- `/Users/basilsergius/projects/renderpdf/auth/authorizer.go`
- `/Users/basilsergius/projects/renderpdf/auth/api-keys.go`
- `/Users/basilsergius/projects/renderpdf/auth/utils.go`
- `/Users/basilsergius/projects/renderpdf/auth/utils_test.go`
- `/Users/basilsergius/projects/renderpdf/infra/cloudformation.yaml` if auth infra assumptions change
- `/Users/basilsergius/projects/renderpdf/dashboard/login.html`
- `/Users/basilsergius/projects/renderpdf/dashboard/callback.html`
- `/Users/basilsergius/projects/renderpdf/dashboard/app.js` if client behavior changes

### Files Usually Not Touched

- `/Users/basilsergius/projects/renderpdf/landing/**`
- `/Users/basilsergius/projects/renderpdf/auth/authorizer`
- `/Users/basilsergius/projects/renderpdf/auth/api-keys`

### Validation Steps

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-auth.sh
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-infra.sh
```

Manual follow-up:

- Verify the dashboard login redirect
- Verify callback token parsing
- Verify API key generate/list/revoke flow

### Rollback Considerations

- Revert `auth/` code and any paired dashboard token-flow changes together.
- Revert schema or authorizer assumptions in `infra/cloudformation.yaml` if they changed.
- If the auth change altered allowed origins or callback URLs, revert frontend and infra together.

### Common Mistakes

- Breaking build tags by mixing authorizer and API-key code paths
- Changing DynamoDB key assumptions without updating `infra/cloudformation.yaml`
- Claiming automated auth E2E coverage exists when it does not
- Editing the checked-in binaries instead of `authorizer.go` or `api-keys.go`

## Update Dashboard UI

### Files Usually Touched

- `/Users/basilsergius/projects/renderpdf/dashboard/index.html`
- `/Users/basilsergius/projects/renderpdf/dashboard/login.html`
- `/Users/basilsergius/projects/renderpdf/dashboard/callback.html`
- `/Users/basilsergius/projects/renderpdf/dashboard/app.js`
- `/Users/basilsergius/projects/renderpdf/dashboard/style.css`

### Files Usually Not Touched

- `/Users/basilsergius/projects/renderpdf/landing/**`
- `/Users/basilsergius/projects/renderpdf/api/**`
- `/Users/basilsergius/projects/renderpdf/auth/**`

### Validation Steps

Static review:

```bash
cd /Users/basilsergius/projects/renderpdf && sed -n '1,220p' dashboard/login.html
cd /Users/basilsergius/projects/renderpdf && sed -n '1,240p' dashboard/callback.html
cd /Users/basilsergius/projects/renderpdf && sed -n '1,260p' dashboard/app.js
```

Deployment-backed verification if needed:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/deploy.sh
```

### Rollback Considerations

- Revert page markup and `dashboard/app.js` together if UI changes depend on new DOM structure.
- Revert Cognito redirect or token handling changes together across `login.html`, `callback.html`, and `app.js`.

### Common Mistakes

- Treating the dashboard like a bundled frontend app
- Changing hard-coded Cognito or API URLs without checking the rest of the auth flow
- Updating HTML structure without updating DOM selectors in `dashboard/app.js`

## Update Landing Page Copy/Styles

### Files Usually Touched

- `/Users/basilsergius/projects/renderpdf/landing/index.html`
- `/Users/basilsergius/projects/renderpdf/landing/style.css`

### Files Usually Not Touched

- `/Users/basilsergius/projects/renderpdf/dashboard/**`
- `/Users/basilsergius/projects/renderpdf/api/**`
- `/Users/basilsergius/projects/renderpdf/auth/**`

### Validation Steps

Static review:

```bash
cd /Users/basilsergius/projects/renderpdf && sed -n '1,220p' landing/index.html
cd /Users/basilsergius/projects/renderpdf && sed -n '1,220p' landing/style.css
```

Deployment-backed verification if needed:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/deploy-landing.sh
```

### Rollback Considerations

- Revert markup and CSS together if the style changes depend on new structure.
- If copy changes also touched the live API demo behavior, revert the script section in `landing/index.html` too.

### Common Mistakes

- Breaking the embedded demo fetch flow while changing copy
- Treating `landing/` like a second dashboard
- Introducing a build step or framework where the repo expects plain static files

## Modify CloudFormation

### Files Usually Touched

- `/Users/basilsergius/projects/renderpdf/infra/cloudformation.yaml`
- `/Users/basilsergius/projects/renderpdf/infra/parameters.json.example`
- `/Users/basilsergius/projects/renderpdf/scripts/deploy.sh`
- `/Users/basilsergius/projects/renderpdf/docs/ARCHITECTURE.md` if resource boundaries materially change

### Files Usually Not Touched

- `/Users/basilsergius/projects/renderpdf/cloudformation.yaml` directly
- `/Users/basilsergius/projects/renderpdf/parameters.json` unless the task explicitly requires environment-local config changes
- checked-in binaries

### Validation Steps

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-infra.sh
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-shell.sh
```

### Rollback Considerations

- Revert stack template and deploy script changes together if one depends on new outputs or resource names.
- Be especially careful with data-bearing resources; rollback may need to preserve names and schemas rather than remove them.

### Common Mistakes

- Editing the root symlink instead of the canonical file in `infra/`
- Changing stack outputs without updating scripts that query them
- Making destructive resource changes without explicit approval

## Add A New Deployment Or Test Script

### Files Usually Touched

- `/Users/basilsergius/projects/renderpdf/scripts/<name>.sh`
- `/Users/basilsergius/projects/renderpdf/scripts/README.md`
- `/Users/basilsergius/projects/renderpdf/docs/VERIFICATION.md` if it is a verification script
- root wrapper only if the script must be a compatibility entrypoint

### Files Usually Not Touched

- New non-wrapper root scripts
- Existing deploy scripts unless the new script replaces or extends their behavior

### Validation Steps

```bash
cd /Users/basilsergius/projects/renderpdf && bash -n scripts/<name>.sh
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-shell.sh
```

If it is a verification wrapper, also run the wrapped command path when safe.

### Rollback Considerations

- Remove the new script and revert any docs that point to it.
- If a root wrapper was added, revert that wrapper too.
- If the script became part of a documented workflow, update `docs/VERIFICATION.md` and `_prompts/`.

### Common Mistakes

- Creating duplicate deploy or test entrypoints
- Depending on caller cwd instead of script-relative paths
- Forgetting to document the new script in `scripts/README.md`

## Add A New `_prompts/` Module

### Files Usually Touched

- `/Users/basilsergius/projects/renderpdf/_prompts/NN-NAME.md`
- `/Users/basilsergius/projects/renderpdf/_prompts/INDEX.md`
- `/Users/basilsergius/projects/renderpdf/_prompts/README.md` if the top-level usage guidance changes
- `/Users/basilsergius/projects/renderpdf/_prompts/TEMPLATE-MODULE.md` only if the standard prompt shape itself changes

### Files Usually Not Touched

- unrelated numbered prompts
- docs outside `_prompts/` unless the new prompt depends on a new verification or navigation surface

### Validation Steps

```bash
cd /Users/basilsergius/projects/renderpdf && rg -n "NN-|INDEX|TEMPLATE-MODULE|scripts/|infra/|docs/VERIFICATION.md" _prompts
```

Manual checks:

- confirm numbering is unique
- confirm prerequisites reference real files
- confirm verification commands are real

### Rollback Considerations

- Remove the new prompt and undo its entry in `_prompts/INDEX.md`.
- Revert any changed prerequisite chain if the new module was inserted into the workflow order.

### Common Mistakes

- Adding a prompt that references files or tests that do not exist
- Skipping `_prompts/INDEX.md` when adding a new module
- Creating overlapping prompt responsibilities instead of extending an existing module
