# edit-surfaces.md

Quick lookup matrix mapping repository components to their safe canonical edit paths, primary files, and verification scripts.

| Component / Subsystem | Primary Edit Surfaces (Safe) | Never Touch / Anti-patterns | Verification Script |
| :--- | :--- | :--- | :--- |
| **PDF Generation API** | `api/main.go`<br>`api/main_test.go`<br>`api/Dockerfile` | `api/renderpdf` (binary)<br>creating root backend folders | `./scripts/verify-api.sh` |
| **Auth & Key Management** | `auth/authorizer.go`<br>`auth/api-keys.go`<br>`auth/utils.go`<br>`auth/utils_test.go`<br>`auth/account-linker/index.js` | `auth/authorizer` (binary)<br>`auth/api-keys` (binary)<br>mixing build tags | `./scripts/verify-auth.sh` |
| **Analytics & Webhooks** | `analytics/index.js`<br>`analytics/index.test.js`<br>`webhooks/index.js` | modifying dependencies without running tests | `(cd analytics && npm test)`<br>`node --check webhooks/index.js` |
| **Authenticated Dashboard** | `dashboard/index.html`<br>`dashboard/login.html`<br>`dashboard/callback.html`<br>`dashboard/app.js` | creating bundled frameworks (`client/`, `ui/`)<br>breaking Cognito URLs | `node --test dashboard/*.test.js`<br>`node scripts/verify-static-ui.js` |
| **Public Landing & Demo** | `landing/index.html` | adding build/bundler pipelines<br>breaking embedded fetch demo | `node scripts/verify-static-ui.js` |
| **Infrastructure (IaC)** | `infra/cloudformation.yaml`<br>`infra/parameters.json.example` | root `cloudformation.yaml` directly<br>`parameters.json` directly | `./scripts/verify-infra.sh` |
| **Operational Scripts** | `scripts/*.sh`<br>`scripts/README.md` | non-wrapper scripts at root<br>unanchored directory changes | `./scripts/verify-shell.sh` |
| **Workflow Prompts** | `_prompts/NN-NAME.md`<br>`_prompts/INDEX.md`<br>`_prompts/README.md` | out-of-order numbering<br>referencing nonexistent files | `rg -n "NN-\|INDEX" _prompts` |
| **HTML Test Fixtures** | `doc-examples/*.html` | root-level test fixtures | manual / render verification |

> [!TIP]
> Run `./scripts/verify-all.sh` to run the complete suite of offline checks across all surfaces in one command.
> For detailed step-by-step recipes on modifying these areas, see `docs/change-recipes.md`.
> For repository placement rules and forbidden patterns, see `docs/AGENT-RULES.md`.
