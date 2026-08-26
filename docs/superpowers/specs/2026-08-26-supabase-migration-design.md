# Supabase Database and Discord Auth Migration Design

## Goal

Replace the local Prisma/PostgreSQL integration in both the Discord bot and the
Next.js dashboard with Supabase, migrate the existing application data from the
provided PostgreSQL dump, and move dashboard authentication to Supabase Auth
with Discord OAuth.

## Scope

The migration preserves these application tables and their existing behavior:

- `GuildConfig`: per-guild voice-log channel configuration.
- `BotRuntime`: singleton bot lifecycle state.
- `VoiceEvent`: voice join/leave/move history.
- `MusicHistory`: successfully played track history.

`Poe2Watch` and `_prisma_migrations` are intentionally not migrated. The new
schema is owned by a committed Supabase SQL migration rather than Prisma.

## Architecture

The bot uses a server-only Supabase client created with the project URL and a
server secret key. It performs trusted writes for lifecycle state, guild
configuration, voice events, and music history. The dashboard uses a browser
client for OAuth initiation, a cookie-aware server client for authenticated
requests, and a server-only client for privileged bot lifecycle operations.

The dashboard's existing application authorization remains: verified Discord
identity IDs are matched against `ADMIN_USER_IDS` and `MEMBER_USER_IDS`, while
development bypass, public guest links, remote host role caps, and guild locks
continue to work. Supabase Auth owns the login session and refresh token; the
old signed custom session cookie and Discord OAuth routes are removed.

## Authentication flow

1. The login page calls `signInWithOAuth({ provider: 'discord' })` using the
   browser Supabase client and redirects to the dashboard callback route.
2. The callback route exchanges the PKCE authorization code for a session and
   redirects to the dashboard.
3. Middleware calls the Supabase session-refresh helper on every non-public
   request, then verifies the authenticated user and applies the existing role
   and guild access rules.
4. Role resolution reads the verified Discord identity's `provider_id`; it does
   not trust editable user metadata.
5. Logout calls `supabase.auth.signOut()` and redirects to `/login`.

Supabase configuration outside the repository is required: enable Discord in
Supabase Auth, enter the Discord application's client ID and secret, register
the Supabase provider callback URL in Discord, and add the app callback URL to
Supabase's redirect allow list.

## Database and security

The SQL migration recreates the four application tables, enums/checks, indexes,
and the singleton runtime row without Prisma metadata. RLS is enabled. The
authenticated dashboard role may read dashboard data; server-only bot/admin
clients use the secret key for trusted writes. The publishable key is exposed
only through `NEXT_PUBLIC_*` variables. No secret key or OAuth secret is
committed.

The one-time import command uses a PostgreSQL 17 client/container because the
provided custom-format dump was produced by PostgreSQL 17.6 and cannot be read
by the installed PostgreSQL 14 `pg_restore`. It restores only the four
application tables into Supabase and does not drop schemas or import Prisma
migration bookkeeping. The local dump remains untouched.

## Compatibility and error handling

- Supabase query helpers check every `{ data, error }` result and throw an
  actionable error with the operation name.
- Voice logging and music-history persistence retain their current failure
  isolation: database failures are logged and do not interrupt Discord audio or
  event handling.
- Missing Supabase URL, publishable key, or server secret produces a clear
  startup/configuration error.
- Existing control endpoint behavior and bot lifecycle semantics remain
  unchanged apart from their storage implementation.

## Verification

- Unit tests cover Supabase query-result error handling and auth role mapping.
- Root typecheck passes without any Prisma imports.
- Dashboard production build passes with the Supabase SSR middleware.
- Repository search confirms application code and package manifests no longer
  depend on Prisma.
- The dump-import command is shell-checked and documented; actual remote import
  requires the user's Supabase database connection string and is not run by the
  code migration.
