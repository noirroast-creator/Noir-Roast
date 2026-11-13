// Three-bar menu: a slide-in drawer with Order now, About us and Gifts & Coupons.
(() => {
  const ITEMS = [
    { label: 'Order now', href: 'index.html#shop', page: '' },
    { label: 'About us', href: 'story.html', page: 'story.html' },
    { label: 'Gifts & Coupons', href: 'gifts.html', page: 'gifts.html' },
  ];
  const opener = document.querySelector('[data-menu-open]');
  if (!opener) return;

  const current = (window.location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const overlay = el('div', 'menu-overlay');
  const drawer = el('aside', 'menu-drawer');
  drawer.id = 'site-menu';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  drawer.setAttribute('aria-label', 'Menu');
  drawer.inert = true;

  const head = el('div', 'menu-head');
  const close = el('button', 'menu-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close menu');
  close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>';
  const logo = el('a', 'logo menu-logo', 'NOIR ROAST');
  logo.href = 'index.html';
  head.append(close, logo, el('span', 'menu-head-gap'));

  const list = el('ul', 'menu-list');
  ITEMS.forEach((item) => {
    const li = el('li');
    const a = el('a', '', '');
    a.href = item.href;
    a.append(el('span', 'menu-label', item.label));
    if (item.page && item.page === current) a.setAttribute('aria-current', 'page');
    li.append(a);
    list.append(li);
  });

  drawer.append(head, list);
  document.body.append(overlay, drawer);

  let lastFocus = null;
  const setOpen = (open) => {
    document.body.classList.toggle('menu-open', open);
    drawer.inert = !open;
    opener.setAttribute('aria-expanded', String(open));
    if (open) { lastFocus = document.activeElement; close.focus({ preventScroll: true }); }
    else if (lastFocus) { lastFocus.focus({ preventScroll: true }); lastFocus = null; }
  };

  opener.addEventListener('click', () => setOpen(true));
  close.addEventListener('click', () => setOpen(false));
  overlay.addEventListener('click', () => setOpen(false));
  list.addEventListener('click', (event) => { if (event.target.closest('a')) setOpen(false); });

  document.addEventListener('keydown', (event) => {
    if (!document.body.classList.contains('menu-open')) return;
    if (event.key === 'Escape') { setOpen(false); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...drawer.querySelectorAll('a[href], button')];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
})();
