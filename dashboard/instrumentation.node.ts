import { runSoundRecoveryWorker } from './lib/sound-recovery-worker';
import { cleanupEntranceSpeech } from './lib/entrance-speech';

export function registerNodeInstrumentation(): void {
  void runSoundRecoveryWorker();
  void cleanupEntranceSpeech().catch(() => {});
  const interval = setInterval(() => {
    void runSoundRecoveryWorker();
    void cleanupEntranceSpeech().catch(() => {});
  }, 60_000);
  interval.unref?.();
}
