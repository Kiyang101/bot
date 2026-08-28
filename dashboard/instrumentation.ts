export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { runSoundRecoveryWorker } = await import('./lib/sound-recovery-worker');
  void runSoundRecoveryWorker();
  const interval = setInterval(() => void runSoundRecoveryWorker(), 60_000);
  interval.unref?.();
}
