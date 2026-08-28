import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { SoundboardActionResult, SoundboardSound } from '../actions';
import SoundManager, { type ManagedSound, type SoundManagerActions } from './SoundManager';

class TestAudioContext {
  close = vi.fn(async () => undefined);

  decodeAudioData = vi.fn(async () => ({
    duration: 2,
    getChannelData: () => Float32Array.from({ length: 320 }, (_, index) => Math.sin(index / 12)),
  }));
}

const ownSound: ManagedSound = {
  id: 'sound-own',
  name: 'Launch horn',
  category: 'Reactions',
  color: '#5865f2',
  mimeType: 'audio/wav',
  sizeBytes: 1024,
  durationSec: 2,
  uploadedById: 'user-1',
  uploadedByName: 'Kai',
  shortcut: 'l',
  gainDb: 0,
  fadeInMs: 0,
  fadeOutMs: 0,
  trimStartMs: 0,
  trimEndMs: 2000,
  sortOrder: 0,
  createdAt: '2026-08-20T10:00:00.000Z',
  updatedAt: '2026-08-20T10:00:00.000Z',
  previewUrl: 'https://signed.example/own-playable',
  sourcePreviewUrl: null,
};

const otherSound: ManagedSound = {
  ...ownSound,
  id: 'sound-other',
  name: 'Airhorn',
  uploadedById: 'user-2',
  uploadedByName: 'Mina',
  shortcut: null,
  sortOrder: 1,
  previewUrl: 'https://signed.example/other-playable',
  sourcePreviewUrl: null,
};

const thirdSound: ManagedSound = {
  ...ownSound,
  id: 'sound-third',
  name: 'Cheer',
  uploadedById: 'user-3',
  uploadedByName: 'Nina',
  shortcut: null,
  sortOrder: 2,
  previewUrl: 'https://signed.example/third-playable',
};

function successfulActions(overrides: Partial<SoundManagerActions> = {}): SoundManagerActions {
  return {
    uploadSound: vi.fn(async () => ({ ok: true as const, value: ownSound as SoundboardSound })),
    updateSound: vi.fn(async () => ({ ok: true as const, value: ownSound as SoundboardSound })),
    trimSound: vi.fn(async () => ({ ok: true as const, value: ownSound as SoundboardSound })),
    deleteSound: vi.fn(async () => ({ ok: true as const })),
    reorderSounds: vi.fn(async () => ({ ok: true as const })),
    getSoundPlayableUrl: vi.fn(async () => ({ ok: true as const, value: 'https://signed.example/refreshed-playable' })),
    getSoundSourceUrl: vi.fn(async () => ({ ok: true as const, value: 'https://signed.example/refreshed-source' })),
    ...overrides,
  };
}

describe('SoundManager', () => {
  beforeEach(() => {
    vi.stubGlobal('AudioContext', TestAudioContext);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:selected-audio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob([new Uint8Array(32)], { type: 'audio/wav' }))));
  });

  test('a valid upload displays its filename and decoded waveform', async () => {
    const user = userEvent.setup();
    render(<SoundManager initialSounds={[]} currentUser={{ id: 'user-1', role: 'member' }} actions={successfulActions()} />);

    await user.upload(screen.getByLabelText('Choose MP3, WAV, or OGG file'), new File([new Uint8Array(32)], 'launch.wav', { type: 'audio/wav' }));

    expect(screen.getByText('launch.wav')).toBeInTheDocument();
    expect(await screen.findByLabelText('Audio waveform')).toBeInTheDocument();
  });

  test('an invalid upload type shows the required correction and no waveform', async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<SoundManager initialSounds={[]} currentUser={{ id: 'user-1', role: 'member' }} actions={successfulActions()} />);

    await user.upload(screen.getByLabelText('Choose MP3, WAV, or OGG file'), new File(['notes'], 'notes.txt', { type: 'text/plain' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Sound must be an MP3, WAV, or OGG file.');
    expect(screen.queryByLabelText('Audio waveform')).not.toBeInTheDocument();
  });

  test('Save trim submits integer offsets from the waveform editor', async () => {
    const actions = successfulActions();
    render(<SoundManager initialSounds={[ownSound]} currentUser={{ id: 'user-1', role: 'member' }} actions={actions} />);
    fireEvent.click(within(screen.getByTestId('sound-row-sound-own')).getByRole('button', { name: 'Edit Launch horn' }));
    const track = await screen.findByLabelText('Audio waveform');
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      bottom: 40, height: 40, left: 0, right: 100, top: 0, width: 100, x: 0, y: 0, toJSON: () => ({}),
    });
    const startHandle = screen.getByRole('slider', { name: 'Trim start' });
    fireEvent.pointerDown(startHandle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 33.333, pointerId: 1 });
    fireEvent.pointerUp(track, { pointerId: 1 });

    fireEvent.click(screen.getByRole('button', { name: 'Save trim' }));

    await waitFor(() => expect(actions.trimSound).toHaveBeenCalledWith({
      soundId: 'sound-own',
      trimStartMs: 667,
      trimEndMs: 2000,
    }));
  });

  test('requests the protected source URL only when trim editing begins', async () => {
    const actions = successfulActions();
    render(<SoundManager initialSounds={[ownSound]} currentUser={{ id: 'user-1', role: 'member' }} actions={actions} />);

    expect(actions.getSoundSourceUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Launch horn' }));

    await screen.findByLabelText('Audio waveform');
    expect(actions.getSoundSourceUrl).toHaveBeenCalledWith('sound-own');
  });

  test('does not install a stale source URL after selecting another sound', async () => {
    const sourceResolvers = new Map<string, (result: SoundboardActionResult<string>) => void>();
    const actions = successfulActions({
      getSoundSourceUrl: vi.fn((soundId): Promise<SoundboardActionResult<string>> => new Promise((resolve) => {
        sourceResolvers.set(soundId, resolve);
      })),
    });
    render(<SoundManager initialSounds={[ownSound, otherSound]} currentUser={{ id: 'admin-1', role: 'admin' }} actions={actions} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Launch horn' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Airhorn' }));
    sourceResolvers.get('sound-own')?.({ ok: true, value: 'blob:stale-source' });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(screen.queryByLabelText('Audio waveform')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Airhorn', level: 2 })).toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:stale-source');
  });

  test('uses a signed generated playable URL after upload instead of a local source URL', async () => {
    const actions = successfulActions();
    const user = userEvent.setup();
    render(<SoundManager initialSounds={[]} currentUser={{ id: 'user-1', role: 'member' }} actions={actions} />);
    await user.upload(screen.getByLabelText('Choose MP3, WAV, or OGG file'), new File([new Uint8Array(32)], 'launch.wav', { type: 'audio/wav' }));
    await screen.findByLabelText('Audio waveform');
    fireEvent.click((await screen.findAllByRole('button', { name: 'Upload sound' })).at(-1)!);

    const preview = await screen.findByLabelText('Preview Launch horn');
    expect(preview).toHaveAttribute('src', 'https://signed.example/refreshed-playable');
  });

  test('keeps a committed upload in the library when preview URL retrieval fails', async () => {
    const actions = successfulActions({
      getSoundPlayableUrl: vi.fn(async () => ({ ok: false as const, message: 'Preview service unavailable.' })),
    });
    const user = userEvent.setup();
    render(<SoundManager initialSounds={[]} currentUser={{ id: 'user-1', role: 'member' }} actions={actions} />);
    await user.upload(screen.getByLabelText('Choose MP3, WAV, or OGG file'), new File([new Uint8Array(32)], 'launch.wav', { type: 'audio/wav' }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Upload sound' })).at(-1)!);

    await waitFor(() => expect(actions.uploadSound).toHaveBeenCalledOnce());
    expect(screen.getByTestId('sound-row-sound-own')).toBeInTheDocument();
    expect(screen.queryByText('launch.wav')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Preview service unavailable.');
    expect(screen.getByRole('button', { name: 'Refresh preview for Launch horn' })).toBeInTheDocument();
  });

  test('refreshes an expired playable URL from the edit preview', async () => {
    const actions = successfulActions();
    render(<SoundManager initialSounds={[ownSound]} currentUser={{ id: 'user-1', role: 'member' }} actions={actions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Launch horn' }));
    await screen.findByLabelText('Audio waveform');

    fireEvent.error(screen.getAllByLabelText('Preview Launch horn')[0]);

    await waitFor(() => expect(actions.getSoundPlayableUrl).toHaveBeenCalledWith(ownSound.id));
    expect(screen.getAllByLabelText('Preview Launch horn')).toHaveLength(2);
    expect(screen.getAllByLabelText('Preview Launch horn')[0]).toHaveAttribute('src', 'https://signed.example/refreshed-playable');
  });

  test('members see edit and delete only for sounds they uploaded', () => {
    render(<SoundManager initialSounds={[ownSound, otherSound]} currentUser={{ id: 'user-1', role: 'member' }} actions={successfulActions()} />);

    const ownRow = screen.getByTestId('sound-row-sound-own');
    const otherRow = screen.getByTestId('sound-row-sound-other');
    expect(within(ownRow).getByRole('button', { name: 'Edit Launch horn' })).toBeInTheDocument();
    expect(within(ownRow).getByRole('button', { name: 'Delete Launch horn' })).toBeInTheDocument();
    expect(within(otherRow).queryByRole('button', { name: 'Edit Airhorn' })).not.toBeInTheDocument();
    expect(within(otherRow).queryByRole('button', { name: 'Delete Airhorn' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Move .* (up|down)/ })).not.toBeInTheDocument();
  });

  test('admins see edit, delete, and global reorder controls for every sound', () => {
    render(<SoundManager initialSounds={[ownSound, otherSound]} currentUser={{ id: 'admin-1', role: 'admin' }} actions={successfulActions()} />);

    expect(screen.getByRole('button', { name: 'Edit Launch horn' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Launch horn' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Airhorn' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Airhorn' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move Launch horn down' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move Airhorn up' })).toBeInTheDocument();
  });

  test('reorder updates the global row order after the server accepts it', async () => {
    const actions = successfulActions();
    render(<SoundManager initialSounds={[ownSound, otherSound]} currentUser={{ id: 'admin-1', role: 'admin' }} actions={actions} />);

    fireEvent.click(screen.getByRole('button', { name: 'Move Launch horn down' }));

    await waitFor(() => expect(actions.reorderSounds).toHaveBeenCalledWith(['sound-other', 'sound-own']));
    const rows = screen.getAllByTestId(/^sound-row-/);
    expect(rows.map((row) => within(row).getByRole('heading', { level: 3 }).textContent)).toEqual(['Airhorn', 'Launch horn']);
  });

  test('does not resurrect a deleted sound when an earlier reorder completes out of order', async () => {
    let resolveReorder!: (result: SoundboardActionResult) => void;
    const updatedOtherSound = { ...otherSound, name: 'Updated Airhorn' } as SoundboardSound;
    const actions = successfulActions({
      reorderSounds: vi.fn(() => new Promise<SoundboardActionResult>((resolve) => { resolveReorder = resolve; })),
      updateSound: vi.fn(async () => ({ ok: true as const, value: updatedOtherSound })),
    });
    render(<SoundManager initialSounds={[ownSound, otherSound, thirdSound]} currentUser={{ id: 'admin-1', role: 'admin' }} actions={actions} />);

    fireEvent.click(screen.getByRole('button', { name: 'Move Launch horn down' }));
    await waitFor(() => expect(actions.reorderSounds).toHaveBeenCalledWith(['sound-other', 'sound-own', 'sound-third']));

    fireEvent.click(screen.getByRole('button', { name: 'Edit Airhorn' }));
    await screen.findByLabelText('Audio waveform');
    fireEvent.change(screen.getByLabelText('Sound name'), { target: { value: 'Updated Airhorn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(actions.updateSound).toHaveBeenCalled());

    const ownRow = screen.getByTestId('sound-row-sound-own');
    fireEvent.click(within(ownRow).getByRole('button', { name: 'Delete Launch horn' }));
    fireEvent.click(within(ownRow).getByRole('button', { name: 'Delete sound' }));
    await waitFor(() => expect(screen.queryByTestId('sound-row-sound-own')).not.toBeInTheDocument());

    resolveReorder({ ok: true });

    await waitFor(() => {
      const rows = screen.getAllByTestId(/^sound-row-/);
      expect(rows.map((row) => within(row).getByRole('heading', { level: 3 }).textContent)).toEqual(['Updated Airhorn', 'Cheer']);
    });
    expect(screen.queryByTestId('sound-row-sound-own')).not.toBeInTheDocument();
  });

  test('delete requires the explicit Delete sound confirmation', async () => {
    const actions = successfulActions();
    render(<SoundManager initialSounds={[ownSound]} currentUser={{ id: 'user-1', role: 'member' }} actions={actions} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Launch horn' }));
    expect(actions.deleteSound).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete sound' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep sound' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete sound' }));
    await waitFor(() => expect(actions.deleteSound).toHaveBeenCalledWith('sound-own'));
    expect(screen.queryByText('Launch horn')).not.toBeInTheDocument();
  });

  test('focuses the first remaining result after deleting the sound being edited', async () => {
    const actions = successfulActions();
    render(<SoundManager initialSounds={[ownSound, otherSound]} currentUser={{ id: 'admin-1', role: 'admin' }} actions={actions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Launch horn' }));
    await screen.findByLabelText('Audio waveform');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Launch horn' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete sound' }));

    await waitFor(() => expect(screen.getByTestId('sound-row-sound-other')).toHaveFocus());
  });

  test('focuses the next surviving row after deleting a non-edited sound', async () => {
    const actions = successfulActions();
    render(<SoundManager initialSounds={[ownSound, otherSound, thirdSound]} currentUser={{ id: 'admin-1', role: 'admin' }} actions={actions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Launch horn' }));
    await screen.findByLabelText('Audio waveform');

    fireEvent.click(screen.getByRole('button', { name: 'Delete Airhorn' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete sound' }));

    await waitFor(() => expect(screen.getByTestId('sound-row-sound-third')).toHaveFocus());
    expect(within(screen.getByTestId('sound-row-sound-own')).getByRole('heading', { name: 'Launch horn' })).toBeInTheDocument();
  });

  test('applies overlapping deletes to the latest library state and focuses the latest survivor', async () => {
    const deleteResolvers = new Map<string, (result: SoundboardActionResult) => void>();
    const actions = successfulActions({
      deleteSound: vi.fn((soundId): Promise<SoundboardActionResult> => new Promise((resolve) => {
        deleteResolvers.set(soundId, resolve);
      })),
    });
    render(<SoundManager initialSounds={[ownSound, otherSound, thirdSound]} currentUser={{ id: 'admin-1', role: 'admin' }} actions={actions} />);

    const ownRow = screen.getByTestId('sound-row-sound-own');
    const otherRow = screen.getByTestId('sound-row-sound-other');
    fireEvent.click(within(ownRow).getByRole('button', { name: 'Delete Launch horn' }));
    fireEvent.click(within(ownRow).getByRole('button', { name: 'Delete sound' }));
    fireEvent.click(within(otherRow).getByRole('button', { name: 'Delete Airhorn' }));
    fireEvent.click(within(otherRow).getByRole('button', { name: 'Delete sound' }));

    deleteResolvers.get('sound-other')?.({ ok: true });
    deleteResolvers.get('sound-own')?.({ ok: true });

    await waitFor(() => expect(screen.queryByTestId('sound-row-sound-other')).not.toBeInTheDocument());
    expect(screen.queryByTestId('sound-row-sound-own')).not.toBeInTheDocument();
    expect(screen.getByTestId('sound-row-sound-third')).toHaveFocus();
  });

  test('keeps delete retryable when the server action rejects', async () => {
    const actions = successfulActions({
      deleteSound: vi.fn(async () => {
        throw new Error('Network unavailable');
      }),
    });
    render(<SoundManager initialSounds={[ownSound]} currentUser={{ id: 'user-1', role: 'member' }} actions={actions} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Launch horn' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete sound' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not delete the sound. Try again.');
    expect(screen.getByRole('button', { name: 'Delete sound' })).toBeEnabled();
    expect(within(screen.getByTestId('sound-row-sound-own')).getByRole('heading', { name: 'Launch horn' })).toBeInTheDocument();
  });

  test('a trim failure keeps the previously saved sound and playable preview', async () => {
    const actions = successfulActions({ trimSound: vi.fn(async () => ({ ok: false as const, message: 'Processing failed. Try again.' })) });
    render(<SoundManager initialSounds={[ownSound]} currentUser={{ id: 'user-1', role: 'member' }} actions={actions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Launch horn' }));
    await screen.findByLabelText('Audio waveform');

    fireEvent.click(screen.getByRole('button', { name: 'Save trim' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Processing failed. Try again.');
    expect(screen.getByText('2.00 s')).toBeInTheDocument();
    expect(within(screen.getByTestId('sound-row-sound-own')).getByLabelText('Preview Launch horn')).toHaveAttribute('src', ownSound.previewUrl);
    expect(screen.getByRole('button', { name: 'Save trim' })).toBeEnabled();
  });

  test('tracks overlapping metadata and trim requests independently', async () => {
    let resolveUpdate!: (result: { ok: true; value: SoundboardSound }) => void;
    let resolveTrim!: (result: { ok: true; value: SoundboardSound }) => void;
    const actions = successfulActions({
      updateSound: vi.fn(() => new Promise<SoundboardActionResult<SoundboardSound>>((resolve) => { resolveUpdate = resolve; })),
      trimSound: vi.fn(() => new Promise<SoundboardActionResult<SoundboardSound>>((resolve) => { resolveTrim = resolve; })),
    });
    render(<SoundManager initialSounds={[ownSound]} currentUser={{ id: 'user-1', role: 'member' }} actions={actions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Launch horn' }));
    await screen.findByLabelText('Audio waveform');

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('button', { name: 'Saving details…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save trim' }));

    expect(screen.getByRole('button', { name: 'Saving details…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Processing trim…' })).toBeDisabled();

    resolveUpdate({ ok: true, value: ownSound });
    resolveTrim({ ok: true, value: ownSound });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
  });
});
