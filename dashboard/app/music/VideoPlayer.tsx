'use client';

import { useEffect, useRef, useState } from 'react';

/* Minimal typings for the YouTube IFrame API surface we use. */
interface YTPlayer {
  loadVideoById(opts: { videoId: string; startSeconds?: number }): void;
  unloadModule?(moduleName: string): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setPlaybackQuality?(quality: VideoQuality): void;
  mute(): void;
  unMute(): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  getPlaybackRate(): number;
  setPlaybackRate(rate: number): void;
  getAvailablePlaybackRates(): number[];
  destroy(): void;
}

type VideoQuality =
  | 'default'
  | 'small'
  | 'medium'
  | 'large'
  | 'hd720'
  | 'hd1080'
  | 'hd1440'
  | 'hd2160'
  | 'highres';

const QUALITY_KEY = 'musicVideoQuality';
const QUALITY_OPTIONS: Array<{ value: VideoQuality; label: string }> = [
  { value: 'default', label: 'Auto' },
  { value: 'small', label: '144p' },
  { value: 'medium', label: '360p' },
  { value: 'large', label: '480p' },
  { value: 'hd720', label: '720p' },
  { value: 'hd1080', label: '1080p' },
  { value: 'hd1440', label: '1440p' },
  { value: 'hd2160', label: '2160p / 4K' },
  { value: 'highres', label: 'Highest available' },
];
interface YTNamespace {
  Player: new (el: HTMLElement, opts: unknown) => YTPlayer;
}
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YTNamespace> | null = null;

/** Load the YouTube IFrame API once and resolve when it's ready. */
function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<YTNamespace>((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      if (window.YT) resolve(window.YT);
    };
    if (!document.getElementById('yt-iframe-api')) {
      const s = document.createElement('script');
      s.id = 'yt-iframe-api';
      s.src = 'https://www.youtube.com/iframe_api';
      document.body.appendChild(s);
    }
  });
  return apiPromise;
}

/** Keep captions disabled for this dashboard's muted visual companion player. */
function disableCaptions(player: YTPlayer): void {
  try {
    player.unloadModule?.('captions');
  } catch {
    /* The captions module is not exposed by every YouTube player version. */
  }
}

const PLAYING = 1;
const DRIFT_TOLERANCE = 0.6; // seconds of drift before we re-seek the video
const OFFSET_KEY = 'musicVideoOffset'; // persisted audio-latency offset
const DEFAULT_OFFSET = 0.5; // Discord audio is ~0.5s behind the bot's reported position
const FILL_KEY = 'musicVideoFill'; // persisted zoom-to-fill preference

/**
 * Embeds the current track's YouTube video and keeps it locked to the bot's
 * playback (position, pause state, and speed). The bot is the source of truth;
 * this player only follows. Muted by default since the real audio plays in the
 * Discord voice channel — unmuting here would double up and (under effects)
 * drift out of sync.
 */
export default function VideoPlayer({
  videoId,
  positionSec,
  paused,
  playbackRate,
  onHide,
}: {
  videoId: string | null;
  positionSec: number;
  paused: boolean;
  playbackRate: number;
  onHide: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const readyRef = useRef(false);
  const [muted, setMuted] = useState(true);
  const [quality, setQuality] = useState<VideoQuality>('default');

  useEffect(() => {
    const saved = localStorage.getItem(QUALITY_KEY) as VideoQuality | null;
    if (saved && QUALITY_OPTIONS.some((option) => option.value === saved)) setQuality(saved);
  }, []);

  function changeQuality(next: VideoQuality) {
    setQuality(next);
    localStorage.setItem(QUALITY_KEY, next);
    if (readyRef.current) playerRef.current?.setPlaybackQuality?.(next);
  }

  // Zoom-to-fill (crop to fill the box, vs letterboxed fit) + fullscreen, like
  // the Streaming repo's player. Fill mainly matters in fullscreen on non-16:9
  // screens. The preference is persisted.
  const [fill, setFill] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    setFill(localStorage.getItem(FILL_KEY) === 'fill');
  }, []);
  function toggleFill() {
    setFill((f) => {
      const next = !f;
      localStorage.setItem(FILL_KEY, next ? 'fill' : 'fit');
      return next;
    });
  }
  function toggleFullscreen() {
    const el = hostRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  }
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === hostRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Audio-latency offset: the video target is `botPosition - offset` so it lines
  // up with the (slightly delayed) audio you actually hear in Discord. Tunable
  // and persisted so you can dial in perfect sync once.
  const [offset, setOffset] = useState(DEFAULT_OFFSET);
  useEffect(() => {
    const saved = Number(localStorage.getItem(OFFSET_KEY));
    if (Number.isFinite(saved)) setOffset(saved);
  }, []);
  function adjustOffset(delta: number) {
    setOffset((o) => {
      const next = Math.round((o + delta) * 4) / 4; // snap to 0.25s
      localStorage.setItem(OFFSET_KEY, String(next));
      return next;
    });
  }

  // Latest sync inputs, read by the interval without re-creating it.
  const sync = useRef({ positionSec, paused, playbackRate, offset });
  sync.current = { positionSec, paused, playbackRate, offset };

  /** Where the video should be right now to match the heard audio. */
  const targetTime = () => Math.max(0, sync.current.positionSec - sync.current.offset);

  // Create the player once. YT replaces a child node with its iframe, so we
  // hand it a node we create ourselves (not one React manages) to avoid
  // reconciliation conflicts.
  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;
    const mount = document.createElement('div');
    host.appendChild(mount);

    loadYouTubeApi().then((YT) => {
      if (cancelled) return;
      playerRef.current = new YT.Player(mount, {
        // Privacy-enhanced mode: the embed doesn't carry your YouTube login, so
        // it plays anonymously instead of conflicting with the bot streaming the
        // same account ("account in use on another device").
        host: 'https://www.youtube-nocookie.com',
        width: '100%',
        height: '100%',
        videoId: videoId ?? undefined,
        playerVars: {
          autoplay: 1,
          controls: 0,
          cc_load_policy: 0,
          disablekb: 1,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          vq: quality,
          start: Math.floor(targetTime()),
        },
        events: {
          onReady: (e: { target: YTPlayer }) => {
            readyRef.current = true;
            e.target.mute();
            disableCaptions(e.target);
            e.target.setPlaybackQuality?.(quality);
            e.target.playVideo();
          },
          onApiChange: (e: { target: YTPlayer }) => disableCaptions(e.target),
        },
      });
    });

    return () => {
      cancelled = true;
      readyRef.current = false;
      try {
        playerRef.current?.destroy();
      } catch {
        /* already gone */
      }
      playerRef.current = null;
    };
    // Create once; videoId changes are handled below via loadVideoById.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load a new video when the track changes.
  useEffect(() => {
    const p = playerRef.current;
    if (!p || !readyRef.current || !videoId) return;
    p.loadVideoById({ videoId, startSeconds: Math.floor(sync.current.positionSec) });
    disableCaptions(p);
    p.setPlaybackQuality?.(quality);
    if (muted) p.mute();
    else p.unMute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  // Apply the requested quality after the player is ready and whenever it changes.
  useEffect(() => {
    if (!readyRef.current) return;
    playerRef.current?.setPlaybackQuality?.(quality);
  }, [quality]);

  // Apply mute toggle.
  useEffect(() => {
    const p = playerRef.current;
    if (!p || !readyRef.current) return;
    if (muted) p.mute();
    else p.unMute();
  }, [muted]);

  // Sync loop: match the bot's rate, play/pause, and correct position drift.
  useEffect(() => {
    const id = setInterval(() => {
      const p = playerRef.current;
      if (!p || !readyRef.current) return;
      const s = sync.current;
      try {
        const rates = p.getAvailablePlaybackRates?.() ?? [1];
        const nearest = rates.reduce(
          (best, r) => (Math.abs(r - s.playbackRate) < Math.abs(best - s.playbackRate) ? r : best),
          1,
        );
        if (p.getPlaybackRate() !== nearest) p.setPlaybackRate(nearest);

        const playing = p.getPlayerState() === PLAYING;
        if (s.paused && playing) p.pauseVideo();
        else if (!s.paused && !playing) p.playVideo();

        const target = Math.max(0, s.positionSec - s.offset);
        if (Math.abs(p.getCurrentTime() - target) > DRIFT_TOLERANCE) {
          p.seekTo(target, true);
        }
      } catch {
        /* player not ready for this call yet */
      }
    }, 500);
    return () => clearInterval(id);
  }, []);

  // Re-seek immediately when the offset is changed so tuning feels responsive.
  useEffect(() => {
    const p = playerRef.current;
    if (!p || !readyRef.current) return;
    try {
      p.seekTo(targetTime(), true);
    } catch {
      /* not ready */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset]);

  return (
    <div className="video">
      <div className={`video-frame${fill ? ' fill' : ''}`} ref={hostRef} />
      <div className="video-controls">
        <span className="video-note">
          {muted ? '🔇 Muted — audio plays in Discord' : '🔊 Unmuted (may echo / drift under effects)'}
        </span>
        <span className="nav-spacer" />
        <div className="video-sync" title="Shift the video earlier/later to match the audio you hear">
          <span>Sync</span>
          <button type="button" className="secondary" onClick={() => adjustOffset(0.25)}>
            ◀ video
          </button>
          <span className="sync-val">{offset > 0 ? `+${offset.toFixed(2)}s` : `${offset.toFixed(2)}s`}</span>
          <button type="button" className="secondary" onClick={() => adjustOffset(-0.25)}>
            video ▶
          </button>
        </div>
        <label className="video-quality" title="Requested YouTube video quality">
          Quality
          <select value={quality} onChange={(e) => changeQuality(e.target.value as VideoQuality)}>
            {QUALITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="secondary" onClick={() => setMuted((m) => !m)}>
          {muted ? '🔊 Unmute' : '🔇 Mute'}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={toggleFill}
          title="Zoom to fill (crop) vs fit (letterbox)"
        >
          {fill ? '🔳 Fit' : '🔲 Fill'}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={toggleFullscreen}
          title="Fullscreen"
        >
          {isFullscreen ? '🡼 Exit' : '⛶ Fullscreen'}
        </button>
        <button type="button" className="secondary" onClick={onHide}>
          Hide video
        </button>
      </div>
    </div>
  );
}
