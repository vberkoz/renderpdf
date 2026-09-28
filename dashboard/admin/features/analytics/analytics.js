/**
 * Analytics & Unit Economics Module (Route: /admin/analytics)
 * Renders high-level summary cards, growth funnel, latency distribution,
 * and unit economics table using native DynamoDB rollup data.
 */

import { adminFetch } from '../../shared/api.js';

/**
 * Escapes HTML characters to prevent XSS.
 * @param {string|number} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Formats a currency amount into standard USD notation.
 * @param {number} amount
 * @returns {string}
 */
function formatUsd(amount) {
  const num = Number(amount) || 0;
  return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Formats an integer count with comma separators.
 * @param {number} count
 * @returns {string}
 */
function formatCount(count) {
  const num = Number(count) || 0;
  return num.toLocaleString('en-US');
}

/**
 * Renders the loading skeleton view.
 * @param {HTMLElement} container
 */
function renderLoadingSkeleton(container) {
  container.innerHTML = `
    <div class="admin-view-header">
      <div class="admin-view-title-group">
        <h2>Analytics &amp; Unit Economics</h2>
        <p class="admin-subtitle">Pre-aggregated daily rollups, conversion funnel velocity, and infrastructure economics.</p>
      </div>
      <div class="admin-view-controls">
        <div class="skeleton-box" style="width: 180px; height: 32px; border-radius: var(--admin-radius-pill);"></div>
        <div class="skeleton-box" style="width: 80px; height: 32px;"></div>
      </div>
    </div>

    <!-- Summary Metrics Skeleton -->
    <div class="admin-metrics-grid">
      <div class="skeleton-box skeleton-card"></div>
      <div class="skeleton-box skeleton-card"></div>
      <div class="skeleton-box skeleton-card"></div>
      <div class="skeleton-box skeleton-card"></div>
    </div>

    <!-- Funnel and Latency Skeleton -->
    <div class="admin-charts-grid">
      <div class="skeleton-box skeleton-chart"></div>
      <div class="skeleton-box skeleton-chart"></div>
    </div>

    <!-- Table Skeleton -->
    <div class="admin-card" style="padding: 24px;">
      <div class="skeleton-box" style="width: 260px; height: 24px; margin-bottom: 20px;"></div>
      <div class="skeleton-box skeleton-table-row"></div>
      <div class="skeleton-box skeleton-table-row"></div>
      <div class="skeleton-box skeleton-table-row"></div>
      <div class="skeleton-box skeleton-table-row"></div>
      <div class="skeleton-box skeleton-table-row"></div>
    </div>
  `;
}

/**
 * Renders the error banner with a retry trigger.
 * @param {HTMLElement} container
 * @param {Error} error
 * @param {Function} onRetry
 */
function renderErrorBanner(container, error, onRetry) {
  container.innerHTML = `
    <div class="admin-view-header">
      <div class="admin-view-title-group">
        <h2>Analytics &amp; Unit Economics</h2>
        <p class="admin-subtitle">Pre-aggregated daily rollups, conversion funnel velocity, and infrastructure economics.</p>
      </div>
    </div>

    <div class="admin-error-banner" role="alert">
      <div class="admin-error-details">
        <span class="admin-error-icon" aria-hidden="true">⚠️</span>
        <div>
          <h3 class="admin-error-title">Failed to load analytics</h3>
          <p class="admin-error-message">${escapeHtml(error?.message || 'Unable to retrieve analytics rollup data.')}</p>
        </div>
      </div>
      <button id="admin-analytics-retry-btn" class="admin-btn admin-btn-retry" type="button">Retry</button>
    </div>
  `;

  const retryBtn = container.querySelector('#admin-analytics-retry-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', onRetry);
  }
}

/**
 * Computes step-to-step and total conversion rates for the visual funnel.
 * @param {Object} funnelData
 * @param {Object} summaryData
 * @returns {Array<Object>}
 */
function buildFunnelSteps(funnelData = {}, summaryData = {}) {
  const visitors = Number(funnelData.pageViews) || 0;
  const playground = Number(funnelData.playgroundSubmits) || 0;
  const signups = Number(funnelData.signupsCompleted) || 0;
  const keys = Number(funnelData.apiKeysCreated) || 0;
  const firstCalls = Number(funnelData.firstApiCalls) || 0;
  const paid = Number(summaryData.activeSubscriptions) || 0;

  const steps = [
    {
      num: 1,
      name: 'Visitors',
      count: visitors,
      stepRate: 100,
      prevCount: visitors,
      desc: 'Landing page sessions'
    },
    {
      num: 2,
      name: 'Playground Renders',
      count: playground,
      stepRate: visitors > 0 ? (playground / visitors) * 100 : 0,
      prevCount: visitors,
      desc: 'Interactive demo executions'
    },
    {
      num: 3,
      name: 'Signups',
      count: signups,
      stepRate: playground > 0 ? (signups / playground) * 100 : 0,
      prevCount: playground,
      desc: 'Cognito accounts registered'
    },
    {
      num: 4,
      name: 'API Key Created',
      count: keys,
      stepRate: signups > 0 ? (keys / signups) * 100 : 0,
      prevCount: signups,
      desc: 'Developer credentials issued'
    },
    {
      num: 5,
      name: 'First API Call',
      count: firstCalls,
      stepRate: keys > 0 ? (firstCalls / keys) * 100 : 0,
      prevCount: keys,
      desc: 'Live PDF generation initiated'
    },
    {
      num: 6,
      name: 'Paid Upgrade',
      count: paid,
      stepRate: firstCalls > 0 ? (paid / firstCalls) * 100 : (signups > 0 ? (paid / signups) * 100 : 0),
      prevCount: firstCalls,
      desc: 'Active paying subscriptions'
    }
  ];

  const maxVal = Math.max(...steps.map(s => s.count), 1);
  return steps.map(step => ({
    ...step,
    barWidth: Math.max(2, (step.count / maxVal) * 100),
    overallRate: visitors > 0 ? (step.count / visitors) * 100 : 0
  }));
}

/**
 * Computes histogram distribution statistics.
 * @param {Object} rendering
 * @returns {Object}
 */
function buildLatencyDistribution(rendering = {}) {
  const buckets = rendering.latencyHistogram || {};
  const under400 = Number(buckets.under_400ms) || 0;
  const to800 = Number(buckets['400ms_to_800ms']) || 0;
  const to1500 = Number(buckets['800ms_to_1500ms']) || 0;
  const over1500 = Number(buckets.over_1500ms) || 0;

  const total = (under400 + to800 + to1500 + over1500) || Number(rendering.totalRenders) || 0;

  const calcPct = (cnt) => total > 0 ? ((cnt / total) * 100) : 0;

  return {
    total,
    buckets: [
      {
        id: 'under_400',
        label: '< 400 ms',
        desc: 'Lightning / Cached',
        count: under400,
        pct: calcPct(under400),
        dotClass: 'dot-under-400',
        segClass: 'seg-under-400'
      },
      {
        id: '400_800',
        label: '400 – 800 ms',
        desc: 'Optimal render',
        count: to800,
        pct: calcPct(to800),
        dotClass: 'dot-400-800',
        segClass: 'seg-400-800'
      },
      {
        id: '800_1500',
        label: '800 – 1500 ms',
        desc: 'Moderate payload',
        count: to1500,
        pct: calcPct(to1500),
        dotClass: 'dot-800-1500',
        segClass: 'seg-800-1500'
      },
      {
        id: 'over_1500',
        label: '> 1500 ms',
        desc: 'Heavy / Complex',
        count: over1500,
        pct: calcPct(over1500),
        dotClass: 'dot-over-1500',
        segClass: 'seg-over-1500'
      }
    ]
  };
}

/**
 * Returns CSS badge class based on gross margin percentage.
 * @param {number} margin
 * @returns {string}
 */
function getMarginBadgeClass(margin) {
  if (margin >= 80) return 'badge-success';
  if (margin >= 50) return 'badge-neutral';
  if (margin >= 0) return 'badge-warning';
  return 'badge-danger';
}

/**
 * Renders the complete populated Analytics view.
 * @param {HTMLElement} container
 * @param {Object} data
 * @param {number} currentDays
 * @param {Function} onRangeChange
 * @param {Function} onRefresh
 */
function renderAnalyticsView(container, data, currentDays, onRangeChange, onRefresh) {
  const summary = data?.summary || {};
  const funnel = data?.funnel || {};
  const rendering = data?.rendering || {};
  const dailyRollups = Array.isArray(data?.dailyRollups) ? data.dailyRollups : [];

  const mrr = Number(summary.mrrUsd) || 0;
  const margin = Number(summary.grossMarginPercent) || 0;
  const costPer1k = Number(summary.costPerThousandPdfsUsd) || 0;
  const activeSubs = Number(summary.activeSubscriptions) || 0;

  const funnelSteps = buildFunnelSteps(funnel, summary);
  const latency = buildLatencyDistribution(rendering);
  const ttfcMinutes = funnel.ttfcMedianMinutes != null ? `${funnel.ttfcMedianMinutes}m` : 'N/A';

  // Sort daily rollups descending by date (newest first)
  const sortedRollups = [...dailyRollups].sort((a, b) => String(b.date).localeCompare(String(a.date)));

  container.innerHTML = `
    <!-- Header & Controls -->
    <div class="admin-view-header">
      <div class="admin-view-title-group">
        <h2>Analytics &amp; Unit Economics</h2>
        <p class="admin-subtitle">Pre-aggregated daily rollups, conversion funnel velocity, and infrastructure economics.</p>
      </div>
      <div class="admin-view-controls">
        <div class="admin-pill-group" role="group" aria-label="Time window selector">
          <button class="admin-pill-btn ${currentDays === 7 ? 'active' : ''}" data-days="7" type="button" aria-pressed="${currentDays === 7}">7d</button>
          <button class="admin-pill-btn ${currentDays === 14 ? 'active' : ''}" data-days="14" type="button" aria-pressed="${currentDays === 14}">14d</button>
          <button class="admin-pill-btn ${currentDays === 30 ? 'active' : ''}" data-days="30" type="button" aria-pressed="${currentDays === 30}">30d</button>
          <button class="admin-pill-btn ${currentDays === 90 ? 'active' : ''}" data-days="90" type="button" aria-pressed="${currentDays === 90}">90d</button>
        </div>
        <button id="admin-analytics-refresh-btn" class="admin-btn admin-btn-secondary" type="button" aria-label="Refresh analytics data">
          <span>↻</span> Refresh
        </button>
        <span class="admin-timestamp">Updated: <time>${escapeHtml(new Date().toLocaleTimeString())}</time></span>
      </div>
    </div>

    <!-- Summary Bar (4 High-Level Metric Cards) -->
    <div class="admin-metrics-grid" aria-label="High-level metrics">
      <!-- 1. MRR -->
      <article class="admin-card" data-metric="mrr">
        <div class="admin-metric-header">
          <span class="admin-metric-category">Monetization</span>
        </div>
        <h3 class="admin-metric-title">Monthly Recurring Revenue (MRR)</h3>
        <p class="admin-metric-value">${escapeHtml(formatUsd(mrr))}</p>
        <p class="admin-metric-subtext">Active subscription run-rate</p>
      </article>

      <!-- 2. Gross Margin -->
      <article class="admin-card" data-metric="margin">
        <div class="admin-metric-header">
          <span class="admin-metric-category">Profitability</span>
          <span class="admin-metric-badge ${getMarginBadgeClass(margin)}">${margin >= 0 ? '+' : ''}${escapeHtml(margin.toFixed(1))}%</span>
        </div>
        <h3 class="admin-metric-title">Real-Time Gross Margin</h3>
        <p class="admin-metric-value">${escapeHtml(margin.toFixed(1))}%</p>
        <p class="admin-metric-subtext">Net after AWS Lambda &amp; S3 costs</p>
      </article>

      <!-- 3. AWS Cost / 1,000 PDFs -->
      <article class="admin-card" data-metric="cost-per-1k">
        <div class="admin-metric-header">
          <span class="admin-metric-category">Unit Economics</span>
        </div>
        <h3 class="admin-metric-title">AWS Cost per 1,000 PDFs</h3>
        <p class="admin-metric-value">${escapeHtml(formatUsd(costPer1k))}</p>
        <p class="admin-metric-subtext">Compute &amp; storage infra efficiency</p>
      </article>

      <!-- 4. Active Subscriptions -->
      <article class="admin-card" data-metric="subscriptions">
        <div class="admin-metric-header">
          <span class="admin-metric-category">Customers</span>
        </div>
        <h3 class="admin-metric-title">Active Subscriptions</h3>
        <p class="admin-metric-value">${escapeHtml(formatCount(activeSubs))}</p>
        <p class="admin-metric-subtext">Total paying accounts</p>
      </article>
    </div>

    <!-- Charts Grid: Growth Funnel Visualizer + Latency Histogram -->
    <div class="admin-charts-grid">
      <!-- Growth Funnel Visualizer -->
      <section class="admin-section-card" aria-labelledby="funnel-heading">
        <div class="admin-section-card-header">
          <div>
            <h3 id="funnel-heading">Growth &amp; Activation Funnel</h3>
            <p>End-to-end conversion: visitor to paying customer</p>
          </div>
        </div>

        <div class="admin-funnel-list" aria-label="Funnel conversion steps">
          ${funnelSteps.map(step => `
            <div class="admin-funnel-step" data-step="${step.num}">
              <div class="admin-funnel-step-header">
                <span class="admin-funnel-step-name">
                  <span class="admin-funnel-step-num">${step.num}</span>
                  ${escapeHtml(step.name)}
                </span>
                <div class="admin-funnel-step-counts">
                  <span class="admin-funnel-step-val">${escapeHtml(formatCount(step.count))}</span>
                  ${step.num > 1 ? `<span class="admin-funnel-step-rate" title="Step-over-step conversion">${escapeHtml(step.stepRate.toFixed(1))}% conv.</span>` : ''}
                </div>
              </div>
              <div class="admin-funnel-bar-track">
                <div class="admin-funnel-bar-fill" style="width: ${step.barWidth.toFixed(1)}%;"></div>
              </div>
            </div>
          `).join('')}
        </div>

        <!-- Onboarding Velocity (TTFC) Card Footer -->
        <div class="admin-funnel-footer">
          <div class="admin-ttfc-box">
            <div class="admin-ttfc-badge">${escapeHtml(ttfcMinutes)}</div>
            <div>
              <strong style="font-size: 13px; color: var(--admin-text); display: block;">Developer Time to First Call (TTFC)</strong>
              <span class="admin-ttfc-desc">Median time from signup to first successful PDF render</span>
            </div>
          </div>
        </div>
      </section>

      <!-- Latency Histogram -->
      <section class="admin-section-card" aria-labelledby="latency-heading">
        <div class="admin-section-card-header">
          <div>
            <h3 id="latency-heading">Render Latency Distribution</h3>
            <p>P95 response time and execution speed across all renders</p>
          </div>
        </div>

        <!-- KPIs row -->
        <div class="admin-latency-kpis">
          <div class="admin-latency-kpi-item">
            <div class="admin-latency-kpi-label">P95 Latency</div>
            <div class="admin-latency-kpi-value">${escapeHtml(rendering.p95RenderMs || 0)} ms</div>
          </div>
          <div class="admin-latency-kpi-item">
            <div class="admin-latency-kpi-label">Avg Render</div>
            <div class="admin-latency-kpi-value">${escapeHtml(rendering.averageRenderMs || 0)} ms</div>
          </div>
          <div class="admin-latency-kpi-item">
            <div class="admin-latency-kpi-label">Success Rate</div>
            <div class="admin-latency-kpi-value">${escapeHtml(rendering.successRate != null ? rendering.successRate : 100)}%</div>
          </div>
          <div class="admin-latency-kpi-item">
            <div class="admin-latency-kpi-label">Total Renders</div>
            <div class="admin-latency-kpi-value">${escapeHtml(formatCount(rendering.totalRenders || 0))}</div>
          </div>
        </div>

        <!-- Segmented Distribution Bar -->
        <div class="admin-latency-stacked-bar" title="Latency distribution segments" role="progressbar" aria-valuenow="100" aria-valuemin="0" aria-valuemax="100">
          ${latency.buckets.map(b => `
            <div class="admin-latency-seg ${b.segClass}" style="width: ${b.pct.toFixed(2)}%;" title="${escapeHtml(b.label)}: ${b.pct.toFixed(1)}%"></div>
          `).join('')}
        </div>

        <!-- Bucket breakdown list -->
        <div class="admin-latency-buckets-list">
          ${latency.buckets.map(b => `
            <div class="admin-latency-bucket-row" data-bucket="${b.id}">
              <div class="admin-latency-bucket-info">
                <span class="admin-latency-bucket-label">
                  <span class="admin-bucket-dot ${b.dotClass}"></span>
                  ${escapeHtml(b.label)}
                  <span style="font-size: 11px; color: var(--admin-dim); font-weight: normal;">(${escapeHtml(b.desc)})</span>
                </span>
                <div class="admin-latency-bucket-counts">
                  <span class="admin-latency-bucket-val">${escapeHtml(formatCount(b.count))}</span>
                  <span class="admin-latency-bucket-pct">${escapeHtml(b.pct.toFixed(1))}%</span>
                </div>
              </div>
              <div class="admin-latency-bucket-track">
                <div class="admin-latency-bucket-fill ${b.segClass}" style="width: ${b.pct.toFixed(1)}%;"></div>
              </div>
            </div>
          `).join('')}
        </div>
      </section>
    </div>

    <!-- Unit Economics & Daily Trends Table -->
    <section class="admin-section-card" aria-labelledby="trends-heading" style="margin-bottom: 24px;">
      <div class="admin-section-card-header">
        <div>
          <h3 id="trends-heading">Unit Economics &amp; Daily Trends</h3>
          <p>Rolling ${currentDays}-day financial performance and render volume per daily rollup.</p>
        </div>
      </div>

      <div class="admin-table-container">
        <table class="admin-table" aria-label="Daily unit economics and trends">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col" class="admin-col-num">Renders</th>
              <th scope="col" class="admin-col-num">Errors</th>
              <th scope="col" class="admin-col-num">Revenue ($)</th>
              <th scope="col" class="admin-col-num">AWS Cost ($)</th>
              <th scope="col" class="admin-col-num">Gross Margin</th>
              <th scope="col" class="admin-col-num">P95 (ms)</th>
            </tr>
          </thead>
          <tbody>
            ${sortedRollups.length === 0 ? `
              <tr>
                <td colspan="7" class="admin-empty-state">No daily rollup records found for the selected period.</td>
              </tr>
            ` : sortedRollups.map(row => {
              const rowMargin = Number(row.marginPercent) || 0;
              const errors = Number(row.errors) || 0;
              return `
                <tr>
                  <td class="admin-col-date">${escapeHtml(row.date)}</td>
                  <td class="admin-col-num">${escapeHtml(formatCount(row.renders))}</td>
                  <td class="admin-col-num">
                    ${errors > 0 ? `<span class="admin-badge-error">${escapeHtml(errors)}</span>` : '<span class="admin-dim">0</span>'}
                  </td>
                  <td class="admin-col-num">${escapeHtml(formatUsd(row.revenueUsd))}</td>
                  <td class="admin-col-num">${escapeHtml(formatUsd(row.estimatedAwsCostUsd))}</td>
                  <td class="admin-col-num">
                    <span class="admin-metric-badge ${getMarginBadgeClass(rowMargin)}">
                      ${rowMargin >= 0 ? '+' : ''}${escapeHtml(rowMargin.toFixed(1))}%
                    </span>
                  </td>
                  <td class="admin-col-num">${escapeHtml(row.p95Ms || 0)} ms</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;

  // Attach controls event handlers
  const pillBtns = container.querySelectorAll('.admin-pill-btn');
  pillBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const days = Number(btn.getAttribute('data-days')) || 30;
      if (days !== currentDays) {
        onRangeChange(days);
      }
    });
  });

  const refreshBtn = container.querySelector('#admin-analytics-refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', onRefresh);
  }
}

/**
 * Initializes the Analytics & Unit Economics tab module.
 * @param {HTMLElement} containerElement - The target container element.
 * @param {number} [initialDays=30] - Initial rolling window in days.
 */
export async function initAnalyticsTab(containerElement, initialDays = 30) {
  if (!containerElement) return;

  let currentDays = initialDays;

  async function loadData() {
    renderLoadingSkeleton(containerElement);
    try {
      const data = await adminFetch(`/analytics?days=${currentDays}`);
      renderAnalyticsView(
        containerElement,
        data,
        currentDays,
        (newDays) => {
          currentDays = newDays;
          loadData();
        },
        () => loadData()
      );
    } catch (err) {
      renderErrorBanner(containerElement, err, () => loadData());
    }
  }

  await loadData();
}
