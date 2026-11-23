(function (global) {
  'use strict';

  function showDashboardDialog({
    title,
    description,
    kicker,
    label = 'Name',
    value = '',
    confirmLabel = 'Save',
    requiresText = true,
    destructive = false,
  }) {
    const dialog = document.getElementById('dashboardTextDialog');
    const form = document.getElementById('dashboardTextDialogForm');
    const input = document.getElementById('dashboardDialogInput');
    const field = document.getElementById('dashboardDialogField');
    const cancelButton = document.getElementById('dashboardDialogCancel');
    const confirmButton = document.getElementById('dashboardDialogConfirm');
    if (!dialog || !form || !input || !confirmButton) return Promise.resolve(null);

    const kickerEl = document.getElementById('dashboardDialogKicker');
    if (kickerEl) {
      kickerEl.textContent = kicker || (requiresText ? 'Saved source' : 'Confirm action');
    }
    document.getElementById('dashboardDialogTitle').textContent = title;
    document.getElementById('dashboardDialogDescription').textContent = description;
    document.getElementById('dashboardDialogLabel').textContent = label;
    confirmButton.textContent = confirmLabel;
    if (field) field.hidden = !requiresText;
    input.required = requiresText;
    confirmButton.classList.toggle('dashboard-button-danger', destructive);
    confirmButton.classList.toggle('dashboard-button-primary', !destructive);
    input.value = value;
    input.setCustomValidity('');

    return new Promise((resolve) => {
      let settled = false;
      const cleanup = () => {
        form.removeEventListener('submit', onSubmit);
        cancelButton?.removeEventListener('click', onCancel);
        dialog.removeEventListener('cancel', onCancel);
        dialog.removeEventListener('close', onClose);
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (dialog.open) dialog.close();
        resolve(result);
      };
      const onSubmit = (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (requiresText && !text) {
          input.setCustomValidity(`${label} is required`);
          input.reportValidity();
          return;
        }
        finish(requiresText ? text : true);
      };
      const onCancel = (event) => {
        event?.preventDefault();
        finish(requiresText ? null : false);
      };
      const onClose = () => finish(null);
      form.addEventListener('submit', onSubmit);
      cancelButton?.addEventListener('click', onCancel);
      dialog.addEventListener('cancel', onCancel);
      dialog.addEventListener('close', onClose);
      dialog.showModal();
      if (typeof window !== 'undefined' && window.requestAnimationFrame) {
        window.requestAnimationFrame(() => {
          if (requiresText) {
            input.focus();
            input.select();
          } else {
            confirmButton.focus();
          }
        });
      }
    });
  }

  function promptDashboardText(options) {
    return showDashboardDialog({ ...options, requiresText: true });
  }

  function confirmDashboardAction(options) {
    return showDashboardDialog({ ...options, requiresText: false, destructive: true });
  }

  const moduleExports = {
    showDashboardDialog,
    promptDashboardText,
    confirmDashboardAction,
  };

  global.confirmDashboardAction = confirmDashboardAction;
  global.promptDashboardText = promptDashboardText;
  global.dashboardDialog = { promptText: promptDashboardText, confirm: confirmDashboardAction };

  Object.assign(global, moduleExports);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = moduleExports;
  }
})(typeof window === 'undefined' ? globalThis : window);
