import { redirect } from 'next/navigation';
import { getSoundboardSessionUser } from '@/lib/session';
import { getSignedSoundUrl, listSounds } from '@/lib/sounds';
import type { SoundRecord } from '@/lib/sound-types';
import type { ManagedSound } from './SoundManager';

export async function loadManagementPageData(): Promise<{
  currentUser: { id: string; role: 'admin' | 'member' };
  sounds: ManagedSound[];
}> {
  const user = await getSoundboardSessionUser();
  if (!user) redirect('/login');

  // Sound ownership is global. The selected guild is intentionally absent
  // here; it only becomes relevant when a sound is played in Discord.
  const records = await listSounds();
  const sounds = await Promise.all(records.map(async (record) => {
    const previewUrl = await getSignedSoundUrl(record.storagePath);
    const { storagePath: _storagePath, sourceStoragePath: _sourceStoragePath, ...clientSound } = record;
    return { ...clientSound, previewUrl, sourcePreviewUrl: null };
  }));

  return {
    currentUser: { id: user.id, role: user.role },
    sounds,
  };
}
