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
    <main>
      <a className="back-button" href="/servers">← Select server</a>
      <h1>Speak</h1>
      <p className="sub">Type a message and the bot will say it out loud in a voice channel.</p>

      <SpeakForm channels={channels} voicevoxVoices={voicevoxVoices} />

      <p className="hint">
        {channels.length === 0
          ? 'No voice channels found — check the bot token / that the bot is in the server.'
          : `${channels.length} voice channels available. The bot joins the channel you pick and speaks.`}
      </p>
    </main>
  );
}
