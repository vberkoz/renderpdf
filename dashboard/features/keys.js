(function (global) {
  'use strict';

  let currentLiveApiKey = '';
  let keysNextCursor = '';

  function getAuthHeaders() {
    if (typeof global.authHeaders === 'function') {
      return global.authHeaders();
    }
    if (typeof authHeaders === 'function') {
      return authHeaders();
    }
    return {};
  }

  function callApiRequest(path, options) {
    if (typeof global.apiRequest === 'function') {
      return global.apiRequest(path, options);
    }
    if (typeof apiRequest === 'function') {
      return apiRequest(path, options);
    }
    throw new Error('apiRequest is not defined');
  }

  async function copyToClipboard(text, button, defaultLabel = 'Copy Key') {
    let copied = false;
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof window !== 'undefined' && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch (e) {
        copied = false;
      }
    }
    if (!copied && typeof document !== 'undefined') {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        copied = document.execCommand('copy');
      } catch (e) {
        copied = false;
      }
      document.body.removeChild(textArea);
    }
    if (copied && button && typeof window !== 'undefined') {
      const prevText = button.textContent;
      button.textContent = 'Copied!';
      button.classList.add('copied');
      window.setTimeout(() => {
        button.textContent = prevText || defaultLabel;
        button.classList.remove('copied');
      }, 2000);
    }
  }

  const quickstartLanguages = [
    {
      id: 'curl',
      label: 'cURL',
      tabId: 'quickstartTabCurl',
      panelId: 'quickstartPanelCurl',
      codeId: 'quickstartCodeCurl',
      copyBtnId: 'quickstartCopyCurlBtn',
    },
    {
      id: 'node',
      label: 'Node.js',
      tabId: 'quickstartTabNode',
      panelId: 'quickstartPanelNode',
      codeId: 'quickstartCodeNode',
      copyBtnId: 'quickstartCopyNodeBtn',
    },
    {
      id: 'python',
      label: 'Python',
      tabId: 'quickstartTabPython',
      panelId: 'quickstartPanelPython',
      codeId: 'quickstartCodePython',
      copyBtnId: 'quickstartCopyPythonBtn',
    },
    {
      id: 'go',
      label: 'Go',
      tabId: 'quickstartTabGo',
      panelId: 'quickstartPanelGo',
      codeId: 'quickstartCodeGo',
      copyBtnId: 'quickstartCopyGoBtn',
    },
  ];

  function generateQuickstartSnippets(apiKey) {
    const key = apiKey && apiKey.trim() ? apiKey.trim() : 'YOUR_API_KEY';
    const endpoint = 'https://renderpdf.vberkoz.com/api/v1/render';

    const curl = `curl -X POST ${endpoint} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${key}" \\
  -d '{"version":"1","source":{"type":"html","content":"<h1>Hello from RenderPDF</h1><p>Rendered with live API key.</p>"},"data":{}}'`;

    const node = `// Node.js 18+ (using native fetch)
const response = await fetch("${endpoint}", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer ${key}"
  },
  body: JSON.stringify({
    version: "1",
    source: {
      type: "html",
      content: "<h1>Hello from RenderPDF</h1><p>Rendered with live API key.</p>"
    },
    data: {}
  })
});

const payload = await response.json();
if (!response.ok) {
  throw new Error(payload.error || \`RenderPDF request failed: \${response.status}\`);
}

// Download URL expires after 15 minutes
console.log("PDF URL:", payload.url);`;

    const python = `# Python 3 with requests
import requests

response = requests.post(
    "${endpoint}",
    headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer ${key}",
    },
    json={
        "version": "1",
        "source": {
            "type": "html",
            "content": "<h1>Hello from RenderPDF</h1><p>Rendered with live API key.</p>",
        },
        "data": {},
    },
)

payload = response.json()
if not response.ok:
    raise RuntimeError(payload.get("error") or f"RenderPDF request failed: {response.status_code}")

# Download URL expires after 15 minutes
print("PDF URL:", payload["url"])`;

    const go = `package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

func main() {
	payload := map[string]any{
		"version": "1",
		"source": map[string]string{
			"type":    "html",
			"content": "<h1>Hello from RenderPDF</h1><p>Rendered with live API key.</p>",
		},
		"data": map[string]any{},
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequest("POST", "${endpoint}", bytes.NewReader(body))
	if err != nil {
		panic(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer ${key}")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		panic(fmt.Sprintf("RenderPDF request failed (%d): %s", resp.StatusCode, string(respBody)))
	}

	fmt.Println("Response:", string(respBody))
}`;

    return { curl, node, python, go };
  }

  function escapeQuickstartHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  const quickstartHighlightRules = {
    curl: [
      { className: 'hljs-string', pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/ },
      { className: 'hljs-number', pattern: /https?:\/\/[^\s'"]+/ },
      { className: 'hljs-attr', pattern: /(?<=^|\s)--?[A-Za-z0-9-]+/ },
      { className: 'hljs-comment', pattern: /\\(?=\s*(?:\r?\n|$))/ },
      { className: 'hljs-title', pattern: /\bcurl\b/ },
      { className: 'hljs-keyword', pattern: /\b(?:POST|GET|PUT|PATCH|DELETE)\b/ },
    ],
    node: [
      { className: 'hljs-comment', pattern: /\/\/[^\n]*/ },
      { className: 'hljs-string', pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/ },
      { className: 'hljs-attr', pattern: /\b[A-Za-z_]\w*(?=\s*:)/ },
      { className: 'hljs-keyword', pattern: /\b(?:const|let|var|await|async|if|else|throw|new|return|import|from|true|false|null|undefined)\b/ },
      { className: 'hljs-built_in', pattern: /\b(?:JSON|Error|console)\b/ },
      { className: 'hljs-title', pattern: /\b[A-Za-z_]\w*(?=\s*\()/ },
      { className: 'hljs-number', pattern: /\b\d+(?:\.\d+)?\b/ },
    ],
    python: [
      { className: 'hljs-comment', pattern: /#[^\n]*/ },
      { className: 'hljs-keyword', pattern: /\b(?:f|r|b|fr|rf|rb|br)(?=["'])/ },
      { className: 'hljs-string', pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/ },
      { className: 'hljs-keyword', pattern: /\b(?:import|from|if|else|elif|not|and|or|raise|return|def|True|False|None)\b/ },
      { className: 'hljs-built_in', pattern: /\b(?:RuntimeError|print)\b/ },
      { className: 'hljs-title', pattern: /\b[A-Za-z_]\w*(?=\s*\()/ },
      { className: 'hljs-number', pattern: /\b\d+(?:\.\d+)?\b/ },
    ],
    go: [
      { className: 'hljs-comment', pattern: /\/\/[^\n]*/ },
      { className: 'hljs-string', pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`/ },
      { className: 'hljs-keyword', pattern: /\b(?:package|import|func|map|string|any|defer|if|else|return|nil|true|false)\b/ },
      { className: 'hljs-built_in', pattern: /\b(?:panic|main|http|json|fmt|io|bytes)\b/ },
      { className: 'hljs-title', pattern: /\b[A-Za-z_]\w*(?=\s*\()/ },
      { className: 'hljs-number', pattern: /\b\d+(?:\.\d+)?\b/ },
    ],
  };

  const compiledQuickstartHighlighters = Object.fromEntries(
    Object.entries(quickstartHighlightRules).map(([lang, rules]) => {
      const combined = rules.map((rule, index) => `(?<t${index}>${rule.pattern.source})`).join('|');
      return [lang, { regex: new RegExp(combined, 'g'), rules }];
    })
  );

  /** Highlight a quickstart code snippet into safe HTML spans in a single pass. */
  function highlightQuickstartCode(code, lang) {
    const source = String(code ?? '');
    if (!source) return '';

    const highlighter = compiledQuickstartHighlighters[lang];
    if (!highlighter) {
      return escapeQuickstartHtml(source);
    }

    const { regex, rules } = highlighter;
    regex.lastIndex = 0;

    let result = '';
    let cursor = 0;
    let match;

    while ((match = regex.exec(source)) !== null) {
      if (match.index > cursor) {
        result += escapeQuickstartHtml(source.slice(cursor, match.index));
      }

      let className = '';
      if (match.groups) {
        for (let i = 0; i < rules.length; i += 1) {
          if (match.groups[`t${i}`] !== undefined) {
            className = rules[i].className;
            break;
          }
        }
      }

      const tokenText = match[0];
      result += className
        ? `<span class="${className}">${escapeQuickstartHtml(tokenText)}</span>`
        : escapeQuickstartHtml(tokenText);
      cursor = match.index + tokenText.length;

      if (tokenText.length === 0) {
        regex.lastIndex += 1;
      }
    }

    if (cursor < source.length) {
      result += escapeQuickstartHtml(source.slice(cursor));
    }

    return result;
  }

  function updateQuickstartCode(apiKey) {
    const key = apiKey && apiKey.trim() ? apiKey.trim() : 'YOUR_API_KEY';
    const keyValueEl = document.getElementById('quickstartKeyValue');
    if (keyValueEl) {
      keyValueEl.textContent = key;
    }

    const snippets = generateQuickstartSnippets(key);
    quickstartLanguages.forEach(({ id, codeId }) => {
      const codeEl = document.getElementById(codeId);
      const rawSnippet = snippets[id];
      if (codeEl && typeof rawSnippet === 'string') {
        codeEl.textContent = rawSnippet;
        codeEl.innerHTML = highlightQuickstartCode(rawSnippet, id);
      }
    });
  }

  function switchQuickstartTab(activeLangId) {
    quickstartLanguages.forEach((lang) => {
      const isActive = lang.id === activeLangId;
      const tabEl = document.getElementById(lang.tabId);
      const panelEl = document.getElementById(lang.panelId);

      if (tabEl) {
        tabEl.setAttribute('aria-selected', isActive ? 'true' : 'false');
        tabEl.setAttribute('tabindex', isActive ? '0' : '-1');
        tabEl.classList.toggle('is-active', isActive);
      }
      if (panelEl) {
        panelEl.hidden = !isActive;
      }
    });
  }

  function openQuickstartModal(apiKey) {
    const dialog = document.getElementById('quickstartDialog');
    if (!dialog) return;

    if (apiKey) {
      currentLiveApiKey = apiKey;
    }
    updateQuickstartCode(currentLiveApiKey);
    switchQuickstartTab('curl');
    if (!dialog.open) {
      dialog.showModal();
    }
  }

  function showNewlyGeneratedKey(data, isInitialRegistration = false) {
    if (!data || !data.apiKey) return;

    currentLiveApiKey = data.apiKey;

    const newKeyValue = document.getElementById('newKeyValue');
    const newKeyCard = document.getElementById('newKeyCard');
    if (newKeyValue) newKeyValue.textContent = data.apiKey;
    if (newKeyCard) newKeyCard.hidden = false;

    const overviewCard = document.getElementById('overviewDefaultKeyCard');
    const overviewValue = document.getElementById('overviewDefaultKeyValue');
    if (overviewCard && overviewValue) {
      overviewValue.textContent = data.apiKey;
      overviewCard.hidden = false;
    }

    updateQuickstartCode(data.apiKey);

    if (isInitialRegistration) {
      openQuickstartModal(data.apiKey);
    }
  }

  function initQuickstartModal() {
    const dialog = document.getElementById('quickstartDialog');
    if (!dialog) return;

    updateQuickstartCode(currentLiveApiKey);

    quickstartLanguages.forEach((lang, index) => {
      const tabEl = document.getElementById(lang.tabId);
      if (!tabEl) return;

      tabEl.addEventListener('click', () => {
        switchQuickstartTab(lang.id);
        tabEl.focus();
      });

      tabEl.addEventListener('keydown', (event) => {
        let targetIndex = -1;
        if (event.key === 'ArrowRight') {
          targetIndex = (index + 1) % quickstartLanguages.length;
        } else if (event.key === 'ArrowLeft') {
          targetIndex = (index - 1 + quickstartLanguages.length) % quickstartLanguages.length;
        } else if (event.key === 'Home') {
          targetIndex = 0;
        } else if (event.key === 'End') {
          targetIndex = quickstartLanguages.length - 1;
        }

        if (targetIndex !== -1) {
          event.preventDefault();
          const targetLang = quickstartLanguages[targetIndex];
          switchQuickstartTab(targetLang.id);
          document.getElementById(targetLang.tabId)?.focus();
        }
      });

      const copyBtn = document.getElementById(lang.copyBtnId);
      const codeEl = document.getElementById(lang.codeId);
      if (copyBtn && codeEl) {
        copyBtn.addEventListener('click', () => {
          copyToClipboard(codeEl.textContent, copyBtn, 'Copy Code');
        });
      }
    });

    const copyKeyBtn = document.getElementById('quickstartCopyKeyBtn');
    if (copyKeyBtn) {
      copyKeyBtn.addEventListener('click', () => {
        const key =
          currentLiveApiKey ||
          document.getElementById('quickstartKeyValue')?.textContent?.trim() ||
          '';
        copyToClipboard(key, copyKeyBtn, 'Copy Key');
      });
    }

    document.getElementById('quickstartDialogClose')?.addEventListener('click', () => {
      dialog.close();
    });

    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) {
        dialog.close();
      }
    });

    ['sidebarQuickstartBtn', 'mobileQuickstartBtn', 'topbarQuickstartBtn'].forEach((btnId) => {
      document.getElementById(btnId)?.addEventListener('click', () => {
        openQuickstartModal();
      });
    });
    document.getElementById('overviewQuickstartAction')?.addEventListener('click', () => {
      openQuickstartModal();
    });
    document.getElementById('quickstartOverviewDefaultKeyBtn')?.addEventListener('click', () => {
      openQuickstartModal();
    });
    document.getElementById('quickstartNewKeyBtn')?.addEventListener('click', () => {
      openQuickstartModal();
    });
  }

  function generateKey(payload) {
    const options = { method: 'POST', headers: getAuthHeaders() };
    if (payload) {
      options.body = JSON.stringify(typeof payload === 'string' ? { name: payload } : payload);
    }
    return callApiRequest('/api-keys', options);
  }

  function listKeys(options = {}) {
    const params = new URLSearchParams();
    if (options && options.limit != null) params.set('limit', String(options.limit));
    if (options && options.cursor) params.set('cursor', String(options.cursor));
    const qs = params.toString();
    return callApiRequest(qs ? `/api-keys?${qs}` : '/api-keys', { headers: getAuthHeaders() });
  }

  function deleteKey(keyId) {
    return callApiRequest(`/api-keys/${encodeURIComponent(keyId)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
  }

  function renderKeys(keys) {
    const container = document.getElementById('keysList');
    if (!container) return;
    const status = document.getElementById('keysStatus');
    const notify = (message, state) => {
      if (typeof global.setNotice === 'function') global.setNotice(status, message, state);
    };
    const active = (keys || []).filter((key) => key && key.isActive !== false);
    global.currentKeys = active.slice();
    if (typeof global.renderTable !== 'function') return;
    global.renderTable(container, {
      caption: 'API keys',
      empty: 'No API keys yet. Create one to start rendering PDFs.',
      columns: [
        { label: 'Name' },
        { label: 'Key ID' },
        { label: 'Created' },
        { label: 'Last used' },
        { label: 'Action' },
      ],
      rows: active.map((key) => {
        const name = document.createElement('span');
        name.textContent = key.name || 'Untitled key';
        const id = document.createElement('code');
        id.textContent = String(key.keyId || '').slice(0, 8);
        const created = document.createElement('span');
        created.textContent = global.formatDate ? global.formatDate(key.createdAt) : '—';
        const used = document.createElement('span');
        used.textContent = key.lastUsed && global.formatDate ? global.formatDate(key.lastUsed) : 'Never';
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.className = 'dashboard-button dashboard-button-secondary';
        revoke.textContent = 'Revoke';
        revoke.setAttribute('aria-label', `Revoke key ${key.name || String(key.keyId || '').slice(0, 8)}`);
        revoke.addEventListener('click', async () => {
          const confirmed =
            typeof global.confirmDashboardAction === 'function'
              ? await global.confirmDashboardAction({
                  kicker: 'API key',
                  title: 'Revoke API key?',
                  description: 'Requests using this key will stop working immediately. This cannot be undone.',
                  confirmLabel: 'Revoke key',
                })
              : false;
          if (!confirmed) return;
          revoke.disabled = true;
          try {
            await deleteKey(key.keyId);
            notify('API key revoked.', 'success');
            await loadKeys();
          } catch (error) {
            revoke.disabled = false;
            notify(`Could not revoke the API key. ${error.message}`, 'error');
          }
        });
        return { cells: [name, id, created, used, revoke] };
      }),
    });
    if (keysNextCursor) {
      const loadMoreWrap = document.createElement('div');
      loadMoreWrap.className = 'logs-pagination';
      const loadMoreBtn = document.createElement('button');
      loadMoreBtn.type = 'button';
      loadMoreBtn.className = 'dashboard-button dashboard-button-secondary';
      loadMoreBtn.dataset.action = 'load-more-keys';
      loadMoreBtn.textContent = 'Load more keys';
      loadMoreBtn.addEventListener('click', async () => {
        loadMoreBtn.disabled = true;
        loadMoreBtn.setAttribute('aria-busy', 'true');
        await loadKeys({ cursor: keysNextCursor, append: true });
      });
      loadMoreWrap.appendChild(loadMoreBtn);
      container.appendChild(loadMoreWrap);
    }
  }

  async function loadKeys(options = {}) {
    const container = document.getElementById('keysList');
    const append = Boolean(options && options.append);
    try {
      const data = await listKeys(
        options && (options.cursor || options.limit != null)
          ? { cursor: options.cursor, limit: options.limit }
          : {}
      );
      const fetched = (data && data.keys) || [];
      keysNextCursor = (data && data.nextCursor) || '';
      const combined =
        append && Array.isArray(global.currentKeys) ? [...global.currentKeys, ...fetched] : fetched;
      renderKeys(combined);
    } catch (error) {
      if (container) {
        container.textContent = `Could not load API keys. ${error.message}`;
      }
    }
  }

  const moduleExports = {
    renderKeys,
    loadKeys,
    quickstartLanguages,
    generateQuickstartSnippets,
    highlightQuickstartCode,
    updateQuickstartCode,
    switchQuickstartTab,
    openQuickstartModal,
    showNewlyGeneratedKey,
    initQuickstartModal,
    generateKey,
    listKeys,
    deleteKey,
    copyToClipboard,
  };

  // Expose currentLiveApiKey getter/setter on global for compatibility
  try {
    Object.defineProperty(global, 'currentLiveApiKey', {
      get: () => currentLiveApiKey,
      set: (val) => {
        currentLiveApiKey = val;
      },
      configurable: true,
      enumerable: true,
    });
  } catch (e) {}

  // Expose on global window object for browser scripts
  Object.assign(global, moduleExports);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = moduleExports;
  }
})(typeof window === 'undefined' ? globalThis : window);
