# Feature Spec: Audit Logs (`/admin/audit-logs`)

| Field | Value |
| :--- | :--- |
| **Feature ID** | FEAT-ADMIN-AUDIT-LOGS |
| **Route** | `/admin/audit-logs` |
| **Feature Path** | `dashboard/admin/features/audit-logs/` |
| **Status** | Approved / In Development |
| **Target Surface** | Backend Status/Revoke Endpoints, DynamoDB Audit Partition, Frontend Audit Tab & Danger Zone |
| **Parent Spec** | [Master Spec: SPEC-ADMIN-MASTER](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/spec.md) |

---

## 1. Overview & Objective

Maintain strict security governance and compliance by providing emergency controls to suspend abusive accounts, revoke compromised API keys, and record an immutable audit trail of every administrative mutation.

Key Capabilities:
1. **Account Suspension / Activation**: Cognito `AdminDisableUser` / `AdminEnableUser` + API key deactivation.
2. **Emergency Key Revocation**: Deactivate leaked keys on behalf of users.
3. **Immutable Audit Trail**: Append-only log of every plan change, quota adjustment, and suspension in DynamoDB with a 365-day retention.

---

## 2. Audit Trail Data Model (`ADMIN_AUDIT#<dateKey>`)

Partition Key: `requestId = "ADMIN_AUDIT#<YYYY-MM-DD>"`  
Sort Key: `timestamp = <now_unix_seconds>`  
Entity Type: `entityType = "ADMIN_AUDIT"`  
TTL: `expiresAt = <now_plus_365_days>`

```json
{
  "requestId": "ADMIN_AUDIT#2026-09-27",
  "timestamp": 1727445600,
  "entityType": "ADMIN_AUDIT",
  "auditId": "aud_9a8b7c...",
  "adminEmail": "vberkoz@gmail.com",
  "targetUserId": "c1f7b76e-3c2e-4b21-8273-df3e18a992bc",
  "action": "PLAN_OVERRIDE",
  "reason": "Enterprise sponsorship deal Q4",
  "details": {
    "previousTier": "starter",
    "newTier": "pro",
    "manualOverride": true
  },
  "expiresAt": 1758981600
}
```

---

## 3. API Contracts

### 3.1 Account Suspension / Activation
`POST /api/v1/admin/users/{userId}/status`

**Request Body**:
```json
{
  "action": "disable",
  "reason": "Terms of Service violation - automated scraping"
}
```

*Side Effects*:
- Invokes Cognito `AdminDisableUser` or `AdminEnableUser`.
- Updates `isActive` to `false` for all API keys belonging to this user in `API_KEYS_TABLE`.
- Writes an event to `ADMIN_AUDIT`.

### 3.2 Revoke API Key
`POST /api/v1/admin/users/{userId}/keys/{keyId}/revoke`

**Request Body**:
```json
{
  "reason": "Public key leak on GitHub"
}
```

### 3.3 List Audit Logs
`GET /api/v1/admin/audit-logs?limit={limit}&cursor={cursor}`

Returns paginated records from the `ADMIN_AUDIT` partition for the last 30 days.

---

## 4. Frontend UI Module (`features/04-governance-audit/governance.js`)

Exports `initGovernanceTab()`:
1. **Audit Logs Tab**: Chronological table showing timestamp, admin email, target customer, action type, and reason note.
2. **Danger Zone Actions in User Drawer**:
   - High-contrast red "Suspend Account" button with double confirmation prompt.
   - Individual "Revoke Key" confirmation modals.

---

## 5. Acceptance Criteria & Test Matrix

- **TC-04-A**: Disabling an account immediately prevents API Gateway and Cognito from accepting the user's credentials.
- **TC-04-B**: Revoking a key marks `isActive: false` in DynamoDB and removes it from API Gateway.
- **TC-04-C**: Every mutating API call creates a record in `ADMIN_AUDIT#YYYY-MM-DD` with admin email and reason.

---

## 6. Implementation Tasks

- [x] [Task 4.1: Immutable Audit Trail Data Layer](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/audit-logs/tasks/01-audit-trail-data-layer.md)
- [x] [Task 4.2: Governance APIs (Suspension & Key Revocation)](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/audit-logs/tasks/02-governance-api.md)
- [x] [Task 4.3: Audit Trail Tab & Danger Zone UI](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/audit-logs/tasks/03-governance-ui.md)
