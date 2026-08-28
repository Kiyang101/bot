'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { MIN_CLIP_LENGTH_MS } from '@/lib/sound-validation';

const MAX_WAVEFORM_BARS = 160;
const KEYBOARD_STEP_MS = 100;

export interface TrimRange {
  startMs: number;
  endMs: number;
  durationMs: number;
}

interface WaveformEditorProps {
  source: Blob | string;
  initialStartMs?: number;
  initialEndMs?: number;
  disabled?: boolean;
  onRangeChange: (range: TrimRange) => void;
}

type ActiveHandle = 'start' | 'end';

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(Math.round(value), minimum), maximum);
}

async function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the selected audio file.'));
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  });
}

function downsample(channelData: Float32Array): number[] {
  const barCount = Math.min(MAX_WAVEFORM_BARS, Math.max(1, channelData.length));
  const samplesPerBar = channelData.length / barCount;
  const bars: number[] = [];
  for (let barIndex = 0; barIndex < barCount; barIndex += 1) {
    const firstSample = Math.floor(barIndex * samplesPerBar);
    const lastSample = Math.max(firstSample + 1, Math.floor((barIndex + 1) * samplesPerBar));
    let peak = 0;
    for (let sampleIndex = firstSample; sampleIndex < lastSample && sampleIndex < channelData.length; sampleIndex += 1) {
      peak = Math.max(peak, Math.abs(channelData[sampleIndex] ?? 0));
    }
    bars.push(Math.max(0.08, peak));
  }
  return bars;
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(2)} s`;
}

export default function WaveformEditor({
  source,
  initialStartMs = 0,
  initialEndMs,
  disabled = false,
  onRangeChange,
}: WaveformEditorProps) {
  const [bars, setBars] = useState<number[]>([]);
  const [durationMs, setDurationMs] = useState(0);
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(0);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const activeHandleRef = useRef<ActiveHandle | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    let audioContext: AudioContext | null = null;

    async function decodeSource() {
      setLoading(true);
      setDecodeError(null);
      setPreviewError(null);
      try {
        const blob = typeof source === 'string'
          ? await fetch(source).then((response) => {
              if (!response.ok) throw new Error('The source audio could not be loaded.');
              return response.blob();
            })
          : source;
        const bytes = await readBlob(blob);
        audioContext = new AudioContext();
        const decoded = await audioContext.decodeAudioData(bytes.slice(0));
        if (cancelled) return;

        const decodedDurationMs = Math.round(decoded.duration * 1_000);
        if (!Number.isFinite(decoded.duration) || decoded.duration * 1_000 < MIN_CLIP_LENGTH_MS) {
          throw new Error(`Sound clips must be at least ${MIN_CLIP_LENGTH_MS} ms long.`);
        }
        const nextStartMs = clamp(initialStartMs, 0, decodedDurationMs - MIN_CLIP_LENGTH_MS);
        const requestedEndMs = initialEndMs ?? decodedDurationMs;
        const nextEndMs = clamp(requestedEndMs, nextStartMs + MIN_CLIP_LENGTH_MS, decodedDurationMs);
        objectUrl = URL.createObjectURL(blob);
        setBars(downsample(decoded.getChannelData(0)));
        setDurationMs(decodedDurationMs);
        setStartMs(nextStartMs);
        setEndMs(nextEndMs);
        setLocalUrl(objectUrl);
      } catch (decodeError) {
        if (!cancelled) {
          setDecodeError(decodeError instanceof Error ? decodeError.message : 'The waveform could not be generated.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void decodeSource();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      void audioContext?.close();
    };
  }, [initialEndMs, initialStartMs, source]);

  useEffect(() => {
    if (durationMs > 0) onRangeChange({ startMs, endMs, durationMs });
  }, [durationMs, endMs, onRangeChange, startMs]);

  const stopPreview = useCallback(() => {
    const audio = previewAudioRef.current;
    if (audio) {
      audio.pause();
      previewAudioRef.current = null;
    }
    setPreviewing(false);
  }, []);

  useEffect(() => stopPreview, [stopPreview]);

  const setHandlePosition = useCallback((handle: ActiveHandle, rawValueMs: number) => {
    if (handle === 'start') {
      setStartMs(clamp(rawValueMs, 0, endMs - MIN_CLIP_LENGTH_MS));
    } else {
      setEndMs(clamp(rawValueMs, startMs + MIN_CLIP_LENGTH_MS, durationMs));
    }
  }, [durationMs, endMs, startMs]);

  function positionFromPointer(event: PointerEvent<HTMLDivElement>): number {
    const bounds = trackRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return 0;
    return ((event.clientX - bounds.left) / bounds.width) * durationMs;
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!activeHandleRef.current || disabled) return;
    setHandlePosition(activeHandleRef.current, positionFromPointer(event));
  }

  function handleKeyDown(handle: ActiveHandle, event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    const currentValue = handle === 'start' ? startMs : endMs;
    let nextValue: number | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') nextValue = currentValue - KEYBOARD_STEP_MS;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') nextValue = currentValue + KEYBOARD_STEP_MS;
    if (event.key === 'Home') nextValue = handle === 'start' ? 0 : startMs + MIN_CLIP_LENGTH_MS;
    if (event.key === 'End') nextValue = handle === 'start' ? endMs - MIN_CLIP_LENGTH_MS : durationMs;
    if (nextValue === null) return;
    event.preventDefault();
    setHandlePosition(handle, nextValue);
  }

  async function previewSelection() {
    if (!localUrl || disabled) return;
    setPreviewError(null);
    if (previewing) {
      stopPreview();
      return;
    }
    const audio = new Audio(localUrl);
    const stopAtBoundary = () => {
      if (audio.currentTime * 1_000 >= endMs) stopPreview();
    };
    audio.currentTime = startMs / 1_000;
    audio.addEventListener('timeupdate', stopAtBoundary);
    audio.addEventListener('ended', stopPreview);
    previewAudioRef.current = audio;
    setPreviewing(true);
    try {
      await audio.play();
    } catch {
      stopPreview();
      setPreviewError('Preview could not start. Check your browser audio settings.');
    }
  }

  if (loading) return <p className="waveform-status" aria-live="polite">Generating waveform…</p>;
  if (decodeError) return <p className="sound-error" role="alert">{decodeError}</p>;

  const startPercent = durationMs ? (startMs / durationMs) * 100 : 0;
  const endPercent = durationMs ? (endMs / durationMs) * 100 : 100;

  return (
    <section className="waveform-editor" aria-label="Trim sound">
      <div
        ref={trackRef}
        className="waveform-track"
        aria-label="Audio waveform"
        onPointerMove={handlePointerMove}
        onPointerUp={() => { activeHandleRef.current = null; }}
        onPointerCancel={() => { activeHandleRef.current = null; }}
      >
        <div className="waveform-bars" aria-hidden="true">
          {bars.map((amplitude, index) => (
            <span
              className="waveform-bar"
              data-testid="waveform-bar"
              key={index}
              style={{ '--bar-amplitude': amplitude } as CSSProperties}
            />
          ))}
        </div>
        <span
          className="waveform-selection"
          aria-hidden="true"
          style={{ left: `${startPercent}%`, width: `${endPercent - startPercent}%` }}
        />
        <button
          type="button"
          role="slider"
          className="waveform-handle waveform-handle-start"
          aria-label="Trim start"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, endMs - MIN_CLIP_LENGTH_MS)}
          aria-valuenow={startMs}
          aria-valuetext={formatSeconds(startMs)}
          disabled={disabled}
          style={{ left: `${startPercent}%` }}
          onPointerDown={(event) => {
            activeHandleRef.current = 'start';
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onKeyDown={(event) => handleKeyDown('start', event)}
        />
        <button
          type="button"
          role="slider"
          className="waveform-handle waveform-handle-end"
          aria-label="Trim end"
          aria-valuemin={Math.min(durationMs, startMs + MIN_CLIP_LENGTH_MS)}
          aria-valuemax={durationMs}
          aria-valuenow={endMs}
          aria-valuetext={formatSeconds(endMs)}
          disabled={disabled}
          style={{ left: `${endPercent}%` }}
          onPointerDown={(event) => {
            activeHandleRef.current = 'end';
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onKeyDown={(event) => handleKeyDown('end', event)}
        />
      </div>
      <div className="waveform-footer">
        <span className="waveform-time">{formatSeconds(endMs - startMs)} selected</span>
        <button type="button" className={previewing ? 'preview-active' : 'secondary'} onClick={() => void previewSelection()} disabled={disabled}>
          {previewing ? 'Stop preview' : 'Preview selection'}
        </button>
      </div>
      {previewError && <p className="sound-error waveform-preview-error" role="alert">{previewError}</p>}
    </section>
  );
}
