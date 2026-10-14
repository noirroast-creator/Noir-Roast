-- NOIR ROAST: accounts. Orders belong to a signed-in customer, who can read only their own.
-- Paste into Supabase > SQL Editor > Run. Safe to run more than once.

alter table public.orders add column if not exists user_id uuid references auth.users(id) on delete set null;
create index if not exists orders_user_id_idx on public.orders (user_id, created_at desc);

revoke all on public.orders, public.order_items from anon, authenticated;
grant select on public.orders, public.order_items to authenticated;

drop policy if exists "read own orders" on public.orders;
create policy "read own orders" on public.orders for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "read own order items" on public.order_items;
create policy "read own order items" on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.user_id = (select auth.uid())));

create or replace function public.place_order(p_customer jsonb, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_name   text := btrim(coalesce(p_customer->>'name', ''));
  -- The order always uses the email the customer verified with the code, not what the form says.
  v_email  text := lower(btrim(coalesce(nullif(auth.jwt()->>'email', ''), p_customer->>'email', '')));
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
  if v_uid is null then raise exception 'not_signed_in'; end if;
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
                             city, state, pin_code, landmark, subtotal_inr, delivery_inr, total_inr, user_id)
  values (v_number, v_name, v_email, v_phone, v_addr1, v_addr2,
          v_city, v_state, v_pin, v_land, v_subtotal, 0, v_subtotal, v_uid)
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

-- Only signed-in customers can call it. Anonymous visitors are refused.
revoke all on function public.place_order(jsonb, jsonb) from public, anon;
grant execute on function public.place_order(jsonb, jsonb) to authenticated;