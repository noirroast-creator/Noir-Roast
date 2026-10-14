// NOIR ROAST: Razorpay payments, as one Supabase Edge Function named "razorpay".
//   POST .../functions/v1/razorpay/create   -> creates a pending order + a Razorpay order (signed-in customer)
//   POST .../functions/v1/razorpay/verify   -> confirms a payment after the customer pays (signed-in customer)
//   POST .../functions/v1/razorpay/webhook  -> Razorpay tells us a payment was captured (backup if the tab closes)
//
// Secrets (Supabase > Edge Functions > Secrets), never put these in the website:
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
//   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.)
// Deploy with "Verify JWT" turned OFF: this function checks the customer's sign-in itself.

type Json = Record<string, unknown>;

export type Deps = {
  db: {
    auth: { getUser: (token: string) => Promise<{ data: { user: { id: string; email?: string | null } | null }; error: unknown }> };
    rpc: (name: string, args: Json) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
  fetch: typeof fetch;
  env: (name: string) => string | undefined;
};

const DEFAULT_ORIGINS = ['https://noirroast.in', 'https://www.noirroast.in', 'http://localhost:5173', 'http://127.0.0.1:5173'];
const VALIDATION_ERRORS = new Set([
  'invalid_name', 'invalid_email', 'invalid_phone', 'invalid_address', 'invalid_city', 'invalid_state',
  'invalid_pin', 'invalid_items', 'invalid_quantity', 'invalid_product',
]);

const encoder = new TextEncoder();

const json = (body: Json, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });

const toHex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

const hmacHex = async (secret: string, message: string) => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
};

// Compares without leaking where the first difference is.
const safeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const rzpFetch = (d: Deps, path: string, init: RequestInit = {}) => {
  const id = d.env('RAZORPAY_KEY_ID') ?? '';
  const secret = d.env('RAZORPAY_KEY_SECRET') ?? '';
  const auth = btoa(`${id}:${secret}`);
  return d.fetch(`https://api.razorpay.com/v1/${path}`, {
    ...init,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
  });
};

const customerFrom = async (req: Request, d: Deps) => {
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  const { data, error } = await d.db.auth.getUser(token); // rejects the public anon key: it is not a customer
  if (error || !data.user || !data.user.email) return null;
  return { id: data.user.id, email: data.user.email };
};

const readJson = async (req: Request): Promise<Json | null> => {
  const text = await req.text();
  if (text.length > 20_000) return null;
  try { const value = JSON.parse(text); return value && typeof value === 'object' ? value as Json : null; } catch { return null; }
};

/* ---------- /create ---------- */
const create = async (req: Request, d: Deps, cors: Record<string, string>) => {
  const customer = await customerFrom(req, d);
  if (!customer) return json({ error: 'not_signed_in' }, 401, cors);
  const body = await readJson(req);
  if (!body) return json({ error: 'bad_request' }, 400, cors);

  const made = await d.db.rpc('create_order', { p_user: customer.id, p_email: customer.email, p_customer: (body.customer ?? {}) as Json, p_items: (body.items ?? []) as unknown as Json });
  if (made.error) {
    const code = made.error.message;
    return VALIDATION_ERRORS.has(code) ? json({ error: code }, 400, cors) : json({ error: 'server_error' }, 500, cors);
  }
  const order = made.data as { order_id: string; order_number: string; total: number };

  const response = await rzpFetch(d, 'orders', {
    method: 'POST',
    body: JSON.stringify({ amount: order.total * 100, currency: 'INR', receipt: order.order_number, notes: { order_number: order.order_number } }),
  });
  if (!response.ok) return json({ error: 'payment_provider' }, 502, cors);
  const rzp = await response.json() as { id: string; amount: number; currency: string };

  const attached = await d.db.rpc('attach_razorpay_order', { p_order_id: order.order_id, p_rzp_order_id: rzp.id });
  if (attached.error) return json({ error: 'server_error' }, 500, cors);

  return json({ key_id: d.env('RAZORPAY_KEY_ID') ?? '', razorpay_order_id: rzp.id, amount: rzp.amount, currency: rzp.currency, order_number: order.order_number }, 200, cors);
};

/* ---------- /verify ---------- */
const verify = async (req: Request, d: Deps, cors: Record<string, string>) => {
  const customer = await customerFrom(req, d);
  if (!customer) return json({ error: 'not_signed_in' }, 401, cors);
  const body = await readJson(req);
  const orderId = String(body?.razorpay_order_id ?? '');
  const paymentId = String(body?.razorpay_payment_id ?? '');
  const signature = String(body?.razorpay_signature ?? '');
  if (!/^order_[A-Za-z0-9]+$/.test(orderId) || !/^pay_[A-Za-z0-9]+$/.test(paymentId) || !/^[a-f0-9]{64}$/.test(signature)) {
    return json({ error: 'bad_request' }, 400, cors);
  }

  const expected = await hmacHex(d.env('RAZORPAY_KEY_SECRET') ?? '', `${orderId}|${paymentId}`);
  if (!safeEqual(expected, signature)) return json({ error: 'bad_signature' }, 400, cors);

  // Ask Razorpay directly: the money must really be captured, for this order.
  const lookup = await rzpFetch(d, `payments/${paymentId}`);
  if (!lookup.ok) return json({ error: 'payment_provider' }, 502, cors);
  const payment = await lookup.json() as { status: string; order_id: string; amount: number };
  if (payment.order_id !== orderId) return json({ error: 'bad_request' }, 400, cors);
  if (payment.status !== 'captured') return json({ error: 'not_captured' }, 402, cors);

  const paid = await d.db.rpc('mark_order_paid', { p_rzp_order_id: orderId, p_payment_id: paymentId, p_amount_paise: payment.amount, p_user: customer.id });
  if (paid.error) {
    return paid.error.message === 'unknown_order' || paid.error.message === 'amount_mismatch'
      ? json({ error: paid.error.message }, 400, cors)
      : json({ error: 'server_error' }, 500, cors);
  }
  return json(paid.data as Json, 200, cors);
};

/* ---------- /webhook ---------- */
const webhook = async (req: Request, d: Deps) => {
  const raw = await req.text();
  const signature = req.headers.get('x-razorpay-signature') ?? '';
  const secret = d.env('RAZORPAY_WEBHOOK_SECRET');
  if (!secret) return new Response('webhook not configured', { status: 400 });
  const expected = await hmacHex(secret, raw);
  if (!safeEqual(expected, signature)) return new Response('bad signature', { status: 400 });

  let event: { event?: string; payload?: { payment?: { entity?: { id?: string; order_id?: string; amount?: number; status?: string } } } };
  try { event = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  if (event.event !== 'payment.captured' && event.event !== 'order.paid') return new Response('ignored', { status: 200 });

  const payment = event.payload?.payment?.entity;
  if (!payment?.id || !payment.order_id || payment.status !== 'captured') return new Response('ignored', { status: 200 });

  const paid = await d.db.rpc('mark_order_paid', { p_rzp_order_id: payment.order_id, p_payment_id: payment.id, p_amount_paise: payment.amount ?? 0, p_user: null });
  if (paid.error) {
    if (paid.error.message === 'unknown_order') return new Response('unknown order', { status: 200 }); // not ours: do not retry
    return new Response('error', { status: 500 }); // let Razorpay retry
  }
  return new Response('ok', { status: 200 });
};

/* ---------- entry ---------- */
export async function handle(req: Request, d: Deps): Promise<Response> {
  const origins = (d.env('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const allowed = origins.length ? origins : DEFAULT_ORIGINS;
  const origin = req.headers.get('origin') ?? '';
  const cors: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
  if (allowed.includes(origin)) cors['Access-Control-Allow-Origin'] = origin;

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);

  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  try {
    if (path.endsWith('/create')) return await create(req, d, cors);
    if (path.endsWith('/verify')) return await verify(req, d, cors);
    if (path.endsWith('/webhook')) return await webhook(req, d);
  } catch (err) {
    console.error('razorpay function error', err instanceof Error ? err.message : 'unknown');
    return json({ error: 'server_error' }, 500, cors);
  }
  return json({ error: 'not_found' }, 404, cors);
}

// Runs only inside Supabase (Deno); the tests import `handle` directly.
// deno-lint-ignore no-explicit-any
const deno = (globalThis as any).Deno;
if (deno && typeof deno.serve === 'function') {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.45.4');
  const db = createClient(deno.env.get('SUPABASE_URL') ?? '', deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const deps: Deps = { db: db as unknown as Deps['db'], fetch, env: (name) => deno.env.get(name) };
  deno.serve((req: Request) => handle(req, deps));
}