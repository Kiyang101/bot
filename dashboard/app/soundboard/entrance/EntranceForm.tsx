'use client';
import { useMemo, useRef, useState } from 'react';
import type { EntrancePreference } from '@/lib/entrance';
import type { EntranceSaveInput } from './actions';

interface Sound { id: string; name: string; durationSec: number | null }
export default function EntranceForm({ preference, sounds, guildName, save, preview, previewSpeech, voicevoxVoices = [], googleVoices = [] }: {
  preference: EntrancePreference; sounds: Sound[]; guildName: string;
  voicevoxVoices?: { id: string; name: string }[]; googleVoices?: { id: string; name: string }[];
  save: (input: EntranceSaveInput) => Promise<{ ok: boolean; message: string }>;
  preview: (soundId: string) => Promise<{ ok: boolean; value?: string; message?: string }>;
  previewSpeech?: () => Promise<{ ok: boolean; value?: string; message?: string }>;
}) {
  const [enabled, setEnabled] = useState(preference.enabled);
  const [soundId, setSoundId] = useState(preference.soundId);
  const [mode, setMode] = useState<'sound' | 'speech'>(preference.mode ?? 'sound');
  const [speechText, setSpeechText] = useState(preference.speechText ?? '');
  const [speechProvider, setSpeechProvider] = useState<'google' | 'voicevox'>(preference.speechProvider ?? 'google');
  const [speechVoice, setSpeechVoice] = useState(preference.speechVoice ?? (preference.speechProvider === 'voicevox' ? '' : 'th'));
  const [savedSpeech, setSavedSpeech] = useState(preference.speechPath ? `${preference.speechText?.trim()}|${preference.speechProvider}|${preference.speechVoice}` : '');
  const [search, setSearch] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const audio = useRef<HTMLAudioElement | null>(null);
  const visible = useMemo(() => sounds.filter((sound) => sound.name.toLowerCase().includes(search.toLowerCase())), [sounds, search]);
  const eligible = (sound: Sound) => sound.durationSec != null && sound.durationSec >= 0.1 && sound.durationSec <= 5;
  async function onPreview() {
    if (mode === 'sound' && !soundId) return;
    const result = mode === 'speech' ? await previewSpeech?.() : await preview(soundId!);
    if (!result) return;
    if (!result.ok || !result.value) { setMessage(result.message ?? 'Preview unavailable.'); return; }
    audio.current?.pause();
    audio.current = new Audio(result.value);
    await audio.current.play().catch(() => setMessage('Preview unavailable.'));
  }
  return <section aria-label={`Entrance settings for ${guildName}`}>
    <h2>Settings for {guildName}</h2>
    <p>Plays when you enter the bot&apos;s current voice channel. Maximum 5 seconds; once per minute. Skipped while other sounds or speech are playing.</p>
    <label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enable my entrance sound</label>
    <p><label>Entrance type <select value={mode} onChange={(event) => setMode(event.target.value as 'sound' | 'speech')}><option value="sound">Soundboard clip</option><option value="speech">Synthesized speech</option></select></label></p>
    {mode === 'sound' ? <>
    <p><label>Search sounds <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search sounds" /></label></p>
    {preference.soundId && !sounds.some((sound) => sound.id === preference.soundId) && <p role="alert">Selected sound is no longer available; choose another sound.</p>}
    {!sounds.some(eligible) && <p>No short sounds available. <a href="/soundboard/manage">Upload or trim a clip</a>.</p>}
    <select aria-label="Entrance sound" value={soundId ?? ''} onChange={(event) => setSoundId(event.target.value || null)}>
      <option value="">Choose a sound</option>
      {visible.map((sound) => <option key={sound.id} value={sound.id} disabled={!eligible(sound)}>{sound.name} {eligible(sound) ? `(${sound.durationSec}s)` : '— requires known duration of 0.1–5 seconds'}</option>)}
    </select>
    </> : <>
      <p>Speech is generated when you save. Saving changed text or voice may use your configured speech provider. Joining voice reuses the saved clip.</p>
      <p><label>Entrance speech <input value={speechText} maxLength={80} onChange={(event) => setSpeechText(event.target.value)} /></label> {speechText.length}/80</p>
      <p><label>Speech provider <select value={speechProvider} onChange={(event) => { const next = event.target.value as 'google' | 'voicevox'; setSpeechProvider(next); setSpeechVoice(next === 'google' ? 'th' : ''); }}><option value="google">Google TTS</option><option value="voicevox">VOICEVOX</option></select></label></p>
      <p><label>{speechProvider === 'google' ? 'Language' : 'Speaker'} <select value={speechVoice} onChange={(event) => setSpeechVoice(event.target.value)}><option value="">Choose a voice</option>{(speechProvider === 'google' ? googleVoices : voicevoxVoices).map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</select></label></p>
      {speechProvider === 'voicevox' && voicevoxVoices.length === 0 && <p>VOICEVOX speakers are unavailable. Start the engine or choose Google TTS.</p>}
    </>}
    <button type="button" onClick={onPreview} disabled={mode === 'sound' ? !soundId : !previewSpeech || savedSpeech !== `${speechText.trim()}|${speechProvider}|${speechVoice}`}>Preview in browser</button>
    <button type="button" disabled={pending || (enabled && (mode === 'sound' ? !soundId : !speechText.trim() || !speechVoice))} onClick={async () => {
      setPending(true);
      try {
        const result = await save(mode === 'sound' ? { enabled, soundId } : { enabled, mode: 'speech', speechText, speechProvider, speechVoice });
        setMessage(result.message);
        if (result.ok && mode === 'speech') setSavedSpeech(`${speechText.trim()}|${speechProvider}|${speechVoice}`);
      } finally { setPending(false); }
    }}>{pending ? 'Saving…' : 'Save'}</button>
    {message && <p role="status">{message}</p>}
    <p><a href="/soundboard/manage">Manage sounds</a></p>
  </section>;
}
