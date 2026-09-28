# Task 1.2: Analytics Read API & Financial Metrics Engine

| Field | Value |
| :--- | :--- |
| **Task ID** | TASK-ANALYTICS-02 |
| **Feature** | [`features/analytics/`](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/analytics/spec.md) |
| **Status** | Completed |
| **Target Files** | `analytics/index.js`, `analytics/index.test.js` |
| **Prerequisites** | Task 1.1 (`01-rollup-ingestion.md`) |

---

## 1. Objective

Implement the `GET /api/v1/admin/analytics?days={days}` backend endpoint in `analytics/index.js`. 

This replaces the previous 100,000+ item scan with a single `BatchGetItem` call across rolling daily rollup keys, computing live conversion funnels, Time to First Call (TTFC), latency distributions (P95), and gross margins against AWS infrastructure costs in $<20\text{ms}$.

---

## 2. Technical Requirements

### 2.1 Route Handler & RBAC Guard
- Route: `GET /api/v1/admin/analytics`
- Authorization: Inspect `event.requestContext.authorizer.claims`:
  - Allow if `claims['cognito:groups'].includes('Admins')` OR `claims.email === STATS_ALLOWED_EMAIL`.
  - Otherwise return HTTP `403 Forbidden`.

### 2.2 Sub-Second Batch Retrieval
Generate keys for the requested window (`days` up to 90, default 30):
```javascript
const keys = [];
for (let i = 0; i < days; i++) {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - i);
  keys.push({ requestId: { S: `ROLLUP#${dateKey(d)}` }, timestamp: { N: '0' } });
}

// Fetch all rolling days in one BatchGetItem command
const batchRes = await ddb.send(new BatchGetItemCommand({
  RequestItems: { [TABLE_NAME]: { Keys: keys } }
}));
```

### 2.3 Interpolation & Financial Math Helpers
1. **P95 Latency Interpolation**:
   Calculate percentile from the combined histogram bucket counts:
   - Buckets: `under_400ms` (midpoint 250ms), `400ms_to_800ms` (midpoint 600ms), `800ms_to_1500ms` (midpoint 1150ms), `over_1500ms` (midpoint 2200ms).
2. **Infrastructure Cost Formulas**:
   - Lambda Cost: `(totalDurationMs / 1000) * (2048 / 1024) * 0.0000166667 + (totalRenders * 0.20 / 1000000)`.
   - S3 Cost: `(totalRenders * 0.005 / 1000) + ((totalBytes / 1e9) * 0.023)`.
   - Gross Margin %: `((attributedRevenue - awsCost) / attributedRevenue) * 100`.

---

## 3. Verification & Acceptance Criteria

1. **Unit Test**: In `analytics/index.test.js`:
   - Non-admin callers receive `403 Forbidden`.
   - Admin callers receive `200 OK` with properly parsed funnels, unit economics, and daily trend arrays.
   - P95 latency correctly reflects the skewed duration buckets.
2. **Command**:
   ```bash
   npm test --prefix analytics/
   ```
