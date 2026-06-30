'use server';

import { cookies, headers } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { revalidatePath } from 'next/cache';
import {
  sendSpeak,
  sendLeave,
  sendPreview,
  getMusicState,
  sendMusicCommand,
  type MusicState,
  type LoopMode,
  type MusicAction,
  type Effect,
} from '@/lib/control';
import { getSelectedGuildId, GUILD_COOKIE } from '@/lib/guild';
import { requireRole } from '@/lib/session';
import { forcedGuildId, requestHost } from '@/lib/auth';

/** Switches which Discord server the dashboard is viewing (stored in a cookie). */
export async function selectGuild(guildId: string) {
  // Remote (ngrok) visitors are locked to their forced server — ignore attempts
  // to switch away from it.
  const hdrs = await headers();
  const forced = forcedGuildId(requestHost((n) => hdrs.get(n)));
  if (forced && guildId !== forced) return;

  const store = await cookies();
  store.set(GUILD_COOKIE, guildId, { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
  revalidatePath('/', 'layout');
}

/** Saves (or clears) the voice-log channel for the selected server. */
export async function saveLogChannel(formData: FormData) {
  await requireRole('admin');
  const guildId = await getSelectedGuildId();
  if (!guildId) return;

  const raw = formData.get('channelId')?.toString() ?? '';
  const channelId = raw === '' ? null : raw;

  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId, logChannelId: channelId },
    update: { logChannelId: channelId },
  });

  revalidatePath('/config');
  revalidatePath('/');
}

export interface SpeakState {
  ok: boolean;
  message: string;
}

export interface SpeakInput {
  channelId: string;
  text: string;
  voice?: string;
  provider?: 'default' | 'voicevox' | 'google';
  translate?: boolean;
  speed?: number;
  pitch?: number;
}

/**
 * Server action for the Speak page — tells the bot to speak in a voice channel.
 * Called directly (RPC-style) from the form's submit handler rather than via
 * `<form action>`, so React 19 doesn't auto-reset the form fields.
 */
export async function speak(input: SpeakInput): Promise<SpeakState> {
  const channelId = input.channelId ?? '';
  const text = (input.text ?? '').trim();
  const voice = input.voice?.trim() || undefined;
  const provider =
    input.provider === 'voicevox' ? 'voicevox' : input.provider === 'google' ? 'google' : 'default';
  const translate = !!input.translate;
  // Speed/pitch only matter for VOICEVOX.
  const speed = provider === 'voicevox' ? input.speed : undefined;
  const pitch = provider === 'voicevox' ? input.pitch : undefined;

  if (!channelId) return { ok: false, message: 'Pick a voice channel first.' };
  if (!text) return { ok: false, message: 'Type a message to speak.' };

  try {
    const { spoken } = await sendSpeak({ channelId, text, voice, provider, translate, speed, pitch });
    const note = translate && spoken !== text ? ` → 🇯🇵 ${spoken}` : '';
    return { ok: true, message: `🔊 Spoke: "${text}"${note}` };
  } catch (err) {
    return { ok: false, message: `❌ ${err instanceof Error ? err.message : 'Failed to speak.'}` };
  }
}

export interface PreviewState {
  ok: boolean;
  message: string;
  /** base64-encoded audio, present only when ok. */
  audioBase64?: string;
  contentType?: string;
  spoken?: string;
}

/**
 * Server action for the Speak page's "Test" button — synthesizes the clip via
 * the bot WITHOUT joining a voice channel and returns it (base64) so the form
 * can play it in the browser. Lets the user hear the voice before sending the
 * bot into a channel.
 */
export async function previewSpeak(input: SpeakInput): Promise<PreviewState> {
  const text = (input.text ?? '').trim();
  const voice = input.voice?.trim() || undefined;
  const provider =
    input.provider === 'voicevox' ? 'voicevox' : input.provider === 'google' ? 'google' : 'default';
  const translate = !!input.translate;
  const speed = provider === 'voicevox' ? input.speed : undefined;
  const pitch = provider === 'voicevox' ? input.pitch : undefined;

  if (!text) return { ok: false, message: 'Type a message to preview.' };

  try {
    const { audio, contentType, spoken } = await sendPreview({
      text,
      voice,
      provider,
      translate,
      speed,
      pitch,
    });
    const note = translate && spoken !== text ? ` → 🇯🇵 ${spoken}` : '';
    return {
      ok: true,
      message: `🎧 Preview ready — playing here only${note}`,
      audioBase64: Buffer.from(audio).toString('base64'),
      contentType,
      spoken,
    };
  } catch (err) {
    return { ok: false, message: `❌ ${err instanceof Error ? err.message : 'Failed to preview.'}` };
  }
}

/** Server action for the Speak page — makes the bot leave the voice channel. */
export async function leaveVoice(): Promise<SpeakState> {
  const guildId = await getSelectedGuildId();
  if (!guildId) return { ok: false, message: 'No server selected.' };

  try {
    await sendLeave(guildId);
    return { ok: true, message: '👋 Bot left the voice channel.' };
  } catch (err) {
    return { ok: false, message: `❌ ${err instanceof Error ? err.message : 'Failed to leave.'}` };
  }
}

// ─── Music player actions ────────────────────────────────────────────────────

export interface MusicActionState {
  ok: boolean;
  message: string;
}

/** Poll the live music state for the selected server. */
export async function fetchMusicState(): Promise<MusicState | null> {
  const guildId = await getSelectedGuildId();
  if (!guildId) return null;
  try {
    return await getMusicState(guildId);
  } catch {
    return null;
  }
}

/** Queue a song/playlist/search in the given voice channel. */
export async function playMusic(channelId: string, query: string): Promise<MusicActionState> {
  const guildId = await getSelectedGuildId();
  if (!guildId) return { ok: false, message: 'No server selected.' };
  if (!channelId) return { ok: false, message: 'Pick a voice channel first.' };
  if (!query.trim()) return { ok: false, message: 'Enter a song name or YouTube URL.' };

  try {
    const res = await sendMusicCommand({ guildId, action: 'play', channelId, query: query.trim() });
    const title = (res.title as string) ?? 'track';
    const added = (res.added as number) ?? 0;
    const startedNow = res.startedNow as boolean;
    const msg =
      res.kind === 'playlist'
        ? `📋 Queued ${added} track(s) from the playlist.`
        : startedNow
          ? `▶️ Playing “${title}”.`
          : `➕ Queued “${title}”.`;
    return { ok: true, message: msg };
  } catch (err) {
    return { ok: false, message: `❌ ${err instanceof Error ? err.message : 'Failed to play.'}` };
  }
}

/**
 * Run a simple control action (skip/pause/resume/stop/shuffle/volume/loop/remove)
 * against the selected server's player.
 */
export async function controlMusic(
  action: Exclude<MusicAction, 'play'>,
  opts: {
    level?: number;
    mode?: LoopMode;
    position?: number;
    effect?: Effect;
    intensity?: number;
    seconds?: number;
  } = {},
): Promise<MusicActionState> {
  const guildId = await getSelectedGuildId();
  if (!guildId) return { ok: false, message: 'No server selected.' };

  try {
    await sendMusicCommand({ guildId, action, ...opts });
    return { ok: true, message: '' };
  } catch (err) {
    return { ok: false, message: `❌ ${err instanceof Error ? err.message : 'Command failed.'}` };
  }
}
