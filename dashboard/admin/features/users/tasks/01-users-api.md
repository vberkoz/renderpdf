# Task 2.1: User Directory & Dossier Backend API

| Field | Value |
| :--- | :--- |
| **Task ID** | TASK-USERS-01 |
| **Feature** | [`features/users/`](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/users/spec.md) |
| **Status** | Ready for Implementation |
| **Target Files** | `analytics/index.js`, `analytics/index.test.js` |
| **Prerequisites** | None |

---

## 1. Objective

Implement backend endpoints for searching users and retrieving complete operational dossiers joining Cognito, DynamoDB billing, monthly quotas, active API keys, and recent request logs.

---

## 2. Technical Requirements

### 2.1 Search Users (`GET /api/v1/admin/users`)
- Query parameters: `q` (email or UUID prefix), `tier`, `status`, `limit`, `cursor`.
- Calls Cognito `ListUsersCommand`:
  - When `q` contains `@`: uses `Filter: "email ^= \"${q}\""`.
  - When `q` is a UUID: fetches user directly via `AdminGetUserCommand`.
- Joins `BILLING#<userId>` and `USER_QUOTA#<userId>#YYYY-MM` via `BatchGetItem` for each returned user.
- Returns `{ users: [...], nextCursor }`.

### 2.2 Complete User Dossier (`GET /api/v1/admin/users/{userId}`)
- Path parameter: `userId` (Cognito `sub`).
- Joins:
  1. Cognito `AdminGetUserCommand`: email, creation, verification, enabled state.
  2. `BILLING#<userId>`: tier, provider, manualOverride, renewsAt.
  3. `USER_QUOTA#<userId>#YYYY-MM`: used, limit, remaining.
  4. `API_KEYS_TABLE`: queries `PK = USER#<userId> AND begins_with(SK, "APIKEY#")`.
  5. `USAGE#`: queries last 25 requests for this user via `CustomerIdDateIndex` or customer partition.
- Returns complete unified JSON dossier.

---

## 3. Verification & Acceptance Criteria

1. **Unit Test**: In `analytics/index.test.js`:
   - Mock Cognito client and DynamoDB client.
   - Search by email returns matching records with joined billing and quota details.
   - User dossier returns all 5 data sources combined.
   - Non-admin callers receive `403 Forbidden`.
2. **Command**:
   ```bash
   npm test --prefix analytics/
   ```
