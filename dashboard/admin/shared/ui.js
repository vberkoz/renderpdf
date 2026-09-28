/**
 * Shared UI Primitives for RenderPDF Admin Console
 * Accessible modals, focus management, and toasts.
 */

let activeModal = null;
let lastFocusedElement = null;

/**
 * Opens an accessible modal dialog and traps keyboard focus.
 * @param {HTMLElement} modalEl - The modal container element
 */
export function openModal(modalEl) {
  if (!modalEl) return;
  lastFocusedElement = document.activeElement;
  activeModal = modalEl;

  modalEl.removeAttribute('hidden');
  modalEl.setAttribute('aria-modal', 'true');
  modalEl.setAttribute('role', 'dialog');

  // Focus the first input or cancel button
  const focusable = modalEl.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  if (focusable.length > 0) {
    focusable[0].focus();
  }

  document.addEventListener('keydown', handleModalKeyDown);
}

/**
 * Closes the active modal and restores focus.
 * @param {HTMLElement} modalEl - The modal container element
 */
export function closeModal(modalEl) {
  const target = modalEl || activeModal;
  if (!target) return;

  target.setAttribute('hidden', '');
  target.removeAttribute('aria-modal');

  document.removeEventListener('keydown', handleModalKeyDown);
  activeModal = null;

  if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
    lastFocusedElement.focus();
    lastFocusedElement = null;
  }
}

function handleModalKeyDown(e) {
  if (!activeModal) return;

  if (e.key === 'Escape') {
    closeModal(activeModal);
    return;
  }

  if (e.key === 'Tab') {
    const focusable = activeModal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

/**
 * Shows a temporary toast banner.
 * @param {string} message - Message to display
 * @param {'info' | 'success' | 'error' | 'warning'} [type='info'] - Toast category
 */
export function showToast(message, type = 'info') {
  let toastContainer = document.getElementById('admin-toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'admin-toast-container';
    toastContainer.className = 'admin-toast-container';
    toastContainer.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastContainer);
  }

  const toast = document.createElement('div');
  toast.className = `admin-toast admin-toast-${type}`;
  toast.textContent = message;

  toastContainer.appendChild(toast);

  window.setTimeout(() => {
    toast.classList.add('fade-out');
    toast.addEventListener('transitionend', () => toast.remove());
  }, 3500);
}
