// Sign-in pop-up: email -> 6-digit code. NoirAuthUI.open({ email }) resolves with the user, or null if closed.
(() => {
  // Length of the emailed code (Supabase > Authentication > Email > OTP length). Set in config.js.
  const CODE_LENGTH = Number((window.NOIR_CONFIG || {}).otpLength) || 8;
  const MIN_CODE = 6;
  const MAX_CODE = 10;
  const COOLDOWN_SECONDS = 60;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  let root = null;
  let state = null; // { resolve, email, lastFocus, cooldownTimer, busy }

  const build = () => {
    const wrap = document.createElement('div');
    wrap.className = 'auth-overlay';
    wrap.hidden = true;
    wrap.innerHTML = `
      <div class="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <button class="auth-close" type="button" data-auth-close aria-label="Close">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>
        </button>
        <h2 id="auth-title" class="auth-title" tabindex="-1">Sign in to continue</h2>
        <p class="auth-lead" data-auth-lead></p>

        <form class="auth-step" data-step-email novalidate>
          <div class="field">
            <label for="auth-email">Email address</label>
            <input id="auth-email" type="email" autocomplete="email" inputmode="email" required>
          </div>
          <button class="btn btn-dark auth-submit" type="submit">Send code</button>
        </form>

        <form class="auth-step" data-step-code novalidate hidden>
          <div class="field">
            <label for="auth-code">Code from your email</label>
            <input id="auth-code" class="auth-code" type="text" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]*" maxlength="${MAX_CODE}" required>
          </div>
          <button class="btn btn-dark auth-submit" type="submit">Verify and continue</button>
          <p class="auth-actions">
            <button class="auth-link" type="button" data-auth-resend>Send a new code</button>
            <button class="auth-link" type="button" data-auth-change>Use a different email</button>
          </p>
        </form>

        <p class="auth-error" role="alert" data-auth-error hidden></p>
        <p class="auth-note">We\u2019ll email you a one-time code. No password needed.</p>
      </div>`;
    document.body.append(wrap);
    return wrap;
  };

  const q = (selector) => root.querySelector(selector);

  const setError = (message) => { const box = q('[data-auth-error]'); box.textContent = message || ''; box.hidden = !message; };

  const friendly = (err, whileVerifying) => {
    const message = String((err && err.message) || '');
    if ((err && err.status === 429) || /rate limit|too many|seconds/i.test(message)) {
      return 'Too many attempts. Please wait a minute and try again.';
    }
    if (whileVerifying) return 'That code isn\u2019t right or has expired. Check it, or send a new code.';
    if (/unavailable/i.test(message)) return 'Sign-in is unavailable right now. Please try again shortly.';
    if (/invalid.*email|email.*invalid/i.test(message)) return 'Please enter a valid email address.';
    return 'We couldn\u2019t send the code. Check the email address and try again.';
  };

  const showStep = (name) => {
    q('[data-step-email]').hidden = name !== 'email';
    q('[data-step-code]').hidden = name !== 'code';
    setError('');
    const target = name === 'email' ? q('#auth-email') : q('#auth-code');
    window.setTimeout(() => target.focus(), 30);
  };

  const startCooldown = () => {
    const button = q('[data-auth-resend]');
    let left = COOLDOWN_SECONDS;
    window.clearInterval(state.cooldownTimer);
    button.disabled = true;
    const tick = () => {
      if (left <= 0) { window.clearInterval(state.cooldownTimer); button.disabled = false; button.textContent = 'Send a new code'; return; }
      button.textContent = `Send a new code (${left}s)`;
      left -= 1;
    };
    tick();
    state.cooldownTimer = window.setInterval(tick, 1000);
  };

  const sendCode = async (email) => {
    const current = state;
    if (!current || current.busy) return;
    current.busy = true;
    setError('');
    const submit = q('[data-step-email] .auth-submit');
    submit.disabled = true;
    try {
      await window.NoirData.sendCode(email);
      if (state !== current) return; // closed while the code was being sent
      state.email = email;
      q('[data-auth-lead]').textContent = '';
      q('[data-auth-lead]').append('We emailed a code to ', Object.assign(document.createElement('strong'), { textContent: email }), '.');
      q('#auth-code').value = '';
      showStep('code');
      startCooldown();
    } catch (err) {
      if (state !== current) return;
      showStep('email');
      q('#auth-email').value = email;
      setError(friendly(err, false));
    } finally {
      current.busy = false;
      submit.disabled = false;
    }
  };

  const verify = async () => {
    const current = state;
    if (!current || current.busy) return;
    const code = q('#auth-code').value.replace(/\D/g, '');
    if (code.length < MIN_CODE || code.length > MAX_CODE) { setError('Enter the code from your email.'); return; }
    current.busy = true;
    setError('');
    const submit = q('[data-step-code] .auth-submit');
    submit.disabled = true;
    try {
      const user = await window.NoirData.verifyCode(current.email, code);
      if (state === current) finish(user);
    } catch (err) {
      if (state !== current) return;
      setError(friendly(err, true));
      q('#auth-code').select();
    } finally {
      current.busy = false;
      submit.disabled = false;
    }
  };

  const focusables = () => [...root.querySelectorAll('button:not([disabled]), input:not([disabled])')].filter((n) => !n.closest('[hidden]'));

  const onKey = (event) => {
    if (!state) return;
    if (event.key === 'Escape') { finish(null); return; }
    if (event.key !== 'Tab') return;
    const nodes = focusables();
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const finish = (user) => {
    if (!state) return;
    const { resolve, lastFocus } = state;
    window.clearInterval(state.cooldownTimer);
    state = null;
    root.hidden = true;
    document.body.classList.remove('auth-open');
    document.removeEventListener('keydown', onKey);
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
    resolve(user);
  };

  const wire = () => {
    q('[data-step-email]').addEventListener('submit', (event) => {
      event.preventDefault();
      const email = q('#auth-email').value.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) { setError('Please enter a valid email address.'); q('#auth-email').focus(); return; }
      sendCode(email);
    });
    q('[data-step-code]').addEventListener('submit', (event) => { event.preventDefault(); verify(); });
    q('#auth-code').addEventListener('input', (event) => {
      event.target.value = event.target.value.replace(/\D/g, '').slice(0, MAX_CODE);
      if (event.target.value.length === CODE_LENGTH) verify();
    });
    q('[data-auth-resend]').addEventListener('click', () => { if (state && state.email) sendCode(state.email); });
    q('[data-auth-change]').addEventListener('click', () => { q('[data-auth-lead]').textContent = 'Enter the email you\u2019d like to use.'; showStep('email'); q('#auth-email').value = state.email || ''; });
    q('[data-auth-close]').addEventListener('click', () => finish(null));
    root.addEventListener('mousedown', (event) => { if (event.target === root) finish(null); });
  };

  // options: { email?: string, title?: string }
  const open = (options = {}) => new Promise((resolve) => {
    if (!window.NoirData || !window.NoirData.available) { resolve(null); return; }
    if (!root) { root = build(); wire(); }
    if (state) finish(null);
    state = { resolve, email: '', lastFocus: document.activeElement, cooldownTimer: 0, busy: false };
    q('#auth-title').textContent = options.title || 'Sign in to continue';
    root.hidden = false;
    document.body.classList.add('auth-open');
    document.addEventListener('keydown', onKey);
    const email = (options.email || '').trim().toLowerCase();
    if (EMAIL_RE.test(email)) {
      q('[data-auth-lead]').textContent = 'Sending your code\u2026';
      q('[data-step-code]').hidden = true;
      q('[data-step-email]').hidden = true;
      setError('');
      sendCode(email);
    } else {
      q('[data-auth-lead]').textContent = 'Enter your email and we\u2019ll send you a one-time code.';
      q('#auth-email').value = email;
      showStep('email');
    }
  });

  window.NoirAuthUI = { open };
})();