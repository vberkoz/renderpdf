# Task 1.3: Analytics & Unit Economics Frontend Tab

| Field | Value |
| :--- | :--- |
| **Task ID** | TASK-ANALYTICS-03 |
| **Feature** | [`features/analytics/`](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/analytics/spec.md) |
| **Status** | Completed |
| **Target Files** | `dashboard/admin/features/analytics/analytics.js`, `dashboard/admin/index.html`, `dashboard/admin/admin.js` |
| **Prerequisites** | Task 1.2 (`02-analytics-api.md`), `shared/api.js` |

---

## 1. Objective

Build the frontend UI module `features/analytics/analytics.js` that renders the Growth Funnel, Onboarding Velocity (TTFC), Unit Economics, and Latency Distribution cards inside the admin console.

---

## 2. Technical Requirements

### 2.1 Module Interface
Exports:
```javascript
export async function initAnalyticsTab(containerElement) { ... }
```

### 2.2 UI Components
1. **Summary Bar**: High-level metric cards:
   - MRR ($)
   - Real-Time Gross Margin (%)
   - AWS Cost per 1,000 PDFs ($)
   - Active Subscriptions count
2. **Growth Funnel Visualizer**:
   - Visual conversion bar chart: Visitors $\to$ Playground Renders $\to$ Signups $\to$ API Key Created $\to$ First API Call $\to$ Paid Upgrade.
   - Shows conversion percentage at each step.
3. **Unit Economics & Daily Trends Table**:
   - Date, Renders, Errors, Revenue, AWS Cost, Gross Margin %, P95 ms.
4. **Latency Histogram**:
   - Percentage of renders under 400ms, 400–800ms, 800–1500ms, over 1500ms.

---

## 3. Verification & Acceptance Criteria

1. Tab loads dynamically when navigating to `#analytics` or clicking the "Overview" tab.
2. Data fetches via `adminFetch('/analytics?days=30')`.
3. Handles loading skeleton and error retry banners gracefully.
