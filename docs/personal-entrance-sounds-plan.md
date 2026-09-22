# Personal entrance sounds — implementation handoff

Status: Phase 1 implemented; Phase 2 implemented in the 2026-09-22 follow-up.
Date: 2026-09-21.

## Objective and delivery scope

Let each member opt into a personal entrance clip for each Discord server. When
they join the voice channel the bot already occupies, play their chosen clip once.
Configure it from the dashboard using the existing Soundboard library.

Implement Phase 1 below as the complete first release. TTS is a separate Phase 2,
not a requirement for completing Phase 1. These are proposed product defaults,
chosen so implementation can proceed without further design questions.

## Read before editing

- Read `CLAUDE.md`, `docs/architecture.md`, and any applicable `AGENTS.md`.
- Inspect `git status`: the workspace already has substantial uncommitted changes,
  including a move from `src/lib/` to `src/features/`, `src/audio/`, and
  `src/infrastructure/`. Preserve them. Use current paths, not historical plans.
- Bot and dashboard are separate applications: do not import dashboard runtime
  modules into the bot or vice versa.
- Do not apply migrations to a live database, deploy commands, or restart a live
  bot as part of coding unless the execution task authorizes that environment.

## Phase 1 product contract

| Decision | Required behavior |
| --- | --- |
| Opt-in | Missing preference means disabled; selecting a clip alone does not enable it. |
| Identity | One preference per `(guildId, Discord userId)`, independent across guilds. |
| Trigger | Human joins from no channel, or moves from another channel into the bot's current channel. |
| Ignore | Leaves, mute/deafen/stream changes, bot accounts, missing member data, Stage channels. |
| Connection | Bot must already have a ready connection in the destination voice channel. Never auto-join, reconnect, or move for an entrance. |
| Length | Accept clips with known duration from 0.1 to 5 seconds. Enforce a real playback cap of 5 seconds as well. |
| User cooldown | 60 seconds per `(guildId, userId)`. |
| Guild cooldown | 5 seconds per guild, shared by all entrances. |
| Bursts | First eligible request wins; skip busy requests. No delayed queue or replay. |
| Staleness | Skip requests more than 3 seconds old before playback begins. |
| Other audio | Skip if a manual Soundboard clip or TTS is playing/preparing. Entrances must not take over their player. |
| Music | Preserve current Soundboard behavior: pause playing music briefly, then resume; preserve queue, seek position, loop, and a user's paused state. |
| Preview | Browser-only preview; do not make the bot join or play in Discord. |
| Errors | Missing/deleted/being-mutated sound, DB/storage failure, lost connection: skip safely, release resources, no channel error spam. |

Cooldowns may be in memory and reset on process restart for the current single-bot
deployment. Document that limitation; do not introduce Redis or distributed locks.
Reserve the entrance attempt atomically before any asynchronous lookup so repeated
gateway events cannot race. An admitted attempt consumes its cooldown even when
later lookup/playback fails (prevents failure retry storms). Basic ineligible events
do not consume cooldown. Bound/expire cooldown entries to avoid unbounded maps.

## Existing integration points and traps

- `src/events/voiceStateUpdate.ts`: existing voice logging. Keep independent.
- `src/events/voiceStateMusic.ts`: auto-leave logic. Entrance handling must not
  undo a stop/leave triggered while an entrance is preparing.
- `src/app/modules.ts`: discovers top-level event files automatically. Add one
  event adapter; do not place helper modules in `src/events/`.
- `src/features/music/musicSession.ts`: `MusicSession.playSound()` owns current
  one-shot playback. It can call `ensureConnection()` and its Promise resolves
  after starting playback, not after finishing. Calling it after a one-time
  channel check is insufficient to guarantee no auto-join or no race.
- `src/features/music/ytdlp.ts`: `durationSec` is used for fades; do not assume
  it is a hard decoding/playback timeout. Inspect and add an explicit optional
  duration cap for entrances without changing ordinary music playback.
- `src/features/speech/session.ts`: a separate speech player can subscribe to
  the same connection. `src/audio/ducking.ts` tracks music ownership; its
  `isMusicActive()` is not a reliable indication of whether TTS is speaking.
- `dashboard/lib/sounds.ts`, `sound-storage.ts`, `sound-types.ts`, and
  `dashboard/app/soundboard/actions.ts`: existing global sound library and
  mutation/recovery workflow. Sounds are global, owned by uploader, not guild.
- `dashboard/lib/auth.ts`, `session.ts`, `guild.ts`, `discord.ts`: existing user
  identity, selected guild, and authorized-guild checks. Verify that the stored
  user ID is the Discord snowflake, never the Supabase auth UUID.

## Implementation steps

### 1. Persistence and validation

Add a new, later migration under `supabase/migrations/` creating
`VoiceEntrancePreference` with:

- `guildId text`, `userId text`, composite primary key.
- `enabled boolean NOT NULL DEFAULT false`.
- `soundId uuid NULL REFERENCES public."Sound"(id) ON DELETE SET NULL`.
- `createdAt` and `updatedAt`, following existing timestamp conventions.
- Enable RLS and grant server/service-role access using existing patterns. Do
  not add public client write policies.

Allow `enabled = true` with `soundId = NULL` in the database so sound deletion
cannot fail on a preference constraint. Runtime treats that row as inactive;
the UI shows “Selected sound is no longer available; choose another sound”.

Add bot store functions under `src/features/entrance/store.ts` and dashboard
server-only persistence under `dashboard/lib/entrance.ts`. Keep contracts small
and typed. Server-side save validates enabled type, UUID, sound existence and
current duration. Enabling requires a valid sound; disabling must remain possible
even if the old sound disappeared. Use upsert and update timestamps explicitly.
Read preferences afresh for each admitted event; no cross-process invalidation
endpoint is needed for this release.

### 2. Safe audio admission and playback

Add a narrowly scoped entrance playback method/options to the existing music
session, rather than another AudioPlayer or an HTTP call back into the bot.

Required guarantees:

1. Use the existing ready connection only. Never call a joining/reconnecting
   path on behalf of an entrance. This should also work when the bot is connected
   but no music is queued; creating session state must not create a connection.
2. Capture connection identity/generation and destination. Recheck connection,
   member's actual current channel, cancellation, and event age after async
   preparation, immediately before subscribing/playing. Stop/disconnect/move
   invalidates pending work; destroy its decoder/stream rather than reviving it.
3. Track preparing/playing speech and entrance ownership using a small shared
   audio coordination primitive if necessary. The busy check and reservation
   must be atomic; a boolean read before an await is insufficient.
4. Existing manual Soundboard busy errors remain intact. If TTS arrives during
   an entrance, cancel the entrance and clean up its pause/subscription state
   before TTS takes ownership. Late entrance callbacks must not steal TTS's
   subscription or resume music under it. Manual sound requests may retain the
   existing busy response while an entrance is active.
5. Release reservations on finish, failure, stop, disconnect, and timeout.
   Do not release at `playSound()` Promise resolution if sound is still playing.
6. Impose a 5-second audio limit and bounded preparation time. Apply the age
   deadline before actual playback, with cancellation/cleanup of timed-out work.
7. Respect existing clip gain/fades; clamp fade lengths to actual clip duration.

Keep changes focused on the above guarantees; no general audio-engine rewrite.
Inspect existing music tests before altering pause/resume/ownership semantics.

### 3. Entrance service and event adapter

Suggested files:

- `src/features/entrance/types.ts`: preference/result types and default limits.
- `src/features/entrance/store.ts`: DB lookup and registered sound resolution.
- `src/features/entrance/service.ts`: eligibility, reservations, cooldowns,
  deadlines, latest-state rechecks, and playback orchestration.
- `src/events/voiceStateEntrance.ts`: thin `Events.VoiceStateUpdate` adapter.

Use dependency injection for time, store, connection state, and playback so
behavior tests do not connect to Discord or Supabase. Catch asynchronous errors
at the adapter boundary. Do not await entrance work inside the voice-log handler.

Resolve the latest playable storage path from the `Sound` row on the bot server,
check duration again, and sign it using `getSupabaseAdmin()` and the private
`sounds` bucket. Match existing path validation and mutation/recovery availability
rules; skip a record currently being trimmed/deleted or awaiting recovery.
Do not store signed URLs in preferences, accept arbitrary user URLs, or make the
bucket public. Resolve the current version each time; never fall back to source
audio. A deletion/trim race or expired URL should simply cause a skipped entrance.
Avoid logging signed URLs or secrets.

Return structured skip reasons internally (disabled, cooldown, busy, stale,
channel_changed, sound_unavailable, playback_failed). Use existing logging style;
no telemetry service or user-facing notifications are needed.

### 4. Dashboard configuration

Add `/soundboard/entrance` with a clear link from Soundboard. Reuse current UI
styles and loader/server-action patterns. Both members and admins configure only
their own preference for the selected authorized guild in this release.

UI includes:

- Current server name, an explicit enable toggle, and selected clip.
- Searchable/selectable existing sounds with eligible durations; disabled or
  excluded longer/unknown-duration sounds with a brief explanation.
- Browser preview using the existing authorized playable-URL mechanism.
- Save with pending, success, and failure states; render persisted values on reload.
- Explanation: “Plays when you enter the bot's current voice channel. Maximum
  5 seconds; once per minute. Skipped while other sounds or speech are playing.”
- Empty states for no selected server, no eligible sounds, and deleted selection;
  link to the existing Soundboard manager to upload/trim a clip.

Authorize every loader, preview, and mutation server-side. Derive user identity
from the authenticated session and check selected guild against authorized guilds;
cookies and client-supplied guild/user IDs are not authorization. Follow existing
host/role rules. Reject attempts to update someone else's preference, including
admin requests in this self-service release. Do not require being in voice just
to configure a preference. Saving works while the bot is offline.

No new bot HTTP endpoint, slash command, upload pipeline, or environment variable
is expected for Phase 1. Verify route authorization/navigation tests even though
the current `/soundboard` prefix policy should already cover the new page.

### 5. Tests and verification

Add focused behavioral tests, including:

- Eligible join/move plays exactly once; same-channel toggles, leave, bots,
  Stage channels, disabled/missing preferences do not play.
- Bot absent, in another channel, or not ready never joins/moves/reconnects.
- Simultaneous events cannot bypass user/guild cooldown or busy reservations;
  different guilds remain independent; cooldown boundaries use fake time.
- Stop, disconnect, member departure, bot move, and stale requests during DB,
  storage, or decoder preparation cannot cause late playback.
- Manual sound and active/preparing TTS cause a skip; TTS arriving during an
  entrance takes over cleanly and late callbacks do not steal audio ownership.
- Music resumes after successful/failed/cancelled entrance as appropriate;
  already paused music stays paused and queue/loop/position are preserved.
- Clip duration is validated on save and trigger; decoding is actually capped,
  including when stored metadata is inaccurate. Timeouts clean up resources.
- Missing/deleted/changed/busy sound and DB/storage failures safely release
  reservations. Deleting a referenced sound succeeds and UI handles NULL soundId.
- Dashboard rejects unauthenticated, forged identity, and unauthorized-guild
  requests; correctly persists each user's settings separately by guild.
- UI toggle, preview, save/error, empty states, and deleted selection behave as
  specified. Preview never invokes Discord playback.

Run focused tests while implementing, then `npm run check` and
`npm run build:all`. Report unrelated pre-existing failures accurately.

Manual smoke test in an authorized configured test environment: apply migration,
save a short clip preference, keep bot in a voice channel, join/move into it, test
rapid rejoin and simultaneous joins, try during music/manual sound/TTS, then
disconnect the bot during preparation. Confirm it never reconnects on its own.
Unit/build success does not replace this real audio check; state if unavailable.

### 6. Documentation and completion

Update README with opt-in setup, limits, existing-channel behavior, music pause
behavior, and cooldown reset on restart. Document the new migration and deployment
order (migration before updated applications). For rollback, disable/remove the
entrance event adapter or revert the feature code; leave the additive table in
place rather than deleting user settings.

Completion requires Phase 1 implementation, passing relevant automated checks,
and a concise report of changed files, migration steps, and manual tests performed
or unavailable. Do not claim real Discord audio was verified without running it.

## Phase 2 — optional synthesized entrance speech

Implementation: added in the 2026-09-22 migration and dashboard/bot code.
Speech is synthesized on save through the preview endpoint and kept as a
private, versioned WAV asset. Join events only sign and play the saved asset.

Only implement when separately requested. Add a sound/TTS selector, short text
limit, and supported voice selection. Reuse existing synthesis/provider validation
but do not call the current `voiceSession.speak()` directly from the event: it
queues speech and can join/move the bot, violating the entrance contract.

Prefer generating and validating a short private audio asset when settings are
saved, then using the Phase 1 entrance playback path. Design ownership, storage
cleanup, cache invalidation, synthesis costs/timeouts, and hard duration enforcement
before adding this mode. Do not synthesize billable audio on every join by default.

## Prompt to hand to the implementing model

> Implement Phase 1 of `docs/personal-entrance-sounds-plan.md` end to end. Read
> repository guidance and inspect the current working tree first; preserve all
> existing unrelated changes. Follow the behavioral contract, especially existing
> connection only, atomic cooldown/busy admission, cancellation races, and TTS
> coordination. Add the migration, bot behavior, dashboard UI, focused tests, and
> README instructions. Run `npm run check` and `npm run build:all`, then report
> results and any unavailable manual verification. Leave Phase 2 for a later task.
