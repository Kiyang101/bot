'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  playMusic,
  controlMusic,
  clearMusicHistory,
  fetchMusicState,
  fetchMusicHistory,
  type MusicActionState,
  type MusicHistoryItem,
} from '../actions';
import { EFFECT_LABELS, type MusicState, type LoopMode, type Effect } from '@/lib/control';
import SeekBar from './SeekBar';
import VideoPlayer from './VideoPlayer';

interface Channel {
  id: string;
  name: string;
}

/** Pull the YouTube video id out of a watch / youtu.be / shorts URL. */
function parseVideoId(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    if (u.hostname === 'youtu.be') return u.pathname.slice(1) || null;
    const m = u.pathname.match(/\/(?:shorts|embed)\/([^/?]+)/);
    if (m) return m[1];
  } catch {
    /* not a URL */
  }
  return null;
}

function fmt(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return 'LIVE';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}

const LOOP_LABEL: Record<LoopMode, string> = {
  off: 'Loop: Off',
  track: 'Loop: Track 🔂',
  queue: 'Loop: Queue 🔁',
};

export default function MusicPlayer({
  channels,
  initialState,
  initialHistory,
  isAdmin,
}: {
  channels: Channel[];
  initialState: MusicState;
  initialHistory: MusicHistoryItem[];
  isAdmin: boolean;
}) {
  const [channelId, setChannelId] = useState(channels[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [state, setState] = useState<MusicState>(initialState);
  const [history, setHistory] = useState<MusicHistoryItem[]>(initialHistory);
  const [volume, setVolume] = useState(initialState.volume);
  const [intensity, setIntensity] = useState(initialState.intensity);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<MusicActionState | null>(null);
  const [showVideo, setShowVideo] = useState(true);

  // Smoothly-interpolated playback position (the bot only reports every poll).
  const [displayPos, setDisplayPos] = useState(initialState.positionSec);
  const posRef = useRef({ base: initialState.positionSec, at: Date.now() });

  const draggingVolume = useRef(false);
  const draggingIntensity = useRef(false);

  // Re-anchor the interpolation clock from a fresh server snapshot.
  function syncFromState(s: MusicState) {
    setState(s);
    if (!draggingVolume.current) setVolume(s.volume);
    if (!draggingIntensity.current) setIntensity(s.intensity);
    posRef.current = { base: s.positionSec, at: Date.now() };
    setDisplayPos(s.positionSec);
  }

  // Poll live state every 3s so the queue / now-playing stay current.
  useEffect(() => {
    let active = true;
    async function refresh() {
      const s = await fetchMusicState();
      if (active && s) syncFromState(s);
    }
    const id = setInterval(refresh, 3000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  // Refresh history with the same cadence as the live player state. This also
  // picks up queued tracks when they actually start playing in the bot.
  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const items = await fetchMusicHistory();
        if (active) setHistory(items);
      } catch {
        // Keep showing the last known history if the dashboard briefly loses
        // database connectivity.
      }
    }
    const id = setInterval(refresh, 3000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  // Advance the playhead ~4×/sec between polls so it moves smoothly. Scale by
  // the effect's playback rate so the position stays accurate under nightcore /
  // vaporwave (content time moves faster/slower than wall-clock).
  useEffect(() => {
    const dur = state.current?.durationSec ?? null;
    const rate = state.playbackRate || 1;
    const id = setInterval(() => {
      const { base, at } = posRef.current;
      const next = state.paused ? base : base + ((Date.now() - at) / 1000) * rate;
      setDisplayPos(dur != null ? Math.min(next, dur) : next);
    }, 250);
    return () => clearInterval(id);
  }, [state.paused, state.playbackRate, state.current?.durationSec]);

  // Pull fresh state immediately after an action for a snappy UI.
  async function refreshNow() {
    const s = await fetchMusicState();
    if (s) syncFromState(s);
  }

  async function refreshHistory() {
    try {
      const items = await fetchMusicHistory();
      setHistory(items);
    } catch {
      // A history refresh should not make an already-successful play request
      // look like it failed.
    }
  }

  async function handleClearHistory() {
    if (!window.confirm('Clear all music history for this server? This cannot be undone.')) return;

    setPending(true);
    setResult(null);
    try {
      const res = await clearMusicHistory();
      setResult(res);
      if (res.ok) setHistory([]);
    } catch {
      setResult({ ok: false, message: '❌ Something went wrong clearing music history.' });
    } finally {
      setPending(false);
    }
  }

  // Seek: optimistically jump the playhead, then tell the bot.
  async function handleSeek(sec: number) {
    posRef.current = { base: sec, at: Date.now() };
    setDisplayPos(sec);
    await control('seek', { seconds: Math.round(sec) });
  }

  async function handlePlay(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setResult(null);
    try {
      const res = await playMusic(channelId, query);
      setResult(res);
      if (res.ok) {
        setQuery('');
        await refreshHistory();
      }
      await refreshNow();
    } catch {
      setResult({ ok: false, message: '❌ Something went wrong sending the request.' });
    } finally {
      setPending(false);
    }
  }

  async function handleHistoryPlay(item: MusicHistoryItem) {
    setPending(true);
    setResult(null);
    try {
      const res = await playMusic(channelId, item.url);
      setResult(res);
      if (res.ok) await refreshHistory();
      await refreshNow();
    } catch {
      setResult({ ok: false, message: '❌ Something went wrong sending the request.' });
    } finally {
      setPending(false);
    }
  }

  async function control(
    action: Parameters<typeof controlMusic>[0],
    opts?: Parameters<typeof controlMusic>[1],
  ) {
    setPending(true);
    try {
      const res = await controlMusic(action, opts);
      if (!res.ok) setResult(res);
      await refreshNow();
    } finally {
      setPending(false);
    }
  }

  const np = state.current;
  const isPlaying = !!np;

  // The bot streams server-side, so there's no real client buffer. We show an
  // indicative read-ahead window past the playhead for the familiar look.
  const dur = np?.durationSec ?? 0;
  const bufferedSec = dur > 0 ? Math.min(dur, displayPos + Math.max(10, dur * 0.12)) : 0;
  const videoId = parseVideoId(np?.url);

  return (
    <div className="music-layout">
      <div className="music">
      {/* Add to queue */}
      <form className="music-add" onSubmit={handlePlay}>
        <div className="row">
          <select value={channelId} required onChange={(e) => setChannelId(e.target.value)}>
            <option value="" disabled>
              — Voice channel —
            </option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                🔊 {c.name}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Song, YouTube/Spotify URL, or liked"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={500}
          />
          <button type="submit" disabled={pending}>
            {pending ? '…' : 'Play'}
          </button>
        </div>
        {result?.message && <p className={`hint ${result.ok ? 'ok' : 'err'}`}>{result.message}</p>}
      </form>

      {/* Now playing */}
      <div className="np-card">
        {np?.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="np-thumb" src={np.thumbnail} alt="" />
        ) : (
          <div className="np-thumb placeholder">🎵</div>
        )}
        <div className="np-info">
          {isPlaying ? (
            <>
              <div className="np-status">{state.paused ? '⏸️ Paused' : '🎵 Now Playing'}</div>
              <a className="np-title" href={np!.url} target="_blank" rel="noreferrer">
                {np!.title}
              </a>
              <div className="np-meta">
                {np!.uploader ? `${np!.uploader} • ` : ''}
                {fmt(np!.durationSec)}
                {state.channelName ? ` • in ${state.channelName}` : ''}
              </div>
            </>
          ) : (
            <div className="np-status muted-big">Nothing playing</div>
          )}
        </div>
      </div>

      {/* Synced YouTube video */}
      {isPlaying && videoId && showVideo && (
        <VideoPlayer
          videoId={videoId}
          positionSec={displayPos}
          paused={state.paused}
          playbackRate={state.playbackRate}
          onHide={() => setShowVideo(false)}
        />
      )}
      {isPlaying && videoId && !showVideo && (
        <button
          type="button"
          className="secondary show-video"
          onClick={() => setShowVideo(true)}
        >
          📺 Watch video
        </button>
      )}

      {/* Seek / progress bar */}
      {isPlaying && (
        <div className="seek-wrap">
          <SeekBar
            positionSec={displayPos}
            durationSec={np!.durationSec}
            bufferedSec={bufferedSec}
            disabled={pending}
            onSeek={handleSeek}
          />
        </div>
      )}

      {/* Transport controls */}
      <div className="controls">
        <button
          type="button"
          className="secondary"
          disabled={pending || !isPlaying}
          onClick={() => control(state.paused ? 'resume' : 'pause')}
        >
          {state.paused ? '▶️ Resume' : '⏸️ Pause'}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={pending || !isPlaying}
          onClick={() => control('skip')}
        >
          ⏭️ Skip
        </button>
        <button
          type="button"
          className="secondary"
          disabled={pending || state.queue.length < 2}
          onClick={() => control('shuffle')}
        >
          🔀 Shuffle
        </button>
        <select
          value={state.loop}
          disabled={pending || !isPlaying}
          onChange={(e) => control('loop', { mode: e.target.value as LoopMode })}
          className="loop-select"
        >
          <option value="off">{LOOP_LABEL.off}</option>
          <option value="track">{LOOP_LABEL.track}</option>
          <option value="queue">{LOOP_LABEL.queue}</option>
        </select>
        <button
          type="button"
          className="danger"
          disabled={pending || !isPlaying}
          onClick={() => control('stop')}
        >
          ⏹️ Stop
        </button>
      </div>

      {/* Audio effect */}
      <div className="effect-row">
        <div className="effect-pick">
          <span className="effect-label">🎚️ Effect</span>
          <select
            value={state.effect}
            disabled={pending || !isPlaying}
            onChange={(e) => control('effect', { effect: e.target.value as Effect })}
            className="effect-select"
          >
            {(Object.keys(EFFECT_LABELS) as Effect[]).map((e) => (
              <option key={e} value={e}>
                {EFFECT_LABELS[e]}
              </option>
            ))}
          </select>
        </div>
        <div className="effect-intensity">
          <label htmlFor="intensity">
            Intensity <span className="val">{intensity}%</span>
          </label>
          <input
            id="intensity"
            type="range"
            min={0}
            max={100}
            step={1}
            value={intensity}
            disabled={!isPlaying || state.effect === 'off'}
            onChange={(e) => setIntensity(Number(e.target.value))}
            onPointerDown={() => (draggingIntensity.current = true)}
            onPointerUp={() => {
              draggingIntensity.current = false;
              void control('intensity', { intensity });
            }}
            onKeyUp={() => void control('intensity', { intensity })}
          />
        </div>
        <span className="effect-note">Changing an effect or intensity restarts the current track.</span>
      </div>

      {/* Volume */}
      <div className="volume">
        <label htmlFor="vol">
          🔊 Volume <span className="val">{volume}%</span>
        </label>
        <input
          id="vol"
          type="range"
          min={0}
          max={100}
          step={1}
          value={volume}
          disabled={!isPlaying}
          onChange={(e) => setVolume(Number(e.target.value))}
          onPointerDown={() => (draggingVolume.current = true)}
          onPointerUp={() => {
            draggingVolume.current = false;
            void control('volume', { level: volume });
          }}
          onKeyUp={() => void control('volume', { level: volume })}
        />
      </div>

      {/* Queue */}
      <div className="queue">
        <div className="queue-head">
          Up next <span className="muted">({state.queue.length})</span>
        </div>
        {state.queue.length === 0 ? (
          <p className="empty-row">Queue is empty.</p>
        ) : (
          <ol className="queue-list">
            {state.queue.map((t, i) => (
              <li key={`${t.url}-${i}`}>
                <button
                  type="button"
                  className="q-play"
                  disabled={pending}
                  title="Play now"
                  onClick={() => control('jump', { position: i + 1 })}
                >
                  ▶
                </button>
                <span className="q-idx">{i + 1}</span>
                <a className="q-title" href={t.url} target="_blank" rel="noreferrer">
                  {t.title}
                </a>
                <span className="q-dur">{fmt(t.durationSec)}</span>
                <button
                  type="button"
                  className="q-remove"
                  disabled={pending}
                  title="Remove"
                  onClick={() => control('remove', { position: i + 1 })}
                >
                  ✕
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>

      </div>

      <aside className="music-history" aria-label="Music history">
        <div className="music-history-head">
          <div>
            <div className="section-title">Replay</div>
            <h2>Music history</h2>
          </div>
          <div className="music-history-actions">
            <span className="muted">{history.length}</span>
            {isAdmin && (
              <button
                type="button"
                className="danger history-clear"
                disabled={pending || history.length === 0}
                onClick={() => void handleClearHistory()}
              >
                Clear
              </button>
            )}
          </div>
        </div>
        {history.length === 0 ? (
          <p className="history-empty">Songs you play from the dashboard will appear here.</p>
        ) : (
          <ol className="history-list">
            {history.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="history-item"
                  disabled={pending}
                  onClick={() => void handleHistoryPlay(item)}
                  title={`Play ${item.title}`}
                >
                  {item.thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.thumbnail} alt="" className="history-thumb" />
                  ) : (
                    <span className="history-thumb placeholder">🎵</span>
                  )}
                  <span className="history-info">
                    <span className="history-title">{item.title}</span>
                    <span className="history-meta">
                      {item.uploader ? `${item.uploader} • ` : ''}
                      {fmt(item.durationSec)}
                    </span>
                  </span>
                  <span className="history-play">▶</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </aside>
    </div>
  );
}
