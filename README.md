# POD Board — Weekly Capacity Tracker (production)

## Strict Admin/Member workspace isolation (latest upgrade)
This version splits the app into two fully separate workspaces, gated by role:

- **Admin Workspace** (`sashah@adobe.com`, or any `profiles.role = 'admin'`):
  everything from before (Week Board, Capacity Overview, Rollup, Team, Projects)
  plus a new **Live Tracking** tab — pick an ongoing project from a dropdown and
  see who's assigned, cumulative time logged per person, and recent entries.
- **Member Workspace** (everyone else): a completely separate view. Members
  never see the admin tabs, other members' data, or unassigned projects. They get:
  - **My projects** — only the projects an admin staffed them on.
  - **Live timer** — Start/Pause/Resume/Stop against a chosen project; Stop
    saves a `time_logs` row.
  - **Manual time entry** — date + hours/minutes + notes for past work.
  - **Personal summary** — their own this-week and all-time hours only.

**Run `supabase/schema_update.sql`** — it's a fresh, fully self-contained,
idempotent script that adds `time_logs`, tightens RLS on `members`/`assignments`/
`projects`/`project_assignments` to the strict model described in its header
comments, and re-seeds `sashah@adobe.com` as admin. Safe to run whether or not
earlier versions of this file were already applied.

**Team tab change**: adding a member now requires an `@adobe.com` email
up front (previously optional) — it's what lets that person's login link to
their member record and see their own workspace.

**Note on the timer**: it runs in-memory only; refreshing the page or closing
the tab while it's running discards unsaved time. Click "Stop & save" before
navigating away.

---

Vanilla JS + Vite frontend, Supabase for auth/data/realtime, deployed as a static
site on Render. Feature-for-feature port of the original HTML mock: week board,
capacity overview, monthly/quarterly rollup, team management, Excel import/export,
branding (logo/name/tagline).

## Access model
- Sign-in is restricted to **@adobe.com** emails (enforced client-side AND with a
  Postgres trigger on `auth.users`, so it can't be bypassed).
- Exactly **one admin**; everyone else is a **member**. Admins can manage team
  members, capacities, weekly default capacity, and branding (logo/name/tagline).
  Any signed-in member can log/edit/delete project hours on the shared board —
  matching the original mock's "shared link" behavior. Adjust the RLS policies
  in `supabase/003_rls_policies.sql` if you want tighter per-member restrictions.

---

## What's new in this update
- **Password login**: the auth screen now uses email + password (`signUp` /
  `signInWithPassword`) instead of magic links. Toggle between "Sign in" and
  "Create account" on the same screen.
- **Routing by role**: after login the URL hash is set to `#/admin` or
  `#/member` based on the signed-in user's role in `profiles`. A member
  can't force their way into `#/admin` by editing the hash.
- **Projects & staffing**: a new **Projects** tab (admin-only) lets admins
  create projects, set their status (ongoing/on hold/completed), and toggle
  which team members are staffed on each — stored in the new `projects` /
  `project_assignments` tables. A new **My Projects** tab shows each signed-in
  member only the projects they're staffed on, with a shortcut to log hours.
- **Ongoing-projects filter**: an admin-only dropdown in the toolbar filters
  the Week Board and Rollup pipeline/delivered lists down to a single
  ongoing project.
- Run `supabase/schema_update.sql` **after** the existing `001`–`005` scripts
  to add the new tables/columns/policies. It's idempotent — safe to re-run.
- A member's login is linked to their `members` row automatically the first
  time they sign in, provided an admin has already set that member's `email`
  column to match (edit it directly in the Supabase table editor, or extend
  the Team tab form — not included by default to keep the diff minimal).
- In **Authentication → Providers → Email**, decide whether "Confirm email"
  is on. If it's on, `signUp` won't return a session immediately — the user
  sees "check your email to confirm" and then signs in normally afterward.

## 1. Supabase setup

1. Create a project at https://supabase.com.
2. In **SQL Editor**, run these files **in order**:
   - `supabase/001_schema.sql`
   - `supabase/002_auth_domain_restriction.sql`
   - `supabase/003_rls_policies.sql`
   - `supabase/005_enable_realtime.sql`
3. In **Authentication → Providers → Email**:
   - Enable "Email" provider.
   - Turn **off** "Confirm email" (magic-link OTP handles verification) — or leave it on if you prefer a confirmation step; either works with `signInWithOtp`.
   - Disable any other providers you don't want (Google, GitHub, etc.).
4. In **Authentication → URL Configuration**:
   - Set **Site URL** to your Render URL (e.g. `https://pod-weekly-tracker.onrender.com`).
   - Add the same URL (and `http://localhost:5173` for local dev) to **Redirect URLs**.
5. Get your keys from **Project Settings → API**: `Project URL` and `anon public` key.
6. **Seed the admin**: have the one admin sign in through the app once (this
   auto-creates their `profiles` row via trigger), then run
   `supabase/004_seed_admin.sql` with their email filled in.

## 2. Local development

```bash
cp .env.example .env
# fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

Visit http://localhost:5173, sign in with an `@adobe.com` address, and check your
inbox for the magic link.

## 3. Push to GitHub

```bash
cd pod-weekly-tracker
git init
git add .
git commit -m "Production POD Board: Supabase auth + RLS, Vite build"
git branch -M main
git remote add origin https://github.com/<your-org>/pod-weekly-tracker.git
git push -u origin main
```

(`.env` is gitignored — never commit real Supabase keys. `.env.example` is the
template that ships in the repo.)

## 4. Deploy on Render

**Option A — render.yaml (Blueprint):**
1. Push this repo to GitHub (step 3).
2. In Render: **New → Blueprint**, point it at the repo. It reads `render.yaml`.
3. Render will prompt for the two secret env vars (`VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY`) since they're marked `sync: false` — paste them in.
4. Deploy. Render runs `npm ci && npm run build` and serves `dist/` as a static site.

**Option B — manual dashboard setup:**
1. **New → Static Site**, connect the GitHub repo.
2. Build command: `npm ci && npm run build`
3. Publish directory: `dist`
4. Add environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
5. Add a rewrite rule: source `/*` → destination `/index.html` (SPA fallback).
6. Deploy.

After the first deploy, copy the Render URL into Supabase's Site URL / Redirect
URLs (step 1.4) if you skipped it before — magic links won't redirect correctly
otherwise.

## File structure

```
pod-weekly-tracker/
├── index.html                 # login screen + app shell (markup only)
├── package.json
├── vite.config.js
├── render.yaml                 # Render static-site blueprint
├── .env.example
├── .gitignore
├── src/
│   ├── style-core.css          # original design system + auth screen styles
│   ├── main.js                 # ported app logic (board/overview/rollup/team/import/export)
│   └── lib/
│       ├── supabaseClient.js   # Supabase client singleton
│       ├── auth.js             # magic-link login, domain gate, role lookup
│       └── db.js               # all Supabase reads/writes + realtime subscription
└── supabase/
    ├── 001_schema.sql
    ├── 002_auth_domain_restriction.sql
    ├── 003_rls_policies.sql
    ├── 004_seed_admin.sql
    └── 005_enable_realtime.sql
```
