(function (global) {
  'use strict';

  let currentLiveApiKey = (() => {
    try {
      return (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('renderpdf_live_api_key')) || '';
    } catch {
      return '';
    }
  })();

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

  function updateQuickstartCode(apiKey) {
    const key = apiKey && apiKey.trim() ? apiKey.trim() : 'YOUR_API_KEY';
    const keyValueEl = document.getElementById('quickstartKeyValue');
    if (keyValueEl) {
      keyValueEl.textContent = key;
    }

    const snippets = generateQuickstartSnippets(key);
    const curlEl = document.getElementById('quickstartCodeCurl');
    const nodeEl = document.getElementById('quickstartCodeNode');
    const pythonEl = document.getElementById('quickstartCodePython');
    const goEl = document.getElementById('quickstartCodeGo');

    if (curlEl) curlEl.textContent = snippets.curl;
    if (nodeEl) nodeEl.textContent = snippets.node;
    if (pythonEl) pythonEl.textContent = snippets.python;
    if (goEl) goEl.textContent = snippets.go;
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
      try {
        sessionStorage.setItem('renderpdf_live_api_key', apiKey);
      } catch (e) {}
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
    try {
      sessionStorage.setItem('renderpdf_live_api_key', data.apiKey);
    } catch (e) {}

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

  function listKeys() {
    return callApiRequest('/api-keys', { headers: getAuthHeaders() });
  }

  function deleteKey(keyId) {
    return callApiRequest(`/api-keys/${encodeURIComponent(keyId)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
  }

  const moduleExports = {
    quickstartLanguages,
    generateQuickstartSnippets,
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
