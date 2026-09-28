# Task 4.2: Governance APIs (Suspension & Key Revocation)

| Field | Value |
| :--- | :--- |
| **Task ID** | TASK-AUDIT-02 |
| **Feature** | [`features/audit-logs/`](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/audit-logs/spec.md) |
| **Status** | Completed |
| **Target Files** | `analytics/index.js`, `analytics/index.test.js` |
| **Prerequisites** | Task 4.1 (`01-audit-trail-data-layer.md`) |

---

## 1. Objective

Implement backend endpoints for suspending/activating accounts in Cognito, revoking compromised API keys, and listing historical audit logs.

---

## 2. Technical Requirements

### 2.1 Account Status Endpoint (`POST /api/v1/admin/users/{userId}/status`)
- Body: `{ action: "disable" | "enable", reason }`.
- Actions:
  - When `action === "disable"`: calls Cognito `AdminDisableUserCommand` and marks all API keys in `API_KEYS_TABLE` as `isActive: false`.
  - When `action === "enable"`: calls Cognito `AdminEnableUserCommand`.
  - Records event in `ADMIN_AUDIT`.

### 2.2 Key Revocation Endpoint (`POST /api/v1/admin/users/{userId}/keys/{keyId}/revoke`)
- Body: `{ reason }`.
- Actions:
  - Updates item in `API_KEYS_TABLE`: `SET isActive = :false`.
  - Removes key association from API Gateway Usage Plan or deletes key in API Gateway.
  - Records event in `ADMIN_AUDIT`.

### 2.3 List Audit Logs (`GET /api/v1/admin/audit-logs?days={days}&limit={limit}`)
- Queries `ADMIN_AUDIT#YYYY-MM-DD` across the requested days (default 30).
- Sorts by timestamp descending and returns `{ logs: [...] }`.

---

## 3. Verification & Acceptance Criteria

1. **Unit Test**: In `analytics/index.test.js`:
   - Disabling user calls Cognito `AdminDisableUserCommand` and deactivates keys.
   - Revoking key marks it inactive in DynamoDB and invokes `recordAdminAudit`.
   - Querying audit logs returns expected records.
   - Non-admin callers receive `403 Forbidden`.
2. **Command**:
   ```bash
   npm test --prefix analytics/
   ```
