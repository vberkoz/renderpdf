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

    assert.deepStrictEqual(calls.map(({ url, options }) => [url, options.method]), [
        ['/api/v1/templates', 'GET'], ['/api/v1/templates/template-a', 'GET'], ['/api/v1/templates', 'POST'], ['/api/v1/templates/template%2Fa', 'PUT'], ['/api/v1/templates/template%2Fa', 'DELETE'], ['/api/v1/render', 'POST']
    ]);
    assert.strictEqual(calls[2].options.headers.Authorization, 'Bearer key');
    assert.deepStrictEqual(JSON.parse(calls[5].options.body), { version: '1', source: { type: 'template', templateId: 'template-a', variables: { customer: { name: 'Ada' } } } });

    global.fetch = async () => ({ ok: false, status: 422, json: async () => ({ error: 'Missing required template variable "customer.name"' }) });
    await assert.rejects(() => client.render('/api/v1', 'key', 'template-a', {}), /Missing required template variable/);
    console.log('template client tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
