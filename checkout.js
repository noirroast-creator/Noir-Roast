// NOIR ROAST checkout: shipping form -> confirmation. Reads the cart saved by the shop page.
const STORAGE_KEY = 'noir-roast-cart';
const FREE_SHIPPING_OVER = 1000;
const DELIVERY_FEE = 69;
const DELIVERY_DAYS = 7;

const STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
  'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana',
  'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
];

const $ = (selector, root = document) => root.querySelector(selector);
const rupee = (value) => '\u20B9' + value.toLocaleString('en-IN');

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
    return saved.filter((i) => i && i.id && i.qty > 0 && Number.isFinite(Number(i.price)));
  } catch { return []; }
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const items = loadCart();
const status = $('[data-status]');

/* ---------- summary ---------- */
const renderSummary = () => {
  $('[data-items]').replaceChildren(...items.map((item) => {
    const li = el('li', 'co-item');
    const img = el('img'); img.src = item.img; img.alt = ''; img.width = 56; img.height = 66;
    const info = el('div');
    info.append(el('p', 'co-item-name', item.name), el('p', 'co-item-qty', `Qty: ${item.qty}`));
    li.append(img, info, el('span', 'co-item-price', rupee(item.qty * Number(item.price))));
    return li;
  }));
  const subtotal = items.reduce((n, i) => n + i.qty * Number(i.price), 0);
  const delivery = subtotal >= FREE_SHIPPING_OVER ? 0 : DELIVERY_FEE;
  $('[data-sum-subtotal]').textContent = rupee(subtotal);
  $('[data-sum-delivery-row]').hidden = delivery === 0;
  $('[data-sum-delivery]').textContent = rupee(delivery);
  $('[data-sum-total]').textContent = rupee(subtotal + delivery);
};

/* ---------- form ---------- */
const form = $('#ship-form');
const stateSelect = $('#f-state');
STATES.forEach((name) => { const o = el('option', '', name); o.value = name; stateSelect.append(o); });

const rules = {
  name: (v) => (v.trim().length < 2 ? 'Please enter your full name.' : ''),
  email: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? '' : 'Please enter a valid email address.'),
  phone: (v) => (/^[6-9]\d{9}$/.test(v.trim()) ? '' : 'Enter a 10-digit Indian mobile number.'),
  addr1: (v) => (v.trim().length < 3 ? 'Please enter your address.' : ''),
  city: (v) => (v.trim().length < 2 ? 'Please enter your city.' : ''),
  state: (v) => (v ? '' : 'Please select your state.'),
  pin: (v) => (/^[1-9]\d{5}$/.test(v.trim()) ? '' : 'Enter a valid 6-digit PIN code.'),
};

const field = (name) => form.elements[name];
const setError = (name, message) => {
  const input = field(name);
  const out = $(`#e-${name}`);
  input.closest('.field').classList.toggle('has-error', Boolean(message));
  if (message) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', out.id); } else { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
  out.textContent = message;
};
const validate = (name) => { const message = rules[name](field(name).value); setError(name, message); return !message; };

Object.keys(rules).forEach((name) => {
  const input = field(name);
  input.addEventListener('blur', () => { if (input.value || input.closest('.field').classList.contains('has-error')) validate(name); });
  input.addEventListener('input', () => { if (input.closest('.field').classList.contains('has-error')) validate(name); });
  input.addEventListener('change', () => { if (name === 'state') validate(name); });
});
['phone', 'pin'].forEach((name) => field(name).addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, ''); }));

const ERRORS = {
  invalid_name: ['name', 'Please enter your full name.'],
  invalid_email: ['email', 'Please enter a valid email address.'],
  invalid_phone: ['phone', 'Enter a 10-digit Indian mobile number.'],
  invalid_address: ['addr1', 'Please check your address.'],
  invalid_city: ['city', 'Please enter your city.'],
  invalid_state: ['state', 'Please select your state.'],
  invalid_pin: ['pin', 'Enter a valid 6-digit PIN code.'],
};
const formError = $('[data-form-error]');
const submitButton = $('.co-submit', form);
const submitLabel = submitButton.innerHTML;
const showFormError = (message) => { formError.textContent = message; formError.hidden = !message; };

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showFormError('');
  const results = Object.keys(rules).map((name) => [name, validate(name)]);
  const firstBad = results.find(([, ok]) => !ok);
  if (firstBad) { field(firstBad[0]).focus(); status.textContent = 'Please fix the highlighted fields.'; return; }

  const shipping = Object.fromEntries(new FormData(form).entries());
  submitButton.disabled = true;
  submitButton.textContent = 'Placing your order\u2026';
  try {
    if (!window.NoirData || !window.NoirData.available) throw new Error('unavailable');
    const order = await window.NoirData.placeOrder(shipping, items.map((i) => ({ id: i.id, qty: i.qty })));
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
    $('[data-done-name]').textContent = shipping.name.trim().split(/\s+/)[0];
    $('[data-done-id]').textContent = order.order_number;
    $('[data-done-total]').textContent = rupee(Number(order.total));
    $('[data-done-eta]').textContent = formatDeliveryDate(DELIVERY_DAYS);
    $('[data-step="1"]').hidden = true;
    $('[data-done]').hidden = false;
    document.body.classList.add('is-done');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    $('#done-title').focus({ preventScroll: true });
  } catch (err) {
    const known = ERRORS[err && err.message];
    if (known) { setError(known[0], known[1]); field(known[0]).focus(); showFormError('Please fix the highlighted field.'); }
    else showFormError('We couldn\u2019t place your order just now. Please check your connection and try again.');
    submitButton.disabled = false;
    submitButton.innerHTML = submitLabel;
  }
});

/* ---------- init ---------- */
if (items.length === 0) {
  document.body.classList.add('is-empty');
  $('[data-step="1"]').hidden = true;
  $('[data-empty]').hidden = false;
  $('.co-steps').hidden = true;
} else {
  renderSummary();
}