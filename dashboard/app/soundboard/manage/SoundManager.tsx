'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useReducer,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from 'react';
import type {
  SoundMetadataInput,
  SoundboardActionResult,
  SoundboardSound,
  TrimSoundInput,
  UploadSoundInput,
} from '../actions';
import {
  MAX_FADE_MS,
  MAX_GAIN_DB,
  MAX_SOUND_BYTES,
  MIN_GAIN_DB,
  SOUND_CATEGORIES,
  SOUND_COLOR_OPTIONS,
  SUPPORTED_SOUND_MIME_TYPES,
  validateUploadMeta,
} from '@/lib/sound-validation';
import WaveformEditor, { type TrimRange } from './WaveformEditor';

const DEFAULT_CATEGORIES = [...SOUND_CATEGORIES];
const COLOR_OPTIONS = [...SOUND_COLOR_OPTIONS];

export type ManagedSound = SoundboardSound & {
  previewUrl: string;
  sourcePreviewUrl: string | null;
};

export interface SoundManagerActions {
  uploadSound: (input: UploadSoundInput) => Promise<SoundboardActionResult<SoundboardSound>>;
  updateSound: (soundId: string, input: SoundMetadataInput) => Promise<SoundboardActionResult<SoundboardSound>>;
  trimSound: (input: TrimSoundInput) => Promise<SoundboardActionResult<SoundboardSound>>;
  deleteSound: (soundId: string) => Promise<SoundboardActionResult>;
  reorderSounds: (soundIds: string[]) => Promise<SoundboardActionResult>;
  getSoundPlayableUrl: (soundId: string) => Promise<SoundboardActionResult<string>>;
  getSoundSourceUrl: (soundId: string) => Promise<SoundboardActionResult<string>>;
}

interface SoundManagerProps {
  initialSounds: ManagedSound[];
  currentUser: { id: string; role: 'admin' | 'member' };
  actions: SoundManagerActions;
}

interface EditorMetadata {
  name: string;
  category: string;
  color: string;
  shortcut: string;
  gainDb: number;
  fadeInMs: number;
  fadeOutMs: number;
}

const DEFAULT_EDITOR_METADATA: EditorMetadata = {
  name: '',
  category: DEFAULT_CATEGORIES[0],
  color: COLOR_OPTIONS[0],
  shortcut: '',
  gainDb: 0,
  fadeInMs: 0,
  fadeOutMs: 0,
};

type FocusAfterDelete = string | 'upload';

interface SoundLibraryState {
  sounds: ManagedSound[];
  focusAfterDeleteId: FocusAfterDelete | null;
}

type SoundLibraryAction =
  | { type: 'update'; update: (sounds: ManagedSound[]) => ManagedSound[] }
  | { type: 'delete'; soundId: string }
  | { type: 'clear-delete-focus' };

function soundLibraryReducer(state: SoundLibraryState, action: SoundLibraryAction): SoundLibraryState {
  switch (action.type) {
    case 'update':
      return { ...state, sounds: action.update(state.sounds) };
    case 'delete': {
      const deletedIndex = state.sounds.findIndex((sound) => sound.id === action.soundId);
      if (deletedIndex < 0) return state;
      const remaining = state.sounds.filter((sound) => sound.id !== action.soundId);
      const focusTarget = remaining[deletedIndex] ?? remaining[deletedIndex - 1] ?? null;
      return {
        sounds: remaining,
        focusAfterDeleteId: focusTarget?.id ?? 'upload',
      };
    }
    case 'clear-delete-focus':
      return state.focusAfterDeleteId === null ? state : { ...state, focusAfterDeleteId: null };
  }
}

function revokeObjectUrl(url: string | null): void {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}

function metadataForSound(sound: SoundboardSound): EditorMetadata {
  return {
    name: sound.name,
    category: sound.category,
    color: sound.color,
    shortcut: sound.shortcut === 'space' ? ' ' : sound.shortcut ?? '',
    gainDb: sound.gainDb,
    fadeInMs: sound.fadeInMs,
    fadeOutMs: sound.fadeOutMs,
  };
}

function displayShortcut(shortcut: string | null): string {
  return shortcut === null ? '—' : shortcut === 'space' ? 'Space' : shortcut.toUpperCase();
}

function metadataInput(metadata: EditorMetadata): SoundMetadataInput {
  return {
    ...metadata,
    // A literal space must reach the server so it can normalize the Space key.
    shortcut: metadata.shortcut === '' ? null : metadata.shortcut,
    fadeInMs: Math.round(metadata.fadeInMs),
    fadeOutMs: Math.round(metadata.fadeOutMs),
  };
}

function mergeSound(saved: ManagedSound, updated: SoundboardSound): ManagedSound {
  return { ...saved, ...updated, previewUrl: saved.previewUrl, sourcePreviewUrl: saved.sourcePreviewUrl };
}

function applySoundOrder(current: ManagedSound[], requestedIds: string[]): ManagedSound[] {
  const currentById = new Map(current.map((sound) => [sound.id, sound]));
  const includedIds = new Set<string>();
  const orderedCurrent = requestedIds.flatMap((soundId) => {
    const sound = currentById.get(soundId);
    if (!sound || includedIds.has(soundId)) return [];
    includedIds.add(soundId);
    return [sound];
  });
  return [...orderedCurrent, ...current.filter((sound) => !includedIds.has(sound.id))];
}

function resultValue<T>(result: SoundboardActionResult<T>): T | null {
  return result.ok && 'value' in result && result.value !== undefined ? result.value : null;
}

function displayDuration(durationSec: number | null): string {
  return durationSec === null ? 'Unknown' : `${durationSec.toFixed(2)} s`;
}

function displayDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
    year: 'numeric',
  }).format(parsed);
}

function MetadataFields({
  metadata,
  categories,
  isAdmin,
  disabled,
  onChange,
}: {
  metadata: EditorMetadata;
  categories: string[];
  isAdmin: boolean;
  disabled: boolean;
  onChange: (metadata: EditorMetadata) => void;
}) {
  const update = <Key extends keyof EditorMetadata>(key: Key, value: EditorMetadata[Key]) => {
    onChange({ ...metadata, [key]: value });
  };

  return (
    <div className="sound-fields">
      <label>
        Sound name
        <input
          type="text"
          maxLength={60}
          required
          value={metadata.name}
          disabled={disabled}
          onChange={(event) => update('name', event.target.value)}
        />
      </label>
      <label>
        Category
        {isAdmin ? (
          <>
            <input
              type="text"
              list="sound-categories"
              maxLength={40}
              required
              value={metadata.category}
              disabled={disabled}
              onChange={(event) => update('category', event.target.value)}
            />
            <datalist id="sound-categories">
              {categories.map((category) => <option key={category} value={category} />)}
            </datalist>
          </>
        ) : (
          <select
            required
            value={metadata.category}
            disabled={disabled}
            onChange={(event) => update('category', event.target.value)}
          >
            {categories.map((category) => <option key={category} value={category}>{category}</option>)}
          </select>
        )}
      </label>
      <fieldset className="sound-color-fieldset" disabled={disabled}>
        <legend>Accent color</legend>
        <div className="sound-color-options">
          {COLOR_OPTIONS.map((color) => (
            <label key={color} className="sound-color-option" style={{ backgroundColor: color }}>
              <input
                type="radio"
                name={`sound-color-${metadata.name}`}
                value={color}
                checked={metadata.color === color}
                onChange={() => update('color', color)}
              />
              <span className="sr-only">{color}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label>
        Keyboard shortcut <span className="field-optional">Optional</span>
        <input
          type="text"
          maxLength={1}
          value={metadata.shortcut}
          disabled={disabled}
          onChange={(event) => update('shortcut', event.target.value)}
        />
      </label>
      <label className="sound-range-field">
        Gain <output>{metadata.gainDb} dB</output>
        <input
          type="range"
          min={MIN_GAIN_DB}
          max={MAX_GAIN_DB}
          step={1}
          value={metadata.gainDb}
          disabled={disabled}
          onChange={(event) => update('gainDb', Number(event.target.value))}
        />
      </label>
      <div className="sound-fade-fields">
        <label>
          Fade in (ms)
          <input
            type="number"
            min={0}
            max={MAX_FADE_MS}
            step={50}
            value={metadata.fadeInMs}
            disabled={disabled}
            onChange={(event) => update('fadeInMs', Number(event.target.value))}
          />
        </label>
        <label>
          Fade out (ms)
          <input
            type="number"
            min={0}
            max={MAX_FADE_MS}
            step={50}
            value={metadata.fadeOutMs}
            disabled={disabled}
            onChange={(event) => update('fadeOutMs', Number(event.target.value))}
          />
        </label>
      </div>
    </div>
  );
}

export default function SoundManager({ initialSounds, currentUser, actions }: SoundManagerProps) {
  const [{ sounds, focusAfterDeleteId }, dispatchLibrary] = useReducer(soundLibraryReducer, {
    sounds: initialSounds,
    focusAfterDeleteId: null,
  });
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadMetadata, setUploadMetadata] = useState<EditorMetadata>(DEFAULT_EDITOR_METADATA);
  const [uploadRange, setUploadRange] = useState<TrimRange | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editMetadata, setEditMetadata] = useState<EditorMetadata | null>(null);
  const [editRange, setEditRange] = useState<TrimRange | null>(null);
  const [editingSourceUrl, setEditingSourceUrl] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTriggerRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const refreshingPreviewIdsRef = useRef(new Set<string>());
  const editingSelectionRef = useRef<{ id: string | null; token: number }>({ id: null, token: 0 });
  const editingSourceUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!focusAfterDeleteId) return;
    if (focusAfterDeleteId === 'upload') uploadTriggerRef.current?.focus();
    else rowRefs.current.get(focusAfterDeleteId)?.focus();
    dispatchLibrary({ type: 'clear-delete-focus' });
  }, [focusAfterDeleteId]);

  useEffect(() => () => {
    revokeObjectUrl(editingSourceUrlRef.current);
  }, []);

  const categories = useMemo(() => Array.from(new Set([
    ...DEFAULT_CATEGORIES,
    ...sounds.map((sound) => sound.category),
  ])), [sounds]);
  const editingSound = sounds.find((sound) => sound.id === editingId) ?? null;
  const isAdmin = currentUser.role === 'admin';

  function canManage(sound: ManagedSound): boolean {
    return isAdmin || sound.uploadedById === currentUser.id;
  }

  function isPending(key: string): boolean {
    return pendingActions.has(key);
  }

  function updateSounds(update: (current: ManagedSound[]) => ManagedSound[]): void {
    dispatchLibrary({ type: 'update', update });
  }

  function replaceEditingSourceUrl(url: string | null): void {
    const previousUrl = editingSourceUrlRef.current;
    if (previousUrl !== url) revokeObjectUrl(previousUrl);
    editingSourceUrlRef.current = url;
    setEditingSourceUrl(url);
  }

  function closeEditor(): void {
    editingSelectionRef.current = { id: null, token: editingSelectionRef.current.token + 1 };
    replaceEditingSourceUrl(null);
    setEditingId(null);
    setEditMetadata(null);
    setEditRange(null);
  }

  async function runAction<T>(
    pendingKey: string,
    failureMessage: string,
    action: () => Promise<SoundboardActionResult<T>>,
  ): Promise<SoundboardActionResult<T> | null> {
    setError(null);
    setWarning(null);
    setPendingActions((current) => new Set(current).add(pendingKey));
    try {
      const result = await action();
      if (result.warning) setWarning(result.warning);
      return result;
    } catch {
      setError(failureMessage);
      return null;
    } finally {
      setPendingActions((current) => {
        const next = new Set(current);
        next.delete(pendingKey);
        return next;
      });
    }
  }

  async function refreshPlayableUrl(soundId: string, expiredUrl: string) {
    if (refreshingPreviewIdsRef.current.has(soundId)) return;
    refreshingPreviewIdsRef.current.add(soundId);
    try {
      const result = await actions.getSoundPlayableUrl(soundId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const previewUrl = resultValue(result);
      if (!previewUrl || previewUrl === expiredUrl) {
        setError('Could not refresh the sound preview. Try again.');
        return;
      }
      updateSounds((current) => current.map((sound) => sound.id === soundId ? { ...sound, previewUrl } : sound));
    } catch {
      setError('Could not refresh the sound preview. Try again.');
    } finally {
      refreshingPreviewIdsRef.current.delete(soundId);
    }
  }

  function chooseFile(file: File | null) {
    setError(null);
    setUploadRange(null);
    if (!file) {
      setSelectedFile(null);
      return;
    }
    const derivedName = file.name.replace(/\.[^.]+$/, '').trim() || file.name;
    const validation = validateUploadMeta(derivedName, file.type, file.size);
    if (!validation.ok) {
      setSelectedFile(null);
      setError(validation.message);
      return;
    }
    setSelectedFile(file);
    setUploadMetadata((current) => ({ ...current, name: validation.value.name }));
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    chooseFile(event.target.files?.[0] ?? null);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    chooseFile(event.dataTransfer.files?.[0] ?? null);
  }

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFile || !uploadRange) {
      setError('Choose an audio file and wait for its waveform before uploading.');
      return;
    }
    const result = await runAction('upload', 'Could not upload the sound. Try again.', () => (
      actions.uploadSound({
        ...metadataInput(uploadMetadata),
        file: selectedFile,
        trimStartMs: Math.round(uploadRange.startMs),
        trimEndMs: Math.round(uploadRange.endMs),
      })
    ));
    if (!result) return;
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const uploadedName = uploadMetadata.name;
    const uploaded = resultValue(result);
    if (uploaded) {
      updateSounds((current) => [...current, {
        ...uploaded,
        previewUrl: '',
        sourcePreviewUrl: null,
      }]);
    }

    // Reset immediately after the mutation commits so a preview outage cannot make the upload retryable.
    setAnnouncement(`${uploadedName} uploaded.`);
    setSelectedFile(null);
    setUploadRange(null);
    setUploadMetadata(DEFAULT_EDITOR_METADATA);
    if (fileInputRef.current) fileInputRef.current.value = '';

    if (uploaded) {
      try {
        const previewResult = await actions.getSoundPlayableUrl(uploaded.id);
        const previewUrl = resultValue(previewResult);
        if (previewUrl) {
          updateSounds((current) => current.map((sound) => sound.id === uploaded.id ? { ...sound, previewUrl } : sound));
        } else if (!previewResult.ok) {
          setError(previewResult.message);
        } else {
          setError('Could not load the sound preview. Use Refresh preview to try again.');
        }
      } catch {
        setError('Could not load the sound preview. Use Refresh preview to try again.');
      }
    }
  }

  async function beginEditing(sound: ManagedSound) {
    const request = { id: sound.id, token: editingSelectionRef.current.token + 1 };
    editingSelectionRef.current = request;
    setError(null);
    setConfirmingDeleteId(null);
    setEditingId(sound.id);
    replaceEditingSourceUrl(null);
    setEditMetadata(metadataForSound(sound));
    setEditRange({
      startMs: sound.trimStartMs,
      endMs: sound.trimEndMs,
      durationMs: Math.round((sound.durationSec ?? sound.trimEndMs / 1_000) * 1_000),
    });
    const sourceResult = await runAction(
      `source:${sound.id}`,
      'Could not load the source audio. Try again.',
      () => actions.getSoundSourceUrl(sound.id),
    );
    if (!sourceResult) return;
    const sourceUrl = resultValue(sourceResult);
    if (editingSelectionRef.current.id !== request.id || editingSelectionRef.current.token !== request.token) {
      revokeObjectUrl(sourceUrl);
      return;
    }
    if (!sourceResult.ok) {
      setError(sourceResult.message);
      return;
    }
    replaceEditingSourceUrl(sourceUrl);
  }

  async function saveMetadata(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingSound || !editMetadata) return;
    const pendingKey = `edit:${editingSound.id}`;
    const result = await runAction(pendingKey, 'Could not save the sound details. Try again.', () => (
      actions.updateSound(editingSound.id, metadataInput(editMetadata))
    ));
    if (!result) return;
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const updated = resultValue(result);
    if (updated) updateSounds((current) => current.map((sound) => sound.id === updated.id ? mergeSound(sound, updated) : sound));
    setAnnouncement(`${editMetadata.name} details saved.`);
  }

  async function saveTrim() {
    if (!editingSound || !editRange) return;
    const pendingKey = `trim:${editingSound.id}`;
    const result = await runAction(pendingKey, 'Could not save the trim. Try again.', () => (
      actions.trimSound({
        soundId: editingSound.id,
        trimStartMs: Math.round(editRange.startMs),
        trimEndMs: Math.round(editRange.endMs),
      })
    ));
    if (!result) return;
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const updated = resultValue(result);
    if (updated) {
      const previewResult = await actions.getSoundPlayableUrl(updated.id);
      const previewUrl = resultValue(previewResult);
      updateSounds((current) => current.map((sound) => sound.id === updated.id
        ? { ...mergeSound(sound, updated), previewUrl: previewUrl ?? sound.previewUrl }
        : sound));
      if (!previewResult.ok) setError(previewResult.message);
    }
    setAnnouncement(`${editingSound.name} trim saved.`);
  }

  async function confirmDelete(sound: ManagedSound) {
    const pendingKey = `delete:${sound.id}`;
    const result = await runAction(pendingKey, 'Could not delete the sound. Try again.', () => (
      actions.deleteSound(sound.id)
    ));
    if (!result) return;
    if (!result.ok) {
      setError(result.message);
      return;
    }
    dispatchLibrary({ type: 'delete', soundId: sound.id });
    setConfirmingDeleteId(null);
    if (editingId === sound.id) {
      closeEditor();
    }
    setAnnouncement(`${sound.name} deleted.`);
  }

  async function moveSound(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= sounds.length) return;
    const reordered = [...sounds];
    [reordered[index], reordered[nextIndex]] = [reordered[nextIndex], reordered[index]];
    const result = await runAction('reorder', 'Could not reorder the sounds. Try again.', () => (
      actions.reorderSounds(reordered.map((sound) => sound.id))
    ));
    if (!result) return;
    if (!result.ok) {
      setError(result.message);
      return;
    }
    updateSounds((current) => applySoundOrder(current, reordered.map((sound) => sound.id)));
    setAnnouncement(`${reordered[nextIndex].name} moved ${direction < 0 ? 'up' : 'down'}.`);
  }

  return (
    <div className="sound-manager">
      <div className="sound-manager-heading">
        <div>
          <p className="sound-manager-eyebrow">Global library</p>
          <h1>Sound management</h1>
          <p className="sub">Shape short clips for every server, then assign them to the shared board.</p>
        </div>
        <button ref={uploadTriggerRef} type="button" onClick={() => fileInputRef.current?.click()}>Upload sound</button>
      </div>

      <form className="sound-upload-panel" onSubmit={(event) => void handleUpload(event)} aria-busy={isPending('upload')}>
        <div
          className={`sound-drop-zone${dragActive ? ' drag-active' : ''}`}
          onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragActive(false)}
          onDrop={handleDrop}
        >
          <span className="sound-drop-icon" aria-hidden="true">↥</span>
          <strong>{selectedFile ? selectedFile.name : 'Drop an audio clip here'}</strong>
          <span>MP3, WAV, or OGG · up to {Math.round(MAX_SOUND_BYTES / 1024 / 1024)} MB</span>
          <label className="sound-file-button">
            Choose file
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              accept={SUPPORTED_SOUND_MIME_TYPES.join(',')}
              aria-label="Choose MP3, WAV, or OGG file"
              disabled={isPending('upload')}
              onChange={handleFileInput}
            />
          </label>
        </div>

        {selectedFile && (
          <div className="sound-editor-panel">
            <MetadataFields
              metadata={uploadMetadata}
              categories={categories}
              isAdmin={isAdmin}
              disabled={isPending('upload')}
              onChange={setUploadMetadata}
            />
            <div className="sound-waveform-column">
              <WaveformEditor
                source={selectedFile}
                disabled={isPending('upload')}
                onRangeChange={setUploadRange}
              />
              <button type="submit" disabled={!uploadRange || isPending('upload')}>
                {isPending('upload') ? 'Processing sound…' : 'Upload sound'}
              </button>
            </div>
          </div>
        )}
      </form>

      {error && <p className="sound-error" role="alert">{error}</p>}
      {warning && <p className="sound-warning" role="status">{warning}</p>}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>

      {editingSound && editMetadata && (
        <section
          className="sound-edit-panel"
          aria-labelledby="sound-edit-title"
          aria-busy={isPending(`edit:${editingSound.id}`) || isPending(`trim:${editingSound.id}`)}
        >
          <div className="sound-section-heading">
            <div>
              <p className="sound-manager-eyebrow">Editing source</p>
              <h2 id="sound-edit-title">{editingSound.name}</h2>
            </div>
            <button type="button" className="secondary" onClick={closeEditor}>Close editor</button>
          </div>
          <div className="sound-editor-panel">
            <form className="sound-metadata-form" onSubmit={(event) => void saveMetadata(event)}>
              <MetadataFields
                metadata={editMetadata}
                categories={categories}
                isAdmin={isAdmin}
                disabled={isPending(`edit:${editingSound.id}`)}
                onChange={setEditMetadata}
              />
              <button type="submit" disabled={isPending(`edit:${editingSound.id}`)}>
                {isPending(`edit:${editingSound.id}`) ? 'Saving details…' : 'Save changes'}
              </button>
            </form>
            <div className="sound-waveform-column">
              {editingSourceUrl ? <WaveformEditor
                source={editingSourceUrl}
                initialStartMs={editingSound.trimStartMs}
                initialEndMs={editingSound.trimEndMs}
                disabled={isPending(`trim:${editingSound.id}`)}
                onRangeChange={setEditRange}
              /> : <p className="waveform-status" aria-live="polite">Loading source audio…</p>}
              <button type="button" onClick={() => void saveTrim()} disabled={!editingSourceUrl || !editRange || isPending(`trim:${editingSound.id}`)}>
                {isPending(`trim:${editingSound.id}`) ? 'Processing trim…' : 'Save trim'}
              </button>
              <audio
                className="sound-native-preview"
                controls
                src={editingSound.previewUrl}
                aria-label={`Preview ${editingSound.name}`}
                onError={() => void refreshPlayableUrl(editingSound.id, editingSound.previewUrl)}
              />
            </div>
          </div>
        </section>
      )}

      <section className="sound-library" aria-labelledby="sound-library-title">
        <div className="sound-section-heading">
          <div>
            <p className="sound-manager-eyebrow">Ready to play</p>
            <h2 id="sound-library-title">Global sound library</h2>
          </div>
          <span className="sound-count">{sounds.length} {sounds.length === 1 ? 'sound' : 'sounds'}</span>
        </div>
        {sounds.length === 0 ? (
          <div className="sound-empty">
            <h3>No sounds yet</h3>
            <p>Upload the first sound to make it available across every server.</p>
            <button ref={uploadTriggerRef} type="button" onClick={() => fileInputRef.current?.click()}>Upload the first sound</button>
          </div>
        ) : (
          <div className="sound-library-list">
            {sounds.map((sound, index) => {
              const manageable = canManage(sound);
              const deleting = isPending(`delete:${sound.id}`);
              return (
                <article
                  className={`sound-library-row${previewingId === sound.id ? ' preview-active' : ''}`}
                  data-testid={`sound-row-${sound.id}`}
                  tabIndex={-1}
                  ref={(element) => {
                    if (element) rowRefs.current.set(sound.id, element);
                    else rowRefs.current.delete(sound.id);
                  }}
                  key={sound.id}
                  style={{ '--sound-color': sound.color } as React.CSSProperties}
                  aria-busy={deleting}
                >
                  <div className="sound-library-identity">
                    <span className="sound-color-mark" aria-hidden="true" />
                    <div>
                      <h3>{sound.name}</h3>
                      <span>Uploaded by {sound.uploadedByName}</span>
                    </div>
                  </div>
                  <dl className="sound-library-meta">
                    <div><dt>Category</dt><dd>{sound.category}</dd></div>
                    <div><dt>Duration</dt><dd>{displayDuration(sound.durationSec)}</dd></div>
                    <div><dt>Uploaded</dt><dd>{displayDate(sound.createdAt)}</dd></div>
                    <div><dt>Shortcut</dt><dd>{displayShortcut(sound.shortcut)}</dd></div>
                  </dl>
                  {sound.previewUrl ? <audio
                      className="sound-row-preview"
                      controls
                      preload="none"
                      src={sound.previewUrl}
                      aria-label={`Preview ${sound.name}`}
                      onPlay={() => setPreviewingId(sound.id)}
                      onPause={() => setPreviewingId((current) => current === sound.id ? null : current)}
                      onEnded={() => setPreviewingId((current) => current === sound.id ? null : current)}
                      onError={() => void refreshPlayableUrl(sound.id, sound.previewUrl)}
                    /> : <button
                      type="button"
                      className="secondary compact"
                      aria-label={`Refresh preview for ${sound.name}`}
                      disabled={isPending(`preview:${sound.id}`)}
                      onClick={() => void refreshPlayableUrl(sound.id, sound.previewUrl)}
                    >Refresh preview</button>}
                  <div className="sound-row-actions">
                    {isAdmin && (
                      <div className="sound-reorder-actions" aria-label={`Reorder ${sound.name}`}>
                        {index > 0 && <button type="button" className="secondary compact" aria-label={`Move ${sound.name} up`} disabled={isPending('reorder')} onClick={() => void moveSound(index, -1)}>↑</button>}
                        {index < sounds.length - 1 && <button type="button" className="secondary compact" aria-label={`Move ${sound.name} down`} disabled={isPending('reorder')} onClick={() => void moveSound(index, 1)}>↓</button>}
                      </div>
                    )}
                    {manageable && (
                      <>
                        <button type="button" className="secondary" aria-label={`Edit ${sound.name}`} onClick={() => void beginEditing(sound)}>Edit</button>
                        <button type="button" className="secondary danger-outline" aria-label={`Delete ${sound.name}`} onClick={() => { setError(null); setConfirmingDeleteId(sound.id); }}>Delete</button>
                      </>
                    )}
                  </div>
                  {confirmingDeleteId === sound.id && (
                    <div className="sound-delete-confirmation">
                      <p>Delete <strong>{sound.name}</strong> from the global library?</p>
                      <div className="actions">
                        <button type="button" className="danger" disabled={deleting} onClick={() => void confirmDelete(sound)}>
                          {deleting ? 'Deleting…' : 'Delete sound'}
                        </button>
                        <button type="button" className="secondary" disabled={deleting} onClick={() => setConfirmingDeleteId(null)}>Keep sound</button>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
