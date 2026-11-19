(function (global) {
  'use strict';

  function callApiRequest(path, options) {
    if (typeof global.dashboardTemplateRequest === 'function') {
      return global.dashboardTemplateRequest(path, options);
    }
    if (typeof global.apiRequest === 'function') {
      return global.apiRequest(path, options);
    }
    if (typeof apiRequest === 'function') {
      return apiRequest(path, options);
    }
    throw new Error('apiRequest is not defined');
  }

  function callConfirmAction(options) {
    if (typeof global.confirmDashboardAction === 'function') {
      return global.confirmDashboardAction(options);
    }
    return Promise.resolve(true);
  }

  function callRenderTable(container, options) {
    if (typeof global.renderTable === 'function') {
      return global.renderTable(container, options);
    }
  }

  function callSetNotice(element, message = '', state = '') {
    if (typeof global.setNotice === 'function') {
      return global.setNotice(element, message, state);
    }
    if (element) {
      element.textContent = message;
      element.dataset.state = state;
      element.hidden = !message;
    }
  }

  function callSetButtonPending(button, pending, pendingLabel) {
    if (typeof global.setButtonPending === 'function') {
      return global.setButtonPending(button, pending, pendingLabel);
    }
    if (button) button.disabled = pending;
  }

  function callFormatAssetDate(timestamp) {
    if (typeof global.formatAssetDate === 'function') {
      return global.formatAssetDate(timestamp);
    }
    if (!timestamp) return 'recently';
    return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }

  let savedSources = new Map();
  let managersLoaded = false;

  function getSavedSources() {
    return savedSources;
  }

  function setSavedSourceInventory(
    sources,
    selectedValue = document.getElementById('storedSourcePickerInput')?.value || ''
  ) {
    savedSources = new Map((sources || []).map((source) => [source.id, source]));
    const options = (sources || []).map((source) => ({ value: source.id, label: source.name }));
    const selected = savedSources.has(selectedValue) ? selectedValue : '';
    if (typeof window !== 'undefined') {
      window.customSelect?.replaceOptions(
        'storedSourcePickerInput',
        [
          {
            label: 'Saved sources',
            options: options.length ? options : [{ value: '', label: 'No saved sources yet' }],
          },
        ],
        selected
      );
    }
    return selected;
  }

  function describeStoredSource(source) {
    return source
      ? `${source.name} · ${source.sourceType} source`
      : 'Select a saved source to add data and create PDFs.';
  }

  function selectStoredSource(sourceID) {
    const selected = setSavedSourceInventory([...savedSources.values()], sourceID);
    const source = savedSources.get(selected);
    const statusEl = document.getElementById('storedSourceStatus');
    if (statusEl) {
      callSetNotice(statusEl, describeStoredSource(source), source ? 'success' : '');
    }
    return source;
  }

  async function loadSavedSources(selectedValue) {
    try {
      const result = await callApiRequest('/dashboard/sources');
      const selected = setSavedSourceInventory(result.sources || [], selectedValue);
      selectStoredSource(selected);
      return result.sources || [];
    } catch (error) {
      setSavedSourceInventory([], '');
      const statusEl = document.getElementById('storedSourceStatus');
      if (statusEl) {
        callSetNotice(statusEl, `Could not load saved sources. ${error.message}`, 'error');
      }
      return [];
    }
  }

  function renderManagerEmpty(container, title, description, action) {
    if (!container) return;
    const empty = document.createElement('div');
    empty.className = 'reusable-empty-state';
    const heading = document.createElement('strong');
    heading.textContent = title;
    const detail = document.createElement('span');
    detail.textContent = description;
    empty.append(heading, detail);
    if (action) {
      const link = document.createElement('a');
      link.className = 'dashboard-button dashboard-button-secondary';
      link.href = action.href;
      link.textContent = action.label;
      empty.append(link);
    }
    callRenderTable(container, { caption: container.getAttribute('aria-label') || title, empty });
  }

  function renderManagerLoading(container, label) {
    if (!container) return;
    callRenderTable(container, { loading: `Loading ${label}` });
  }

  function openReusableAsset(assetType, asset) {
    if (typeof global.setDashboardView === 'function') {
      global.setDashboardView('create-render', { history: 'push', focus: true });
    }
    document.dispatchEvent(
      new CustomEvent('dashboardviewchange', { detail: { view: 'create-render' } })
    );
    const modeInput = document.getElementById('createRenderModeInput');
    if (assetType === 'template') {
      if (modeInput) modeInput.value = 'template';
      if (typeof global.setCreateRenderMode === 'function') {
        global.setCreateRenderMode('template');
      }
      if (typeof global.openStoredTemplate === 'function') {
        global.openStoredTemplate(asset);
      }
      return;
    }
    if (modeInput) modeInput.value = 'stored';
    if (typeof global.setCreateRenderMode === 'function') {
      global.setCreateRenderMode('stored');
    }
    selectStoredSource(asset.id);
  }

  async function refreshManagers() {
    const templatesManager = document.getElementById('templatesManager');
    const sourcesManager = document.getElementById('sourcesManager');
    const filesManager = document.getElementById('filesManager');
    const batchesManager = document.getElementById('batchesManager');
    if (!managersLoaded) {
      renderManagerLoading(templatesManager, 'templates');
      renderManagerLoading(sourcesManager, 'saved sources');
      renderManagerLoading(filesManager, 'private files');
      renderManagerLoading(batchesManager, 'batch jobs');
    }
    try {
      const [templateResult, sourceResult, fileResult, batchResult] = await Promise.all([
        typeof global.listTemplates === 'function' ? global.listTemplates() : callApiRequest('/dashboard/templates'),
        callApiRequest('/dashboard/sources'),
        callApiRequest('/dashboard/files'),
        callApiRequest('/dashboard/batches'),
      ]);

      if (typeof global.setSavedTemplatesState === 'function') {
        global.setSavedTemplatesState(templateResult.templates || [], templateResult.starters || []);
      }

      const templates = templateResult.templates || [];
      if (!templates.length) {
        renderManagerEmpty(
          templatesManager,
          'No templates yet',
          'Create a reusable layout for individual PDFs.',
          { href: '/app/?view=create-render', label: 'Create template' }
        );
      } else {
        const templateRows = templates.map((template) => {
          const details = document.createElement('div');
          details.className = 'reusable-asset-details';
          const name = document.createElement('strong');
          const meta = document.createElement('span');
          name.textContent = template.name;
          meta.textContent = `${template.type} template · updated ${callFormatAssetDate(template.updatedAt)}`;
          details.append(name, meta);
          const actions = document.createElement('div');
          actions.className = 'dashboard-table-actions reusable-asset-actions';
          const use = document.createElement('button');
          use.className = 'table-action';
          use.type = 'button';
          use.textContent = 'Use in Create';
          use.setAttribute('aria-label', `Use template ${template.name} in Create PDF`);
          use.onclick = () => openReusableAsset('template', template);
          const remove = document.createElement('button');
          remove.className = 'table-action danger';
          remove.type = 'button';
          remove.textContent = 'Delete';
          remove.setAttribute('aria-label', `Delete template ${template.name}`);
          remove.onclick = async () => {
            if (
              !(await callConfirmAction({
                title: `Delete “${template.name}”?`,
                description: 'This template will be permanently deleted.',
                confirmLabel: 'Delete template',
              }))
            )
              return;
            try {
              if (typeof global.removeTemplate === 'function') {
                await global.removeTemplate(template.id);
              } else {
                await callApiRequest(`/dashboard/templates/${encodeURIComponent(template.id)}`, {
                  method: 'DELETE',
                });
              }
              await refreshManagers();
              callSetNotice(document.getElementById('sourcesStatus'), 'Template deleted.', 'success');
            } catch (error) {
              callSetNotice(
                document.getElementById('sourcesStatus'),
                `Could not delete this template. ${error.message}`,
                'error'
              );
            }
          };
          actions.append(use, remove);
          return {
            cells: [details, actions],
            sortValues: [template.name, template.updatedAt || ''],
          };
        });
        callRenderTable(templatesManager, {
          caption: 'Saved templates',
          columns: [
            { label: 'Template' },
            { label: 'Actions', className: 'dashboard-table-actions-cell' },
          ],
          rows: templateRows,
        });
      }

      const sourceList = sourceResult.sources || [];
      setSavedSourceInventory(sourceList);
      const batchOptions = sourceList.map((source) => ({ value: source.id, label: source.name }));
      if (!sourceList.length) {
        renderManagerEmpty(
          sourcesManager,
          'No saved sources yet',
          'Save a document definition for repeat renders and batches.',
          { href: '/app/?view=create-render', label: 'Create PDF' }
        );
      }
      const sourceRows = sourceList.map((source) => {
        const details = document.createElement('div');
        details.className = 'reusable-asset-details';
        const name = document.createElement('strong');
        const meta = document.createElement('span');
        name.textContent = source.name;
        meta.textContent = `${source.sourceType} · ${(source.sizeBytes / 1024).toFixed(1)} KB`;
        details.append(name, meta);
        const actions = document.createElement('div');
        actions.className = 'dashboard-table-actions reusable-asset-actions';
        const use = document.createElement('button');
        use.className = 'table-action';
        use.type = 'button';
        use.textContent = 'Use in Create';
        use.setAttribute('aria-label', `Use saved source ${source.name} in Create PDF`);
        const remove = document.createElement('button');
        remove.className = 'table-action danger';
        remove.type = 'button';
        remove.textContent = 'Delete';
        remove.setAttribute('aria-label', `Delete saved source ${source.name}`);
        actions.append(use, remove);
        use.onclick = () => openReusableAsset('source', source);
        remove.onclick = async () => {
          if (
            !(await callConfirmAction({
              title: `Delete “${source.name}”?`,
              description:
                'This saved source will be permanently deleted and cannot be used in future renders or batches.',
              confirmLabel: 'Delete source',
            }))
          )
            return;
          try {
            await callApiRequest(`/dashboard/sources/${encodeURIComponent(source.id)}`, {
              method: 'DELETE',
            });
            await refreshManagers();
            callSetNotice(document.getElementById('sourcesStatus'), 'Source deleted.', 'success');
          } catch (error) {
            callSetNotice(
              document.getElementById('sourcesStatus'),
              `Could not delete this source. ${error.message}`,
              'error'
            );
          }
        };
        return { cells: [details, actions], sortValues: [source.name, source.sizeBytes || 0] };
      });
      if (sourceRows.length) {
        callRenderTable(sourcesManager, {
          caption: 'Saved sources',
          columns: [
            { label: 'Source' },
            { label: 'Actions', className: 'dashboard-table-actions-cell' },
          ],
          rows: sourceRows,
        });
      }

      const currentBatchSource = document.getElementById('batchSourceSelect')?.value;
      if (typeof window !== 'undefined') {
        window.customSelect?.replaceOptions(
          'batchSourceSelect',
          [
            {
              label: 'Saved sources',
              options: batchOptions.length
                ? batchOptions
                : [{ value: '', label: 'No saved sources' }],
            },
          ],
          batchOptions.some((source) => source.value === currentBatchSource)
            ? currentBatchSource
            : batchOptions[0]?.value || ''
        );
      }
      if (typeof global.updateBatchReview === 'function') {
        global.updateBatchReview();
      }

      const files = fileResult.files || [];
      if (!files.length) {
        renderManagerEmpty(
          filesManager,
          'No private files yet',
          'Uploaded packages and rendered PDFs will appear here.'
        );
      }
      const fileRows = files.map((file) => {
        const displayName = file.displayName || file.kind.replace(/_/g, ' ');
        const details = document.createElement('div');
        details.className = 'file-record-details';
        const name = document.createElement('strong');
        const meta = document.createElement('span');
        name.textContent = displayName;
        details.append(name, meta);
        const createdAt = file.createdAt
          ? new Date(file.createdAt).toLocaleString([], {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })
          : 'Date unavailable';
        meta.textContent = `${(file.sizeBytes / 1024).toFixed(1)} KB · ${createdAt}`;
        const kind = document.createElement('span');
        kind.textContent = file.kind.replace(/_/g, ' ');
        const actions = document.createElement('div');
        actions.className = 'dashboard-table-actions';
        const isPackage =
          file.kind === 'uploaded_package' ||
          (file.displayName && file.displayName.toLowerCase().endsWith('.zip'));
        if (isPackage) {
          const renderBtn = document.createElement('button');
          renderBtn.className = 'table-action';
          renderBtn.type = 'button';
          renderBtn.textContent = 'Render';
          renderBtn.setAttribute('aria-label', `Render package ${displayName}`);
          renderBtn.onclick = () => {
            if (typeof global.setDashboardView === 'function') {
              global.setDashboardView('create-render', { history: 'push', focus: true });
            }
            if (typeof global.setCreateRenderMode === 'function') {
              global.setCreateRenderMode('html', false);
            }
            const packagePayload = {
              version: '1',
              source: {
                type: 'upload',
                uploadId: file.id,
              },
              options: {
                format: 'A4',
                margin: '18mm',
              },
            };
            if (typeof global.setTemplateEditorValue === 'function') {
              global.setTemplateEditorValue('documentJsonInput', JSON.stringify(packagePayload, null, 2));
            } else {
              const el = document.getElementById('documentJsonInput');
              if (el) el.value = JSON.stringify(packagePayload, null, 2);
            }
            const statusEl = document.getElementById('documentJsonStatus');
            if (statusEl && typeof global.setNotice === 'function') {
              global.setNotice(statusEl, `Selected uploaded package “${displayName}”. Ready to render.`, 'success');
            }
            if (typeof global.previewDocumentJson === 'function') {
              try {
                global.previewDocumentJson();
              } catch (_) {}
            }
          };
          actions.append(renderBtn);
        }
        const download = document.createElement('button');
        const remove = document.createElement('button');
        download.className = 'table-action';
        download.type = 'button';
        download.textContent = 'Download';
        remove.className = 'table-action danger';
        remove.type = 'button';
        remove.textContent = 'Delete';
        actions.append(download, remove);
        download.setAttribute('aria-label', `Download file ${displayName}`);
        remove.setAttribute('aria-label', `Delete file ${displayName}`);
        download.onclick = async () => {
          const result = await callApiRequest(
            `/dashboard/files/${encodeURIComponent(file.id)}/download`
          );
          window.open(result.url, '_blank', 'noopener');
        };
        remove.onclick = async () => {
          const name = displayName;
          if (
            !(await callConfirmAction({
              title: `Delete “${name}”?`,
              description:
                'This private file will be permanently deleted and can no longer be downloaded.',
              confirmLabel: 'Delete file',
            }))
          )
            return;
          try {
            await callApiRequest(`/dashboard/files/${encodeURIComponent(file.id)}`, {
              method: 'DELETE',
            });
            await refreshManagers();
            callSetNotice(document.getElementById('filesStatus'), 'File deleted.', 'success');
          } catch (error) {
            callSetNotice(
              document.getElementById('filesStatus'),
              `Could not delete this file. ${error.message}`,
              'error'
            );
          }
        };
        return {
          cells: [details, kind, actions],
          sortValues: [displayName, file.kind, file.createdAt || ''],
        };
      });
      if (fileRows.length) {
        callRenderTable(filesManager, {
          caption: 'Private files',
          columns: [
            { label: 'File' },
            { label: 'Kind' },
            { label: 'Actions', className: 'dashboard-table-actions-cell' },
          ],
          rows: fileRows,
        });
      }

      if (typeof global.renderBatchJobs === 'function') {
        global.renderBatchJobs(batchResult.jobs || [], { onRefreshManagers: refreshManagers });
      }
      managersLoaded = true;
    } catch (error) {
      const activeView = typeof global.activeDashboardView !== 'undefined' ? global.activeDashboardView : 'sources';
      const managerView = ['sources', 'files', 'batches'].includes(activeView)
        ? activeView
        : 'sources';
      const status = document.getElementById(`${managerView}Status`);
      const resource =
        managerView === 'files'
          ? 'private files'
          : managerView === 'batches'
            ? 'batch jobs'
            : 'saved sources';
      if (status) {
        callSetNotice(status, `Could not load ${resource}. ${error.message}`, 'error');
      }
    }
  }

  const moduleExports = {
    getSavedSources,
    setSavedSourceInventory,
    describeStoredSource,
    selectStoredSource,
    loadSavedSources,
    renderManagerEmpty,
    renderManagerLoading,
    openReusableAsset,
    refreshManagers,
  };

  Object.assign(global, moduleExports);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = moduleExports;
  }
})(typeof window === 'undefined' ? globalThis : window);
