# Supabase Database and Discord Auth Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Prisma/local PostgreSQL access in the bot and dashboard with Supabase, migrate the four retained application tables from the supplied dump, and use Supabase Auth with Discord OAuth for dashboard sessions.

**Architecture:** The bot uses a server-only Supabase client with a secret key for trusted writes. The dashboard uses `@supabase/ssr` browser/server clients for OAuth and authenticated cookies, plus a server-only client for lifecycle mutations. Existing application-level roles and guest/guild access rules remain in `dashboard/lib/auth.ts`, but custom Discord OAuth and signed session cookies are removed.

**Tech Stack:** TypeScript, Node.js 18+, Next.js 15, React 19, `@supabase/supabase-js`, `@supabase/ssr`, Node’s built-in test runner, PostgreSQL 17 `pg_restore`/`psql` for the one-time import.

**Spec:** `docs/superpowers/specs/2026-08-26-supabase-migration-design.md`

## Global Constraints

- Preserve `GuildConfig`, `BotRuntime`, `VoiceEvent`, and `MusicHistory` behavior and existing camelCase TypeScript interfaces.
- Do not migrate `Poe2Watch` or `_prisma_migrations`.
- Never commit `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, a Supabase secret key, Discord OAuth secrets, or any populated environment file.
- Supabase query failures must be checked and reported with the operation name.
- Voice-event and music-history persistence must continue logging failures without interrupting bot behavior.
- Do not use destructive restore flags such as `--clean`, and never restore into Supabase’s `auth` schema.

---

### Task 1: Add Supabase schema, environment contract, and dump-import tooling

**Files:**
- Create: `supabase/migrations/20260826223000_initial_schema.sql`
- Create: `scripts/import-supabase-dump.sh`
- Modify: `.env.example`
- Modify: `dashboard/.env.example`
- Modify: `README.md`

**Interfaces:**
- Produces SQL tables named `GuildConfig`, `BotRuntime`, `VoiceEvent`, and `MusicHistory` with the existing quoted column names and enum values.
- Produces an executable shell command accepting a dump path and `SUPABASE_DB_URL`, using PostgreSQL 17 tooling and excluding `Poe2Watch` and `_prisma_migrations`.

- [ ] **Step 1: Write the failing schema/import checks**

Create `scripts/test-supabase-migration.sh` with shell assertions that the SQL contains all four retained tables, RLS, indexes, and no `Poe2Watch`; assert the import script rejects a missing dump or connection string.

```bash
#!/usr/bin/env bash
set -euo pipefail

schema="supabase/migrations/20260826223000_initial_schema.sql"
import="scripts/import-supabase-dump.sh"
for table in GuildConfig BotRuntime VoiceEvent MusicHistory; do
  grep -q "CREATE TABLE.*\\\"${table}\\\"" "$schema"
done
grep -q 'ENABLE ROW LEVEL SECURITY' "$schema"
grep -q 'VoiceEvent_guildId_createdAt_idx' "$schema"
grep -q 'MusicHistory_guildId_createdAt_idx' "$schema"
! grep -q 'Poe2Watch' "$schema"
! "$import" 2>/dev/null
```

- [ ] **Step 2: Run the checks to verify they fail**

Run: `bash scripts/test-supabase-migration.sh`

Expected: FAIL because the migration and import script do not exist yet.

- [ ] **Step 3: Write the migration and import script**

The SQL must create the two enums, four tables, primary keys, indexes, and RLS policies. Use `GRANT SELECT` for `authenticated` on dashboard-readable tables; trusted server clients with the secret key bypass RLS for bot writes. The import script must check `pg_restore --version`, require major version 17 or newer, verify both arguments, and execute:

```bash
pg_restore --exit-on-error --data-only --no-owner --no-privileges --schema=public \
  --dbname="$SUPABASE_DB_URL" \
  --table='BotRuntime' --table='GuildConfig' --table='MusicHistory' --table='VoiceEvent' \
  "$DUMP_PATH"
```

Document that this requires the SQL migration to be applied first and that the local dump is never modified.

- [ ] **Step 4: Run the checks to verify they pass**

Run: `bash scripts/test-supabase-migration.sh`

Expected: PASS with exit code 0.

- [ ] **Step 5: Commit**

```bash
git add supabase scripts .env.example dashboard/.env.example README.md
git commit -m "feat: add Supabase schema and data import tooling"
```

### Task 2: Replace the bot’s Prisma data layer with Supabase

**Files:**
- Create: `src/lib/supabase.ts`
- Create: `src/lib/database.ts`
- Modify: `src/lib/db.ts`
- Modify: `src/lib/botRuntime.ts`
- Modify: `src/lib/voiceLogStore.ts`
- Modify: `src/lib/music/musicSession.ts`
- Modify: `src/events/voiceStateUpdate.ts`
- Modify: `src/control/server.ts`
- Modify: `src/index.ts`
- Test: `test/database.test.ts`

**Interfaces:**
- `src/lib/supabase.ts` exports `supabaseAdmin` created from `SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SECRET_KEY`.
- `src/lib/database.ts` exports `assertSupabaseResult<T>(operation, result)` and `DatabaseError`.
- `src/lib/voiceLogStore.ts` continues exporting `getLogChannel`, `setLogChannel`, `clearLogChannel`, `recordVoiceEvent`, and `VoiceEventInput`.
- `src/lib/botRuntime.ts` continues exporting the five lifecycle functions with their current signatures.

- [ ] **Step 1: Write the failing database error-handling test**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSupabaseResult, DatabaseError } from '../src/lib/database';

test('assertSupabaseResult turns a Supabase error into an actionable DatabaseError', () => {
  assert.throws(
    () => assertSupabaseResult('read BotRuntime', { data: null, error: { message: 'connection refused' } }),
    (error: unknown) => error instanceof DatabaseError && error.message.includes('read BotRuntime: connection refused'),
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/database.test.ts`

Expected: FAIL because `src/lib/database.ts` does not exist.

- [ ] **Step 3: Implement the bot Supabase layer**

Create the server-only client with explicit environment validation. Replace Prisma operations with `.from(...).select/insert/update/upsert`, preserving null handling and ordering. Define `VoiceAction` and `BotStatus` as local string unions/enums instead of importing `@prisma/client`. Remove `$disconnect` calls because the Supabase client is HTTP-based. In `musicSession.ts`, preserve the immediate-repeat URL check using `select('url').eq('guildId', guildId).order('createdAt', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle()`.

- [ ] **Step 4: Run the focused test and bot typecheck**

Run: `node --import tsx --test test/database.test.ts && npm run typecheck`

Expected: PASS and no `@prisma/client` imports in `src/`.

- [ ] **Step 5: Commit**

```bash
git add src test/database.test.ts package.json package-lock.json
git commit -m "feat: move bot persistence to Supabase"
```

### Task 3: Add Supabase SSR clients and migrate dashboard authentication

**Files:**
- Create: `dashboard/lib/supabase/client.ts`
- Create: `dashboard/lib/supabase/server.ts`
- Create: `dashboard/lib/supabase/admin.ts`
- Create: `dashboard/app/api/auth/callback/route.ts`
- Modify: `dashboard/app/login/page.tsx`
- Modify: `dashboard/app/api/auth/logout/route.ts`
- Modify: `dashboard/middleware.ts`
- Modify: `dashboard/lib/auth.ts`
- Modify: `dashboard/lib/session.ts`
- Test: `test/auth.test.ts`

**Interfaces:**
- `createBrowserClient()` returns the browser Supabase client for Discord OAuth.
- `createServerClient()` accepts the Next.js cookie store and wires `getAll`/`setAll`.
- `createAdminClient()` is server-only and requires `SUPABASE_SECRET_KEY`.
- `resolveRoleForDiscordId(discordId)` preserves `admin`/`member`/`null` allowlist behavior.

- [ ] **Step 1: Write the failing role-resolution test**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoleForDiscordId } from '../dashboard/lib/auth';

test('admin allowlist takes precedence over member allowlist', () => {
  const oldAdmin = process.env.ADMIN_USER_IDS;
  const oldMember = process.env.MEMBER_USER_IDS;
  process.env.ADMIN_USER_IDS = 'discord-admin';
  process.env.MEMBER_USER_IDS = 'discord-admin,discord-member';
  try {
    assert.equal(resolveRoleForDiscordId('discord-admin'), 'admin');
    assert.equal(resolveRoleForDiscordId('discord-member'), 'member');
    assert.equal(resolveRoleForDiscordId('unknown'), null);
  } finally {
    process.env.ADMIN_USER_IDS = oldAdmin;
    process.env.MEMBER_USER_IDS = oldMember;
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/auth.test.ts`

Expected: FAIL because the new Supabase-backed role resolver does not exist.

- [ ] **Step 3: Implement SSR auth**

Use `signInWithOAuth({ provider: 'discord', options: { redirectTo: `${origin}/api/auth/callback` } })` in the login page. Exchange `code` with `exchangeCodeForSession` in the callback route. Middleware must call the cookie-aware Supabase refresh helper before checking `supabase.auth.getUser()`, preserve public auth routes and guest-link handling, and pass verified Discord identity `provider_id` into the existing role rules. Remove custom `jose` session signing and the old Discord token exchange while retaining non-auth access helpers.

- [ ] **Step 4: Run the focused test and dashboard build**

Run: `node --import tsx --test test/auth.test.ts && npm --prefix dashboard run build`

Expected: PASS; the build includes the Supabase callback and middleware without custom session-cookie routes.

- [ ] **Step 5: Commit**

```bash
git add dashboard test/auth.test.ts package.json package-lock.json
git commit -m "feat: use Supabase Auth with Discord OAuth"
```

### Task 4: Replace dashboard Prisma reads/writes and remove Prisma

**Files:**
- Modify: `dashboard/app/actions.ts`
- Modify: `dashboard/app/page.tsx`
- Modify: `dashboard/app/config/page.tsx`
- Modify: `dashboard/app/music/page.tsx`
- Modify: `dashboard/lib/runtime.ts`
- Modify: `dashboard/lib/botProcess.ts`
- Delete: `dashboard/lib/prisma.ts`
- Delete: `src/lib/db.ts`
- Modify: `package.json`
- Modify: `dashboard/package.json`
- Modify: `dashboard/next.config.mjs`
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Dashboard pages retain their current result shapes and rendering behavior.
- Runtime and bot-process helpers use `createAdminClient()` for lifecycle writes.
- All dashboard database errors are caught at the existing page/action boundaries and converted to current user-facing fallback messages.

- [ ] **Step 1: Write the failing Prisma-removal check**

```bash
#!/usr/bin/env bash
set -euo pipefail
! rg -n '@prisma/client|PrismaClient|prisma\\.' src dashboard package.json dashboard/package.json next.config.mjs dashboard/next.config.mjs
! rg -n 'DATABASE_URL|db:migrate|db:generate|db:studio' package.json dashboard/package.json src dashboard README.md CLAUDE.md
```

- [ ] **Step 2: Run the check to verify it fails**

Run the commands above from the repository root.

Expected: FAIL because Prisma imports and scripts still exist.

- [ ] **Step 3: Replace dashboard queries and dependencies**

Use the server client for authenticated dashboard reads and the admin client for trusted lifecycle/process updates. Implement the equivalent Supabase filters, ordering, limits, counts, and upsert behavior for voice events, guild config, music history, and bot runtime. Remove Prisma dependencies, Prisma Next configuration, Docker/local-Postgres setup instructions, and obsolete `DATABASE_URL` documentation. Keep the dump import documentation and add the required Supabase Auth provider configuration steps.

- [ ] **Step 4: Run typechecks, builds, and removal checks**

Run: `npm run typecheck && npm --prefix dashboard run build`.

Then run the removal checks from Step 1.

Expected: both commands pass and all removal searches produce no matches.

- [ ] **Step 5: Commit**

```bash
git add src dashboard package.json dashboard/package.json package-lock.json README.md CLAUDE.md
git commit -m "refactor: remove Prisma from bot and dashboard"
```

### Task 5: Full verification and migration handoff

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Test: `scripts/test-supabase-migration.sh`

- [ ] **Step 1: Add the test script command**

Add `"test": "node --import tsx --test test/**/*.test.ts"` to the root scripts and ensure the shell migration checks are executable.

- [ ] **Step 2: Run the full verification suite**

Run:

```bash
npm test
npm run typecheck
npm --prefix dashboard run build
bash scripts/test-supabase-migration.sh
rg -n '@prisma/client|PrismaClient|prisma\\.|DATABASE_URL' src dashboard package.json dashboard/package.json README.md CLAUDE.md
```

Expected: tests, typecheck, build, and shell checks exit 0; the final `rg` command exits 1 because it finds no forbidden references.

- [ ] **Step 3: Inspect the final diff and migration instructions**

Confirm no populated `.env`/`.env.local` file is staged, the dump path is only documented as an input, and the import command does not include `Poe2Watch` or Prisma metadata. Report that remote import still requires the user’s Supabase database connection string and server secret key.

- [ ] **Step 4: Commit**

```bash
git add .
git commit -m "chore: verify Supabase migration"
```
