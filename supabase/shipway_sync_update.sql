-- NOIR ROAST: parcel tracking by asking Shipway every 15 minutes (no webhook needed).
-- Paste into Supabase > SQL Editor > Run. Safe to run more than once.
-- Run supabase/shipway_update.sql first.

-- 1) When an order was last checked with Shipway.
alter table public.orders add column if not exists shipway_synced_at timestamptz;

-- 2) Pick the next orders to check (oldest check first). Skips delivered/cancelled/returned parcels
--    and anything older than 60 days. Also tidies the private log (keeps 60 days).
create or replace function public.claim_shipway_tracking(p_limit integer default 15)
returns setof text
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.shipway_log where at < now() - interval '60 days';
  return query
    with picked as (
      select id from public.orders
       where payment_status = 'paid'
         and shipway_status = 'sent'
         and created_at > now() - interval '60 days'
         and coalesce(shipment_status, '') not in ('DEL', 'RTD', 'CAN')
         and (shipway_synced_at is null or shipway_synced_at < now() - interval '10 minutes')
       order by shipway_synced_at nulls first, created_at
       limit least(greatest(coalesce(p_limit, 15), 1), 30)
       for update skip locked
    ), done as (
      update public.orders o
         set shipway_synced_at = now()
        from picked
       where o.id = picked.id
      returning o.order_number
    )
    select order_number from done;
end;
$$;

-- 3) Better shipment update: an order with a tracking number counts as shipped even before Shipway
--    reports a status code.
create or replace function public.update_shipment(p_order_number text, p_awb text, p_carrier text, p_status text, p_tracking_url text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(btrim(coalesce(p_status, '')));
  v_has_awb boolean := btrim(coalesce(p_awb, '')) <> '';
  v_found integer;
begin
  update public.orders
     set awb_number      = coalesce(nullif(left(btrim(coalesce(p_awb, '')), 60), ''), awb_number),
         carrier_name    = coalesce(nullif(left(btrim(coalesce(p_carrier, '')), 80), ''), carrier_name),
         tracking_url    = coalesce(case when p_tracking_url ~* '^https?://' then left(p_tracking_url, 500) end, tracking_url),
         shipment_status = coalesce(nullif(left(v_code, 12), ''), shipment_status),
         status          = case when v_code = 'DEL' then 'delivered'
                                when (v_code <> '' or v_has_awb) and status = 'new' then 'shipped'
                                else status end,
         delivered_at    = case when v_code = 'DEL' then coalesce(delivered_at, now()) else delivered_at end
   where order_number = p_order_number and payment_status = 'paid';
  get diagnostics v_found = row_count;
  return v_found > 0;
end;
$$;

-- 4) Only the server (service role) may call these.
revoke all on function public.claim_shipway_tracking(integer)                       from public, anon, authenticated;
revoke all on function public.update_shipment(text, text, text, text, text)         from public, anon, authenticated;
grant execute on function public.claim_shipway_tracking(integer)                    to service_role;
grant execute on function public.update_shipment(text, text, text, text, text)      to service_role;
