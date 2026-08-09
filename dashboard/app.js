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
    return apiRequest('/render-html', {
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

function getStoredTemplate(templateId, apiKey) { return templateClient.get(API_URL, apiKey, templateId); }

function updateTemplate(templateId, template, apiKey) {
    return templateClient.update(API_URL, apiKey, templateId, template);
}

function removeTemplate(templateId, apiKey) {
    return templateClient.remove(API_URL, apiKey, templateId);
}

function renderStoredTemplate(templateId, variables, apiKey) {
    return templateClient.render(API_URL, apiKey, templateId, variables);
}

function listSharedTemplates(apiKey) { return templateClient.listShared(API_URL, apiKey); }
function listTemplateShares(templateId, apiKey) { return templateClient.listShares(API_URL, apiKey, templateId); }
function shareTemplate(templateId, share, apiKey) { return templateClient.share(API_URL, apiKey, templateId, share); }
function updateTemplateShare(templateId, recipientId, share, apiKey) { return templateClient.updateShare(API_URL, apiKey, templateId, recipientId, share); }
function revokeTemplateShare(templateId, recipientId, apiKey) { return templateClient.revokeShare(API_URL, apiKey, templateId, recipientId); }
function cloneTemplate(templateId, apiKey) { return templateClient.clone(API_URL, apiKey, templateId); }
function listPublicLinks(templateId, apiKey) { return templateClient.listPublicLinks(API_URL, apiKey, templateId); }
function createPublicLink(templateId, apiKey) { return templateClient.createPublicLink(API_URL, apiKey, templateId); }
function revokePublicLink(templateId, linkId, apiKey) { return templateClient.revokePublicLink(API_URL, apiKey, templateId, linkId); }

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
    document.getElementById('cloneTemplateBtn').hidden = true;
    document.getElementById('saveTemplateBtn').disabled = false;
    ['templateNameInput', 'templateTypeInput', 'templateHtmlInput'].forEach((id) => { document.getElementById(id).disabled = false; });
    window.customSelect?.setValue('templateTypeInput', 'custom');
    document.getElementById('templateTypeInput').closest('[data-custom-select]').querySelector('.custom-select-trigger').disabled = false;
    document.getElementById('templateSharingPanel').hidden = true;
    document.getElementById('templatePublicPanel').hidden = true;
    document.getElementById('templateSharesList').replaceChildren();
    document.getElementById('templatePublicLinksList').replaceChildren();
    previewTemplateHTML('');
}

function populateTemplateEditor(template) {
    document.getElementById('templateId').value = template.id || '';
    document.getElementById('templateNameInput').value = template.name || '';
    window.customSelect?.setValue('templateTypeInput', template.type || 'custom');
    document.getElementById('templateHtmlInput').value = template.html || '';
    const canEdit = !template.access || template.access === 'owner' || template.access === 'editor';
    const isOwner = !template.access || template.access === 'owner';
    document.getElementById('templateVersion').textContent = template.id ? `${template.access && template.access !== 'owner' ? `${template.access} access · ` : ''}Version ${template.version || 1}` : 'Starter template — save to customize';
    document.getElementById('deleteTemplateBtn').hidden = !template.id || !isOwner;
    document.getElementById('cloneTemplateBtn').hidden = !template.id || isOwner;
    document.getElementById('saveTemplateBtn').disabled = !canEdit;
    ['templateNameInput', 'templateTypeInput', 'templateHtmlInput'].forEach((id) => { document.getElementById(id).disabled = !canEdit; });
    document.getElementById('templateTypeInput').closest('[data-custom-select]').querySelector('.custom-select-trigger').disabled = !canEdit;
    document.getElementById('templateSharingPanel').hidden = !template.id || !isOwner;
    document.getElementById('templatePublicPanel').hidden = !template.id || !isOwner;
    previewTemplateHTML(template.html || '');
}

function renderPublicLinks(links) {
    const container = document.getElementById('templatePublicLinksList');
    container.replaceChildren();
    if (!links?.length) {
        const empty = document.createElement('p'); empty.className = 'empty-state'; empty.textContent = 'No public links yet.'; container.appendChild(empty); return;
    }
    links.forEach((link) => {
        const item = document.createElement('div'); item.className = 'template-share-item';
        const summary = document.createElement('span'); summary.textContent = `Created ${new Date(link.createdAt).toLocaleDateString()} · URL shown once`;
        const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'dashboard-button dashboard-button-secondary'; revoke.textContent = 'Revoke'; revoke.dataset.publicLinkId = link.id;
        item.append(summary, revoke); container.appendChild(item);
    });
}

function renderTemplateShares(shares) {
    const container = document.getElementById('templateSharesList');
    container.replaceChildren();
    shares.forEach((share) => {
        const item = document.createElement('div'); item.className = 'template-share-item';
        const recipient = document.createElement('code'); recipient.textContent = share.recipientId;
        const role = document.createElement('span'); role.textContent = share.role;
        const changeRole = document.createElement('button'); changeRole.type = 'button'; changeRole.className = 'dashboard-button dashboard-button-secondary'; changeRole.textContent = share.role === 'viewer' ? 'Make editor' : 'Make viewer'; changeRole.dataset.recipientId = share.recipientId; changeRole.dataset.shareAction = 'role'; changeRole.dataset.nextRole = share.role === 'viewer' ? 'editor' : 'viewer';
        const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'dashboard-button dashboard-button-secondary'; revoke.textContent = 'Revoke'; revoke.dataset.recipientId = share.recipientId;
        revoke.dataset.shareAction = 'revoke';
        item.append(recipient, role, changeRole, revoke); container.appendChild(item);
    });
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
        button.querySelector('span').textContent = template.access ? `${template.type} · ${template.access}` : template.type;
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
    const sharedTemplatesList = document.getElementById('sharedTemplatesList');
    const templateForm = document.getElementById('templateForm');
    const templateRenderForm = document.getElementById('templateRenderForm');
    const templateRenderResult = document.getElementById('templateRenderResult');
    const saveTemplateButton = document.getElementById('saveTemplateBtn');
    const renderTemplateButton = document.getElementById('renderTemplateBtn');
    const templateShareForm = document.getElementById('templateShareForm');
    const cloneTemplateButton = document.getElementById('cloneTemplateBtn');
    const createPublicLinkButton = document.getElementById('createPublicLinkBtn');

    window.customSelect?.init();
    const libraryInput = document.getElementById('templateLibraryInput');
    const showTemplateLibrary = (library) => {
        document.querySelectorAll('[data-template-library-panel]').forEach((panel) => { panel.hidden = panel.dataset.templateLibraryPanel !== library; });
    };
    libraryInput.addEventListener('change', () => showTemplateLibrary(libraryInput.value));
    showTemplateLibrary(libraryInput.value);

    async function openStoredTemplate(summary, apiKey) {
        try {
            const template = await getStoredTemplate(summary.id, apiKey);
            if (summary.access) template.access = summary.access;
            populateTemplateEditor(template);
            await loadTemplateManagement(template.id, apiKey);
            setNotice(templatesStatus);
        } catch (error) {
            setNotice(templatesStatus, `Could not load template. ${error.message}`, 'error');
        }
    }

    async function loadTemplates() {
        const apiKey = apiKeyInput.value.trim();
        if (!apiKey) {
            renderTemplateList(templatesList, [], () => {}, 'Enter an API key above to load templates.');
            renderTemplateList(sharedTemplatesList, [], () => {}, 'No shared templates loaded.');
            renderTemplateList(starterTemplatesList, [], () => {}, 'Starter templates load with your API key.');
            return;
        }
        try {
            const [data, shared] = await Promise.all([listTemplates(apiKey), listSharedTemplates(apiKey)]);
            renderTemplateList(templatesList, data.templates, (template) => openStoredTemplate(template, apiKey), 'No saved templates yet. Start with a starter below.');
            renderTemplateList(sharedTemplatesList, shared.templates, (template) => openStoredTemplate(template, apiKey), 'No templates have been shared with you.');
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
        window.customSelect?.setValue('templateLibraryInput', 'owned');
        showTemplateLibrary('owned');
        setNotice(templatesStatus);
    });

    document.getElementById('templateHtmlInput').addEventListener('input', (event) => previewTemplateHTML(event.target.value));

    cloneTemplateButton.addEventListener('click', async () => {
        const templateId = document.getElementById('templateId').value;
        const apiKey = apiKeyInput.value.trim();
        if (!templateId || !apiKey) return;
        setButtonPending(cloneTemplateButton, true, 'Cloning...');
        try {
            const clone = await cloneTemplate(templateId, apiKey);
            populateTemplateEditor(clone);
            await loadTemplates();
            await loadTemplateManagement(clone.id, apiKey);
            setNotice(templatesStatus, 'Private copy created. You can now edit and share it.', 'success');
        } catch (error) {
            setNotice(templatesStatus, `Could not clone template. ${error.message}`, 'error');
        } finally {
            setButtonPending(cloneTemplateButton, false);
        }
    });

    async function loadTemplateShares(templateId, apiKey) {
        if (!templateId || document.getElementById('templateSharingPanel').hidden) return;
        try { renderTemplateShares((await listTemplateShares(templateId, apiKey)).shares || []); }
        catch (error) { setNotice(templatesStatus, `Could not load template collaborators. ${error.message}`, 'error'); }
    }

    async function loadTemplatePublicLinks(templateId, apiKey) {
        if (!templateId || document.getElementById('templatePublicPanel').hidden) return;
        try { renderPublicLinks((await listPublicLinks(templateId, apiKey)).links || []); }
        catch (error) { setNotice(templatesStatus, `Could not load public links. ${error.message}`, 'error'); }
    }

    async function loadTemplateManagement(templateId, apiKey) {
        await Promise.all([loadTemplateShares(templateId, apiKey), loadTemplatePublicLinks(templateId, apiKey)]);
    }

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
            await loadTemplateManagement(saved.id, apiKey);
            setNotice(templatesStatus, 'Template saved.', 'success');
        } catch (error) {
            setNotice(templatesStatus, `Could not save template. ${error.message}`, 'error');
        } finally {
            setButtonPending(saveTemplateButton, false);
        }
    });

    templateShareForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const templateId = document.getElementById('templateId').value, apiKey = apiKeyInput.value.trim();
        if (!templateId || !apiKey) return;
        const button = document.getElementById('shareTemplateBtn');
        setButtonPending(button, true, 'Sharing...');
        try {
            await shareTemplate(templateId, { recipientId: document.getElementById('templateRecipientInput').value.trim(), role: document.getElementById('templateShareRoleInput').value }, apiKey);
            templateShareForm.reset(); window.customSelect?.setValue('templateShareRoleInput', 'viewer'); await loadTemplateShares(templateId, apiKey); setNotice(templatesStatus, 'Template shared.', 'success');
        } catch (error) { setNotice(templatesStatus, `Could not share template. ${error.message}`, 'error'); }
        finally { setButtonPending(button, false); }
    });

    document.getElementById('templateSharesList').addEventListener('click', async (event) => {
        const button = event.target.closest('[data-recipient-id]'); if (!button) return;
        const templateId = document.getElementById('templateId').value, apiKey = apiKeyInput.value.trim();
        const isRoleUpdate = button.dataset.shareAction === 'role';
        setButtonPending(button, true, isRoleUpdate ? 'Updating...' : 'Revoking...');
        try {
            if (isRoleUpdate) await updateTemplateShare(templateId, button.dataset.recipientId, { role: button.dataset.nextRole }, apiKey);
            else await revokeTemplateShare(templateId, button.dataset.recipientId, apiKey);
            await loadTemplateShares(templateId, apiKey);
            setNotice(templatesStatus, isRoleUpdate ? 'Collaborator access updated.' : 'Access revoked.', 'success');
        }
        catch (error) { setNotice(templatesStatus, `Could not ${isRoleUpdate ? 'update' : 'revoke'} access. ${error.message}`, 'error'); }
    });

    createPublicLinkButton.addEventListener('click', async () => {
        const templateId = document.getElementById('templateId').value, apiKey = apiKeyInput.value.trim();
        if (!templateId || !apiKey) return;
        setButtonPending(createPublicLinkButton, true, 'Creating link...');
        try {
            const link = await createPublicLink(templateId, apiKey);
            await loadTemplatePublicLinks(templateId, apiKey);
            const publicURL = `${window.location.origin}${API_URL}/public/templates/${link.token}/render`;
            try { await navigator.clipboard.writeText(publicURL); setNotice(templatesStatus, 'Public link created and copied to clipboard.', 'success'); }
            catch (error) { setNotice(templatesStatus, `Public link created: ${publicURL}`, 'success'); }
        } catch (error) { setNotice(templatesStatus, `Could not create public link. ${error.message}`, 'error'); }
        finally { setButtonPending(createPublicLinkButton, false); }
    });

    document.getElementById('templatePublicLinksList').addEventListener('click', async (event) => {
        const templateId = document.getElementById('templateId').value, apiKey = apiKeyInput.value.trim();
        const revoke = event.target.closest('[data-public-link-id]'); if (!revoke || !templateId || !apiKey) return;
        setButtonPending(revoke, true, 'Revoking...');
        try { await revokePublicLink(templateId, revoke.dataset.publicLinkId, apiKey); await loadTemplatePublicLinks(templateId, apiKey); setNotice(templatesStatus, 'Public link revoked.', 'success'); }
        catch (error) { setNotice(templatesStatus, `Could not revoke public link. ${error.message}`, 'error'); }
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
