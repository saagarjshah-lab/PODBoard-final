-- Adds the tables to Supabase's realtime publication so the board updates
-- live for everyone when a teammate logs hours (see subscribeToBoard in db.js).
alter publication supabase_realtime add table public.assignments;
alter publication supabase_realtime add table public.members;
alter publication supabase_realtime add table public.app_settings;
