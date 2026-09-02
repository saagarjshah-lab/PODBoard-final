-- supabase/schema_update.sql
--
-- Idempotent, self-contained migration for the strict Admin/Member workspace
-- split. Safe to run on a fresh database (after 001_schema.sql /
-- 002_auth_domain_restriction.sql have created `profiles`/`members`/
-- `assignments`/`app_settings` and the @adobe.com signup trigger) AND safe to
-- re-run on a database that already has an earlier version of this file
-- applied (e.g. the one that first introduced `projects`/`project_assignments`).
--
-- What this does:
--   1. Ensures `profiles`, `members` (+ email/auth_user_id link) exist.
--   2. Creates `projects`, `project_assignments`, and `time_logs`.
--   3. (Re)creates helper functions `is_admin()`, `is_adobe_user()`,
--      `my_member_id()` — `is_admin()` treats sashah@adobe.com as admin even
--      before her `profiles.role` is manually flipped, matching the app's
--      client-side admin check exactly.
--   4. Tightens RLS to a strict model:
--        - Admins: full SELECT/INSERT/UPDATE/DELETE on every table below.
--        - Members: can only SELECT projects/assignments/time_logs that are
--          their own; can INSERT/UPDATE only their own `time_logs`; the
--          legacy `assignments` table (per-week hour logging on the admin
--          Week Board) becomes admin-only end to end, since the Member
--          Workspace now uses `time_logs` instead.
--   5. Adds the new tables to the realtime publication.
--   6. Seeds sashah@adobe.com as admin.

begin;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. Core tables (created if this is a fresh database; no-ops otherwise)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('admin','member')),
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  capacity numeric not null default 40,
  created_at timestamptz not null default now()
);

alter table public.members
  add column if not exists email text,
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null;

create unique index if not exists idx_members_auth_user_id
  on public.members(auth_user_id) where auth_user_id is not null;
create unique index if not exists idx_members_email_lower
  on public.members (lower(email)) where email is not null;

-- ---------------------------------------------------------------------
-- 2. Projects, staffing, and time logs
-- ---------------------------------------------------------------------
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  status text not null default 'ongoing' check (status in ('ongoing', 'on_hold', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists idx_projects_name_lower on public.projects (lower(name));

create table if not exists public.project_assignments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  unique (project_id, member_id)
);
create index if not exists idx_project_assignments_project on public.project_assignments(project_id);
create index if not exists idx_project_assignments_member on public.project_assignments(member_id);

create table if not exists public.time_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  duration integer not null default 0 check (duration >= 0), -- seconds
  start_time timestamptz not null default now(),
  end_time timestamptz,
  notes text,
  is_manual boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_time_logs_user on public.time_logs(user_id);
create index if not exists idx_time_logs_project on public.time_logs(project_id);
create index if not exists idx_time_logs_start_time on public.time_logs(start_time);

-- ---------------------------------------------------------------------
-- 3. Helper functions (safe to recreate — same signature, same owner)
-- ---------------------------------------------------------------------
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

-- Admin check mirrors the client: role = 'admin' OR the hard-coded
-- sashah@adobe.com account, so RLS and UI never disagree about who's admin.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and (p.role = 'admin' or lower(p.email) = 'sashah@adobe.com')
  );
$$;

create or replace function public.my_member_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.members where auth_user_id = auth.uid() limit 1;
$$;

-- ---------------------------------------------------------------------
-- 4. RLS — strict isolation
-- ---------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.members enable row level security;
alter table public.assignments enable row level security;
alter table public.projects enable row level security;
alter table public.project_assignments enable row level security;
alter table public.time_logs enable row level security;

-- profiles: read own row, or any row if admin. Inserts only via trigger.
drop policy if exists "read own profile" on public.profiles;
drop policy if exists "read own or admin" on public.profiles;
drop policy if exists "read own or admin members" on public.profiles;
drop policy if exists "read own or admin profiles" on public.profiles;
create policy "read own or admin profiles" on public.profiles
  for select using (auth.uid() = id or public.is_admin());

drop policy if exists "no direct inserts" on public.profiles;
create policy "no direct inserts" on public.profiles
  for insert with check (false);

drop policy if exists "admin can update roles" on public.profiles;
drop policy if exists "admin updates roles" on public.profiles;
create policy "admin updates roles" on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());

-- members: admin sees/manages everyone; a member sees only their own linked row.
drop policy if exists "adobe users read members" on public.members;
drop policy if exists "read own or admin members" on public.members;
create policy "read own or admin members" on public.members
  for select using (public.is_admin() or auth_user_id = auth.uid());

drop policy if exists "admin inserts members" on public.members;
create policy "admin inserts members" on public.members
  for insert with check (public.is_admin());

drop policy if exists "admin updates members" on public.members;
create policy "admin updates members" on public.members
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin deletes members" on public.members;
create policy "admin deletes members" on public.members
  for delete using (public.is_admin());

-- Narrow self-claim: lets a user link their own member row once, by email
-- match, without needing admin rights. Required for `claimMemberByEmail`.
drop policy if exists "self claim member row" on public.members;
create policy "self claim member row" on public.members
  for update using (
    auth_user_id is null
    and email is not null
    and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
  with check (
    auth_user_id = auth.uid()
    and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

-- assignments (legacy per-week hour log): admin-only end to end. The Member
-- Workspace no longer reads or writes this table — it uses `time_logs`.
drop policy if exists "adobe users read assignments" on public.assignments;
drop policy if exists "adobe users insert assignments" on public.assignments;
drop policy if exists "adobe users update assignments" on public.assignments;
drop policy if exists "adobe users delete assignments" on public.assignments;
drop policy if exists "admin full select assignments" on public.assignments;
create policy "admin full select assignments" on public.assignments
  for select using (public.is_admin());
drop policy if exists "admin full insert assignments" on public.assignments;
create policy "admin full insert assignments" on public.assignments
  for insert with check (public.is_admin());
drop policy if exists "admin full update assignments" on public.assignments;
create policy "admin full update assignments" on public.assignments
  for update using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin full delete assignments" on public.assignments;
create policy "admin full delete assignments" on public.assignments
  for delete using (public.is_admin());

-- projects: admin sees/manages all; a member sees only projects they're
-- staffed on via project_assignments.
drop policy if exists "adobe users read projects" on public.projects;
drop policy if exists "member reads assigned projects" on public.projects;
create policy "member reads assigned projects" on public.projects
  for select using (
    public.is_admin()
    or exists (
      select 1 from public.project_assignments pa
      where pa.project_id = projects.id and pa.member_id = public.my_member_id()
    )
  );
drop policy if exists "admin inserts projects" on public.projects;
create policy "admin inserts projects" on public.projects
  for insert with check (public.is_admin());
drop policy if exists "admin updates projects" on public.projects;
create policy "admin updates projects" on public.projects
  for update using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin deletes projects" on public.projects;
create policy "admin deletes projects" on public.projects
  for delete using (public.is_admin());

-- project_assignments: admin manages all; a member can only see their own
-- staffing rows (needed so the member can tell which projects are theirs).
drop policy if exists "adobe users read project_assignments" on public.project_assignments;
drop policy if exists "member reads own project_assignments" on public.project_assignments;
create policy "member reads own project_assignments" on public.project_assignments
  for select using (public.is_admin() or member_id = public.my_member_id());
drop policy if exists "admin inserts project_assignments" on public.project_assignments;
create policy "admin inserts project_assignments" on public.project_assignments
  for insert with check (public.is_admin());
drop policy if exists "admin deletes project_assignments" on public.project_assignments;
create policy "admin deletes project_assignments" on public.project_assignments
  for delete using (public.is_admin());

-- time_logs: admin full access; a member can select/insert/update ONLY
-- their own rows, and cannot delete (matches the spec exactly).
drop policy if exists "admin or own select time_logs" on public.time_logs;
create policy "admin or own select time_logs" on public.time_logs
  for select using (public.is_admin() or user_id = auth.uid());
drop policy if exists "admin or own insert time_logs" on public.time_logs;
create policy "admin or own insert time_logs" on public.time_logs
  for insert with check (public.is_admin() or user_id = auth.uid());
drop policy if exists "admin or own update time_logs" on public.time_logs;
create policy "admin or own update time_logs" on public.time_logs
  for update using (public.is_admin() or user_id = auth.uid()) with check (public.is_admin() or user_id = auth.uid());
drop policy if exists "admin delete time_logs" on public.time_logs;
create policy "admin delete time_logs" on public.time_logs
  for delete using (public.is_admin());

-- ---------------------------------------------------------------------
-- 5. Realtime
-- ---------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.projects;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.project_assignments;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.time_logs;
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- 6. Seed admin
-- ---------------------------------------------------------------------
-- Takes effect once sashah@adobe.com has signed in at least once (their
-- `profiles` row is auto-created by the existing handle_new_user trigger).
-- Not strictly required for admin access (is_admin() already recognizes this
-- email), but keeps the `role` column accurate for display in the UI badge.
update public.profiles
set role = 'admin'
where lower(email) = 'sashah@adobe.com';

commit;
