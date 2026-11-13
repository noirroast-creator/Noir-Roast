// NOIR ROAST: Shipway shipping, as one Supabase Edge Function named "shipway".
//   POST .../functions/v1/shipway/push     body {"order_number":"NR-..."}  send one paid order to Shipway
//   POST .../functions/v1/shipway/retry                                    send every paid order that is still waiting
//   POST .../functions/v1/shipway/cron?token=...                           every 15 minutes: retry waiting orders + ask Shipway where parcels are
//   POST .../functions/v1/shipway/webhook?token=...                        Shipway tells us where a parcel is (needs Shipway's paid Advance plan)
//
// /push and /retry are only for our own server: they need the project's service key as the Bearer token.
//a
// Secrets (Supabase > Edge Functions > Secrets), never put these in the website:
//   SHIPWAY_EMAIL           the email you log in to Shipway with
//   SHIPWAY_LICENSE_KEY     Shipway > Profile > Manage profile
//   SHIPWAY_WEBHOOK_TOKEN   any long random string; it is also part of the webhook URL you give Shipway
//   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.)
// Deploy with "Verify JWT" turned OFF: this function checks its own access rules.

type Json = Record<string, unknown>;

export type Deps = {
  db: { rpc: (name: string, args?: Json) => Promise<{ data: unknown; error: { message: string } | null }> };
  fetch: typeof fetch;
  env: (name: string) => string | undefined;
  // Lets /cron answer straight away and keep working afterwards (Supabase provides this).
  background?: (work: Promise<unknown>) => void;
};

const SHIPWAY_BASE = 'https://app.shipway.com/api';
const SHIPWAY_ORDERS_URL = `${SHIPWAY_BASE}/v2orders`;
const SHIPWAY_GET_ORDERS_URL = `${SHIPWAY_BASE}/getorders`;

const json = (body: Json, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Compares without leaking where the first difference is.
const safeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const isServer = (req: Request, d: Deps) => {
  const key = d.env('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const header = req.headers.get('authorization') ?? '';
  return key.length > 20 && header.startsWith('Bearer ') && safeEqual(header.slice(7), key);
};

type Item = { name: string; price: number; quantity: number; sku?: string | null; hsn_code?: string | null; gst_rate?: number | null; weight_g?: number | null };
type Order = {
  order_number: string; full_name: string; email: string; phone: string; address_line1: string; address_line2?: string | null;
  landmark?: string | null; city: string; state: string; pin_code: string; total_inr: number; paid_at?: string | null; items: Item[];
};

// "2026-10-22 15:30:02" in Indian time, which is what a shop in India expects to see in Shipway.
export const istDate = (iso?: string | null) => {
  const date = iso ? new Date(iso) : new Date();
  const ist = new Date((Number.isNaN(date.getTime()) ? Date.now() : date.getTime()) + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 19).replace('T', ' ');
};

// Turns our order into Shipway's "PUSH Orders" body. Prices already include GST, so taxes are sent as 0
// (Shipway reads a taxes value of 0 as "prices include tax").
export const buildPayload = (o: Order): Json => {
  const [first, ...rest] = o.full_name.trim().split(/\s+/);
  const last = rest.join(' ');
  const line2 = [o.address_line2, o.landmark ? `Near ${o.landmark}` : ''].filter(Boolean).join(', ');
  const products = o.items.map((i) => {
    const row: Json = { product: i.name, price: String(i.price), product_quantity: String(i.quantity), discount: '0' };
    if (i.sku) row.product_code = i.sku;
    if (i.hsn_code) row.hsn_code = i.hsn_code;
    if (i.gst_rate !== null && i.gst_rate !== undefined) row.tax_rate = String(i.gst_rate);
    return row;
  });
  const weights = o.items.map((i) => (i.weight_g ? i.weight_g * i.quantity : null));
  const payload: Json = {
    order_id: o.order_number,
    products,
    payment_type: 'P', // prepaid: every NOIR ROAST order is paid online
    email: o.email,
    discount: '0',
    shipping: '0',
    taxes: '0',
    order_total: String(o.total_inr),
    order_date: istDate(o.paid_at),
    billing_firstname: first, billing_lastname: last, billing_address: o.address_line1, billing_address2: line2,
    billing_city: o.city, billing_state: o.state, billing_country: 'India', billing_zipcode: o.pin_code, billing_phone: o.phone,
    shipping_firstname: first, shipping_lastname: last, shipping_address: o.address_line1, shipping_address2: line2,
    shipping_city: o.city, shipping_state: o.state, shipping_country: 'India', shipping_zipcode: o.pin_code, shipping_phone: o.phone,
  };
  if (weights.every((w) => w !== null)) payload.order_weight = String(weights.reduce((a, b) => (a ?? 0) + (b ?? 0), 0));
  return payload;
};

// Secrets pasted into a dashboard often carry a stray space, line break or quote marks: ignore those.
const clean = (value: string | undefined) => (value ?? '').trim().replace(/^["']+|["']+$/g, '').trim();

const authHeader = (d: Deps) => {
  const email = clean(d.env('SHIPWAY_EMAIL'));
  const key = clean(d.env('SHIPWAY_LICENSE_KEY'));
  return email && key ? `Basic ${btoa(`${email}:${key}`)}` : null;
};

// Sends one order. Returns what happened; never throws.
export const pushOrder = async (orderNumber: string, d: Deps): Promise<{ result: 'sent' | 'failed' | 'skipped'; message: string }> => {
  const claimed = await d.db.rpc('claim_shipway_push', { p_order_number: orderNumber });
  if (claimed.error) return { result: 'failed', message: 'database_error' };
  if (!claimed.data) return { result: 'skipped', message: 'not_due' }; // already sent, being sent, unpaid or unknown

  const order = claimed.data as Order;
  const finish = async (ok: boolean, message: string) => { await d.db.rpc('finish_shipway_push', { p_order_number: orderNumber, p_ok: ok, p_message: message }); };

  const auth = authHeader(d);
  if (!auth) { await finish(false, 'Shipway email or license key is not set'); return { result: 'failed', message: 'not_configured' }; }

  let response: Response;
  try {
    response = await d.fetch(SHIPWAY_ORDERS_URL, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(order)),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    await finish(false, 'could not reach Shipway');
    return { result: 'failed', message: 'network' };
  }

  let body: { success?: boolean | number; message?: unknown } = {};
  try { body = await response.json(); } catch { /* not JSON */ }
  const message = typeof body.message === 'string' ? body.message : `HTTP ${response.status}`;
  const accepted = response.ok && (body.success === true || body.success === 1);
  // If a retry finds the order already there, treat it as done instead of failing forever.
  const alreadyThere = !accepted && /already|exist|duplicate/i.test(message);
  if (accepted || alreadyThere) { await finish(true, message); return { result: 'sent', message }; }
  await finish(false, `Shipway said: ${message}`);
  return { result: 'failed', message };
};

/* ---------- asking Shipway where a parcel is ---------- */
const KNOWN_STATUS = new Set(['SCH', 'INT', 'OOD', 'DEL', 'UND', 'ONH', 'NFI', 'NFIDS', 'RTO', 'RTD', 'CAN']);

// Shipway documents short codes (DEL, INT...) but its order list can show words ("SHIPMENT RTO LOCK").
// Turns either into one of our known codes, or '' when unsure (we then show a plain "Shipped").
export const normalizeShipmentStatus = (raw: unknown): string => {
  const text = String(raw ?? '').trim();
  const upper = text.toUpperCase();
  if (KNOWN_STATUS.has(upper)) return upper;
  const t = text.toLowerCase();
  if (!t) return '';
  if (/rto/.test(t) && /deliver/.test(t)) return 'RTD';
  if (/rto/.test(t)) return 'RTO';
  if (/undeliver|not delivered|attempt|failed delivery/.test(t)) return 'UND';
  if (/out for delivery/.test(t)) return 'OOD';
  if (/deliver/.test(t) && !/return|rto/.test(t)) return 'DEL';
  if (/cancel/.test(t)) return 'CAN';
  if (/on hold/.test(t)) return 'ONH';
  if (/transit|dispatch|shipped|reached|arrived|received at/.test(t)) return 'INT';
  if (/booked|manifest|awaiting pickup|pickup scheduled/.test(t)) return 'SCH';
  return '';
};

type Lookup = { result: 'updated' | 'unchanged' | 'failed'; reason?: string };

// Asks Shipway about one order and stores the tracking number, courier and status.
export const syncOrder = async (orderNumber: string, d: Deps): Promise<Lookup> => {
  const auth = authHeader(d);
  if (!auth) return { result: 'failed', reason: 'not_configured' };
  let response: Response;
  try {
    response = await d.fetch(`${SHIPWAY_GET_ORDERS_URL}?orderid=${encodeURIComponent(orderNumber)}`, {
      method: 'GET',
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(10_000),
    });
  } catch { return { result: 'failed', reason: 'network' }; }
  if (!response.ok) return { result: 'failed', reason: `HTTP ${response.status}` };

  let body: { success?: boolean | number; message?: unknown } = {};
  try { body = await response.json(); } catch { return { result: 'failed', reason: 'bad_response' }; }
  if (!(body.success === 1 || body.success === true)) return { result: 'failed', reason: typeof body.message === 'string' ? body.message.slice(0, 80) : 'rejected' };
  const rows = Array.isArray(body.message) ? body.message as Json[] : [];
  const row = rows.find((r) => String(r.order_id ?? '') === orderNumber);
  if (!row) return { result: 'unchanged' }; // Shipway does not list it (yet)

  const awb = String(row.tracking_number ?? '').trim();
  const status = normalizeShipmentStatus(row.shipment_status);
  if (!awb && !status) return { result: 'unchanged' }; // no courier assigned yet
  const saved = await d.db.rpc('update_shipment', {
    p_order_number: orderNumber, p_awb: awb, p_carrier: String(row.name ?? ''), p_status: status, p_tracking_url: '',
  });
  return saved.error ? { result: 'failed', reason: 'database_error' } : { result: 'updated' };
};

// Checks several orders at once (a few at a time, so one slow answer does not hold up the rest).
const syncTracking = async (d: Deps) => {
  const picked = await d.db.rpc('claim_shipway_tracking', { p_limit: 15 });
  const numbers = picked.error ? [] : ((picked.data as string[] | null) ?? []);
  const outcomes: Lookup[] = [];
  for (let i = 0; i < numbers.length; i += 5) {
    outcomes.push(...await Promise.all(numbers.slice(i, i + 5).map((n) => syncOrder(n, d))));
  }
  return { checked: numbers.length, updated: outcomes.filter((o) => o.result === 'updated').length, failures: outcomes.filter((o) => o.result === 'failed').map((o) => o.reason ?? 'failed'), databaseError: Boolean(picked.error) };
};

/* ---------- routes ---------- */
const push = async (req: Request, d: Deps) => {
  if (!isServer(req, d)) return json({ error: 'forbidden' }, 403);
  let body: Json = {};
  try { body = JSON.parse(await req.text()); } catch { /* empty */ }
  const orderNumber = String(body.order_number ?? '');
  if (!/^NR-[A-Z0-9]{4,20}$/.test(orderNumber)) return json({ error: 'bad_request' }, 400);
  return json({ ...(await pushOrder(orderNumber, d)) }, 200);
};

const retryPending = async (d: Deps): Promise<{ ok: boolean; results: Json[] }> => {
  const pending = await d.db.rpc('list_shipway_pending');
  if (pending.error) return { ok: false, results: [] };
  const numbers = (pending.data as string[] | null) ?? [];
  const results: Json[] = [];
  for (const n of numbers) results.push({ order_number: n, ...(await pushOrder(n, d)) });
  return { ok: true, results };
};

const retry = async (req: Request, d: Deps) => {
  if (!isServer(req, d)) return json({ error: 'forbidden' }, 403);
  const { ok, results } = await retryPending(d);
  if (!ok) return json({ error: 'server_error' }, 500);
  return json({ checked: results.length, results }, 200);
};

// The 15-minute job: send anything still waiting, then refresh parcel status. The URL carries a secret token.
const runCron = async (d: Deps): Promise<Json> => {
  const sent = await retryPending(d);
  const tracked = await syncTracking(d);
  if (tracked.failures.length > 0 || tracked.databaseError) {
    const summary = `tracking check: ${tracked.failures.length} of ${tracked.checked} failed (${[...new Set(tracked.failures)].slice(0, 3).join(', ') || 'database'})`;
    await d.db.rpc('finish_shipway_push', { p_order_number: 'SYNC', p_ok: false, p_message: summary });
  }
  return { retried: sent.results.length, tracking_checked: tracked.checked, tracking_updated: tracked.updated, tracking_failed: tracked.failures.length };
};

const cron = async (req: Request, d: Deps) => {
  const expected = clean(d.env('SHIPWAY_WEBHOOK_TOKEN'));
  const given = new URL(req.url).searchParams.get('token') ?? '';
  const trusted = (expected.length >= 16 && safeEqual(given, expected)) || isServer(req, d);
  if (!trusted) return json({ error: 'forbidden' }, 403);
  const work = runCron(d).catch((err) => { console.error('shipway cron error', err instanceof Error ? err.message : 'unknown'); return {}; });
  if (d.background) { d.background(work); return json({ accepted: true }, 202); }
  return json(await work, 200);
};

// Shipway's webhook has no signature, so the URL itself carries a secret token.
const webhook = async (req: Request, d: Deps) => {
  const expected = clean(d.env('SHIPWAY_WEBHOOK_TOKEN'));
  const given = new URL(req.url).searchParams.get('token') ?? '';
  if (expected.length < 16 || !safeEqual(given, expected)) return new Response('forbidden', { status: 403 });

  const text = await req.text();
  if (text.length > 200_000) return new Response('too large', { status: 413 });
  let event: Json;
  try { event = JSON.parse(text); } catch { return new Response('bad json', { status: 400 }); }

  const orderNumber = String(event.order_id ?? '');
  if (!/^NR-[A-Z0-9]{4,20}$/.test(orderNumber)) return new Response('ignored', { status: 200 }); // not one of ours: do not retry
  const input = (event.api_input && typeof event.api_input === 'object' ? event.api_input : {}) as Json;

  const updated = await d.db.rpc('update_shipment', {
    p_order_number: orderNumber,
    p_awb: String(event.awbno ?? input.awbno ?? ''),
    p_carrier: String(event.carrier ?? input.carrier ?? ''),
    p_status: String(event.current_status ?? input.current_status ?? ''),
    p_tracking_url: String(input.tracking_url ?? ''),
  });
  if (updated.error) return new Response('error', { status: 500 }); // let Shipway retry
  return new Response('ok', { status: 200 });
};

// A safe self-check: shows what is configured (never the secrets themselves) and what Shipway answers
// to a harmless read-only request. Open it in a browser while testing; remove the route when done.
const maskEmail = (email: string) => {
  const [name = '', domain = ''] = email.split('@');
  const tld = domain.includes('.') ? domain.slice(domain.lastIndexOf('.')) : '';
  return `${name.slice(0, 1)}***@${domain.slice(0, 1)}***${tld}`;
};

const diag = async (req: Request, d: Deps) => {
  const expected = clean(d.env('SHIPWAY_WEBHOOK_TOKEN'));
  const given = new URL(req.url).searchParams.get('token') ?? '';
  if (!((expected.length >= 16 && safeEqual(given, expected)) || isServer(req, d))) return json({ error: 'forbidden' }, 403);

  const rawEmail = d.env('SHIPWAY_EMAIL') ?? '';
  const rawKey = d.env('SHIPWAY_LICENSE_KEY') ?? '';
  const describe = (raw: string) => ({ set: raw.length > 0, length: raw.length, has_outer_space_or_newline: raw !== raw.trim(), has_quote_marks: /^["']|["']$/.test(raw.trim()) });
  const info: Json = {
    email: { ...describe(rawEmail), masked: maskEmail(clean(rawEmail)) },
    license_key: describe(rawKey),
    cron_token_set: expected.length >= 16,
    service_key_set: (d.env('SUPABASE_SERVICE_ROLE_KEY') ?? '').length > 20,
  };

  const auth = authHeader(d);
  if (!auth) return json({ ...info, shipway: 'email or license key missing' }, 200);
  try {
    const response = await d.fetch(`${SHIPWAY_BASE}/getwarehouses`, { method: 'GET', headers: { Authorization: auth }, signal: AbortSignal.timeout(10_000) });
    let body: { success?: unknown; message?: unknown } = {};
    try { body = await response.json(); } catch { /* not JSON */ }
    const warehouses = body.message && typeof body.message === 'object' && !Array.isArray(body.message)
      ? Object.values(body.message as Record<string, Json>).slice(0, 10).map((w) => ({ id: w.warehouse_id, title: w.title })) : [];
    info.shipway = {
      http_status: response.status,
      success: body.success ?? null,
      message: typeof body.message === 'string' ? body.message.slice(0, 120) : null,
      warehouses,
    };
  } catch { info.shipway = { http_status: 'could not reach Shipway' }; }
  return json(info, 200);
};

/* ---------- entry ---------- */
export async function handle(req: Request, d: Deps): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  if (req.method === 'GET' && path.endsWith('/diag')) { try { return await diag(req, d); } catch { return json({ error: 'server_error' }, 500); } }
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    if (path.endsWith('/push')) return await push(req, d);
    if (path.endsWith('/retry')) return await retry(req, d);
    if (path.endsWith('/cron')) return await cron(req, d);
    if (path.endsWith('/webhook')) return await webhook(req, d);
  } catch (err) {
    console.error('shipway function error', err instanceof Error ? err.message : 'unknown');
    return json({ error: 'server_error' }, 500);
  }
  return json({ error: 'not_found' }, 404);
}

// Runs only inside Supabase (Deno); the tests import `handle` directly.
// deno-lint-ignore no-explicit-any
const deno = (globalThis as any).Deno;
if (deno && typeof deno.serve === 'function') {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.45.4');
  const db = createClient(deno.env.get('SUPABASE_URL') ?? '', deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime;
  const background = runtime && typeof runtime.waitUntil === 'function' ? (work: Promise<unknown>) => runtime.waitUntil(work) : undefined;
  const deps: Deps = { db: db as unknown as Deps['db'], fetch, env: (name) => deno.env.get(name), background };
  deno.serve((req: Request) => handle(req, deps));
}
