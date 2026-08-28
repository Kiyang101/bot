import { getSoundPlayableUrl, playSound, stopSound } from './actions';
import Soundboard from './Soundboard';
import { loadSoundboardPageData } from './loader';

export const dynamic = 'force-dynamic';

export default async function SoundboardPage() {
  const data = await loadSoundboardPageData();

  return (
    <Soundboard
      sounds={data.sounds}
      currentUser={data.user}
      selectedGuildId={data.selectedGuildId}
      guildName={data.guildName}
      channels={data.channels}
      initialMusicState={data.musicState}
      botStatus={data.botStatus}
      actions={{ playSound, stopSound, getSoundPlayableUrl }}
    />
  );
}
