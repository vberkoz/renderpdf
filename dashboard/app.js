const API_URL = '/api/v1';
const IS_LOCAL_PREVIEW = window.location.protocol === 'file:' ||
    ['localhost', '127.0.0.1'].includes(window.location.hostname);

function decodeTokenPayload(token) {
    try {
        const encodedPayload = token.split('.')[1];
        const base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(decodeURIComponent(atob(base64).split('').map((character) =>
            `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`
        ).join('')));
    } catch (error) {
        return null;
    }
}

function clearSession() {
    localStorage.removeItem('id_token');
    localStorage.removeItem('access_token');
}

function checkAuth() {
    if (IS_LOCAL_PREVIEW) return true;

    const idToken = localStorage.getItem('id_token');
    const payload = idToken ? decodeTokenPayload(idToken) : null;

    if (!payload || (payload.exp && payload.exp * 1000 <= Date.now())) {
        clearSession();
        window.location.href = '/app/login';
        return false;
    }

    return true;
}

async function apiRequest(path, options = {}) {
    const response = await fetch(`${API_URL}${path}`, options);

    if (response.status === 401) {
        clearSession();
        window.location.href = '/app/login';
        throw new Error('Your session has expired');
    }

    if (!response.ok) {
        let message = `Request failed (${response.status})`;
        try {
            const payload = await response.json();
            message = payload.error || payload.message || message;
        } catch (error) {
            // Keep the status-based message when the response is not JSON.
        }
        throw new Error(message);
    }

    if (response.status === 204) return null;
    return response.json();
}

function authHeaders() {
    return {
        'Authorization': `Bearer ${localStorage.getItem('id_token')}`,
        'Content-Type': 'application/json'
    };
}

function generateKey() {
    return apiRequest('/api-keys', { method: 'POST', headers: authHeaders() });
}

function listKeys() {
    return apiRequest('/api-keys', { headers: authHeaders() });
}

function deleteKey(keyId) {
    return apiRequest(`/api-keys/${encodeURIComponent(keyId)}`, {
        method: 'DELETE',
        headers: authHeaders()
    });
}

function loadDashboard() {
    return apiRequest('/dashboard', { headers: authHeaders() });
}

function startCheckout(plan) {
    return apiRequest('/billing/checkout', {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ plan })
    });
}

function openBillingPortal() {
    return apiRequest('/billing/portal', { method: 'POST', headers: authHeaders() });
}

let paddleInitialized = false;

function loadPaddleScript() {
    if (window.Paddle) return Promise.resolve(window.Paddle);
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
        script.async = true;
        script.onload = () => resolve(window.Paddle);
        script.onerror = () => reject(new Error('Could not load Paddle Checkout'));
        document.head.appendChild(script);
    });
}

async function openPaddleCheckout(checkout) {
    const Paddle = await loadPaddleScript();
    if (!Paddle || !checkout.clientToken || !checkout.transactionId) throw new Error('Paddle Checkout is unavailable');
    if (!paddleInitialized) {
        if (checkout.environment === 'sandbox') Paddle.Environment.set('sandbox');
        Paddle.Initialize({
            token: checkout.clientToken,
            eventCallback(event) {
                if (event?.name === 'checkout.completed') {
                    window.setTimeout(refreshDashboard, 1500);
                    window.setTimeout(refreshDashboard, 5000);
                }
            }
        });
        paddleInitialized = true;
    }
    Paddle.Checkout.open({ transactionId: checkout.transactionId, settings: { displayMode: 'overlay', theme: 'light' } });
}

function testPdfGeneration(html, apiKey) {
    return apiRequest('/render', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ html })
    });
}

function listTemplates(apiKey) {
    return templateClient.list(API_URL, apiKey);
}

function createTemplate(template, apiKey) {
    return templateClient.create(API_URL, apiKey, template);
}

function updateTemplate(templateId, template, apiKey) {
    return templateClient.update(API_URL, apiKey, templateId, template);
}

function removeTemplate(templateId, apiKey) {
    return templateClient.remove(API_URL, apiKey, templateId);
}

function renderStoredTemplate(templateId, variables, apiKey) {
    return templateClient.render(API_URL, apiKey, templateId, variables);
}

function setNotice(element, message = '', state = '') {
    element.textContent = message;
    element.dataset.state = state;
    element.hidden = !message;
}

function setButtonPending(button, pending, pendingLabel) {
    if (!button.dataset.label) button.dataset.label = button.innerHTML;
    button.disabled = pending;
    button.innerHTML = pending ? pendingLabel : button.dataset.label;
}

function templatePayloadFromForm() {
    return {
        name: document.getElementById('templateNameInput').value.trim(),
        type: document.getElementById('templateTypeInput').value,
        html: document.getElementById('templateHtmlInput').value.trim()
    };
}

function previewTemplateHTML(html) {
    document.getElementById('templatePreview').srcdoc = html || '<main style="font-family:sans-serif;padding:24px;color:#586473">Your template preview appears here.</main>';
}

function resetTemplateEditor() {
    document.getElementById('templateForm').reset();
    document.getElementById('templateId').value = '';
    document.getElementById('templateVersion').textContent = 'New template';
    document.getElementById('deleteTemplateBtn').hidden = true;
    previewTemplateHTML('');
}

function populateTemplateEditor(template) {
    document.getElementById('templateId').value = template.id || '';
    document.getElementById('templateNameInput').value = template.name || '';
    document.getElementById('templateTypeInput').value = template.type || 'custom';
    document.getElementById('templateHtmlInput').value = template.html || '';
    document.getElementById('templateVersion').textContent = template.id ? `Version ${template.version || 1}` : 'Starter template — save to customize';
    document.getElementById('deleteTemplateBtn').hidden = !template.id;
    previewTemplateHTML(template.html || '');
}

function renderTemplateList(container, templates, selectTemplate, emptyMessage) {
    container.replaceChildren();
    if (!templates?.length) {
        const empty = document.createElement('p');
        empty.className = 'empty-state';
        empty.textContent = emptyMessage;
        container.appendChild(empty);
        return;
    }
    templates.forEach((template) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'template-list-item';
        button.innerHTML = `<strong></strong><span></span>`;
        button.querySelector('strong').textContent = template.name;
        button.querySelector('span').textContent = template.type;
        button.addEventListener('click', () => selectTemplate(template));
        container.appendChild(button);
    });
}

function formatDate(timestamp) {
    if (!timestamp) return 'Not used yet';
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short'
    }).format(new Date(timestamp * 1000));
}

function renderKeys(keys) {
    const container = document.getElementById('keysList');
    const keyCount = document.getElementById('keyCount');
    const activeKeys = (keys || []).filter((key) => key.isActive);
    keyCount.textContent = String(activeKeys.length);
    container.replaceChildren();

    if (!keys || keys.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.innerHTML = '<strong>No API keys yet</strong><span>Create your first key to use the production endpoint.</span>';
        container.appendChild(empty);
        return;
    }

    keys.forEach((key) => {
        const item = document.createElement('div');
        item.className = 'key-item';

        const identity = document.createElement('div');
        identity.className = 'key-identity';
        const keyLabel = document.createElement('code');
        keyLabel.textContent = key.keyId;
        const created = document.createElement('span');
        created.textContent = `Created ${formatDate(key.createdAt)}`;
        identity.append(keyLabel, created);

        const activity = document.createElement('div');
        activity.className = 'key-activity';
        const activityLabel = document.createElement('span');
        activityLabel.textContent = key.lastUsed ? 'Last used' : 'Usage';
        const activityValue = document.createElement('strong');
        activityValue.textContent = formatDate(key.lastUsed);
        activity.append(activityLabel, activityValue);

        const controls = document.createElement('div');
        controls.className = 'key-controls';
        const state = document.createElement('span');
        state.className = key.isActive ? 'key-state is-active' : 'key-state';
        state.textContent = key.isActive ? 'Active' : 'Revoked';
        controls.appendChild(state);

        if (key.isActive) {
            const revokeButton = document.createElement('button');
            revokeButton.className = 'revoke-button';
            revokeButton.type = 'button';
            revokeButton.textContent = 'Revoke';
            revokeButton.dataset.keyId = key.keyId;
            controls.appendChild(revokeButton);
        }

        item.append(identity, activity, controls);
        container.appendChild(item);
    });
}

async function loadKeys() {
    const status = document.getElementById('keysStatus');
    try {
        const data = await listKeys();
        renderKeys(data.keys);
        setNotice(status);
    } catch (error) {
        setNotice(status, `Could not load API keys. ${error.message}`, 'error');
    }
}

function renderAccount() {
    const payload = decodeTokenPayload(localStorage.getItem('id_token'));
    const accountLabel = document.getElementById('accountLabel');
    accountLabel.textContent = payload?.email || 'RenderPDF developer';
    document.getElementById('statsNav').hidden = payload?.email?.toLowerCase() !== 'vberkoz@gmail.com';
}

function formatLogDate(timestamp) {
    if (!timestamp) return 'Unknown time';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp * 1000));
}

function renderLogs(logs) {
    const container = document.getElementById('logsList');
    container.replaceChildren();
    if (!logs?.length) {
        container.innerHTML = '<p class="empty-state">No authenticated PDF requests yet.</p>';
        return;
    }
    logs.forEach((log) => {
        const item = document.createElement('div');
        item.className = `log-item ${log.status === 'success' ? 'is-success' : 'is-error'}`;
        const main = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = log.status === 'success' ? 'PDF generated' : 'PDF failed';
        const details = document.createElement('span');
        details.textContent = `${formatLogDate(log.timestamp)} · ${log.apiKeyId ? `key ${log.apiKeyId.slice(0, 8)}` : 'account request'}`;
        main.append(title, details);
        const meta = document.createElement('span');
        meta.textContent = log.status === 'success' ? `${(log.size / 1024).toFixed(1)} KB` : (log.errorType || log.status);
        item.append(main, meta);
        container.appendChild(item);
    });
}

function renderDashboard(data) {
    const usage = data.usage || {};
    const billing = data.billing || { status: 'free', plan: 'Free' };
    document.getElementById('pdfsToday').textContent = String(usage.pdfsToday ?? 0);
    document.getElementById('failedToday').textContent = String(usage.failedToday ?? 0);
    document.getElementById('quotaRemaining').textContent = String(usage.remaining ?? 0);
    document.getElementById('quotaDetail').textContent = `${usage.usedThisMonth ?? 0} of ${usage.quota ?? 0} PDFs used this month`;
    document.getElementById('billingPlan').textContent = billing.plan || 'Free';
    document.getElementById('billingDetail').textContent = billing.status === 'free'
        ? 'Upgrade for more monthly PDF capacity.'
        : `${billing.status.replace(/_/g, ' ')}${billing.renewsAt ? ` · renews ${new Date(billing.renewsAt).toLocaleDateString()}` : ''}`;
    const subscribed = ['active', 'trialing', 'past_due'].includes(billing.status);
    document.querySelectorAll('[data-plan]').forEach((button) => { button.hidden = subscribed; });
    document.getElementById('manageBillingBtn').hidden = !subscribed;
    renderLogs(data.logs);
}

async function refreshDashboard() {
    const billingStatus = document.getElementById('billingStatus');
    try {
        renderDashboard(await loadDashboard());
        setNotice(billingStatus);
    } catch (error) {
        setNotice(billingStatus, `Could not load dashboard data. ${error.message}`, 'error');
    }
}

if (checkAuth()) {
    const generateButton = document.getElementById('generateKeyBtn');
    const copyButton = document.getElementById('copyKeyBtn');
    const keysList = document.getElementById('keysList');
    const keysStatus = document.getElementById('keysStatus');
    const testForm = document.getElementById('testApiForm');
    const testButton = document.getElementById('testApiBtn');
    const testResult = document.getElementById('testResult');
    const apiKeyInput = document.getElementById('apiKeyInput');
    const templatesStatus = document.getElementById('templatesStatus');
    const templatesList = document.getElementById('templatesList');
    const starterTemplatesList = document.getElementById('starterTemplatesList');
    const templateForm = document.getElementById('templateForm');
    const templateRenderForm = document.getElementById('templateRenderForm');
    const templateRenderResult = document.getElementById('templateRenderResult');
    const saveTemplateButton = document.getElementById('saveTemplateBtn');
    const renderTemplateButton = document.getElementById('renderTemplateBtn');

    async function loadTemplates() {
        const apiKey = apiKeyInput.value.trim();
        if (!apiKey) {
            renderTemplateList(templatesList, [], () => {}, 'Enter an API key above to load templates.');
            renderTemplateList(starterTemplatesList, [], () => {}, 'Starter templates load with your API key.');
            return;
        }
        try {
            const data = await listTemplates(apiKey);
            renderTemplateList(templatesList, data.templates, populateTemplateEditor, 'No saved templates yet. Start with a starter below.');
            renderTemplateList(starterTemplatesList, data.starters, (starter) => {
                populateTemplateEditor({ ...starter, id: '' });
                setNotice(templatesStatus, `Loaded the ${starter.name} starter. Save it to create your editable copy.`, 'success');
            }, 'No starter templates are available.');
            setNotice(templatesStatus);
        } catch (error) {
            setNotice(templatesStatus, `Could not load templates. ${error.message}`, 'error');
        }
    }

    renderAccount();
    if (IS_LOCAL_PREVIEW) {
        renderKeys([]);
    } else {
        loadKeys();
    }
    if (!IS_LOCAL_PREVIEW) refreshDashboard();
    resetTemplateEditor();

    document.querySelectorAll('[data-plan]').forEach((button) => button.addEventListener('click', async () => {
        const billingStatus = document.getElementById('billingStatus');
        setButtonPending(button, true, 'Opening checkout...');
        try {
            const data = await startCheckout(button.dataset.plan);
            await openPaddleCheckout(data);
            setButtonPending(button, false);
        } catch (error) {
            setNotice(billingStatus, `Could not start checkout. ${error.message}`, 'error');
            setButtonPending(button, false);
        }
    }));

    document.getElementById('manageBillingBtn').addEventListener('click', async () => {
        const button = document.getElementById('manageBillingBtn');
        const billingStatus = document.getElementById('billingStatus');
        setButtonPending(button, true, 'Opening billing...');
        try {
            const data = await openBillingPortal();
            window.location.assign(data.url);
        } catch (error) {
            setNotice(billingStatus, `Could not open billing. ${error.message}`, 'error');
            setButtonPending(button, false);
        }
    });

    generateButton.addEventListener('click', async () => {
        setButtonPending(generateButton, true, 'Creating key...');
        setNotice(keysStatus);
        try {
            const data = await generateKey();
            document.getElementById('newKeyValue').textContent = data.apiKey;
            document.getElementById('newKeyCard').hidden = false;
            apiKeyInput.value = data.apiKey;
            await loadKeys();
            await loadTemplates();
        } catch (error) {
            setNotice(keysStatus, `Could not create an API key. ${error.message}`, 'error');
        } finally {
            setButtonPending(generateButton, false);
        }
    });

    copyButton.addEventListener('click', async () => {
        const key = document.getElementById('newKeyValue').textContent;
        try {
            await navigator.clipboard.writeText(key);
            copyButton.textContent = 'Copied';
            window.setTimeout(() => { copyButton.textContent = 'Copy key'; }, 1600);
        } catch (error) {
            setNotice(keysStatus, 'Clipboard access is unavailable. Select and copy the key manually.', 'error');
        }
    });

    apiKeyInput.addEventListener('change', loadTemplates);

    document.getElementById('newTemplateBtn').addEventListener('click', () => {
        resetTemplateEditor();
        setNotice(templatesStatus);
    });

    document.getElementById('templateHtmlInput').addEventListener('input', (event) => previewTemplateHTML(event.target.value));

    templateForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const apiKey = apiKeyInput.value.trim();
        if (!apiKey) {
            setNotice(templatesStatus, 'Enter an API key before saving a template.', 'error');
            apiKeyInput.focus();
            return;
        }
        const template = templatePayloadFromForm();
        if (!template.name || !template.html) {
            setNotice(templatesStatus, 'Template name and HTML are required.', 'error');
            return;
        }
        setButtonPending(saveTemplateButton, true, 'Saving...');
        try {
            const templateId = document.getElementById('templateId').value;
            const saved = templateId ? await updateTemplate(templateId, template, apiKey) : await createTemplate(template, apiKey);
            populateTemplateEditor(saved);
            await loadTemplates();
            setNotice(templatesStatus, 'Template saved.', 'success');
        } catch (error) {
            setNotice(templatesStatus, `Could not save template. ${error.message}`, 'error');
        } finally {
            setButtonPending(saveTemplateButton, false);
        }
    });

    document.getElementById('deleteTemplateBtn').addEventListener('click', async () => {
        const templateId = document.getElementById('templateId').value;
        const apiKey = apiKeyInput.value.trim();
        if (!templateId || !apiKey) return;
        if (!window.confirm('Delete this template? This cannot be undone.')) return;
        const button = document.getElementById('deleteTemplateBtn');
        setButtonPending(button, true, 'Deleting...');
        try {
            await removeTemplate(templateId, apiKey);
            resetTemplateEditor();
            await loadTemplates();
            setNotice(templatesStatus, 'Template deleted.', 'success');
        } catch (error) {
            setNotice(templatesStatus, `Could not delete template. ${error.message}`, 'error');
        } finally {
            setButtonPending(button, false);
        }
    });

    templateRenderForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const templateId = document.getElementById('templateId').value;
        const apiKey = apiKeyInput.value.trim();
        if (!templateId) {
            setNotice(templateRenderResult, 'Save this template before rendering a test PDF.', 'error');
            return;
        }
        if (!apiKey) {
            setNotice(templateRenderResult, 'Enter an API key before rendering.', 'error');
            return;
        }
        let variables;
        try {
            variables = JSON.parse(document.getElementById('templateVariablesInput').value);
            if (!variables || Array.isArray(variables) || typeof variables !== 'object') throw new Error('Variables must be an object');
        } catch (error) {
            setNotice(templateRenderResult, `Variable JSON is invalid. ${error.message}`, 'error');
            return;
        }
        setButtonPending(renderTemplateButton, true, 'Rendering PDF...');
        setNotice(templateRenderResult, 'Resolving template variables and rendering PDF...', 'pending');
        try {
            const result = await renderStoredTemplate(templateId, variables, apiKey);
            templateRenderResult.dataset.state = 'success';
            templateRenderResult.replaceChildren();
            const link = document.createElement('a');
            link.href = result.url;
            link.target = '_blank';
            link.rel = 'noopener';
            link.textContent = `Download test PDF (${(result.size / 1024).toFixed(1)} KB) →`;
            templateRenderResult.append(link);
            templateRenderResult.hidden = false;
        } catch (error) {
            setNotice(templateRenderResult, `Could not render template. ${error.message}`, 'error');
        } finally {
            setButtonPending(renderTemplateButton, false);
        }
    });

    keysList.addEventListener('click', async (event) => {
        const revokeButton = event.target.closest('[data-key-id]');
        if (!revokeButton) return;
        if (!window.confirm('Revoke this API key? Requests using it will stop working immediately.')) return;

        revokeButton.disabled = true;
        revokeButton.textContent = 'Revoking...';
        try {
            await deleteKey(revokeButton.dataset.keyId);
            await loadKeys();
        } catch (error) {
            setNotice(keysStatus, `Could not revoke the API key. ${error.message}`, 'error');
            revokeButton.disabled = false;
            revokeButton.textContent = 'Revoke';
        }
    });

    document.getElementById('logoutBtn').addEventListener('click', () => {
        clearSession();
        window.location.href = '/app/login';
    });

    testForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const html = document.getElementById('htmlInput').value.trim();
        const apiKey = apiKeyInput.value.trim();

        if (!apiKey) {
            setNotice(testResult, 'Enter an API key before generating a PDF.', 'error');
            apiKeyInput.focus();
            return;
        }
        if (!html) {
            setNotice(testResult, 'Enter HTML content before generating a PDF.', 'error');
            return;
        }

        setButtonPending(testButton, true, 'Rendering PDF...');
        setNotice(testResult, 'Rendering HTML with Chromium...', 'pending');
        try {
            const result = await testPdfGeneration(html, apiKey);
            testResult.dataset.state = 'success';
            testResult.replaceChildren();

            const summary = document.createElement('div');
            const title = document.createElement('strong');
            title.textContent = 'PDF ready';
            const size = document.createElement('span');
            size.textContent = `${(result.size / 1024).toFixed(1)} KB`;
            summary.append(title, size);

            const download = document.createElement('a');
            download.href = result.url;
            download.target = '_blank';
            download.rel = 'noopener';
            download.textContent = 'Download PDF ->';
            testResult.append(summary, download);
            testResult.hidden = false;
        } catch (error) {
            setNotice(testResult, `Could not generate the PDF. ${error.message}`, 'error');
        } finally {
            setButtonPending(testButton, false);
        }
    });
}
