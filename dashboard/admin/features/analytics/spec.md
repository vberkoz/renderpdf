# Feature Spec: Analytics (`/admin/analytics`)

| Field | Value |
| :--- | :--- |
| **Feature ID** | FEAT-ADMIN-ANALYTICS |
| **Route** | `/admin/analytics` |
| **Feature Path** | `dashboard/admin/features/analytics/` |
| **Status** | Approved / In Development |
| **Target Surface** | Backend Rollup Engine (`analytics/index.js`), API Endpoint (`GET /api/v1/admin/analytics`), and Frontend Overview/Economics Tab |
| **Parent Spec** | [Master Spec: SPEC-ADMIN-MASTER](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/spec.md) |

---

## 1. Overview & Objective

Replace the existing multi-thousand item DynamoDB partition scans with an **$O(1)$ pre-aggregated daily rollup engine** (`ROLLUP#YYYY-MM-DD`). 

This engine:
1. Eliminates scan latency and high RCU consumption across 30–90 day analytics queries.
2. Tracks full acquisition-to-paid conversion funnels natively without third-party trackers.
3. Computes developer Time to First Call (TTFC) using histogram bucketing.
4. Calculates real-time gross margins and AWS infrastructure costs per 1,000 PDFs.
5. Computes P95 render latency in constant time using latency histograms.

---

## 2. Data Model: Daily Rollup Schema

Partition Key: `requestId = "ROLLUP#<YYYY-MM-DD>"`  
Sort Key: `timestamp = 0`  
Entity Type: `entityType = "DAILY_ROLLUP"`  
TTL: None (Permanent historical summary)

```json
{
  "requestId": "ROLLUP#2026-09-27",
  "timestamp": 0,
  "entityType": "DAILY_ROLLUP",

  "acquisition": {
    "pageViews": 2450,
    "playgroundSubmits": 420,
    "playgroundSuccesses": 412,
    "playgroundErrors": 8,
    "templateSwitches": { "invoice": 210, "receipt": 140, "contract": 70 },
    "snippetsCopied": { "curl": 180, "python": 95, "nodejs": 85, "go": 32 }
  },

  "activation": {
    "signupStarted": 85,
    "signupCompleted": 78,
    "apiKeysCreated": 52,
    "firstApiCalls": 34,
    "ttfcBuckets": {
      "under_5m": 22,
      "5m_to_30m": 8,
      "30m_to_2h": 3,
      "over_2h": 1
    }
  },

  "monetization": {
    "pricingClicks": { "starter": 110, "pro": 75 },
    "checkoutsInitiated": 18,
    "checkoutsCompleted": 7,
    "overagePurchases": 3,
    "overageRevenueUsd": 15,
    "quotaThreshold80Hit": 14,
    "quotaThreshold100Hit": 6
  },

  "rendering": {
    "totalRenders": 14200,
    "successes": 14182,
    "errors": 18,
    "totalDurationMs": 6816000,
    "totalBytes": 2840000000,
    "byPlan": { "free": 1200, "starter": 6500, "pro": 6500 },
    "latencyBuckets": {
      "under_400ms": 9800,
      "400ms_to_800ms": 3800,
      "800ms_to_1500ms": 550,
      "over_1500ms": 50
    }
  }
}
```

---

## 3. Ingestion & Atomic Update Expressions

### 3.1 PDF Render Completion (`api/main.go` / `analytics/index.js`)
Executed synchronously when a PDF render finishes:
```javascript
const durationBucket = 
  durationMs < 400 ? 'under_400ms' :
  durationMs < 800 ? '400ms_to_800ms' :
  durationMs < 1500 ? '800ms_to_1500ms' : 'over_1500ms';

await ddb.send(new UpdateItemCommand({
  TableName: TABLE_NAME,
  Key: { requestId: { S: `ROLLUP#${dateKey(now)}` }, timestamp: { N: '0' } },
  UpdateExpression: `
    ADD rendering.totalRenders :one,
        rendering.totalBytes :size,
        rendering.totalDurationMs :duration,
        #rendSuccess :succIncr,
        #rendError :errIncr,
        rendering.byPlan.#plan :one,
        rendering.latencyBuckets.#latBucket :one
  `,
  ExpressionAttributeNames: {
    '#rendSuccess': status === 'success' ? 'rendering.successes' : 'dummy_attr',
    '#rendError': status !== 'success' ? 'rendering.errors' : 'dummy_attr',
    '#plan': requestPlan,
    '#latBucket': durationBucket
  },
  ExpressionAttributeValues: {
    ':one': { N: '1' },
    ':size': { N: String(pdfBytes) },
    ':duration': { N: String(durationMs) },
    ':succIncr': { N: status === 'success' ? '1' : '0' },
    ':errIncr': { N: status !== 'success' ? '1' : '0' }
  }
}));
```

### 3.2 Time to First Call (TTFC)
1. On signup, write `createdAt = <now_unix>` to `BILLING#<userId>`.
2. On first successful API key render, conditionally write `firstRenderAt = now` and compute $\Delta t = \text{now} - \text{createdAt}$.
3. Classify $\Delta t$ into bucket (`under_5m`, `5m_to_30m`, `30m_to_2h`, `over_2h`) and atomically increment `activation.ttfcBuckets.<bucket>` on today's `ROLLUP#YYYY-MM-DD`.

---

## 4. Analytical & Financial Formulas

1. **Estimated AWS Infrastructure Cost per Day**:
   $$\text{Lambda Cost} = \frac{\text{totalDurationMs}}{1000} \times \left(\frac{2048\text{ MB}}{1024}\right) \times \$0.0000166667/\text{GB-s} + \left(\text{totalRenders} \times \frac{\$0.20}{10^6}\right)$$
   $$\text{S3 Cost} = \left(\text{totalRenders} \times \frac{\$0.005}{10^3}\right) + \left(\frac{\text{totalBytes}}{10^9} \times \$0.023/\text{GB}\right)$$
2. **Gross Margin Percentage**:
   $$\text{Gross Margin \%} = \frac{\text{Attributed Revenue} - (\text{Lambda Cost} + \text{S3 Cost})}{\text{Attributed Revenue}} \times 100$$
3. **P95 Latency via Histogram Interpolation**:
   Sum total renders $N = \sum \text{latencyBuckets}$. Find the 95th percentile index $0.95 \times N$ and linearly interpolate the latency inside that bucket.

---

## 5. API Contract

### `GET /api/v1/admin/analytics?days={days}`
Requires `Authorization: Bearer <id_token>` with Admin privileges.

**Response `200 OK`**:
```json
{
  "summary": {
    "totalUsers": 1420,
    "activeSubscriptions": 84,
    "mrrUsd": 3456.00,
    "grossMarginPercent": 89.4,
    "costPerThousandPdfsUsd": 0.26
  },
  "funnel": {
    "pageViews": 73500,
    "playgroundSubmits": 12600,
    "playgroundActivationRate": 17.1,
    "signupsCompleted": 840,
    "trialToSignupRate": 6.7,
    "apiKeysCreated": 580,
    "signupToKeyRate": 69.0,
    "firstApiCalls": 410,
    "ttfcMedianMinutes": 4.2
  },
  "rendering": {
    "totalRenders": 426000,
    "successRate": 99.87,
    "averageRenderMs": 480,
    "p95RenderMs": 720,
    "latencyHistogram": {
      "under_400ms": 294000,
      "400ms_to_800ms": 114000,
      "800ms_to_1500ms": 16500,
      "over_1500ms": 1500
    }
  },
  "dailyRollups": [
    {
      "date": "2026-09-27",
      "renders": 14200,
      "revenueUsd": 115.20,
      "estimatedAwsCostUsd": 3.69,
      "marginPercent": 96.8,
      "p95Ms": 690
    }
  ]
}
```

---

## 6. Frontend UI Module (`features/01-analytics/analytics.js`)

Exports `initAnalyticsTab()`:
1. Calls `/api/v1/admin/analytics?days=30` on tab load using `shared/api.js`.
2. Renders high-level summary cards (MRR, Gross Margin %, Cost/1k, TTFC).
3. Renders the interactive visual conversion funnel bars.
4. Renders the 30-day unit economics table and latency breakdown.

---

## 7. Acceptance Criteria & Test Matrix

- **TC-01-A**: Ingestion of a render updates `ROLLUP#YYYY-MM-DD` in $<10\text{ms}$ with zero errors.
- **TC-01-B**: Requesting 30 days of analytics executes a single `BatchGetItem` for 30 keys and returns in $<50\text{ms}$.
- **TC-01-C**: Computed P95 latency accurately reflects the histogram bucket distribution.
- **TC-01-D**: Unit economics accurately reflect recorded duration and S3 byte totals.

---

## 8. Implementation Tasks

- [x] [Task 1.1: DynamoDB Daily Rollup Ingestion Engine](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/analytics/tasks/01-rollup-ingestion.md)
- [x] [Task 1.2: Analytics Read API & Financial Metrics Engine](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/analytics/tasks/02-analytics-api.md)
- [x] [Task 1.3: Analytics & Unit Economics Frontend Tab](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/analytics/tasks/03-analytics-ui.md)
