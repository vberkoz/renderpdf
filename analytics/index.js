'use strict';

const crypto = require('node:crypto');
let PutItemCommand;
let UpdateItemCommand;

try {
  ({
    PutItemCommand,
    UpdateItemCommand,
  } = require('@aws-sdk/client-dynamodb'));
} catch {
  PutItemCommand = class PutItemCommand {
    constructor(input) {
      this.input = input;
    }
  };
  UpdateItemCommand = class UpdateItemCommand {
    constructor(input) {
      this.input = input;
    }
  };
}
const {
  recordAdminAudit,
  listAdminAuditLogs,
} = require('./admin-audit');
const {
  findCognitoUser,
  getCognitoAttr,
  formatCognitoDate,
  getRecentRequestsForUser,
  mapRecentRequest,
  searchAdminUsers,
  readAdminUserDossier,
  handleAdminUserPlanOverride,
  handleAdminUserQuotaAdjust,
  handleAdminUserStatus,
  handleAdminKeyRevoke,
  cognito,
  apigw,
  syncUserUsagePlans,
  getBilling,
  getQuotaRecord,
  monthlyQuotaForBilling,
  planNameForTier,
  PLAN_QUOTAS,
  FREE_MONTHLY_QUOTA,
} = require('./admin-users');
const { sendPaymentFailedAlert, sendTelegramErrorAlert } = require('./notifications');
const {
  handleChatMessage,
  buildSystemPrompt,
  listAdminChats,
  getAdminChatTranscript,
  postAdminChatReply,
  updateAdminChatStatus,
} = require('./chat');
const {
  calculateAwsCost,
  calculateGrossMargin,
  calculateP95,
  calculateMedianTtfc,
  aggregateDayData,
  readAdminAnalytics,
  readAnalytics,
  isAuthorizedAdmin,
  unwrap,
  roundOneDecimal,
  parseDays,
  topRanks,
  ddb,
} = require('./admin-analytics');
const {
  readPublicStats,
  recordPublicEvent,
  publicStatsResponse,
  queryDay,
  recordEventRollup,
  EVENT_ROLLUP_TARGETS,
} = require('./public-stats');
const {
  receivePaddleWebhook,
  receiveOverageWebhook,
  receivePaymentFailedWebhook,
  createCheckout,
  openBillingPortal,
  changePlan,
  readCustomerDashboard,
  syncSubscriptionWithPaddle,
  updateQuotaOnSubscriptionChange,
  saveBillingWebhook,
  creditOverage,
  paddleRequest,
  tierFromAttributes,
  intervalFromAttributes,
  PADDLE_PRICES,
} = require('./billing');

const ANALYTICS_INDEX = 'AnalyticsDateIndex';
const ANALYTICS_TTL_DAYS = 90;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const TABLE_NAME = process.env.TABLE_NAME;
const API_KEYS_TABLE = process.env.API_KEYS_TABLE || '';
const USER_POOL_ID = process.env.USER_POOL_ID || '';
const FREE_USAGE_PLAN_ID = process.env.FREE_USAGE_PLAN_ID || '';
const STARTER_USAGE_PLAN_ID = process.env.STARTER_USAGE_PLAN_ID || '';
const PRO_USAGE_PLAN_ID = process.env.PRO_USAGE_PLAN_ID || '';
const STATS_ALLOWED_EMAIL = String(process.env.STATS_ALLOWED_EMAIL || 'vberkoz@gmail.com')
  .trim()
  .toLowerCase();
const EVENT_NAME = /^[a-zA-Z0-9._:-]{1,64}$/;

const { response, routeRequest } = require('./router');

async function handler(event) {
  try {
    return await routeRequest(event, saveAnalytics);
  } catch (err) {
    console.error('Unhandled error in analytics handler:', err);
    await sendTelegramErrorAlert({
      context: `${event?.httpMethod || 'HTTP'} ${event?.resource || event?.path || '/'}`,
      error: err,
      details: {
        sourceIp: event?.requestContext?.identity?.sourceIp,
        userId: event?.requestContext?.authorizer?.claims?.sub,
        route: event?.queryStringParameters?.route,
      },
    }).catch(() => {});
    return response(500, { error: 'Internal server error' });
  }
}

function latencyBucket(durationMs) {
  const d = Number(durationMs) || 0;
  if (d < 400) return 'under_400ms';
  if (d < 800) return '400ms_to_800ms';
  if (d < 1500) return '800ms_to_1500ms';
  return 'over_1500ms';
}

async function recordRenderRollup(status, durationMs, pdfBytes, plan, date) {
  let dateKeyStr;
  if (date instanceof Date) {
    dateKeyStr = dateKey(date);
  } else if (typeof date === 'string' && date) {
    dateKeyStr = date.length === 10 ? date : dateKey(new Date(date));
  } else {
    dateKeyStr = dateKey(new Date());
  }

  const updateInput = {
    TableName: TABLE_NAME,
    Key: { requestId: { S: `ROLLUP#${dateKeyStr}` }, timestamp: { N: '0' } },
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
      '#latBucket': latencyBucket(durationMs),
    },
    ExpressionAttributeValues: {
      ':one': { N: '1' },
      ':size': { N: String(pdfBytes || 0) },
      ':duration': { N: String(durationMs || 0) },
      ':succIncr': { N: status === 'success' ? '1' : '0' },
      ':errIncr': { N: status !== 'success' ? '1' : '0' },
    },
  };

  return ddb.send(new UpdateItemCommand(updateInput));
}

async function saveAnalytics(request) {
  let event;
  try {
    event = JSON.parse(request.body || '');
  } catch {
    return response(400, { error: 'Invalid JSON body' });
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return response(400, { error: 'Invalid JSON body' });
  }

  event.event = String(event.event || '').trim();
  if (!EVENT_NAME.test(event.event)) {
    return response(400, {
      error: 'event must be 1-64 letters, numbers, dots, colons, hyphens, or underscores',
    });
  }
  const durationMs = Number(event.durationMs || 0);
  if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 3600000) {
    return response(400, { error: 'durationMs must be between 0 and 3600000' });
  }

  const now = new Date();
  const eventId = crypto.randomBytes(16).toString('hex');
  const item = {
    requestId: { S: `ANALYTICS#${eventId}` },
    timestamp: { N: String(Math.floor(now.getTime() / 1000)) },
    entityType: { S: 'ANALYTICS' },
    eventName: { S: event.event },
    GSI1PK: { S: `ANALYTICS#${dateKey(now)}` },
    GSI1SK: { S: `${String(BigInt(now.getTime()) * 1000000n).padStart(20, '0')}#${eventId}` },
    expiresAt: { N: String(Math.floor((now.getTime() + ANALYTICS_TTL_DAYS * 86400000) / 1000)) },
  };
  if (event.path) item.path = { S: limitString(String(event.path), 256) };
  if (event.source) item.source = { S: limitString(String(event.source), 128) };
  if (event.status) item.status = { S: limitString(String(event.status), 64) };
  if (durationMs > 0) item.durationMs = { N: String(Math.trunc(durationMs)) };

  try {
    await ddb.send(new PutItemCommand({ TableName: TABLE_NAME, Item: item }));
    if (EVENT_ROLLUP_TARGETS[event.event]) {
      await recordEventRollup(event.event, now);
    }
  } catch (err) {
    console.error('Could not save analytics event', err);
    return response(500, { error: 'Could not save analytics event' });
  }
  return response(202, { id: eventId });
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function limitString(value, max) {
  return value.length <= max ? value : value.slice(0, max);
}

exports.handler = handler;
exports.saveBillingWebhook = saveBillingWebhook;
exports.updateQuotaOnSubscriptionChange = updateQuotaOnSubscriptionChange;
exports.monthlyQuotaForBilling = monthlyQuotaForBilling;
exports.tierFromAttributes = tierFromAttributes;
exports.intervalFromAttributes = intervalFromAttributes;
exports.planNameForTier = planNameForTier;
exports.syncSubscriptionWithPaddle = syncSubscriptionWithPaddle;
exports.changePlan = changePlan;
exports.receiveOverageWebhook = receiveOverageWebhook;
exports.creditOverage = creditOverage;
exports.createCheckout = createCheckout;
exports.openBillingPortal = openBillingPortal;
exports.readCustomerDashboard = readCustomerDashboard;
exports.paddleRequest = paddleRequest;
exports.receivePaymentFailedWebhook = receivePaymentFailedWebhook;
exports.sendPaymentFailedAlert = sendPaymentFailedAlert;
exports.syncUserUsagePlans = syncUserUsagePlans;
exports.ddb = ddb;
exports.apigw = apigw;
exports.PADDLE_PRICES = PADDLE_PRICES;
exports.latencyBucket = latencyBucket;
exports.recordRenderRollup = recordRenderRollup;
exports.recordEventRollup = recordEventRollup;
exports.saveAnalytics = saveAnalytics;
exports.EVENT_ROLLUP_TARGETS = EVENT_ROLLUP_TARGETS;
exports.readAdminAnalytics = readAdminAnalytics;
exports.readAnalytics = readAnalytics;
exports.calculateAwsCost = calculateAwsCost;
exports.calculateGrossMargin = calculateGrossMargin;
exports.calculateP95 = calculateP95;
exports.calculateMedianTtfc = calculateMedianTtfc;
exports.isAuthorizedAdmin = isAuthorizedAdmin;
exports.aggregateDayData = aggregateDayData;
exports.unwrap = unwrap;
exports.roundOneDecimal = roundOneDecimal;
exports.parseDays = parseDays;
exports.topRanks = topRanks;
exports.recordPublicEvent = recordPublicEvent;
exports.readPublicStats = readPublicStats;
exports.publicStatsResponse = publicStatsResponse;
exports.queryDay = queryDay;
exports.dateKey = dateKey;
exports.cognito = cognito;
exports.searchAdminUsers = searchAdminUsers;
exports.readAdminUserDossier = readAdminUserDossier;
exports.getCognitoAttr = getCognitoAttr;
exports.getRecentRequestsForUser = getRecentRequestsForUser;
exports.findCognitoUser = findCognitoUser;
exports.handleAdminUserPlanOverride = handleAdminUserPlanOverride;
exports.handleAdminUserQuotaAdjust = handleAdminUserQuotaAdjust;
exports.recordAdminAudit = recordAdminAudit;
exports.handleAdminUserStatus = handleAdminUserStatus;
exports.handleAdminKeyRevoke = handleAdminKeyRevoke;
exports.listAdminAuditLogs = listAdminAuditLogs;
exports.handleChatMessage = handleChatMessage;
exports.buildSystemPrompt = buildSystemPrompt;
exports.listAdminChats = listAdminChats;
exports.getAdminChatTranscript = getAdminChatTranscript;
exports.postAdminChatReply = postAdminChatReply;
exports.updateAdminChatStatus = updateAdminChatStatus;

