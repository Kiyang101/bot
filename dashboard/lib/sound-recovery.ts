export type UploadRecoveryState = 'uploading' | 'cleanup_pending';
export type UploadRecoveryResolution = 'row_committed' | 'objects_absent' | 'defer';

export interface UploadRecoveryCandidate {
  state: UploadRecoveryState;
  nextAttemptAt: string;
  leaseExpiresAt: string;
}

/** Keeps the consumer from considering an active upload before row insertion. */
export function isUploadRecoveryCandidate(candidate: UploadRecoveryCandidate, nowMs: number): boolean {
  if (new Date(candidate.nextAttemptAt).getTime() > nowMs) return false;
  return candidate.state === 'cleanup_pending'
    || new Date(candidate.leaseExpiresAt).getTime() <= nowMs;
}

/** Chooses a terminal outcome only after the caller has checked its evidence. */
export function resolveUploadRecovery(input: {
  hasSoundRow: boolean;
  soundPathsMatch: boolean;
  sourceAbsent: boolean;
  playableAbsent: boolean;
}): UploadRecoveryResolution {
  if (input.hasSoundRow && input.soundPathsMatch && !input.sourceAbsent && !input.playableAbsent) {
    return 'row_committed';
  }
  if (!input.hasSoundRow && input.sourceAbsent && input.playableAbsent) {
    return 'objects_absent';
  }
  return 'defer';
}
