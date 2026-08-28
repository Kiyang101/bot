'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { BotStatus, MusicState } from '@/lib/control';
import { SOUND_CATEGORIES } from '@/lib/sound-validation';
import type { SoundboardActionResult, SoundboardSound } from './actions';

const DEFAULT_CATEGORIES: string[] = [...SOUND_CATEGORIES];

export interface SoundboardActions {
  playSound: (input: { soundId: string; channelId: string }) => Promise<SoundboardActionResult<SoundboardSound>>;
  stopSound: (channelId: string) => Promise<SoundboardActionResult>;
  getSoundPlayableUrl: (soundId: string) => Promise<SoundboardActionResult<string>>;
}

export interface SoundboardProps {
  sounds: SoundboardSound[];
  currentUser: { id: string; username: string; role: 'admin' | 'member' };
  selectedGuildId: string | null;
  guildName: string | null;
  channels: Array<{ id: string; name: string }>;
  initialMusicState: MusicState;
  botStatus: BotStatus;
  actions: SoundboardActions;
}

function formatDuration(durationSec: number | null): string {
  if (durationSec === null || !Number.isFinite(durationSec)) return 'Unknown';
  const seconds = Math.max(0, Math.round(durationSec));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function statusLabel(status: BotStatus): string {
  switch (status) {
    case 'RUNNING': return 'Online';
    case 'STARTING': return 'Starting';
    case 'STOPPING': return 'Stopping';
    case 'ERROR': return 'Error';
    default: return 'Offline';
  }
}

function categoryList(sounds: SoundboardSound[]): string[] {
  const existing = new Set(sounds.map((sound) => sound.category));
  return [
    ...DEFAULT_CATEGORIES.filter((category) => existing.has(category)),
    ...[...existing].filter((category) => !DEFAULT_CATEGORIES.includes(category)).sort((a, b) => a.localeCompare(b)),
  ];
}

export default function Soundboard({
  sounds,
  currentUser,
  selectedGuildId,
  guildName,
  channels,
  initialMusicState,
  botStatus,
  actions,
}: SoundboardProps) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [channelId, setChannelId] = useState(initialMusicState.channelId ?? channels[0]?.id ?? '');
  const [activeSoundId, setActiveSoundId] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [pendingSoundId, setPendingSoundId] = useState<string | null>(null);
  const [pendingStop, setPendingStop] = useState(false);
  const [previewSoundId, setPreviewSoundId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewRefreshing, setPreviewRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const previewRequestRef = useRef<{ soundId: string; token: number }>({ soundId: '', token: 0 });

  const categories = useMemo(() => categoryList(sounds), [sounds]);
  const filteredSounds = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return sounds.filter((sound) => {
      const matchesCategory =
        category === 'All'
          ? true
          : category === 'Uploaded by me'
            ? sound.uploadedById === currentUser.id
            : sound.category === category;
      const searchable = `${sound.name} ${sound.category} ${sound.uploadedByName}`.toLocaleLowerCase();
      return matchesCategory && (!query || searchable.includes(query));
    });
  }, [category, currentUser.id, search, sounds]);

  const activeSound = activeSoundId ? sounds.find((sound) => sound.id === activeSoundId) ?? null : null;
  const playbackAvailable = Boolean(selectedGuildId && channelId && botStatus === 'RUNNING');
  const activeDuration = activeSound
    ? activeSound.durationSec ?? Math.max(0, (activeSound.trimEndMs - activeSound.trimStartMs) / 1_000)
    : null;

  useEffect(() => {
    if (!channelId || !channels.some((channel) => channel.id === channelId)) {
      setChannelId(channels[0]?.id ?? '');
    }
  }, [channelId, channels]);

  useEffect(() => {
    if (!activeSoundId || startedAt === null || activeDuration === null || activeDuration <= 0) return;
    const timer = window.setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1000;
      if (elapsed >= activeDuration) {
        setActiveSoundId(null);
        setStartedAt(null);
        setElapsedSec(0);
        setMessage('Sound finished.');
        return;
      }
      setElapsedSec(elapsed);
    }, 250);
    return () => window.clearInterval(timer);
  }, [activeDuration, activeSoundId, startedAt]);

  async function handlePlay(sound: SoundboardSound): Promise<void> {
    if (!playbackAvailable || pendingSoundId) return;
    setPendingSoundId(sound.id);
    setMessage(null);
    try {
      const result = await actions.playSound({ soundId: sound.id, channelId });
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setActiveSoundId(sound.id);
      setStartedAt(Date.now());
      setElapsedSec(0);
      setMessage(initialMusicState.current ? 'Playing over music.' : 'Playing.');
    } catch {
      setMessage('Could not play this sound. Try again.');
    } finally {
      setPendingSoundId(null);
    }
  }

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (
        target.isContentEditable
        || target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.tagName === 'SELECT'
        || target.closest('[contenteditable="true"]')
      )) return;
      if (!selectedGuildId || !channelId || botStatus !== 'RUNNING' || pendingSoundId || activeSoundId) return;
      const shortcut = event.key === ' ' ? 'space' : event.key.length === 1 ? event.key.toLowerCase() : null;
      if (!shortcut) return;
      const sound = sounds.find((candidate) => candidate.shortcut === shortcut);
      if (!sound) return;
      event.preventDefault();
      void handlePlay(sound);
    }

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [activeSoundId, botStatus, channelId, pendingSoundId, selectedGuildId, sounds]);

  async function handlePreview(sound: SoundboardSound): Promise<void> {
    const request = { soundId: sound.id, token: previewRequestRef.current.token + 1 };
    previewRequestRef.current = request;
    setPreviewSoundId(sound.id);
    setPreviewUrl(null);
    setPreviewError(null);
    setPreviewRefreshing(false);
    setMessage(null);
    try {
      const result = await actions.getSoundPlayableUrl(sound.id);
      if (previewRequestRef.current !== request) return;
      if (!result.ok) {
        setPreviewError(result.message);
        setPreviewSoundId(null);
        return;
      }
      if (!result.value) {
        setPreviewError('Could not load the preview. Try again.');
        setPreviewSoundId(null);
        return;
      }
      setPreviewUrl(result.value);
    } catch {
      if (previewRequestRef.current !== request) return;
      setPreviewError('Could not load the preview. Try again.');
      setPreviewSoundId(null);
    }
  }

  async function refreshPreview(): Promise<void> {
    if (!previewSoundId || previewRefreshing) return;
    const soundId = previewSoundId;
    const sound = sounds.find((candidate) => candidate.id === soundId);
    if (!sound) return;
    const request = { soundId, token: previewRequestRef.current.token + 1 };
    previewRequestRef.current = request;
    setPreviewRefreshing(true);
    setPreviewError(null);
    try {
      const result = await actions.getSoundPlayableUrl(sound.id);
      if (previewRequestRef.current !== request) return;
      if (!result.ok || !result.value || result.value === previewUrl) {
        setPreviewError(result.ok ? 'Could not refresh the sound preview. Try again.' : result.message);
        return;
      }
      setPreviewUrl(result.value);
    } catch {
      if (previewRequestRef.current !== request) return;
      setPreviewError('Could not refresh the sound preview. Try again.');
    } finally {
      if (previewRequestRef.current === request) setPreviewRefreshing(false);
    }
  }

  async function handleStop(): Promise<void> {
    if (!selectedGuildId || !channelId || pendingStop) return;
    setPendingStop(true);
    setMessage(null);
    try {
      const result = await actions.stopSound(channelId);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setActiveSoundId(null);
      setStartedAt(null);
      setElapsedSec(0);
      setMessage('Sound stopped.');
    } catch {
      setMessage('Could not stop the sound. Try again.');
    } finally {
      setPendingStop(false);
    }
  }

  const progress = activeDuration && activeDuration > 0
    ? Math.min(100, (elapsedSec / activeDuration) * 100)
    : 0;

  return (
    <main className="soundboard-page">
      <header className="soundboard-heading">
        <div>
          <p className="soundboard-eyebrow">Live broadcast console</p>
          <h1>Soundboard</h1>
          <p className="sub">Trigger shared sounds into the selected Discord voice session.</p>
        </div>
        <div className="soundboard-heading-actions">
          <div className="soundboard-destination" aria-label="Playback destination">
            <span className="muted">Destination</span>
            <strong>{guildName ?? 'No server selected'}</strong>
          </div>
          <a className="secondary soundboard-manage-link" href="/soundboard/manage">Manage sounds</a>
        </div>
      </header>

      <section className="soundboard-connection" aria-label="Voice connection status">
        <div className="soundboard-connection-status">
          <span className={`status-dot ${botStatus.toLowerCase()}`} aria-hidden="true" />
          <div>
            <span className="section-title">Bot status</span>
            <strong>{statusLabel(botStatus)}</strong>
          </div>
        </div>
        <div className="soundboard-voice-status">
          <span className="section-title">Voice session</span>
          <strong>{initialMusicState.channelName ?? 'Not connected'}</strong>
        </div>
        <label className="soundboard-channel">
          Voice channel
          <select value={channelId} onChange={(event) => setChannelId(event.target.value)} disabled={!selectedGuildId || Boolean(initialMusicState.channelId)}>
            <option value="">Choose a channel</option>
            {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
          </select>
        </label>
        <p className="soundboard-connection-note">
          {botStatus !== 'RUNNING'
            ? 'The bot is unavailable. Preview sounds here and reconnect the bot to play them in Discord.'
            : initialMusicState.channelName
              ? `Connected in ${initialMusicState.channelName}.`
              : 'The first sound will join the selected voice channel.'}
        </p>
      </section>

      {!selectedGuildId && (
        <section className="soundboard-setup-card" role="status">
          <span className="soundboard-setup-icon" aria-hidden="true">◎</span>
          <div>
            <h2>Select a Discord server before playing sounds</h2>
            <p>Browse the global library and preview clips now. Choose a server to route playback into Discord.</p>
          </div>
          <a className="secondary" href="/servers">Select server</a>
        </section>
      )}

      <section className="soundboard-toolbar" aria-label="Sound filters">
        <label className="soundboard-search">
          Search sounds
          <input
            aria-label="Search sounds"
            type="search"
            placeholder="Name, category, or uploader"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="soundboard-filters" role="group" aria-label="Sound categories">
          <button type="button" className={category === 'All' ? 'filter-chip active' : 'filter-chip'} aria-pressed={category === 'All'} onClick={() => setCategory('All')}>All</button>
          {categories.map((item) => (
            <button key={item} type="button" className={category === item ? 'filter-chip active' : 'filter-chip'} aria-pressed={category === item} onClick={() => setCategory(item)}>{item}</button>
          ))}
          <button type="button" className={category === 'Uploaded by me' ? 'filter-chip active' : 'filter-chip'} aria-pressed={category === 'Uploaded by me'} onClick={() => setCategory('Uploaded by me')}>Uploaded by me</button>
        </div>
      </section>

      {message && <p className="soundboard-message" role="status" aria-live="polite">{message}</p>}
      {previewError && <p className="soundboard-message" role="alert">{previewError}</p>}

      {sounds.length === 0 ? (
        <section className="soundboard-empty empty">
          <h2>No sounds yet</h2>
          <p>Upload the first sound to give your server a live audio palette.</p>
          <a className="secondary" href="/soundboard/manage">Upload the first sound</a>
        </section>
      ) : filteredSounds.length === 0 ? (
        <section className="soundboard-empty empty"><h2>No sounds match your filters</h2><p>Try a different name, category, or uploader.</p></section>
      ) : (
        <section className="soundboard-grid" aria-label="Sound pads">
          {filteredSounds.map((sound) => {
            const isActive = activeSoundId === sound.id;
            const isPending = pendingSoundId === sound.id;
            const padDisabled = Boolean(pendingSoundId) || (!isActive && Boolean(activeSoundId)) || !playbackAvailable;
            return (
              <article key={sound.id} className={`sound-pad-wrap${isActive ? ' active' : ''}`} style={{ '--sound-color': sound.color } as CSSProperties}>
                <button
                  type="button"
                  className="sound-pad"
                  aria-label={`Play ${sound.name}, ${formatDuration(sound.durationSec)}, ${sound.category}`}
                  aria-pressed={isActive}
                  aria-busy={isPending}
                  disabled={padDisabled}
                  onClick={() => void handlePlay(sound)}
                >
                  <span className="sound-pad-wave" aria-hidden="true"><i /><i /><i /><i /><i /></span>
                  <span className="sound-pad-name">{sound.name}</span>
                  <span className="sound-pad-meta">{sound.category} · {formatDuration(sound.durationSec)}</span>
                  <span className="sound-pad-uploader">by {sound.uploadedByName}</span>
                  {isActive && <span className="sound-pad-live">LIVE</span>}
                </button>
                <button type="button" className="sound-pad-preview" aria-label={`Preview ${sound.name}`} onClick={() => void handlePreview(sound)} disabled={previewSoundId === sound.id && !previewUrl}>
                  {previewSoundId === sound.id && !previewUrl ? 'Loading…' : 'Preview'}
                </button>
              </article>
            );
          })}
        </section>
      )}

      {previewUrl && previewSoundId && (
        <section className="soundboard-preview" aria-label="Sound preview">
          <div><span className="section-title">Browser preview</span><strong>{sounds.find((sound) => sound.id === previewSoundId)?.name}</strong></div>
          <audio key={previewUrl} aria-label={`Preview ${sounds.find((sound) => sound.id === previewSoundId)?.name ?? 'sound'}`} controls src={previewUrl} onError={() => void refreshPreview()} />
          <button type="button" className="secondary" onClick={() => void refreshPreview()} disabled={previewRefreshing}>
            {previewRefreshing ? 'Refreshing preview…' : 'Refresh preview'}
          </button>
        </section>
      )}

      <section className="soundboard-dock" aria-label="Playback dock">
        <div className="soundboard-dock-now">
          <span className="soundboard-dock-mark" aria-hidden="true">◒</span>
          <div>
            <span className="section-title">Now playing</span>
            <strong>{activeSound?.name ?? 'No sound playing'}</strong>
            {activeSound && <span className="muted">{initialMusicState.current ? 'Playing over music' : 'Playing'} · {formatDuration(Math.max(0, (activeDuration ?? 0) - elapsedSec))} remaining</span>}
          </div>
        </div>
        <div className="soundboard-progress" aria-label="Sound progress">
          <div className="soundboard-progress-track"><span style={{ width: `${progress}%` }} /></div>
          <span className="muted">{activeSound ? `${formatDuration(elapsedSec)} / ${formatDuration(activeDuration)}` : 'Ready'}</span>
        </div>
        <label className="soundboard-volume">
          Master volume
          <output>{initialMusicState.volume}%</output>
          <input type="range" min="0" max="100" value={initialMusicState.volume} readOnly aria-label="Master volume" />
        </label>
        <button type="button" className="danger" disabled={!channelId || pendingStop || !selectedGuildId || botStatus !== 'RUNNING'} onClick={() => void handleStop()}>{pendingStop ? 'Stopping…' : 'Stop sound'}</button>
      </section>
    </main>
  );
}
