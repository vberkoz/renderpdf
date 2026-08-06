# CONTRIBUTING.md

## Before You Change Anything

- Read:
  - `/Users/basilsergius/projects/renderpdf/AGENTS.md`
  - `/Users/basilsergius/projects/renderpdf/docs/ARCHITECTURE.md`
  - target folder README
- Confirm whether the change touches:
  - app code
  - deploy scripts
  - infrastructure
  - examples
  - prompt docs

## Where New Changes Should Go

- New PDF generation logic:
  - `/Users/basilsergius/projects/renderpdf/api/`
- New API-key or authorizer logic:
  - `/Users/basilsergius/projects/renderpdf/auth/`
- New dashboard UI:
  - `/Users/basilsergius/projects/renderpdf/dashboard/`
- New landing/demo UI:
  - `/Users/basilsergius/projects/renderpdf/landing/`
- New sample HTML inputs:
  - `/Users/basilsergius/projects/renderpdf/doc-examples/`
- New AI workflow docs:
  - `/Users/basilsergius/projects/renderpdf/_prompts/`
- New shared operator docs:
  - repo root

## Safe Edit Checklist

- [ ] Prefer editing source files, not compiled binaries.
- [ ] Keep existing file paths stable unless deploy/test scripts are updated too.
- [ ] Check for hard-coded domains, callback URLs, and AWS resource names.
- [ ] Keep docs aligned with actual files in the repo.
- [ ] Mark assumptions instead of inventing missing behavior.

## Testing Checklist

- API code:
  - `cd /Users/basilsergius/projects/renderpdf/api && go test ./...`
- Auth code:
  - `cd /Users/basilsergius/projects/renderpdf/auth && go test ./...`
- Deployed API smoke test:
  - `cd /Users/basilsergius/projects/renderpdf && ./scripts/test-api.sh`
- Static pages:
  - Review the HTML/JS paths directly and verify hard-coded URLs remain valid.

## Treat Carefully

- `/Users/basilsergius/projects/renderpdf/infra/cloudformation.yaml`
- `/Users/basilsergius/projects/renderpdf/scripts/deploy.sh`
- `/Users/basilsergius/projects/renderpdf/scripts/deploy-landing.sh`
- `/Users/basilsergius/projects/renderpdf/parameters.json`
- `/Users/basilsergius/projects/renderpdf/dashboard/login.html`
- `/Users/basilsergius/projects/renderpdf/dashboard/callback.html`

## Common Pitfalls

- `scripts/test-api.sh` validates the deployed stack, not only local code.
- `api/main_test.go` skips locally if Chrome is unavailable.
- `_prompts/` contains planned files and flows that are not fully present in the repo.
- `parameters.json` is ignored by git and may differ across environments.
