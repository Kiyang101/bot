# Soundboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a global, user-owned Discord sound library with live one-shot playback over uninterrupted music, waveform trimming, and role-aware management in the Megu dashboard.

**Architecture:** The dashboard stores one global sound library, with `uploadedById` ownership and a private Supabase Storage bucket. The selected guild is only the playback destination. The bot uses one per-guild PCM mixer and one Discord `AudioPlayer`: music is the main source, and at most one soundboard overlay can be active; a second overlay is rejected until the first ends.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Supabase SSR/admin clients, Supabase Storage/Postgres, discord.js v14, `@discordjs/voice`, Node streams, ffmpeg, Web Audio API, CSS via the existing global stylesheet, and Node/Vitest tests.

**Spec:** `docs/superpowers/specs/2026-08-27-soundboard-design.md`

## Global Constraints

- Sounds belong to the user who uploaded them, but the shared library is available across Discord servers.
- All authenticated dashboard users can list and use the global library; members can edit/delete their own sounds and admins can edit/reorder/delete any sound.
- The selected guild is relevant only to playback destination, not sound ownership or library filtering.
- Sound playback is always one-shot; there is no loop setting in the UI, database, or control payload.
- The current music source and one optional soundboard overlay source are decoded to the same 48 kHz stereo PCM format and mixed into the single `AudioPlayer` resource.
- If an overlay is already active, the control endpoint rejects a second play request; it does not queue or layer the second sound.
- Store original uploads and derived playable clips in private Supabase Storage paths; never expose arbitrary storage paths to the client or bot.
- Accepted upload types are MP3, WAV, and OGG; client and server both validate the file type and configured size limit.
- Use the existing Discord OAuth session, selected guild cookie, control secret, and localhost-only bot control endpoint.
- Preserve existing voice logs, music, speak, and settings behavior.
- Verify with `npm run typecheck` in `bot-discord/bot`, the dashboard build, and focused tests before claiming completion.

## File Map

- `supabase/migrations/20260827210000_soundboard.sql` — global `Sound` table, indexes, grants, and storage bucket policy setup.
- `dashboard/lib/sound-types.ts` — serializable sound records and typed mutation/playback results.
- `dashboard/lib/sound-validation.ts` — upload metadata, shortcut, trim, gain, fade, and editable-field validation.
- `dashboard/lib/sounds.ts` — global queries, signed URLs, Storage operations, ownership checks, and row mapping.
- `dashboard/lib/audio.ts` — server-side duration extraction and ffmpeg trim processing.
- `dashboard/lib/control.ts` — dashboard client for `/soundboard/play` and `/soundboard/stop`.
- `dashboard/app/soundboard/actions.ts` — authenticated server actions for upload, play, edit, trim, delete, and reorder.
- `dashboard/app/soundboard/page.tsx` — global library loading and selected-guild playback destination.
- `dashboard/app/soundboard/Soundboard.tsx` — live search/filter/pad/playback state.
- `dashboard/app/soundboard/manage/page.tsx` — management data loading and signed preview URLs.
- `dashboard/app/soundboard/manage/SoundManager.tsx` — upload, metadata editing, delete, and library state.
- `dashboard/app/soundboard/manage/WaveformEditor.tsx` — browser waveform rendering, range handles, preview, and keyboard interaction.
- `dashboard/app/layout.tsx` — Soundboard navigation item.
- `dashboard/lib/auth.ts` — member/admin route access for both soundboard paths.
- `dashboard/app/globals.css` — soundboard console layout, responsive grid, pad states, waveform editor, and focus states.
- `src/lib/voice/audioMixer.ts` — one 48 kHz stereo PCM mixer with one main source and one overlay slot per guild.
- `src/lib/music/ytdlp.ts` — PCM output mode for the music source while preserving existing effects and cleanup.
- `src/lib/music/musicSession.ts` — one-player mixer integration and soundboard overlay API.
- `src/control/server.ts` — authenticated `/soundboard/play` and `/soundboard/stop` routes with busy/error handling.
- `test/sound-validation.test.ts` — pure validation tests.
- `test/audio-mixer.test.ts` — PCM mixing, overlay exclusivity, gain, and source-end tests.

---

### Task 1: Add global sound schema and pure domain validation

**Files:**
- Create: `supabase/migrations/20260827210000_soundboard.sql`
- Create: `dashboard/lib/sound-types.ts`
- Create: `dashboard/lib/sound-validation.ts`
- Create: `test/sound-validation.test.ts`
- Modify: `package.json` only if the existing test command needs to include the new file pattern

**Interfaces:**
- Produces `SoundRecord`, `SoundMutationResult`, `SoundPlaybackOptions`, `validateUploadMeta`, `validateTrimRange`, `normalizeShortcut`, `canEditSound`, `canDeleteSound`, and `mapSoundRow` for later tasks.

- [ ] **Step 1: Write the failing validation tests**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SOUND_BYTES, canDeleteSound, canEditSound, normalizeShortcut, validateTrimRange, validateUploadMeta } from '../dashboard/lib/sound-validation';

test('accepts supported audio metadata and trims the name', () => {
  assert.deepEqual(validateUploadMeta('  Airhorn  ', 'audio/mpeg', 1200), { ok: true, value: { name: 'Airhorn' } });
});

test('rejects unsupported, oversized, and empty uploads', () => {
  assert.equal(validateUploadMeta('clip', 'audio/flac', 1200).ok, false);
  assert.equal(validateUploadMeta('clip', 'audio/mpeg', MAX_SOUND_BYTES + 1).ok, false);
  assert.equal(validateUploadMeta('   ', 'audio/mpeg', 1200).ok, false);
});

test('requires a positive trim range inside the source duration', () => {
  assert.equal(validateTrimRange({ trimStartMs: 100, trimEndMs: 900, sourceDurationMs: 1000 }).ok, true);
  assert.equal(validateTrimRange({ trimStartMs: 900, trimEndMs: 100, sourceDurationMs: 1000 }).ok, false);
  assert.equal(validateTrimRange({ trimStartMs: 0, trimEndMs: 1200, sourceDurationMs: 1000 }).ok, false);
});

test('normalizes printable shortcuts and rejects modifiers', () => {
  assert.equal(normalizeShortcut('A'), 'a');
  assert.equal(normalizeShortcut(' '), 'space');
  assert.equal(normalizeShortcut('Ctrl+K'), null);
});

test('members mutate only their own sounds while admins mutate any sound', () => {
  const own = { uploadedById: 'member-1' };
  const other = { uploadedById: 'member-2' };
  assert.equal(canEditSound({ id: 'member-1', role: 'member' }, own), true);
  assert.equal(canDeleteSound({ id: 'member-1', role: 'member' }, other), false);
  assert.equal(canEditSound({ id: 'admin-1', role: 'admin' }, other), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/sound-validation.test.ts`

Expected: FAIL because the sound validation module and exported types do not exist.

- [ ] **Step 3: Define records and validation**

Implement `SoundRecord` with `id`, `name`, `category`, `color`, `storagePath`, `sourceStoragePath`, `mimeType`, `sizeBytes`, `durationSec`, `uploadedById`, `uploadedByName`, `shortcut`, `gainDb`, `fadeInMs`, `fadeOutMs`, `trimStartMs`, `trimEndMs`, `sortOrder`, `createdAt`, and `updatedAt`. Implement `SoundMutationResult` and `SoundPlaybackOptions` without any loop property. Use MP3/WAV/OGG MIME allowlist, `MAX_SOUND_BYTES = 10 * 1024 * 1024`, 60-character names, gain `-24..12 dB`, fade `0..5000 ms`, minimum clip length `100 ms`, and lowercase shortcut normalization for one printable key or `space`.

- [ ] **Step 4: Add the global `Sound` migration**

Create the quoted Postgres table without `guildId`, with UUID `id`, source/playable paths, uploader identity, trim offsets, metadata, and `sortOrder`. Add an index on `sortOrder, createdAt`, a unique partial index on non-null `shortcut`, and grants/policies consistent with the existing server-side admin client pattern. Create the private `sounds` Storage bucket if the project migration convention supports storage DDL; otherwise keep object access server-only and document the bucket requirement in the migration comment.

- [ ] **Step 5: Run tests and migration checks**

Run: `node --import tsx --test test/sound-validation.test.ts` and `git diff --check`.

Expected: PASS and no whitespace errors. Apply the SQL in a disposable Supabase database or SQL editor and confirm the table has no guild column and shortcut uniqueness is global.

- [ ] **Step 6: Commit the domain slice**

```bash
git add supabase/migrations/20260827210000_soundboard.sql dashboard/lib/sound-types.ts dashboard/lib/sound-validation.ts test/sound-validation.test.ts
git commit -m "feat: add global soundboard domain model"
```

### Task 2: Implement Storage, signed URLs, duration extraction, and trimming

**Files:**
- Create: `dashboard/lib/sounds.ts`
- Create: `dashboard/lib/audio.ts`
- Modify: `dashboard/package.json` to declare server-side ffmpeg if the workspace does not already resolve it
- Create: `dashboard/lib/sounds.test.ts`

**Interfaces:**
- Consumes Task 1 types and validators.
- Produces `listSounds(): Promise<SoundRecord[]>`, `getSound(id: string): Promise<SoundRecord | null>`, `getSignedSoundUrl(path: string): Promise<string>`, `uploadSource(...)`, `replacePlayableClip(...)`, `deleteSoundFiles(...)`, `trimSourceFile(...)`, and `mapSoundRow(...)`.

- [ ] **Step 1: Write failing helper tests**

Test that row mapping preserves global ownership and never applies a guild filter. Test that trim processing rejects an end before start and returns a playable file buffer for a small generated WAV fixture.

```ts
test('maps a global sound row without guild ownership', () => {
  const row = { id: 's1', name: 'Airhorn', uploadedById: 'u1', uploadedByName: 'Kai', sortOrder: 0 };
  assert.equal(mapSoundRow(row as never).uploadedById, 'u1');
  assert.equal('guildId' in mapSoundRow(row as never), false);
});
```

- [ ] **Step 2: Run the helper tests to verify they fail**

Run: `node --import tsx --test dashboard/lib/sounds.test.ts`.

Expected: FAIL because the helper modules do not exist.

- [ ] **Step 3: Implement Supabase helpers**

Use `createAdminClient()` for mutations and signed URLs. `listSounds` selects all global rows ordered by `sortOrder` then `createdAt`. `uploadSource` writes to `sounds/${uploadedById}/${soundId}/source`; `replacePlayableClip` writes to `sounds/${uploadedById}/${soundId}/playable` and returns the new path only after upload succeeds. Keep path construction internal so callers cannot choose another user's path.

- [ ] **Step 4: Implement duration and trim processing**

Write the source to a task-scoped temporary file, run bundled ffmpeg with `-ss`, `-to`, `-i`, and normalized output, capture duration with ffprobe/ffmpeg output, and return a `Buffer` plus final duration. Reject malformed media, invalid ranges, and oversized output. Remove temporary files in `finally`; never overwrite the original source object.

- [ ] **Step 5: Run helpers and typecheck**

Run: `node --import tsx --test dashboard/lib/sounds.test.ts` and `npm run typecheck`.

Expected: PASS. If ffmpeg is unavailable, fail with `Audio processing is unavailable on this dashboard host.` rather than a raw child-process error.

- [ ] **Step 6: Commit the storage slice**

```bash
git add dashboard/lib/sounds.ts dashboard/lib/audio.ts dashboard/package.json dashboard/lib/sounds.test.ts
git commit -m "feat: add sound storage and trim processing"
```

### Task 3: Add the one-player PCM mixer and bot playback control

**Files:**
- Create: `src/lib/voice/audioMixer.ts`
- Create: `test/audio-mixer.test.ts`
- Modify: `src/lib/music/ytdlp.ts`
- Modify: `src/lib/music/musicSession.ts`
- Modify: `src/control/server.ts`

**Interfaces:**
- Consumes the existing per-guild music session and control server.
- Produces `AudioMixer`, `MusicSession.playSound(...)`, `MusicSession.stopSound()`, `handleSoundboard(...)`, and control routes `/soundboard/play` and `/soundboard/stop`.

- [ ] **Step 1: Write failing PCM mixer tests**

Use 16-bit little-endian stereo frames and assert saturation, overlay rejection, overlay completion, and overlay stop without clearing the main source:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { AudioMixer } from '../src/lib/voice/audioMixer';

const FRAME_BYTES = 48_000 / 50 * 2 * 2;
function pcmFrame(sample: number): Buffer {
  const frame = Buffer.alloc(FRAME_BYTES);
  for (let offset = 0; offset < FRAME_BYTES; offset += 2) frame.writeInt16LE(sample, offset);
  return frame;
}
async function readFrame(mixer: AudioMixer): Promise<Buffer> {
  const chunk = mixer.read(FRAME_BYTES) as Buffer | null;
  if (chunk) return chunk;
  return await new Promise((resolve, reject) => {
    mixer.once('data', (data: Buffer) => resolve(data));
    mixer.once('error', reject);
  });
}

test('mixes main and overlay samples with saturation', async () => {
  const mixer = new AudioMixer();
  mixer.setMain(Readable.from([pcmFrame(30_000)]));
  assert.equal(mixer.startOverlay(Readable.from([pcmFrame(10_000)]), { gainDb: 0, fadeInMs: 0, fadeOutMs: 0 }), true);
  const frame = await readFrame(mixer);
  assert.equal(frame.readInt16LE(0), 32_767);
});

test('rejects a second overlay while the first is active', () => {
  const mixer = new AudioMixer();
  assert.equal(mixer.startOverlay(Readable.from([pcmFrame(1_000)]), { gainDb: 0, fadeInMs: 0, fadeOutMs: 0 }), true);
  assert.equal(mixer.startOverlay(Readable.from([pcmFrame(2_000)]), { gainDb: 0, fadeInMs: 0, fadeOutMs: 0 }), false);
});

test('stopping an overlay leaves the main source active', async () => {
  const mixer = new AudioMixer();
  mixer.setMain(Readable.from([pcmFrame(4_000), pcmFrame(4_000)]));
  mixer.startOverlay(Readable.from([pcmFrame(1_000)]), { gainDb: 0, fadeInMs: 0, fadeOutMs: 0 });
  mixer.stopOverlay();
  assert.equal((await readFrame(mixer)).readInt16LE(0), 4_000);
});
```

- [ ] **Step 2: Run mixer tests to verify they fail**

Run: `node --import tsx --test test/audio-mixer.test.ts`.

Expected: FAIL because `AudioMixer` is not defined.

- [ ] **Step 3: Implement `AudioMixer`**

Use 48,000 Hz stereo, signed 16-bit little-endian frames. Buffer each source independently, read exactly one frame per tick, multiply overlay samples by linear gain, sum with main samples, and clamp to `[-32768, 32767]`. Keep one `main` source and one `overlay` source. When an overlay ends, clear only the overlay slot and emit an `overlayEnded` callback. Return `false` from `startOverlay` when occupied. Stop destroys/unsubscribes only the overlay stream.

- [ ] **Step 4: Refactor music to feed the mixer**

Add PCM output mode to `createAudioStream` in `src/lib/music/ytdlp.ts` using ffmpeg `-f s16le -ar 48000 -ac 2 -`. In `MusicSession`, create one `AudioMixer`, one `AudioPlayer`, and one `AudioResource` with `StreamType.Raw`; subscribe the player once per voice connection. Replace direct Ogg/Opus resource swaps with `mixer.setMain(pcmStream)`. Keep queue, seek, effects, volume, pause, and stop behavior unchanged to callers.

- [ ] **Step 5: Add one-shot soundboard methods**

Implement `playSound(channel, audioUrl, options)` so it ensures the same guild connection, fetches/decodes the sound into PCM, and calls `mixer.startOverlay`. Pass only `{ gainDb, fadeInMs, fadeOutMs }`; no loop field exists. If occupied, throw `Soundboard is busy — wait for the current sound to finish.`. Implement `stopSound()` to clear only the overlay.

- [ ] **Step 6: Add control routes and typed busy status**

Extend `src/control/server.ts` with `SoundboardBody` and `handleSoundboard`. Validate `guildId`, `channelId`, same-guild channel ownership, and a server-resolved `audioUrl`. Add `/soundboard/play` and `/soundboard/stop` to `postRoutes`. Return HTTP 409 with `{ error: 'soundboard_busy' }` for an occupied overlay; keep 500 for unexpected failures. Reject any incoming `loop` key if present.

- [ ] **Step 7: Run bot tests and typecheck**

Run: `node --import tsx --test test/audio-mixer.test.ts`, `npm test`, and `npm run typecheck`.

Expected: all PASS; tests show an overlay does not call music `pause`, `stop`, or replace the music queue.

- [ ] **Step 8: Commit the bot audio slice**

```bash
git add src/lib/voice/audioMixer.ts test/audio-mixer.test.ts src/lib/music/ytdlp.ts src/lib/music/musicSession.ts src/control/server.ts
git commit -m "feat: mix one-shot soundboard audio over music"
```

### Task 4: Wire authenticated dashboard server actions and control client

**Files:**
- Modify: `dashboard/lib/control.ts`
- Create: `dashboard/app/soundboard/actions.ts`
- Modify: `dashboard/lib/sounds.ts` if action-facing helpers need typed results
- Create: `dashboard/app/soundboard/actions.test.ts`

**Interfaces:**
- Consumes Task 1-3 types, Storage helpers, `getSessionUser`, selected guild helpers, and control endpoint.
- Produces `listSoundboardData`, `playSound`, `stopSound`, `uploadSound`, `updateSound`, `trimSound`, `deleteSound`, and `reorderSounds` server actions.

- [ ] **Step 1: Write failing authorization tests**

Cover these cases: a member can delete their own sound; a member cannot delete another user's sound; an admin can delete another user's sound; all authenticated users can play a global sound; missing selected guild blocks Discord playback but not global listing; a sound id outside the global table is rejected.

- [ ] **Step 2: Run the action tests to verify they fail**

Run: `node --import tsx --test dashboard/app/soundboard/actions.test.ts`.

Expected: FAIL because action functions do not exist.

- [ ] **Step 3: Add control client methods**

Add `sendSoundboardPlay({ guildId, channelId, audioUrl, gainDb, fadeInMs, fadeOutMs })` and `sendSoundboardStop(guildId)` to `dashboard/lib/control.ts`. Map HTTP 409 `soundboard_busy` to a stable `SoundboardBusyError` message so the client can render a waiting state.

- [ ] **Step 4: Implement global list/play/stop actions**

Read the session user with `getSessionUser()`, load all sounds without a guild filter, and use `getSelectedGuildId()` only for playback. For play, require a selected guild, load the global sound by id, create a short-lived signed URL, and call `sendSoundboardPlay`. For stop, require a selected guild and call `sendSoundboardStop`.

- [ ] **Step 5: Implement upload/edit/trim/delete/reorder actions**

Upload derives `uploadedById` and `uploadedByName` from the session, validates the file again, uploads the source, generates the initial playable clip, inserts the row, and cleans up storage if row insertion fails. Update and trim actions enforce owner-or-admin access. Delete enforces the same access, removes both storage objects, then the row. Reorder requires admin and updates global `sortOrder` values in a verified sequential batch. Revalidate `/soundboard` and `/soundboard/manage` after each successful mutation.

- [ ] **Step 6: Run action tests and dashboard typecheck**

Run: `node --import tsx --test dashboard/app/soundboard/actions.test.ts` and `npm run typecheck` from `dashboard/`.

Expected: PASS with direct action calls unable to bypass ownership, global visibility, or selected-guild playback checks.

- [ ] **Step 7: Commit the dashboard action slice**

```bash
git add dashboard/lib/control.ts dashboard/app/soundboard/actions.ts dashboard/lib/sounds.ts dashboard/app/soundboard/actions.test.ts
git commit -m "feat: add soundboard dashboard actions"
```

### Task 5: Build waveform editor and management UI

**Files:**
- Create: `dashboard/app/soundboard/manage/WaveformEditor.tsx`
- Create: `dashboard/app/soundboard/manage/SoundManager.tsx`
- Create: `dashboard/app/soundboard/manage/page.tsx`
- Create: `dashboard/vitest.config.ts`
- Create: `dashboard/test/setup.ts`
- Modify: `dashboard/package.json` to add the test script and React/jsdom testing dependencies
- Modify: `dashboard/app/globals.css`

**Interfaces:**
- Consumes `SoundRecord`, signed preview URLs, and actions from Task 4.
- Produces accessible upload, edit, trim, preview, delete, and library components used by the live board and management route.

- [ ] **Step 1: Add the dashboard component test harness**

Configure Vitest with `environment: 'jsdom'`, the existing TypeScript path alias, React JSX transform, and `dashboard/test/setup.ts` importing `@testing-library/jest-dom`. Add `test: vitest run` to `dashboard/package.json` and the required React Testing Library, jsdom, Vitest, and Vite React plugin development dependencies.

- [ ] **Step 2: Write component behavior tests**

Test that valid upload displays filename and waveform; invalid type shows the correction; dragging/keyboard-adjusting handles updates selected duration; `Save trim` calls `trimSound` with integer offsets; members see delete only on own rows; admins see edit/delete/reorder for all rows; delete confirmation requires explicit `Delete sound`.

- [ ] **Step 3: Run component tests to verify they fail**

Run: `npm test -- --run dashboard/app/soundboard/manage` from `dashboard/`.

Expected: FAIL because the route and components do not exist.

- [ ] **Step 4: Implement `WaveformEditor`**

Decode the selected source with `AudioContext.decodeAudioData`, downsample channel data to at most 160 bars, draw bars with CSS or canvas, and keep `startMs`/`endMs` in React state. Use pointer handles plus buttons/arrow-key adjustments. Generate a local Blob URL and play only the selected range with an `HTMLAudioElement` driven by `currentTime`, stopping at `endMs`. Expose `aria-label`, `aria-valuemin`, `aria-valuemax`, and `aria-valuenow` for both handles.

- [ ] **Step 5: Implement `SoundManager` upload and editor states**

Keep selected file, metadata, trim range, preview URL, pending action, and error message in local state. On upload, show an inline processing state while the server stores the source and generated clip. For an existing sound, load its signed playable URL for preview and its source URL only when the user enters trim mode. Preserve the previous saved sound when trim processing fails.

- [ ] **Step 6: Implement global library and role-aware actions**

Render `Uploaded by`, category, duration, upload date, shortcut, and actions. Members see edit/delete only for their own rows; admins see all actions and global reorder controls. Use inline delete confirmation and announce mutations in a live region.

- [ ] **Step 7: Implement the management page loader**

Load the global sound list and signed preview URLs server-side. Do not filter by selected guild. Pass the session user role/id to `SoundManager` for presentation only; actions remain the security boundary.

- [ ] **Step 8: Add responsive styling and accessibility states**

Add the waveform panel, upload drop zone, editor layout, library table, pending/error states, visible focus rings, `prefers-reduced-motion`, and mobile stacking to `globals.css`. Keep the established dashboard palette and use the acid-lime playing token only for active states.

- [ ] **Step 9: Run component tests and dashboard build**

Run: `npm test -- --run dashboard/app/soundboard/manage`, `npm run typecheck`, and `npm run build` from `dashboard/`.

Expected: PASS with no hydration warnings and a usable management screen at `/soundboard/manage`.

- [ ] **Step 10: Commit the management UI slice**

```bash
git add dashboard/app/soundboard/manage dashboard/vitest.config.ts dashboard/test/setup.ts dashboard/package.json dashboard/app/globals.css
git commit -m "feat: add sound upload trim and management UI"
```

### Task 6: Build the live soundboard and integrate navigation/access

**Files:**
- Create: `dashboard/app/soundboard/Soundboard.tsx`
- Create: `dashboard/app/soundboard/page.tsx`
- Modify: `dashboard/app/layout.tsx`
- Modify: `dashboard/lib/auth.ts`
- Modify: `dashboard/app/globals.css`

**Interfaces:**
- Consumes global sound data, selected guild, music state, control actions, and management route from Tasks 4-5.
- Produces the user-facing `/soundboard` live performance page.

- [ ] **Step 1: Write live board behavior tests**

Test search by name/category/uploader; category chips; one play call per pad click; other pads disabled while playing; busy result keeps the active pad and displays the wait message; `Stop sound` calls stop; no selected guild keeps browse/preview available but disables Discord playback; keyboard activation works.

- [ ] **Step 2: Run live board tests to verify they fail**

Run: `npm test -- --run dashboard/app/soundboard/Soundboard`.

Expected: FAIL because the live route does not exist.

- [ ] **Step 3: Implement the server page loader**

Load the global sound list, selected guild, and bot/music status. Keep the page dynamic. Pass `guildId`, `guildName`, and serializable `SoundRecord` values to the client board; do not include storage paths.

- [ ] **Step 4: Implement the live pad grid and playback dock**

Render search, dynamic category chips, `Uploaded by me`, large pads, connection strip, current sound progress, master volume presentation, and `Stop sound`. Use `button` elements for pads with accessible labels. On successful play, set the active pad and use a short interval to update remaining time from the known duration; clear it on end/stop/error.

- [ ] **Step 5: Add navigation and role access**

Add `{ href: '/soundboard', label: 'Soundboard' }` to `NAV_LINKS`. Add `/soundboard` and `/soundboard/manage` to both member and admin `ROLE_PATHS`. Keep `/config` admin-only. Link `Manage sounds` from the live board and `Back to soundboard` from management.

- [ ] **Step 6: Add live board styling**

Create the broadcast-console layout: four-plus flexible desktop columns, two-column mobile pads, category accent strip, waveform mark, active lime pulse, disabled busy state, and sticky playback dock on narrow screens. Respect reduced motion and add `:focus-visible` styles.

- [ ] **Step 7: Run live board tests and dashboard build**

Run: `npm test -- --run dashboard/app/soundboard/Soundboard`, `npm run typecheck`, and `npm run build` from `dashboard/`.

Expected: PASS with members able to open both soundboard routes and admin-only controls rendered only for admins.

- [ ] **Step 8: Commit the live board slice**

```bash
git add dashboard/app/soundboard/page.tsx dashboard/app/soundboard/Soundboard.tsx dashboard/app/layout.tsx dashboard/lib/auth.ts dashboard/app/globals.css
git commit -m "feat: add live discord soundboard"
```

### Task 7: End-to-end verification and regression pass

**Files:**
- Modify: implementation files only when a verification failure identifies a concrete defect
- Test: existing `test/*.test.ts`, dashboard component/action tests, and manual browser checks

**Interfaces:**
- Consumes every completed slice from Tasks 1-6.
- Produces a verified global soundboard with no regression to existing dashboard/music behavior.

- [ ] **Step 1: Run the complete bot test and typecheck suite**

Run from `bot-discord/bot`: `npm test` and `npm run typecheck`.

Expected: PASS, including mixer tests, with no changes to existing music, speak, or voice-log tests.

- [ ] **Step 2: Run complete dashboard verification**

Run from `bot-discord/bot/dashboard`: `npm test`, `npm run typecheck`, and `npm run build`.

Expected: PASS with `/soundboard` and `/soundboard/manage` included in the Next build output.

- [ ] **Step 3: Verify global ownership manually**

Using two authenticated users and two selected guilds, upload one sound as user A, confirm user B sees and previews it in both guild contexts, confirm user B cannot delete it, and confirm user A can delete it. Confirm an admin can edit and delete it.

- [ ] **Step 4: Verify overlay playback manually**

Start music in guild A, trigger a sound, and confirm the song continues while the sound overlays it. Trigger a second sound during the first and confirm the UI shows the busy state and the bot returns 409 without interrupting either source. Confirm the second sound works after the first ends. Repeat in guild B and confirm playback state is independent.

- [ ] **Step 5: Verify waveform trim manually**

Upload a valid audio file, drag both handles, preview the selected range, save it, confirm duration and waveform update, then edit the range again from the retained source. Try an unsupported type, oversized file, reversed handles, and a decode failure; each must preserve the previous playable clip and show a specific correction.

- [ ] **Step 6: Verify accessibility and responsive states**

Check keyboard-only use, visible focus, screen-reader labels/live announcements, 44px touch targets, mobile layout, offline bot state, no selected guild, empty library, pending upload/trim/delete, and reduced-motion behavior.

- [ ] **Step 7: Commit verification fixes and report evidence**

```bash
git status --short
git diff --check
git log -7 --oneline
```

Commit only concrete fixes found during verification with a focused message, then report the exact test/build commands and results.
