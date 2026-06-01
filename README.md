# supa-auth-migrate

A minimal **Next.js + Supabase** TODO app, used to demonstrate migrating application
**data** off Supabase to a **ClickHouse‑managed Postgres** while keeping **Supabase Auth**.

Users sign in (email/password or GitHub OAuth) and can add / list / delete their own todos.

## Stack

- **Next.js 16** (App Router, React 19, TypeScript)
- **Supabase Auth** via `@supabase/ssr` (cookie-based sessions, middleware refresh)
- **Supabase Postgres** for data (`public.todos`) with Row Level Security
- **shadcn/ui** + Tailwind CSS v4 + lucide-react

## Getting started

```bash
npm install
cp .env.example .env.local   # then fill in your Supabase project values
npm run dev                  # http://localhost:3000
```

### Environment

`.env.local` (never committed):

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxxxxxxxxxxxxxxxxxxxxx
```

Get these from the Supabase dashboard (**Project → Connect**, or **Settings → API Keys**).
The publishable key is safe to expose in the browser; RLS protects your data.

### Database

The app expects a `public.todos` table with RLS. Equivalent SQL:

```sql
create table public.todos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task text not null check (char_length(task) > 0),
  inserted_at timestamptz not null default now()
);
alter table public.todos enable row level security;
create policy "select own todos" on public.todos for select using (auth.uid() = user_id);
create policy "insert own todos" on public.todos for insert with check (auth.uid() = user_id);
create policy "delete own todos" on public.todos for delete using (auth.uid() = user_id);
```

For **GitHub OAuth**, create a GitHub OAuth App with callback
`https://<project-ref>.supabase.co/auth/v1/callback`, then enable the GitHub provider in
the Supabase dashboard with its client id/secret.

## Migrating off Supabase

See **[MIGRATION.md](./MIGRATION.md)** — a tested, step-by-step guide for moving the
`public` data to a ClickHouse‑managed Postgres via `pg_dump`/`pg_restore` while Supabase Auth
stays put (stripping the `auth` coupling and moving authorization into the app layer).

## License

[Apache License 2.0](./LICENSE) © 2026 Kaushik Iska
