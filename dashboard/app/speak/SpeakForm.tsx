'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { speak, leaveVoice, previewSpeak, type SpeakState, type SpeakInput } from '../actions';

interface Channel { id: string; name: string }
interface VoicevoxVoice { id: string; name: string }

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

export default function SpeakForm({ channels, voicevoxVoices, defaultProvider = '' }: {
  channels: Channel[];
  voicevoxVoices: VoicevoxVoice[];
  defaultProvider?: string;
}) {
  const [channelId, setChannelId] = useState('');
  const [text, setText] = useState('');
  const [provider, setProvider] = useState<NonNullable<SpeakInput['provider']>>('voicevox');
  const [voice, setVoice] = useState('');
  const [translate, setTranslate] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [pitch, setPitch] = useState(0);
  const [operation, setOperation] = useState<'speak' | 'preview' | 'leave' | null>(null);
  const [result, setResult] = useState<SpeakState | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const busy = operation !== null;
  const isVoicevox = provider === 'voicevox' || (provider === 'default' && defaultProvider === 'voicevox');
  const isGoogle = provider === 'google' || (provider === 'default' && defaultProvider === 'googletts');

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  function clearResult() {
    setResult(null);
    setPreviewUrl(null);
  }

  async function run(action: 'speak' | 'preview' | 'leave') {
    if (busy) return;
    setOperation(action);
    clearResult();
    const input: SpeakInput = {
      channelId, text, provider, voice: isGoogle ? voice || 'th' : voice,
      translate: isVoicevox ? translate : undefined,
      speed: isVoicevox ? speed : undefined, pitch: isVoicevox ? pitch : undefined,
    };
    try {
      if (action === 'leave') setResult(await leaveVoice());
      else if (action === 'speak') setResult(await speak(input));
      else {
        const res = await previewSpeak(input);
        if (res.ok && res.audioBase64) {
          const bytes = Uint8Array.from(atob(res.audioBase64), (c) => c.charCodeAt(0));
          setPreviewUrl(URL.createObjectURL(new Blob([bytes], { type: res.contentType || 'audio/mpeg' })));
        }
        setResult(res);
      }
    } catch {
      setResult({ ok: false, message: 'ส่งคำขอไม่สำเร็จ กรุณาลองอีกครั้ง' });
    } finally { setOperation(null); }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run('speak');
  }

  return (
    <form className="speak-form" onSubmit={handleSubmit} aria-busy={busy}>
      <fieldset disabled={busy} className="speak-fields">
        <div className="speak-grid">
          <section className="speak-compose" aria-labelledby="compose-title">
            <h2 id="compose-title"><span className="speak-step">1</span> เขียนข้อความ</h2>
            <label htmlFor="text">ข้อความที่ต้องการให้บอทพูด</label>
            <textarea id="text" rows={7} maxLength={500} required value={text}
              placeholder="เช่น สวัสดีทุกคน วันนี้มาเล่นเกมด้วยกันไหม"
              aria-describedby="message-help"
              onChange={(e) => { setText(e.target.value); clearResult(); }} />
            <div className="speak-meta" id="message-help">
              <span>{isVoicevox && translate ? 'พิมพ์ไทยหรืออังกฤษ แล้วแปลเป็นญี่ปุ่นให้อัตโนมัติ' : 'ข้อความจะถูกอ่านตามที่พิมพ์'}</span>
              <span>{text.length}/500</span>
            </div>
            {isVoicevox && <div className="speak-reading">
              <label htmlFor="reading">การอ่านภาษาญี่ปุ่น</label>
              <select id="reading" value={translate ? 'translate' : 'raw'} onChange={(e) => { setTranslate(e.target.value === 'translate'); clearResult(); }}>
                <option value="translate">แปลเป็นญี่ปุ่นก่อนอ่าน (แนะนำ)</option>
                <option value="raw">อ่านตามที่พิมพ์ — สำหรับข้อความญี่ปุ่น</option>
              </select>
              <p className="hint">{translate ? 'ระบบจะแสดงข้อความภาษาญี่ปุ่นหลังทดลองฟังหรือส่งเสียง' : 'VOICEVOX อ่านภาษาญี่ปุ่น หากพิมพ์ไทยหรืออังกฤษ แนะนำให้เปิดการแปล'}</p>
            </div>}
          </section>
          <section className="speak-settings" aria-labelledby="voice-title">
            <h2 id="voice-title"><span className="speak-step">2</span> เลือกเสียง</h2>
            <label htmlFor="provider">เอนจินเสียง</label>
            <select id="provider" value={provider} onChange={(e) => {
              setProvider(e.target.value as NonNullable<SpeakInput['provider']>);
              setVoice(''); clearResult();
            }}>
              <option value="voicevox">VOICEVOX · เสียงตัวละครญี่ปุ่น</option>
              <option value="google">Google TTS · ภาษาไทยและภาษาอื่น</option>
              <option value="default">ค่าเริ่มต้นของเซิร์ฟเวอร์{defaultProvider ? ` · ${defaultProvider}` : ''}</option>
            </select>
            <label htmlFor="voice">{isGoogle ? 'ภาษาที่อ่าน' : 'เสียง / ตัวละคร'}</label>
            {isGoogle ? <select id="voice" value={voice || 'th'} onChange={(e) => { setVoice(e.target.value); clearResult(); }}>
              {GOOGLE_LANGS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select> : isVoicevox && voicevoxVoices.length > 0 ?
              <select id="voice" value={voice} onChange={(e) => { setVoice(e.target.value); clearResult(); }}>
                <option value="">เสียงเริ่มต้นของเซิร์ฟเวอร์</option>
                {voicevoxVoices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select> : <input id="voice" type="text" value={voice} pattern={isVoicevox ? '[0-9]*' : undefined}
                inputMode={isVoicevox ? 'numeric' : 'text'} placeholder={isVoicevox ? 'Speaker ID เช่น 3 (เว้นว่างใช้ค่าเริ่มต้น)' : 'ชื่อเสียง (ไม่บังคับ)'}
                onChange={(e) => { setVoice(e.target.value); clearResult(); }} />}
            {isVoicevox && voicevoxVoices.length === 0 && <p className="speak-notice" role="status">โหลดรายชื่อเสียงไม่ได้ ตรวจสอบว่าเปิด VOICEVOX แล้ว จากนั้นรีเฟรชหน้า หรือระบุ Speaker ID เพื่อทดลองฟัง</p>}
            {isGoogle && <p className="hint">เลือกภาษาให้ตรงกับข้อความ ระบบจะอ่านโดยไม่แปลภาษา</p>}
            {isVoicevox && <details className="speak-tuning">
              <summary>ปรับความเร็วและระดับเสียง</summary>
              <div className="sliders">
                <label htmlFor="speed">ความเร็ว <span className="val">{speed.toFixed(2)}×</span></label>
                <input id="speed" type="range" min={0.5} max={2} step={0.05} value={speed} onChange={(e) => { setSpeed(Number(e.target.value)); clearResult(); }} />
                <label htmlFor="pitch">ระดับเสียง <span className="val">{pitch.toFixed(2)}</span></label>
                <input id="pitch" type="range" min={-0.15} max={0.15} step={0.01} value={pitch} onChange={(e) => { setPitch(Number(e.target.value)); clearResult(); }} />
                <button type="button" className="secondary" onClick={() => { setSpeed(1); setPitch(0); clearResult(); }}>คืนค่าเสียง</button>
              </div>
            </details>}
          </section>
        </div>
        <section className="speak-delivery" aria-labelledby="delivery-title">
          <h2 id="delivery-title"><span className="speak-step">3</span> ทดลองฟัง แล้วส่งเข้าห้อง</h2>
          <label htmlFor="channelId">ห้องเสียงปลายทาง</label>
          <select id="channelId" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            <option value="">🎙️ ห้องเสียงที่ฉันอยู่ (อัตโนมัติ)</option>
            {channels.map((c) => <option key={c.id} value={c.id}>🔊 {c.name}</option>)}
          </select>
          {channels.length === 0 && <p className="speak-notice">ไม่พบห้องเสียงให้เลือก หากคุณอยู่ในห้องเสียงอยู่แล้ว สามารถลองส่งแบบอัตโนมัติได้</p>}
          <div className="actions">
            <button type="button" className="secondary" disabled={!text.trim() || (isVoicevox && !!voice && !/^\d+$/.test(voice))} onClick={() => void run('preview')}>
              {operation === 'preview' ? 'กำลังสร้างเสียง…' : 'ทดลองฟัง'}</button>
            <button type="submit" disabled={!text.trim()}>{operation === 'speak' ? 'กำลังส่งเสียง…' : 'ส่งเสียงเข้าห้อง'}</button>
            <button type="button" className="secondary speak-leave" onClick={() => void run('leave')}>{operation === 'leave' ? 'กำลังออก…' : 'ให้บอทออกจากห้อง'}</button>
          </div>
          <p className="hint">บอทจะเข้าห้องที่คุณอยู่โดยอัตโนมัติ หรือเลือกห้องอื่นจากรายการ • ทดลองฟังได้เฉพาะคุณ</p>
        </section>
      </fieldset>
      <div aria-live="polite" aria-atomic="true">
        {result && <div className={`speak-result ${result.ok ? 'ok' : 'err'}`} role={result.ok ? 'status' : 'alert'}>
          <p>{result.message}</p>
          {result.spoken && <><span className="muted">ข้อความที่อ่านจริง</span><p className="speak-spoken" lang={isVoicevox ? 'ja' : undefined}>{result.spoken}</p></>}
        </div>}
      </div>
      {previewUrl && <audio className="preview-player" aria-label="เสียงตัวอย่าง" src={previewUrl} controls autoPlay />}
    </form>
  );
}
