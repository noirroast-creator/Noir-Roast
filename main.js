// NOIR ROAST: order-goal progress + shopping cart drawer.
const DELIVERY_DAYS = 7;
const STORAGE_KEY = 'noir-roast-cart';

const rupee = (value) => '\u20B9' + value.toLocaleString('en-IN');

const renderProgress = ({ placed, goal }) => {
  const percent = Math.min(placed / goal, 1) * 100;
  document.querySelectorAll('[data-orders]').forEach((el) => { el.textContent = placed; });
  document.querySelectorAll('[data-goal-number]').forEach((el) => { el.textContent = goal; });
  document.querySelectorAll('[data-goal-formatted]').forEach((el) => { el.textContent = goal.toLocaleString('en-IN'); });
  document.querySelectorAll('[data-remaining]').forEach((el) => { el.textContent = Math.max(goal - placed, 0); });

  const track = document.querySelector('[data-progress]');
  if (!track) return;
  track.style.setProperty('--progress', `${percent}%`);
  track.setAttribute('aria-valuenow', placed);
  track.setAttribute('aria-valuemax', goal);
};

const formatDeliveryDate = (daysAhead) => {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      .formatToParts(date).map((p) => [p.type, p.value]),
  );
  return `${parts.weekday}, ${parts.day} ${parts.month} ${parts.year}`;
};

const loadCart = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return new Map(saved.filter((i) => i && i.id && i.qty > 0).map((i) => [i.id, i]));
  } catch { return new Map(); }
};
const saveCart = (cart) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...cart.values()])); } catch { /* storage unavailable */ }
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const iconButton = (action, label, pathD) => {
  const btn = el('button', 'cart-icon-btn');
  btn.type = 'button';
  btn.dataset.act = action;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${pathD}"/></svg>`;
  return btn;
};

const initCart = () => {
  const drawer = document.getElementById('cart');
  const overlay = document.querySelector('[data-cart-overlay]');
  const list = document.querySelector('[data-cart-items]');
  const status = document.querySelector('[data-status]');
  const bag = document.querySelector('[data-bag]');
  const badge = document.querySelector('[data-bag-count]');
  const closeButton = drawer.querySelector('.cart-close');
  const q = (s) => drawer.querySelector(s);
  const cart = loadCart();
  // Keep saved bag prices in step with the current catalogue (prices live on the Add to bag buttons).
  document.querySelectorAll('[data-add]').forEach((button) => {
    const saved = cart.get(button.dataset.id);
    if (saved) saved.price = Number(button.dataset.price);
  });
  let lastFocus = null;

  const render = () => {
    const items = [...cart.values()];
    const count = items.reduce((n, i) => n + i.qty, 0);
    const subtotal = items.reduce((n, i) => n + i.qty * i.price, 0);

    list.replaceChildren(...items.map((item) => {
      const li = el('li', 'cart-item');
      li.dataset.id = item.id;
      const img = el('img'); img.src = item.img; img.alt = ''; img.width = 80; img.height = 96;
      const info = el('div', 'cart-item-info');
      info.append(el('p', 'cart-item-name', item.name), el('p', 'cart-item-sub', item.sub));
      const stepper = el('div', 'cart-stepper');
      const minus = iconButton('dec', `Decrease quantity of ${item.name}`, 'M6 12h12');
      const plus = iconButton('inc', `Increase quantity of ${item.name}`, 'M6 12h12M12 6v12');
      if (item.qty <= 1) minus.disabled = true;
      stepper.append(minus, el('span', 'cart-qty', String(item.qty)), plus);
      const foot = el('div', 'cart-item-foot');
      const remove = iconButton('remove', `Remove ${item.name}`, 'M4 7h16M10 11v6M14 11v6M6 7l1 12a1.5 1.5 0 0 0 1.5 1.4h7A1.5 1.5 0 0 0 17 19l1-12M9 7V4.5h6V7');
      foot.append(stepper, el('span', 'cart-item-price', rupee(item.price * item.qty)), remove);
      info.append(foot);
      li.append(img, info);
      return li;
    }));

    document.querySelector('[data-cart-count]').textContent = count;
    badge.textContent = count;
    badge.hidden = count === 0;
    bag.setAttribute('aria-label', `Shopping bag, ${count} item${count === 1 ? '' : 's'}`);

    q('[data-cart-empty]').hidden = count > 0;
    q('[data-cart-summary]').hidden = count === 0;
    q('[data-cart-total]').textContent = rupee(subtotal);
    q('[data-cart-eta]').textContent = formatDeliveryDate(DELIVERY_DAYS);
    saveCart(cart);
  };

  const focusables = () => [...drawer.querySelectorAll('button:not([disabled]), a[href]')].filter((n) => !n.closest('[hidden]'));

  const open = () => {
    if (drawer.classList.contains('is-open')) return;
    lastFocus = document.activeElement;
    drawer.removeAttribute('inert');
    drawer.classList.add('is-open');
    overlay.classList.add('is-open');
    document.body.classList.add('cart-open');
    closeButton.focus({ preventScroll: true });
  };
  const close = () => {
    if (!drawer.classList.contains('is-open')) return;
    drawer.classList.remove('is-open');
    overlay.classList.remove('is-open');
    drawer.setAttribute('inert', '');
    document.body.classList.remove('cart-open');
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  };

  const change = (id, delta) => {
    const item = cart.get(id);
    if (!item) return;
    item.qty = Math.min(Math.max(item.qty + delta, 1), 20);
    status.textContent = `${item.name} quantity ${item.qty}.`;
    render();
  };
  const remove = (id) => {
    const item = cart.get(id);
    if (!item) return;
    cart.delete(id);
    status.textContent = `${item.name} removed from bag.`;
    render();
  };

  document.querySelectorAll('[data-add]').forEach((button) => {
    const label = button.innerHTML;
    button.addEventListener('click', () => {
      const { id, price, sub, img, add } = button.dataset;
      const existing = cart.get(id);
      if (existing) existing.qty = Math.min(existing.qty + 1, 20);
      else cart.set(id, { id, name: add, sub, img, price: Number(price), qty: 1 });
      status.textContent = `${add} added to bag.`;
      render();
      button.textContent = 'Added \u2713';
      window.setTimeout(() => { button.innerHTML = label; }, 1200);
      open();
    });
  });

  bag.addEventListener('click', (event) => { event.preventDefault(); open(); });
  overlay.addEventListener('click', close);
  drawer.querySelectorAll('[data-cart-close]').forEach((n) => n.addEventListener('click', close));
  list.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('.cart-item').dataset.id;
    if (btn.dataset.act === 'inc') change(id, 1);
    if (btn.dataset.act === 'dec') change(id, -1);
    if (btn.dataset.act === 'remove') remove(id);
  });
  q('[data-cart-view]').addEventListener('click', () => {
    close();
    document.getElementById('shop').scrollIntoView({ behavior: 'smooth' });
  });
  q('[data-cart-checkout]').addEventListener('click', () => {
    saveCart(cart);
    window.location.href = 'checkout.html';
  });

  document.addEventListener('keydown', (event) => {
    if (!drawer.classList.contains('is-open')) return;
    if (event.key === 'Escape') { close(); return; }
    if (event.key !== 'Tab') return;
    const nodes = focusables();
    if (!nodes.length) return;
    const first = nodes[0]; const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  render();
};

// Real order counter from Supabase, updated live as new orders arrive.
if (window.NoirData && window.NoirData.available) {
  window.NoirData.getStats().then(renderProgress).catch((err) => console.warn('Order counter unavailable', err));
  window.NoirData.subscribeStats(renderProgress);
}
initCart();