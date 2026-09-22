# Architecture and development guide

The repository contains two applications: a Discord bot in `src/` and a Next.js
dashboard in the `dashboard/` npm workspace. They communicate through the local
HTTP control API and share a Supabase schema. Neither application should import
the other application's runtime code.

## Bot responsibilities

| Directory | Responsibility |
| --- | --- |
| `src/app/` | Construct the client, discover modules, log in, manage process lifecycle. |
| `src/commands/` | Translate Discord slash commands into feature operations. |
| `src/events/` | Translate Discord gateway events into feature operations. |
| `src/control/` | HTTP authentication, routing, request parsing, and response formatting. |
| `src/control/handlers/` | Validate and execute dashboard requests for each feature. |
| `src/features/music/` | Music sessions, queues, effects, track resolution, player components. |
| `src/features/speech/` | Speech playback, translation, synthesis, and TTS providers. |
| `src/features/voice-log/` | Store and query voice-channel activity. |
| `src/audio/` | Audio primitives used by multiple features: PCM mixing and ducking. |
| `src/infrastructure/` | Supabase initialization, database error handling, runtime persistence. |

Dependency direction is from entry points/adapters to features, then to shared
audio and infrastructure. Features should not import the application bootstrap
or HTTP server. Keep provider-specific details inside the corresponding feature.
Music's Discord embeds and components stay beside its session logic because they
are specific to that feature; this is not a framework-independent domain layer.

`src/index.ts` loads `.env` before starting the application. Importing
`src/app/client.ts` constructs no live connection; `createClient()` wires commands
and events, and `startBot()` owns login, control-server startup, signal handlers,
and the existing process error safety net.

`src/app/modules.ts` is the single source for command discovery used by both
runtime startup and `src/deploy-commands.ts`. It loads top-level `.ts`/`.js`
modules and ignores declarations. Do not put helper files in `commands/` or
`events/`, and do not mix generated JavaScript into the source tree. TypeScript
outputs to `dist/`; existing launcher paths and npm commands remain valid.

## Dashboard responsibilities

- `dashboard/app/`: Next.js routes, UI components, loaders, and server actions.
- `dashboard/lib/`: dashboard services, authentication, control API client, and
  soundboard storage/recovery logic.
- `dashboard/lib/supabase/`: browser, SSR, middleware, and privileged clients.
- `dashboard/instrumentation.node.ts`: Node-only recovery worker startup.

Keep server-only services out of client component imports. The dashboard talks
to the bot through `dashboard/lib/control.ts`; its HTTP paths and payloads are
the integration boundary. Schema changes belong in `supabase/migrations/` and
must account for both applications.

## Adding a feature

1. Put reusable behavior under `src/features/<feature>/`. Put cross-feature audio
   primitives under `src/audio/` and external persistence plumbing under
   `src/infrastructure/`.
2. Add a top-level `src/commands/<command>.ts` exporting the `Command` interface
   from `src/types.ts`, or a `src/events/<event>.ts` exporting `BotEvent`.
3. For dashboard control, add the handler under `src/control/handlers/`, wire the
   route in `src/control/server.ts`, and update `dashboard/lib/control.ts`.
   Preserve secret authentication and the loopback-only binding.
4. Add regression coverage under `test/` for bot behavior or beside the affected
   dashboard module as `*.test.ts`/`*.test.tsx`.
5. Run `npm run check`. Run `npm run build:all` when changing imports or bundling.
   Re-register changed slash-command definitions with `npm run deploy` in the
   intended Discord environment.

For a new speech provider, implement `TtsProvider` in
`src/features/speech/providers/`, wire selection in that directory's `index.ts`
and `config.ts`, and document environment variables in `.env.example`.

## Local commands

Run `npm install` from the repository root to install both workspace dependency
sets, including the dashboard's development dependencies for Vitest.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Watch the bot source. |
| `npm run prod` | Compile and start the bot; preferred for audio playback. |
| `npm run dev:dashboard` | Start Next.js in development mode. |
| `npm run typecheck:all` | Type-check both applications. |
| `npm run test:all` | Run root tests followed by dashboard tests. |
| `npm run check` | Type-check both applications, then run both test suites. |
| `npm run build:all` | Compile the bot and build the dashboard. |

The combined commands stop on the first failure. To investigate each suite
independently, run `npm test` and `npm test --workspace dashboard` separately.
Tests use local mocks/fixtures; real Discord login, voice playback, and Supabase
integration still need the configured services for a manual smoke test.

## Path changes

| Previous path | Current path |
| --- | --- |
| `src/lib/music/` | `src/features/music/` |
| `src/lib/voiceAI/` | `src/features/speech/` |
| `src/lib/voice/` | `src/audio/` |
| `src/lib/voiceLogStore.ts` | `src/features/voice-log/store.ts` |
| `src/lib/database.ts`, `supabase.ts`, `botRuntime.ts` | `src/infrastructure/` |

The root and dashboard environment-file locations, `dist/index.js`, migration
paths, HTTP contracts, and Windows launcher scripts are unchanged. Files under
`docs/superpowers/` are historical design records and may show earlier paths.
