// My Orders: shows the signed-in customer's own orders (the database only returns their own).
const $ = (selector) => document.querySelector(selector);
const rupee = (value) => '\u20B9' + Number(value).toLocaleString('en-IN');
const STATUS = { new: 'Order received', shipped: 'Shipped', delivered: 'Delivered' };

// Shipway's short status codes, in plain words.
const SHIPMENT = {
  SCH: 'Courier booked', RSCH: 'Pickup scheduled', RPKP: 'Picked up', INT: 'In transit', OOD: 'Out for delivery',
  DEL: 'Delivered', UND: 'Delivery attempted, will retry', ONH: 'On hold', NFI: 'Update pending', NFIDS: 'Update pending',
  RTO: 'Returning to us', RTD: 'Returned to us', CAN: 'Cancelled',
};

// Only ever link to normal web addresses.
const safeUrl = (value) => {
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : ''; } catch { return ''; }
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const sections = {
  loading: $('[data-loading]'),
  signedOut: $('[data-signed-out]'),
  empty: $('[data-empty]'),
  orders: $('[data-orders]'),
  error: $('[data-error]'),
  who: $('[data-who]'),
};

const show = (which) => {
  sections.loading.hidden = which !== 'loading';
  sections.signedOut.hidden = which !== 'signedOut';
  sections.empty.hidden = which !== 'empty';
  sections.orders.hidden = which !== 'orders';
  sections.error.hidden = which !== 'error';
  sections.who.hidden = which === 'signedOut' || which === 'loading';
};

const renderShipping = (order) => {
  if (!order.awb_number && !order.shipment_status) return null;
  const box = el('div', 'ac-ship');
  const label = SHIPMENT[order.shipment_status] || 'Shipped';
  box.append(el('p', 'ac-ship-status', label));
  const parts = [order.carrier_name, order.awb_number ? `Tracking no. ${order.awb_number}` : ''].filter(Boolean);
  if (parts.length) box.append(el('p', 'ac-ship-detail', parts.join(' · ')));
  const href = safeUrl(order.tracking_url);
  if (href) {
    const link = el('a', 'ac-ship-link', 'Track your parcel');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    box.append(link);
  }
  return box;
};

const renderOrder = (order) => {
  const li = el('li', 'ac-order');
  const top = el('div', 'ac-order-top');
  top.append(
    el('span', 'ac-number', order.order_number),
    el('span', 'ac-date', new Date(order.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })),
  );
  const chip = el('span', 'ac-chip', STATUS[order.status] || String(order.status || '').replace(/^./, (c) => c.toUpperCase()));
  const list = el('ul', 'ac-items');
  (order.order_items || []).forEach((item) => {
    const row = el('li');
    row.append(el('span', '', `${item.product_name} \u00D7 ${item.quantity}`), el('span', '', rupee(item.unit_price_inr * item.quantity)));
    list.append(row);
  });
  const total = el('div', 'ac-total');
  total.append(el('span', '', 'Total'), el('strong', '', rupee(order.total_inr)));
  li.append(top, chip, list);
  const shipping = renderShipping(order);
  if (shipping) li.append(shipping);
  li.append(total);
  return li;
};

const renderWho = (user) => {
  sections.who.replaceChildren();
  const out = el('button', 'auth-link', 'Sign out');
  out.type = 'button';
  out.addEventListener('click', async () => {
    try { await window.NoirData.signOut(); } catch { /* ignore */ }
    show('signedOut');
  });
  sections.who.append('Signed in as ', el('strong', '', user.email), out);
};

const load = async (user) => {
  if (!user) { show('signedOut'); return; }
  show('loading');
  renderWho(user);
  try {
    const orders = await window.NoirData.getMyOrders();
    if (!orders.length) { show('empty'); return; }
    sections.orders.replaceChildren(...orders.map(renderOrder));
    show('orders');
  } catch {
    sections.error.textContent = 'We couldn\u2019t load your orders just now. Please refresh the page to try again.';
    show('error');
    sections.who.hidden = false;
  }
};

$('[data-signin]').addEventListener('click', async () => {
  const user = await window.NoirAuthUI.open({ title: 'Sign in to see your orders' });
  if (user) load(user);
});

if (!window.NoirData || !window.NoirData.available) {
  sections.error.textContent = 'Sign-in is unavailable right now. Please try again shortly.';
  show('error');
  sections.who.hidden = true;
} else {
  window.NoirData.getUser().then(load);
  window.NoirData.onAuthChange((user) => { if (!user) show('signedOut'); });
}