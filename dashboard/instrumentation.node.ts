import { runSoundRecoveryWorker } from './lib/sound-recovery-worker';

export function registerNodeInstrumentation(): void {
  void runSoundRecoveryWorker();
  const interval = setInterval(() => void runSoundRecoveryWorker(), 60_000);
  interval.unref?.();
}
