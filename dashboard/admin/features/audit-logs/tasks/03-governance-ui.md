# Task 4.3: Audit Trail Tab & Danger Zone UI

| Field | Value |
| :--- | :--- |
| **Task ID** | TASK-AUDIT-03 |
| **Feature** | [`features/audit-logs/`](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/audit-logs/spec.md) |
| **Status** | Completed |
| **Target Files** | `dashboard/admin/features/audit-logs/governance.js`, `dashboard/admin/index.html` |
| **Prerequisites** | Task 4.2 (`02-governance-api.md`), `shared/ui.js` |

---

## 1. Objective

Build the frontend UI module `features/audit-logs/governance.js` providing the Audit Trail history table and the Danger Zone action modals (Account Suspension and Key Revocation).

---

## 2. Technical Requirements

### 2.1 Module Interface
Exports:
```javascript
export async function initGovernanceTab(containerElement) { ... }
export function openSuspendUserModal(userId, userEmail) { ... }
export function openRevokeKeyModal(userId, keyId, keyName) { ... }
```

### 2.2 UI Elements
1. **Audit Logs Tab Table**:
   - Columns: Timestamp (relative & absolute), Admin Email, Target User, Action Badge (`PLAN_OVERRIDE`, `QUOTA_ADJUST`, `USER_SUSPEND`, `KEY_REVOKE`), Reason, and Change Summary.
   - Filter by Action type and date range.
2. **"Suspend User Account" Danger Modal**:
   - High-contrast red warning theme.
   - Requires typing the customer's email or "SUSPEND" to confirm.
   - Required reason text field.
   - Dispatches `POST /users/{userId}/status`.
3. **"Revoke API Key" Modal**:
   - Warning that active client integrations will immediately fail with 401.
   - Required reason text field.
   - Dispatches `POST /users/{userId}/keys/{keyId}/revoke`.

---

## 3. Verification & Acceptance Criteria

1. Navigating to `#audit-logs` tab loads the audit table via `adminFetch('/audit-logs')`.
2. Confirming suspension triggers API call, updates UI state, and displays toast.
3. Accessible focus management functions properly on confirmation dialogs.
