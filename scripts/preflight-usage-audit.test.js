'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ALLOWED_AWS_COMMANDS,
  CSV_HEADERS,
  parseArgs,
  createAwsRunner,
  escapeCsvCell,
  formatCsv,
  buildPlannedCommands,
  runAudit,
  matchFrontendPath,
  isOptionEnabled,
} = require('./preflight-usage-audit');

const SCRIPT_PATH = path.resolve(__dirname, 'preflight-usage-audit.js');
const FIXED_NOW = new Date('2026-11-19T12:00:00.000Z');
const RECENT_ISO = '2026-11-15T10:00:00.000Z';
const OLD_ISO = '2026-09-01T10:00:00.000Z';

function baseConfig(overrides = {}) {
  return {
    days: 30,
    stack: 'renderpdf-prod',
    appName: 'renderpdf',
    region: 'us-east-1',
    stage: 'prod',
    out: 'preflight-30d-baseline.csv',
    maxPages: 100,
    maxS3Sources: 200,
    queryTimeoutSec: 30,
    dryRun: false,
    help: false,
    ...overrides,
  };
}

function getArgValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function createMockAwsRunner(handlers = {}) {
  const calls = [];
  const runner = (args) => {
    const key = `${args[0]}:${args[1]}`;
    if (!ALLOWED_AWS_COMMANDS.has(key)) {
      throw new Error(`Disallowed AWS CLI command in test: ${key}`);
    }
    calls.push(args);

    if (typeof handlers.custom === 'function') {
      const handled = handlers.custom(args, key);
      if (handled !== undefined) return handled;
    }

    if (key === 'cloudformation:describe-stack-resources') {
      return handlers.describeStackResources
        ? handlers.describeStackResources(args)
        : {
            ok: true,
            stdout: JSON.stringify({
              StackResources: [
                { LogicalResourceId: 'RestApi', PhysicalResourceId: 'abc123api' },
                { LogicalResourceId: 'CloudFrontDistribution', PhysicalResourceId: 'E123CFDIST' },
                { LogicalResourceId: 'PdfBucket', PhysicalResourceId: 'renderpdf-pdfs-123456' },
                { LogicalResourceId: 'UsageTable', PhysicalResourceId: 'renderpdf-usage' },
                { LogicalResourceId: 'TemplatesTable', PhysicalResourceId: 'renderpdf-templates' },
                { LogicalResourceId: 'DocumentStoreTable', PhysicalResourceId: 'renderpdf-documents-v2' },
                { LogicalResourceId: 'PdfFunction', PhysicalResourceId: 'renderpdf-generate' },
                { LogicalResourceId: 'AnalyticsFunction', PhysicalResourceId: 'renderpdf-analytics-node' },
              ],
            }),
          };
    }

    if (key === 'cloudformation:describe-stacks') {
      return handlers.describeStacks
        ? handlers.describeStacks(args)
        : {
            ok: true,
            stdout: JSON.stringify({
              Stacks: [{ StackName: 'renderpdf-prod', Outputs: [] }],
            }),
          };
    }

    if (key === 'apigateway:get-stage') {
      return handlers.getStage
        ? handlers.getStage(args)
        : {
            ok: true,
            stdout: JSON.stringify({
              stageName: 'prod',
              methodSettings: { '*/*': { metricsEnabled: false } },
            }),
          };
    }

    if (key === 'cloudwatch:get-metric-data') {
      return handlers.getMetricData
        ? handlers.getMetricData(args)
        : { ok: true, stdout: JSON.stringify({ MetricDataResults: [] }) };
    }

    if (key === 'cloudfront:get-distribution-config') {
      return handlers.getDistributionConfig
        ? handlers.getDistributionConfig(args)
        : {
            ok: true,
            stdout: JSON.stringify({
              DistributionConfig: { Logging: { Enabled: false, Bucket: '', Prefix: '' } },
            }),
          };
    }

    if (key === 'dynamodb:query') {
      return handlers.ddbQuery ? handlers.ddbQuery(args) : { ok: true, stdout: JSON.stringify({ Items: [] }) };
    }

    if (key === 'dynamodb:scan') {
      return handlers.ddbScan ? handlers.ddbScan(args) : { ok: true, stdout: JSON.stringify({ Items: [] }) };
    }

    if (key === 'logs:start-query') {
      return handlers.logsStartQuery
        ? handlers.logsStartQuery(args)
        : { ok: true, stdout: JSON.stringify({ queryId: 'q-default' }) };
    }

    if (key === 'logs:get-query-results') {
      return handlers.logsGetQueryResults
        ? handlers.logsGetQueryResults(args)
        : { ok: true, stdout: JSON.stringify({ status: 'Complete', results: [] }) };
    }

    if (key === 's3api:get-object') {
      return handlers.s3GetObject ? handlers.s3GetObject(args) : { ok: true, stdout: '{}', body: '{}' };
    }

    return { ok: false, error: `Unhandled mock command: ${key}`, isAuthError: false, isNotFound: false };
  };

  return { runner, calls };
}

test('CSV formatting & RFC-4180 escaping', () => {
  assert.equal(
    CSV_HEADERS.join(','),
    'metric_id,linked_features,source_system,target,window_days,total_count,unique_owners,error_count,visibility,recommended_gate,notes'
  );

  assert.equal(escapeCsvCell(null), '');
  assert.equal(escapeCsvCell(undefined), '');
  assert.equal(escapeCsvCell(42), '42');
  assert.equal(escapeCsvCell('plain'), 'plain');
  assert.equal(escapeCsvCell('a,b'), '"a,b"');
  assert.equal(escapeCsvCell('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(escapeCsvCell('line1\r\nline2'), '"line1\r\nline2"');

  const csv = formatCsv([
    {
      metric_id: 'm1',
      linked_features: 'F12,F13',
      source_system: 'S3',
      target: 'options.compliance',
      window_days: 30,
      total_count: 3,
      unique_owners: 2,
      error_count: 1,
      visibility: 'PARTIAL_ERRORS_AND_SAVED_SOURCES_ONLY',
      recommended_gate: 'HOLD',
      notes: 'Note with "quotes",\nand newline',
    },
  ]);

  const lines = csv.trimEnd().split('\n');
  assert.equal(lines[0], CSV_HEADERS.join(','));
  assert.ok(csv.includes('"F12,F13"'));
  assert.ok(csv.includes('"Note with ""quotes"",\nand newline"'));
});

test('Read-only AWS CLI runner blocks mutating commands before calling execFileSync', () => {
  let invoked = 0;
  const runner = createAwsRunner({
    execFileSyncImpl: () => {
      invoked += 1;
      return '{}';
    },
  });

  for (const badArgs of [
    ['dynamodb', 'put-item', '--table-name', 'renderpdf-usage'],
    ['apigateway', 'update-stage', '--rest-api-id', 'abc'],
    ['s3api', 'put-object', '--bucket', 'b', '--key', 'k'],
    ['logs', 'delete-log-group', '--log-group-name', '/aws/lambda/foo'],
  ]) {
    assert.throws(() => runner(badArgs), /Blocked non-read-only or disallowed AWS CLI command/);
  }
  assert.equal(invoked, 0);
});

test('Path matching & option checks isolate /app/stats from /stats/ and ignore disabled options', () => {
  assert.deepEqual(matchFrontendPath({ path: '/waitlist/' }), ['f18_page_waitlist']);
  assert.deepEqual(matchFrontendPath({ path: '/app/debug?foo=1' }), ['f18_page_app_debug']);
  assert.deepEqual(matchFrontendPath({ metadata: JSON.stringify({ url: 'https://renderpdf.example/app/stats' }) }), [
    'f18_page_app_stats',
  ]);
  assert.deepEqual(matchFrontendPath({ metadata: { pathname: '/stats/' } }), ['f18_page_stats']);
  assert.deepEqual(matchFrontendPath({ path: '/app/stats/index.html' }), ['f18_page_app_stats']);

  assert.equal(isOptionEnabled(undefined), false);
  assert.equal(isOptionEnabled(null), false);
  assert.equal(isOptionEnabled(false), false);
  assert.equal(isOptionEnabled({}), false);
  assert.equal(isOptionEnabled({ enabled: false }), false);
  assert.equal(isOptionEnabled({ enabled: true, standard: 'PDF/A-1b' }), true);
  assert.equal(isOptionEnabled(true), true);
});

test('Full offline aggregation: UsageTable, CHAT_STATUS#, Templates vs Sources, FILE kinds/TTL, S3 SOURCE options, Logs Insights polling, and truncation', () => {
  const logPollCounts = new Map();
  let querySeq = 0;

  const { runner } = createMockAwsRunner({
    ddbQuery: (args) => {
      const attrVals = JSON.parse(getArgValue(args, '--expression-attribute-values'));
      const pk = attrVals[':pk'].S;
      const startKeyRaw = getArgValue(args, '--exclusive-start-key');

      if (pk === 'USAGE#2026-11-19') {
        return {
          ok: true,
          stdout: JSON.stringify({
            Items: [
              {
                entityType: { S: 'PDF_REQUEST' },
                sourceType: { S: 'template' },
                sourceMode: { S: 'handlebars' },
                plan: { S: 'starter' },
                status: { S: 'success' },
                customerId: { S: 'cust-1' },
              },
              {
                entityType: { S: 'PDF_REQUEST' },
                sourceType: { S: 'template' },
                sourceMode: { S: 'handlebars' },
                plan: { S: 'pro' },
                status: { S: 'error' },
                errorType: { S: 'render_timeout' },
                customerId: { S: 'cust-2' },
              },
              {
                entityType: { S: 'PDF_REQUEST' },
                sourceType: { S: 'stored' },
                sourceMode: { S: 'html' },
                plan: { S: 'pro' },
                status: { S: 'success' },
                customerId: { S: 'cust-1' },
              },
              {
                entityType: { S: 'PDF_REQUEST' },
                sourceType: { S: 'html' },
                sourceMode: { S: 'inline' },
                plan: { S: 'free' },
                status: { S: 'success' },
                customerId: { S: 'cust-3' },
              },
            ],
          }),
        };
      }

      if (pk === 'CHAT_STATUS#active') {
        return {
          ok: true,
          stdout: JSON.stringify({
            Items: [
              {
                entityType: { S: 'CHAT_SESSION' },
                updatedAt: { S: RECENT_ISO },
                messageCount: { N: '4' },
                customerId: { S: 'cust-1' },
              },
              {
                entityType: { S: 'CHAT_SESSION' },
                updatedAt: { S: OLD_ISO },
                messageCount: { N: '99' },
                customerId: { S: 'cust-old' },
              },
            ],
          }),
        };
      }

      if (pk === 'CHAT_STATUS#escalated') {
        return {
          ok: true,
          stdout: JSON.stringify({
            Items: [
              {
                entityType: { S: 'CHAT_SESSION' },
                createdAt: { N: String(Math.floor(Date.parse(RECENT_ISO) / 1000)) },
                messageCount: { N: '6' },
                customerId: { S: 'cust-2' },
              },
            ],
          }),
        };
      }

      if (pk === 'CHAT_STATUS#resolved') {
        return {
          ok: true,
          stdout: JSON.stringify({
            Items: [
              {
                entityType: { S: 'CHAT_SESSION' },
                updatedAt: { S: RECENT_ISO },
                messageCount: { N: '2' },
                customerId: { S: 'cust-1' },
              },
            ],
          }),
        };
      }

      if (pk === 'ANALYTICS#2026-11-18') {
        return {
          ok: true,
          stdout: JSON.stringify({
            Items: [
              {
                entityType: { S: 'ANALYTICS' },
                eventName: { S: 'page_viewed' },
                metadata: { M: { path: { S: '/waitlist/' } } },
                visitorId: { S: 'vis-1' },
              },
              {
                entityType: { S: 'ANALYTICS' },
                eventName: { S: 'page_viewed' },
                path: { S: '/app/stats' },
                customerId: { S: 'cust-1' },
              },
            ],
          }),
        };
      }

      // Pagination test on ANALYTICS#2026-11-19
      if (pk === 'ANALYTICS#2026-11-19') {
        if (!startKeyRaw) {
          return {
            ok: true,
            stdout: JSON.stringify({
              Items: [
                {
                  entityType: { S: 'ANALYTICS' },
                  eventName: { S: 'page_viewed' },
                  path: { S: '/stats/' },
                  visitorId: { S: 'vis-2' },
                },
              ],
              LastEvaluatedKey: { GSI1PK: { S: 'ANALYTICS#2026-11-19' } },
            }),
          };
        }
        return {
          ok: true,
          stdout: JSON.stringify({
            Items: [
              {
                entityType: { S: 'ANALYTICS' },
                eventName: { S: 'button_clicked' },
                path: { S: '/waitlist/' },
                visitorId: { S: 'vis-1' },
              },
            ],
          }),
        };
      }

      return { ok: true, stdout: JSON.stringify({ Items: [] }) };
    },
    ddbScan: (args) => {
      const table = getArgValue(args, '--table-name');
      if (table === 'renderpdf-usage') {
        return {
          ok: true,
          stdout: JSON.stringify({
            Items: [
              { requestId: { S: 'BILLING#cust-1' }, entityType: { S: 'BILLING' }, status: { S: 'active' }, plan: { S: 'pro' }, customerId: { S: 'cust-1' } },
              { requestId: { S: 'BILLING#cust-2' }, entityType: { S: 'BILLING' }, status: { S: 'trialing' }, plan: { S: 'starter' }, customerId: { S: 'cust-2' } },
              { requestId: { S: 'BILLING#cust-3' }, entityType: { S: 'BILLING' }, status: { S: 'canceled' }, plan: { S: 'starter' }, customerId: { S: 'cust-3' } },
            ],
          }),
        };
      }
      if (table === 'renderpdf-templates') {
        return {
          ok: true,
          stdout: JSON.stringify({
            Items: [
              { PK: { S: 'owner-1' }, SK: { S: 'tpl-1' }, updatedAt: { S: RECENT_ISO } },
              { PK: { S: 'owner-1' }, SK: { S: 'tpl-2' }, updatedAt: { S: OLD_ISO } },
              { PK: { S: 'owner-2' }, SK: { S: 'tpl-3' }, createdAt: { S: RECENT_ISO } },
            ],
          }),
        };
      }
      if (table === 'renderpdf-documents-v2') {
        return {
          ok: true,
          stdout: JSON.stringify({
            Items: [
              {
                PK: { S: 'owner-1' },
                SK: { S: 'SRC#1' },
                entityType: { S: 'SOURCE' },
                objectKey: { S: 'sources/owner-1/src-1/definition.json' },
                updatedAt: { S: RECENT_ISO },
              },
              {
                PK: { S: 'owner-2' },
                SK: { S: 'SRC#2' },
                entityType: { S: 'SOURCE' },
                objectKey: { S: 'sources/owner-2/src-2/definition.json' },
                createdAt: { S: OLD_ISO },
              },
              {
                PK: { S: 'owner-1' },
                SK: { S: 'FILE#1' },
                entityType: { S: 'FILE' },
                kind: { S: 'rendered_pdf' },
                createdAt: { S: RECENT_ISO },
                expiresAt: { N: String(Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000)) },
              },
              {
                PK: { S: 'owner-1' },
                SK: { S: 'FILE#2' },
                entityType: { S: 'FILE' },
                kind: { S: 'merged_pdf' },
                createdAt: { S: OLD_ISO },
                expiresAt: { N: String(Math.floor(Date.parse('2026-10-01T00:00:00Z') / 1000)) },
              },
              {
                PK: { S: 'owner-2' },
                SK: { S: 'FILE#3' },
                entityType: { S: 'FILE' },
                kind: { S: 'uploaded_package' },
                createdAt: { S: RECENT_ISO },
                expiresAt: { N: String(Math.floor(Date.parse('2026-11-01T00:00:00Z') / 1000)) },
              },
              {
                PK: { S: 'owner-1' },
                SK: { S: 'BATCH#1' },
                entityType: { S: 'BATCH_JOB' },
                createdAt: { S: RECENT_ISO },
              },
            ],
          }),
        };
      }
      return { ok: true, stdout: JSON.stringify({ Items: [] }) };
    },
    logsStartQuery: (args) => {
      querySeq += 1;
      const query = getArgValue(args, '--query-string');
      const id = `q-${querySeq}`;
      logPollCounts.set(id, { polls: 0, query });
      return { ok: true, stdout: JSON.stringify({ queryId: id }) };
    },
    logsGetQueryResults: (args) => {
      const id = getArgValue(args, '--query-id');
      const state = logPollCounts.get(id);
      state.polls += 1;
      if (state.polls === 1) {
        return { ok: true, stdout: JSON.stringify({ status: 'Running', results: [] }) };
      }
      let matchCount = '0';
      if (state.query.includes('compliance')) matchCount = '3';
      else if (state.query.includes('bedrock')) matchCount = '2';
      return {
        ok: true,
        stdout: JSON.stringify({
          status: 'Complete',
          results: [[{ field: 'matchCount', value: matchCount }]],
        }),
      };
    },
    s3GetObject: (args) => {
      const key = getArgValue(args, '--key');
      if (key.includes('src-1')) {
        return {
          ok: true,
          body: JSON.stringify({
            options: {
              compliance: { enabled: true, standard: 'PDF/A-2b' },
              signing: { enabled: false },
            },
          }),
        };
      }
      return {
        ok: true,
        body: JSON.stringify({
          options: {
            signing: { certificateId: 'kms-key-1' },
            redaction: {},
          },
        }),
      };
    },
  });

  const result = runAudit({
    config: baseConfig(),
    awsRunner: runner,
    now: FIXED_NOW,
    sleepImpl: () => {},
  });

  const byId = new Map(result.rows.map((r) => [r.metric_id, r]));

  // Usage sourceTypes
  assert.equal(byId.get('f3_f4_ddb_usage_template').total_count, 2);
  assert.equal(byId.get('f3_f4_ddb_usage_template').unique_owners, 2);
  assert.equal(byId.get('f3_f4_ddb_usage_template').error_count, 1);
  assert.equal(byId.get('f3_f4_ddb_usage_template').recommended_gate, 'HOLD');
  assert.equal(byId.get('f3_f4_ddb_usage_stored').total_count, 1);
  assert.equal(byId.get('f3_f4_ddb_usage_html').total_count, 1);
  assert.equal(byId.get('f3_f4_ddb_usage_markdown').total_count, 0);

  // Chat sessions & messages (excluding OLD_ISO)
  assert.equal(byId.get('f17_ddb_chat_sessions').total_count, 3);
  assert.equal(byId.get('f17_ddb_chat_sessions').unique_owners, 2);
  assert.equal(byId.get('f17_ddb_chat_messages').total_count, 12);
  assert.equal(byId.get('f17_logs_chat_bedrock_errors').error_count, 2);

  // Billing context
  assert.equal(byId.get('context_ddb_billing_accounts').total_count, 2);
  assert.equal(byId.get('context_ddb_billing_accounts').unique_owners, 2);

  // Templates vs Sources
  assert.equal(byId.get('f3_ddb_templates_total').total_count, 3);
  assert.equal(byId.get('f3_ddb_templates_total').unique_owners, 2);
  assert.equal(byId.get('f3_ddb_templates_30d_active').total_count, 2);
  assert.equal(byId.get('f3_ddb_templates_30d_active').unique_owners, 2);

  assert.equal(byId.get('f4_ddb_sources_total').total_count, 2);
  assert.equal(byId.get('f4_ddb_sources_30d_active').total_count, 1);

  // DocumentStore FILE kinds & expired TTL check
  assert.equal(byId.get('f5_ddb_files_kind_rendered_pdf').total_count, 1);
  assert.equal(byId.get('f5_ddb_files_kind_merged_pdf').total_count, 1);
  assert.equal(byId.get('f5_ddb_files_kind_uploaded_package').total_count, 1);
  assert.equal(byId.get('f5_ddb_files_kind_batch_zip').total_count, 0);
  assert.equal(byId.get('f5_ddb_files_expired_no_ttl').total_count, 2);
  assert.equal(byId.get('f5_ddb_files_expired_no_ttl').recommended_gate, 'HOLD');
  assert.equal(byId.get('context_ddb_batch_jobs').total_count, 1);

  // F12/F13/F14 compliance/signing/redaction blind-spot visibility + gates
  const f12 = byId.get('f12_options_compliance');
  assert.equal(f12.total_count, 1);
  assert.equal(f12.error_count, 3);
  assert.equal(f12.visibility, 'PARTIAL_ERRORS_AND_SAVED_SOURCES_ONLY');
  assert.equal(f12.recommended_gate, 'HOLD');

  const f13 = byId.get('f13_options_signing');
  assert.equal(f13.total_count, 1);
  assert.equal(f13.error_count, 0);
  assert.equal(f13.visibility, 'PARTIAL_ERRORS_AND_SAVED_SOURCES_ONLY');
  assert.equal(f13.recommended_gate, 'HOLD');

  const f14 = byId.get('f14_options_redaction');
  assert.equal(f14.total_count, 0);
  assert.equal(f14.error_count, 0);
  assert.equal(f14.visibility, 'PARTIAL_ERRORS_AND_SAVED_SOURCES_ONLY');
  assert.equal(f14.recommended_gate, 'INSTRUMENT_FIRST');

  // Frontend ANALYTICS# checks & CloudFront blind spot
  assert.equal(byId.get('f18_page_waitlist').total_count, 2);
  assert.equal(byId.get('f18_page_waitlist').unique_owners, 1);
  assert.equal(byId.get('f18_page_waitlist').visibility, 'UNINSTRUMENTED_NO_CF_LOGS');
  assert.equal(byId.get('f18_page_app_stats').total_count, 1);
  assert.equal(byId.get('f18_page_stats').total_count, 1);
});

test('Pagination safety cap (--max-pages 1) sets TRUNCATED in visibility', () => {
  const { runner } = createMockAwsRunner({
    ddbScan: (args) => {
      const table = getArgValue(args, '--table-name');
      if (table === 'renderpdf-templates') {
        return {
          ok: true,
          stdout: JSON.stringify({
            Items: [{ PK: { S: 'owner-1' }, SK: { S: 'tpl-1' }, updatedAt: { S: RECENT_ISO } }],
            LastEvaluatedKey: { PK: { S: 'owner-1' }, SK: { S: 'tpl-1' } },
          }),
        };
      }
      return { ok: true, stdout: JSON.stringify({ Items: [] }) };
    },
  });

  const result = runAudit({
    config: baseConfig({ maxPages: 1 }),
    awsRunner: runner,
    now: FIXED_NOW,
    sleepImpl: () => {},
  });

  const byId = new Map(result.rows.map((r) => [r.metric_id, r]));
  assert.equal(byId.get('f3_ddb_templates_total').visibility, 'FULL|TRUNCATED');
  assert.equal(byId.get('f3_ddb_templates_total').recommended_gate, 'INSTRUMENT_FIRST');
});

test('Blind-spot labeling: API GW metricsEnabled=false skips get-metric-data; metricsEnabled=true aggregates routes including /admin/*', () => {
  // Case A: metricsEnabled = false
  const disabledMock = createMockAwsRunner({
    getStage: () => ({
      ok: true,
      stdout: JSON.stringify({
        stageName: 'prod',
        methodSettings: { '*/*': { metricsEnabled: false } },
      }),
    }),
  });

  const resDisabled = runAudit({
    config: baseConfig(),
    awsRunner: disabledMock.runner,
    now: FIXED_NOW,
    sleepImpl: () => {},
  });

  assert.equal(
    disabledMock.calls.some((c) => c[0] === 'cloudwatch' && c[1] === 'get-metric-data'),
    false
  );
  const byIdDisabled = new Map(resDisabled.rows.map((r) => [r.metric_id, r]));
  assert.equal(byIdDisabled.get('f17_apigw_chat').visibility, 'UNINSTRUMENTED_ENABLE_STAGE_METRICS');
  assert.equal(byIdDisabled.get('f17_apigw_chat').total_count, 'N/A');
  assert.equal(byIdDisabled.get('f17_apigw_chat').recommended_gate, 'INSTRUMENT_FIRST');
  assert.equal(byIdDisabled.get('f18_apigw_admin_all').visibility, 'UNINSTRUMENTED_ENABLE_STAGE_METRICS');

  // Case B: metricsEnabled = true
  const enabledMock = createMockAwsRunner({
    getStage: () => ({
      ok: true,
      stdout: JSON.stringify({
        stageName: 'prod',
        methodSettings: { '*/*': { metricsEnabled: true } },
      }),
    }),
    getMetricData: (args) => {
      const queries = JSON.parse(getArgValue(args, '--metric-data-queries'));
      const results = queries.map((q) => {
        const dims = Object.fromEntries(q.MetricStat.Metric.Dimensions.map((d) => [d.Name, d.Value]));
        let val = 0;
        if (dims.Resource === '/api/v1/uploads' && q.MetricStat.Metric.MetricName === 'Count') val = 5;
        if (dims.Resource === '/api/v1/uploads' && q.MetricStat.Metric.MetricName === '4XXError') val = 1;
        if (dims.Resource.startsWith('/api/v1/admin/') && q.MetricStat.Metric.MetricName === 'Count') val = 2;
        return { Id: q.Id, Values: [val] };
      });
      return { ok: true, stdout: JSON.stringify({ MetricDataResults: results }) };
    },
  });

  const resEnabled = runAudit({
    config: baseConfig(),
    awsRunner: enabledMock.runner,
    now: FIXED_NOW,
    sleepImpl: () => {},
  });

  assert.equal(
    enabledMock.calls.some((c) => c[0] === 'cloudwatch' && c[1] === 'get-metric-data'),
    true
  );
  const byIdEnabled = new Map(resEnabled.rows.map((r) => [r.metric_id, r]));
  assert.equal(byIdEnabled.get('f5_apigw_uploads_legacy').visibility, 'FULL');
  assert.equal(byIdEnabled.get('f5_apigw_uploads_legacy').total_count, 5);
  assert.equal(byIdEnabled.get('f5_apigw_uploads_legacy').error_count, 1);
  assert.equal(byIdEnabled.get('f5_apigw_uploads_legacy').recommended_gate, 'HOLD');

  assert.equal(byIdEnabled.get('f17_apigw_chat').total_count, 0);
  assert.equal(byIdEnabled.get('f17_apigw_chat').recommended_gate, 'GO');

  // 5 admin routes * 2 each = 10
  assert.equal(byIdEnabled.get('f18_apigw_admin_all').total_count, 10);
});

test('Missing AWS credentials never fabricate zeros and mark N/A cleanly', () => {
  const { runner } = createMockAwsRunner({
    custom: () => ({
      ok: false,
      error: 'Unable to locate credentials. You can configure credentials by running "aws configure".',
      stderr: 'Unable to locate credentials.',
      code: 253,
      isAuthError: true,
      isNotFound: false,
    }),
  });

  const result = runAudit({
    config: baseConfig(),
    awsRunner: runner,
    now: FIXED_NOW,
    sleepImpl: () => {},
  });

  assert.ok(result.rows.length > 0);
  for (const row of result.rows) {
    assert.equal(row.total_count, 'N/A', `${row.metric_id} should report N/A for total_count`);
    assert.equal(row.visibility, 'N/A', `${row.metric_id} should report N/A for visibility`);
    assert.ok(row.notes.includes('Unable to locate credentials'), `${row.metric_id} should preserve error context`);
  }
});

test('--dry-run lists only read-only AWS commands, makes zero AWS calls, and writes no CSV file', () => {
  const cfg = parseArgs(['--days', '14', '--stack', 'my-stack', '--dry-run']);
  assert.equal(cfg.days, 14);
  assert.equal(cfg.stack, 'my-stack');
  assert.equal(cfg.dryRun, true);

  const planned = buildPlannedCommands(cfg, FIXED_NOW);
  assert.ok(planned.length >= 10);
  for (const cmd of planned) {
    assert.ok(ALLOWED_AWS_COMMANDS.has(`${cmd.args[0]}:${cmd.args[1]}`));
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'renderpdf-dryrun-test-'));
  const outCsv = path.join(tmpDir, 'should-not-exist.csv');
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT_PATH, '--dry-run', '--out', outCsv], {
      encoding: 'utf8',
    });
    assert.ok(stdout.includes('DRY RUN'));
    assert.ok(stdout.includes('aws cloudformation describe-stack-resources'));
    assert.equal(fs.existsSync(outCsv), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Large stack (>100 resources): targeted describe-stack-resources resolves omitted RestApi and calls apigateway get-stage', () => {
  const { runner, calls } = createMockAwsRunner({
    describeStackResources: (args) => {
      const logicalId = getArgValue(args, '--logical-resource-id');
      if (logicalId === 'RestApi') {
        return {
          ok: true,
          stdout: JSON.stringify({
            StackResources: [{ LogicalResourceId: 'RestApi', PhysicalResourceId: 'rest999api' }],
          }),
        };
      }
      // Stack-wide response omits RestApi (simulating CFN's 100-resource cap)
      return {
        ok: true,
        stdout: JSON.stringify({
          StackResources: [
            { LogicalResourceId: 'CloudFrontDistribution', PhysicalResourceId: 'E123CFDIST' },
            { LogicalResourceId: 'PdfBucket', PhysicalResourceId: 'renderpdf-pdfs-123456' },
            { LogicalResourceId: 'UsageTable', PhysicalResourceId: 'renderpdf-usage' },
            { LogicalResourceId: 'TemplatesTable', PhysicalResourceId: 'renderpdf-templates' },
            { LogicalResourceId: 'DocumentStoreTable', PhysicalResourceId: 'renderpdf-documents-v2' },
          ],
        }),
      };
    },
    getStage: (args) => {
      assert.equal(getArgValue(args, '--rest-api-id'), 'rest999api');
      return {
        ok: true,
        stdout: JSON.stringify({
          stageName: 'prod',
          methodSettings: { '*/*': { metricsEnabled: false } },
        }),
      };
    },
  });

  const result = runAudit({
    config: baseConfig(),
    awsRunner: runner,
    now: FIXED_NOW,
    sleepImpl: () => {},
  });

  assert.equal(result.resources.restApiId, 'rest999api');
  assert.equal(
    calls.some(
      (c) =>
        c[0] === 'cloudformation' &&
        c[1] === 'describe-stack-resources' &&
        getArgValue(c, '--logical-resource-id') === 'RestApi'
    ),
    true
  );
  assert.equal(
    calls.some((c) => c[0] === 'apigateway' && c[1] === 'get-stage' && getArgValue(c, '--rest-api-id') === 'rest999api'),
    true
  );
  const byId = new Map(result.rows.map((r) => [r.metric_id, r]));
  assert.ok(byId.get('f17_apigw_chat').notes.includes('restApiId=rest999api'));
});
