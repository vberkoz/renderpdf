# Task 4.1: Immutable Audit Trail Data Layer

| Field | Value |
| :--- | :--- |
| **Task ID** | TASK-AUDIT-01 |
| **Feature** | [`features/audit-logs/`](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/audit-logs/spec.md) |
| **Status** | Completed |
| **Target Files** | `analytics/index.js`, `analytics/index.test.js` |
| **Prerequisites** | None |

---

## 1. Objective

Implement the append-only `ADMIN_AUDIT#YYYY-MM-DD` DynamoDB partition and helper function to record an immutable record of every administrative action (plan changes, quota modifications, suspensions, key revocations) with a 365-day TTL.

---

## 2. Technical Requirements

### 2.1 Audit Schema
- `requestId`: `ADMIN_AUDIT#<YYYY-MM-DD>`
- `timestamp`: `<now_unix_seconds>`
- `entityType`: `"ADMIN_AUDIT"`
- `auditId`: unique random UUID
- `adminEmail`: operating admin email
- `targetUserId`: affected customer `sub`
- `action`: e.g. `PLAN_OVERRIDE`, `QUOTA_ADJUST`, `USER_SUSPEND`, `KEY_REVOKE`
- `reason`: administrator explanation
- `details`: map of before/after attributes
- `expiresAt`: `<now_plus_365_days>`

### 2.2 Helper Function in `analytics/index.js`
```javascript
async function recordAdminAudit({ adminEmail, targetUserId, action, reason, details }) {
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  const auditId = crypto.randomUUID();
  const expiresAt = Math.floor(now.getTime() / 1000) + (365 * 86400);

  await ddb.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      requestId: { S: `ADMIN_AUDIT#${dateKey}` },
      timestamp: { N: String(Math.floor(now.getTime() / 1000)) },
      entityType: { S: 'ADMIN_AUDIT' },
      auditId: { S: auditId },
      adminEmail: { S: adminEmail || 'unknown' },
      targetUserId: { S: targetUserId || '' },
      action: { S: action },
      reason: { S: reason || '' },
      details: { S: JSON.stringify(details || {}) },
      expiresAt: { N: String(expiresAt) }
    }
  }));
}
```

---

## 3. Verification & Acceptance Criteria

1. **Unit Test**: In `analytics/index.test.js`:
   - Mock DynamoDB `PutItemCommand`.
   - Verify `recordAdminAudit` puts an item with the expected partition key, sort key, and 365-day expiration timestamp.
2. **Command**:
   ```bash
   npm test --prefix analytics/
   ```
