# Task 1.1: DynamoDB Daily Rollup Ingestion Engine

| Field | Value |
| :--- | :--- |
| **Task ID** | TASK-ANALYTICS-01 |
| **Feature** | [`features/analytics/`](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/analytics/spec.md) |
| **Status** | Completed |
| **Target Files** | `analytics/index.js`, `analytics/index.test.js` |
| **Prerequisites** | None |

---

## 1. Objective

Implement atomic, zero-overhead ingestion updates to the daily rollup partition (`ROLLUP#YYYY-MM-DD`) on every completed render and analytics event. This builds the foundational data layer that eliminates the need for expensive multi-partition scans.

---

## 2. Technical Requirements

### 2.1 Latency Histogram Classifier
Create a helper function to bucket render durations:
```javascript
function latencyBucket(durationMs) {
  if (durationMs < 400) return 'under_400ms';
  if (durationMs < 800) return '400ms_to_800ms';
  if (durationMs < 1500) return '800ms_to_1500ms';
  return 'over_1500ms';
}
```

### 2.2 Atomic Render Rollup Update
In `analytics/index.js`, add `recordRenderRollup(status, durationMs, pdfBytes, plan, date)`:
- Target Item Key: `requestId = "ROLLUP#<YYYY-MM-DD>"`, `timestamp = 0`.
- Update Expression:
  ```javascript
  const updateInput = {
    TableName: TABLE_NAME,
    Key: { requestId: { S: `ROLLUP#${dateKey}` }, timestamp: { N: '0' } },
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
      '#rendSuccess': status === 'success' ? 'rendering.successes' : 'dummy_success',
      '#rendError': status !== 'success' ? 'rendering.errors' : 'dummy_error',
      '#plan': plan || 'unknown',
      '#latBucket': latencyBucket(durationMs)
    },
    ExpressionAttributeValues: {
      ':one': { N: '1' },
      ':size': { N: String(pdfBytes || 0) },
      ':duration': { N: String(durationMs || 0) },
      ':succIncr': { N: status === 'success' ? '1' : '0' },
      ':errIncr': { N: status !== 'success' ? '1' : '0' }
    }
  };
  ```

### 2.3 Client-Side Event Rollup
In `saveAnalytics(request)`:
- Increment corresponding acquisition/activation counters on `ROLLUP#YYYY-MM-DD` when known event names arrive:
  - `page_viewed` $\to$ `acquisition.pageViews`
  - `trial_render_submitted` $\to$ `acquisition.playgroundSubmits`
  - `trial_render_succeeded` $\to$ `acquisition.playgroundSuccesses`
  - `signup_started` $\to$ `activation.signupStarted`
  - `signup_completed` $\to$ `activation.signupCompleted`
  - `api_key_created` $\to$ `activation.apiKeysCreated`

---

## 3. Verification & Acceptance Criteria

1. **Unit Test**: Create tests in `analytics/index.test.js`:
   - Mock DynamoDB `UpdateItemCommand`.
   - Verify that calling `recordRenderRollup('success', 350, 50000, 'pro')` sends the expected atomic `ADD` parameters and targets `under_400ms`.
   - Verify that error outcomes increment `rendering.errors`.
2. **Command**:
   ```bash
   npm test --prefix analytics/
   ```
   Must pass with 100% success.
