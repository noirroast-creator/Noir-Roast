-- NOIR ROAST: "Stop the clock at 10.00" game + 10% coupons. Paste into Supabase > SQL Editor > Run.
-- Safe to run more than once. Run it BEFORE deploying the updated "razorpay" Edge Function.
-- Needs supabase/accounts_update.sql and supabase/payments_update.sql to have been run already.
--
-- Rules, all enforced here in the database (the browser cannot change them):
--   * 3 chances per signed-in customer. A chance is used the moment the clock starts.
--   * Stopping on exactly 10.00 (9.995 to 10.004 seconds) wins ONE 10% coupon, bound to that customer.
--   * The coupon works once, on a paid order, and expires after 90 days.

-- 1) Tables. Row level security is on and there are no policies: only the functions below can touch them.
create table if not exists public.game_attempts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  started_at  timestamptz not null default now(),
  stopped_at  timestamptz,
  elapsed_ms  integer,
  diff_ms     integer,
  won         boolean not null default false
);
create index if not exists game_attempts_user_idx on public.game_attempts (user_id);
alter table public.game_attempts enable row level security;

create table if not exists public.coupons (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  user_id       uuid not null references auth.users (id) on delete cascade,
  percent_off   integer not null default 10 check (percent_off between 1 and 100),
  source        text not null default 'timer_game',
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default (now() + interval '90 days'),
  used_order_id uuid references public.orders (id) on delete set null
);
create unique index if not exists coupons_one_game_coupon_per_user on public.coupons (user_id) where source = 'timer_game';
alter table public.coupons enable row level security;

-- 2) Orders remember which coupon was used and how much it took off.
alter table public.orders add column if not exists coupon_code   text;
alter table public.orders add column if not exists discount_inr  integer not null default 0;

-- 3) Where the customer stands: chances left, closest stop so far, and their coupon if they won.
create or replace function public.game_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_used   integer;
  v_best   integer;
  v_code   text;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select count(*) into v_used from public.game_attempts where user_id = v_uid;
  select diff_ms into v_best from public.game_attempts
    where user_id = v_uid and diff_ms is not null order by abs(diff_ms) asc limit 1;
  select code into v_code from public.coupons where user_id = v_uid and source = 'timer_game';
  return jsonb_build_object('total', 3, 'left', greatest(3 - v_used, 0), 'best_diff_ms', v_best,
                            'won', v_code is not null, 'code', v_code);
end;
$$;

-- 4) Start the clock. Uses up a chance straight away, so reloading the page cannot give a free retry.
create or replace function public.game_start()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_used integer;
  v_id   uuid;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  perform pg_advisory_xact_lock(hashtext('noir_game:' || v_uid::text));
  if exists (select 1 from public.coupons where user_id = v_uid and source = 'timer_game') then
    raise exception 'already_won';
  end if;
  select count(*) into v_used from public.game_attempts where user_id = v_uid;
  if v_used >= 3 then raise exception 'no_chances'; end if;
  insert into public.game_attempts (user_id, started_at) values (v_uid, clock_timestamp()) returning id into v_id;
  return jsonb_build_object('attempt_id', v_id, 'left', 3 - v_used - 1);
end;
$$;

-- 5) Stop the clock. The browser sends the time it measured; the server checks it against its own clock.
create or replace function public.game_stop(p_attempt uuid, p_client_ms integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_a       public.game_attempts%rowtype;
  v_server  integer;
  v_ms      integer;
  v_valid   boolean;
  v_won     boolean;
  v_code    text;
  v_used    integer;
  v_best    integer;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  perform pg_advisory_xact_lock(hashtext('noir_game:' || v_uid::text));

  select * into v_a from public.game_attempts where id = p_attempt and user_id = v_uid for update;
  if not found then raise exception 'unknown_attempt'; end if;
  if v_a.stopped_at is not null then raise exception 'already_stopped'; end if;

  v_server := floor(extract(epoch from (clock_timestamp() - v_a.started_at)) * 1000);
  v_ms     := least(greatest(coalesce(p_client_ms, 0), 0), 60000);
  -- The server must have waited at least as long as the browser says (minus a small margin), and not absurdly longer.
  v_valid  := v_server >= v_ms - 100 and v_server - v_ms <= 10000;
  if not v_valid then v_ms := least(v_server, 60000); end if;

  -- Shown as 10.00 on screen = from 9.995 up to (not including) 10.005 seconds.
  v_won := v_valid and round(v_ms / 10.0) = 1000;

  update public.game_attempts
     set stopped_at = clock_timestamp(), elapsed_ms = v_ms, diff_ms = v_ms - 10000, won = v_won
   where id = v_a.id;

  if v_won and not exists (select 1 from public.coupons where user_id = v_uid and source = 'timer_game') then
    insert into public.coupons (code, user_id, percent_off, source)
    values ('NOIR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)), v_uid, 10, 'timer_game');
  end if;

  select count(*) into v_used from public.game_attempts where user_id = v_uid;
  select diff_ms into v_best from public.game_attempts
    where user_id = v_uid and diff_ms is not null order by abs(diff_ms) asc limit 1;
  select code into v_code from public.coupons where user_id = v_uid and source = 'timer_game';

  return jsonb_build_object('won', v_won, 'elapsed_ms', v_ms, 'diff_ms', v_ms - 10000,
                            'left', greatest(3 - v_used, 0), 'best_diff_ms', v_best, 'code', v_code);
end;
$$;

-- 6) The customer's own coupons.
create or replace function public.my_coupons()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'code', c.code, 'percent_off', c.percent_off, 'expires_at', c.expires_at,
             'used', exists (select 1 from public.orders o where o.id = c.used_order_id and o.payment_status = 'paid'))
           order by c.created_at desc)
    from public.coupons c where c.user_id = v_uid
  ), '[]'::jsonb);
end;
$$;

-- 7) Checkout asks "is this code good for me?" before showing the discount.
create or replace function public.check_coupon(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_c   public.coupons%rowtype;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into v_c from public.coupons where upper(code) = upper(btrim(coalesce(p_code, ''))) and user_id = v_uid;
  if not found then raise exception 'invalid_coupon'; end if;
  if v_c.expires_at < now() then raise exception 'coupon_expired'; end if;
  if exists (select 1 from public.orders o where o.id = v_c.used_order_id and o.payment_status = 'paid') then
    raise exception 'coupon_used';
  end if;
  return jsonb_build_object('code', v_c.code, 'percent_off', v_c.percent_off);
end;
$$;

revoke all on function public.game_status()                 from public, anon;
revoke all on function public.game_start()                  from public, anon;
revoke all on function public.game_stop(uuid, integer)      from public, anon;
revoke all on function public.my_coupons()                  from public, anon;
revoke all on function public.check_coupon(text)            from public, anon;
grant execute on function public.game_status()              to authenticated;
grant execute on function public.game_start()               to authenticated;
grant execute on function public.game_stop(uuid, integer)   to authenticated;
grant execute on function public.my_coupons()               to authenticated;
grant execute on function public.check_coupon(text)         to authenticated;

-- 8) create_order, now with an optional coupon. Same checks as before; the discount is worked out on the server.
drop function if exists public.create_order(uuid, text, jsonb, jsonb);

create or replace function public.create_order(p_user uuid, p_email text, p_customer jsonb, p_items jsonb, p_coupon text default null)
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
  v_discount integer := 0;
  v_total    integer;
  v_coupon   public.coupons%rowtype;
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

  -- Optional coupon: must be this customer's own, unexpired, and not already used on a paid order.
  if nullif(btrim(coalesce(p_coupon, '')), '') is not null then
    select * into v_coupon from public.coupons
      where upper(code) = upper(btrim(p_coupon)) and user_id = p_user for update;
    if not found then raise exception 'invalid_coupon'; end if;
    if v_coupon.expires_at < now() then raise exception 'coupon_expired'; end if;
    if exists (select 1 from public.orders o where o.id = v_coupon.used_order_id and o.payment_status = 'paid') then
      raise exception 'coupon_used';
    end if;
    v_discount := floor(v_subtotal * v_coupon.percent_off / 100.0);
  end if;
  v_total := v_subtotal - v_discount;

  v_number := 'NR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  insert into public.orders (order_number, full_name, email, phone, address_line1, address_line2,
                             city, state, pin_code, landmark, subtotal_inr, delivery_inr, total_inr,
                             user_id, status, payment_status, coupon_code, discount_inr)
  values (v_number, v_name, v_email, v_phone, v_addr1, v_addr2,
          v_city, v_state, v_pin, v_land, v_subtotal, 0, v_total,
          p_user, 'awaiting_payment', 'pending', v_coupon.code, v_discount)
  returning id into v_order_id;

  if v_coupon.id is not null then
    update public.coupons set used_order_id = v_order_id where id = v_coupon.id;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from public.products where id = v_item->>'id';
    insert into public.order_items (order_id, product_id, product_name, unit_price_inr, quantity)
    values (v_order_id, v_prod.id, v_prod.name, v_prod.price_inr, (v_item->>'qty')::integer);
  end loop;

  return jsonb_build_object('order_id', v_order_id, 'order_number', v_number, 'total', v_total);
end;
$$;

revoke all on function public.create_order(uuid, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.create_order(uuid, text, jsonb, jsonb, text) to service_role;
