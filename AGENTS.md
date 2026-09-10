# AGENTS.md

Operational guide for AI agents working in this repository.

## Repo Rules

- Read these files first:
  - `/Users/basilsergius/projects/renderpdf/README.md`
  - `/Users/basilsergius/projects/renderpdf/AGENTS.md`
  - `/Users/basilsergius/projects/renderpdf/docs/repo-map.md`
  - `/Users/basilsergius/projects/renderpdf/docs/service-map.md`
  - `/Users/basilsergius/projects/renderpdf/docs/edit-surfaces.md`
  - `/Users/basilsergius/projects/renderpdf/docs/ARCHITECTURE.md`
  - `/Users/basilsergius/projects/renderpdf/docs/VERIFICATION.md`
  - `/Users/basilsergius/projects/renderpdf/docs/change-recipes.md`
  - `/Users/basilsergius/projects/renderpdf/docs/CONTRIBUTING.md`
- Treat root deploy and infra files as shared coordination points:
  - `/Users/basilsergius/projects/renderpdf/deploy.sh`
  - `/Users/basilsergius/projects/renderpdf/deploy-landing.sh`
  - `/Users/basilsergius/projects/renderpdf/test-api.sh`
  - `/Users/basilsergius/projects/renderpdf/cloudformation.yaml`
- Canonical locations for moved root assets:
  - `/Users/basilsergius/projects/renderpdf/scripts/`
  - `/Users/basilsergius/projects/renderpdf/infra/`
  - `/Users/basilsergius/projects/renderpdf/docs/`
- Preserve current path assumptions unless the task explicitly includes updating deploy/test wiring.

## Write Boundaries

- Safe to edit for feature work:
  - `/Users/basilsergius/projects/renderpdf/api/**`
  - `/Users/basilsergius/projects/renderpdf/auth/**`
  - `/Users/basilsergius/projects/renderpdf/dashboard/**`
  - `/Users/basilsergius/projects/renderpdf/landing/**`
  - `/Users/basilsergius/projects/renderpdf/doc-examples/**`
  - `/Users/basilsergius/projects/renderpdf/_prompts/**`
  - root docs and scripts
- Edit carefully:
  - `/Users/basilsergius/projects/renderpdf/infra/cloudformation.yaml`
  - `/Users/basilsergius/projects/renderpdf/scripts/deploy.sh`
  - `/Users/basilsergius/projects/renderpdf/scripts/deploy-landing.sh`
  - `/Users/basilsergius/projects/renderpdf/scripts/test-api.sh`
  - `/Users/basilsergius/projects/renderpdf/parameters.json`
- Generated/local artifacts excluded from Git, not source of truth:
  - `/Users/basilsergius/projects/renderpdf/api/renderpdf`
  - `/Users/basilsergius/projects/renderpdf/auth/authorizer`
  - `/Users/basilsergius/projects/renderpdf/auth/api-keys`

## Folder Ownership

- `api/`: HTML-to-PDF Lambda source and image build.
- `auth/`: API authorizer and API-key Lambda source plus shared auth helpers.
- `dashboard/`: static authenticated UI for key management and API testing.
- `landing/`: static marketing/demo page.
- `doc-examples/`: sample HTML inputs used by tests and manual verification.
- `_prompts/`: AI workflow docs and repo-operating prompts. These are documentation, not runtime code.

## Fast Navigation

- Need folder ownership:
  - `/Users/basilsergius/projects/renderpdf/docs/repo-map.md`
- Need service entrypoints:
  - `/Users/basilsergius/projects/renderpdf/docs/service-map.md`
- Need safe edit boundaries or common edits:
  - `/Users/basilsergius/projects/renderpdf/docs/edit-surfaces.md`
  - `/Users/basilsergius/projects/renderpdf/docs/change-recipes.md`
- Need verification commands:
  - `/Users/basilsergius/projects/renderpdf/docs/VERIFICATION.md`
- Need prompt workflow guidance:
  - `/Users/basilsergius/projects/renderpdf/_prompts/INDEX.md`

## Entry Points

- API Lambda:
  - `/Users/basilsergius/projects/renderpdf/api/main.go`
  - `/Users/basilsergius/projects/renderpdf/api/Dockerfile`
- Auth Lambdas:
  - `/Users/basilsergius/projects/renderpdf/auth/authorizer.go`
  - `/Users/basilsergius/projects/renderpdf/auth/api-keys.go`
  - `/Users/basilsergius/projects/renderpdf/auth/Dockerfile.authorizer`
  - `/Users/basilsergius/projects/renderpdf/auth/Dockerfile.apikeys`
- Static apps:
  - `/Users/basilsergius/projects/renderpdf/dashboard/login.html`
  - `/Users/basilsergius/projects/renderpdf/dashboard/callback.html`
  - `/Users/basilsergius/projects/renderpdf/dashboard/index.html`
  - `/Users/basilsergius/projects/renderpdf/landing/index.html`
- Infra and deploy:
  - `/Users/basilsergius/projects/renderpdf/infra/cloudformation.yaml`
  - `/Users/basilsergius/projects/renderpdf/scripts/deploy.sh`

## Safe Workflow

- Before editing:
  - Read the folder README for the target area.
  - Search for root-level scripts that reference the target path.
  - Check for hard-coded URLs, AWS names, and callback paths.
- While editing:
- Prefer source files over local generated binaries.
  - Keep root-relative path assumptions intact unless you also update scripts.
  - Mark unclear behavior as an assumption in docs or handoff notes.
- After editing:
  - Run the smallest relevant test first.
  - If deploy wiring was touched, review `scripts/deploy.sh`, `scripts/deploy-landing.sh`, and `infra/cloudformation.yaml` together.

## Common Pitfalls

- `scripts/deploy.sh` directly references `api/`, `auth/`, `landing/`, and `dashboard/`.
- `dashboard/` and `landing/` contain hard-coded production URLs.
- `_prompts/` documents some files that do not exist in the current repo state.
- `scripts/test-api.sh` exercises deployed infrastructure, not just local code.
- `api/main_test.go` only runs when Chrome is available in the expected environment.

## Assumptions

- Assumption: local binaries are generated build artifacts, not the intended edit target.
- Assumption: `parameters.json` is environment-specific and should not be rewritten unless the task is explicitly deployment-related.
