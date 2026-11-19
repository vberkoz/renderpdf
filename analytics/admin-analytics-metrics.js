'use strict';

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;

function roundOneDecimal(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}

function roundFloat(value) {
  return Math.floor(value * 100 + 0.5) / 100;
}

function calculateAwsCost(totalRenders = 0, totalDurationMs = 0, totalBytes = 0) {
  const lambdaCost =
    (totalDurationMs / 1000) * (2048 / 1024) * 0.0000166667 + (totalRenders * 0.2) / 1000000;
  const s3Cost = (totalRenders * 0.005) / 1000 + (totalBytes / 1e9) * 0.023;
  return lambdaCost + s3Cost;
}

function calculateGrossMargin(attributedRevenue, awsCost) {
  if (!attributedRevenue || attributedRevenue <= 0) return 0;
  return ((attributedRevenue - awsCost) / attributedRevenue) * 100;
}

function calculateP95(latencyBuckets) {
  if (!latencyBuckets) return 0;
  const buckets = [
    { key: 'under_400ms', min: 100, max: 400, midpoint: 250 },
    { key: '400ms_to_800ms', min: 400, max: 800, midpoint: 600 },
    { key: '800ms_to_1500ms', min: 800, max: 1500, midpoint: 1150 },
    { key: 'over_1500ms', min: 1500, max: 2900, midpoint: 2200 },
  ];

  let total = 0;
  for (const b of buckets) {
    total += Number(latencyBuckets[b.key] || 0);
  }
  if (total === 0) return 0;

  const target = 0.95 * total;
  let cumulative = 0;

  for (const b of buckets) {
    const count = Number(latencyBuckets[b.key] || 0);
    if (count <= 0) continue;
    if (cumulative + count >= target) {
      const rankInBucket = target - cumulative;
      const fraction = rankInBucket / count;
      return Math.round(b.min + fraction * (b.max - b.min));
    }
    cumulative += count;
  }

  return buckets[buckets.length - 1].midpoint;
}

function calculateMedianTtfc(ttfcBuckets) {
  if (!ttfcBuckets) return 0;
  const buckets = [
    { key: 'under_5m', min: 0, max: 5 },
    { key: '5m_to_30m', min: 5, max: 30 },
    { key: '30m_to_2h', min: 30, max: 120 },
    { key: 'over_2h', min: 120, max: 360 },
  ];

  let total = 0;
  for (const b of buckets) {
    total += Number(ttfcBuckets[b.key] || 0);
  }
  if (total === 0) return 0;

  const target = 0.5 * total;
  let cumulative = 0;

  for (const b of buckets) {
    const count = Number(ttfcBuckets[b.key] || 0);
    if (count <= 0) continue;
    if (cumulative + count >= target) {
      const rank = target - cumulative;
      const fraction = rank / count;
      return roundOneDecimal(b.min + fraction * (b.max - b.min));
    }
    cumulative += count;
  }

  return 0;
}

function parseDays(value, fallback = DEFAULT_DAYS) {
  const days = Number.parseInt(value, 10);
  if (!Number.isFinite(days) || days < 1) return fallback;
  return Math.min(days, MAX_DAYS);
}

function topRanks(values, limit) {
  return [...values.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function latencyBucket(durationMs) {
  if (durationMs < 400) return 'under_400ms';
  if (durationMs < 800) return '400ms_to_800ms';
  if (durationMs < 1500) return '800ms_to_1500ms';
  return 'over_1500ms';
}

module.exports = {
  roundOneDecimal,
  roundFloat,
  calculateAwsCost,
  calculateGrossMargin,
  calculateP95,
  calculateMedianTtfc,
  parseDays,
  topRanks,
  dateKey,
  latencyBucket,
  DEFAULT_DAYS,
  MAX_DAYS,
};
