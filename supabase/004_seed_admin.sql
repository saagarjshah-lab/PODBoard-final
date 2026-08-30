-- Run this AFTER the one admin has signed in at least once via the app
-- (their `profiles` row is auto-created by the trigger on first login).
-- Replace the email below with the single admin's @adobe.com address.

update public.profiles
set role = 'admin'
where email = 'REPLACE_WITH_ADMIN@adobe.com';

-- Verify:
-- select id, email, role from public.profiles order by created_at;
