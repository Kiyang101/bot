import 'server-only';
import { reconcileSoundCleanupTasks, reconcileSoundMutationRecoveries } from './sounds';

let inFlight: Promise<void> | null = null;

export function runSoundRecoveryWorker(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    await reconcileSoundMutationRecoveries(10).catch(() => undefined);
    await reconcileSoundCleanupTasks(10).catch(() => undefined);
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
