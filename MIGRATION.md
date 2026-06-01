# Migrating data off Supabase to ClickHouse-managed Postgres (Auth stays on Supabase)

This guide moves your **application data** (the Postgres `public` schema) out of Supabase
into a **ClickHouse-managed Postgres** using `pg_dump` / `pg_restore`, while **Supabase Auth
keeps running on Supabase**.

Good news: most of this is the same for every app, and it is not much. The data move is a
handful of `pg_dump` / `pg_restore` commands, and the app change is usually just pointing at
the new database (plus, in some setups, adding a `where user_id = ...` to your queries). Find
your bucket below, do **Part 1** (shared), then do the short **Part 2** for your bucket.

Every command here was run against a real Supabase source (Postgres 17.6) and a real
ClickHouse-managed Postgres target (Postgres 18.4); the worked example migrates a
`public.todos` table with 3 rows and verifies it.

---

## Find your bucket (start here)

Answer two questions about how your app works **today**.

**1. How does your app read & write data?**
- **PostgREST**: through `supabase-js` (`supabase.from('todos')...`, `supabase.rpc(...)`) or
  HTTP calls to `https://<project-ref>.supabase.co/rest/v1/...`. (This is the Supabase default.)
- **Direct Postgres**: your code already opens a Postgres connection itself, e.g. a connection
  string with a driver (`pg`, `postgres`), an ORM (Prisma, Drizzle), or a backend pool.

**2. How is per-user data access enforced?**
- **RLS**: Row Level Security policies on your tables (typically `using (auth.uid() = user_id)`),
  so the database filters rows per user.
- **No RLS**: you authorize in application code (or via Edge Functions / a service role), and
  the database itself does not enforce per-user access.

|                     | **RLS**                      | **No RLS**                   |
| ------------------- | ---------------------------- | ---------------------------- |
| **PostgREST**       | [Bucket A](#bucket-a)        | [Bucket B](#bucket-b)        |
| **Direct Postgres** | [Bucket C](#bucket-c)        | [Bucket D](#bucket-d)        |

- **[Bucket A](#bucket-a)** (PostgREST + RLS, this repo's example): point your data calls at
  the new database with a Postgres driver, and add a `where user_id = ...` to each query.
- **[Bucket B](#bucket-b)** (PostgREST + No RLS): point your data calls at the new database with
  a Postgres driver. Your authorization already lives in app code.
- **[Bucket C](#bucket-c)** (Direct + RLS): keep your driver, swap the connection string, and add
  a `where user_id = ...` to each query.
- **[Bucket D](#bucket-d)** (Direct + No RLS): change the connection string and you are done.

> **How this maps to a standard Postgres:** the target is plain, portable Postgres, so the
> Supabase conveniences (the PostgREST API, the RLS *context* `auth.uid()`, the
> `anon` / `authenticated` / `service_role` roles, the `auth` schema) live in your app instead.
> Your **data** restores as-is, and the per-user **authorization** Supabase ran for you becomes a
> little app code, often just a `where` clause you already have or one short line per query.

Then do **[Part 1: Data migration](#part-1)** (all buckets), then jump to your bucket in
**[Part 2: App rewiring](#part-2)**.

---

## 0. Mental model

### Before (Supabase)

```
                          ┌─ (PostgREST users) ─ supabase-js ─► PostgREST ─┐
Browser / your server ────┤                                                ├─► Supabase Postgres (public.*)
                          └─ (Direct users) ──── pg / ORM ─────────────────┘     ├─ RLS policies via auth.uid()
                                                                                  └─ FK user_id → auth.users.id
   Supabase Auth issues the JWT ──────────────────────────────────────────────────────────────────────────┘
```

### After (this migration)

```
Browser ─► your server ─── pg driver ──► ClickHouse-managed Postgres (public.*)   [standard Postgres tables, owned by your app]
                │
                └── supabase-js ─► Supabase Auth   [still issues & validates the user's JWT]
```

- **Data** lives on the new Postgres. **Auth** stays on Supabase.
- **Your server is the trust boundary:** it authenticates the user with Supabase
  (`supabase.auth.getUser()`), then runs SQL with the connection credential and authorizes in
  code. The database no longer needs to know about users.

---

<a id="part-1"></a>

# Part 1: Data migration (all buckets)

## 1.1 Prerequisites

- **Postgres 18 client tools** (`pg_dump`, `psql`, `pg_restore`). Point `PG` at your install:
  ```bash
  PG=/path/to/postgresql-18/bin   # e.g. a Homebrew libpq 18 bin dir
  "$PG/pg_dump" --version    # pg_dump (PostgreSQL) 18.4
  ```
  Use a client at or above the source server version (source PG 17.6, target PG 18.4 here, so
  the 18.4 client dumps 17.6 and restores into 18.4, the correct direction).

- **Two connection strings.** Set them as environment variables in your shell (e.g. a local,
  untracked file you `source`). **Never hardcode passwords or commit them.** To keep the
  password out of shell history / process lists, prefer a `~/.pgpass` file or a separately
  exported `PGPASSWORD` rather than inlining it in the URL.

  **Source (Supabase), via the SESSION POOLER on port `5432`:**
  ```bash
  # Dashboard, Project, Connect, "Session pooler"  (NOT "Transaction pooler")
  export SUPABASE_DB_URL="postgresql://postgres.<PROJECT_REF>:<DB_PASSWORD>@aws-0-<REGION>.pooler.supabase.com:5432/postgres"
  ```
  - ✅ Port **5432** = session mode, works with `pg_dump`.
  - ❌ Port **6543** = transaction mode, **`pg_dump` will fail** (no session features).
  - The direct host `db.<PROJECT_REF>.supabase.co` is **IPv6-only**; the pooler is the reliable
    IPv4 path. Copy your exact pooler host from the **Connect** dialog.

  **Target (ClickHouse-managed Postgres):**
  ```bash
  export TARGET_DB_URL="postgresql://<USER>:<PASSWORD>@<TARGET_HOST>:5432/<DB>?sslmode=require"
  ```
  Managed Postgres requires TLS, so keep `?sslmode=require`.

## 1.2 Decide what moves

Migrate **only your `public` schema** (your app tables). Do **not** dump Supabase's internal
schemas, which belong to the platform and mean nothing on a plain Postgres:

> `auth`, `storage`, `realtime`, `vault`, `graphql`, `graphql_public`,
> `supabase_functions`, `supabase_migrations`, `extensions`, `pgbouncer`, `net`.

```bash
"$PG/psql" "$SUPABASE_DB_URL" -c "\dt public.*"     # list your tables
```

For this app that's one table: `public.todos`.

## 1.3 Dump the schema and see what won't restore

```bash
"$PG/pg_dump" "$SUPABASE_DB_URL" --schema-only --schema=public --no-comments -f schema.sql
```

What Supabase emits for `public.todos` (trimmed), with the lines that **break on a plain
Postgres** flagged:

```sql
CREATE TABLE public.todos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    task text NOT NULL,
    inserted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT todos_task_check CHECK ((char_length(task) > 0))
);

ALTER TABLE public.todos OWNER TO postgres;                     -- (!) role may not exist on target

-- (!) FK into the auth schema (auth.users does NOT exist on the target)
ALTER TABLE ONLY public.todos
    ADD CONSTRAINT todos_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- (!) RLS policies call auth.uid(), which does NOT exist on the target  (RLS buckets only)
CREATE POLICY "select own todos" ON public.todos FOR SELECT USING ((auth.uid() = user_id));
CREATE POLICY "insert own todos" ON public.todos FOR INSERT WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "delete own todos" ON public.todos FOR DELETE USING ((auth.uid() = user_id));
ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;

-- (!) Grants to Supabase roles that do NOT exist on the target
GRANT ALL ON TABLE public.todos TO anon;
GRANT ALL ON TABLE public.todos TO authenticated;
GRANT ALL ON TABLE public.todos TO service_role;
-- (plus ALTER DEFAULT PRIVILEGES ... TO anon/authenticated/service_role)
```

Restoring this verbatim fails with `schema "auth" does not exist`,
`function auth.uid() does not exist`, `role "anon"/"authenticated"/"service_role" does not exist`.

## 1.4 Strip the Supabase coupling (the decoupled schema)

Remove the platform-specific bits. **All buckets** remove:

- [x] `OWNER TO postgres` and every `GRANT ... TO anon/authenticated/service_role`
- [x] `ALTER DEFAULT PRIVILEGES ... TO anon/authenticated/service_role`
- [x] any `FOREIGN KEY (user_id) REFERENCES auth.users(id)` (auth lives on Supabase now)

**RLS buckets (A & C) also remove** (No-RLS buckets won't have these in the dump):

- [x] `ENABLE ROW LEVEL SECURITY` and every `CREATE POLICY ...`

Keep your columns, primary key, real CHECK/UNIQUE constraints, and `user_id uuid`. It still
holds the Supabase auth user ID, just no longer as a foreign key. Add an index since you'll
filter on it constantly.

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

> `gen_random_uuid()` is built into Postgres core since v13, so no extension is needed on PG 18.
> If you use `uuid_generate_v4()` (uuid-ossp), `pgcrypto`, PostGIS, etc., `CREATE EXTENSION`
> those on the target first.
>
> **Many tables?** Either dump with `--no-owner --no-privileges` (drops ownership/grants), then
> delete the `auth`/RLS lines with a script, or keep a hand-maintained DDL per table.

## 1.5 Dump the data

```bash
"$PG/pg_dump" "$SUPABASE_DB_URL" \
  --data-only --schema=public --no-owner --no-privileges -f data.sql
# single table:  add  --table=public.todos
```

```sql
COPY public.todos (id, user_id, task, inserted_at) FROM stdin;
7d2f4bd1-...  1a1e3539-...  test 1  2026-06-01 14:28:12.42+00
3de858b6-...  1a1e3539-...  test 2  2026-06-01 14:28:17.17+00
1f2e75e1-...  1a1e3539-...  test 3  2026-06-01 14:28:56.02+00
\.
```

- `pg_dump` connects as the table owner, which **bypasses RLS**, so you get all rows. Good.
- PG 18's `pg_dump` wraps the file in `\restrict ... / \unrestrict ...` (a `psql` safety guard);
  it is harmless and handled automatically by a PG 18 `psql`.
- `user_id` values are the Supabase auth user UUIDs; they stay valid because auth stays on Supabase.

## 1.6 Restore into the target & verify

```bash
"$PG/psql" "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -f decoupled_schema.sql
"$PG/psql" "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -f data.sql
```

Real worked-example output:

```
CREATE TABLE
CREATE INDEX
SET
SET
SET
SET
COPY 3
```

Verify counts match (worked example: both return `3`):

```bash
"$PG/psql" "$SUPABASE_DB_URL" -tAc "select count(*) from public.todos;"
"$PG/psql" "$TARGET_DB_URL"   -tAc "select count(*) from public.todos;"
```

Data is migrated. Now rewire the app: jump to your bucket.

---

<a id="part-2"></a>

# Part 2: App rewiring (pick your bucket)

In every bucket, **auth stays on Supabase**: keep using `supabase-js` for login/sessions and
read the user server-side with `supabase.auth.getUser()`. (It verifies the JWT, so don't use
`getSession()` for authorization.) What changes is the **data path**.

The two building blocks the buckets reuse:

**Install a Postgres driver** (skip if you already have one, i.e. Buckets C/D):
```bash
npm install pg
npm install -D @types/pg
```

**`lib/db.ts`, a pooled client:**
```ts
import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var _pgPool: Pool | undefined;
}

export const db =
  global._pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL, // the new Postgres (server-only secret)
    ssl: { rejectUnauthorized: false },          // managed PG terminates TLS
    max: 5,
  });

if (process.env.NODE_ENV !== "production") global._pgPool = db;
```

`.env.local` (never committed; not `NEXT_PUBLIC_`, so it never reaches the browser):
```bash
DATABASE_URL=postgresql://<USER>:<PASSWORD>@<TARGET_HOST>:5432/<DB>?sslmode=require
```

---

<a id="bucket-a"></a>

## Bucket A: PostgREST + RLS  *(this repo's example)*

You call `supabase.from(...)` and rely on RLS for per-user access. Two small changes: point
your data calls at the new database with the driver, and turn each RLS policy into an explicit
query filter. The auth code does not change.

**Listing (`app/page.tsx`)**
```diff
- const { data: todos } = await supabase
-   .from("todos")
-   .select("id, task, inserted_at")
-   .order("inserted_at", { ascending: true });
+ const { rows: todos } = await db.query(
+   `select id, task, inserted_at
+      from public.todos
+     where user_id = $1                 -- replaces the RLS SELECT policy
+     order by inserted_at asc`,
+   [user.id],
+ );
```

**Add / delete (`app/actions.ts`)**
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
+     [user.id, task],                   // app sets the owner; the INSERT policy is gone
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
+     `delete from public.todos where id = $1 and user_id = $2`,  // "and user_id" = the DELETE policy
+     [id, user.id],
+   );
    revalidatePath("/");
  }
```

> 🔒 **RLS is gone, so the `where user_id = ...` clause IS your security boundary.** Every query
> touching user data must filter by the authenticated user's id, and inserts must set `user_id`
> from the session (never from client input). Use **parameterized queries** only. Consider a
> thin data-access layer so no route can forget the filter.

What stays unchanged: `lib/supabase/{client,server}.ts`, `proxy.ts`, `/login`, the GitHub OAuth
flow, `/auth/callback`. Keep `NEXT_PUBLIC_SUPABASE_*` for auth; add `DATABASE_URL` for data.

---

<a id="bucket-b"></a>

## Bucket B: PostgREST + No RLS

You call `supabase.from(...)`/`rpc(...)` but authorize in **app code** already (e.g. you call
PostgREST server-side with the `service_role` key and filter in your handlers, or front
everything with Edge Functions). One change: stop using PostgREST, start using the driver.

1. Install `pg`, add `DATABASE_URL`, create `lib/db.ts` (above).
2. Replace each `supabase.from('t').select/insert/update/delete(...)` and `supabase.rpc(...)`
   call with the equivalent SQL via `db.query(...)`. Mechanically the same diffs as Bucket A.
3. **Keep your existing authorization checks as they are.** You already had them; RLS wasn't
   doing the work. Just make sure each migrated query still carries whatever filter your code
   relied on.
4. Auth: keep Supabase `getUser()` server-side if you used Supabase Auth.

> ⚠️ **Reality check:** "PostgREST + no RLS" on Supabase often means tables were reachable with
> the anon/publishable key with no DB-side protection. If your only safeguard was that nobody
> knew the URL (or you didn't actually filter server-side), your data was effectively public.
> Treat yourself as **Bucket A** and add explicit `where user_id = ...` filtering now.

---

<a id="bucket-c"></a>

## Bucket C: Direct Postgres + RLS

You already open a Postgres connection (driver/ORM), but you rely on RLS, typically by
connecting as the `authenticated` role and setting the request's JWT claims per query so
`auth.uid()` resolves. On the new Postgres those roles and `auth.uid()` don't exist.

1. **Swap the connection** to the new Postgres (`DATABASE_URL` / your ORM datasource). Add
   `sslmode=require`.
2. **Delete the per-request RLS setup.** Anything like the following must go, since it has
   nothing to bind to anymore:
   ```sql
   -- REMOVE: this only worked because Supabase injected an auth context
   set local role authenticated;
   set local request.jwt.claims = '{"sub":"<user-id>", ...}';
   ```
3. **Move the policy logic into your queries.** The policies you dropped in Part 1 become
   explicit predicates:
   ```diff
   - -- previously enforced by RLS:  using (auth.uid() = user_id)
   - select id, task from public.todos;                 -- RLS filtered it for you
   + select id, task from public.todos where user_id = $1;   -- you filter now
   ```
4. Auth: get the user from Supabase server-side (`getUser()`), or if you verify tokens yourself,
   validate the Supabase JWT against the project's JWKS, then pass that `sub` / user id into the
   `where` clause.

> 🔒 Same boundary as Bucket A: with RLS removed, **your WHERE clauses are the enforcement.**
> Your connection/driver layer barely changes; your authorization moves up into the queries.

---

<a id="bucket-d"></a>

## Bucket D: Direct Postgres + No RLS

You already connect directly **and** authorize in app code. There is almost nothing to rewire.

1. Run **Part 1** (dump and restore). With no RLS there are no policies to strip, just drop
   ownership, the `anon/authenticated/service_role` grants, and any `auth.users` FK.
2. **Point your connection string at the new Postgres** (`DATABASE_URL`, `sslmode=require`).
3. That's it: your queries and authorization are unchanged.

Sanity-check before cutover: confirm no query secretly depends on Supabase-only SQL
(`auth.uid()`, `auth.*`/`storage.*` tables, or extensions you haven't created on the target).

---

# Cutover & rollback (all buckets)

- **One-time snapshot.** `pg_dump`/`pg_restore` copies a point in time. To avoid losing writes,
  run the final dump during a short **maintenance window** (pause writes / read-only), or re-run
  a delta for append-only tables filtered by `inserted_at > <last cutover time>`.
- **Cutover** = deploy the rewired app pointing `DATABASE_URL` at the new Postgres.
- **Rollback is safe:** the Supabase source is untouched. Redeploy the previous version (still
  using Supabase for data) to revert; you can drop the target table and re-run anytime.
- **Out of scope (for now):** migrating Supabase Auth itself, and continuous replication/CDC for
  zero-downtime. Auth intentionally stays on Supabase here.

---

# Gotchas quick reference

| Symptom / risk | Cause | Fix |
|---|---|---|
| `pg_dump` hangs/errors on connect | Used the transaction pooler (`:6543`) | Use the **session pooler `:5432`** (or direct host over IPv6) |
| `connection refused` to `db.<ref>.supabase.co` | Direct host is IPv6-only | Use the pooler hostname (IPv4) |
| `server version mismatch` | `pg_dump` older than server | Use a client at or above the server version (PG 18 client here) |
| `role "anon"/"authenticated"/"service_role" does not exist` | Grants in the dump | Strip grants / dump with `--no-owner --no-privileges` |
| `schema "auth" does not exist` | FK to `auth.users` | Drop the FK (1.4) |
| `function auth.uid() does not exist` | RLS policies (Buckets A/C) | Drop RLS + policies; enforce in app (Part 2) |
| `function gen_random_uuid() does not exist` | Missing extension (only < PG13) | Built-in on PG 18; else `create extension pgcrypto` |
| Rows leak across users after migration | RLS no longer enforced (Buckets A/C) | Add `where user_id = $1` to **every** query |
| TLS/`SSL required` on target | Managed PG mandates TLS | Keep `?sslmode=require` in the URL |
| Sequences out of sync (serial/identity) | `--data-only` doesn't bump sequences | `select setval('seq', (select max(id) from t));` after load (N/A for uuid keys) |
| Huge tables slow | Single-stream COPY | Dump `-Fc` (custom) and restore with `pg_restore -j <N>` in parallel |

---

## Appendix: exact commands used in this worked example

```bash
PG=/path/to/postgresql-18/bin   # your Postgres 18 client tools (pg_dump, psql)
export SUPABASE_DB_URL="postgresql://postgres.<PROJECT_REF>:<DB_PASSWORD>@aws-0-<REGION>.pooler.supabase.com:5432/postgres"
export TARGET_DB_URL="postgresql://<USER>:<PASSWORD>@<TARGET_HOST>:5432/<DB>?sslmode=require"

# inspect + dump
"$PG/psql"    "$SUPABASE_DB_URL" -c "\dt public.*"
"$PG/pg_dump" "$SUPABASE_DB_URL" --schema-only --schema=public --no-comments -f schema.sql
"$PG/pg_dump" "$SUPABASE_DB_URL" --data-only --table=public.todos --no-owner --no-privileges -f data.sql

# restore (decoupled_schema.sql is the 1.4 DDL)
"$PG/psql" "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -f decoupled_schema.sql
"$PG/psql" "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -f data.sql

# verify
"$PG/psql" "$TARGET_DB_URL" -tAc "select count(*) from public.todos;"   # -> 3
```

> Validated against a Supabase source (Postgres 17.6) and a ClickHouse-managed Postgres target
> (Postgres 18.4): `public.todos`, 3 rows, migrated and verified. Keep connection strings in
> environment variables or a secrets manager. Never commit them.
