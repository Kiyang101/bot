# CLAUDE.md

Guidance for Claude Code (and other AI assistants) when working in this repository.

## What this is

A Discord bot (discord.js v14 + TypeScript, CommonJS) with three feature areas —
a YouTube **music player**, **text-to-speech** (multi-provider, incl. VOICEVOX
Japanese voices), and **voice-channel activity logging** to PostgreSQL — plus an
optional **Next.js web dashboard** that drives the bot over a local HTTP control
endpoint.

## Commands you'll run

```bash
npm run dev          # bot with auto-restart (tsx watch) — fine for logic work
npm run prod         # compile to dist/ + run; use for testing music playback
npm run typecheck    # tsc --noEmit — run this before considering a change done
npm run deploy       # re-register slash commands (after changing name/desc/options)
npm run db:migrate   # apply Prisma migrations (needs PostgreSQL up)
npm run db:generate  # regenerate the Prisma client after editing schema.prisma
```

Run PostgreSQL with `docker compose up -d` before anything that touches the DB.

## Architecture

- **Entry point:** `src/index.ts` creates the client, auto-loads every module in
  `src/commands/` and `src/events/`, then logs in and starts the control server.
- **Commands** (`src/commands/*.ts`): each file `export default`s a `Command`
  (`{ data: SlashCommandBuilder, execute(interaction) }`). Dropping in a new file
  registers it automatically — but you must run `npm run deploy` for Discord to
  see name/description/option changes.
- **Events** (`src/events/*.ts`): each `export default`s a `BotEvent`
  (`{ name, once?, execute }`). No deploy needed.
- **Shared types** live in `src/types.ts`.
- **Music** (`src/lib/music/`): `musicSession.ts` holds per-guild sessions;
  `ytdlp.ts` resolves tracks via `youtube-dl-exec`. Effects/queue/loop state is
  in `types.ts`; Discord UI (buttons/embeds) in `components.ts`/`ui.ts`.
- **Voice/TTS** (`src/lib/voiceAI/`): provider abstraction under `providers/`
  (openai, gemini, voicevox, googletts) selected via env. `tts.ts`/`session.ts`
  drive synthesis and playback; `translate.ts` does Google-Translate-to-Japanese.
- **Control endpoint** (`src/control/server.ts`): a `127.0.0.1`-only HTTP server
  guarded by `BOT_CONTROL_SECRET`. Exposes `/speak`, `/preview`, `/leave`,
  `/music`, and `/music/state` so the dashboard can drive the bot.
- **Database:** Prisma + PostgreSQL. `prisma/schema.prisma` is the single source
  of truth, **shared by both the bot and the dashboard**. Models: `GuildConfig`
  (per-server settings), `VoiceEvent` (join/leave/move history).
- **Dashboard** (`dashboard/`): a separate Next.js app and npm workspace. It
  reads the DB directly via its own Prisma client and calls the bot's control
  endpoint for live actions.

## Conventions

- TypeScript throughout; CommonJS (`require`-based auto-loader in `index.ts`), so
  keep `import`/`export default` consistent with existing files.
- Match the existing comment style: short "why" comments explaining non-obvious
  decisions, not narration of what the code does.
- Config is read from `.env` via `dotenv`. Document any new env var in
  `.env.example` with an inline comment, following the existing sectioned format.
- Prefer failing with a clear, actionable message (see the env-var guards in
  `index.ts` and `control/server.ts`) over silent failure.
- After editing `prisma/schema.prisma`, run `npm run db:generate` (and create a
  migration with `npm run db:migrate`).

## Gotchas

- **Music needs the compiled build** to play smoothly: run `npm run prod` /
  `npm run serve` with native `@discordjs/opus` and `sodium-native` installed.
  `tsx` dev mode stutters audio.
- **`dist/` is build output and git-ignored** — never edit files there; edit
  `src/` and recompile.
- **Don't commit secrets.** `.env` and `dashboard/.env.local` are git-ignored.
- The bot only requests `Guilds` and `GuildVoiceStates` intents. Reading message
  text would require enabling the Message Content intent and adding it in
  `index.ts`.
- `unhandledRejection`/`uncaughtException` are caught in `index.ts` on purpose so
  a stray killed yt-dlp/ffmpeg child can't take the whole bot offline — keep that
  safety net intact.
