# Task 3.3: Plan & Quota Management Modals UI

| Field | Value |
| :--- | :--- |
| **Task ID** | TASK-PLANS-03 |
| **Feature** | [`features/plans/`](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/plans/spec.md) |
| **Status** | Ready for Implementation |
| **Target Files** | `dashboard/admin/features/plans/plans.js`, `dashboard/admin/index.html` |
| **Prerequisites** | Task 3.2 (`02-plan-quota-api.md`), `shared/ui.js` |

---

## 1. Objective

Build the interactive "Change Plan Tier" and "Grant Render Credits" modal interfaces in `features/plans/plans.js` with required reason validation and toast feedback.

---

## 2. Technical Requirements

### 2.1 Module Interface
Exports:
```javascript
export function initPlanQuotaModals() { ... }
export function openChangePlanModal(userId, currentTier, currentOverride) { ... }
export function openGrantCreditsModal(userId, currentQuota) { ... }
```

### 2.2 Modal Specifications
1. **"Change Plan Tier" Modal**:
   - Radio group for Tier: `Free`, `Starter`, `Pro`, `Enterprise`.
   - Checkbox: "Lock Plan (Prevent Paddle Webhook Overwrite)".
   - Required textarea: "Reason for Change (Logged to Audit Trail)".
   - Submit button: calls `adminFetch('/users/{userId}/plan', { method: 'POST', body: ... })`.
   - On success: closes modal, shows success toast via `shared/ui.js`, dispatches `user-updated` event.
2. **"Grant Render Credits" Modal**:
   - Preset buttons (+500, +1,000, +5,000) that populate a number input.
   - Required reason input.
   - Submit button: calls `adminFetch('/users/{userId}/quota', { method: 'POST', body: ... })`.
   - On success: closes modal, shows success toast, dispatches `user-updated` event.

---

## 3. Verification & Acceptance Criteria

1. Submitting without a reason is blocked by client-side validation.
2. Submitting successfully fires the API call, closes the modal, and shows a green toast.
3. Accessible focus trap and `Escape` key close behavior function properly.
