// Thin wrapper around Supabase for the order counter and placing orders.
(() => {
  const config = window.NOIR_CONFIG || {};
  const lib = window.supabase;
  const client = lib && config.supabaseUrl && config.supabaseAnonKey
    ? lib.createClient(config.supabaseUrl, config.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;

  const toStats = (row) => ({ placed: Number(row.orders_placed), goal: Number(row.goal) });

  const getStats = async () => {
    if (!client) throw new Error('unavailable');
    const { data, error } = await client.from('order_stats').select('orders_placed, goal').eq('id', 1).single();
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

  // customer: { name, email, phone, addr1, addr2, city, state, pin, landmark }; items: [{ id, qty }]
  const placeOrder = async (customer, items) => {
    if (!client) throw new Error('unavailable');
    const { data, error } = await client.rpc('place_order', { p_customer: customer, p_items: items });
    if (error) throw error;
    return data; // { order_number, subtotal, delivery, total }
  };

  window.NoirData = { available: Boolean(client), getStats, subscribeStats, placeOrder };
})();
