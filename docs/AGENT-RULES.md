# AGENT-RULES.md

Repository-safe editing guide for AI agents working in `renderpdf`.

## Purpose

- Keep new changes inside the repo's existing responsibility boundaries.
- Prevent root-level sprawl and duplicate operational entrypoints.
- Make edits predictable for Go services, static frontend files, CloudFormation, shell scripts, and `_prompts/`.

## Placement Rules

### New Backend Code

- PDF generation service code:
  - put in `/Users/basilsergius/projects/renderpdf/api/`
- Auth-related Lambda code:
  - put in `/Users/basilsergius/projects/renderpdf/auth/`
- Shared backend logic:
  - keep inside the owning service folder unless both `api/` and `auth/` truly need it
- Do not create a new root backend folder.

### New Frontend Code

- Authenticated dashboard UI:
  - put in `/Users/basilsergius/projects/renderpdf/dashboard/`
- Public marketing/demo UI:
  - put in `/Users/basilsergius/projects/renderpdf/landing/`
- Keep these as static assets unless the repo is explicitly being migrated to a bundled frontend.
- Do not create a generic `frontend/`, `web/`, or `client/` folder unless the user explicitly asks for a structural change.

### New Infrastructure Code

- CloudFormation templates and deployment config examples:
  - put in `/Users/basilsergius/projects/renderpdf/infra/`
- Update canonical infra files here:
  - `/Users/basilsergius/projects/renderpdf/infra/cloudformation.yaml`
  - `/Users/basilsergius/projects/renderpdf/infra/parameters.json.example`
- Root `cloudformation.yaml` is a compatibility path. Prefer editing the canonical file in `infra/`.

### New Scripts

- Operational scripts:
  - put in `/Users/basilsergius/projects/renderpdf/scripts/`
- Root script files are compatibility wrappers only:
  - `/Users/basilsergius/projects/renderpdf/deploy.sh`
  - `/Users/basilsergius/projects/renderpdf/deploy-landing.sh`
  - `/Users/basilsergius/projects/renderpdf/test-api.sh`
- Do not add new non-wrapper scripts at the repo root.

### New Docs And Prompt Files

- Long-form repo/process docs:
  - put in `/Users/basilsergius/projects/renderpdf/docs/`
- AI workflow modules:
  - put in `/Users/basilsergius/projects/renderpdf/_prompts/`
- Example HTML inputs for PDF testing:
  - put in `/Users/basilsergius/projects/renderpdf/doc-examples/`

## Naming Rules

### Scripts

- Deployment scripts:
  - use `deploy-<scope>.sh` or `deploy.sh` only for the primary full deploy
- Test scripts:
  - use `test-<scope>.sh`
- One script per clear operational purpose.
- Avoid ambiguous names like `run.sh`, `temp.sh`, `helper.sh`.

### Tests

- Go tests:
  - use Go's standard `*_test.go`
- HTML example fixtures:
  - use descriptive kebab-case or existing plain names that reflect the document purpose
- Do not create ad hoc test files at the repo root.

### Prompt Files

- Keep numeric ordering for workflow prompts:
  - `NN-NAME.md`
- Use uppercase descriptive names to match current convention:
  - example: `11-NEW-FLOW.md`
- If a prompt is informational rather than ordered workflow, prefer a descriptive README or docs file instead.

### Examples

- Put sample HTML fixtures in `doc-examples/`.
- Use names that describe document shape or scenario:
  - `invoice.html`
  - `report.html`
  - `variable-columns.html`

## Modify Existing Vs Create New

### Modify Existing Files When

- The responsibility already exists in a current file.
- The change updates current deploy, auth, dashboard, landing, or PDF behavior.
- The new logic is a direct extension of an existing script or prompt step.
- Adding a new file would create a second source of truth.

### Create New Files When

- A new file adds a distinct responsibility that does not already have a natural home.
- A script would otherwise become hard to reason about if overloaded.
- A new example fixture is needed for a new PDF scenario.
- A new prompt step is truly separate from the existing numbered steps.

### Prefer Editing Over Creating If Any Of These Are True

- There is already a file with the same deploy target.
- There is already a file with the same UI page responsibility.
- There is already a script with the same verification goal.
- The new file would differ only by one environment or one small branch of logic.

## Forbidden Patterns

- Duplicate deploy scripts for the same target.
- Duplicate test scripts for the same verification path.
- New root-level infrastructure, script, or docs files when `infra/`, `scripts/`, or `docs/` already owns that concern.
- Hidden side effects in scripts:
  - changing directories without anchoring to script location
  - relying on caller cwd without documenting it
  - silently mutating unrelated AWS resources
- Editing checked-in binaries as if they were source:
  - `/Users/basilsergius/projects/renderpdf/api/renderpdf`
  - `/Users/basilsergius/projects/renderpdf/auth/authorizer`
  - `/Users/basilsergius/projects/renderpdf/auth/api-keys`
- Creating alternate frontend roots like `client/`, `ui/`, or `frontend/` without an explicit migration task.
- Creating alternate infra roots like `ops/`, `iac/`, or `cloud/` without an explicit migration task.
- Adding prompt docs that claim scripts or files exist when they do not.

## Existing Files To Treat Carefully

- `/Users/basilsergius/projects/renderpdf/infra/cloudformation.yaml`
- `/Users/basilsergius/projects/renderpdf/scripts/deploy.sh`
- `/Users/basilsergius/projects/renderpdf/scripts/deploy-landing.sh`
- `/Users/basilsergius/projects/renderpdf/scripts/test-api.sh`
- `/Users/basilsergius/projects/renderpdf/dashboard/login.html`
- `/Users/basilsergius/projects/renderpdf/dashboard/callback.html`
- `/Users/basilsergius/projects/renderpdf/dashboard/app.js`
- `/Users/basilsergius/projects/renderpdf/landing/index.html`
- `/Users/basilsergius/projects/renderpdf/parameters.json`

## Before Editing Checklist

- [ ] Read `/Users/basilsergius/projects/renderpdf/AGENTS.md`
- [ ] Read `/Users/basilsergius/projects/renderpdf/docs/ARCHITECTURE.md`
- [ ] Read the README in the target folder, if present
- [ ] Confirm the target area:
  - `api/`
  - `auth/`
  - `dashboard/`
  - `landing/`
  - `infra/`
  - `scripts/`
  - `docs/`
  - `_prompts/`
- [ ] Search for existing files that already own the responsibility
- [ ] Check for path-sensitive references in scripts, docs, and prompts
- [ ] Check for hard-coded domains, callback URLs, and AWS resource names
- [ ] Confirm whether root files are wrappers or compatibility links before editing them

## After Editing Checklist

- [ ] Re-read changed paths for accidental new responsibilities
- [ ] Confirm there is still one clear deploy path per target
- [ ] Confirm there is still one clear test path per target
- [ ] Update docs or prompts if commands or canonical paths changed
- [ ] Keep compatibility wrappers working if canonical scripts moved
- [ ] Avoid leaving broken absolute or root-relative paths
- [ ] Note any assumptions if repo behavior was unclear

## Verification Commands By Area

### API

```bash
cd /Users/basilsergius/projects/renderpdf/api && go test ./...
```

### Auth

```bash
cd /Users/basilsergius/projects/renderpdf/auth && go test ./...
```

### Scripts

```bash
cd /Users/basilsergius/projects/renderpdf && bash -n deploy.sh deploy-landing.sh test-api.sh scripts/deploy.sh scripts/deploy-landing.sh scripts/test-api.sh
```

### Infrastructure

```bash
cd /Users/basilsergius/projects/renderpdf && aws cloudformation validate-template --template-body file://infra/cloudformation.yaml
```

### Deployed API Smoke Test

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/test-api.sh
```

### Landing

- Review:
  - `/Users/basilsergius/projects/renderpdf/landing/index.html`
  - `/Users/basilsergius/projects/renderpdf/landing/style.css`
- If deployment is intended:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/deploy-landing.sh
```

### Dashboard

- Review:
  - `/Users/basilsergius/projects/renderpdf/dashboard/login.html`
  - `/Users/basilsergius/projects/renderpdf/dashboard/callback.html`
  - `/Users/basilsergius/projects/renderpdf/dashboard/index.html`
  - `/Users/basilsergius/projects/renderpdf/dashboard/app.js`
- If deployment is intended:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/deploy.sh
```

### Prompts

- Verify referenced files exist:

```bash
cd /Users/basilsergius/projects/renderpdf && rg -n "deploy\\.sh|test-api\\.sh|cloudformation\\.yaml|scripts/|infra/" _prompts
```

## Repo-Specific Notes

- `api/` and `auth/` are Go Lambda services, not a monorepo with shared packages.
- `dashboard/` and `landing/` are static frontend folders with hard-coded production integrations.
- `infra/cloudformation.yaml` is the canonical CloudFormation template.
- `scripts/` is the canonical home for operational shell scripts.
- `_prompts/` is part of the working system because the repo uses a prompt-driven workflow; keep prompt instructions aligned with the actual file tree.
