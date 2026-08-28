import {
  deleteSound,
  getSoundPlayableUrl,
  getSoundSourceUrl,
  reorderSounds,
  trimSound,
  updateSound,
  uploadSound,
} from '../actions';
import SoundManager from './SoundManager';
import { loadManagementPageData } from './loader';

export const dynamic = 'force-dynamic';

export default async function SoundManagementPage() {
  const data = await loadManagementPageData();

  return (
    <main className="sound-manage-page">
      <a className="back-button" href="/soundboard">← Back to soundboard</a>
      <SoundManager
        initialSounds={data.sounds}
        currentUser={data.currentUser}
        actions={{
          deleteSound,
          getSoundPlayableUrl,
          getSoundSourceUrl,
          reorderSounds,
          trimSound,
          updateSound,
          uploadSound,
        }}
      />
    </main>
  );
}
