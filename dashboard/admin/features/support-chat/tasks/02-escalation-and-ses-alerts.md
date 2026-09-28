# Task 2: Escalation Triage Engine, SES Email Alerts & Admin Chat APIs

| Field | Value |
| :--- | :--- |
| **Task ID** | TASK-CHAT-02 |
| **Feature** | [`features/support-chat/`](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/support-chat/spec.md) |
| **Status** | Completed |
| **Target Files** | `analytics/chat.js`, `analytics/notifications.js`, `analytics/index.js`, `analytics/chat.test.js` |
| **Prerequisites** | [`TASK-CHAT-01`](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/support-chat/tasks/01-bedrock-knowledge-and-chat-api.md) |

---

## 1. Objective

Implement the autonomous vs. human escalation detection pipeline, trigger instantaneous alert emails via Amazon SES to the operator (`vberkoz@gmail.com`), and provide admin management endpoints for listing, viewing, and replying to chat sessions.

---

## 2. Technical Requirements

### 2.1 Escalation Detection & SES Alerting (`analytics/chat.js` & `analytics/notifications.js`)
1. Detect model output containing `[DECISION: ESCALATE]`.
2. Extract escalation metadata: `escalationReason` (`high_value_lead`, `complex_bug`, `billing_issue`, `explicit_request`).
3. Update session item in DynamoDB:
   - `status = "escalated"`
   - `unreadByAdmin = true`
   - `escalatedAt = new Date().toISOString()`
4. Trigger `sendChatEscalationAlert({ session, recentMessages })`:
   - Utilizes `sendSESEmail` from [`analytics/notifications.js`](file:///Users/basilsergius/projects/renderpdf/analytics/notifications.js).
   - Recipient: `OperationsAlertEmail` (`vberkoz@gmail.com`).
   - Subject: `[RenderPDF Chat Escalation] <Visitor Email or Anonymous IP> - <Reason>`
   - HTML body: formatted table with customer metadata, plan, reason, transcript excerpt, and deep link to `/app/admin#chats?id=<sessionId>`.

### 2.2 Admin Endpoints (`analytics/index.js`)
Enforce Cognito admin authorization on all routes:
1. `GET /api/v1/admin/chats`:
   - Query params: `status` (`all`, `escalated`, `active`, `resolved`), `limit`, `cursor`.
   - Queries `GSI1PK = CHAT_STATUS#<status>` or table scan with filter.
   - Returns `{ chats: [...], nextCursor }`.
2. `GET /api/v1/admin/chats/{sessionId}`:
   - Fetches metadata item and all associated message records.
   - Sets `unreadByAdmin = false`.
   - Returns `{ sessionId, status, visitorEmail, plan, messages: [...] }`.
3. `POST /api/v1/admin/chats/{sessionId}/reply`:
   - Request body: `{ message, sendEmail }`.
   - Writes message record with `role: "operator"`, `sender: "operator"`.
   - Updates session `updatedAt`.
   - If `sendEmail: true` and `visitorEmail` is present, dispatches SES email reply to the customer.
4. `POST /api/v1/admin/chats/{sessionId}/status`:
   - Updates session status (`resolved`, `active`, `escalated`).

---

## 3. Verification & Acceptance Criteria

1. **Unit Tests (`analytics/chat.test.js`)**:
   - Escalation trigger fires `sendSESEmail` with correct recipient and subject.
   - Admin chat listing returns escalated chats ordered by activity.
   - Operator reply appends to DynamoDB and sends copy to customer email when checked.
   - Non-admin callers receive `403 Forbidden` on admin endpoints.
2. **Execution**:
   ```bash
   npm test --prefix analytics/
   ```
