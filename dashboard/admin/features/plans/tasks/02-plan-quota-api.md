# Task 3.2: Plan Override & Quota Backend APIs

| Field | Value |
| :--- | :--- |
| **Task ID** | TASK-PLANS-02 |
| **Feature** | [`features/plans/`](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/plans/spec.md) |
| **Status** | Completed |
| **Target Files** | `analytics/index.js`, `analytics/index.test.js` |
| **Prerequisites** | Task 3.1 (`01-paddle-webhook-guard.md`) |

---

## 1. Objective

Implement the backend mutation endpoints for changing a customer's plan tier and adjusting monthly render quotas, ensuring API Gateway Usage Plans are automatically updated.

---

## 2. Technical Requirements

### 2.1 Plan Override Endpoint (`POST /api/v1/admin/users/{userId}/plan`)
- Body: `{ tier, manualOverride, reason, customMonthlyQuota }`.
- Actions:
  1. Update `BILLING#<userId>`:
     - Sets `tier = tier`.
     - Sets `status = "active"`.
     - Sets `manualOverride = Boolean(manualOverride)`.
     - Sets `overrideReason = reason`.
     - Sets `overrideSetBy = adminEmail`.
     - Sets `overrideSetAt = ISO timestamp`.
  2. Recalculate and update `USER_QUOTA#<userId>#YYYY-MM`:
     - Sets `#limit` to `customMonthlyQuota` or tier default (Free: 25, Starter: 5,000, Pro: 20,000).
  3. Invoke existing [`syncUserUsagePlans(userId, tier)`](file:///Users/basilsergius/projects/renderpdf/analytics/index.js#L1068) to move all active API keys in API Gateway.
  4. Record mutation in `ADMIN_AUDIT`.

### 2.2 Quota Adjustment Endpoint (`POST /api/v1/admin/users/{userId}/quota`)
- Body: `{ action, amount, reason }`.
- Actions:
  - `add_credits`: Increases `#limit` by `amount`.
  - `set_limit`: Overwrites `#limit` to `amount`.
  - `reset_usage`: Sets `#used` to `0`.
  - Record mutation in `ADMIN_AUDIT`.

---

## 3. Verification & Acceptance Criteria

1. **Unit Test**: In `analytics/index.test.js`:
   - Admin upgrading user to Pro calls `syncUserUsagePlans` and sets `tier = "pro"`.
   - Adding 1,000 credits increases stored quota limit by 1,000.
   - Non-admin callers receive `403 Forbidden`.
2. **Command**:
   ```bash
   npm test --prefix analytics/
   ```
