'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const https = require('https');
const net = require('net');

const timeoutMs = 10_000;

exports.handler = async (event) => {
  const failures = [];
  for (const record of event.Records || []) {
    try {
      await deliver(JSON.parse(record.body));
    } catch (error) {
      console.error('Webhook delivery failed', { messageId: record.messageId, error: error.message });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};

async function deliver(event) {
  const target = await validatedTarget(event.url);
  const payload = JSON.stringify({
    id: event.id,
    type: 'pdf.completed',
    createdAt: event.createdAt,
    data: { requestId: event.id, url: event.pdfUrl, size: event.pdfSize }
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = event.secret
    ? `t=${timestamp},v1=${crypto.createHmac('sha256', event.secret).update(`${timestamp}.${payload}`).digest('hex')}`
    : undefined;
  const status = await post(target, payload, event.id, signature);
  if (status < 200 || status >= 300) throw new Error(`endpoint returned HTTP ${status}`);
}

async function validatedTarget(raw) {
  const target = new URL(raw);
  if (target.protocol !== 'https:' || target.username || target.password || (target.port && target.port !== '443')) {
    throw new Error('invalid webhook target');
  }
  const addresses = await dns.lookup(target.hostname, { all: true, verbatim: true });
  const address = addresses.find(({ address }) => isPublicAddress(address));
  if (!address) throw new Error('webhook target did not resolve to a public IP');
  return { target, address: address.address, family: address.family };
}

function isPublicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168);
  }
  const value = address.toLowerCase();
  return net.isIP(address) === 6 && value !== '::1' && !value.startsWith('fc') && !value.startsWith('fd') && !value.startsWith('fe80:');
}

function post({ target, address, family }, payload, eventID, signature) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: 'https:', hostname: address, family, port: 443, method: 'POST', path: `${target.pathname}${target.search}`,
      servername: target.hostname, headers: {
        Host: target.host, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'RenderPDF-Webhooks/1.0', 'X-RenderPDF-Event': 'pdf.completed', 'X-RenderPDF-Event-ID': eventID,
        ...(signature ? { 'X-RenderPDF-Signature': signature } : {})
      }, timeout: timeoutMs
    }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('timeout', () => request.destroy(new Error('webhook request timed out')));
    request.on('error', reject);
    request.end(payload);
  });
}
