#!/usr/bin/env node
'use strict';

// Phase 0 (P0 Pre-Flight Telemetry Audit) — strictly read-only 30-day usage audit.
// Uses only Node.js built-in modules and read-only AWS CLI commands via execFileSync.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CSV_HEADERS = [
  'metric_id',
  'linked_features',
  'source_system',
  'target',
  'window_days',
  'total_count',
  'unique_owners',
  'error_count',
  'visibility',
  'recommended_gate',
  'notes',
];

const ALLOWED_AWS_COMMANDS = new Set([
  'cloudformation:describe-stacks',
  'cloudformation:describe-stack-resources',
  'apigateway:get-stage',
  'cloudwatch:get-metric-data',
  'logs:start-query',
  'logs:get-query-results',
  'dynamodb:query',
  'dynamodb:scan',
  's3api:get-object',
  'cloudfront:get-distribution-config',
]);

const API_GW_TARGETS = [
  {
    metricId: 'f17_apigw_chat',
    linkedFeatures: 'F17',
    target: 'POST /api/v1/chat',
    routes: [{ resource: '/api/v1/chat', method: 'POST' }],
  },
  {
    metricId: 'f5_apigw_uploads_legacy',
    linkedFeatures: 'F5',
    target: 'POST /api/v1/uploads',
    routes: [{ resource: '/api/v1/uploads', method: 'POST' }],
  },
  {
    metricId: 'f5_apigw_files_upload',
    linkedFeatures: 'F5',
    target: 'POST /api/v1/files/upload',
    routes: [{ resource: '/api/v1/files/upload', method: 'POST' }],
  },
  {
    metricId: 'f7_apigw_pdf_merge_legacy',
    linkedFeatures: 'F5,F7',
    target: 'POST /api/v1/pdf/merge',
    routes: [{ resource: '/api/v1/pdf/merge', method: 'POST' }],
  },
  {
    metricId: 'f7_apigw_merge',
    linkedFeatures: 'F5,F7',
    target: 'POST /api/v1/merge',
    routes: [{ resource: '/api/v1/merge', method: 'POST' }],
  },
  {
    metricId: 'f18_apigw_public_stats',
    linkedFeatures: 'F18',
    target: 'GET /api/v1/public-stats',
    routes: [{ resource: '/api/v1/public-stats', method: 'GET' }],
  },
  {
    metricId: 'f18_apigw_admin_all',
    linkedFeatures: 'F18',
    target: '/api/v1/admin/* (5 routes)',
    routes: [
      { resource: '/api/v1/admin/analytics', method: 'GET' },
      { resource: '/api/v1/admin/users', method: 'GET' },
      { resource: '/api/v1/admin/users/{userId}', method: 'GET' },
      { resource: '/api/v1/admin/users/{userId}/plan', method: 'POST' },
      { resource: '/api/v1/admin/users/{userId}/quota', method: 'POST' },
    ],
  },
];

const FRONTEND_TARGETS = [
  { metricId: 'f18_page_waitlist', target: '/waitlist/', regex: /^\/waitlist(?:\/|$)/i },
  { metricId: 'f18_page_app_debug', target: '/app/debug', regex: /^\/app\/debug(?:\/|\.html|$)/i },
  { metricId: 'f18_page_app_stats', target: '/app/stats', regex: /^\/app\/stats(?:\/|\.html|$)/i },
  { metricId: 'f18_page_stats', target: '/stats/', regex: /^\/stats(?:\/|$)/i },
];

const USAGE_SOURCE_TYPE_TARGETS = [
  { sourceType: 'template', linkedFeatures: 'F3', gateMode: 'legacy_candidate' },
  { sourceType: 'stored', linkedFeatures: 'F4', gateMode: 'info' },
  { sourceType: 'html', linkedFeatures: 'F3,F4', gateMode: 'info' },
  { sourceType: 'markdown', linkedFeatures: 'F3,F4', gateMode: 'info' },
  { sourceType: 'url', linkedFeatures: 'F3,F4', gateMode: 'info' },
  { sourceType: 'upload', linkedFeatures: 'F3,F4', gateMode: 'info' },
];

const CANONICAL_FILE_KINDS = [
  'rendered_pdf',
  'merged_pdf',
  'uploaded_package',
  'batch_zip',
  'batch_merged_pdf',
];

const COMPLIANCE_LOG_QUERIES = [
  {
    key: 'compliance',
    metricId: 'f12_options_compliance',
    linkedFeatures: 'F12',
    target: 'options.compliance',
    query: 'fields @message | filter @message like /(?i)(compliance|document_compliance_)/ | stats count() as matchCount',
  },
  {
    key: 'signing',
    metricId: 'f13_options_signing',
    linkedFeatures: 'F13',
    target: 'options.signing',
    query: 'fields @message | filter @message like /(?i)(pdf signing|kms sign|sign pdf|document_signing_)/ | stats count() as matchCount',
  },
  {
    key: 'redaction',
    metricId: 'f14_options_redaction',
    linkedFeatures: 'F14',
    target: 'options.redaction',
    query: 'fields @message | filter @message like /(?i)(redaction|document_redaction_)/ | stats count() as matchCount',
  },
];

function parsePositiveInt(value, flagName) {
  if (!/^\d+$/.test(String(value))) {
    throw new Error(`${flagName} must be a positive integer, got: ${value}`);
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer, got: ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const config = {
    days: 30,
    stack: null,
    appName: 'renderpdf',
    region: 'us-east-1',
    stage: 'prod',
    out: 'preflight-30d-baseline.csv',
    maxPages: 100,
    maxS3Sources: 200,
    queryTimeoutSec: 30,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (raw === '--help' || raw === '-h') {
      config.help = true;
      continue;
    }
    if (raw === '--dry-run') {
      config.dryRun = true;
      continue;
    }

    let flag = raw;
    let value;
    const eqIdx = raw.indexOf('=');
    if (raw.startsWith('--') && eqIdx !== -1) {
      flag = raw.slice(0, eqIdx);
      value = raw.slice(eqIdx + 1);
    } else if (raw.startsWith('--')) {
      if (i + 1 >= argv.length) {
        throw new Error(`Missing value for flag ${flag}`);
      }
      value = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`Unexpected positional argument: ${raw}`);
    }

    switch (flag) {
      case '--days':
        config.days = parsePositiveInt(value, '--days');
        break;
      case '--stack':
        if (!value) throw new Error('--stack must not be empty');
        config.stack = value;
        break;
      case '--app-name':
        if (!value) throw new Error('--app-name must not be empty');
        config.appName = value;
        break;
      case '--region':
        if (!value) throw new Error('--region must not be empty');
        config.region = value;
        break;
      case '--stage':
        if (!value) throw new Error('--stage must not be empty');
        config.stage = value;
        break;
      case '--out':
        if (!value) throw new Error('--out must not be empty');
        config.out = value;
        break;
      case '--max-pages':
        config.maxPages = parsePositiveInt(value, '--max-pages');
        break;
      case '--max-s3-sources':
        config.maxS3Sources = parsePositiveInt(value, '--max-s3-sources');
        break;
      case '--query-timeout-sec':
        config.queryTimeoutSec = parsePositiveInt(value, '--query-timeout-sec');
        break;
      case '--dry-run':
        if (value === 'true' || value === '1') config.dryRun = true;
        else if (value === 'false' || value === '0') config.dryRun = false;
        else throw new Error(`--dry-run does not accept value: ${value}`);
        break;
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }

  return config;
}

function classifyAwsError(message, code) {
  const text = `${message || ''} ${code || ''}`;
  const isAuthError =
    /Unable to locate credentials|ExpiredToken|UnrecognizedClientException|InvalidClientTokenId|AccessDenied|UnauthorizedOperation|Could not connect to the endpoint URL|CredentialsProviderError|NoCredentialProviders|InvalidSignatureException|RequestExpired|ENOENT|ETIMEDOUT|ENOTFOUND/i.test(
      text
    );
  const isNotFound =
    /ResourceNotFoundException|NotFoundException|NoSuchKey|NoSuchBucket|NoSuchDistribution|does not exist/i.test(
      text
    );
  return { isAuthError, isNotFound };
}

function assertAllowedAwsCommand(args) {
  if (!Array.isArray(args) || args.length < 2) {
    throw new Error(`Invalid AWS CLI arguments: ${JSON.stringify(args)}`);
  }
  const key = `${args[0]}:${args[1]}`;
  if (!ALLOWED_AWS_COMMANDS.has(key)) {
    throw new Error(`Blocked non-read-only or disallowed AWS CLI command: ${key}`);
  }
}

function createAwsRunner({ execFileSyncImpl = execFileSync } = {}) {
  return function runAws(args) {
    assertAllowedAwsCommand(args);
    try {
      const stdout = execFileSyncImpl('aws', args, {
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, stdout: stdout || '' };
    } catch (err) {
      const stderr = err && err.stderr ? String(err.stderr).trim() : '';
      const message = stderr || (err && err.message ? String(err.message) : 'Unknown AWS CLI error');
      const code = err && err.code !== undefined ? err.code : err && err.status;
      const { isAuthError, isNotFound } = classifyAwsError(message, code);
      return {
        ok: false,
        error: message,
        stderr,
        code,
        isAuthError,
        isNotFound,
      };
    }
  };
}

function runAwsJson(awsRunner, args) {
  const res = awsRunner(args);
  if (!res.ok) return res;
  if (!res.stdout || !res.stdout.trim()) {
    return { ok: true, data: {} };
  }
  try {
    return { ok: true, data: JSON.parse(res.stdout) };
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON from aws ${args[0]} ${args[1]}: ${err.message}`,
      stderr: res.stdout.slice(0, 300),
      isAuthError: false,
      isNotFound: false,
    };
  }
}

function unmarshalAttr(av) {
  if (av === null || av === undefined || typeof av !== 'object') return av;
  if ('S' in av) return av.S;
  if ('N' in av) {
    const raw = String(av.N);
    const num = Number(raw);
    if (Number.isFinite(num) && (raw.includes('.') || Number.isSafeInteger(num))) {
      return num;
    }
    return raw;
  }
  if ('BOOL' in av) return Boolean(av.BOOL);
  if ('NULL' in av) return null;
  if ('M' in av && av.M && typeof av.M === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(av.M)) {
      out[k] = unmarshalAttr(v);
    }
    return out;
  }
  if ('L' in av && Array.isArray(av.L)) {
    return av.L.map(unmarshalAttr);
  }
  if ('SS' in av && Array.isArray(av.SS)) return av.SS.slice();
  if ('NS' in av && Array.isArray(av.NS)) {
    return av.NS.map((n) => {
      const num = Number(n);
      return Number.isFinite(num) && (String(n).includes('.') || Number.isSafeInteger(num)) ? num : n;
    });
  }
  if ('BS' in av && Array.isArray(av.BS)) return av.BS.slice();
  if ('B' in av) return av.B;
  return av;
}

function unmarshalItem(item) {
  if (!item || typeof item !== 'object') return {};
  const out = {};
  for (const [key, val] of Object.entries(item)) {
    out[key] = unmarshalAttr(val);
  }
  return out;
}

function parseTimestampMs(val) {
  if (val === null || val === undefined || typeof val === 'boolean') return null;
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || val <= 0) return null;
    return val < 1e12 ? val * 1000 : val;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return null;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (!Number.isFinite(num) || num <= 0) return null;
      return num < 1e12 ? num * 1000 : num;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[,"\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatCsv(rows) {
  const lines = [CSV_HEADERS.join(',')];
  for (const row of rows) {
    const line = CSV_HEADERS.map((header) => escapeCsvCell(row[header])).join(',');
    lines.push(line);
  }
  return `${lines.join('\n')}\n`;
}

function getUtcDateStrings(days, now = new Date()) {
  const endDayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dates = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const d = new Date(endDayUtcMs - offset * 86400 * 1000);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function isOptionEnabled(val) {
  if (val === undefined || val === null || val === false) return false;
  if (typeof val === 'string') {
    const normalized = val.trim().toLowerCase();
    return normalized !== '' && normalized !== 'false' && normalized !== '0' && normalized !== 'off';
  }
  if (Array.isArray(val)) return val.length > 0;
  if (typeof val === 'object') {
    const keys = Object.keys(val);
    if (keys.length === 0) return false;
    if (val.enabled === false) return false;
    return true;
  }
  return Boolean(val);
}

function normalizeFrontendPath(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw.trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) {
    try {
      text = new URL(text).pathname;
    } catch {
      return '';
    }
  }
  const qIdx = text.indexOf('?');
  if (qIdx !== -1) text = text.slice(0, qIdx);
  const hIdx = text.indexOf('#');
  if (hIdx !== -1) text = text.slice(0, hIdx);
  if (!text.startsWith('/')) text = `/${text}`;
  if (text.endsWith('/index.html')) {
    text = text.slice(0, -'index.html'.length);
  }
  return text;
}

function extractEventPaths(item) {
  const candidates = [];
  const collectFromObj = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of ['path', 'page', 'pathname', 'url', 'route', 'href']) {
      if (typeof obj[key] === 'string' && obj[key].trim()) {
        candidates.push(obj[key]);
      }
    }
  };
  collectFromObj(item);
  if (item.metadata && typeof item.metadata === 'object') {
    collectFromObj(item.metadata);
  } else if (typeof item.metadata === 'string' && item.metadata.trim().startsWith('{')) {
    try {
      collectFromObj(JSON.parse(item.metadata));
    } catch {
      // Ignore unparseable metadata string.
    }
  }
  return candidates.map(normalizeFrontendPath).filter(Boolean);
}

function matchFrontendPath(item) {
  const paths = extractEventPaths(item);
  const matched = new Set();
  for (const normalized of paths) {
    for (const target of FRONTEND_TARGETS) {
      if (target.regex.test(normalized)) {
        matched.add(target.metricId);
      }
    }
  }
  return Array.from(matched);
}

function resolveResources(awsRunner, config) {
  const app = config.appName;
  const resources = {
    stackName: config.stack || app,
    stackResolved: false,
    stackAuthError: false,
    stackNote: '',
    usageTable: `${app}-usage`,
    templatesTable: `${app}-templates`,
    documentStoreTable: `${app}-documents-v2`,
    apiName: `${app}-api`,
    stage: config.stage,
    pdfLogGroup: `/aws/lambda/${app}-generate`,
    analyticsLogGroup: `/aws/lambda/${app}-analytics-node`,
    restApiId: null,
    cloudFrontDistributionId: null,
    pdfBucket: null,
  };

  let methodApiId = null;

  const stackArgs = [
    'cloudformation',
    'describe-stack-resources',
    '--stack-name',
    resources.stackName,
    '--region',
    config.region,
    '--output',
    'json',
  ];
  const resResources = runAwsJson(awsRunner, stackArgs);
  if (resResources.ok) {
    resources.stackResolved = true;
    const list = Array.isArray(resResources.data.StackResources) ? resResources.data.StackResources : [];
    for (const entry of list) {
      const logical = entry.LogicalResourceId;
      const physical = entry.PhysicalResourceId;
      if (!logical || !physical) continue;
      if (logical === 'RestApi') resources.restApiId = physical;
      else if (logical === 'CloudFrontDistribution') resources.cloudFrontDistributionId = physical;
      else if (logical === 'PdfBucket') resources.pdfBucket = physical;
      else if (logical === 'UsageTable') resources.usageTable = physical;
      else if (logical === 'TemplatesTable') resources.templatesTable = physical;
      else if (logical === 'DocumentStoreTable') resources.documentStoreTable = physical;
      else if (logical === 'PdfFunction') resources.pdfLogGroup = `/aws/lambda/${physical}`;
      else if (logical === 'AnalyticsFunction') resources.analyticsLogGroup = `/aws/lambda/${physical}`;
      else if (!methodApiId && entry.ResourceType === 'AWS::ApiGateway::Method') {
        const parts = String(physical).split('|');
        if (parts.length >= 3 && parts[0]) methodApiId = parts[0];
      }
    }
  } else {
    if (resResources.isAuthError) resources.stackAuthError = true;
    resources.stackNote = `CFN describe-stack-resources(${resources.stackName}): ${resResources.error}`;
  }

  const descArgs = [
    'cloudformation',
    'describe-stacks',
    '--stack-name',
    resources.stackName,
    '--region',
    config.region,
    '--output',
    'json',
  ];
  const resStacks = runAwsJson(awsRunner, descArgs);
  if (resStacks.ok) {
    resources.stackResolved = true;
    const stack = Array.isArray(resStacks.data.Stacks) ? resStacks.data.Stacks[0] : null;
    const outputs = stack && Array.isArray(stack.Outputs) ? stack.Outputs : [];
    for (const out of outputs) {
      if (out.OutputKey === 'CloudFrontDistributionId' && !resources.cloudFrontDistributionId) {
        resources.cloudFrontDistributionId = out.OutputValue;
      } else if (out.OutputKey === 'PdfBucketName' && !resources.pdfBucket) {
        resources.pdfBucket = out.OutputValue;
      } else if (out.OutputKey === 'TemplatesTableName' && out.OutputValue) {
        resources.templatesTable = out.OutputValue;
      }
    }
  } else {
    if (resStacks.isAuthError) resources.stackAuthError = true;
    if (!resources.stackNote) {
      resources.stackNote = `CFN describe-stacks(${resources.stackName}): ${resStacks.error}`;
    }
  }

  // CloudFormation DescribeStackResources returns at most 100 resources when
  // called without --logical-resource-id; target any missing critical IDs.
  if (resources.stackResolved && !resources.stackAuthError) {
    const targetedLookups = [
      ['RestApi', 'restApiId'],
      ['CloudFrontDistribution', 'cloudFrontDistributionId'],
      ['PdfBucket', 'pdfBucket'],
    ];
    for (const [logicalId, prop] of targetedLookups) {
      if (resources[prop]) continue;
      const singleRes = runAwsJson(awsRunner, [
        'cloudformation',
        'describe-stack-resources',
        '--stack-name',
        resources.stackName,
        '--logical-resource-id',
        logicalId,
        '--region',
        config.region,
        '--output',
        'json',
      ]);
      if (singleRes.ok) {
        const list = Array.isArray(singleRes.data.StackResources) ? singleRes.data.StackResources : [];
        if (list[0] && list[0].PhysicalResourceId) {
          resources[prop] = list[0].PhysicalResourceId;
        }
      }
    }
    if (!resources.restApiId && methodApiId) {
      resources.restApiId = methodApiId;
    }
  }

  return resources;
}

function ddbQueryAll(awsRunner, { tableName, indexName, keyConditionExpression, attrNames, attrValues, region, maxPages }) {
  const items = [];
  let exclusiveStartKey = null;
  let pages = 0;
  let truncated = false;

  while (true) {
    const args = [
      'dynamodb',
      'query',
      '--table-name',
      tableName,
      '--index-name',
      indexName,
      '--key-condition-expression',
      keyConditionExpression,
      '--expression-attribute-names',
      JSON.stringify(attrNames),
      '--expression-attribute-values',
      JSON.stringify(attrValues),
      '--region',
      region,
      '--output',
      'json',
    ];
    if (exclusiveStartKey) {
      args.push('--exclusive-start-key', JSON.stringify(exclusiveStartKey));
    }

    const res = runAwsJson(awsRunner, args);
    if (!res.ok) {
      return {
        ok: false,
        items,
        pages,
        truncated,
        error: res.error,
        isAuthError: res.isAuthError,
        isNotFound: res.isNotFound,
      };
    }

    pages += 1;
    const rawItems = Array.isArray(res.data.Items) ? res.data.Items : [];
    for (const raw of rawItems) {
      items.push(unmarshalItem(raw));
    }

    if (!res.data.LastEvaluatedKey) {
      break;
    }
    if (pages >= maxPages) {
      truncated = true;
      break;
    }
    exclusiveStartKey = res.data.LastEvaluatedKey;
  }

  return { ok: true, items, pages, truncated, error: null };
}

function ddbScanAll(
  awsRunner,
  { tableName, filterExpression, projectionExpression, attrNames, attrValues, region, maxPages }
) {
  const items = [];
  let exclusiveStartKey = null;
  let pages = 0;
  let truncated = false;

  while (true) {
    const args = ['dynamodb', 'scan', '--table-name', tableName, '--region', region, '--output', 'json'];
    if (filterExpression) args.push('--filter-expression', filterExpression);
    if (projectionExpression) args.push('--projection-expression', projectionExpression);
    if (attrNames && Object.keys(attrNames).length > 0) {
      args.push('--expression-attribute-names', JSON.stringify(attrNames));
    }
    if (attrValues && Object.keys(attrValues).length > 0) {
      args.push('--expression-attribute-values', JSON.stringify(attrValues));
    }
    if (exclusiveStartKey) {
      args.push('--exclusive-start-key', JSON.stringify(exclusiveStartKey));
    }

    const res = runAwsJson(awsRunner, args);
    if (!res.ok) {
      return {
        ok: false,
        items,
        pages,
        truncated,
        error: res.error,
        isAuthError: res.isAuthError,
        isNotFound: res.isNotFound,
      };
    }

    pages += 1;
    const rawItems = Array.isArray(res.data.Items) ? res.data.Items : [];
    for (const raw of rawItems) {
      items.push(unmarshalItem(raw));
    }

    if (!res.data.LastEvaluatedKey) {
      break;
    }
    if (pages >= maxPages) {
      truncated = true;
      break;
    }
    exclusiveStartKey = res.data.LastEvaluatedKey;
  }

  return { ok: true, items, pages, truncated, error: null };
}

function sleepSync(ms) {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

function parseLogsCount(results) {
  if (!Array.isArray(results) || results.length === 0) return 0;
  const firstRow = results[0];
  if (!Array.isArray(firstRow) || firstRow.length === 0) return 0;
  const matchCell = firstRow.find((c) => c.field === 'matchCount') || firstRow[0];
  const parsed = Number(matchCell && matchCell.value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function runLogsInsightsCount(
  awsRunner,
  { logGroupName, startTimeSec, endTimeSec, queryString, region, timeoutSec, sleepImpl = sleepSync, nowFn = Date.now }
) {
  const startRes = runAwsJson(awsRunner, [
    'logs',
    'start-query',
    '--log-group-name',
    logGroupName,
    '--start-time',
    String(startTimeSec),
    '--end-time',
    String(endTimeSec),
    '--query-string',
    queryString,
    '--region',
    region,
    '--output',
    'json',
  ]);
  if (!startRes.ok) {
    return {
      ok: false,
      count: null,
      error: startRes.error,
      isAuthError: startRes.isAuthError,
      isNotFound: startRes.isNotFound,
    };
  }

  const queryId = startRes.data.queryId;
  if (!queryId) {
    return { ok: false, count: null, error: 'logs start-query returned no queryId' };
  }

  const deadline = nowFn() + timeoutSec * 1000;
  const terminalStatuses = new Set(['Complete', 'Failed', 'Cancelled', 'Timeout', 'Unknown']);

  while (true) {
    const pollRes = runAwsJson(awsRunner, [
      'logs',
      'get-query-results',
      '--query-id',
      queryId,
      '--region',
      region,
      '--output',
      'json',
    ]);
    if (!pollRes.ok) {
      return {
        ok: false,
        count: null,
        error: pollRes.error,
        isAuthError: pollRes.isAuthError,
        isNotFound: pollRes.isNotFound,
      };
    }

    const status = pollRes.data.status || 'Unknown';
    if (status === 'Complete') {
      return { ok: true, count: parseLogsCount(pollRes.data.results), status };
    }
    if (terminalStatuses.has(status)) {
      return { ok: false, count: null, error: `Logs Insights query ended with status: ${status}` };
    }
    if (nowFn() >= deadline) {
      return {
        ok: false,
        count: null,
        timedOut: true,
        error: `Logs Insights query timed out after ${timeoutSec}s (queryId=${queryId})`,
      };
    }
    sleepImpl(1000);
  }
}

function collectApiGatewayMetrics(awsRunner, resources, config, startIso, endIso) {
  const rows = [];

  if (!resources.restApiId) {
    const authFailed = resources.stackAuthError;
    for (const item of API_GW_TARGETS) {
      rows.push({
        metric_id: item.metricId,
        linked_features: item.linkedFeatures,
        source_system: 'API_GATEWAY',
        target: item.target,
        window_days: config.days,
        total_count: 'N/A',
        unique_owners: 'N/A',
        error_count: 'N/A',
        visibility: authFailed ? 'N/A' : 'UNINSTRUMENTED_ENABLE_STAGE_METRICS',
        recommended_gate: 'INSTRUMENT_FIRST',
        notes: authFailed
          ? `Unable to resolve RestApiId from CloudFormation due to AWS auth/connectivity error (${resources.stackNote}).`
          : `RestApiId unresolved (pass --stack <stack-name> to resolve RestApi). Stage detailed metrics status unknown.`,
      });
    }
    return rows;
  }

  const stageRes = runAwsJson(awsRunner, [
    'apigateway',
    'get-stage',
    '--rest-api-id',
    resources.restApiId,
    '--stage-name',
    resources.stage,
    '--region',
    config.region,
    '--output',
    'json',
  ]);

  if (!stageRes.ok) {
    for (const item of API_GW_TARGETS) {
      rows.push({
        metric_id: item.metricId,
        linked_features: item.linkedFeatures,
        source_system: 'API_GATEWAY',
        target: item.target,
        window_days: config.days,
        total_count: 'N/A',
        unique_owners: 'N/A',
        error_count: 'N/A',
        visibility: stageRes.isAuthError ? 'N/A' : 'UNINSTRUMENTED_ENABLE_STAGE_METRICS',
        recommended_gate: 'INSTRUMENT_FIRST',
        notes: `apigateway get-stage failed for ${resources.restApiId}/${resources.stage}: ${stageRes.error}`,
      });
    }
    return rows;
  }

  const methodSettings = stageRes.data.methodSettings || {};
  const wildcardSettings = methodSettings['*/*'] || {};
  const metricsEnabled = wildcardSettings.metricsEnabled === true;

  if (!metricsEnabled) {
    for (const item of API_GW_TARGETS) {
      rows.push({
        metric_id: item.metricId,
        linked_features: item.linkedFeatures,
        source_system: 'API_GATEWAY',
        target: item.target,
        window_days: config.days,
        total_count: 'N/A',
        unique_owners: 'N/A',
        error_count: 'N/A',
        visibility: 'UNINSTRUMENTED_ENABLE_STAGE_METRICS',
        recommended_gate: 'INSTRUMENT_FIRST',
        notes: `Stage ${resources.stage} (restApiId=${resources.restApiId}) has methodSettings["*/*"].metricsEnabled=${Boolean(
          wildcardSettings.metricsEnabled
        )}. Enable detailed CloudWatch metrics on stage before trusting route counts.`,
      });
    }
    return rows;
  }

  const queries = [];
  const queryLookup = new Map();
  let qIndex = 0;

  for (const target of API_GW_TARGETS) {
    for (const route of target.routes) {
      for (const metricName of ['Count', '4XXError', '5XXError']) {
        const id = `q_${qIndex}`;
        qIndex += 1;
        queries.push({
          Id: id,
          MetricStat: {
            Metric: {
              Namespace: 'AWS/ApiGateway',
              MetricName: metricName,
              Dimensions: [
                { Name: 'ApiName', Value: resources.apiName },
                { Name: 'Stage', Value: resources.stage },
                { Name: 'Resource', Value: route.resource },
                { Name: 'Method', Value: route.method },
              ],
            },
            Period: 86400,
            Stat: 'Sum',
          },
          ReturnData: true,
        });
        queryLookup.set(id, { metricId: target.metricId, metricName });
      }
    }
  }

  const sumsByMetricId = new Map();
  for (const target of API_GW_TARGETS) {
    sumsByMetricId.set(target.metricId, { count: 0, errors4xx: 0, errors5xx: 0 });
  }

  let nextToken = null;
  let cwFailed = null;
  let cwPages = 0;

  while (true) {
    const cwArgs = [
      'cloudwatch',
      'get-metric-data',
      '--metric-data-queries',
      JSON.stringify(queries),
      '--start-time',
      startIso,
      '--end-time',
      endIso,
      '--region',
      config.region,
      '--output',
      'json',
    ];
    if (nextToken) {
      cwArgs.push('--next-token', nextToken);
    }
    const cwRes = runAwsJson(awsRunner, cwArgs);
    if (!cwRes.ok) {
      cwFailed = cwRes;
      break;
    }

    cwPages += 1;
    const metricResults = Array.isArray(cwRes.data.MetricDataResults) ? cwRes.data.MetricDataResults : [];
    for (const mr of metricResults) {
      const meta = queryLookup.get(mr.Id);
      if (!meta) continue;
      const bucket = sumsByMetricId.get(meta.metricId);
      const values = Array.isArray(mr.Values) ? mr.Values : [];
      const sum = values.reduce((acc, v) => acc + (Number(v) || 0), 0);
      if (meta.metricName === 'Count') bucket.count += sum;
      else if (meta.metricName === '4XXError') bucket.errors4xx += sum;
      else if (meta.metricName === '5XXError') bucket.errors5xx += sum;
    }

    if (!cwRes.data.NextToken || cwPages >= config.maxPages) {
      break;
    }
    nextToken = cwRes.data.NextToken;
  }

  if (cwFailed) {
    for (const item of API_GW_TARGETS) {
      rows.push({
        metric_id: item.metricId,
        linked_features: item.linkedFeatures,
        source_system: 'API_GATEWAY',
        target: item.target,
        window_days: config.days,
        total_count: 'N/A',
        unique_owners: 'N/A',
        error_count: 'N/A',
        visibility: 'N/A',
        recommended_gate: 'INSTRUMENT_FIRST',
        notes: `cloudwatch get-metric-data failed: ${cwFailed.error}`,
      });
    }
    return rows;
  }

  for (const item of API_GW_TARGETS) {
    const s = sumsByMetricId.get(item.metricId);
    const totalErrors = Math.round(s.errors4xx + s.errors5xx);
    const totalCount = Math.round(s.count);
    rows.push({
      metric_id: item.metricId,
      linked_features: item.linkedFeatures,
      source_system: 'API_GATEWAY',
      target: item.target,
      window_days: config.days,
      total_count: totalCount,
      unique_owners: 'N/A',
      error_count: totalErrors,
      visibility: 'FULL',
      recommended_gate: totalCount === 0 ? 'GO' : 'HOLD',
      notes: `Stage=${resources.stage} metricsEnabled=true; 4XX=${Math.round(s.errors4xx)}, 5XX=${Math.round(
        s.errors5xx
      )}. Per-caller identity not exposed in API GW stage metrics.`,
    });
  }

  return rows;
}

function collectFrontendAndCloudFront(awsRunner, resources, config, dateStrings) {
  let cfLoggingEnabled = false;
  let cfCheckNote = '';

  if (!resources.cloudFrontDistributionId) {
    cfCheckNote = resources.stackAuthError
      ? `CloudFrontDistributionId unresolved due to AWS auth error (${resources.stackNote}).`
      : 'CloudFrontDistributionId unresolved (pass --stack <stack-name>); assuming CF access logging disabled.';
  } else {
    const cfRes = runAwsJson(awsRunner, [
      'cloudfront',
      'get-distribution-config',
      '--id',
      resources.cloudFrontDistributionId,
      '--output',
      'json',
    ]);
    if (!cfRes.ok) {
      cfCheckNote = `cloudfront get-distribution-config(${resources.cloudFrontDistributionId}) failed: ${cfRes.error}.`;
    } else {
      const logging = cfRes.data.DistributionConfig && cfRes.data.DistributionConfig.Logging;
      cfLoggingEnabled = Boolean(logging && logging.Enabled === true);
      cfCheckNote = cfLoggingEnabled
        ? `CloudFront ${resources.cloudFrontDistributionId} Logging.Enabled=true (Bucket=${logging.Bucket || 'N/A'}, Prefix=${
            logging.Prefix || ''
          }). Raw CF S3 logs are not parsed by this audit.`
        : `CloudFront ${resources.cloudFrontDistributionId} Logging.Enabled=false (no CF access logs).`;
    }
  }

  const statsByTarget = new Map();
  for (const t of FRONTEND_TARGETS) {
    statsByTarget.set(t.metricId, {
      matchedEvents: 0,
      pageViewedEvents: 0,
      owners: new Set(),
    });
  }

  let anyAnalyticsQuerySucceeded = false;
  let analyticsTruncated = false;
  const analyticsErrors = [];

  for (const day of dateStrings) {
    const res = ddbQueryAll(awsRunner, {
      tableName: resources.usageTable,
      indexName: 'AnalyticsDateIndex',
      keyConditionExpression: '#pk = :pk',
      attrNames: { '#pk': 'GSI1PK' },
      attrValues: { ':pk': { S: `ANALYTICS#${day}` } },
      region: config.region,
      maxPages: config.maxPages,
    });

    if (!res.ok) {
      analyticsErrors.push(`${day}: ${res.error}`);
      continue;
    }

    anyAnalyticsQuerySucceeded = true;
    if (res.truncated) analyticsTruncated = true;

    for (const item of res.items) {
      if (item.entityType && item.entityType !== 'ANALYTICS') continue;
      const matchedIds = matchFrontendPath(item);
      if (matchedIds.length === 0) continue;
      const owner = item.customerId || item.userId || item.sessionId || item.visitorId || null;
      const isPageViewed = item.eventName === 'page_viewed';
      for (const id of matchedIds) {
        const entry = statsByTarget.get(id);
        entry.matchedEvents += 1;
        if (isPageViewed) entry.pageViewedEvents += 1;
        if (owner) entry.owners.add(String(owner));
      }
    }
  }

  const rows = [];
  for (const t of FRONTEND_TARGETS) {
    const s = statsByTarget.get(t.metricId);
    if (!anyAnalyticsQuerySucceeded) {
      rows.push({
        metric_id: t.metricId,
        linked_features: 'F18',
        source_system: 'CLOUDFRONT_AND_DDB_ANALYTICS',
        target: t.target,
        window_days: config.days,
        total_count: 'N/A',
        unique_owners: 'N/A',
        error_count: 'N/A',
        visibility: 'N/A',
        recommended_gate: 'INSTRUMENT_FIRST',
        notes: `${cfCheckNote} UsageTable ANALYTICS# query failed: ${analyticsErrors[0] || 'unknown error'}`,
      });
      continue;
    }

    const baseVisibility = cfLoggingEnabled ? 'PARTIAL' : 'UNINSTRUMENTED_NO_CF_LOGS';
    const visibility = analyticsTruncated || analyticsErrors.length > 0 ? `${baseVisibility}|TRUNCATED` : baseVisibility;
    const errNote = analyticsErrors.length > 0 ? ` Partial query errors=${analyticsErrors.length}.` : '';

    rows.push({
      metric_id: t.metricId,
      linked_features: 'F18',
      source_system: 'CLOUDFRONT_AND_DDB_ANALYTICS',
      target: t.target,
      window_days: config.days,
      total_count: s.matchedEvents,
      unique_owners: s.owners.size,
      error_count: 'N/A',
      visibility,
      recommended_gate: s.matchedEvents > 0 ? 'HOLD' : 'INSTRUMENT_FIRST',
      notes: `${cfCheckNote} Supplemented by UsageTable ANALYTICS# events: total_matched=${s.matchedEvents}, page_viewed=${s.pageViewedEvents}.${errNote}`,
    });
  }

  return rows;
}

function collectUsageAndChatAndBilling(
  awsRunner,
  resources,
  config,
  dateStrings,
  cutoffMs,
  startTimeSec,
  endTimeSec,
  { sleepImpl = sleepSync, nowFn = Date.now } = {}
) {
  const rows = [];

  // 1. Daily USAGE#YYYY-MM-DD (PDF_REQUEST by sourceType)
  const bySourceType = new Map();
  for (const spec of USAGE_SOURCE_TYPE_TARGETS) {
    bySourceType.set(spec.sourceType, {
      total: 0,
      errors: 0,
      owners: new Set(),
      modes: new Map(),
      plans: new Map(),
      linkedFeatures: spec.linkedFeatures,
      gateMode: spec.gateMode,
    });
  }

  let usageAnySuccess = false;
  let usageTruncated = false;
  const usageErrors = [];

  for (const day of dateStrings) {
    const res = ddbQueryAll(awsRunner, {
      tableName: resources.usageTable,
      indexName: 'AnalyticsDateIndex',
      keyConditionExpression: '#pk = :pk',
      attrNames: { '#pk': 'GSI1PK' },
      attrValues: { ':pk': { S: `USAGE#${day}` } },
      region: config.region,
      maxPages: config.maxPages,
    });

    if (!res.ok) {
      usageErrors.push(`${day}: ${res.error}`);
      continue;
    }

    usageAnySuccess = true;
    if (res.truncated) usageTruncated = true;

    for (const item of res.items) {
      if (item.entityType && item.entityType !== 'PDF_REQUEST') continue;
      const rawType = typeof item.sourceType === 'string' && item.sourceType.trim() ? item.sourceType.trim().toLowerCase() : 'unspecified';
      if (!bySourceType.has(rawType)) {
        bySourceType.set(rawType, {
          total: 0,
          errors: 0,
          owners: new Set(),
          modes: new Map(),
          plans: new Map(),
          linkedFeatures: 'F3,F4',
          gateMode: 'info',
        });
      }
      const bucket = bySourceType.get(rawType);
      bucket.total += 1;

      const status = typeof item.status === 'string' ? item.status.trim().toLowerCase() : '';
      const isError = Boolean(item.errorType) || (status !== '' && status !== 'success' && status !== 'ok');
      if (isError) bucket.errors += 1;

      if (item.customerId) bucket.owners.add(String(item.customerId));

      if (item.sourceMode) {
        const mode = String(item.sourceMode);
        bucket.modes.set(mode, (bucket.modes.get(mode) || 0) + 1);
      }
      if (item.plan) {
        const plan = String(item.plan);
        bucket.plans.set(plan, (bucket.plans.get(plan) || 0) + 1);
      }
    }
  }

  for (const [sourceType, b] of bySourceType.entries()) {
    if (sourceType === 'unspecified' && b.total === 0) continue;
    if (!usageAnySuccess) {
      rows.push({
        metric_id: `f3_f4_ddb_usage_${sourceType}`,
        linked_features: b.linkedFeatures,
        source_system: 'DYNAMODB_USAGE_TABLE',
        target: `PDF_REQUEST sourceType=${sourceType}`,
        window_days: config.days,
        total_count: 'N/A',
        unique_owners: 'N/A',
        error_count: 'N/A',
        visibility: 'N/A',
        recommended_gate: 'INSTRUMENT_FIRST',
        notes: `UsageTable USAGE# query failed: ${usageErrors[0] || 'unknown error'}`,
      });
      continue;
    }

    const modeSummary = Array.from(b.modes.entries())
      .map(([k, v]) => `${k}:${v}`)
      .join(',');
    const planSummary = Array.from(b.plans.entries())
      .map(([k, v]) => `${k}:${v}`)
      .join(',');
    const visibility = usageTruncated ? 'FULL|TRUNCATED' : usageErrors.length > 0 ? 'PARTIAL' : 'FULL';
    let gate = 'INFO';
    if (b.gateMode === 'legacy_candidate') {
      if (usageTruncated || usageErrors.length > 0) gate = b.total > 0 ? 'HOLD' : 'INSTRUMENT_FIRST';
      else gate = b.total === 0 ? 'GO' : 'HOLD';
    }

    rows.push({
      metric_id: `f3_f4_ddb_usage_${sourceType}`,
      linked_features: b.linkedFeatures,
      source_system: 'DYNAMODB_USAGE_TABLE',
      target: `PDF_REQUEST sourceType=${sourceType}`,
      window_days: config.days,
      total_count: b.total,
      unique_owners: b.owners.size,
      error_count: b.errors,
      visibility,
      recommended_gate: gate,
      notes: `sourceMode=[${modeSummary || 'none'}]; plans=[${planSummary || 'none'}]${
        usageErrors.length > 0 ? `; queryErrors=${usageErrors.length}` : ''
      }`,
    });
  }

  // 2. Chat sessions (CHAT_STATUS#active|escalated|resolved)
  const chatStatuses = ['active', 'escalated', 'resolved'];
  let chatSuccess = false;
  let chatTruncated = false;
  const chatErrors = [];
  let chatSessionsWindow = 0;
  let chatSessionsAllTime = 0;
  let chatMessagesWindow = 0;
  const chatOwnersWindow = new Set();
  const chatStatusCounts = { active: 0, escalated: 0, resolved: 0 };

  for (const st of chatStatuses) {
    const res = ddbQueryAll(awsRunner, {
      tableName: resources.usageTable,
      indexName: 'AnalyticsDateIndex',
      keyConditionExpression: '#pk = :pk',
      attrNames: { '#pk': 'GSI1PK' },
      attrValues: { ':pk': { S: `CHAT_STATUS#${st}` } },
      region: config.region,
      maxPages: config.maxPages,
    });

    if (!res.ok) {
      chatErrors.push(`${st}: ${res.error}`);
      continue;
    }

    chatSuccess = true;
    if (res.truncated) chatTruncated = true;

    for (const item of res.items) {
      if (item.entityType && item.entityType !== 'CHAT_SESSION') continue;
      chatSessionsAllTime += 1;
      const tsMs = parseTimestampMs(item.updatedAt) ?? parseTimestampMs(item.createdAt);
      if (tsMs !== null && tsMs >= cutoffMs) {
        chatSessionsWindow += 1;
        chatStatusCounts[st] += 1;
        const msgCount = Number(item.messageCount);
        if (Number.isFinite(msgCount) && msgCount > 0) {
          chatMessagesWindow += msgCount;
        }
        if (item.customerId || item.userId) {
          chatOwnersWindow.add(String(item.customerId || item.userId));
        }
      }
    }
  }

  if (!chatSuccess) {
    const note = `UsageTable CHAT_STATUS#* query failed: ${chatErrors[0] || 'unknown error'}`;
    rows.push(
      {
        metric_id: 'f17_ddb_chat_sessions',
        linked_features: 'F17',
        source_system: 'DYNAMODB_USAGE_TABLE',
        target: 'CHAT_STATUS#* sessions (30d)',
        window_days: config.days,
        total_count: 'N/A',
        unique_owners: 'N/A',
        error_count: 'N/A',
        visibility: 'N/A',
        recommended_gate: 'INSTRUMENT_FIRST',
        notes: note,
      },
      {
        metric_id: 'f17_ddb_chat_messages',
        linked_features: 'F17',
        source_system: 'DYNAMODB_USAGE_TABLE',
        target: 'CHAT_STATUS#* messageCount sum (30d)',
        window_days: config.days,
        total_count: 'N/A',
        unique_owners: 'N/A',
        error_count: 'N/A',
        visibility: 'N/A',
        recommended_gate: 'INSTRUMENT_FIRST',
        notes: note,
      }
    );
  } else {
    const visibility = chatTruncated ? 'FULL|TRUNCATED' : chatErrors.length > 0 ? 'PARTIAL' : 'FULL';
    const chatNote = `status_30d={active:${chatStatusCounts.active},escalated:${chatStatusCounts.escalated},resolved:${chatStatusCounts.resolved}}; all_time_sessions=${chatSessionsAllTime}${
      chatErrors.length > 0 ? `; queryErrors=${chatErrors.length}` : ''
    }`;
    rows.push(
      {
        metric_id: 'f17_ddb_chat_sessions',
        linked_features: 'F17',
        source_system: 'DYNAMODB_USAGE_TABLE',
        target: 'CHAT_STATUS#* sessions (30d)',
        window_days: config.days,
        total_count: chatSessionsWindow,
        unique_owners: chatOwnersWindow.size,
        error_count: 'N/A',
        visibility,
        recommended_gate:
          chatSessionsWindow > 0 ? 'HOLD' : chatTruncated || chatErrors.length > 0 ? 'INSTRUMENT_FIRST' : 'GO',
        notes: chatNote,
      },
      {
        metric_id: 'f17_ddb_chat_messages',
        linked_features: 'F17',
        source_system: 'DYNAMODB_USAGE_TABLE',
        target: 'CHAT_STATUS#* messageCount sum (30d)',
        window_days: config.days,
        total_count: chatMessagesWindow,
        unique_owners: chatOwnersWindow.size,
        error_count: 'N/A',
        visibility,
        recommended_gate:
          chatMessagesWindow > 0 ? 'HOLD' : chatTruncated || chatErrors.length > 0 ? 'INSTRUMENT_FIRST' : 'GO',
        notes: chatNote,
      }
    );
  }

  // 3. AnalyticsFunction Bedrock/Chat errors via CloudWatch Logs Insights
  const chatLogRes = runLogsInsightsCount(awsRunner, {
    logGroupName: resources.analyticsLogGroup,
    startTimeSec,
    endTimeSec,
    queryString:
      'fields @timestamp, @message | filter @message like /(?i)(bedrock|converse|invokemodel|support.?chat|\\/api\\/v1\\/chat)/ and @message like /(?i)(error|exception|failed|throttl|timeout|denied)/ | stats count() as matchCount',
    region: config.region,
    timeoutSec: config.queryTimeoutSec,
    sleepImpl,
    nowFn,
  });

  rows.push({
    metric_id: 'f17_logs_chat_bedrock_errors',
    linked_features: 'F17',
    source_system: 'CLOUDWATCH_LOGS_INSIGHTS',
    target: `${resources.analyticsLogGroup} (Bedrock/chat errors)`,
    window_days: config.days,
    total_count: 'N/A',
    unique_owners: 'N/A',
    error_count: chatLogRes.ok ? chatLogRes.count : 'N/A',
    visibility: chatLogRes.ok ? 'PARTIAL' : 'N/A',
    recommended_gate: !chatLogRes.ok ? 'INSTRUMENT_FIRST' : chatLogRes.count > 0 ? 'HOLD' : 'INFO',
    notes: chatLogRes.ok
      ? 'Matched Bedrock/chat error log lines in AnalyticsFunction. Does not measure successful invocations.'
      : `Logs Insights failed for ${resources.analyticsLogGroup}: ${chatLogRes.error}`,
  });

  // 4. Paid accounts context (BILLING#)
  const billingRes = ddbScanAll(awsRunner, {
    tableName: resources.usageTable,
    filterExpression: '#et = :billing OR begins_with(requestId, :prefix)',
    projectionExpression: 'requestId, entityType, #st, #pl, customerId, userId',
    attrNames: { '#et': 'entityType', '#st': 'status', '#pl': 'plan' },
    attrValues: { ':billing': { S: 'BILLING' }, ':prefix': { S: 'BILLING#' } },
    region: config.region,
    maxPages: config.maxPages,
  });

  if (!billingRes.ok) {
    rows.push({
      metric_id: 'context_ddb_billing_accounts',
      linked_features: 'CONTEXT',
      source_system: 'DYNAMODB_USAGE_TABLE',
      target: 'BILLING active|trialing|past_due accounts',
      window_days: config.days,
      total_count: 'N/A',
      unique_owners: 'N/A',
      error_count: 'N/A',
      visibility: 'N/A',
      recommended_gate: 'INFO',
      notes: `UsageTable BILLING scan failed: ${billingRes.error}`,
    });
  } else {
    const activeStatuses = new Set(['active', 'trialing', 'past_due']);
    const statusCounts = new Map();
    const planCounts = new Map();
    const owners = new Set();
    let paidCount = 0;

    for (const item of billingRes.items) {
      const st = typeof item.status === 'string' ? item.status.trim().toLowerCase() : 'unknown';
      statusCounts.set(st, (statusCounts.get(st) || 0) + 1);
      if (activeStatuses.has(st)) {
        paidCount += 1;
        const owner = item.customerId || item.userId || item.requestId;
        if (owner) owners.add(String(owner));
        const plan = item.plan || 'unknown';
        planCounts.set(plan, (planCounts.get(plan) || 0) + 1);
      }
    }

    rows.push({
      metric_id: 'context_ddb_billing_accounts',
      linked_features: 'CONTEXT',
      source_system: 'DYNAMODB_USAGE_TABLE',
      target: 'BILLING active|trialing|past_due accounts',
      window_days: config.days,
      total_count: paidCount,
      unique_owners: owners.size,
      error_count: 'N/A',
      visibility: billingRes.truncated ? 'FULL|TRUNCATED' : 'FULL',
      recommended_gate: 'INFO',
      notes: `total_billing_rows=${billingRes.items.length}; statuses=[${Array.from(statusCounts.entries())
        .map(([k, v]) => `${k}:${v}`)
        .join(',')}]; paid_plans=[${Array.from(planCounts.entries())
        .map(([k, v]) => `${k}:${v}`)
        .join(',')}]`,
    });
  }

  return rows;
}

function collectTemplates(awsRunner, resources, config, cutoffMs) {
  const scanRes = ddbScanAll(awsRunner, {
    tableName: resources.templatesTable,
    projectionExpression: 'PK, SK, updatedAt, createdAt',
    region: config.region,
    maxPages: config.maxPages,
  });

  if (!scanRes.ok) {
    const note = `TemplatesTable (${resources.templatesTable}) scan failed: ${scanRes.error}`;
    return [
      {
        metric_id: 'f3_ddb_templates_total',
        linked_features: 'F3',
        source_system: 'DYNAMODB_TEMPLATES_TABLE',
        target: `${resources.templatesTable} (all templates)`,
        window_days: config.days,
        total_count: 'N/A',
        unique_owners: 'N/A',
        error_count: 'N/A',
        visibility: 'N/A',
        recommended_gate: 'INSTRUMENT_FIRST',
        notes: note,
      },
      {
        metric_id: 'f3_ddb_templates_30d_active',
        linked_features: 'F3',
        source_system: 'DYNAMODB_TEMPLATES_TABLE',
        target: `${resources.templatesTable} (active in window)`,
        window_days: config.days,
        total_count: 'N/A',
        unique_owners: 'N/A',
        error_count: 'N/A',
        visibility: 'N/A',
        recommended_gate: 'INSTRUMENT_FIRST',
        notes: note,
      },
    ];
  }

  const allOwners = new Set();
  const activeOwners = new Set();
  let activeCount = 0;

  for (const item of scanRes.items) {
    if (item.PK) allOwners.add(String(item.PK));
    const tsMs = parseTimestampMs(item.updatedAt) ?? parseTimestampMs(item.createdAt);
    if (tsMs !== null && tsMs >= cutoffMs) {
      activeCount += 1;
      if (item.PK) activeOwners.add(String(item.PK));
    }
  }

  const visibility = scanRes.truncated ? 'FULL|TRUNCATED' : 'FULL';

  return [
    {
      metric_id: 'f3_ddb_templates_total',
      linked_features: 'F3',
      source_system: 'DYNAMODB_TEMPLATES_TABLE',
      target: `${resources.templatesTable} (all templates)`,
      window_days: config.days,
      total_count: scanRes.items.length,
      unique_owners: allOwners.size,
      error_count: 'N/A',
      visibility,
      recommended_gate: scanRes.truncated ? 'INSTRUMENT_FIRST' : scanRes.items.length === 0 ? 'GO' : 'HOLD',
      notes: `Scanned ${scanRes.pages} page(s) in ${resources.templatesTable}.`,
    },
    {
      metric_id: 'f3_ddb_templates_30d_active',
      linked_features: 'F3',
      source_system: 'DYNAMODB_TEMPLATES_TABLE',
      target: `${resources.templatesTable} (active in window)`,
      window_days: config.days,
      total_count: activeCount,
      unique_owners: activeOwners.size,
      error_count: 'N/A',
      visibility,
      recommended_gate: scanRes.truncated ? 'INSTRUMENT_FIRST' : activeCount === 0 ? 'GO' : 'HOLD',
      notes: `Templates with updatedAt or createdAt within last ${config.days}d.`,
    },
  ];
}

function collectDocumentStoreAndCompliance(
  awsRunner,
  resources,
  config,
  cutoffMs,
  nowMs,
  startTimeSec,
  endTimeSec,
  { sleepImpl = sleepSync, nowFn = Date.now } = {}
) {
  const rows = [];
  const docScan = ddbScanAll(awsRunner, {
    tableName: resources.documentStoreTable,
    projectionExpression: 'PK, SK, entityType, kind, objectKey, #bk, updatedAt, createdAt, expiresAt',
    attrNames: { '#bk': 'bucket' },
    region: config.region,
    maxPages: config.maxPages,
  });

  const sourceObjects = [];

  if (!docScan.ok) {
    const errNote = `DocumentStoreTable (${resources.documentStoreTable}) scan failed: ${docScan.error}`;
    rows.push(
      {
        metric_id: 'f4_ddb_sources_total',
        linked_features: 'F4',
        source_system: 'DYNAMODB_DOCUMENT_STORE',
        target: `${resources.documentStoreTable} entityType=SOURCE (all)`,
        window_days: config.days,
        total_count: 'N/A',
        unique_owners: 'N/A',
        error_count: 'N/A',
        visibility: 'N/A',
        recommended_gate: 'INFO',
        notes: errNote,
      },
      {
        metric_id: 'f4_ddb_sources_30d_active',
        linked_features: 'F4',
        source_system: 'DYNAMODB_DOCUMENT_STORE',
        target: `${resources.documentStoreTable} entityType=SOURCE (active in window)`,
        window_days: config.days,
        total_count: 'N/A',
        unique_owners: 'N/A',
        error_count: 'N/A',
        visibility: 'N/A',
        recommended_gate: 'INFO',
        notes: errNote,
      }
    );

    for (const kind of CANONICAL_FILE_KINDS) {
      rows.push({
        metric_id: `f5_ddb_files_kind_${kind}`,
        linked_features: 'F5,F7',
        source_system: 'DYNAMODB_DOCUMENT_STORE',
        target: `${resources.documentStoreTable} FILE kind=${kind}`,
        window_days: config.days,
        total_count: 'N/A',
        unique_owners: 'N/A',
        error_count: 'N/A',
        visibility: 'N/A',
        recommended_gate: 'INSTRUMENT_FIRST',
        notes: errNote,
      });
    }

    rows.push(
      {
        metric_id: 'f5_ddb_files_expired_no_ttl',
        linked_features: 'F5,F7',
        source_system: 'DYNAMODB_DOCUMENT_STORE',
        target: `${resources.documentStoreTable} FILE expired (>30d / past expiresAt)`,
        window_days: config.days,
        total_count: 'N/A',
        unique_owners: 'N/A',
        error_count: 'N/A',
        visibility: 'N/A',
        recommended_gate: 'INSTRUMENT_FIRST',
        notes: errNote,
      },
      {
        metric_id: 'context_ddb_batch_jobs',
        linked_features: 'CONTEXT',
        source_system: 'DYNAMODB_DOCUMENT_STORE',
        target: `${resources.documentStoreTable} entityType=BATCH_JOB`,
        window_days: config.days,
        total_count: 'N/A',
        unique_owners: 'N/A',
        error_count: 'N/A',
        visibility: 'N/A',
        recommended_gate: 'INFO',
        notes: errNote,
      }
    );
  } else {
    const visibility = docScan.truncated ? 'FULL|TRUNCATED' : 'FULL';

    let sourcesTotal = 0;
    let sourcesActive = 0;
    const sourceOwnersAll = new Set();
    const sourceOwnersActive = new Set();

    const filesByKind = new Map();
    for (const kind of CANONICAL_FILE_KINDS) {
      filesByKind.set(kind, { total: 0, owners: new Set() });
    }
    let filesExpiredPastAttr = 0;
    let filesOlderThanWindow = 0;
    let filesExpiredUnion = 0;
    const expiredOwners = new Set();

    let batchTotal = 0;
    let batchActive = 0;
    const batchOwners = new Set();

    for (const item of docScan.items) {
      const entityType = item.entityType;
      const owner = item.PK ? String(item.PK) : null;
      const tsMs = parseTimestampMs(item.updatedAt) ?? parseTimestampMs(item.createdAt);

      if (entityType === 'SOURCE') {
        sourcesTotal += 1;
        if (owner) sourceOwnersAll.add(owner);
        if (tsMs !== null && tsMs >= cutoffMs) {
          sourcesActive += 1;
          if (owner) sourceOwnersActive.add(owner);
        }
        if (item.objectKey) {
          sourceObjects.push({
            owner: owner || 'unknown',
            objectKey: String(item.objectKey),
            bucket: item.bucket ? String(item.bucket) : resources.pdfBucket,
          });
        }
      } else if (entityType === 'FILE') {
        const kind = typeof item.kind === 'string' && item.kind.trim() ? item.kind.trim() : 'unspecified';
        if (!filesByKind.has(kind)) {
          filesByKind.set(kind, { total: 0, owners: new Set() });
        }
        const entry = filesByKind.get(kind);
        entry.total += 1;
        if (owner) entry.owners.add(owner);

        const expiresMs = parseTimestampMs(item.expiresAt);
        const isPastExpires = expiresMs !== null && expiresMs < nowMs;
        const createdOrUpdated = parseTimestampMs(item.createdAt) ?? parseTimestampMs(item.updatedAt);
        const isOlder = createdOrUpdated !== null && createdOrUpdated < cutoffMs;
        if (isPastExpires) filesExpiredPastAttr += 1;
        if (isOlder) filesOlderThanWindow += 1;
        if (isPastExpires || isOlder) {
          filesExpiredUnion += 1;
          if (owner) expiredOwners.add(owner);
        }
      } else if (entityType === 'BATCH_JOB') {
        batchTotal += 1;
        if (owner) batchOwners.add(owner);
        if (tsMs !== null && tsMs >= cutoffMs) {
          batchActive += 1;
        }
      }
    }

    rows.push(
      {
        metric_id: 'f4_ddb_sources_total',
        linked_features: 'F4',
        source_system: 'DYNAMODB_DOCUMENT_STORE',
        target: `${resources.documentStoreTable} entityType=SOURCE (all)`,
        window_days: config.days,
        total_count: sourcesTotal,
        unique_owners: sourceOwnersAll.size,
        error_count: 'N/A',
        visibility,
        recommended_gate: 'INFO',
        notes: `Saved S3 source keys found=${sourceObjects.length}. Scanned ${docScan.pages} page(s).`,
      },
      {
        metric_id: 'f4_ddb_sources_30d_active',
        linked_features: 'F4',
        source_system: 'DYNAMODB_DOCUMENT_STORE',
        target: `${resources.documentStoreTable} entityType=SOURCE (active in window)`,
        window_days: config.days,
        total_count: sourcesActive,
        unique_owners: sourceOwnersActive.size,
        error_count: 'N/A',
        visibility,
        recommended_gate: 'INFO',
        notes: `SOURCE rows with updatedAt or createdAt within last ${config.days}d.`,
      }
    );

    for (const [kind, entry] of filesByKind.entries()) {
      if (kind === 'unspecified' && entry.total === 0) continue;
      rows.push({
        metric_id: `f5_ddb_files_kind_${kind}`,
        linked_features: 'F5,F7',
        source_system: 'DYNAMODB_DOCUMENT_STORE',
        target: `${resources.documentStoreTable} FILE kind=${kind}`,
        window_days: config.days,
        total_count: entry.total,
        unique_owners: entry.owners.size,
        error_count: 'N/A',
        visibility,
        recommended_gate: 'INFO',
        notes: `All FILE rows with kind=${kind} in ${resources.documentStoreTable}.`,
      });
    }

    rows.push(
      {
        metric_id: 'f5_ddb_files_expired_no_ttl',
        linked_features: 'F5,F7',
        source_system: 'DYNAMODB_DOCUMENT_STORE',
        target: `${resources.documentStoreTable} FILE expired (>30d / past expiresAt)`,
        window_days: config.days,
        total_count: filesExpiredUnion,
        unique_owners: expiredOwners.size,
        error_count: 'N/A',
        visibility,
        recommended_gate: docScan.truncated ? 'INSTRUMENT_FIRST' : filesExpiredUnion > 0 ? 'HOLD' : 'GO',
        notes: `past_expiresAt=${filesExpiredPastAttr}; older_than_${config.days}d=${filesOlderThanWindow}. DocumentStoreTable has no DynamoDB TTL enabled in CloudFormation.`,
      },
      {
        metric_id: 'context_ddb_batch_jobs',
        linked_features: 'CONTEXT',
        source_system: 'DYNAMODB_DOCUMENT_STORE',
        target: `${resources.documentStoreTable} entityType=BATCH_JOB`,
        window_days: config.days,
        total_count: batchTotal,
        unique_owners: batchOwners.size,
        error_count: 'N/A',
        visibility,
        recommended_gate: 'INFO',
        notes: `30d_active=${batchActive}.`,
      }
    );
  }

  // F12/F13/F14: Logs Insights error/validation matches + S3 saved SOURCE inspection
  const featureResults = {
    compliance: { savedCount: 0, owners: new Set() },
    signing: { savedCount: 0, owners: new Set() },
    redaction: { savedCount: 0, owners: new Set() },
  };

  let s3Inspected = 0;
  let s3Errors = 0;
  const s3CappedList = sourceObjects.slice(0, config.maxS3Sources);
  const s3Truncated = sourceObjects.length > config.maxS3Sources;
  let lastS3Error = '';

  if (s3CappedList.length > 0) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'renderpdf-audit-'));
    try {
      for (let idx = 0; idx < s3CappedList.length; idx += 1) {
        const obj = s3CappedList[idx];
        if (!obj.bucket) {
          s3Errors += 1;
          lastS3Error = 'PdfBucket unresolved (pass --stack <stack-name>)';
          continue;
        }
        const outFile = path.join(tmpDir, `source-${idx}.json`);
        const s3Res = awsRunner([
          's3api',
          'get-object',
          '--bucket',
          obj.bucket,
          '--key',
          obj.objectKey,
          outFile,
          '--region',
          config.region,
          '--output',
          'json',
        ]);
        if (!s3Res.ok) {
          s3Errors += 1;
          lastS3Error = s3Res.error;
          continue;
        }

        let bodyText = null;
        if (s3Res.body !== undefined) {
          bodyText = typeof s3Res.body === 'string' ? s3Res.body : JSON.stringify(s3Res.body);
        } else if (fs.existsSync(outFile)) {
          bodyText = fs.readFileSync(outFile, 'utf8');
        }

        if (bodyText === null) {
          s3Errors += 1;
          lastS3Error = `Missing S3 object body for ${obj.objectKey}`;
          continue;
        }

        try {
          const parsed = JSON.parse(bodyText);
          s3Inspected += 1;
          const opts = parsed && typeof parsed === 'object' ? parsed.options || {} : {};
          for (const key of ['compliance', 'signing', 'redaction']) {
            if (isOptionEnabled(opts[key])) {
              featureResults[key].savedCount += 1;
              featureResults[key].owners.add(obj.owner);
            }
          }
        } catch (err) {
          s3Errors += 1;
          lastS3Error = `Invalid JSON in ${obj.objectKey}: ${err.message}`;
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  for (const spec of COMPLIANCE_LOG_QUERIES) {
    const logRes = runLogsInsightsCount(awsRunner, {
      logGroupName: resources.pdfLogGroup,
      startTimeSec,
      endTimeSec,
      queryString: spec.query,
      region: config.region,
      timeoutSec: config.queryTimeoutSec,
      sleepImpl,
      nowFn,
    });

    const fStat = featureResults[spec.key];
    const s3Unavailable = !docScan.ok || (s3CappedList.length > 0 && s3Inspected === 0 && s3Errors > 0);
    const logsUnavailable = !logRes.ok;

    let visibility = 'PARTIAL_ERRORS_AND_SAVED_SOURCES_ONLY';
    if (s3Unavailable && logsUnavailable) {
      visibility = 'N/A';
    } else if ((docScan.ok && docScan.truncated) || s3Truncated) {
      visibility = 'PARTIAL_ERRORS_AND_SAVED_SOURCES_ONLY|TRUNCATED';
    }

    const totalCount = s3Unavailable ? 'N/A' : fStat.savedCount;
    const uniqueOwners = s3Unavailable ? 'N/A' : fStat.owners.size;
    const errorCount = logsUnavailable ? 'N/A' : logRes.count;

    const hasSignal =
      (typeof totalCount === 'number' && totalCount > 0) || (typeof errorCount === 'number' && errorCount > 0);
    const recommendedGate = hasSignal ? 'HOLD' : 'INSTRUMENT_FIRST';

    const blindSpotExplanation =
      'BLIND SPOT: api/api_analytics.go does not write compliance/signing/redaction to UsageTable and PdfFunction emits no success log lines.';
    const details = `inspected_s3_sources=${s3Inspected}/${sourceObjects.length}; log_matches=${
      logRes.ok ? logRes.count : 'N/A'
    }; s3_errors=${s3Errors}${lastS3Error ? ` (${lastS3Error})` : ''}${
      !logRes.ok ? `; logs_error=${logRes.error}` : ''
    }${!docScan.ok ? `; ddb_error=${docScan.error}` : ''}`;

    rows.push({
      metric_id: spec.metricId,
      linked_features: spec.linkedFeatures,
      source_system: 'CLOUDWATCH_LOGS_AND_S3_SOURCES',
      target: spec.target,
      window_days: config.days,
      total_count: totalCount,
      unique_owners: uniqueOwners,
      error_count: errorCount,
      visibility,
      recommended_gate: recommendedGate,
      notes: `${blindSpotExplanation} ${details}`,
    });
  }

  return rows;
}

function buildPlannedCommands(config, now = new Date()) {
  const app = config.appName;
  const stackName = config.stack || app;
  const dates = getUtcDateStrings(config.days, now);
  const endTimeSec = Math.floor(now.getTime() / 1000);
  const startTimeSec = endTimeSec - config.days * 86400;
  const startIso = new Date(startTimeSec * 1000).toISOString();
  const endIso = new Date(endTimeSec * 1000).toISOString();

  const commands = [
    {
      description: 'Resolve stack resources',
      args: ['cloudformation', 'describe-stack-resources', '--stack-name', stackName, '--region', config.region, '--output', 'json'],
    },
    {
      description: 'Resolve stack outputs',
      args: ['cloudformation', 'describe-stacks', '--stack-name', stackName, '--region', config.region, '--output', 'json'],
    },
    {
      description: 'Check API Gateway stage methodSettings["*/*"].metricsEnabled',
      args: ['apigateway', 'get-stage', '--rest-api-id', '<RestApiId>', '--stage-name', config.stage, '--region', config.region, '--output', 'json'],
    },
    {
      description: 'Fetch API Gateway 30d route Count/4XXError/5XXError (if metricsEnabled=true)',
      args: [
        'cloudwatch',
        'get-metric-data',
        '--metric-data-queries',
        `[${API_GW_TARGETS.flatMap((t) => t.routes).length * 3} route/metric queries]`,
        '--start-time',
        startIso,
        '--end-time',
        endIso,
        '--region',
        config.region,
        '--output',
        'json',
      ],
    },
    {
      description: 'Check CloudFront DistributionConfig.Logging.Enabled',
      args: ['cloudfront', 'get-distribution-config', '--id', '<CloudFrontDistributionId>', '--output', 'json'],
    },
    {
      description: `Query UsageTable USAGE#YYYY-MM-DD (${dates.length} days: ${dates[0]}..${dates[dates.length - 1]})`,
      args: [
        'dynamodb',
        'query',
        '--table-name',
        `${app}-usage`,
        '--index-name',
        'AnalyticsDateIndex',
        '--key-condition-expression',
        '#pk = :pk',
        '--expression-attribute-names',
        JSON.stringify({ '#pk': 'GSI1PK' }),
        '--expression-attribute-values',
        JSON.stringify({ ':pk': { S: `USAGE#${dates[0]}` } }),
        '--region',
        config.region,
        '--output',
        'json',
      ],
    },
    {
      description: `Query UsageTable ANALYTICS#YYYY-MM-DD (${dates.length} days: ${dates[0]}..${dates[dates.length - 1]})`,
      args: [
        'dynamodb',
        'query',
        '--table-name',
        `${app}-usage`,
        '--index-name',
        'AnalyticsDateIndex',
        '--key-condition-expression',
        '#pk = :pk',
        '--expression-attribute-names',
        JSON.stringify({ '#pk': 'GSI1PK' }),
        '--expression-attribute-values',
        JSON.stringify({ ':pk': { S: `ANALYTICS#${dates[0]}` } }),
        '--region',
        config.region,
        '--output',
        'json',
      ],
    },
    {
      description: 'Query UsageTable CHAT_STATUS#{active,escalated,resolved}',
      args: [
        'dynamodb',
        'query',
        '--table-name',
        `${app}-usage`,
        '--index-name',
        'AnalyticsDateIndex',
        '--key-condition-expression',
        '#pk = :pk',
        '--expression-attribute-names',
        JSON.stringify({ '#pk': 'GSI1PK' }),
        '--expression-attribute-values',
        JSON.stringify({ ':pk': { S: 'CHAT_STATUS#active' } }),
        '--region',
        config.region,
        '--output',
        'json',
      ],
    },
    {
      description: 'Scan UsageTable for BILLING# context',
      args: [
        'dynamodb',
        'scan',
        '--table-name',
        `${app}-usage`,
        '--filter-expression',
        '#et = :billing OR begins_with(requestId, :prefix)',
        '--projection-expression',
        'requestId, entityType, #st, #pl, customerId, userId',
        '--region',
        config.region,
        '--output',
        'json',
      ],
    },
    {
      description: 'Scan TemplatesTable for F3 total & 30d-active counts',
      args: [
        'dynamodb',
        'scan',
        '--table-name',
        `${app}-templates`,
        '--projection-expression',
        'PK, SK, updatedAt, createdAt',
        '--region',
        config.region,
        '--output',
        'json',
      ],
    },
    {
      description: 'Scan DocumentStoreTable for SOURCE, FILE kinds/TTL, and BATCH_JOB',
      args: [
        'dynamodb',
        'scan',
        '--table-name',
        `${app}-documents-v2`,
        '--projection-expression',
        'PK, SK, entityType, kind, objectKey, #bk, updatedAt, createdAt, expiresAt',
        '--region',
        config.region,
        '--output',
        'json',
      ],
    },
    {
      description: 'Logs Insights query for AnalyticsFunction Bedrock/chat errors',
      args: [
        'logs',
        'start-query',
        '--log-group-name',
        `/aws/lambda/${app}-analytics-node`,
        '--start-time',
        String(startTimeSec),
        '--end-time',
        String(endTimeSec),
        '--query-string',
        '<bedrock-chat-error-query>',
        '--region',
        config.region,
        '--output',
        'json',
      ],
    },
    ...COMPLIANCE_LOG_QUERIES.map((spec) => ({
      description: `Logs Insights query for ${spec.target} errors/validations`,
      args: [
        'logs',
        'start-query',
        '--log-group-name',
        `/aws/lambda/${app}-generate`,
        '--start-time',
        String(startTimeSec),
        '--end-time',
        String(endTimeSec),
        '--query-string',
        spec.query,
        '--region',
        config.region,
        '--output',
        'json',
      ],
    })),
    {
      description: 'Poll CloudWatch Logs Insights query status',
      args: ['logs', 'get-query-results', '--query-id', '<QueryId>', '--region', config.region, '--output', 'json'],
    },
    {
      description: `Download saved SOURCE JSON definitions from PdfBucket (capped at ${config.maxS3Sources})`,
      args: ['s3api', 'get-object', '--bucket', '<PdfBucket>', '--key', 'sources/<owner>/<id>/definition.json', '<tmpFile>', '--region', config.region, '--output', 'json'],
    },
  ];

  for (const cmd of commands) {
    assertAllowedAwsCommand(cmd.args);
  }
  return commands;
}

function summarizeGroupChecklist(rows) {
  const byId = new Map(rows.map((r) => [r.metric_id, r]));
  const pick = (ids) => ids.map((id) => byId.get(id)).filter(Boolean);

  const rollup = (groupRows, extraCheck) => {
    if (groupRows.some((r) => r.recommended_gate === 'HOLD')) return 'HOLD';
    if (groupRows.some((r) => r.visibility === 'N/A' || String(r.visibility).includes('UNINSTRUMENTED') || String(r.visibility).includes('PARTIAL') || String(r.visibility).includes('TRUNCATED') || r.recommended_gate === 'INSTRUMENT_FIRST')) {
      return extraCheck ? extraCheck(groupRows) : 'INSTRUMENT_FIRST';
    }
    if (groupRows.every((r) => r.recommended_gate === 'GO' || r.recommended_gate === 'INFO')) return 'GO';
    return 'INSTRUMENT_FIRST';
  };

  const f17Rows = pick(['f17_apigw_chat', 'f17_ddb_chat_sessions', 'f17_ddb_chat_messages', 'f17_logs_chat_bedrock_errors']);
  const f12Rows = pick(['f12_options_compliance', 'f13_options_signing', 'f14_options_redaction']);
  const f5Rows = pick([
    'f5_apigw_uploads_legacy',
    'f5_apigw_files_upload',
    'f7_apigw_pdf_merge_legacy',
    'f7_apigw_merge',
    'f5_ddb_files_expired_no_ttl',
  ]);
  const f3Rows = pick(['f3_ddb_templates_total', 'f3_ddb_templates_30d_active', 'f3_f4_ddb_usage_template', 'f4_ddb_sources_total', 'f3_f4_ddb_usage_stored']);
  const f18Rows = pick(['f18_page_waitlist', 'f18_page_app_debug', 'f18_page_app_stats', 'f18_page_stats', 'f18_apigw_public_stats', 'f18_apigw_admin_all']);

  return [
    {
      group: 'F17 (Support Chat /api/v1/chat)',
      verdict: rollup(f17Rows),
      action: f17Rows.some((r) => String(r.visibility).includes('UNINSTRUMENTED'))
        ? 'Enable API GW stage methodSettings["*/*"].metricsEnabled=true for /api/v1/chat edge count, and verify 30d CHAT_STATUS#* sessions.'
        : 'Confirm 30d session/message counts and API GW route volume before deprecating chat.',
    },
    {
      group: 'F12/F13/F14 (Compliance / Signing / Redaction)',
      verdict: f12Rows.some((r) => r.recommended_gate === 'HOLD') ? 'HOLD' : 'INSTRUMENT_FIRST',
      action:
        'Always PARTIAL without request-option telemetry: instrument api/api_analytics.go (or PdfFunction structured success logs) before any Phase 2 removal if saved-source/error counts are 0.',
    },
    {
      group: 'F5/F7 (Upload & Merge Routes + FILE TTL)',
      verdict: rollup(f5Rows),
      action: f5Rows.some((r) => r.metric_id === 'f5_ddb_files_expired_no_ttl' && r.recommended_gate === 'HOLD')
        ? 'Expired FILE rows present without TTL — add DynamoDB TTL on DocumentStoreTable and check API GW legacy vs canonical route counts.'
        : 'Enable API GW stage metrics if uninstrumented before removing legacy /uploads or /pdf/merge routes.',
    },
    {
      group: 'F3 vs F4 (Legacy TemplatesTable vs DocumentStore SOURCE)',
      verdict: rollup(f3Rows),
      action: 'Verify TemplatesTable 30d active count and USAGE# sourceType=template volume before retiring legacy templates.',
    },
    {
      group: 'F18 (Waitlist / Stats / Debug / Public-Stats / Admin)',
      verdict: rollup(f18Rows),
      action:
        'If CloudFront access logging or API GW stage metrics are disabled, enable them for 30d or sign off explicitly on static/client-analytics visibility limits.',
    },
  ];
}

function formatSummaryOutput(rows, checklist, outPath) {
  const cols = [
    ['metric_id', 30],
    ['linked_features', 8],
    ['total_count', 11],
    ['unique_owners', 13],
    ['error_count', 11],
    ['visibility', 36],
    ['recommended_gate', 16],
  ];
  const pad = (val, width) => {
    const s = String(val ?? '');
    return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
  };
  const lines = [];
  lines.push(`Wrote Phase 0 baseline CSV: ${outPath}`);
  lines.push('');
  lines.push(cols.map(([h, w]) => pad(h, w)).join(' | '));
  lines.push(cols.map(([, w]) => '-'.repeat(w)).join('-+-'));
  for (const row of rows) {
    lines.push(cols.map(([h, w]) => pad(row[h], w)).join(' | '));
  }
  lines.push('');
  lines.push('=== Phase 0 Sign-Off Checklist ===');
  for (const item of checklist) {
    lines.push(`- [${item.verdict}] ${item.group}: ${item.action}`);
  }
  return lines.join('\n');
}

function runAudit({ config, awsRunner, now = new Date(), sleepImpl = sleepSync, nowFn = Date.now }) {
  const resources = resolveResources(awsRunner, config);
  const dateStrings = getUtcDateStrings(config.days, now);
  const nowMs = now.getTime();
  const cutoffMs = nowMs - config.days * 86400 * 1000;
  const endTimeSec = Math.floor(nowMs / 1000);
  const startTimeSec = Math.floor(cutoffMs / 1000);
  const startIso = new Date(cutoffMs).toISOString();
  const endIso = now.toISOString();

  const rows = [
    ...collectApiGatewayMetrics(awsRunner, resources, config, startIso, endIso),
    ...collectFrontendAndCloudFront(awsRunner, resources, config, dateStrings),
    ...collectUsageAndChatAndBilling(awsRunner, resources, config, dateStrings, cutoffMs, startTimeSec, endTimeSec, {
      sleepImpl,
      nowFn,
    }),
    ...collectTemplates(awsRunner, resources, config, cutoffMs),
    ...collectDocumentStoreAndCompliance(awsRunner, resources, config, cutoffMs, nowMs, startTimeSec, endTimeSec, {
      sleepImpl,
      nowFn,
    }),
  ];

  const csv = formatCsv(rows);
  const checklist = summarizeGroupChecklist(rows);
  return { resources, rows, csv, checklist };
}

function printHelp() {
  console.log(`Usage: node scripts/preflight-usage-audit.js [options]

Strictly read-only 30-day AWS telemetry audit for Phase 0 pre-flight sign-off.

Options:
  --days <N>               Lookback window in days (default: 30)
  --stack <stack-name>     CloudFormation stack name to resolve physical IDs (optional)
  --app-name <name>        App prefix for fallback names (default: renderpdf)
  --region <region>        AWS region (default: us-east-1)
  --stage <stage>          API Gateway stage name (default: prod)
  --out <path>             Output CSV file path (default: preflight-30d-baseline.csv)
  --max-pages <N>          Pagination safety cap per DynamoDB scan/query (default: 100)
  --max-s3-sources <N>     Max saved SOURCE definitions to inspect in S3 (default: 200)
  --query-timeout-sec <N>  Timeout per CloudWatch Logs Insights query in seconds (default: 30)
  --dry-run                Print planned read-only AWS CLI commands without executing
  -h, --help               Show this help message`);
}

function main(argv = process.argv.slice(2)) {
  const config = parseArgs(argv);
  if (config.help) {
    printHelp();
    return 0;
  }

  if (config.dryRun) {
    const planned = buildPlannedCommands(config, new Date());
    console.log(`# DRY RUN — Read-only AWS CLI commands planned for ${config.days}d audit (no AWS calls made, no CSV written):`);
    for (const cmd of planned) {
      console.log(`# ${cmd.description}`);
      console.log(`aws ${cmd.args.join(' ')}`);
    }
    return 0;
  }

  const awsRunner = createAwsRunner();
  const result = runAudit({ config, awsRunner, now: new Date() });
  const outPath = path.resolve(process.cwd(), config.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, result.csv, 'utf8');
  console.log(formatSummaryOutput(result.rows, result.checklist, outPath));
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  ALLOWED_AWS_COMMANDS,
  CSV_HEADERS,
  parseArgs,
  createAwsRunner,
  assertAllowedAwsCommand,
  unmarshalAttr,
  unmarshalItem,
  parseTimestampMs,
  escapeCsvCell,
  formatCsv,
  getUtcDateStrings,
  isOptionEnabled,
  matchFrontendPath,
  resolveResources,
  buildPlannedCommands,
  runAudit,
  summarizeGroupChecklist,
  formatSummaryOutput,
};
