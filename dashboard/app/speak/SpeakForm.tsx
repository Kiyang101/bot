'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { speak, leaveVoice, previewSpeak, type SpeakState } from '../actions';

interface Channel {
  id: string;
  name: string;
}

interface VoicevoxVoice {
  id: string;
  name: string;
}

// Languages offered by the free Google TTS engine (label → code). Thai first.
const GOOGLE_LANGS: { id: string; name: string }[] = [
  { id: 'th', name: 'Thai ไทย' },
  { id: 'en', name: 'English' },
  { id: 'ja', name: 'Japanese 日本語' },
  { id: 'ko', name: 'Korean 한국어' },
  { id: 'zh-CN', name: 'Chinese 中文' },
  { id: 'vi', name: 'Vietnamese' },
  { id: 'id', name: 'Indonesian' },
  { id: 'fr', name: 'French' },
  { id: 'de', name: 'German' },
  { id: 'es', name: 'Spanish' },
  { id: 'ru', name: 'Russian' },
  { id: 'hi', name: 'Hindi' },
];

export default function SpeakForm({
  channels,
  voicevoxVoices,
}: {
  channels: Channel[];
  voicevoxVoices: VoicevoxVoice[];
}) {
  // Controlled inputs — values stay put across submits.
  const [channelId, setChannelId] = useState('');
  const [text, setText] = useState('');
  const [provider, setProvider] = useState('default');
  const [voice, setVoice] = useState('');
  const [translate, setTranslate] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [pitch, setPitch] = useState(0);

  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<SpeakState | null>(null);

  // "Test" button state — a local-only preview the user hears in the browser.
  const [previewing, setPreviewing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Free the object URL when it's replaced or the component unmounts.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const isVoicevox = provider === 'voicevox';
  const isGoogle = provider === 'google';
  const hasVoiceList = isVoicevox && voicevoxVoices.length > 0;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    // Call the server action directly so React doesn't auto-reset the form.
    e.preventDefault();
    setPending(true);
    setResult(null);
    try {
      const res = await speak({
        channelId,
        text,
        voice,
        provider: provider as 'default' | 'voicevox',
        translate,
        speed,
        pitch,
      });
      setResult(res);
    } catch {
      setResult({ ok: false, message: '❌ Something went wrong sending the request.' });
    } finally {
      setPending(false);
    }
  }

  async function handlePreview() {
    // Synthesize the clip via the bot and play it here only — the bot does NOT
    // join a voice channel. Lets the user audition the voice first.
    setPreviewing(true);
    setResult(null);
    // Drop any previous clip so a failed preview doesn't leave a stale player.
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    try {
      const res = await previewSpeak({
        channelId,
        text,
        voice,
        provider: provider as 'default' | 'voicevox' | 'google',
        translate,
        speed,
        pitch,
      });
      if (res.ok && res.audioBase64) {
        const bytes = Uint8Array.from(atob(res.audioBase64), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: res.contentType || 'audio/mpeg' });
        setPreviewUrl(URL.createObjectURL(blob));
      }
      setResult({ ok: res.ok, message: res.message });
    } catch {
      setResult({ ok: false, message: '❌ Something went wrong generating the preview.' });
    } finally {
      setPreviewing(false);
    }
  }

  async function handleLeave() {
    setPending(true);
    setResult(null);
    try {
      setResult(await leaveVoice());
    } catch {
      setResult({ ok: false, message: '❌ Something went wrong sending the request.' });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <label htmlFor="channelId">Voice channel</label>
      <select id="channelId" required value={channelId} onChange={(e) => setChannelId(e.target.value)}>
        <option value="" disabled>
          — Select a voice channel —
        </option>
        {channels.map((c) => (
          <option key={c.id} value={c.id}>
            🔊 {c.name}
          </option>
        ))}
      </select>

      <label htmlFor="text">Message</label>
      <textarea
        id="text"
        rows={3}
        maxLength={500}
        required
        placeholder="What should the bot say?"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      <label htmlFor="provider">Voice engine</label>
      <select id="provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
        <option value="default">Server default (configured TTS)</option>
        <option value="google">Google TTS (Thai &amp; more, free)</option>
        <option value="voicevox">VOICEVOX (anime, Japanese)</option>
      </select>

      <label htmlFor="voice">{isGoogle ? 'Language' : `Voice / speaker ${hasVoiceList ? '' : '(optional)'}`}</label>
      {isGoogle ? (
        <select id="voice" value={voice || 'th'} onChange={(e) => setVoice(e.target.value)}>
          {GOOGLE_LANGS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      ) : hasVoiceList ? (
        <select id="voice" value={voice} onChange={(e) => setVoice(e.target.value)}>
          <option value="">Default (Zundamon #3)</option>
          {voicevoxVoices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      ) : (
        <input
          id="voice"
          type="text"
          placeholder={
            isVoicevox
              ? 'VOICEVOX speaker id like 3 (start the engine to get a dropdown)'
              : 'e.g. a Gemini voice name'
          }
          value={voice}
          onChange={(e) => setVoice(e.target.value)}
        />
      )}

      {isVoicevox && (
        <div className="sliders">
          <label htmlFor="speed">
            Speed <span className="val">{speed.toFixed(2)}×</span>
          </label>
          <input
            id="speed"
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
          />

          <label htmlFor="pitch">
            Pitch <span className="val">{pitch.toFixed(2)}</span>
          </label>
          <input
            id="pitch"
            type="range"
            min={-0.15}
            max={0.15}
            step={0.01}
            value={pitch}
            onChange={(e) => setPitch(Number(e.target.value))}
          />
        </div>
      )}

      {isVoicevox && (
        <label className="check">
          <input type="checkbox" checked={translate} onChange={(e) => setTranslate(e.target.checked)} />{' '}
          Translate to Japanese first (for VOICEVOX)
        </label>
      )}

      <div className="actions">
        <button type="submit" disabled={pending || previewing}>
          {pending ? 'Speaking…' : 'Speak'}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={pending || previewing || !text.trim()}
          onClick={handlePreview}
          title="Hear it in your browser without sending the bot to a channel"
        >
          {previewing ? 'Testing…' : '🎧 Test'}
        </button>
        <button type="button" className="secondary" disabled={pending || previewing} onClick={handleLeave}>
          Leave channel
        </button>
      </div>

      {result?.message && <p className={`hint ${result.ok ? 'ok' : 'err'}`}>{result.message}</p>}

      {previewUrl && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio className="preview-player" src={previewUrl} controls autoPlay />
      )}
    </form>
  );
}
