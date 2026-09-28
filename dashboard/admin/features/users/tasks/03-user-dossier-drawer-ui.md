# Task 2.3: Sliding Support Dossier Drawer UI

| Field | Value |
| :--- | :--- |
| **Task ID** | TASK-USERS-03 |
| **Feature** | [`features/users/`](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/users/spec.md) |
| **Status** | Completed |
| **Target Files** | `dashboard/admin/features/users/users.js`, `dashboard/admin/index.html`, `dashboard/admin/admin.css` |
| **Prerequisites** | Task 2.1 (`01-users-api.md`), `shared/ui.js` |

---

## 1. Objective

Build the sliding side-panel drawer that opens when clicking "Inspect" on any user, displaying their identity, plan status, quota progress, active API keys, and recent render logs.

---

## 2. Technical Requirements

### 2.1 Sliding Drawer Mechanics
- Uses `shared/ui.js` accessible modal/drawer primitives:
  - Traps keyboard focus inside the drawer while open.
  - Closes on clicking the close button `X`, backdrop click, or pressing `Escape`.
  - Sets `aria-modal="true"` and `role="dialog"`.

### 2.2 Dossier Sub-Panels
1. **Card A: Identity**: Full Cognito `sub`, email, account status, creation date.
2. **Card B: Plan & Billing**: Current tier, renewal date, `manualOverride` indicator, and "Change Plan" trigger button.
3. **Card C: Quota**: Gauge of monthly renders used vs limit, and "Grant Credits" trigger button.
4. **Card D: API Keys**: Table of active keys with masked identifiers, creation dates, last-used timestamps, and "Revoke" button.
5. **Card E: Recent Telemetry**: Table of user's last 25 requests (timestamp, status, duration, error message).
6. **Card F: Danger Zone**: "Suspend Account" trigger button.

---

## 3. Verification & Acceptance Criteria

1. Clicking "Inspect" slides open the drawer and fetches dossier via `adminFetch('/users/{userId}')`.
2. Pressing `Escape` closes the drawer and restores focus to the "Inspect" button.
3. Action buttons dispatch events for Feature 03 (Plans) and Feature 04 (Governance).
