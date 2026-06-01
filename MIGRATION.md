# Migrating data off Supabase → ClickHouse‑managed Postgres (Auth stays on Supabase)

This guide moves your **application data** (the Postgres `public` schema) out of Supabase
into a **ClickHouse‑managed Postgres** instance using `pg_dump` / `pg_restore`, while
**Supabase Auth keeps running on Supabase**. It is written for existing Supabase users
who rely on Supabase Auth (email/password, OAuth, RLS).

It uses this repo's TODO app (`public.todos`) as a fully worked, tested example. Every
command below was run against a real Supabase project (Postgres 17.6) and a real
ClickHouse Cloud Postgres target (Postgres 18.4).

---

## TL;DR

```bash
PG=/path/to/postgresql-18/bin   # your Postgres 18 client tools (pg_dump, psql)

# 1. Dump SCHEMA of the public schema and SEE what won't restore on plain Postgres
"$PG/pg_dump" "$SUPABASE_DB_URL" --schema-only --schema=public -f schema.sql

# 2. Hand off the auth coupling: write a *decoupled* schema (no FK to auth.users,
#    no RLS, no anon/authenticated/service_role grants) — see §4.

# 3. Dump DATA only
"$PG/pg_dump" "$SUPABASE_DB_URL" --data-only --schema=public --no-owner --no-privileges -f data.sql

# 4. Restore into the target
"$PG/psql" "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -f decoupled_schema.sql
"$PG/psql" "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -f data.sql

# 5. Verify row counts match, then rewire the app (§8): data via a direct
#    Postgres driver, auth still via Supabase, RLS replaced by app-level checks.
```

> ⚠️ The single biggest thing to understand: **on a plain Postgres there is no
> PostgREST, no Row Level Security context, no `auth.uid()`, and no `anon` /
> `authenticated` / `service_role` roles.** Your data restores fine, but the
> *authorization* that Supabase did for you is gone and must move into your app.

---

## 0. The mental model (read this first)

### Before (Supabase)

```
Browser ──(supabase-js)──> PostgREST ──> Postgres (public.*)
                              │              ├─ RLS policies using auth.uid()
   Supabase Auth (JWT) ───────┘              └─ FK public.todos.user_id → auth.users.id
```

The browser talks to **PostgREST** with the user's JWT. Postgres reads `auth.uid()`
from that JWT and **RLS** filters rows to the current user automatically. The `auth`
schema (users, sessions) lives in the same database.

### After (this migration)

```
Browser ──> Your Next.js server ──(pg driver)──> ClickHouse-managed Postgres (public.*)
                │                                   └─ plain tables, NO RLS, NO auth schema
                └──(supabase-js)──> Supabase Auth (still issues & validates the JWT)
```

- **Data** lives on the new Postgres. There is **no PostgREST and no RLS** there.
- **Auth** still lives on Supabase. Your app still calls `supabase.auth.*` to log users
  in and to read the current user/session on the server.
- **Your server becomes the trust boundary.** It authenticates the user with Supabase
  (`supabase.auth.getUser()`), then runs SQL against the new Postgres **with an explicit
  `where user_id = <the authenticated user's id>`** on every query. The database no
  longer enforces per-user access — your code does.

### What Supabase gave you that a plain Postgres does not

| Supabase feature | On plain Postgres | What you do instead |
|---|---|---|
| PostgREST auto-API (`supabase.from('todos')`) | ❌ none | Connect with a Postgres driver (`pg`, `postgres`, Drizzle, Prisma) |
| RLS + `auth.uid()` | ❌ `auth.uid()` doesn't exist | Filter by `user_id` in every query (app-level authz) |
| Roles `anon`, `authenticated`, `service_role` | ❌ don't exist | One app DB user; authorize in code |
| `auth` schema / `auth.users` | ❌ stays on Supabase | Drop the FK; `user_id` is just a UUID that still matches Supabase user IDs |

---

## 1. Prerequisites

- **Postgres 18 client tools** (`pg_dump`, `psql`, `pg_restore`). Point `PG` at your install:
  ```bash
  PG=/path/to/postgresql-18/bin   # e.g. a Homebrew libpq 18 bin dir
  "$PG/pg_dump" --version    # pg_dump (PostgreSQL) 18.4
  ```
  Use a client **≥ the source server version**. Source here is PG 17.6, target is PG 18.4,
  so the 18.4 client dumps the 17.6 source and restores into the 18.4 target — correct direction.

- **Two connection strings.** Set these as environment variables in your shell (e.g. in a
  local, untracked file you `source`). **Never hardcode passwords or commit them.** To keep
  the password out of your shell history / process list, prefer a `~/.pgpass` file or export
  `PGPASSWORD` separately instead of inlining it in the URL.

  **Source (Supabase) — use the SESSION POOLER on port `5432`:**
  ```bash
  # Dashboard → Project → Connect → "Session pooler"  (NOT "Transaction pooler")
  export SUPABASE_DB_URL="postgresql://postgres.<PROJECT_REF>:<DB_PASSWORD>@aws-0-<REGION>.pooler.supabase.com:5432/postgres"
  ```
  - ✅ Port **5432** = session mode → works with `pg_dump`.
  - ❌ Port **6543** = transaction mode → **`pg_dump` will fail** (no session-level features).
  - The direct host `db.<PROJECT_REF>.supabase.co` is **IPv6-only** on Supabase; the pooler is
    the reliable IPv4 path. Copy your exact pooler host from the dashboard's **Connect** dialog.

  **Target (ClickHouse-managed Postgres):**
  ```bash
  export TARGET_DB_URL="postgresql://<USER>:<PASSWORD>@<TARGET_HOST>:5432/<DB>?sslmode=require"
  ```
  Managed Postgres requires TLS — keep `sslmode=require` in the URL (or `?sslmode=require`).

---

## 2. Decide what moves

Migrate **only your `public` schema** (your application tables). Do **not** dump Supabase's
internal schemas — they belong to the Supabase platform and have no meaning on a plain Postgres:

> `auth`, `storage`, `realtime`, `vault`, `graphql`, `graphql_public`,
> `supabase_functions`, `supabase_migrations`, `extensions`, `pgbouncer`, `net`.

List your own tables first:

```bash
"$PG/psql" "$SUPABASE_DB_URL" -c "\dt public.*"
```

For this app that's a single table: `public.todos`.

---

## 3. Dump the schema and see what won't restore

```bash
"$PG/pg_dump" "$SUPABASE_DB_URL" --schema-only --schema=public --no-comments -f schema.sql
```

Here is exactly what Supabase emits for `public.todos` (trimmed), with every line that
**breaks on a plain Postgres** flagged:

```sql
CREATE TABLE public.todos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    task text NOT NULL,
    inserted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT todos_task_check CHECK ((char_length(task) > 0))
);

ALTER TABLE public.todos OWNER TO postgres;                     -- ⚠️ role may not exist on target
ALTER TABLE ONLY public.todos ADD CONSTRAINT todos_pkey PRIMARY KEY (id);

-- ⚠️ FK into the auth schema — auth.users does NOT exist on the target
ALTER TABLE ONLY public.todos
    ADD CONSTRAINT todos_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- ⚠️ RLS policies call auth.uid() — that function does NOT exist on the target
CREATE POLICY "select own todos" ON public.todos FOR SELECT USING ((auth.uid() = user_id));
CREATE POLICY "insert own todos" ON public.todos FOR INSERT WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "delete own todos" ON public.todos FOR DELETE USING ((auth.uid() = user_id));
ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;

-- ⚠️ Grants to Supabase roles that do NOT exist on the target
GRANT ALL ON TABLE public.todos TO anon;
GRANT ALL ON TABLE public.todos TO authenticated;
GRANT ALL ON TABLE public.todos TO service_role;
-- (plus many ALTER DEFAULT PRIVILEGES ... TO anon/authenticated/service_role lines)
```

If you tried to restore this verbatim into a plain Postgres you'd get:

```
ERROR:  schema "auth" does not exist
ERROR:  function auth.uid() does not exist
ERROR:  role "anon" does not exist
ERROR:  role "authenticated" does not exist
ERROR:  role "service_role" does not exist
```

That's expected — those objects are Supabase-specific. Next we strip them.

---

## 4. Strip the auth coupling (the decoupled schema)

Because **auth stays on Supabase**, the target table should be a plain table. Remove:

- [x] `OWNER TO postgres` and all `GRANT ... TO anon/authenticated/service_role`
- [x] `ALTER DEFAULT PRIVILEGES ... TO anon/authenticated/service_role`
- [x] the `FOREIGN KEY (user_id) REFERENCES auth.users(id)` constraint
- [x] `ENABLE ROW LEVEL SECURITY` and all `CREATE POLICY ...`

Keep:

- [x] the columns, the primary key, and your real CHECK/UNIQUE constraints
- [x] `user_id uuid NOT NULL` — it still holds the **Supabase auth user ID**, it just isn't
      a foreign key anymore. Add an index since you'll filter by it constantly.

`decoupled_schema.sql` (validated against the target):

```sql
create table if not exists public.todos (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null,                                  -- Supabase auth user id (no FK)
    task text not null,
    constraint todos_task_check check (char_length(task) > 0),
    inserted_at timestamptz not null default now()
);
create index if not exists todos_user_id_idx on public.todos (user_id);
```

> `gen_random_uuid()` is built into Postgres core since v13, so it works on the PG 18
> target with no extension. If your tables use `uuid_generate_v4()` (uuid-ossp),
> `crypt()`/`digest()` (pgcrypto), PostGIS, etc., `CREATE EXTENSION` those on the target first.

> **Tip for many tables:** generating the decoupled schema by hand doesn't scale. Either
> (a) dump with `--no-owner --no-privileges` to drop ownership/grants, then delete the
> `auth`/RLS lines with an editor or a small script, or (b) keep a hand-maintained DDL
> per table (clearer, recommended for a stable schema like this one).

---

## 5. Dump the data

```bash
"$PG/pg_dump" "$SUPABASE_DB_URL" \
  --data-only --schema=public --no-owner --no-privileges \
  -f data.sql
# For a single table:  add  --table=public.todos
```

The dump is plain `COPY` data:

```sql
COPY public.todos (id, user_id, task, inserted_at) FROM stdin;
7d2f4bd1-…  1a1e3539-…  test 1  2026-06-01 14:28:12.42+00
3de858b6-…  1a1e3539-…  test 2  2026-06-01 14:28:17.17+00
1f2e75e1-…  1a1e3539-…  test 3  2026-06-01 14:28:56.02+00
\.
```

Notes:
- `pg_dump` connects as the `postgres` role (the table owner), which **bypasses RLS**, so
  you get *all* rows, not just one user's. Good — that's what you want for a full copy.
- Postgres 18's `pg_dump` wraps the file in `\restrict … / \unrestrict …` (a `psql`
  injection-safety guard). It's harmless and handled automatically when you restore with a
  Postgres 18 `psql`.
- The `user_id` values are the Supabase auth user UUIDs. They stay valid because auth still
  lives on Supabase — you're just not enforcing the FK anymore.

---

## 6. Restore into the target

```bash
"$PG/psql" "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -f decoupled_schema.sql
"$PG/psql" "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -f data.sql
```

Worked-example output (real run against the ClickHouse Cloud PG 18.4 target):

```
CREATE TABLE
CREATE INDEX
SET
SET
SET
SET
COPY 3
```

`-v ON_ERROR_STOP=1` makes `psql` exit non-zero on the first error instead of plowing
ahead — always use it for restores.

---

## 7. Verify

```bash
# source
"$PG/psql" "$SUPABASE_DB_URL" -tAc "select count(*) from public.todos;"
# target
"$PG/psql" "$TARGET_DB_URL"   -tAc "select count(*) from public.todos;"
```

Worked example: both return `3`, and the target rows are `test 1`, `test 2`, `test 3`. ✅
For bigger tables also spot-check a few rows and compare `min/max(inserted_at)`.

---

## 8. Rewire the app (data → new Postgres, auth → still Supabase)

The data move is done; now the app must read/write the new Postgres directly and **re-implement
the authorization RLS used to do.** Auth — login, sessions, the GitHub OAuth flow, the
middleware/`proxy.ts` session refresh, `lib/supabase/{client,server}.ts` — **does not change.**

### 8.1 Install a Postgres driver

```bash
npm install pg
npm install -D @types/pg
```

### 8.2 Add the connection string (server-only secret)

`.env.local` — note it is **not** prefixed `NEXT_PUBLIC_`, so it never reaches the browser:

```bash
DATABASE_URL=postgresql://<USER>:<PASSWORD>@<TARGET_HOST>:5432/<DB>?sslmode=require
```

### 8.3 `lib/db.ts` — a pooled client

```ts
import { Pool } from "pg";

// One pool per server process. DATABASE_URL points at the ClickHouse-managed Postgres.
declare global {
  // eslint-disable-next-line no-var
  var _pgPool: Pool | undefined;
}

export const db =
  global._pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // managed PG terminates TLS; relax verification or pass the CA
    max: 5,
  });

if (process.env.NODE_ENV !== "production") global._pgPool = db;
```

### 8.4 Auth is unchanged — keep reading the user from Supabase

```ts
const supabase = await createClient();                 // lib/supabase/server.ts — UNCHANGED
const { data: { user } } = await supabase.auth.getUser();
if (!user) redirect("/login");
```

Always use `getUser()` (it verifies the JWT with Supabase), **not** `getSession()`, for any
decision that gates data access.

### 8.5 Replace PostgREST + RLS with explicit, user-scoped SQL

**Listing — `app/page.tsx`**

```diff
- const { data: todos } = await supabase
-   .from("todos")
-   .select("id, task, inserted_at")
-   .order("inserted_at", { ascending: true });
+ const { rows: todos } = await db.query(
+   `select id, task, inserted_at
+      from public.todos
+     where user_id = $1                 -- ← this WHERE replaces the RLS SELECT policy
+     order by inserted_at asc`,
+   [user.id],
+ );
```

**Add / delete — `app/actions.ts`**

```diff
  export async function addTodo(formData: FormData) {
    const task = String(formData.get("task") ?? "").trim();
    if (!task) return;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) redirect("/login");
-   await supabase.from("todos").insert({ task, user_id: user.id });
+   await db.query(
+     `insert into public.todos (user_id, task) values ($1, $2)`,
+     [user.id, task],                   // ← app sets the owner; the INSERT policy is gone
+   );
    revalidatePath("/");
  }

  export async function deleteTodo(formData: FormData) {
    const id = String(formData.get("id"));
+   const supabase = await createClient();
+   const { data: { user } } = await supabase.auth.getUser();
+   if (!user) redirect("/login");
-   const supabase = await createClient();
-   await supabase.from("todos").delete().eq("id", id);
+   await db.query(
+     `delete from public.todos where id = $1 and user_id = $2`,
+     [id, user.id],                     // ← "and user_id = $2" replaces the DELETE policy
+   );
    revalidatePath("/");
  }
```

### 8.6 🔒 Security: RLS is gone — the WHERE clause IS your security boundary

With RLS removed, the database will happily return or delete **any** row. Every single query
that touches user data **must** include `where user_id = <authenticated user id>` (and inserts
must set `user_id` from the session, never from client input). Use **parameterized queries**
(`$1`, `$2`) exclusively — string-concatenated SQL is now a direct injection/IDOR risk that
RLS used to backstop. Consider a thin data-access layer so no route can forget the filter.

### 8.7 What changes vs. what stays

| Keep (auth, unchanged) | Replace (data) |
|---|---|
| `lib/supabase/client.ts`, `server.ts` | `supabase.from('todos')…` → `db.query(...)` |
| `proxy.ts` session refresh | RLS policies → `where user_id = $1` in code |
| `/login`, GitHub OAuth, `/auth/callback` | `NEXT_PUBLIC_SUPABASE_*` stays for auth; add `DATABASE_URL` for data |
| `supabase.auth.getUser()` | — |

---

## 9. Cutover & rollback

- **This is a one-time snapshot.** `pg_dump`/`pg_restore` copies the data at a point in time.
  To avoid losing writes, do the final dump during a short **maintenance window** (pause
  writes / put the app in read-only), or re-run a delta for append-only tables filtered by
  `inserted_at > <last cutover time>`.
- **Cutover** = deploy the rewired app (§8) pointing `DATABASE_URL` at the new Postgres.
- **Rollback is easy and safe:** the Supabase source is untouched by this process. To roll
  back, redeploy the previous app version (still using `supabase.from(...)`). You can drop the
  target table and re-run the migration as many times as you like.
- **Out of scope (for now):** migrating Supabase Auth itself, and continuous replication/CDC
  for zero-downtime. Auth intentionally stays on Supabase here.

---

## 10. Gotchas quick reference

| Symptom / risk | Cause | Fix |
|---|---|---|
| `pg_dump` hangs/errors on connect | Used the transaction pooler (`:6543`) | Use the **session pooler `:5432`** (or direct host over IPv6) |
| `connection refused` to `db.<ref>.supabase.co` | Direct host is IPv6-only | Use the pooler hostname (IPv4) |
| `server version mismatch` | `pg_dump` older than server | Use a client **≥** server version (PG 18 client here) |
| `role "anon"/"authenticated"/"service_role" does not exist` | Grants in the dump | Strip grants / dump with `--no-owner --no-privileges` |
| `schema "auth" does not exist` | FK to `auth.users` | Drop the FK (decoupled schema, §4) |
| `function auth.uid() does not exist` | RLS policies | Drop RLS + policies; enforce in app (§8) |
| `function gen_random_uuid() does not exist` | Missing extension (only < PG13) | Built-in on PG 18; otherwise `create extension pgcrypto` |
| Rows leak across users after migration | RLS no longer enforced | Add `where user_id = $1` to **every** query (§8.6) |
| TLS/`SSL required` on target | Managed PG mandates TLS | Keep `?sslmode=require` in `TARGET_DB_URL` |
| Sequences out of sync (serial/identity) | `--data-only` doesn't bump sequences | `select setval('seq', (select max(id) from t));` after load (N/A for uuid keys) |
| Huge tables slow | Single-stream COPY | Dump `-Fc` (custom) and restore with `pg_restore -j <N>` in parallel |

---

## Appendix — exact commands used in this worked example

```bash
PG=/path/to/postgresql-18/bin   # your Postgres 18 client tools (pg_dump, psql)
export SUPABASE_DB_URL="postgresql://postgres.<PROJECT_REF>:<DB_PASSWORD>@aws-0-<REGION>.pooler.supabase.com:5432/postgres"
export TARGET_DB_URL="postgresql://<USER>:<PASSWORD>@<TARGET_HOST>:5432/<DB>?sslmode=require"

# inspect + dump
"$PG/psql"    "$SUPABASE_DB_URL" -c "\dt public.*"
"$PG/pg_dump" "$SUPABASE_DB_URL" --schema-only --schema=public --no-comments -f schema.sql
"$PG/pg_dump" "$SUPABASE_DB_URL" --data-only --table=public.todos --no-owner --no-privileges -f data.sql

# restore (decoupled_schema.sql is the §4 DDL)
"$PG/psql" "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -f decoupled_schema.sql
"$PG/psql" "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -f data.sql

# verify
"$PG/psql" "$TARGET_DB_URL" -tAc "select count(*) from public.todos;"   # → 3
```

> This guide was validated against a Supabase source (Postgres 17.6) and a ClickHouse-managed
> Postgres target (Postgres 18.4): a `public.todos` table with 3 rows migrated and verified.
> Keep connection strings in environment variables or a secrets manager — never commit them.
