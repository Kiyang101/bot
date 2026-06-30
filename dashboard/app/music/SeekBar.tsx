'use client';

import { useRef, useState, type PointerEvent } from 'react';

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return h > 0
    ? `${h}:${mm}:${String(s).padStart(2, '0')}`
    : `${mm}:${String(s).padStart(2, '0')}`;
}

/**
 * Seek / progress bar with scrubbing.
 *
 * Layers (back to front): full track (unbuffered) → buffer bar → played bar →
 * draggable playhead. Click or drag the bar to scrub; `onSeek` fires on release
 * with the target time in seconds. Livestreams (no duration) show a LIVE chip.
 */
export default function SeekBar({
  positionSec,
  durationSec,
  bufferedSec,
  disabled = false,
  onSeek,
}: {
  positionSec: number;
  durationSec: number | null;
  bufferedSec: number;
  disabled?: boolean;
  onSeek: (sec: number) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [preview, setPreview] = useState(0);

  const live = durationSec == null || durationSec <= 0;
  const dur = durationSec ?? 0;
  const shown = scrubbing ? preview : Math.min(positionSec, dur);

  const pct = (v: number) => (dur > 0 ? Math.max(0, Math.min(100, (v / dur) * 100)) : 0);

  function timeFromEvent(e: PointerEvent<HTMLDivElement>): number {
    const el = barRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(1, ratio)) * dur;
  }

  function onDown(e: PointerEvent<HTMLDivElement>) {
    if (disabled || live) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setScrubbing(true);
    setPreview(timeFromEvent(e));
  }
  function onMove(e: PointerEvent<HTMLDivElement>) {
    if (scrubbing) setPreview(timeFromEvent(e));
  }
  function onUp(e: PointerEvent<HTMLDivElement>) {
    if (!scrubbing) return;
    const target = timeFromEvent(e);
    setScrubbing(false);
    onSeek(target);
  }

  if (live) {
    return (
      <div className="seek">
        <span className="seek-live">🔴 LIVE</span>
      </div>
    );
  }

  return (
    <div className="seek">
      <span className="seek-time">{fmt(shown)}</span>
      <div
        ref={barRef}
        className={`seek-bar${disabled ? ' disabled' : ''}${scrubbing ? ' scrubbing' : ''}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(shown)}
      >
        <div className="seek-buffer" style={{ width: `${pct(bufferedSec)}%` }} />
        <div className="seek-played" style={{ width: `${pct(shown)}%` }} />
        <div className="seek-thumb" style={{ left: `${pct(shown)}%` }} />
      </div>
      <span className="seek-time">{fmt(dur)}</span>
    </div>
  );
}
