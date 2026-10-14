// Thin wrapper around Supabase: order counter, email-code sign-in, and orders.
(() => {
  const config = window.NOIR_CONFIG || {};
  const lib = window.supabase;
  const client = lib && config.supabaseUrl && config.supabaseAnonKey
    ? lib.createClient(config.supabaseUrl, config.supabaseAnonKey, {
        // Keep customers signed in on this device (session lasts until they sign out).
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      })
    : null;

  const need = () => { if (!client) throw new Error('unavailable'); return client; };
  const toStats = (row) => ({ placed: Number(row.orders_placed), goal: Number(row.goal) });

  /* ---------- order counter ---------- */
  const getStats = async () => {
    const { data, error } = await need().from('order_stats').select('orders_placed, goal').eq('id', 1).single();
    if (error) throw error;
    return toStats(data);
  };

  // Calls back every time the counter changes (live). Returns a function that stops listening.
  const subscribeStats = (callback) => {
    if (!client) return () => {};
    const channel = client
      .channel('order-stats')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_stats' }, (payload) => {
        if (payload.new && 'orders_placed' in payload.new) callback(toStats(payload.new));
      })
      .subscribe();
    return () => client.removeChannel(channel);
  };

  /* ---------- sign-in with an emailed 6-digit code ---------- */
  const getUser = async () => {
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data && data.session ? data.session.user : null;
  };

  // callback(user | null). Runs after sign-in and sign-out, including from another tab.
  const onAuthChange = (callback) => {
    if (!client) return () => {};
    const { data } = client.auth.onAuthStateChange((event, session) => {
      if (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') return;
      // Do not call Supabase from inside this callback; hand off to the next tick.
      window.setTimeout(() => callback(session ? session.user : null), 0);
    });
    return () => data.subscription.unsubscribe();
  };

  // Emails a 6-digit code. Creates the account on first use.
  const sendCode = async (email) => {
    const { error } = await need().auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (error) throw error;
  };

  const verifyCode = async (email, token) => {
    const { data, error } = await need().auth.verifyOtp({ email, token, type: 'email' });
    if (error) throw error;
    return data.user;
  };

  const signOut = async () => {
    const { error } = await need().auth.signOut();
    if (error) throw error;
  };

  /* ---------- orders ---------- */
  /* ---------- payments (Razorpay, through the "razorpay" Edge Function) ---------- */
  const callPayments = async (path, body) => {
    const { data } = await need().auth.getSession();
    if (!data || !data.session) throw new Error('not_signed_in');
    let response;
    try {
      response = await fetch(`${config.supabaseUrl}/functions/v1/razorpay/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}`, apikey: config.supabaseAnonKey },
        body: JSON.stringify(body),
      });
    } catch { throw new Error('network'); }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) { const err = new Error(result.error || 'payment_failed'); err.status = response.status; throw err; }
    return result;
  };

  // customer: { name, email, phone, addr1, addr2, city, state, pin, landmark }; items: [{ id, qty }]
  // Creates a pending order and a Razorpay order. Prices are worked out on the server.
  const createPayment = (customer, items) => callPayments('create', { customer, items });
  // payment: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
  const verifyPayment = (payment) => callPayments('verify', payment);

  // The signed-in customer's own orders, newest first (the database only returns their own).
  const getMyOrders = async () => {
    const { data, error } = await need()
      .from('orders')
      .select('order_number, created_at, status, total_inr, order_items(product_name, quantity, unit_price_inr)')
      .eq('payment_status', 'paid')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    return data || [];
  };

  // Details from their latest order, used to pre-fill the checkout form.
  const getLastShipping = async () => {
    const { data, error } = await need()
      .from('orders')
      .select('full_name, phone, address_line1, address_line2, city, state, pin_code, landmark')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error || !data || !data.length) return null;
    return data[0];
  };

  window.NoirData = {
    available: Boolean(client),
    getStats, subscribeStats,
    getUser, onAuthChange, sendCode, verifyCode, signOut,
    createPayment, verifyPayment, getMyOrders, getLastShipping,
  };
})();