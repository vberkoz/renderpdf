# AGENT-RULES.md

Repository boundaries, placement rules, and forbidden patterns for AI agents working in `renderpdf`.

For modification recipes, see [change-recipes.md](file:///Users/basilsergius/projects/renderpdf/docs/change-recipes.md).
For a fast lookup table of edit surfaces and verification scripts, see [edit-surfaces.md](file:///Users/basilsergius/projects/renderpdf/docs/edit-surfaces.md).

## Purpose

- Keep new changes inside the repo's existing responsibility boundaries.
- Prevent root-level sprawl and duplicate operational entrypoints.
- Enforce strict boundaries for Go services, static frontend files, CloudFormation, shell scripts, and `_prompts/`.

## Placement Rules

### Backend Code

- **PDF generation service**:
  - Canonical location: `api/`
- **Auth-related Lambda code**:
  - Canonical location: `auth/`
- **Analytics Lambda code**:
  - Canonical location: `analytics/`
- **Webhook delivery worker**:
  - Canonical location: `webhooks/`
- **Shared backend logic**:
  - Keep inside the owning service folder unless multiple services truly require shared code.
- **Rule**: Do NOT create a new root backend folder.

### Frontend Code

- **Authenticated dashboard UI**:
  - Canonical location: `dashboard/`
- **Public marketing / demo UI**:
  - Canonical location: `landing/`
- **Rule**: Keep these as static assets. Do NOT create generic `frontend/`, `web/`, `ui/`, or `client/` directories unless explicitly instructed.

### Infrastructure Code

- **CloudFormation templates and deployment config**:
  - Canonical location: `infra/` (`infra/cloudformation.yaml`, `infra/parameters.json.example`)
- **Rule**: Root `cloudformation.yaml` is a compatibility path. Always edit the canonical file in `infra/`.

### Scripts

- **Operational & verification scripts**:
  - Canonical location: `scripts/`
- **Rule**: Root script files (`deploy.sh`, `deploy-landing.sh`, `test-api.sh`) are compatibility wrappers only. Do NOT add new non-wrapper scripts at the repo root.

### Documentation & Workflow Prompts

- **Long-form repo & process docs**:
  - Canonical location: `docs/`
- **AI workflow modules**:
  - Canonical location: `_prompts/`
- **PDF testing HTML fixtures**:
  - Canonical location: `doc-examples/`

---

## Naming Rules

### Scripts

- Deployment: `deploy-<scope>.sh` (use `deploy.sh` only for the primary full deploy).
- Verification / Testing: `verify-<scope>.sh` or `test-<scope>.sh`.
- Exactly one script per clear operational purpose. Avoid ambiguous names like `run.sh`, `temp.sh`, `helper.sh`.

### Tests

- Go: standard `*_test.go`.
- Node: standard `*.test.js`.
- HTML fixtures: descriptive kebab-case or scenario names in `doc-examples/` (e.g. `invoice.html`, `report.html`). Do not place fixtures at the repo root.

### Workflow Prompts

- Numeric ordering for workflow prompts: `NN-NAME.md` (e.g. `11-NEW-FLOW.md`).
- Uppercase descriptive names matching repo convention.
- Always register new prompt modules in `_prompts/INDEX.md`.

---

## Decision Matrix: Modify Existing vs Create New

### Modify Existing Files When:
- The responsibility already belongs to a current file.
- The change extends current deploy, auth, dashboard, landing, or PDF behavior.
- Adding a new file would introduce an ambiguous or secondary source of truth.

### Create New Files When:
- Adding a distinct responsibility that has no natural home in existing files.
- An existing script would otherwise become overloaded or unsafe to reason about.
- Introducing a new PDF test scenario (`doc-examples/`).
- Adding a brand-new workflow module in `_prompts/`.

### Prefer Editing Over Creating If:
- An existing file targets the same deploy destination.
- An existing file manages the same UI page responsibility.
- An existing script performs the same verification goal.
- The proposed new file would differ only by environment or minor logic branches.

---

## Forbidden Patterns

1. **Duplicate entrypoints**: Never create duplicate deploy or test scripts for the same target or verification path.
2. **Root sprawl**: Never add new root-level infrastructure, operational scripts, tests, or documentation files.
3. **Editing generated binaries**: NEVER edit compiled binaries as source files:
   - `api/renderpdf`
   - `auth/authorizer`
   - `auth/api-keys`
4. **Unanchored script execution**: Never write shell scripts that rely on caller `cwd` or change directories without anchoring to `SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`.
5. **Silent mutations**: Never write scripts that silently mutate unrelated AWS resources or delete data tables without explicit prompt instruction.
6. **Framework introduction**: Never introduce build tools, bundlers, or frontend frameworks into `dashboard/` or `landing/` unless explicitly tasked with a migration.
7. **Phantom references**: Never add prompt docs or instructions claiming scripts or files exist when they do not.
8. **Symlink edits**: Never edit root compatibility symlinks/wrappers when canonical targets exist in `infra/` or `scripts/`.

---

## High-Risk Files (Edit With Caution)

- `infra/cloudformation.yaml`: Main cloud resources; validate with `./scripts/verify-infra.sh`.
- `scripts/deploy.sh` & `scripts/deploy-landing.sh`: Production deployment paths.
- `scripts/test-api.sh`: Smoke test suite with live AWS dependencies.
- `dashboard/login.html`, `dashboard/callback.html`, `dashboard/app.js`: Production Cognito authentication flow and token storage.
- `landing/index.html`: Public customer portal and live conversion demo.
- `parameters.json`: Live deployment parameters.

---

## Pre-Flight & Post-Flight Checklists

### Before Editing
- [ ] Read `AGENTS.md` and `docs/ARCHITECTURE.md`.
- [ ] Consult `docs/edit-surfaces.md` to identify the safe edit surface and verification script.
- [ ] Confirm whether root files are wrappers before modifying them.
- [ ] Check for hardcoded Cognito domain names, callback URLs, or API endpoints.

### After Editing
- [ ] Verify that no new unexpected responsibilities were added to modified files.
- [ ] Confirm single source of truth is preserved (no duplicate entrypoints).
- [ ] Run the respective verification script or `./scripts/verify-all.sh`.
- [ ] Keep compatibility wrappers intact if canonical scripts were touched.

---

## Repo-Specific Constraints

- Run `./scripts/verify-all.sh` for fast, unified offline verification of Go, Node, static UI, shell, and infra syntax.
- `api/` and `auth/` are standalone Go Lambda modules, not a monorepo with shared packages.
- In macOS sandboxed CLI environments, shell commands inspecting `docs/` (`ls docs`, `find docs`) may fail with `Operation not permitted`; inspect documentation with native file viewing tools directly.
- For local offline mocking and testing variables, refer to `.env.test.example` and `docs/testing-and-mocking.md`.
