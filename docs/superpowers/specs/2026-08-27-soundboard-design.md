# Soundboard dashboard design

## Goal

Add a global sound library to the Megu dashboard so Discord users can quickly
trigger short sounds into the selected Discord server's active voice session,
including over the top of music without interrupting it. Sounds belong to the
user who uploaded them, but the shared library is available across Discord
servers.

The experience has two modes:

- `/soundboard` is optimized for fast live performance.
- `/soundboard/manage` is optimized for uploading, editing, and deleting
  sounds.

This feature uses the dashboard's existing Discord OAuth session, selected
guild cookie as the playback destination, Supabase data layer, and
localhost-only bot control endpoint.

## Access rules

| Capability | Member | Admin |
| --- | --- | --- |
| Open global soundboard | Yes | Yes |
| Play / preview any sound | Yes | Yes |
| Play one sound over active music | Yes | Yes |
| Upload a sound to the global library | Yes | Yes |
| Edit own sound | Yes | Yes |
| Delete own sound | Yes | Yes |
| Edit any sound | No | Yes |
| Reorder / categorize any sound | No | Yes |
| Delete any sound | No | Yes |

The server action must enforce these rules with the verified session user. The
selected guild is relevant only to playback destination. The UI only reflects
permissions; it is not the security boundary.

## Visual direction

The soundboard extends the existing dark dashboard rather than introducing a
separate product shell. The visual language is a broadcast-console treatment:

- Background: ink charcoal `#0f1117`.
- Surfaces: `#1a1d27` and `#161922` with the existing `#2a2e3a` border.
- Primary action: existing Discord blurple `#5865f2`.
- Live/playing state: acid lime `#d5f451` with a faint lime glow.
- Destructive state: existing red `#ed4245`.
- Body text: existing light text `#e6e8ee`; supporting text `#9aa0ad`.
- Sound category colors are user-selectable swatches, restricted to accessible
  preset values so text contrast stays readable.

Large sound pads are the signature interaction. Pads use restrained waveform
marks, category color accents, duration, and uploader metadata. Motion is
limited to a short playing pulse and progress indicator; `prefers-reduced-motion`
removes the pulse.

## Page structure

### Live soundboard (`/soundboard`)

1. Header with title, selected Discord server as the playback destination, and
   a `Manage sounds` link.
2. Voice status strip showing bot connection state for the selected server,
   active voice channel, and a join/stop affordance when the control endpoint
   reports no playable session.
3. Search input and category chips: `All`, `Reactions`, `Memes`, `Music`, and
   `Uploaded by me`. Categories are derived from stored sounds; the default
   category chips are shown when they contain sounds and custom categories are
   added automatically as they appear.
4. Sound pad grid. Desktop uses four or more flexible columns; tablet uses two
   or three; mobile uses two columns with at least 44px pointer targets and
   enough vertical spacing for fast taps.
5. Playback dock showing the most recently triggered sound, progress, current
   time, and master volume. `Stop all` is always available when a sound is
   playing.

Each pad supports mouse, touch, and keyboard activation. The accessible label
  includes sound name, duration, and category. The pressed state is immediate;
  the action result is announced in a live region for screen readers.

When a sound is playing, all other sound pads remain visible but become
temporarily disabled. The active pad and playback dock show `Playing over
music` (or `Playing` when no music is active) and the remaining duration. There
is no sound-to-sound queue in v1: the next sound can be triggered only after the
current overlay finishes, or after `Stop sound` is used.

### Sound management (`/soundboard/manage`)

1. Header with a back link to the soundboard and an `Upload sound` primary
   action.
2. Upload panel with drag/drop and file picker. Accepted types are MP3, WAV,
   and OGG. The interface displays the configured size limit and rejects
   unsupported types or oversized files before upload.
3. Configuration editor appears for a selected/new sound:
   - Name (required, trimmed, max 60 characters).
   - Category (required, one of the shared category values or a new category
     only for admins).
   - Accent color (preset swatches).
   - Keyboard shortcut (optional, one unmodified printable key; duplicates are
     rejected within the global library).
   - Volume normalization / gain slider.
   - Fade in and fade out controls.
   - Browser preview with native audio controls.
4. Library list with name, duration, category, upload date, and `Uploaded by`.
   Each row has `Edit` and `Delete` only when the current user is allowed. An
   admin also sees reorder controls; order is persisted globally.
5. Delete becomes an inline confirmation with explicit `Delete sound` and
   `Keep sound` actions. The sound is removed from the grid after the action
   succeeds and the user is returned to the first available result if the
   deleted row was selected.

## Data model

Add a migration with a `Sound` table containing:

- `id` — UUID primary key.
- `name` — display name.
- `category` — category label.
- `color` — validated preset token/hex value.
- `storagePath` — private storage object path, never a client-supplied URL.
- `mimeType` — accepted audio MIME type.
- `sizeBytes` — original upload size.
- `durationSec` — decoded duration when available.
- `uploadedById` — verified Discord user id.
- `uploadedByName` — display-name snapshot for historical readability.
- `shortcut` — nullable normalized key.
- `gainDb` — bounded gain value.
- `fadeInMs`, `fadeOutMs` — bounded integer values.
- `sortOrder` — integer, default 0.
- `createdAt`, `updatedAt` — timestamps.

Use a private Supabase Storage bucket for audio files. Store objects under a
user-owned path such as `sounds/{uploadedById}/{soundId}`; the path is not
guild-scoped. All authenticated dashboard users can list and use the global
library, while ownership and admin role determine mutation rights. Read/list
operations return signed preview URLs with a short expiry; playback requests
use the same server-side lookup and do not expose arbitrary storage paths. A
later implementation can add soft deletion, but v1 should hard-delete the
storage object and row together with an actionable error if either step fails.

## Data flow and boundaries

### Read flow

- Server page gets the selected guild and session user.
- Server-side data helper queries the global sound library ordered by
  `sortOrder`, then `createdAt`.
- The page passes serializable sound metadata to the client board.
- Preview URLs are generated server-side for the management view and refreshed
  when they expire.

### Play flow

- Client pad click calls a server action with the sound id and selected guild.
- Server action verifies the session, that the selected guild is a valid
  playback destination for the user, and that the requested sound exists in
  the global library.
- Server action resolves the private storage object and sends a sound command
  to the bot control endpoint.
- The bot uses one audio pipeline per guild: the current music source and one
  optional soundboard overlay source are decoded to the same 48 kHz stereo PCM
  format, mixed, and wrapped in the single `AudioPlayer` resource subscribed to
  the guild's `VoiceConnection`.
- Starting an overlay never pauses, seeks, replaces, or clears the music
  source. The overlay is removed from the mixer when its stream ends or when
  `Stop sound` is requested.
- If an overlay is already active, the control endpoint rejects a second play
  request with a typed busy response; it does not queue or layer the second
  sound.
- The bot returns a clear error if it is stopped, cannot connect to the active
  voice channel, cannot decode the file, or the overlay slot is busy.
- Client marks the pad and playback dock as active only after a successful
  command; failure leaves the previous playback state intact and shows an
  inline actionable message.

### Upload flow

- Client validates file extension/type and size immediately.
- Server action re-validates the file metadata and size, derives uploader
  identity from the session, uploads to a user-scoped private storage path,
  writes the `Sound` row, and revalidates both soundboard routes.
- If database insertion fails, the uploaded object is removed as cleanup and
  the user sees a retryable error.

### Edit/delete flow

- Server actions re-check role/ownership for every global-library mutation;
  selected guild is not part of sound ownership.
- Editing updates metadata only unless a new audio file is explicitly chosen.
- Deletion removes storage and row, then revalidates both routes.
- Any failed mutation returns a typed `{ ok, message }` result matching the
  dashboard's existing action pattern.

## Audio architecture decision

The current bot uses one `AudioPlayer` per guild and sends music as Ogg/Opus
passthrough. A second player cannot be subscribed independently to the same
Discord voice connection, so overlay playback must not be implemented as a
second `AudioPlayer` or by replacing the current music resource.

Introduce a small per-guild audio coordinator (or extract the responsibility
from `MusicSession`) that owns the connection, one player, and a PCM mixer. The
existing music stream is adapted to provide a decoded PCM source to the mixer;
the soundboard source is decoded into the same format and gets its own bounded
gain and optional fade envelope. The mixer emits silence when no source is
active and keeps the connection reusable. Music controls continue to operate
on the main source; soundboard stop only removes the overlay source.

The control endpoint adds `/soundboard/play` and `/soundboard/stop`. The play
command carries a server-resolved audio input plus the sound's gain and fade
settings. Sound playback is always one-shot; there is no loop setting in the
UI, database, or control payload. The bot owns the actual file fetch and decode
so the dashboard never sends untrusted local paths to the process. The existing
control secret and localhost restriction remain in force.

The global sound library is shared across guilds, but playback state is not:
each guild has its own audio coordinator, active music source, and one-slot
soundboard overlay. Playing a sound in one selected server does not block the
same sound from being played in another server.

## Error, empty, and loading states

- No guild selected: the global library can still be browsed and previewed, but
  show a centered setup card explaining that a Discord server must be selected
  before Discord playback is available.
- No sounds: show an inviting empty state with `Upload the first sound` and a
  note that users can add sounds; admins see the same action.
- Bot unavailable: pads remain browsable and previewable, but show a clear
  `Bot offline` status and disable only Discord playback.
- Upload error: keep the selected file and metadata in the form, display the
  exact correction needed, and allow retry.
- Duplicate shortcut: identify the conflicting sound by name.
- Delete error: keep the row and confirmation visible with a retry action.
- Pending actions: disable only the affected control, preserve the rest of
  the board, and use `aria-busy` where appropriate.

## Implementation units

- `app/soundboard/page.tsx`: server data loading and page shell.
- `app/soundboard/Soundboard.tsx`: client search/filter/pad/playback state.
- `app/soundboard/manage/page.tsx`: management data loading and admin/member
  action visibility.
- `app/soundboard/manage/SoundManager.tsx`: upload, edit, preview, and delete
  UI state.
- `app/soundboard/actions.ts`: typed server actions for play, upload, edit,
  delete, and reorder.
- `dashboard/lib/sounds.ts`: query, validation, signed URL, and storage
  helpers.
- `supabase/migrations/<timestamp>_soundboard.sql`: schema, indexes,
  grants, and policies appropriate for the server-side admin client pattern.
- `app/layout.tsx` and `lib/auth.ts`: Soundboard navigation and role access.
- `app/globals.css`: soundboard-specific responsive layout and states.
- `src/lib/voice/mixer.ts`: one-player PCM mixing and the single active overlay
  slot per guild.
- Bot control endpoint and music/voice session code: add sound playback and
  stop commands plus the one-player PCM mixer described above.

## Verification and acceptance criteria

- Member can open `/soundboard`, filter/search, preview, and trigger a sound
  when the bot is available.
- Admin and member can upload valid files; invalid type/size is rejected on
  both client and server.
- `Uploaded by` shows the authenticated Discord identity for every sound.
- Member can edit/delete only their own sound; admin can edit/reorder/delete
  any sound, including sounds uploaded by another user.
- Unauthorized direct requests to server actions cannot bypass ownership or
  role checks.
- The same global library is displayed regardless of selected guild; the
  selected guild only controls where playback is sent.
- A sound is always one-shot and never loops.
- Empty, offline, pending, and failure states are readable and actionable.
- Keyboard activation, visible focus, semantic labels, and reduced-motion
  behavior are verified manually.
- `npm run typecheck` in `bot-discord/bot` and the dashboard build both pass.
- Existing voice logs, music, speak, and settings flows remain unchanged.

## Out of scope for v1

- Anonymous/public access without dashboard authentication.
- Guild-specific sound libraries.
- Waveform generation or audio trimming in the browser.
- Sound-to-sound queues, sound-to-sound layering, or per-user rate limiting.
- Drag-to-reorder on touch; buttons are sufficient for the first release.
- Automatic moderation/transcription of uploaded audio.
