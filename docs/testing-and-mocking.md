# Testing and Mocking Guide

Comprehensive guide for local verification, unit test mocking, and sandboxed AI agent execution in `renderpdf`.

---

## 1. Quick Verification Overview

Run all fast, local offline verification suites in under 3 seconds:

```bash
./scripts/verify-all.sh
```

This single command executes 7 offline validation stages across Go, Node.js, Shell, DOM, and CloudFormation syntax:
1. `scripts/verify-shell.sh`: Syntax validation (`bash -n`) for all repository scripts.
2. `scripts/verify-api.sh`: Go unit tests for PDF rendering, Markdown compilation, and batch APIs.
3. `scripts/verify-auth.sh`: Go unit tests for Bearer token authorizer and API key management.
4. `cd analytics && npm test`: 82 Node.js unit tests for billing webhooks, rollups, and admin APIs.
5. `node --test dashboard/*.test.js`: 7 Node.js unit tests for chat widget and template client.
6. Syntax checks: `node --check webhooks/index.js` and `node --check auth/account-linker/index.js`.
7. `scripts/verify-static-ui.js`: 38 static HTML pages validated for broken links, duplicate IDs, and headings.
8. `scripts/verify-infra.sh`: CloudFormation YAML structural and conflict-marker validation.

---

## 2. In-Process Mocking Architecture

### Node.js AWS SDK Mocking (`analytics/index.test.js`)
The `analytics` microservice runs on Node.js 22 and interacts with DynamoDB, SES, Cognito, and API Gateway.
To achieve fast, deterministic local tests without spinning up containers or network mocks, the test suite intercepts Node's module loader:

```javascript
// analytics/index.test.js
const Module = require('node:module');
const originalRequire = Module.prototype.require;

Module.prototype.require = function (id, ...args) {
  if (id === '@aws-sdk/client-dynamodb') {
    return {
      DynamoDBClient: class { send() {} },
      GetItemCommand: class { constructor(i) { this.input = i; } },
      PutItemCommand: class { constructor(i) { this.input = i; } },
      QueryCommand: class { constructor(i) { this.input = i; } },
      UpdateItemCommand: class { constructor(i) { this.input = i; } },
      TransactWriteItemsCommand: class { constructor(i) { this.input = i; } },
    };
  }
  // Handles @aws-sdk/client-ses, @aws-sdk/client-cognito-identity-provider, etc.
  return originalRequire.apply(this, [id, ...args]);
};
```

This allows full unit testing of:
- Paddle webhook subscription upgrades (Starter 5k, Pro 20k)
- Quota reservation and overage credit additions
- SES billing alert formatting and dual-dispatch to Telegram
- Admin dossier retrieval and audit logging

### Go Logic Decoupling (`api/` and `auth/`)
- Pure logic functions (such as request normalization, HTML escaping, template binding, and IAM policy generation) are decoupled from AWS Lambda runtime boundaries.
- Tests in `api/*_test.go` and `auth/*_test.go` run instantly with `go test ./...`.
- `api/main_test.go` tests headless Chrome rendering; if Google Chrome or Chromium is not present in the local execution path, browser rendering tests gracefully skip rather than fail.

---

## 3. Local Environment & Mock Configuration

A standardized environment template is provided in [`.env.test.example`](../.env.test.example).

To run any service or script locally with mock AWS and third-party values:

```bash
cp .env.test.example .env.test
export $(grep -v '^#' .env.test | xargs)
```

Key environment groupings:
- **DynamoDB Tables:** `TABLE_NAME`, `API_KEYS_TABLE`, `TEMPLATE_TABLE_NAME`, `DOCUMENT_STORE_TABLE_NAME`
- **S3 Buckets:** `BUCKET_NAME`, `PACKAGE_BUCKET_NAME`
- **SQS Queues:** `WEBHOOK_QUEUE_URL`, `BATCH_QUEUE_URL`
- **Paddle Sandbox:** `PADDLE_ENVIRONMENT=sandbox`, `PADDLE_API_KEY=mock-paddle-api-key`, `PADDLE_OVERAGE_PRICE_ID=pri_01m2fzxsmngvj4a5186zydh2ej`

---

## 4. macOS Sandboxed CLI Environments

### The `docs/` Directory Restriction
In sandboxed execution environments on macOS (e.g. Anthropic Claude Code, Antigravity, or Apple Seatbelt-confined processes), shell processes may be denied access to the repository directory named `docs/`:

```text
ls: docs: Operation not permitted
warning: could not open directory 'docs/': Operation not permitted
```

**Why this happens:**
macOS sandboxing profiles frequently enforce system TCC (Transparency, Consent, and Control) checks on paths matching `~/Documents` or containing `docs/`. When a sandboxed subshell executes `ls docs` or `git status`, the OS kernel denies file enumeration.

**Rules for AI Agents:**
1. **Never fail or retry in loops** when a shell command outputs `Operation not permitted` on `docs/`.
2. **Use Native IDE / Tool APIs:** The editor and parent agent process run outside the child subshell sandbox. Dedicated file viewing tools (`view_file`, IDE open file) read `docs/` without restriction.
3. **Do not modify `.gitignore` or permissions:** This is an OS sandbox restriction, not a file permission or git corruption issue.

---

## 5. Deployed Infrastructure Verification

When deploying changes to AWS or testing against staging/production:

1. **API Smoke Tests:**
   ```bash
   ./scripts/test-api.sh
   # With API key to test template CRUD lifecycle:
   RENDERPDF_API_KEY='your-key' ./scripts/test-api.sh
   ```

2. **Persistence & Account Isolation Test:**
   ```bash
   RENDERPDF_API_KEY='primary-key' \
   RENDERPDF_SECONDARY_API_KEY='secondary-key' \
   ./scripts/test-sources-files.sh
   ```
   Tests saved sources, private presigned S3 downloads, and cross-account access denial.

3. **CloudFormation Live API Validation:**
   ```bash
   RENDERPDF_TEMPLATE_VALIDATION_BUCKET='your-private-bucket' \
   ./scripts/verify-infra.sh
   ```

---

## 6. LocalStack Emulation (Optional Local Integration)

For integration testing against real local AWS endpoints (DynamoDB, S3, SQS):

```bash
docker compose -f docker-compose.test.yml up -d
```

This starts LocalStack on `http://localhost:4566` and automatically runs `scripts/init-localstack.sh` to provision the exact test DynamoDB tables, S3 buckets, and SQS queues defined in `.env.test.example`.

Stop and clean up:
```bash
docker compose -f docker-compose.test.yml down -v
```

---

## 7. Auto-Formatting and Linting

Keep code formatted to repository standards with a single command:

```bash
./scripts/format-all.sh
```

- **Go Code:** Runs `go fmt ./...` in `api/` and `auth/`.
- **JavaScript & Configs:** Formats `analytics/`, `webhooks/`, `dashboard/`, `scripts/`, `*.json`, `*.yaml` according to `.prettierrc`.
- **CI / Check Mode:** Pass `--check` to detect unformatted files without writing:
  ```bash
  ./scripts/format-all.sh --check
  ```
