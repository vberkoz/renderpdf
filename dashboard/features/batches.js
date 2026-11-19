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

  function callSetButtonPending(button, pending, pendingLabel) {
    if (typeof global.setButtonPending === 'function') {
      return global.setButtonPending(button, pending, pendingLabel);
    }
    if (button) button.disabled = pending;
  }

  let batchDataUploadError = '';

  function setBatchDataUploadError(err) {
    batchDataUploadError = err || '';
  }

  function getBatchDataUploadError() {
    return batchDataUploadError;
  }

  function batchSubmission() {
    const sourceID = document.getElementById('batchSourceSelect')?.value;
    if (!sourceID) throw new Error('Choose a saved source first.');
    let items;
    try {
      items = JSON.parse(document.getElementById('batchItemsInput')?.value || '');
    } catch (error) {
      throw new Error('Item data must be valid JSON.');
    }
    if (!Array.isArray(items) || items.length < 1 || items.length > 99)
      throw new Error('Provide a JSON array with 1–99 items.');
    const mergeOutput = Boolean(document.getElementById('batchMergeOutput')?.checked);
    return { sourceID, items, mergeOutput };
  }

  function updateBatchReview() {
    const review = document.getElementById('batchReview');
    if (!review) return null;
    const sourceID = document.getElementById('batchSourceSelect')?.value || '';
    const sourceName = [
      ...document.querySelectorAll('#batchSourceSelect-menu [data-custom-select-option]'),
    ]
      .find((option) => option.dataset.value === sourceID)
      ?.textContent?.trim();
    const input = document.getElementById('batchItemsInput')?.value || '';
    const steps = {
      source: Boolean(sourceID),
      data: false,
      review: false,
      submit: false,
    };
    let items;
    let message = 'Choose a saved source and add item data to review this batch.';
    let state = 'pending';

    if (sourceID) {
      message = 'Add a JSON array with 1–99 items to continue.';
      try {
        if (batchDataUploadError) throw new Error(batchDataUploadError);
        items = JSON.parse(input);
        if (!Array.isArray(items)) {
          message = 'Item data must be a JSON array.';
          state = 'error';
        } else if (items.length < 1 || items.length > 99) {
          message = 'Provide a JSON array with 1–99 items.';
          state = 'error';
        } else {
          steps.data = true;
          steps.review = true;
          steps.submit = true;
          const mergeOutput = Boolean(document.getElementById('batchMergeOutput')?.checked);
          message = mergeOutput
            ? `Ready to render and merge ${items.length} PDF${items.length === 1 ? '' : 's'} into a single document from ${sourceName || 'the selected source'}.`
            : `Ready to render ${items.length} PDF${items.length === 1 ? '' : 's'} from ${sourceName || 'the selected source'}.`;
          state = 'success';
        }
      } catch (error) {
        if (batchDataUploadError) {
          message = batchDataUploadError;
          state = 'error';
        } else if (input.trim()) {
          message = 'Item data must be valid JSON.';
          state = 'error';
        }
      }
    }

    review.textContent = message;
    review.dataset.state = state;
    const submitBtn = document.getElementById('submitBatchBtn');
    if (submitBtn) submitBtn.disabled = !steps.submit;
    Object.entries(steps).forEach(([step, complete]) => {
      document
        .querySelector(`[data-batch-step="${step}"]`)
        ?.classList.toggle('is-ready', complete || (step === 'source' && !steps.source));
    });
    return steps.submit ? { sourceID, items } : null;
  }

  function renderBatchJobs(jobs, options = {}) {
    const batchesManager = document.getElementById('batchesManager');
    if (!batchesManager) return;
    const { onRefreshManagers } = options;
    if (!jobs.length) {
      if (typeof global.renderManagerEmpty === 'function') {
        global.renderManagerEmpty(
          batchesManager,
          'No batch jobs yet',
          'Choose a saved source and add item data to submit your first batch.'
        );
      }
      return;
    }
    const rows = jobs.map((job) => {
      const details = document.createElement('div');
      const name = document.createElement('strong');
      const meta = document.createElement('span');
      details.append(name, meta);
      name.textContent = job.jobId;
      const finished =
        (job.succeededCount || 0) + (job.failedCount || 0) + (job.cancelledCount || 0);
      const createdAt = job.createdAt
        ? new Date(job.createdAt).toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : 'Date unavailable';
      meta.textContent = `${finished}/${job.itemCount} finished · ${job.succeededCount || 0} PDFs · ${createdAt}`;
      const status = document.createElement('span');
      status.textContent = job.status;
      const actions = document.createElement('div');
      if ((job.succeededCount || 0) > 0) {
        const download = document.createElement('button');
        download.className = 'table-action';
        download.type = 'button';
        download.textContent = 'Download ZIP';
        download.setAttribute('aria-label', `Download ZIP for batch ${job.jobId}`);
        download.onclick = async () => {
          const result = await callApiRequest(
            `/dashboard/batches/${encodeURIComponent(job.jobId)}/download?format=zip`
          );
          window.open(result.url, '_blank', 'noopener');
        };
        actions.append(download);

        const downloadPdf = document.createElement('button');
        downloadPdf.className = 'table-action';
        downloadPdf.type = 'button';
        downloadPdf.textContent = 'Download PDF';
        downloadPdf.setAttribute('aria-label', `Download merged PDF for batch ${job.jobId}`);
        downloadPdf.onclick = async () => {
          const result = await callApiRequest(
            `/dashboard/batches/${encodeURIComponent(job.jobId)}/download?format=pdf`
          );
          window.open(result.url, '_blank', 'noopener');
        };
        actions.append(downloadPdf);
      }
      if (job.status === 'queued' || job.status === 'running') {
        const cancel = document.createElement('button');
        cancel.className = 'table-action';
        cancel.type = 'button';
        cancel.textContent = 'Cancel batch';
        cancel.setAttribute('aria-label', `Cancel batch ${job.jobId}`);
        cancel.onclick = async () => {
          if (
            !(await callConfirmAction({
              title: `Cancel batch “${job.jobId}”?`,
              description: 'Pending PDFs in this batch will not be rendered.',
              confirmLabel: 'Cancel batch',
            }))
          )
            return;
          await callApiRequest(`/dashboard/batches/${encodeURIComponent(job.jobId)}/cancel`, {
            method: 'POST',
          });
          if (typeof onRefreshManagers === 'function') {
            await onRefreshManagers();
          } else if (typeof global.refreshManagers === 'function') {
            await global.refreshManagers();
          }
        };
        actions.append(cancel);
      }
      return {
        cells: [details, status, actions],
        sortValues: [job.jobId, job.status, job.createdAt || ''],
      };
    });
    callRenderTable(batchesManager, {
      caption: 'Batch jobs',
      columns: [
        { label: 'Batch' },
        { label: 'Status' },
        { label: 'Actions', className: 'dashboard-table-actions-cell' },
      ],
      rows,
    });
  }

  const moduleExports = {
    batchSubmission,
    updateBatchReview,
    renderBatchJobs,
    setBatchDataUploadError,
    getBatchDataUploadError,
  };

  Object.assign(global, moduleExports);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = moduleExports;
  }
})(typeof window === 'undefined' ? globalThis : window);
