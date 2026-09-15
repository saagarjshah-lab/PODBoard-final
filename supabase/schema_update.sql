-- supabase/schema_update.sql
-- CONSOLIDATED migration covering all four phases of the enterprise upgrade.
-- Idempotent and safe to run exactly once, regardless of whether some or
-- all of the individual phase scripts were already applied previously —
-- every statement either uses IF NOT EXISTS / IF EXISTS or drops-then-
-- recreates a policy/function with the same final definition.
--
-- Assumes 001_schema.sql and 002_auth_domain_restriction.sql have already
-- been run (they create `profiles`, `members`, `assignments`,
-- `app_settings`, and the @adobe.com signup trigger). 003/004/005 are
-- superseded by this file — you don't need to run them separately.
--
-- ===========================================================================
-- PHASE 1 — 3-tier RBAC (super_admin / admin / member)
-- ===========================================================================
--   - Widens profiles.role to the 3-tier model.
--   - is_admin() = "admin tier or higher" (admin OR super_admin OR the
--     hard-coded sashah@adobe.com fallback) — every table below that calls
--     is_admin() automatically gets 3-tier behavior with no further changes.
--   - is_super_admin() gates two things only: role assignment, and global
--     settings (branding/default capacity).
--
-- PHASE 2 — Executive Roll-Up dashboard
-- ===========================================================================
--   - Adds projects.billable (Billable vs Internal classification).
--   - Everything else (KPIs, availability/free-date forecasting) is computed
--     client-side; no further schema needed.
--
-- PHASE 3 — Reporting (dual export engine, timelines, audit trail)
-- ===========================================================================
--   - Adds projects.start_date / target_date / completed_at.
--   - Adds audit_logs — append-only (no update/delete policy exists at all,
--     not even for Super Admin).
--
-- PHASE 4 — Auth hardening (password reset + TOTP 2FA)
-- ===========================================================================
--   - No schema changes. Supabase's built-in auth.mfa_factors table and
--     resetPasswordForEmail/updateUser handle everything.

begin;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Core tables (created if this is a fresh database; no-ops otherwise)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'member',
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

-- ===========================================================================
-- PHASE 1: profiles.role -> 3-tier
-- ===========================================================================
do $$
declare
  con record;
begin
  for con in
    select c.conname
    from pg_constraint c
    join pg_class rel on rel.oid = c.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'profiles'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%role%'
  loop
    execute format('alter table public.profiles drop constraint %I', con.conname);
  end loop;
end $$;

alter table public.profiles
  add constraint profiles_role_check check (role in ('super_admin', 'admin', 'member'));

-- ===========================================================================
-- PHASE 2: billable classification
-- ===========================================================================
alter table public.projects
  add column if not exists billable boolean not null default true;

-- ===========================================================================
-- PHASE 3: timeline dates + audit log
-- ===========================================================================
alter table public.projects
  add column if not exists start_date date,
  add column if not exists target_date date,
  add column if not exists completed_at timestamptz;

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text,
  entity_type text not null check (entity_type in ('project', 'project_assignment', 'profile')),
  entity_id uuid,
  secondary_entity_id uuid,
  action text not null,
  details jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_logs_entity on public.audit_logs(entity_type, entity_id);
create index if not exists idx_audit_logs_secondary on public.audit_logs(secondary_entity_id);
create index if not exists idx_audit_logs_created_at on public.audit_logs(created_at);

-- ===========================================================================
-- Helper functions (recreated unconditionally — same signatures throughout)
-- ===========================================================================
create or replace function public.is_adobe_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.email ilike '%@adobe.com'
  );
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and (p.role in ('admin', 'super_admin') or lower(p.email) = 'sashah@adobe.com')
  );
$$;

create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and (p.role = 'super_admin' or lower(p.email) = 'sashah@adobe.com')
  );
$$;

create or replace function public.my_member_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.members where auth_user_id = auth.uid() limit 1;
$$;

-- ===========================================================================
-- RLS — enable on everything
-- ===========================================================================
alter table public.profiles enable row level security;
alter table public.members enable row level security;
alter table public.assignments enable row level security;
alter table public.app_settings enable row level security;
alter table public.projects enable row level security;
alter table public.project_assignments enable row level security;
alter table public.time_logs enable row level security;
alter table public.audit_logs enable row level security;

-- ---- profiles ----
drop policy if exists "read own profile" on public.profiles;
drop policy if exists "read own or admin" on public.profiles;
drop policy if exists "read own or admin members" on public.profiles;
drop policy if exists "read own or admin profiles" on public.profiles;
drop policy if exists "read own or superadmin profiles" on public.profiles;
create policy "read own or superadmin profiles" on public.profiles
  for select using (auth.uid() = id or public.is_super_admin());

drop policy if exists "no direct inserts" on public.profiles;
create policy "no direct inserts" on public.profiles for insert with check (false);

drop policy if exists "admin can update roles" on public.profiles;
drop policy if exists "admin updates roles" on public.profiles;
drop policy if exists "superadmin updates roles" on public.profiles;
create policy "superadmin updates roles" on public.profiles
  for update using (public.is_super_admin())
  with check (public.is_super_admin() and role in ('admin', 'member'));

-- ---- members ----
drop policy if exists "adobe users read members" on public.members;
drop policy if exists "read own or admin members" on public.members;
create policy "read own or admin members" on public.members
  for select using (public.is_admin() or auth_user_id = auth.uid());

drop policy if exists "admin inserts members" on public.members;
create policy "admin inserts members" on public.members for insert with check (public.is_admin());
drop policy if exists "admin updates members" on public.members;
create policy "admin updates members" on public.members for update using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin deletes members" on public.members;
create policy "admin deletes members" on public.members for delete using (public.is_admin());

drop policy if exists "self claim member row" on public.members;
create policy "self claim member row" on public.members
  for update using (
    auth_user_id is null and email is not null
    and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
  with check (
    auth_user_id = auth.uid() and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

-- ---- assignments (legacy per-week hour log; admin-tier only, end to end) ----
drop policy if exists "adobe users read assignments" on public.assignments;
drop policy if exists "adobe users insert assignments" on public.assignments;
drop policy if exists "adobe users update assignments" on public.assignments;
drop policy if exists "adobe users delete assignments" on public.assignments;
drop policy if exists "admin full select assignments" on public.assignments;
create policy "admin full select assignments" on public.assignments for select using (public.is_admin());
drop policy if exists "admin full insert assignments" on public.assignments;
create policy "admin full insert assignments" on public.assignments for insert with check (public.is_admin());
drop policy if exists "admin full update assignments" on public.assignments;
create policy "admin full update assignments" on public.assignments for update using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin full delete assignments" on public.assignments;
create policy "admin full delete assignments" on public.assignments for delete using (public.is_admin());

-- ---- app_settings (branding/default capacity: super-admin only to write) ----
drop policy if exists "adobe users read settings" on public.app_settings;
create policy "adobe users read settings" on public.app_settings for select using (public.is_adobe_user());
drop policy if exists "admin writes settings" on public.app_settings;
drop policy if exists "superadmin writes settings" on public.app_settings;
create policy "superadmin writes settings" on public.app_settings
  for update using (public.is_super_admin()) with check (public.is_super_admin());

-- ---- projects (member sees only what they're staffed on) ----
drop policy if exists "adobe users read projects" on public.projects;
drop policy if exists "member reads assigned projects" on public.projects;
create policy "member reads assigned projects" on public.projects
  for select using (
    public.is_admin()
    or exists (select 1 from public.project_assignments pa where pa.project_id = projects.id and pa.member_id = public.my_member_id())
  );
drop policy if exists "admin inserts projects" on public.projects;
create policy "admin inserts projects" on public.projects for insert with check (public.is_admin());
drop policy if exists "admin updates projects" on public.projects;
create policy "admin updates projects" on public.projects for update using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin deletes projects" on public.projects;
create policy "admin deletes projects" on public.projects for delete using (public.is_admin());

-- ---- project_assignments ----
drop policy if exists "adobe users read project_assignments" on public.project_assignments;
drop policy if exists "member reads own project_assignments" on public.project_assignments;
create policy "member reads own project_assignments" on public.project_assignments
  for select using (public.is_admin() or member_id = public.my_member_id());
drop policy if exists "admin inserts project_assignments" on public.project_assignments;
create policy "admin inserts project_assignments" on public.project_assignments for insert with check (public.is_admin());
drop policy if exists "admin deletes project_assignments" on public.project_assignments;
create policy "admin deletes project_assignments" on public.project_assignments for delete using (public.is_admin());

-- ---- time_logs (member: own rows only; admin: all) ----
drop policy if exists "admin or own select time_logs" on public.time_logs;
create policy "admin or own select time_logs" on public.time_logs for select using (public.is_admin() or user_id = auth.uid());
drop policy if exists "admin or own insert time_logs" on public.time_logs;
create policy "admin or own insert time_logs" on public.time_logs for insert with check (public.is_admin() or user_id = auth.uid());
drop policy if exists "admin or own update time_logs" on public.time_logs;
create policy "admin or own update time_logs" on public.time_logs for update using (public.is_admin() or user_id = auth.uid()) with check (public.is_admin() or user_id = auth.uid());
drop policy if exists "admin delete time_logs" on public.time_logs;
create policy "admin delete time_logs" on public.time_logs for delete using (public.is_admin());

-- ---- audit_logs (admin reads/writes; append-only — no update/delete policy exists) ----
drop policy if exists "admin reads audit_logs" on public.audit_logs;
create policy "admin reads audit_logs" on public.audit_logs for select using (public.is_admin());
drop policy if exists "admin inserts audit_logs" on public.audit_logs;
create policy "admin inserts audit_logs" on public.audit_logs for insert with check (public.is_admin());

-- ===========================================================================
-- Realtime
-- ===========================================================================
do $$ begin alter publication supabase_realtime add table public.projects; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.project_assignments; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.time_logs; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.audit_logs; exception when duplicate_object then null; end $$;

-- ===========================================================================
-- Seed: sashah@adobe.com is super_admin
-- ===========================================================================
-- Takes effect once she has signed in at least once (profiles row is
-- auto-created by the handle_new_user trigger from 002_auth_domain_restriction.sql).
update public.profiles set role = 'super_admin' where lower(email) = 'sashah@adobe.com';

commit;
