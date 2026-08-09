const assert = require('assert');
const client = require('./template-client.js');

const calls = [];
global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: options.method === 'DELETE' ? 204 : 200, json: async () => ({ url: 'https://example.test/test.pdf', size: 100 }) };
};

(async () => {
    await client.list('/api/v1', 'key');
    await client.get('/api/v1', 'key', 'template-a');
    await client.create('/api/v1', 'key', { name: 'Invoice' });
    await client.update('/api/v1', 'key', 'template/a', { name: 'Updated' });
    await client.remove('/api/v1', 'key', 'template/a');
    await client.render('/api/v1', 'key', 'template-a', { customer: { name: 'Ada' } });
    await client.listShared('/api/v1', 'key');
    await client.listShares('/api/v1', 'key', 'template-a');
    await client.share('/api/v1', 'key', 'template-a', { recipientId: 'customer-b', role: 'viewer' });
    await client.updateShare('/api/v1', 'key', 'template-a', 'customer-b', { role: 'editor' });
    await client.revokeShare('/api/v1', 'key', 'template-a', 'customer-b');
    await client.clone('/api/v1', 'key', 'template-a');
    await client.listPublicLinks('/api/v1', 'key', 'template-a');
    await client.createPublicLink('/api/v1', 'key', 'template-a');
    await client.revokePublicLink('/api/v1', 'key', 'template-a', 'link-a');

    assert.deepStrictEqual(calls.map(({ url, options }) => [url, options.method]), [
        ['/api/v1/templates', 'GET'], ['/api/v1/templates/template-a', 'GET'], ['/api/v1/templates', 'POST'], ['/api/v1/templates/template%2Fa', 'PUT'], ['/api/v1/templates/template%2Fa', 'DELETE'], ['/api/v1/render-template', 'POST'], ['/api/v1/templates/shared', 'GET'], ['/api/v1/templates/template-a/shares', 'GET'], ['/api/v1/templates/template-a/shares', 'POST'], ['/api/v1/templates/template-a/shares/customer-b', 'PUT'], ['/api/v1/templates/template-a/shares/customer-b', 'DELETE'], ['/api/v1/templates/template-a/clone', 'POST'], ['/api/v1/templates/template-a/public-links', 'GET'], ['/api/v1/templates/template-a/public-links', 'POST'], ['/api/v1/templates/template-a/public-links/link-a', 'DELETE']
    ]);
    assert.strictEqual(calls[2].options.headers.Authorization, 'Bearer key');
    assert.deepStrictEqual(JSON.parse(calls[5].options.body), { templateId: 'template-a', variables: { customer: { name: 'Ada' } } });
    assert.deepStrictEqual(JSON.parse(calls[8].options.body), { recipientId: 'customer-b', role: 'viewer' });
    assert.deepStrictEqual(JSON.parse(calls[9].options.body), { role: 'editor' });

    global.fetch = async () => ({ ok: false, status: 422, json: async () => ({ error: 'Missing required template variable "customer.name"' }) });
    await assert.rejects(() => client.render('/api/v1', 'key', 'template-a', {}), /Missing required template variable/);
    console.log('template client tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
