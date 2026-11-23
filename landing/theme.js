(() => {
  const KEY = 'ds-scheme';
  const meta = () => document.querySelector('meta[name="color-scheme"]');
  const set = (v) => {
    const m = meta();
    if (m) m.content = v;
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-action="theme"]')) return;
    const next = meta()?.content === 'light' ? 'dark' : 'light';
    set(next);
    try { localStorage.setItem(KEY, next); } catch {}
  });
  window.addEventListener('storage', (e) => {
    if (e.key === KEY && (e.newValue === 'light' || e.newValue === 'dark')) set(e.newValue);
  });
})();
