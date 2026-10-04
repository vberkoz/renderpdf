# AGENTS.md

Operational guide for AI agents working in this repository.

## Safety & Repo Guardrails

- **Sandbox Quirk (macOS)**: Shell commands listing `docs/` (`ls docs`, `find docs`) may fail with `Operation not permitted` under macOS TCC/Seatbelt. Always read documentation using native file reading tools.
- **Canonical Paths**: Operational scripts live in `scripts/`, infra in `infra/`, docs in `docs/`. Root `*.sh` and `cloudformation.yaml` are compatibility wrappers/symlinks.
- **No Generated Binaries**: Never edit `api/renderpdf`, `auth/authorizer`, `auth/api-keys`. Edit `.go` source files.
- **Verification**: Run `./scripts/verify-all.sh` to run all offline checks (Go, Node, static UI, shell, infra).

## Write Boundaries

- **Safe for feature work**: `api/**`, `auth/**`, `analytics/**`, `webhooks/**`, `dashboard/**`, `landing/**`, `doc-examples/**`, `_prompts/**`, root docs & scripts.
- **Edit carefully**: `infra/cloudformation.yaml`, `scripts/deploy*.sh`, `scripts/test-api.sh`, `parameters.json`.

## Entry Points

- **API Lambda**: `api/main.go`, `api/Dockerfile`
- **Auth Lambdas**: `auth/authorizer.go`, `auth/api-keys.go`, `auth/account-linker/index.js`
- **Analytics & Webhooks**: `analytics/index.js`, `webhooks/index.js`
- **Static Frontends**: `dashboard/login.html`, `dashboard/index.html`, `landing/index.html`
- **Infra & Deploy**: `infra/cloudformation.yaml`, `scripts/deploy.sh`

## On-Demand Documentation (Read Only When Relevant)

Do NOT read all docs upfront. Consult specific files only when working on related tasks:
- **Repo layout & ownership details**: `docs/repo-map.md`
- **Service architecture & data flows**: `docs/service-map.md`, `docs/ARCHITECTURE.md`
- **Safe edit patterns & workflows**: `docs/edit-surfaces.md`
- **Adding endpoints or common modifications**: `docs/change-recipes.md`
- **Testing, mock envs, or verification runs**: `docs/VERIFICATION.md`, `docs/testing-and-mocking.md`
- **API schema & contracts**: `docs/api-summary.md` (read first; consult `docs/openapi.yaml` only for deep schema definitions)
- **Prompts & operating workflows**: `_prompts/INDEX.md`
- **Contributing standards**: `docs/CONTRIBUTING.md`
