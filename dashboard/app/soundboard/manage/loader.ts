import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/session';
import { getSignedSoundUrl, listSounds } from '@/lib/sounds';
import type { SoundRecord } from '@/lib/sound-types';
import type { ManagedSound } from './SoundManager';

function canManageSource(user: { id: string; role: 'admin' | 'member' }, sound: SoundRecord): boolean {
  return user.role === 'admin' || user.id === sound.uploadedById;
}

export async function loadManagementPageData(): Promise<{
  currentUser: { id: string; role: 'admin' | 'member' };
  sounds: ManagedSound[];
}> {
  const user = await getSessionUser({ allowRemoteAdmin: true });
  if (!user) redirect('/login');

  // Sound ownership is global. The selected guild is intentionally absent
  // here; it only becomes relevant when a sound is played in Discord.
  const records = await listSounds();
  const sounds = await Promise.all(records.map(async (record) => {
    const [previewUrl, sourcePreviewUrl] = await Promise.all([
      getSignedSoundUrl(record.storagePath),
      canManageSource(user, record) ? getSignedSoundUrl(record.sourceStoragePath) : Promise.resolve(''),
    ]);
    const { storagePath: _storagePath, sourceStoragePath: _sourceStoragePath, ...clientSound } = record;
    return { ...clientSound, previewUrl, sourcePreviewUrl };
  }));

  return {
    currentUser: { id: user.id, role: user.role },
    sounds,
  };
}
