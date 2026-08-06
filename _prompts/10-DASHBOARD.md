# PROMPT 10: DASHBOARD

## Purpose

- Maintain the authenticated static dashboard in `dashboard/`.
- Preserve the Cognito redirect flow, token handling, and API-key workflow.

## Prerequisites

- Complete `09-AUTH-LAMBDA.md`.
- Read `/Users/basilsergius/projects/renderpdf/dashboard/README.md`.

## Files/Folders In Scope

- `/Users/basilsergius/projects/renderpdf/dashboard/login.html`
- `/Users/basilsergius/projects/renderpdf/dashboard/callback.html`
- `/Users/basilsergius/projects/renderpdf/dashboard/index.html`
- `/Users/basilsergius/projects/renderpdf/dashboard/app.js`
- `/Users/basilsergius/projects/renderpdf/dashboard/style.css`

## Files/Folders Out Of Scope

- `landing/`
- backend auth implementation
- new frontend frameworks or build systems
- assumed compatibility artifact:
  - `/Users/basilsergius/projects/renderpdf/dashboard/auth/callback`

## Implementation Task

1. Preserve the static multi-page auth flow.
2. Keep `login.html`, `callback.html`, and `app.js` aligned with the current Cognito and API expectations.
3. Prefer updating existing pages over introducing new dashboard routes or frameworks.
4. Treat `dashboard/auth/callback` as out of scope unless the task is specifically about that artifact.

## Verification Steps

Manual review:

```bash
cd /Users/basilsergius/projects/renderpdf && sed -n '1,220p' dashboard/login.html
cd /Users/basilsergius/projects/renderpdf && sed -n '1,240p' dashboard/callback.html
cd /Users/basilsergius/projects/renderpdf && sed -n '1,260p' dashboard/app.js
```

If deployment-backed verification is needed:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/deploy.sh
```

## Stop Conditions

- Stop if the task requires automated dashboard coverage that does not exist.
- Stop if the change would split dashboard behavior across a second frontend root.
