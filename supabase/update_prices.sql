-- NOIR ROAST: new prices. Paste into Supabase > SQL Editor > Run. Safe to run more than once.
-- The checkout charges THESE prices (the website's displayed price is only for show).
update public.products set price_inr = 1299 where id = 'original';
update public.products set price_inr = 2499 where id = 'duo';

-- Check: should show original 1299 and duo 2499.
select id, name, price_inr from public.products order by id;
