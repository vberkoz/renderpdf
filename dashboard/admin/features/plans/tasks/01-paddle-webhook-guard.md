# Task 3.1: Paddle Webhook Conflict Guard

| Field | Value |
| :--- | :--- |
| **Task ID** | TASK-PLANS-01 |
| **Feature** | [`features/plans/`](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/plans/spec.md) |
| **Status** | Ready for Implementation |
| **Target Files** | `analytics/index.js`, `analytics/index.test.js` |
| **Prerequisites** | None |

---

## 1. Objective

Protect manually upgraded VIP, enterprise, or complimentary accounts from being downgraded by automated webhooks sent by Paddle (e.g. if the customer cancels their old credit card subscription after switching to an annual invoice).

---

## 2. Technical Requirements

### 2.1 Webhook Guard Logic
In [`analytics/index.js`](file:///Users/basilsergius/projects/renderpdf/analytics/index.js#L982), inside `saveBillingWebhook(userId, subscriptionId, attributes, eventId, occurredAt, eventType)`:

1. Check existing record `previousBilling = await getBilling(userId)`.
2. Inspect `previousBilling?.manualOverride`:
   ```javascript
   if (previousBilling?.manualOverride === true) {
     const isDowngradeOrCancel = 
       ['subscription.canceled', 'subscription.paused', 'subscription.past_due'].includes(eventType) ||
       attributes?.status === 'canceled' ||
       attributes?.status === 'past_due';

     if (isDowngradeOrCancel) {
       console.log(`Paddle webhook ignored: manualOverride is active for user ${userId} (${eventType})`);
       return; // Preserve the admin's manual plan
     }
   }
   ```
3. If an incoming event is a legitimate paid upgrade (e.g. customer purchases a higher tier self-serve), clear `manualOverride` and adopt the new paid tier.

---

## 3. Verification & Acceptance Criteria

1. **Unit Test**: In `analytics/index.test.js`:
   - Mock a user with `manualOverride: true` and `tier: "pro"`.
   - Dispatch simulated `subscription.canceled` webhook.
   - Verify that DynamoDB `UpdateItem` is NOT called to downgrade the user, and function returns successfully.
   - Dispatch simulated webhook for a normal user (`manualOverride: false`) and verify downgrade occurs as normal.
2. **Command**:
   ```bash
   npm test --prefix analytics/
   ```
