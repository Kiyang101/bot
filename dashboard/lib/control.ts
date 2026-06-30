// Server-only client for the bot's local control endpoint (src/control/server.ts).
// The bot exposes this on 127.0.0.1; the dashboard's server actions call it to
// make the bot speak. Never import this into a client component.

const CONTROL_URL = process.env.BOT_CONTROL_URL ?? 'http://127.0.0.1:8787';
const CONTROL_SECRET = process.env.BOT_CONTROL_SECRET ?? '';

export interface SpeakPayload {
  channelId: string;
  text: string;
  voice?: string;
  provider?: 'default' | 'voicevox' | 'google';
  translate?: boolean;
  speed?: number;
  pitch?: number;
}

/** Ask the bot to speak. Returns the spoken text, or throws with the bot's error. */
export async function sendSpeak(payload: SpeakPayload): Promise<{ spoken: string }> {
  let res: Response;
  try {
    res = await fetch(`${CONTROL_URL}/speak`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-control-secret': CONTROL_SECRET,
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
  } catch {
    throw new Error(
      `Could not reach the bot at ${CONTROL_URL}. Make sure the bot is running and BOT_CONTROL_PORT matches.`,
    );
  }

  const data = (await res.json().catch(() => ({}))) as { spoken?: string; error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `Bot returned HTTP ${res.status}`);
  }
  return { spoken: data.spoken ?? payload.text };
}

/** A preview request — same shape as a speak, minus the voice channel. */
export type PreviewPayload = Omit<SpeakPayload, 'channelId'>;

export interface PreviewResult {
  audio: ArrayBuffer;
  contentType: string;
  /** The (possibly translated) text that was spoken. */
  spoken: string;
}

/**
 * Ask the bot to synthesize a clip WITHOUT joining a voice channel, so the
 * dashboard can play it in the browser. Returns the raw audio bytes, or throws
 * with the bot's error.
 */
export async function sendPreview(payload: PreviewPayload): Promise<PreviewResult> {
  let res: Response;
  try {
    res = await fetch(`${CONTROL_URL}/preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-control-secret': CONTROL_SECRET,
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
  } catch {
    throw new Error(
      `Could not reach the bot at ${CONTROL_URL}. Make sure the bot is running and BOT_CONTROL_PORT matches.`,
    );
  }

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Bot returned HTTP ${res.status}`);
  }

  const audio = await res.arrayBuffer();
  const contentType = res.headers.get('Content-Type') ?? 'audio/mpeg';
  const spoken = decodeURIComponent(res.headers.get('x-spoken') ?? '');
  return { audio, contentType, spoken };
}

// ─── Music player ────────────────────────────────────────────────────────────

export type LoopMode = 'off' | 'track' | 'queue';

export type Effect = 'off' | 'nightcore' | 'vaporwave' | 'bassboost' | 'treble' | '8d';

export const EFFECT_LABELS: Record<Effect, string> = {
  off: 'Off',
  nightcore: 'Nightcore',
  vaporwave: 'Vaporwave',
  bassboost: 'Bass Boost',
  treble: 'Treble',
  '8d': '8D Audio',
};

export interface MusicTrack {
  title: string;
  url: string;
  durationSec: number | null;
  thumbnail: string | null;
  uploader: string | null;
  requestedById: string;
  requestedByTag: string;
}

export interface MusicState {
  current: MusicTrack | null;
  queue: MusicTrack[];
  loop: LoopMode;
  effect: Effect;
  intensity: number;
  volume: number;
  positionSec: number;
  playbackRate: number;
  paused: boolean;
  channelName: string | null;
}

export type MusicAction =
  | 'play'
  | 'skip'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'shuffle'
  | 'volume'
  | 'loop'
  | 'remove'
  | 'jump'
  | 'effect'
  | 'intensity'
  | 'seek';

export interface MusicCommand {
  guildId: string;
  action: MusicAction;
  channelId?: string;
  query?: string;
  level?: number;
  mode?: LoopMode;
  position?: number;
  effect?: Effect;
  intensity?: number;
  seconds?: number;
}

/** Fetch the live player state for a guild (polled by the dashboard). */
export async function getMusicState(guildId: string): Promise<MusicState> {
  let res: Response;
  try {
    res = await fetch(`${CONTROL_URL}/music/state?guildId=${encodeURIComponent(guildId)}`, {
      headers: { 'x-control-secret': CONTROL_SECRET },
      cache: 'no-store',
    });
  } catch {
    throw new Error(`Could not reach the bot at ${CONTROL_URL}. Is it running?`);
  }
  const data = (await res.json().catch(() => ({}))) as { state?: MusicState; error?: string };
  if (!res.ok || !data.state) {
    throw new Error(data.error ?? `Bot returned HTTP ${res.status}`);
  }
  return data.state;
}

/** Send a music command to the bot. Returns the bot's JSON result. */
export async function sendMusicCommand(
  cmd: MusicCommand,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${CONTROL_URL}/music`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-control-secret': CONTROL_SECRET },
      body: JSON.stringify(cmd),
      cache: 'no-store',
    });
  } catch {
    throw new Error(`Could not reach the bot at ${CONTROL_URL}. Is it running?`);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
  if (!res.ok) {
    throw new Error((data.error as string) ?? `Bot returned HTTP ${res.status}`);
  }
  return data;
}

/** Ask the bot to leave the voice channel in the given guild. */
export async function sendLeave(guildId: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${CONTROL_URL}/leave`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-control-secret': CONTROL_SECRET,
      },
      body: JSON.stringify({ guildId }),
      cache: 'no-store',
    });
  } catch {
    throw new Error(`Could not reach the bot at ${CONTROL_URL}. Make sure the bot is running.`);
  }

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Bot returned HTTP ${res.status}`);
  }
}
