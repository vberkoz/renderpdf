'use strict';

const crypto = require('node:crypto');
const {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} = require('@aws-sdk/client-dynamodb');
const { sendOperatorChatReply } = require('./notifications');

function isAuthorizedAdmin(request) {
  const claims = request?.requestContext?.authorizer?.claims;
  if (!claims) return false;

  const groups = claims['cognito:groups'];
  if (Array.isArray(groups) && groups.includes('Admins')) return true;
  if (typeof groups === 'string') {
    const list = groups
      .replace(/[\[\]"']/g, '')
      .split(',')
      .map((s) => s.trim());
    if (list.includes('Admins')) return true;
  }

  const email = String(claims.email || '')
    .trim()
    .toLowerCase();
  const allowedEmail = String(process.env.STATS_ALLOWED_EMAIL || 'vberkoz@gmail.com')
    .trim()
    .toLowerCase();
  if (email && allowedEmail && email === allowedEmail) return true;

  return false;
}

function createChatAdminHandlers({
  getTableName,
  getDdbClient,
  unmarshalSession,
  unmarshalMessage,
  chatResponse,
  CHAT_TTL_SECONDS,
}) {
  async function listAdminChats(event) {
    if (!isAuthorizedAdmin(event)) {
      return chatResponse(403, { error: 'Forbidden' }, 'admin');
    }

    const qs = event?.queryStringParameters || {};
    const statusParam = String(qs.status || 'all')
      .toLowerCase()
      .trim();
    const limitParam = Math.min(Math.max(Number.parseInt(qs.limit, 10) || 50, 1), 100);

    const ddb = getDdbClient();
    const tableName = getTableName();

    if (!tableName) {
      return chatResponse(200, { chats: [], nextCursor: null }, 'admin');
    }

    try {
      let items = [];
      const validStatuses = ['escalated', 'active', 'resolved'];

      if (statusParam === 'all') {
        const queries = validStatuses.map((st) =>
          ddb
            .send(
              new QueryCommand({
                TableName: tableName,
                IndexName: 'AnalyticsDateIndex',
                KeyConditionExpression: 'GSI1PK = :pk',
                ExpressionAttributeValues: {
                  ':pk': { S: `CHAT_STATUS#${st}` },
                },
                ScanIndexForward: false,
                Limit: limitParam,
              })
            )
            .catch((err) => {
              console.warn(`Failed to query chats for status ${st}:`, err);
              return { Items: [] };
            })
        );

        const results = await Promise.all(queries);
        for (const res of results) {
          if (Array.isArray(res?.Items)) {
            items.push(...res.Items);
          }
        }
      } else if (validStatuses.includes(statusParam)) {
        const res = await ddb.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: 'AnalyticsDateIndex',
            KeyConditionExpression: 'GSI1PK = :pk',
            ExpressionAttributeValues: {
              ':pk': { S: `CHAT_STATUS#${statusParam}` },
            },
            ScanIndexForward: false,
            Limit: limitParam,
          })
        );
        items = res?.Items || [];
      } else {
        return chatResponse(
          400,
          { error: 'Invalid status filter. Allowed: all, escalated, active, resolved' },
          'admin'
        );
      }

      const chats = items.map(unmarshalSession).filter(Boolean);
      chats.sort((a, b) => {
        const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return timeB - timeA;
      });

      const page = chats.slice(0, limitParam).map((c) => ({
        sessionId: c.sessionId,
        status: c.status,
        escalationReason: c.escalationReason,
        visitorEmail: c.visitorEmail,
        customerId: c.customerId,
        plan: c.plan,
        source: c.source,
        lastMessage: c.summary,
        unreadByAdmin: c.unreadByAdmin,
        messageCount: c.messageCount,
        updatedAt: c.updatedAt,
        createdAt: c.createdAt,
      }));

      return chatResponse(200, { chats: page, nextCursor: null }, 'admin');
    } catch (err) {
      console.error('Failed to list admin chats:', err);
      return chatResponse(500, { error: 'Failed to list chat conversations' }, 'admin');
    }
  }

  async function getAdminChatTranscript(event, explicitSessionId) {
    if (!isAuthorizedAdmin(event)) {
      return chatResponse(403, { error: 'Forbidden' }, 'admin');
    }

    const routeParam = event?.queryStringParameters?.route || '';
    const routePath = routeParam
      ? routeParam.startsWith('/')
        ? routeParam
        : `/${routeParam}`
      : event?.path || event?.resource || '';
    const match = routePath.match(/\/(?:admin\/)?chats\/([^/?#]+)$/);
    const sessionIdParam = explicitSessionId || event?.pathParameters?.sessionId;
    const sessionId =
      sessionIdParam && sessionIdParam !== '{sessionId}' ? sessionIdParam : match ? match[1] : null;

    if (!sessionId || sessionId === 'chats') {
      return chatResponse(400, { error: 'sessionId is required' }, 'admin');
    }

    const ddb = getDdbClient();
    const tableName = getTableName();
    try {
      const res = await ddb.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'requestId = :rid',
          ExpressionAttributeValues: {
            ':rid': { S: `CHAT#${sessionId}` },
          },
          ScanIndexForward: true,
        })
      );

      const items = res?.Items || [];
      if (!items.length) {
        return chatResponse(404, { error: 'Chat session not found' }, 'admin');
      }

      let session = null;
      const messages = [];
      for (const item of items) {
        if (item.timestamp?.N === '0') {
          session = unmarshalSession(item);
        } else {
          messages.push(unmarshalMessage(item));
        }
      }

      if (!session) {
        return chatResponse(404, { error: 'Chat session metadata not found' }, 'admin');
      }

      if (session.unreadByAdmin) {
        session.unreadByAdmin = false;
        ddb
          .send(
            new UpdateItemCommand({
              TableName: tableName,
              Key: {
                requestId: { S: `CHAT#${sessionId}` },
                timestamp: { N: '0' },
              },
              UpdateExpression: 'SET unreadByAdmin = :f',
              ExpressionAttributeValues: {
                ':f': { BOOL: false },
              },
            })
          )
          .catch((err) => console.warn('Failed to update unreadByAdmin flag:', err));
      }

      return chatResponse(
        200,
        {
          sessionId: session.sessionId,
          status: session.status,
          escalationReason: session.escalationReason,
          visitorEmail: session.visitorEmail,
          customerId: session.customerId,
          plan: session.plan,
          source: session.source,
          unreadByAdmin: false,
          messages: messages.map((m) => ({
            messageId: m.messageId,
            role: m.role,
            sender: m.sender,
            content: m.content,
            timestamp: m.timestamp,
          })),
        },
        'admin'
      );
    } catch (err) {
      console.error('Failed to get chat transcript:', err);
      return chatResponse(500, { error: 'Failed to get chat transcript' }, 'admin');
    }
  }

  async function postAdminChatReply(event, explicitSessionId) {
    if (!isAuthorizedAdmin(event)) {
      return chatResponse(403, { error: 'Forbidden' }, 'admin');
    }

    const routeParam = event?.queryStringParameters?.route || '';
    const routePath = routeParam
      ? routeParam.startsWith('/')
        ? routeParam
        : `/${routeParam}`
      : event?.path || event?.resource || '';
    const match = routePath.match(/\/(?:admin\/)?chats\/([^/?#]+)\/reply$/);
    const sessionIdParam = explicitSessionId || event?.pathParameters?.sessionId;
    const sessionId =
      sessionIdParam && sessionIdParam !== '{sessionId}' ? sessionIdParam : match ? match[1] : null;

    if (!sessionId || sessionId === 'chats') {
      return chatResponse(400, { error: 'sessionId is required' }, 'admin');
    }

    let body = {};
    if (typeof event.body === 'string') {
      try {
        body = JSON.parse(event.body);
      } catch {
        return chatResponse(400, { error: 'Invalid JSON body' }, 'admin');
      }
    } else if (event.body && typeof event.body === 'object') {
      body = event.body;
    }

    const replyText = String(body.message || '').trim();
    if (!replyText) {
      return chatResponse(400, { error: 'message is required' }, 'admin');
    }

    const ddb = getDdbClient();
    const tableName = getTableName();

    const sessionRes = await ddb.send(
      new GetItemCommand({
        TableName: tableName,
        Key: {
          requestId: { S: `CHAT#${sessionId}` },
          timestamp: { N: '0' },
        },
      })
    );

    if (!sessionRes?.Item) {
      return chatResponse(404, { error: 'Chat session not found' }, 'admin');
    }

    const session = unmarshalSession(sessionRes.Item);
    const now = new Date();
    const nowEpochMs = now.getTime();
    const nowIso = now.toISOString();
    const expiresAt = Math.floor(nowEpochMs / 1000) + CHAT_TTL_SECONDS;

    const messageId = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const operatorMsgItem = {
      requestId: { S: `CHAT#${sessionId}` },
      timestamp: { N: String(nowEpochMs) },
      entityType: { S: 'CHAT_MESSAGE' },
      messageId: { S: messageId },
      role: { S: 'operator' },
      sender: { S: 'operator' },
      content: { S: replyText },
      expiresAt: { N: String(expiresAt) },
    };

    await ddb.send(
      new PutItemCommand({
        TableName: tableName,
        Item: operatorMsgItem,
      })
    );

    await ddb.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: {
          requestId: { S: `CHAT#${sessionId}` },
          timestamp: { N: '0' },
        },
        UpdateExpression: 'SET updatedAt = :now, GSI1SK = :now, messageCount = messageCount + :one',
        ExpressionAttributeValues: {
          ':now': { S: nowIso },
          ':one': { N: '1' },
        },
      })
    );

    let emailDispatched = false;
    if (body.sendEmail && session.visitorEmail) {
      try {
        const emailResult = await sendOperatorChatReply({
          to: session.visitorEmail,
          replyMessage: replyText,
          sessionId,
        });
        emailDispatched = Boolean(emailResult?.sent);
      } catch (err) {
        console.error('Failed to send operator email reply:', err);
      }
    }

    return chatResponse(
      200,
      {
        success: true,
        messageId,
        emailDispatched,
      },
      'admin'
    );
  }

  async function updateAdminChatStatus(event, explicitSessionId) {
    if (!isAuthorizedAdmin(event)) {
      return chatResponse(403, { error: 'Forbidden' }, 'admin');
    }

    const routeParam = event?.queryStringParameters?.route || '';
    const routePath = routeParam
      ? routeParam.startsWith('/')
        ? routeParam
        : `/${routeParam}`
      : event?.path || event?.resource || '';
    const match = routePath.match(/\/(?:admin\/)?chats\/([^/?#]+)\/status$/);
    const sessionIdParam = explicitSessionId || event?.pathParameters?.sessionId;
    const sessionId =
      sessionIdParam && sessionIdParam !== '{sessionId}' ? sessionIdParam : match ? match[1] : null;

    if (!sessionId || sessionId === 'chats') {
      return chatResponse(400, { error: 'sessionId is required' }, 'admin');
    }

    let body = {};
    if (typeof event.body === 'string') {
      try {
        body = JSON.parse(event.body);
      } catch {
        return chatResponse(400, { error: 'Invalid JSON body' }, 'admin');
      }
    } else if (event.body && typeof event.body === 'object') {
      body = event.body;
    }

    const status = String(body.status || '')
      .toLowerCase()
      .trim();
    const validStatuses = ['active', 'escalated', 'resolved'];
    if (!validStatuses.includes(status)) {
      return chatResponse(
        400,
        { error: 'Invalid status. Allowed values: active, escalated, resolved' },
        'admin'
      );
    }

    const ddb = getDdbClient();
    const tableName = getTableName();
    const nowIso = new Date().toISOString();

    let updateExpr = 'SET #st = :st, GSI1PK = :gpk, updatedAt = :now, GSI1SK = :now';
    const exprValues = {
      ':st': { S: status },
      ':gpk': { S: `CHAT_STATUS#${status}` },
      ':now': { S: nowIso },
    };

    if (status === 'resolved') {
      updateExpr += ', unreadByAdmin = :f';
      exprValues[':f'] = { BOOL: false };
    } else if (status === 'escalated') {
      updateExpr += ', unreadByAdmin = :t';
      exprValues[':t'] = { BOOL: true };
    }

    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: {
            requestId: { S: `CHAT#${sessionId}` },
            timestamp: { N: '0' },
          },
          UpdateExpression: updateExpr,
          ExpressionAttributeNames: {
            '#st': 'status',
          },
          ExpressionAttributeValues: exprValues,
        })
      );

      return chatResponse(200, { success: true, status }, 'admin');
    } catch (err) {
      console.error('Failed to update chat status:', err);
      return chatResponse(500, { error: 'Failed to update chat status' }, 'admin');
    }
  }

  return {
    listAdminChats,
    getAdminChatTranscript,
    postAdminChatReply,
    updateAdminChatStatus,
  };
}

module.exports = {
  isAuthorizedAdmin,
  createChatAdminHandlers,
};
