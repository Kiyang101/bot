import { listVoiceChannels } from '@/lib/discord';
import { listVoicevoxSpeakers } from '@/lib/voicevox';
import { getSelectedGuildId } from '@/lib/guild';
import SpeakForm from './SpeakForm';

export const dynamic = 'force-dynamic';

export default async function SpeakPage() {
  const guildId = await getSelectedGuildId();
  const [channels, voicevoxVoices] = await Promise.all([
    listVoiceChannels(guildId).catch(() => []),
    listVoicevoxSpeakers().catch(() => []),
  ]);

  return (
    <main className="speak-page">
      <a className="back-button" href="/servers">← เลือกเซิร์ฟเวอร์</a>
      <h1>Speak</h1>
      <p className="sub">เปลี่ยนข้อความเป็นเสียงพูด ทดลองฟังก่อนส่ง หรือให้ VOICEVOX พูดเป็นภาษาญี่ปุ่น</p>

      <SpeakForm key={guildId ?? "none"} channels={channels} voicevoxVoices={voicevoxVoices} defaultProvider={process.env.AI_TTS_PROVIDER ?? "openai"} />


    </main>
  );
}
