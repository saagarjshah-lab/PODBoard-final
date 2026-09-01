-- supabase/schema_update.sql
-- Idempotent migration. Safe to run multiple times, and safe to run after
-- 001_schema.sql / 002_auth_domain_restriction.sql / 003_rls_policies.sql /
-- 004_seed_admin.sql / 005_enable_realtime.sql have already been applied.
--
-- Adds:
--   1. members.email + members.auth_user_id  -> lets a logged-in @adobe.com
--      user "claim" the member row that matches their email, so the member
--      dashboard can query "my" data by auth.uid() instead of by name.
--   2. projects table                        -> a real project entity
--      (name/status/description), independent of the free-text `project`
--      field already used on weekly `assignments` rows.
--   3. project_assignments table             -> which members are staffed
--      on which project (admin-managed).
--   4. RLS policies for both new tables, plus a narrow "self-claim" policy
--      on `members` so a user can link their own row once.
--   5. Realtime publication for the new tables.
--   6. Seed: grants sashah@adobe.com the admin role.

begin;

-- ---------------------------------------------------------------------
-- 1. Link members <-> auth users
-- ---------------------------------------------------------------------
alter table public.members
  add column if not exists email text,
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null;

create unique index if not exists idx_members_auth_user_id
  on public.members(auth_user_id)
  where auth_user_id is not null;

create unique index if not exists idx_members_email_lower
  on public.members (lower(email))
  where email is not null;

-- ---------------------------------------------------------------------
-- 2. Projects (distinct entity from the weekly `assignments.project` text)
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

-- ---------------------------------------------------------------------
-- 3. Project <-> member staffing
-- ---------------------------------------------------------------------
create table if not exists public.project_assignments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  unique (project_id, member_id)
);

create index if not exists idx_project_assignments_project on public.project_assignments(project_id);
create index if not exists idx_project_assignments_member on public.project_assignments(member_id);

-- ---------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------
alter table public.projects enable row level security;
alter table public.project_assignments enable row level security;

-- projects: any signed-in @adobe.com user can read; only admins write
drop policy if exists "adobe users read projects" on public.projects;
create policy "adobe users read projects" on public.projects
  for select using (public.is_adobe_user());

drop policy if exists "admin inserts projects" on public.projects;
create policy "admin inserts projects" on public.projects
  for insert with check (public.is_admin());

drop policy if exists "admin updates projects" on public.projects;
create policy "admin updates projects" on public.projects
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin deletes projects" on public.projects;
create policy "admin deletes projects" on public.projects
  for delete using (public.is_admin());

-- project_assignments: any signed-in @adobe.com user can read (so members
-- can see their own staffing); only admins write
drop policy if exists "adobe users read project_assignments" on public.project_assignments;
create policy "adobe users read project_assignments" on public.project_assignments
  for select using (public.is_adobe_user());

drop policy if exists "admin inserts project_assignments" on public.project_assignments;
create policy "admin inserts project_assignments" on public.project_assignments
  for insert with check (public.is_admin());

drop policy if exists "admin deletes project_assignments" on public.project_assignments;
create policy "admin deletes project_assignments" on public.project_assignments
  for delete using (public.is_admin());

-- members: allow a signed-in user to claim ONE unclaimed member row that
-- matches their own email (case-insensitive). This is intentionally narrow:
-- it only permits setting auth_user_id on a row that has no auth_user_id
-- yet and whose email matches the caller's own JWT email.
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

-- ---------------------------------------------------------------------
-- 5. Realtime
-- ---------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.projects;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.project_assignments;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------
-- 6. Seed admin
-- ---------------------------------------------------------------------
-- Only takes effect once sashah@adobe.com has signed in at least once
-- (their `profiles` row is auto-created by the existing handle_new_user
-- trigger). Safe to re-run.
update public.profiles
set role = 'admin'
where lower(email) = 'sashah@adobe.com';

commit;
