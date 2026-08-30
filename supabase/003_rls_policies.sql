alter table public.profiles enable row level security;
alter table public.app_settings enable row level security;
alter table public.members enable row level security;
alter table public.assignments enable row level security;

-- Helper functions (security definer + stable so they're cheap to call from policies)
create or replace function public.is_adobe_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.email ilike '%@adobe.com'
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  );
$$;

-- ---------------- profiles ----------------
drop policy if exists "read own or admin" on public.profiles;
create policy "read own or admin" on public.profiles
  for select using (auth.uid() = id or public.is_admin());

-- Inserts happen only via the handle_new_user() trigger (security definer),
-- so direct client inserts are blocked outright.
drop policy if exists "no direct inserts" on public.profiles;
create policy "no direct inserts" on public.profiles
  for insert with check (false);

drop policy if exists "admin can update roles" on public.profiles;
create policy "admin can update roles" on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());

-- ---------------- app_settings ----------------
drop policy if exists "adobe users read settings" on public.app_settings;
create policy "adobe users read settings" on public.app_settings
  for select using (public.is_adobe_user());

drop policy if exists "admin writes settings" on public.app_settings;
create policy "admin writes settings" on public.app_settings
  for update using (public.is_admin()) with check (public.is_admin());

-- ---------------- members ----------------
drop policy if exists "adobe users read members" on public.members;
create policy "adobe users read members" on public.members
  for select using (public.is_adobe_user());

drop policy if exists "admin inserts members" on public.members;
create policy "admin inserts members" on public.members
  for insert with check (public.is_admin());

drop policy if exists "admin updates members" on public.members;
create policy "admin updates members" on public.members
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin deletes members" on public.members;
create policy "admin deletes members" on public.members
  for delete using (public.is_admin());

-- ---------------- assignments (any signed-in @adobe.com user can log hours) ----------------
drop policy if exists "adobe users read assignments" on public.assignments;
create policy "adobe users read assignments" on public.assignments
  for select using (public.is_adobe_user());

drop policy if exists "adobe users insert assignments" on public.assignments;
create policy "adobe users insert assignments" on public.assignments
  for insert with check (public.is_adobe_user());

drop policy if exists "adobe users update assignments" on public.assignments;
create policy "adobe users update assignments" on public.assignments
  for update using (public.is_adobe_user()) with check (public.is_adobe_user());

drop policy if exists "adobe users delete assignments" on public.assignments;
create policy "adobe users delete assignments" on public.assignments
  for delete using (public.is_adobe_user());
