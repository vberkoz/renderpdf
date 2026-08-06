# _prompts/INDEX.md

Main entrypoint for the AI workflow modules in this repository.

## Workflow Order

1. `00-REPO-NAVIGATION.md`
   - Use first when you need to understand where code, infra, scripts, docs, and prompts live.
2. `01-LOCAL-DEVELOPMENT.md`
   - Use to discover real local verification paths before editing.
3. `02-MASTER-PLAN.md`
   - Use to anchor work to the intended architecture and service boundaries.
4. `03-INFRASTRUCTURE.md`
   - Use for CloudFormation or deploy-time resource changes.
5. `04-LAMBDA-FUNCTION.md`
   - Use for PDF-generation service work in `api/`.
6. `05-DEPLOYMENT.md`
   - Use for canonical deploy-script changes.
7. `06-TESTING.md`
   - Use when working on verification flows or test discovery.
8. `07-LANDING-PAGE.md`
   - Use for the public landing/demo site.
9. `08-AUTH-INFRASTRUCTURE.md`
   - Use for Cognito, API-key table, or authorizer-related infra.
10. `09-AUTH-LAMBDA.md`
   - Use for Go auth service code in `auth/`.
11. `10-DASHBOARD.md`
   - Use for the authenticated static dashboard.
12. `11-AUTH-DEPLOYMENT.md`
   - Use when auth/backend/dashboard changes need coordinated deployment updates.
13. `12-AUTH-TESTING.md`
   - Use for auth verification and for documenting missing auth coverage accurately.
14. `13-SAFE-REFACTORS.md`
   - Use for structural cleanup, file moves, or non-behavioral refactors.

## When To Use Each Prompt

- Repo orientation:
  - `00-REPO-NAVIGATION.md`
- Local verification discovery:
  - `01-LOCAL-DEVELOPMENT.md`
- Architecture decisions and boundaries:
  - `02-MASTER-PLAN.md`
- CloudFormation changes:
  - `03-INFRASTRUCTURE.md`
- PDF generation backend:
  - `04-LAMBDA-FUNCTION.md`
- Deploy automation:
  - `05-DEPLOYMENT.md`
- Verification wrappers and test flows:
  - `06-TESTING.md`
- Public frontend:
  - `07-LANDING-PAGE.md`
- Auth infra:
  - `08-AUTH-INFRASTRUCTURE.md`
- Auth backend:
  - `09-AUTH-LAMBDA.md`
- Authenticated frontend:
  - `10-DASHBOARD.md`
- Coordinated auth deploy work:
  - `11-AUTH-DEPLOYMENT.md`
- Auth verification:
  - `12-AUTH-TESTING.md`
- Safe repo refactors:
  - `13-SAFE-REFACTORS.md`

## Idempotent Usage Rules

- Detect current state before creating new files.
- Prefer editing canonical files over creating parallel ones.
- Use the verification commands that actually exist in `scripts/` and `docs/VERIFICATION.md`.
- If a test or script does not exist, document the gap instead of inventing it.
- Stop when a task crosses ownership boundaries without clear approval.

## Template For New Modules

- Start from:
  - `/Users/basilsergius/projects/renderpdf/_prompts/TEMPLATE-MODULE.md`
- Keep the filename format:
  - `NN-NAME.md`
- Include:
  - purpose
  - prerequisites
  - files/folders in scope
  - files/folders out of scope
  - implementation task
  - verification steps
  - stop conditions
