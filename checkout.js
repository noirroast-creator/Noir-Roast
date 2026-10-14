// NOIR ROAST checkout: shipping form -> confirmation. Reads the cart saved by the shop page.
const STORAGE_KEY = 'noir-roast-cart';
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
  $('[data-sum-total]').textContent = rupee(subtotal);
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

/* ---------- Razorpay Checkout ---------- */
const loadRazorpay = () => new Promise((resolve, reject) => {
  if (window.Razorpay) { resolve(); return; }
  const script = document.createElement('script');
  script.src = 'https://checkout.razorpay.com/v1/checkout.js';
  script.onload = () => resolve();
  script.onerror = () => reject(new Error('razorpay_script'));
  document.head.append(script);
});

// Resolves { paid: true, response } after payment, or { paid: false, failure? } if the customer closes it.
const payWithRazorpay = async (payment, shipping) => {
  await loadRazorpay();
  return new Promise((resolve) => {
    let failure = '';
    const checkout = new window.Razorpay({
      key: payment.key_id,
      order_id: payment.razorpay_order_id,
      amount: payment.amount,
      currency: payment.currency,
      name: 'NOIR ROAST',
      description: `Order ${payment.order_number}`,
      prefill: { name: shipping.name, email: shipping.email, contact: shipping.phone },
      notes: { order_number: payment.order_number },
      theme: { color: '#45291a' },
      handler: (response) => resolve({ paid: true, response }),
      modal: { ondismiss: () => resolve({ paid: false, failure }) },
    });
    checkout.on('payment.failed', (event) => { failure = (event && event.error && event.error.description) || 'payment failed'; });
    checkout.open();
  });
};

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

/* ---------- account: sign in with an emailed code when "Place order" is pressed ---------- */
const accountLine = $('[data-account]');
const emailField = field('email');
let currentUser = null;
let prefilled = false;

const renderAccount = () => {
  accountLine.replaceChildren();
  if (currentUser) {
    const who = el('strong', '', currentUser.email);
    const out = el('button', 'auth-link', 'Not you? Sign out');
    out.type = 'button';
    out.dataset.signout = '';
    accountLine.append('Signed in as ', who, ' \u00b7 ', out);
  } else if (window.NoirData && window.NoirData.available) {
    const signin = el('button', 'auth-link', 'Sign in');
    signin.type = 'button';
    signin.dataset.signin = '';
    accountLine.append('Returning customer? ', signin);
  }
};

// Fills only empty fields, from the customer's latest order.
const prefillFromLastOrder = async () => {
  if (prefilled) return;
  prefilled = true;
  try {
    const last = await window.NoirData.getLastShipping();
    if (!last) return;
    const map = { name: last.full_name, phone: last.phone, addr1: last.address_line1, addr2: last.address_line2, city: last.city, state: last.state, pin: last.pin_code, landmark: last.landmark };
    Object.entries(map).forEach(([name, value]) => { if (value && !field(name).value) field(name).value = value; });
  } catch { /* nothing to pre-fill */ }
};

const applyUser = (user) => {
  currentUser = user || null;
  if (currentUser) {
    emailField.value = currentUser.email;
    emailField.readOnly = true;
    setError('email', '');
    prefillFromLastOrder();
  } else {
    emailField.readOnly = false;
    prefilled = false;
  }
  renderAccount();
};

accountLine.addEventListener('click', async (event) => {
  if (event.target.closest('[data-signout]')) {
    try { await window.NoirData.signOut(); } catch { /* ignore */ }
    applyUser(null);
  } else if (event.target.closest('[data-signin]')) {
    const user = await window.NoirAuthUI.open({ title: 'Welcome back', email: emailField.value });
    if (user) applyUser(user);
  }
});

if (window.NoirData && window.NoirData.available) {
  window.NoirData.getUser().then(applyUser);
  window.NoirData.onAuthChange(applyUser);
}
renderAccount();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showFormError('');
  const results = Object.keys(rules).map((name) => [name, validate(name)]);
  const firstBad = results.find(([, ok]) => !ok);
  if (firstBad) { field(firstBad[0]).focus(); status.textContent = 'Please fix the highlighted fields.'; return; }

  submitButton.disabled = true;
  try {
    if (!window.NoirData || !window.NoirData.available) throw new Error('unavailable');

    // Sign in first (an emailed code), then carry straight on and place the order.
    if (!currentUser) {
      const user = await window.NoirAuthUI.open({ title: 'One last step', email: emailField.value });
      if (!user) {
        submitButton.disabled = false;
        submitButton.focus({ preventScroll: true });
        showFormError('Please sign in to place your order. We only email you a code, no password.');
        return;
      }
      applyUser(user);
    }

    submitButton.textContent = 'Starting secure payment\u2026';
    const shipping = Object.fromEntries(new FormData(form).entries());
    const payment = await window.NoirData.createPayment(shipping, items.map((i) => ({ id: i.id, qty: i.qty })));

    submitButton.textContent = 'Waiting for payment\u2026';
    const result = await payWithRazorpay(payment, shipping);
    if (!result.paid) {
      submitButton.disabled = false;
      submitButton.innerHTML = submitLabel;
      submitButton.focus({ preventScroll: true });
      showFormError(result.failure
        ? `Your payment didn\u2019t go through (${result.failure}). Your bag is safe, so you can try again.`
        : 'Payment wasn\u2019t completed. Your bag is safe, so you can try again whenever you\u2019re ready.');
      return;
    }

    // Paid. Confirm it with our server; if that call fails the payment is still safe (Razorpay also notifies us).
    submitButton.textContent = 'Confirming your payment\u2026';
    let confirmed = null;
    try { confirmed = await window.NoirData.verifyPayment(result.response); } catch { /* shown below */ }
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
    $('[data-done-name]').textContent = shipping.name.trim().split(/\s+/)[0];
    $('[data-done-id]').textContent = payment.order_number;
    $('[data-done-total]').textContent = rupee(Number(confirmed ? confirmed.total : payment.amount / 100));
    $('[data-done-eta]').textContent = formatDeliveryDate(DELIVERY_DAYS);
    const note = $('[data-done-note]');
    note.textContent = confirmed ? '' : `We received your payment (${result.response.razorpay_payment_id}) but couldn\u2019t confirm it on screen. It will show under My Orders shortly. Keep this number if you need help.`;
    note.hidden = Boolean(confirmed);
    $('[data-step="1"]').hidden = true;
    $('[data-done]').hidden = false;
    document.body.classList.add('is-done');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    $('#done-title').focus({ preventScroll: true });
  } catch (err) {
    const known = ERRORS[err && err.message];
    if (err && (err.message === 'not_signed_in' || /jwt/i.test(err.message || ''))) {
      applyUser(null);
      showFormError('Your sign-in has expired. Please press Place order again to sign in.');
    } else if (known) { setError(known[0], known[1]); field(known[0]).focus(); showFormError('Please fix the highlighted field.'); }
    else if (err && err.message === 'razorpay_script') showFormError('We couldn\u2019t load the payment window. Please check your connection and try again.');
    else showFormError('We couldn\u2019t start your payment just now. Please check your connection and try again. You haven\u2019t been charged.');
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