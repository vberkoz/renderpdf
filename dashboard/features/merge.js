(function (global) {
  'use strict';

  function initMergeFeature() {
    const mergeFilesContainer = document.getElementById('mergeFilesContainer');
    const mergeNotice = document.getElementById('mergeNotice');
    const mergeResult = document.getElementById('mergeResult');
    const refreshMergeFilesBtn = document.getElementById('refreshMergeFilesBtn');
    const submitMergeBtn = document.getElementById('submitMergeBtn');

    async function loadMergeFiles() {
      if (!mergeFilesContainer) return;
      mergeFilesContainer.innerHTML = '<p class="empty-state">Loading PDF files...</p>';
      try {
        const reqFn = global.managedRequest || global.apiRequest;
        if (!reqFn) return;
        const data = await reqFn('/dashboard/files');
        const files = (data.files || []).filter(
          (f) =>
            f.kind === 'rendered_pdf' ||
            (f.displayName && f.displayName.toLowerCase().endsWith('.pdf'))
        );
        if (!files.length) {
          mergeFilesContainer.innerHTML =
            '<p class="empty-state">No rendered PDFs available to merge. Create some PDFs first.</p>';
          updateMergeSubmitState();
          return;
        }
        mergeFilesContainer.innerHTML = '';
        files.forEach((file) => {
          const item = document.createElement('label');
          item.className = 'merge-file-item';
          item.style.display = 'flex';
          item.style.alignItems = 'center';
          item.style.gap = '10px';
          item.style.padding = '10px 14px';
          item.style.border = '1px solid var(--line, #1e2d44)';
          item.style.borderRadius = 'var(--radius-sm, 6px)';
          item.style.marginBottom = '8px';
          item.style.cursor = 'pointer';
          item.style.background = 'var(--card-bg, #151f33)';

          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.dataset.mergeFileId = file.id;
          cb.style.width = '16px';
          cb.style.height = '16px';
          cb.style.accentColor = 'var(--accent, #3b82f6)';
          cb.addEventListener('change', updateMergeSubmitState);

          const info = document.createElement('div');
          info.style.flex = '1';
          const name = document.createElement('strong');
          name.style.display = 'block';
          name.style.fontSize = '14px';
          name.textContent = file.displayName || file.id;
          const meta = document.createElement('span');
          meta.style.fontSize = '12px';
          meta.style.color = 'var(--muted, #94a3b8)';
          meta.textContent = `${(file.sizeBytes / 1024).toFixed(1)} KB · ${file.createdAt ? new Date(file.createdAt).toLocaleDateString() : ''}`;
          info.append(name, meta);

          item.append(cb, info);
          mergeFilesContainer.append(item);
        });
        updateMergeSubmitState();
      } catch (error) {
        mergeFilesContainer.innerHTML = `<p class="empty-state">Could not load files. ${error.message}</p>`;
      }
    }

    function updateMergeSubmitState() {
      const selected = document.querySelectorAll('input[data-merge-file-id]:checked');
      if (submitMergeBtn) {
        submitMergeBtn.disabled = selected.length < 2;
        submitMergeBtn.textContent =
          selected.length >= 2 ? `Merge ${selected.length} PDFs` : 'Merge PDFs';
      }
    }

    if (refreshMergeFilesBtn) {
      refreshMergeFilesBtn.addEventListener('click', loadMergeFiles);
    }

    if (submitMergeBtn) {
      submitMergeBtn.addEventListener('click', async () => {
        const selected = Array.from(
          document.querySelectorAll('input[data-merge-file-id]:checked')
        ).map((cb) => cb.dataset.mergeFileId);
        if (selected.length < 2) {
          if (global.setNotice) global.setNotice(mergeNotice, 'Please select at least 2 PDFs to merge.', 'error');
          return;
        }
        if (global.setNotice) global.setNotice(mergeNotice);
        if (global.setButtonPending) global.setButtonPending(submitMergeBtn, true, 'Merging PDFs...');
        if (global.setNotice) global.setNotice(mergeResult, 'Concatenating selected PDFs...', 'pending');
        try {
          const options = {};
          const watermark = document.getElementById('mergeWatermarkInput')?.value?.trim();
          if (watermark) options.watermark = { text: watermark };
          const password = document.getElementById('mergePasswordInput')?.value;
          if (password) options.password = password;
          const pageNumbers = document.getElementById('mergePageNumberFormat')?.value?.trim();
          if (pageNumbers) options.pageNumbers = { format: pageNumbers };

          const payload = {
            version: '1',
            files: selected,
            ...(Object.keys(options).length > 0 ? { options } : {}),
          };
          const reqFn = global.managedRequest || global.apiRequest;
          const result = await reqFn('/dashboard/merge', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
          mergeResult.dataset.state = 'success';
          mergeResult.replaceChildren();
          const summary = document.createElement('div');
          const title = document.createElement('strong');
          title.textContent = 'Merged PDF ready';
          const detail = document.createElement('span');
          detail.textContent = `${(result.size / 1024).toFixed(1)} KB · ${result.pageCount} pages`;
          summary.append(title, detail);
          const link = document.createElement('a');
          link.href = result.url;
          link.target = '_blank';
          link.rel = 'noopener';
          link.download = '';
          link.textContent = 'Download merged PDF →';
          mergeResult.append(summary, link);
          mergeResult.hidden = false;
          if (typeof global.refreshManagers === 'function') global.refreshManagers();
        } catch (error) {
          if (global.setNotice) global.setNotice(mergeResult, `Could not merge PDFs. ${error.message}`, 'error');
        } finally {
          if (global.setButtonPending) global.setButtonPending(submitMergeBtn, false);
        }
      });
    }

    return {
      loadMergeFiles,
      updateMergeSubmitState,
    };
  }

  const moduleExports = {
    initMergeFeature,
  };

  global.initMergeFeature = initMergeFeature;

  Object.assign(global, moduleExports);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = moduleExports;
  }
})(typeof window === 'undefined' ? globalThis : window);
