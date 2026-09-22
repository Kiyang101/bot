/** Synchronous ownership of the connection's non-music audio slot. */
type Owner = { kind: 'entrance' | 'sound' | 'speech'; cancel?: () => void };
const owners = new Map<string, Owner>();

export function audioBusy(guildId: string): boolean { return owners.has(guildId); }

export function claimAudio(guildId: string, owner: Owner): boolean {
  if (owners.has(guildId)) return false;
  owners.set(guildId, owner);
  return true;
}

export function claimSpeech(guildId: string, owner: Owner): void {
  const previous = owners.get(guildId);
  owners.set(guildId, owner);
  previous?.cancel?.();
}

export function ownsAudio(guildId: string, owner: Owner): boolean { return owners.get(guildId) === owner; }
export function releaseAudio(guildId: string, owner: Owner): void {
  if (ownsAudio(guildId, owner)) owners.delete(guildId);
}
export type AudioOwner = Owner;
