import { loadEntranceData, previewEntrance, previewEntranceSpeech, saveEntrance } from './actions';
import EntranceForm from './EntranceForm';
import ServerSelector from '../../ServerSelector';

export const dynamic = 'force-dynamic';

export default async function EntrancePage() {
  try {
    const data = await loadEntranceData();
    return <main className="soundboard-page">
      <header className="soundboard-heading"><div><h1>Personal entrance sound</h1><p>Choose a server to configure your entrance clip.</p></div><a className="secondary" href="/soundboard">Soundboard</a></header>
      {data.guilds.length > 0 ? <ServerSelector guilds={data.guilds} current={data.selectedGuildId ?? ''} destination="/soundboard/entrance" /> : <p>No servers are available for your Discord account.</p>}
      {data.settingsError && <p role="alert">{data.settingsError} Try refreshing or choose another server.</p>}
      {data.preference && data.guildName && <EntranceForm key={data.selectedGuildId} preference={data.preference} sounds={data.sounds} guildName={data.guildName} save={saveEntrance} preview={previewEntrance} previewSpeech={previewEntranceSpeech} voicevoxVoices={data.voicevoxVoices} googleVoices={data.googleVoices} />}
    </main>;
  } catch (error) {
    console.error('[entrance] failed to load server list:', error);
    return <main className="soundboard-page"><h1>Personal entrance sound</h1><p>Could not load the server list. Try refreshing this page.</p><a href="/servers">Server selection</a></main>;
  }
}
