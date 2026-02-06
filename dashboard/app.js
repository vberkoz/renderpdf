const API_URL = 'https://api.renderpdf.vberkoz.com';

function checkAuth() {
    const idToken = localStorage.getItem('id_token');
    if (!idToken) {
        window.location.href = '/login.html';
        return false;
    }
    return true;
}

function getUserId() {
    const idToken = localStorage.getItem('id_token');
    if (!idToken) return null;
    
    try {
        const payload = JSON.parse(atob(idToken.split('.')[1]));
        return payload.sub;
    } catch (e) {
        return null;
    }
}

async function generateKey() {
    const idToken = localStorage.getItem('id_token');
    const response = await fetch(`${API_URL}/api-keys`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${idToken}`,
            'Content-Type': 'application/json'
        }
    });

    if (!response.ok) throw new Error('Failed to generate key');
    return await response.json();
}

async function listKeys() {
    const idToken = localStorage.getItem('id_token');
    const response = await fetch(`${API_URL}/api-keys`, {
        headers: {
            'Authorization': `Bearer ${idToken}`
        }
    });

    if (!response.ok) throw new Error('Failed to list keys');
    return await response.json();
}

async function deleteKey(keyId) {
    const idToken = localStorage.getItem('id_token');
    const response = await fetch(`${API_URL}/api-keys/${keyId}`, {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${idToken}`
        }
    });

    if (!response.ok) throw new Error('Failed to delete key');
}

async function testPdfGeneration(html, apiKey) {
    const response = await fetch(`${API_URL}/generate`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        },
        body: JSON.stringify({ html })
    });

    if (!response.ok) throw new Error('Failed to generate PDF');
    return await response.json();
}

function renderKeys(keys) {
    const container = document.getElementById('keysList');
    if (!keys || keys.length === 0) {
        container.innerHTML = '<p>No API keys yet. Generate one to get started!</p>';
        return;
    }

    container.innerHTML = keys.map(key => `
        <div class="key-item">
            <div>
                <strong>Key ID:</strong> ${key.keyId}<br>
                <small>Created: ${new Date(key.createdAt * 1000).toLocaleString()}</small>
                ${key.lastUsed ? `<br><small>Last used: ${new Date(key.lastUsed * 1000).toLocaleString()}</small>` : ''}
            </div>
            <button class="btn-danger" onclick="revokeKey('${key.keyId}')">Revoke</button>
        </div>
    `).join('');
}

async function revokeKey(keyId) {
    if (!confirm('Are you sure you want to revoke this API key?')) return;
    
    try {
        await deleteKey(keyId);
        await loadKeys();
    } catch (e) {
        alert('Failed to revoke key: ' + e.message);
    }
}

async function loadKeys() {
    try {
        const data = await listKeys();
        renderKeys(data.keys);
    } catch (e) {
        alert('Failed to load keys: ' + e.message);
    }
}

if (checkAuth()) {
    loadKeys();

    document.getElementById('generateKeyBtn').addEventListener('click', async () => {
        try {
            const data = await generateKey();
            document.getElementById('newKeyValue').textContent = data.apiKey;
            document.getElementById('newKeyCard').style.display = 'block';
            await loadKeys();
        } catch (e) {
            alert('Failed to generate key: ' + e.message);
        }
    });

    document.getElementById('copyKeyBtn').addEventListener('click', () => {
        const key = document.getElementById('newKeyValue').textContent;
        navigator.clipboard.writeText(key);
        alert('API key copied to clipboard!');
    });

    document.getElementById('logoutBtn').addEventListener('click', () => {
        localStorage.clear();
        window.location.href = '/login.html';
    });

    document.getElementById('testApiBtn').addEventListener('click', async () => {
        const html = document.getElementById('htmlInput').value;
        const keys = await listKeys();
        
        if (!keys.keys || keys.keys.length === 0) {
            alert('Please generate an API key first');
            return;
        }

        const apiKey = prompt('Enter your API key to test:');
        if (!apiKey) return;

        try {
            const result = await testPdfGeneration(html, apiKey);
            document.getElementById('testResult').innerHTML = `
                <div class="success">
                    <strong>Success!</strong><br>
                    <a href="${result.url}" target="_blank">Download PDF</a><br>
                    <small>Size: ${result.size} bytes</small>
                </div>
            `;
        } catch (e) {
            document.getElementById('testResult').innerHTML = `
                <div class="error">Failed: ${e.message}</div>
            `;
        }
    });
}
