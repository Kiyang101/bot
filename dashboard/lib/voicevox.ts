// Server-only helper to list the speakers in the local VOICEVOX engine, so the
// Speak page can offer a voice dropdown instead of a free-text speaker id.
const VOICEVOX_URL = process.env.VOICEVOX_URL ?? 'http://127.0.0.1:50021';

export interface VoicevoxVoice {
  name: string; // e.g. "ずんだもん (ノーマル) #3"
  id: string; // engine speaker id, as a string
}

interface VoicevoxSpeaker {
  name: string;
  styles: Array<{ name: string; id: number; type?: string }>;
}

/** Fetch & flatten the engine's speakers into one entry per talk style. */
export async function listVoicevoxSpeakers(): Promise<VoicevoxVoice[]> {
  const root = VOICEVOX_URL.replace(/\/+$/, '');
  const res = await fetch(`${root}/speakers`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`VOICEVOX /speakers HTTP ${res.status}`);

  const data = (await res.json()) as VoicevoxSpeaker[];
  const out: VoicevoxVoice[] = [];
  for (const sp of data) {
    for (const st of sp.styles) {
      if (st.type && st.type !== 'talk') continue;
      out.push({ name: `${sp.name} (${st.name}) #${st.id}`, id: String(st.id) });
    }
  }
  return out;
}
