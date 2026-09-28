# Feature Spec: Plans (`/admin/plans`)

| Field | Value |
| :--- | :--- |
| **Feature ID** | FEAT-ADMIN-PLANS |
| **Route** | `/admin/plans` |
| **Feature Path** | `dashboard/admin/features/plans/` |
| **Status** | Approved / In Development |
| **Target Surface** | Backend Plan & Quota APIs, Paddle Webhook Guard in `analytics/index.js`, Frontend Modals |
| **Parent Spec** | [Master Spec: SPEC-ADMIN-MASTER](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/spec.md) |

---

## 1. Overview & Objective

Enable administrators to manually adjust a customer's plan tier or monthly render quota without causing desynchronizations with API Gateway rate limits or Paddle billing webhooks.

Key Capabilities:
1. **Plan Tier Overrides**: Change user tier (`free`, `starter`, `pro`, `enterprise`).
2. **Automated API Gateway Sync**: Automatically moves the user's active API keys between API Gateway Usage Plans (`FreeUsagePlan`, `StarterUsagePlan`, `ProUsagePlan`).
3. **Paddle Webhook Guard**: Flags the account with `manualOverride: true` so automated webhooks from Paddle will not downgrade an enterprise or VIP account.
4. **Emergency Quota Relief**: Grant one-off bonus credits or reset monthly render counts for customer support goodwill.

---

## 2. Paddle Webhook Interoperability Guard

In [`analytics/index.js`](file:///Users/basilsergius/projects/renderpdf/analytics/index.js#L982), `saveBillingWebhook` receives Paddle subscription events.

### The Guard Logic
```javascript
// Inside saveBillingWebhook:
if (previousBilling?.manualOverride === true) {
  const isDowngradeOrCancel = ['subscription.canceled', 'subscription.paused', 'subscription.past_due'].includes(eventType) ||
    (attributes?.status === 'canceled');
  
  if (isDowngradeOrCancel) {
    console.log(`Paddle webhook ignored: manualOverride is active for user ${userId}`);
    return; // Preserve the admin's manual entitlement
  }
}
```

---

## 3. API Contracts

### 3.1 Plan Override
`POST /api/v1/admin/users/{userId}/plan`

**Request Body**:
```json
{
  "tier": "pro",
  "manualOverride": true,
  "reason": "Enterprise contract Q4",
  "customMonthlyQuota": 25000
}
```

**Side Effects & Invariants**:
1. Updates `BILLING#<userId>`: sets `tier = "pro"`, `manualOverride = true`, `overrideReason = "..."`, `overrideSetBy = <admin_email>`.
2. Updates `USER_QUOTA#<userId>#YYYY-MM`: sets `#limit = 25000`.
3. Invokes [`syncUserUsagePlans(userId, "pro")`](file:///Users/basilsergius/projects/renderpdf/analytics/index.js#L1068): detaches keys from Free/Starter and attaches to `ProUsagePlan`.
4. Appends audit log to `ADMIN_AUDIT#YYYY-MM-DD`.

**Response `200 OK`**:
```json
{
  "success": true,
  "userId": "c1f7b76e-3c2e-4b21-8273-df3e18a992bc",
  "tier": "pro",
  "manualOverride": true,
  "quotaLimit": 25000
}
```

### 3.2 Quota Adjustments
`POST /api/v1/admin/users/{userId}/quota`

**Request Body**:
```json
{
  "action": "add_credits",
  "amount": 1000,
  "reason": "Goodwill grant for webhook retries"
}
```

*Allowed `action` values*: `add_credits`, `set_limit`, `reset_usage`.

**Response `200 OK`**:
```json
{
  "success": true,
  "userId": "c1f7b76e-3c2e-4b21-8273-df3e18a992bc",
  "month": "2026-09",
  "used": 412,
  "limit": 6000,
  "remaining": 5588
}
```

---

## 4. Frontend UI Module (`features/03-plan-quota-management/plans.js`)

Exports `initPlanQuotaModals()`:
1. **"Change Plan" Modal**:
   - Radio buttons for `Free`, `Starter`, `Pro`, `Enterprise`.
   - Checkbox for "Lock Plan (Prevent Paddle Webhook Overwrite)".
   - Required "Reason for Change" text field.
2. **"Grant Quota Credits" Modal**:
   - Preset buttons (+500, +1,000, +5,000) or custom input.
   - Required reason text field.

---

## 5. Acceptance Criteria & Test Matrix

- **TC-03-A**: Changing plan tier immediately updates the user's API keys in API Gateway to the target Usage Plan.
- **TC-03-B**: When `manualOverride: true`, a simulated Paddle cancellation webhook does not alter the user's Pro plan.
- **TC-03-C**: Granting render credits atomically updates `#limit` in `USER_QUOTA#<userId>#YYYY-MM`.

---

## 6. Implementation Tasks

- [x] [Task 3.1: Paddle Webhook Conflict Guard](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/plans/tasks/01-paddle-webhook-guard.md)
- [x] [Task 3.2: Plan Override & Quota Backend APIs](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/plans/tasks/02-plan-quota-api.md)
- [x] [Task 3.3: Plan & Quota Management Modals UI](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/plans/tasks/03-plan-quota-modals-ui.md)
