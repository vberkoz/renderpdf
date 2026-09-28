# Task 1: Bedrock Nova Micro Engine & Public Chat API

| Field | Value |
| :--- | :--- |
| **Task ID** | TASK-CHAT-01 |
| **Feature** | [`features/support-chat/`](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/support-chat/spec.md) |
| **Status** | Completed |
| **Target Files** | `infra/cloudformation.yaml`, `analytics/chat.js`, `analytics/index.js`, `analytics/chat.test.js` |
| **Prerequisites** | None |

---

## 1. Objective

Configure AWS Bedrock permissions in CloudFormation and implement the public `POST /api/v1/chat` endpoint powered by **Amazon Nova Micro** (`amazon.nova-micro-v1:0`) armed with the embedded RenderPDF knowledge base.

---

## 2. Technical Requirements

### 2.1 Infrastructure & IAM (`infra/cloudformation.yaml`)
1. Add Bedrock invocation policy to `LambdaExecutionRole`:
   ```yaml
   - Effect: Allow
     Action:
       - 'bedrock:InvokeModel'
     Resource:
       - 'arn:aws:bedrock:*::foundation-model/amazon.nova-micro-v1:0'
       - 'arn:aws:bedrock:*::foundation-model/amazon.nova-lite-v1:0'
   ```
2. Configure API Gateway resources:
   - Resource `/api/v1/chat` with method `POST`.
   - Method integration pointing to `AnalyticsFunction` (Node.js 22 runtime).
   - Rate limiting: standard usage throttling applied.

### 2.2 Embedded Knowledge Base & System Prompt (`analytics/chat.js`)
1. Create `analytics/chat.js` exporting `handleChatMessage(event)` and `buildSystemPrompt()`.
2. Embed concise, structured Markdown knowledge modules covering:
   - Canonical `/api/v1/render` request options (`format`, `margin`, `headerTemplate`, `footerTemplate`, `displayHeaderFooter`, `password`, `permissions`).
   - Starter template variables & migration guidance.
   - Quotas, limits, and pricing tiers (\$19/mo Starter, \$49/mo Pro, \$10 overages).
   - Async batch rendering (`/batches`) and Webhook delivery.
3. System prompt instructs model to include decision tags:
   - `[DECISION: ANSWER]` for autonomous resolution.
   - `[DECISION: ESCALATE]` for high-value leads, complex bugs, billing issues, or human requests.

### 2.3 Bedrock Invocation & Session Persistence
1. Use `@aws-sdk/client-bedrock-runtime` (`ConverseCommand` or `InvokeModelCommand`).
2. Persist session metadata and message records in DynamoDB (`requestId: "CHAT#<sessionId>"`) with `expiresAt = Math.floor(Date.now() / 1000) + 30 * 86400`.
3. Support returning `{ sessionId, reply, escalated, requiresEmail }`.

---

## 3. Verification & Acceptance Criteria

1. **Unit Tests (`analytics/chat.test.js`)**:
   - Mock Bedrock runtime client.
   - Verify answering technical questions returns `[DECISION: ANSWER]` with valid reply.
   - Verify prompt construction includes recent session history and RenderPDF knowledge base.
   - Verify session metadata and messages are correctly written to DynamoDB with 30-day TTL.
2. **Execution**:
   ```bash
   npm test --prefix analytics/
   ```
