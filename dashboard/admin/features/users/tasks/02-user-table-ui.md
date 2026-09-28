# Task 2.2: User Directory Table & Search UI

| Field | Value |
| :--- | :--- |
| **Task ID** | TASK-USERS-02 |
| **Feature** | [`features/users/`](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/users/spec.md) |
| **Status** | Ready for Implementation |
| **Target Files** | `dashboard/admin/features/users/users.js`, `dashboard/admin/index.html` |
| **Prerequisites** | Task 2.1 (`01-users-api.md`), `shared/api.js` |

---

## 1. Objective

Build the paginated User Directory Table in `features/users/users.js` with debounced search, plan & status dropdown filtering, and inline quota consumption progress bars.

---

## 2. Technical Requirements

### 2.1 Module Interface
Exports:
```javascript
export async function initUserDirectoryTab(containerElement) { ... }
```

### 2.2 UI Elements
1. **Search & Filter Toolbar**:
   - Text input for email/UUID with 300ms debounce.
   - Dropdown for Tier: `All`, `Free`, `Starter`, `Pro`.
   - Dropdown for Status: `All`, `Active`, `Past Due`, `Canceled`.
2. **Users Data Table**:
   - Columns:
     - **Email**: Customer email and Cognito ID snippet.
     - **Tier Badge**: `Free` (gray), `Starter` (blue), `Pro` (purple), `Override` (amber asterisk).
     - **Monthly Quota**: Progress bar showing `used / limit` with percentage fill.
     - **Status Badge**: `Active` (green), `Past Due` (amber), `Canceled` (red).
     - **Actions**: "Inspect" button that fires custom event `open-user-dossier` with the `userId`.
3. **Pagination Bar**:
   - Shows current count and `Previous` / `Next` controls.

---

## 3. Verification & Acceptance Criteria

1. Typing in search bar triggers API request after 300ms idle.
2. Clicking dropdown filter immediately refilters the table.
3. Clicking "Inspect" triggers the user dossier drawer (Task 2.3).
