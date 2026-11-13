// Gifts & Coupons: "Stop the clock at 10.00". The chances, the win check and the coupon all live in the database.
// This page only shows a live timer and measures how long the customer waited.
const $ = (selector) => document.querySelector(selector);
const TARGET_MS = 10000;
const AUTO_END_MS = 20000; // if nobody presses stop, the attempt ends here as a miss
const COUPON_KEY = 'noir-roast-coupon';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const ui = {
  error: $('[data-error]'),
  signinBox: $('[data-signin-box]'),
  play: $('[data-play]'),
  clock: $('[data-clock]'),
  action: $('[data-action]'),
  result: $('[data-result]'),
  note: $('[data-note]'),
  meta: $('[data-meta]'),
  couponsSection: $('[data-coupons-section]'),
  coupons: $('[data-coupons]'),
  couponsEmpty: $('[data-coupons-empty]'),
};

// Same rounding the server uses: what the clock shows is what counts.
const clockText = (ms) => (Math.round(ms / 10) / 100).toFixed(2);
const secs = (ms) => (Math.round(Math.abs(ms) / 10) / 100).toFixed(2);
const signed = (ms) => (ms > 0 ? '+' : ms < 0 ? '-' : '') + secs(ms) + 's';

let state = 'loading'; // loading | signedOut | idle | running | busy | done
let status = null;     // { left, total, best_diff_ms, won, code }
let attemptId = null;
let t0 = 0;
let raf = 0;
let lastStopAt = -1e9;

const showError = (message) => { ui.error.textContent = message; ui.error.hidden = !message; };

const ERRORS = {
  no_chances: 'You have used all 3 chances. Thanks for playing!',
  already_won: 'You have already won your coupon. Find it below.',
  not_signed_in: 'Please sign in to play.',
};

const renderMeta = () => {
  if (!status) { ui.meta.textContent = ''; return; }
  const closest = status.best_diff_ms === null || status.best_diff_ms === undefined ? '—' : signed(status.best_diff_ms);
  ui.meta.textContent = `Chances left: ${status.left} of ${status.total} · Closest: ${closest}`;
};

const renderAction = () => {
  const b = ui.action;
  b.classList.toggle('is-stop', state === 'running');
  ui.clock.classList.toggle('is-running', state === 'running');
  if (state === 'running') { b.disabled = false; b.textContent = 'Stop'; return; }
  if (state === 'busy') { b.disabled = true; b.textContent = 'Checking…'; return; }
  if (status && status.won) { b.disabled = true; b.textContent = 'Coupon unlocked'; return; }
  if (status && status.left <= 0) { b.disabled = true; b.textContent = 'No chances left'; return; }
  b.disabled = false;
  b.textContent = status && status.left < status.total ? 'Try again' : 'Start';
};

const setState = (next) => { state = next; renderAction(); };

/* ---------- the clock ---------- */
const tick = () => {
  const elapsed = performance.now() - t0;
  if (elapsed >= AUTO_END_MS) { stop(AUTO_END_MS); return; }
  ui.clock.textContent = clockText(elapsed);
  raf = requestAnimationFrame(tick);
};

const start = async () => {
  if (state !== 'idle') return;
  showError('');
  ui.result.textContent = '';
  ui.result.classList.remove('is-win');
  ui.clock.classList.remove('is-win');
  ui.note.textContent = '';
  setState('busy');
  try {
    const started = await window.NoirData.gameStart();
    attemptId = started.attempt_id;
    status = { ...status, left: started.left };
    renderMeta();
    t0 = performance.now(); // the clock begins when the customer actually sees it start
    ui.clock.textContent = '0.00';
    setState('running');
    raf = requestAnimationFrame(tick);
  } catch (err) {
    const message = ERRORS[err && err.message];
    if (message) { try { await refresh(); } catch { /* keep what is on screen */ } ui.result.textContent = message; } else { showError('We couldn’t start the game just now. Please check your connection and try again.'); }
    setState('idle');
    renderAction();
  }
};

const stop = async (forcedMs) => {
  if (state !== 'running') return;
  const ms = Math.round(typeof forcedMs === 'number' ? forcedMs : performance.now() - t0);
  cancelAnimationFrame(raf);
  ui.clock.textContent = clockText(ms);
  setState('busy');
  const id = attemptId;
  attemptId = null;
  try {
    const out = await window.NoirData.gameStop(id, ms);
    status = { ...status, left: out.left, best_diff_ms: out.best_diff_ms, won: Boolean(out.code), code: out.code };
    ui.clock.textContent = clockText(out.elapsed_ms);
    if (out.won) {
      ui.clock.classList.add('is-win');
      ui.result.classList.add('is-win');
      ui.result.textContent = 'Perfect stop! 10.00 exactly.';
      ui.note.textContent = `Your 10% coupon is ${out.code}. It is saved under Your coupons below.`;
    } else {
      const late = out.diff_ms > 0;
      ui.result.textContent = `${secs(out.diff_ms)}s too ${late ? 'late' : 'early'}.`;
      ui.note.textContent = out.left > 0
        ? `You have ${out.left} ${out.left === 1 ? 'chance' : 'chances'} left. Press Try again when you’re ready.`
        : 'You have used all 3 chances. Thanks for playing!';
    }
    renderMeta();
    setState('idle');
    renderAction();
    loadCoupons();
  } catch (err) {
    try { await refresh(); } catch { /* keep what is on screen */ }
    showError('We couldn’t record that stop. Your chance may have been used. Please refresh the page.');
    setState('idle');
    renderAction();
  }
};

// Pressing Stop on touch/mouse reacts on press, not release, so the stop time is as accurate as it can be.
ui.action.addEventListener('pointerdown', (event) => {
  if (state === 'running' && event.isPrimary) { lastStopAt = performance.now(); event.preventDefault(); stop(); }
});
ui.action.addEventListener('click', () => {
  if (performance.now() - lastStopAt < 700) return; // the click that follows a press-to-stop must not start a new round
  if (state === 'running') stop();
  else if (state === 'idle') start();
});

/* ---------- coupons ---------- */
const useCoupon = (code) => {
  try { localStorage.setItem(COUPON_KEY, code); } catch { /* storage unavailable */ }
  window.location.href = 'index.html#shop';
};

const renderCoupon = (c) => {
  const expires = new Date(c.expires_at);
  const expired = expires.getTime() < Date.now();
  const dead = c.used || expired;
  const li = el('li', `gf-coupon${dead ? ' is-dead' : ''}`);
  const info = el('div');
  info.append(el('p', 'gf-coupon-code', c.code));
  const off = el('p', 'gf-coupon-off');
  off.append(el('strong', '', `${c.percent_off}% off`), ' your order');
  info.append(off);
  const when = expires.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  info.append(el('p', 'gf-coupon-state', c.used ? 'Used' : expired ? `Expired on ${when}` : `Valid until ${when}`));
  const actions = el('div', 'gf-coupon-actions');
  const copy = el('button', 'gf-small', 'Copy code');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(c.code); copy.textContent = 'Copied'; } catch { copy.textContent = c.code; }
    window.setTimeout(() => { copy.textContent = 'Copy code'; }, 1800);
  });
  actions.append(copy);
  if (!dead) {
    const use = el('button', 'gf-small is-primary', 'Use at checkout');
    use.type = 'button';
    use.addEventListener('click', () => useCoupon(c.code));
    actions.append(use);
  }
  li.append(info, actions);
  return li;
};

const loadCoupons = async () => {
  try {
    const list = await window.NoirData.myCoupons();
    ui.coupons.replaceChildren(...list.map(renderCoupon));
    ui.couponsEmpty.hidden = list.length > 0;
    ui.couponsSection.hidden = false;
  } catch { /* the game still works without the list */ }
};

/* ---------- page ---------- */
const refresh = async () => {
  status = await window.NoirData.gameStatus();
  renderMeta();
};

const enter = async (user) => {
  cancelAnimationFrame(raf);
  attemptId = null;
  if (!user) {
    status = null;
    ui.play.hidden = true;
    ui.signinBox.hidden = false;
    ui.couponsSection.hidden = true;
    ui.meta.textContent = '';
    ui.result.textContent = '';
    ui.note.textContent = '';
    setState('signedOut');
    return;
  }
  ui.signinBox.hidden = true;
  ui.play.hidden = false;
  setState('busy');
  try {
    await refresh();
    ui.clock.textContent = '0.00';
    if (status.won) ui.note.textContent = `You’ve already unlocked your 10% coupon: ${status.code}.`;
    else if (status.left <= 0) ui.result.textContent = 'You have used all 3 chances. Thanks for playing!';
    setState('idle');
    renderAction();
    loadCoupons();
  } catch {
    showError('We couldn’t load the game just now. Please refresh the page to try again.');
    setState('idle');
    ui.action.disabled = true;
  }
};

$('[data-signin]').addEventListener('click', async () => {
  const user = await window.NoirAuthUI.open({ title: 'Sign in to play' });
  if (user) enter(user);
});

// Leaving mid-round counts as a used chance; warn before the page closes.
window.addEventListener('beforeunload', (event) => { if (state === 'running') { event.preventDefault(); event.returnValue = ''; } });

if (!window.NoirData || !window.NoirData.available) {
  showError('The game is unavailable right now. Please try again shortly.');
  ui.play.hidden = true;
} else {
  window.NoirData.getUser().then(enter);
  window.NoirData.onAuthChange((user) => { if (!user) enter(null); });
}
