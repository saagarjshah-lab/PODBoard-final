-- Blocks signup at the database level for any non-@adobe.com email,
-- so it's enforced even if someone bypasses the client-side check.
create or replace function public.enforce_adobe_domain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is null or new.email !~* '@adobe\.com$' then
    raise exception 'Only @adobe.com email addresses are allowed to sign up.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_adobe_domain on auth.users;
create trigger trg_enforce_adobe_domain
before insert on auth.users
for each row execute function public.enforce_adobe_domain();

-- Auto-creates a `profiles` row (role defaults to 'member') whenever a new
-- auth user is created. Runs as security definer so it works despite RLS.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'member')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_handle_new_user on auth.users;
create trigger trg_handle_new_user
after insert on auth.users
for each row execute function public.handle_new_user();
