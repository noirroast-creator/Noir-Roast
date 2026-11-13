-- NOIR ROAST: Shipway shipping. Paste into Supabase > SQL Editor > Run. Safe to run more than once.
-- Run supabase/payments_update.sql first. After this, deploy the "shipway" function (see the guide).
--
-- How it works: when an order is paid, the shipway function sends it to your Shipway account.
-- Shipway's tracking webhook then fills in the courier, tracking number and delivery status.

-- 1) Product shipping details. Fill in weight, HSN and GST at the bottom of this file.
alter table public.products add column if not exists sku text;
alter table public.products add column if not exists hsn_code text;
alter table public.products add column if not exists gst_rate numeric(5,2) check (gst_rate is null or (gst_rate >= 0 and gst_rate <= 100));
alter table public.products add column if not exists weight_g integer check (weight_g is null or weight_g > 0);
update public.products set sku = 'NR-ORIGINAL-100G' where id = 'original' and sku is null;
update public.products set sku = 'NR-DUO-2X100G'    where id = 'duo'      and sku is null;

-- 2) Shipping columns on orders. Orders paid BEFORE this update are marked 'skipped' (never sent to Shipway).
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'shipway_status') then
    alter table public.orders add column shipway_status text not null default 'pending'
      check (shipway_status in ('pending', 'sending', 'sent', 'failed', 'skipped'));
    update public.orders set shipway_status = 'skipped';
  end if;
end $$;
alter table public.orders add column if not exists shipway_attempted_at timestamptz;
alter table public.orders add column if not exists shipway_sent_at timestamptz;
alter table public.orders add column if not exists awb_number text;
alter table public.orders add column if not exists carrier_name text;
alter table public.orders add column if not exists tracking_url text;
alter table public.orders add column if not exists shipment_status text;
alter table public.orders add column if not exists delivered_at timestamptz;
create index if not exists orders_shipway_queue_idx on public.orders (shipway_status) where payment_status = 'paid';
create index if not exists orders_awb_idx on public.orders (awb_number) where awb_number is not null;

-- 3) Private log of what Shipway answered (customers can never read this).
create table if not exists public.shipway_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  order_number text not null,
  ok boolean not null,
  message text
);
alter table public.shipway_log enable row level security;
revoke all on public.shipway_log from anon, authenticated;

-- 4) Take an order for sending. Returns the order (with items) or null if it is not due.
--    Safe against double sending: only one caller can claim it at a time.
create or replace function public.claim_shipway_push(p_order_number text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
begin
  update public.orders
     set shipway_status = 'sending', shipway_attempted_at = now()
   where order_number = p_order_number
     and payment_status = 'paid'
     and (shipway_status in ('pending', 'failed')
          or (shipway_status = 'sending' and shipway_attempted_at < now() - interval '10 minutes'))
  returning * into v_order;
  if not found then return null; end if;

  return jsonb_build_object(
    'order_number', v_order.order_number,
    'full_name', v_order.full_name,
    'email', v_order.email,
    'phone', v_order.phone,
    'address_line1', v_order.address_line1,
    'address_line2', v_order.address_line2,
    'landmark', v_order.landmark,
    'city', v_order.city,
    'state', v_order.state,
    'pin_code', v_order.pin_code,
    'total_inr', v_order.total_inr,
    'paid_at', v_order.paid_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', oi.product_name,
               'price', oi.unit_price_inr,
               'quantity', oi.quantity,
               'sku', p.sku,
               'hsn_code', p.hsn_code,
               'gst_rate', p.gst_rate,
               'weight_g', p.weight_g) order by oi.id)
        from public.order_items oi
        left join public.products p on p.id = oi.product_id
       where oi.order_id = v_order.id), '[]'::jsonb)
  );
end;
$$;

-- 5) Record the result of sending.
create or replace function public.finish_shipway_push(p_order_number text, p_ok boolean, p_message text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.orders
     set shipway_status = case when p_ok then 'sent' else 'failed' end,
         shipway_sent_at = case when p_ok then now() else shipway_sent_at end
   where order_number = p_order_number and shipway_status = 'sending';
  insert into public.shipway_log (order_number, ok, message) values (p_order_number, p_ok, left(coalesce(p_message, ''), 500));
end;
$$;

-- 6) Orders that still need sending (used to retry after a failure).
create or replace function public.list_shipway_pending()
returns setof text
language sql
security definer
set search_path = public
as $$
  select order_number from public.orders
   where payment_status = 'paid'
     and (shipway_status in ('pending', 'failed')
          or (shipway_status = 'sending' and shipway_attempted_at < now() - interval '10 minutes'))
     and (shipway_attempted_at is null or shipway_attempted_at < now() - interval '5 minutes')
   order by created_at
   limit 20;
$$;

-- 7) Tracking update from Shipway's webhook.
create or replace function public.update_shipment(p_order_number text, p_awb text, p_carrier text, p_status text, p_tracking_url text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(btrim(coalesce(p_status, '')));
  v_found integer;
begin
  update public.orders
     set awb_number      = coalesce(nullif(left(btrim(coalesce(p_awb, '')), 60), ''), awb_number),
         carrier_name    = coalesce(nullif(left(btrim(coalesce(p_carrier, '')), 80), ''), carrier_name),
         tracking_url    = coalesce(case when p_tracking_url ~* '^https?://' then left(p_tracking_url, 500) end, tracking_url),
         shipment_status = coalesce(nullif(left(v_code, 12), ''), shipment_status),
         status          = case when v_code = 'DEL' then 'delivered'
                                when v_code <> '' and status = 'new' then 'shipped'
                                else status end,
         delivered_at    = case when v_code = 'DEL' then coalesce(delivered_at, now()) else delivered_at end
   where order_number = p_order_number and payment_status = 'paid';
  get diagnostics v_found = row_count;
  return v_found > 0;
end;
$$;

-- 8) Only the server (service role) may call these.
revoke all on function public.claim_shipway_push(text)                              from public, anon, authenticated;
revoke all on function public.finish_shipway_push(text, boolean, text)              from public, anon, authenticated;
revoke all on function public.list_shipway_pending()                                from public, anon, authenticated;
revoke all on function public.update_shipment(text, text, text, text, text)         from public, anon, authenticated;
grant execute on function public.claim_shipway_push(text)                           to service_role;
grant execute on function public.finish_shipway_push(text, boolean, text)           to service_role;
grant execute on function public.list_shipway_pending()                             to service_role;
grant execute on function public.update_shipment(text, text, text, text, text)      to service_role;

-- 9) YOUR TURN: fill in the real packed weight (grams, jar + packing), HSN code and GST rate for each product.
--    Ask your accountant for the HSN code and GST %. Remove the two dashes at the start of each line, edit, and run.
--    Leave a value out and it is simply not sent to Shipway.
-- update public.products set weight_g = 250, hsn_code = '000000', gst_rate = 0 where id = 'original';
-- update public.products set weight_g = 450, hsn_code = '000000', gst_rate = 0 where id = 'duo';
