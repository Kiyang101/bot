# Discord Bot

A feature-rich Discord bot built with [discord.js](https://discord.js.org/) v14 +
TypeScript. It ships with a YouTube music player, text-to-speech (including
Japanese anime voices via VOICEVOX), voice-channel activity logging backed by
Supabase, and an optional [Next.js](https://nextjs.org/) web dashboard for
controlling it from a browser.

Commands and events are auto-loaded from the `src/commands/` and `src/events/`
folders, so adding a feature is usually just dropping in a new file.

## Features

- **🎵 Music player** — stream audio from YouTube (URLs, playlists, or search
  terms) with a full queue, loop modes, shuffle, seek, volume, and audio
  effects. Spotify track, album, and playlist links are resolved to matching
  YouTube tracks; `/play liked` can import Spotify Liked Songs when configured.
  Audio is pulled with `yt-dlp` via the bundled `youtube-dl-exec`, so no
  separate install is needed.
- **🗣️ Text-to-speech** — `/say` makes the bot speak in your voice channel, and
  `/sayjp` speaks in a Japanese anime voice via [VOICEVOX](https://voicevox.hiroshiba.jp/).
  Pluggable TTS providers (OpenAI, Gemini, VOICEVOX, Google Translate TTS).
- **📋 Voice activity logging** — records who joins/leaves/moves between voice
  channels to Supabase and (optionally) posts it to a text channel. Browse the
  history in the dashboard.
- **🖥️ Web dashboard** — a Next.js app to view voice activity and drive the bot's
  speak/music features remotely via a local control endpoint.

## Commands

| Command | Description |
| --- | --- |
| `/ping` | Replies with Pong and the bot latency. |
| `/help` | Lists all available commands. |
| `/server` | Shows information about this server. |
| `/play` | Play YouTube audio, a Spotify link, or Spotify Liked Songs (`liked`). |
| `/pause` · `/resume` | Pause / resume the current track. |
| `/skip` · `/stop` | Skip the track / stop and leave the channel. |
| `/queue` · `/nowplaying` | Show the queue / the current track. |
| `/loop` · `/shuffle` | Set loop mode / shuffle the queue. |
| `/remove` · `/seek` | Remove a track by position / jump to a position. |
| `/volume` · `/effect` | Set volume (0–100) / apply an audio effect. |
| `/say` | Make the bot speak a message in your voice channel. |
| `/sayjp` | Speak your message in a Japanese anime voice (VOICEVOX). |
| `/voicelog` | Configure logging of who joins/leaves voice channels. |

## Project layout

```
discord-bot/
├── src/
│   ├── commands/          # One file per slash command (auto-loaded)
│   ├── events/            # One file per Discord event (auto-loaded)
│   ├── control/           # Local HTTP endpoint the dashboard talks to
│   ├── lib/
│   │   ├── music/         # YouTube music player (yt-dlp, queue, effects)
│   │   ├── voice/         # Voice-channel audio helpers (ducking)
│   │   ├── voiceAI/       # TTS/STT/LLM providers + sessions
│   │   └── supabase.ts     # Server-only Supabase client
│   ├── deploy-commands.ts # Registers slash commands with Discord
│   └── index.ts           # Bot entry point
├── dashboard/             # Next.js web dashboard (npm workspace)
├── supabase/              # SQL schema migrations
├── scripts/               # Supabase data import/check scripts
└── .env.example           # Template for your secrets
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create your bot on Discord

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. Open the **Bot** tab → **Reset Token** → copy the token.
3. Open the **General Information** tab → copy the **Application ID** (this is your `CLIENT_ID`).

### 3. Add your secrets

```bash
cp .env.example .env      # Windows PowerShell: copy .env.example .env
```

Open `.env` and fill in at least `DISCORD_TOKEN` and `CLIENT_ID`. For instant
command updates while developing, set `GUILD_ID` to your test server's ID
(enable **Developer Mode** in Discord → User Settings → Advanced, then
right-click your server → **Copy Server ID**). The other variables (AI providers,
VOICEVOX, music tuning, Spotify integration, dashboard control secret) are documented inline in
`.env.example` and are all optional.

Keep the populated `.env` file local. It is ignored by Git and must never be
committed; `.env.example` is the safe template to commit. The same rule applies
to `dashboard/.env.local`; `dashboard/.env.example` contains blank placeholders
and is safe to commit.

### 4. Configure Supabase

Create or open the Supabase project, then run the SQL files in
`supabase/migrations/` in filename order in the Supabase SQL Editor. This
creates the application tables, including `DashboardUser`. Add the following
values to `.env`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SECRET_KEY=sb_secret_...
```

Put the same public URL/key and server secret in `dashboard/.env.local`. The
secret key is server-only and must never be committed or exposed to the browser.

To preserve the supplied local data dump, use PostgreSQL 17 tooling and the
database connection string from Supabase:

```bash
SUPABASE_DB_URL='postgresql://...' \
  ./scripts/import-supabase-dump.sh \
  /Users/kiyang/Downloads/megu-postgres-20260826-222833.dump
```

The importer copies `GuildConfig`, `BotRuntime`, `VoiceEvent`, and
`MusicHistory`. It deliberately excludes `Poe2Watch` and Prisma metadata, does
not alter the dump, and never drops Supabase schemas.

For dashboard Discord login, enable **Discord** under Supabase Dashboard →
Authentication → Providers. Copy the Supabase provider callback URL shown there
into the Discord application's OAuth2 redirect list. Add
`http://localhost:3000/api/auth/callback` (and the production equivalent) to
Supabase Dashboard → Authentication → URL Configuration → Redirect URLs. The
dashboard creates a `DashboardUser` row after each successful Discord login.
New users are members by default; promote an account to `admin` by updating its
`role` in Supabase.

For example, after the user has logged in once:

```sql
update public."DashboardUser"
set role = 'admin'
where "discordId" = 'YOUR_DISCORD_USER_ID';
```

### 5. Invite the bot to your server

In the Developer Portal → **OAuth2** → **URL Generator**:

- Scopes: **`bot`** and **`applications.commands`**
- Bot Permissions: **Send Messages**, **Connect**, and **Speak** (for music/TTS)

Open the generated URL, pick your server, and authorize.

### 6. Register the slash commands

```bash
npm run deploy
```

Run this again whenever you add or change a command's name/description/options.

### 7. Start the bot

For development:

```bash
npm run dev      # auto-restarts on file changes
```

For production (recommended for smooth music playback):

```bash
npm run prod     # compiles to dist/ and runs node dist/index.js
```

You should see `✅ Logged in as ...` in the console. Try `/ping` in your server.

> **Note:** Music quality is much smoother when running the compiled build
> (`npm run prod` / `npm run serve`) with the native `@discordjs/opus` and
> `sodium-native` packages installed. The `tsx`-based dev mode can stutter.

## Web dashboard (optional)

The dashboard lives in `dashboard/` (a workspace package). It reads voice
activity from the database and can tell the running bot to speak or play music
via the local control endpoint.

```bash
cd dashboard
cp .env.example .env.local   # fill in the values (incl. a matching BOT_CONTROL_SECRET)
npm run dev                  # http://localhost:3000
```

Set `BOT_CONTROL_SECRET` to the **same** random string in both the root `.env`
and `dashboard/.env.local` so the dashboard can authenticate to the bot's
control endpoint. Every successful login receives member access by default;
update the corresponding `DashboardUser.role` to `admin` for full access.
`DEV_AUTH_BYPASS=admin` is available for local development only and should
remain blank in production. Supabase Auth handles the Discord OAuth exchange
and session cookies; configure its provider and redirect URLs as described in
the Supabase setup section above.

Local admins can use the **Start bot** and **Stop bot**
controls on the Voice Activity page; start uses `BOT_START_COMMAND` (default
`npm run start`) from `BOT_WORKDIR`, and stop requests a graceful shutdown.
The lifecycle state and last PID are stored in the Supabase `BotRuntime` row.

For a production dashboard host, set these in `dashboard/.env.local`:

```env
BOT_WORKDIR=..
BOT_START_COMMAND=npm run prod
```

## npm scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the bot with auto-restart (`tsx watch`). |
| `npm start` | Start the bot once with `tsx` (no compile). |
| `npm run prod` | Compile to `dist/` and run the compiled build. |
| `npm run serve` | Run the already-compiled build (`node dist/index.js`). |
| `npm run build` / `npm run typecheck` | Compile / type-check only. |
| `npm run deploy` | Register slash commands with Discord. |
| `npm test` | Run the database/auth unit tests. |

## Notes

- Keep your `.env` private. If your token ever leaks, reset it in the Bot tab.
- The control endpoint binds to `127.0.0.1` only and is guarded by
  `BOT_CONTROL_SECRET`. It is not meant to be exposed to the internet.

## License

MIT
