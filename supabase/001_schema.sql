-- Run in Supabase SQL editor, in order: 001 -> 002 -> 003 -> 004

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('admin','member')),
  created_at timestamptz not null default now()
);

create table if not exists public.app_settings (
  id smallint primary key default 1,
  app_name text not null default 'POD Board',
  tagline text not null default 'Weekly Capacity Tracker',
  default_capacity numeric not null default 40,
  logo_data text,
  updated_at timestamptz not null default now(),
  constraint singleton_row check (id = 1)
);
insert into public.app_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  capacity numeric not null default 40,
  created_at timestamptz not null default now()
);

create table if not exists public.assignments (
  id uuid primary key default gen_random_uuid(),
  week_label text not null,
  member_id uuid not null references public.members(id) on delete cascade,
  project text not null,
  deadline date,
  mon numeric not null default 0,
  tue numeric not null default 0,
  wed numeric not null default 0,
  thu numeric not null default 0,
  fri numeric not null default 0,
  priority text not null default 'Not started' check (priority in ('Urgent', 'According to SLA''s', 'Not started')),
  status text not null default 'Not started' check (status in ('Not started','In progress','In review','Done','Blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_assignments_week on public.assignments(week_label);
create index if not exists idx_assignments_member on public.assignments(member_id);
