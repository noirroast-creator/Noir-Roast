-- NOIR ROAST: Razorpay payments. Paste into Supabase > SQL Editor > Run. Safe to run more than once.
-- Run supabase/accounts_update.sql first (it adds customer accounts).
--
-- How it works: the payment server function creates a PENDING order, the customer pays with Razorpay,
-- and the order becomes PAID (and the public counter goes up) only after Razorpay confirms the payment.

-- 1) Payment columns. Orders that already exist (placed before payments) stay visible as paid.
alter table public.orders add column if not exists payment_status text not null default 'paid'
  check (payment_status in ('pending', 'paid', 'failed'));
alter table public.orders alter column payment_status set default 'pending';
alter table public.orders add column if not exists razorpay_order_id text;
alter table public.orders add column if not exists razorpay_payment_id text;
alter table public.orders add column if not exists paid_at timestamptz;
create unique index if not exists orders_razorpay_order_id_key on public.orders (razorpay_order_id) where razorpay_order_id is not null;
create unique index if not exists orders_razorpay_payment_id_key on public.orders (razorpay_payment_id) where razorpay_payment_id is not null;

-- 2) Orders can no longer be created straight from the browser.
drop function if exists public.place_order(jsonb, jsonb);

-- 3) Create a pending order. Only the payment server (service role) can call this.
create or replace function public.create_order(p_user uuid, p_email text, p_customer jsonb, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name   text := btrim(coalesce(p_customer->>'name', ''));
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_phone  text := btrim(coalesce(p_customer->>'phone', ''));
  v_addr1  text := btrim(coalesce(p_customer->>'addr1', ''));
  v_addr2  text := nullif(btrim(coalesce(p_customer->>'addr2', '')), '');
  v_city   text := btrim(coalesce(p_customer->>'city', ''));
  v_state  text := btrim(coalesce(p_customer->>'state', ''));
  v_pin    text := btrim(coalesce(p_customer->>'pin', ''));
  v_land   text := nullif(btrim(coalesce(p_customer->>'landmark', '')), '');
  v_subtotal integer := 0;
  v_order_id uuid;
  v_number   text;
  v_item     jsonb;
  v_prod     public.products%rowtype;
  v_qty      integer;
begin
  if p_user is null then raise exception 'not_signed_in'; end if;
  if char_length(v_name) < 2 or char_length(v_name) > 100            then raise exception 'invalid_name'; end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' or char_length(v_email) > 200 then raise exception 'invalid_email'; end if;
  if v_phone !~ '^[6-9][0-9]{9}$'                                    then raise exception 'invalid_phone'; end if;
  if char_length(v_addr1) < 3 or char_length(v_addr1) > 200          then raise exception 'invalid_address'; end if;
  if char_length(coalesce(v_addr2, '')) > 200 or char_length(coalesce(v_land, '')) > 200 then raise exception 'invalid_address'; end if;
  if char_length(v_city) < 2 or char_length(v_city) > 100            then raise exception 'invalid_city'; end if;
  if char_length(v_state) < 2 or char_length(v_state) > 60           then raise exception 'invalid_state'; end if;
  if v_pin !~ '^[1-9][0-9]{5}$'                                      then raise exception 'invalid_pin'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 10 then raise exception 'invalid_items'; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'qty')::integer;
    if v_qty is null or v_qty < 1 or v_qty > 20 then raise exception 'invalid_quantity'; end if;
    select * into v_prod from public.products where id = v_item->>'id' and active;
    if not found then raise exception 'invalid_product'; end if;
    v_subtotal := v_subtotal + v_prod.price_inr * v_qty;
  end loop;

  v_number := 'NR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  insert into public.orders (order_number, full_name, email, phone, address_line1, address_line2,
                             city, state, pin_code, landmark, subtotal_inr, delivery_inr, total_inr,
                             user_id, status, payment_status)
  values (v_number, v_name, v_email, v_phone, v_addr1, v_addr2,
          v_city, v_state, v_pin, v_land, v_subtotal, 0, v_subtotal,
          p_user, 'awaiting_payment', 'pending')
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from public.products where id = v_item->>'id';
    insert into public.order_items (order_id, product_id, product_name, unit_price_inr, quantity)
    values (v_order_id, v_prod.id, v_prod.name, v_prod.price_inr, (v_item->>'qty')::integer);
  end loop;

  return jsonb_build_object('order_id', v_order_id, 'order_number', v_number, 'total', v_subtotal);
end;
$$;

-- 4) Remember which Razorpay order belongs to our order.
create or replace function public.attach_razorpay_order(p_order_id uuid, p_rzp_order_id text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.orders set razorpay_order_id = p_rzp_order_id
  where id = p_order_id and payment_status = 'pending';
$$;

-- 5) Mark an order paid (once). Checks the amount, and the owner when a customer confirms it.
create or replace function public.mark_order_paid(p_rzp_order_id text, p_payment_id text, p_amount_paise integer, p_user uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order   public.orders%rowtype;
  v_already boolean := false;
begin
  select * into v_order from public.orders where razorpay_order_id = p_rzp_order_id for update;
  if not found then raise exception 'unknown_order'; end if;
  if p_user is not null and v_order.user_id is distinct from p_user then raise exception 'unknown_order'; end if;
  if p_amount_paise is null or p_amount_paise <> v_order.total_inr * 100 then raise exception 'amount_mismatch'; end if;

  if v_order.payment_status = 'paid' then
    v_already := true;
  else
    update public.orders
       set payment_status = 'paid', status = 'new', razorpay_payment_id = p_payment_id, paid_at = now()
     where id = v_order.id;
    update public.order_stats set orders_placed = orders_placed + 1, updated_at = now() where id = 1;
  end if;

  return jsonb_build_object('order_number', v_order.order_number, 'total', v_order.total_inr, 'already_paid', v_already);
end;
$$;

-- 6) Only the payment server may call these.
revoke all on function public.create_order(uuid, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.attach_razorpay_order(uuid, text)       from public, anon, authenticated;
revoke all on function public.mark_order_paid(text, text, integer, uuid) from public, anon, authenticated;
grant execute on function public.create_order(uuid, text, jsonb, jsonb) to service_role;
grant execute on function public.attach_razorpay_order(uuid, text)       to service_role;
grant execute on function public.mark_order_paid(text, text, integer, uuid) to service_role;