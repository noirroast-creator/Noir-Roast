-- NOIR ROAST: Supabase schema. Paste this whole file into Supabase > SQL Editor > Run.
-- Safe to re-run: it only creates what is missing.
-- After this file, also run supabase/accounts_update.sql (adds customer accounts and signed-in orders).
-- Then run supabase/payments_update.sql (Razorpay payments; replaces place_order).

-- 1) Catalogue. Prices live here so the browser can never set its own price.
create table if not exists public.products (
  id         text primary key,
  name       text not null,
  price_inr  integer not null check (price_inr > 0),
  active     boolean not null default true
);
insert into public.products (id, name, price_inr) values
  ('original', 'The Original', 999),
  ('duo',      'The Duo',       1899)
on conflict (id) do update set name = excluded.name, price_inr = excluded.price_inr;

-- 2) Orders: real customer details. Nobody on the website can read these back.
create table if not exists public.orders (
  id             uuid primary key default gen_random_uuid(),
  order_number   text unique not null,
  created_at     timestamptz not null default now(),
  full_name      text not null,
  email          text not null,
  phone          text not null,
  address_line1  text not null,
  address_line2  text,
  city           text not null,
  state          text not null,
  pin_code       text not null,
  landmark       text,
  subtotal_inr   integer not null,
  delivery_inr   integer not null,
  total_inr      integer not null,
  status         text not null default 'new'
);

create table if not exists public.order_items (
  id              bigint generated always as identity primary key,
  order_id        uuid not null references public.orders(id) on delete cascade,
  product_id      text not null references public.products(id),
  product_name    text not null,
  unit_price_inr  integer not null,
  quantity        integer not null check (quantity between 1 and 20)
);

-- 3) The public "orders placed" counter (one row, safe to show everyone).
create table if not exists public.order_stats (
  id             integer primary key default 1 check (id = 1),
  orders_placed  integer not null default 0,
  goal           integer not null default 1000,
  updated_at     timestamptz not null default now()
);
-- The counter starts at 59. Real orders then add to it one by one.
insert into public.order_stats (id, orders_placed) values (1, 59) on conflict (id) do nothing;

-- 4) Row Level Security: lock everything, then open only what visitors need.
alter table public.products    enable row level security;
alter table public.orders      enable row level security;
alter table public.order_items enable row level security;
alter table public.order_stats enable row level security;

drop policy if exists "read active products" on public.products;
create policy "read active products" on public.products for select to anon, authenticated using (active);

drop policy if exists "read order stats" on public.order_stats;
create policy "read order stats" on public.order_stats for select to anon, authenticated using (true);

-- No policies on orders / order_items: visitors cannot read, change or delete them.
revoke all on public.orders, public.order_items from anon, authenticated;
revoke insert, update, delete on public.products, public.order_stats from anon, authenticated;

-- 5) The only way to place an order: a server-side function that checks everything
--    and works out the price itself.
create or replace function public.place_order(p_customer jsonb, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name   text := btrim(coalesce(p_customer->>'name', ''));
  v_email  text := lower(btrim(coalesce(p_customer->>'email', '')));
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

  v_number   := 'NR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  insert into public.orders (order_number, full_name, email, phone, address_line1, address_line2,
                             city, state, pin_code, landmark, subtotal_inr, delivery_inr, total_inr)
  values (v_number, v_name, v_email, v_phone, v_addr1, v_addr2,
          v_city, v_state, v_pin, v_land, v_subtotal, 0, v_subtotal)
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from public.products where id = v_item->>'id';
    insert into public.order_items (order_id, product_id, product_name, unit_price_inr, quantity)
    values (v_order_id, v_prod.id, v_prod.name, v_prod.price_inr, (v_item->>'qty')::integer);
  end loop;

  update public.order_stats set orders_placed = orders_placed + 1, updated_at = now() where id = 1;

  return jsonb_build_object('order_number', v_number, 'subtotal', v_subtotal, 'total', v_subtotal);
end;
$$;

revoke all on function public.place_order(jsonb, jsonb) from public;
grant execute on function public.place_order(jsonb, jsonb) to anon, authenticated;

-- 6) Realtime: let browsers subscribe to counter changes.
do $$
begin
  alter publication supabase_realtime add table public.order_stats;
exception when duplicate_object then null;
end $$;