# Feature Spec: Users (`/admin/users`)

| Field | Value |
| :--- | :--- |
| **Feature ID** | FEAT-ADMIN-USERS |
| **Route** | `/admin/users` |
| **Feature Path** | `dashboard/admin/features/users/` |
| **Status** | Approved / In Development |
| **Target Surface** | Backend User APIs (`GET /api/v1/admin/users*`), Frontend User Table & Sliding Drawer |
| **Parent Spec** | [Master Spec: SPEC-ADMIN-MASTER](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/spec.md) |

---

## 1. Overview & Objective

Empower operators and support engineers to quickly search for any customer by email address or Cognito subject ID (`sub`), inspect their operational state, and diagnose issues without raw database queries.

The sliding dossier brings together:
1. **Cognito Profile**: Email, verification status, creation date, enabled status.
2. **Billing State**: Plan tier, provider (`paddle` vs `manual`), renewal dates.
3. **Monthly Quota**: Progress gauge of used vs limit for the current month.
4. **Active API Keys**: Key IDs, names, creation, and last-used timestamps.
5. **Recent Request Telemetry**: Last 25 renders with durations, sizes, and error types.

---

## 2. API Contracts

### 2.1 Search & List Users
`GET /api/v1/admin/users?q={query}&tier={tier}&status={status}&limit={limit}&cursor={cursor}`

**Query Parameters**:
- `q`: Search string matching email prefix or Cognito `sub`.
- `tier`: Filter by tier (`all`, `free`, `starter`, `pro`).
- `status`: Filter by billing status (`all`, `active`, `past_due`, `canceled`).
- `limit`: Default `25`, max `100`.
- `cursor`: Pagination token.

**Response `200 OK`**:
```json
{
  "users": [
    {
      "id": "c1f7b76e-3c2e-4b21-8273-df3e18a992bc",
      "email": "customer@acme.com",
      "tier": "starter",
      "status": "active",
      "provider": "paddle",
      "manualOverride": false,
      "quotaUsed": 412,
      "quotaLimit": 5000,
      "quotaMonth": "2026-09",
      "activeKeys": 2,
      "createdAt": "2026-04-12T14:22:00Z"
    }
  ],
  "nextCursor": null
}
```

### 2.2 Detailed User Dossier
`GET /api/v1/admin/users/{userId}`

Joins Cognito `AdminGetUser`, `BILLING#<userId>`, `USER_QUOTA#<userId>#YYYY-MM`, `API_KEYS_TABLE`, and `USAGE#` telemetry.

**Response `200 OK`**:
```json
{
  "user": {
    "id": "c1f7b76e-3c2e-4b21-8273-df3e18a992bc",
    "email": "customer@acme.com",
    "emailVerified": true,
    "enabled": true,
    "createdAt": "2026-04-12T14:22:00Z"
  },
  "billing": {
    "tier": "starter",
    "status": "active",
    "plan": "RenderPDF Starter",
    "provider": "paddle",
    "manualOverride": false,
    "subscriptionId": "sub_01h6t8z...",
    "renewsAt": "2026-10-12T14:22:00Z"
  },
  "quota": {
    "month": "2026-09",
    "used": 412,
    "limit": 5000,
    "remaining": 4588
  },
  "apiKeys": [
    {
      "keyId": "key_9f82d1c...",
      "name": "Production Backend",
      "isActive": true,
      "createdAt": 1712931720,
      "lastUsed": 1727289120
    }
  ],
  "recentRequests": [
    {
      "requestId": "req_8471b0...",
      "timestamp": 1727289120,
      "status": "success",
      "errorType": "",
      "durationMs": 482,
      "size": 184920
    }
  ]
}
```

---

## 3. Frontend UI Module (`features/02-user-directory/users.js`)

Exports `initUserDirectoryTab()`:
1. Manages search input with 300ms debounce.
2. Renders the paginated user table with inline visual quota progress bars.
3. Implements the **Sliding User Drawer**:
   - Opens on clicking "Inspect".
   - Traps keyboard focus, closes on `Escape` or backdrop click.
   - Houses action buttons to trigger plan changes, quota grants, or key revocations.

---

## 4. Acceptance Criteria & Test Matrix

- **TC-02-A**: Searching by an email fragment returns matching users in $<300\text{ms}$.
- **TC-02-B**: Opening the user dossier loads their Cognito profile, billing record, quota, keys, and logs in a single unified view.
- **TC-02-C**: Drawer navigation meets accessibility standards (focus management and ARIA attributes).

---

## 5. Implementation Tasks

- [x] [Task 2.1: User Directory & Dossier Backend API](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/users/tasks/01-users-api.md)
- [x] [Task 2.2: User Directory Table & Search UI](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/users/tasks/02-user-table-ui.md)
- [x] [Task 2.3: Sliding Support Dossier Drawer UI](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/users/tasks/03-user-dossier-drawer-ui.md)
