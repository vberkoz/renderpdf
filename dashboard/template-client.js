(function (global) {
    async function request(baseUrl, path, apiKey, method = 'GET', payload) {
        const response = await fetch(`${baseUrl}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: payload === undefined ? undefined : JSON.stringify(payload)
        });
        if (response.status === 204) return null;
        if (!response.ok) {
            let message = `Request failed (${response.status})`;
            try {
                const body = await response.json();
                message = body.error || body.message || message;
            } catch (error) {
                // Retain the status-based fallback for malformed error bodies.
            }
            throw new Error(message);
        }
        return response.json();
    }

    const client = {
        list: (baseUrl, apiKey) => request(baseUrl, '/templates', apiKey),
        create: (baseUrl, apiKey, template) => request(baseUrl, '/templates', apiKey, 'POST', template),
        update: (baseUrl, apiKey, id, template) => request(baseUrl, `/templates/${encodeURIComponent(id)}`, apiKey, 'PUT', template),
        remove: (baseUrl, apiKey, id) => request(baseUrl, `/templates/${encodeURIComponent(id)}`, apiKey, 'DELETE'),
        render: (baseUrl, apiKey, templateId, variables) => request(baseUrl, '/render-template', apiKey, 'POST', { templateId, variables })
    };

    global.templateClient = client;
    if (typeof module !== 'undefined') module.exports = client;
}(typeof window === 'undefined' ? globalThis : window));
