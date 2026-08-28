import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import type { MusicState } from '@/lib/control';
import type { SoundboardActionResult, SoundboardSound } from './actions';
import Soundboard, { type SoundboardActions } from './Soundboard';

const musicState: MusicState = {
  current: null,
  queue: [],
  loop: 'off',
  effect: 'off',
  intensity: 50,
  volume: 80,
  positionSec: 0,
  playbackRate: 1,
  paused: false,
  channelName: null,
};

const launchHorn: SoundboardSound = {
  id: 'sound-launch',
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
};

const airhorn: SoundboardSound = {
  ...launchHorn,
  id: 'sound-airhorn',
  name: 'Airhorn',
  category: 'Memes',
  uploadedById: 'user-2',
  uploadedByName: 'Mina',
  shortcut: null,
  sortOrder: 1,
};

function successfulActions(overrides: Partial<SoundboardActions> = {}): SoundboardActions {
  return {
    playSound: vi.fn(async () => ({ ok: true as const, value: launchHorn })),
    stopSound: vi.fn(async () => ({ ok: true as const })),
    getSoundPlayableUrl: vi.fn(async () => ({ ok: true as const, value: 'https://signed.example/playable' })),
    ...overrides,
  };
}

function renderBoard(
  options: {
    sounds?: SoundboardSound[];
    selectedGuildId?: string | null;
    actions?: SoundboardActions;
  } = {},
) {
  return render(
    <Soundboard
      sounds={options.sounds ?? [launchHorn, airhorn]}
      currentUser={{ id: 'user-1', username: 'Kai', role: 'member' }}
      selectedGuildId={options.selectedGuildId === undefined ? 'guild-1' : options.selectedGuildId}
      guildName="Studio"
      channels={[{ id: 'channel-1', name: 'Broadcast' }]}
      initialMusicState={musicState}
      botStatus="RUNNING"
      actions={options.actions ?? successfulActions()}
    />,
  );
}

describe('Soundboard', () => {
  test('filters pads by name, category, and uploader', async () => {
    const user = userEvent.setup();
    renderBoard();

    await user.type(screen.getByRole('searchbox', { name: 'Search sounds' }), 'mina');
    expect(screen.getByRole('button', { name: /^Play Airhorn/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Play Launch horn/ })).not.toBeInTheDocument();

    await user.clear(screen.getByRole('searchbox', { name: 'Search sounds' }));
    await user.click(screen.getByRole('button', { name: 'Reactions' }));
    expect(screen.getByRole('button', { name: /^Play Launch horn/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Play Airhorn/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Uploaded by me' }));
    expect(screen.getByRole('button', { name: /^Play Launch horn/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Play Airhorn/ })).not.toBeInTheDocument();
  });

  test('makes one play call per pad activation and disables other pads while active', async () => {
    const user = userEvent.setup();
    const actions = successfulActions();
    renderBoard({ actions });

    await user.click(screen.getByRole('button', { name: /^Play Launch horn/ }));

    expect(actions.playSound).toHaveBeenCalledTimes(1);
    expect(actions.playSound).toHaveBeenCalledWith({ soundId: launchHorn.id, channelId: 'channel-1' });
    expect(screen.getByRole('button', { name: /^Play Airhorn/ })).toBeDisabled();
    expect(screen.getByText('Playing.')).toBeInTheDocument();
  });

  test('keeps the active pad and announces a busy response', async () => {
    const user = userEvent.setup();
    const actions = successfulActions({
      playSound: vi.fn()
        .mockResolvedValueOnce({ ok: true as const, value: launchHorn })
        .mockResolvedValueOnce({ ok: false as const, message: 'Soundboard is busy — wait for the current sound to finish.' }),
    });
    renderBoard({ actions });

    await user.click(screen.getByRole('button', { name: /^Play Launch horn/ }));
    await user.click(screen.getByRole('button', { name: /^Play Launch horn/ }));

    expect(await screen.findByText('Soundboard is busy — wait for the current sound to finish.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Play Launch horn/ })).toHaveAttribute('aria-pressed', 'true');
  });

  test('stop sound calls the selected channel and clears the active dock', async () => {
    const user = userEvent.setup();
    const actions = successfulActions();
    renderBoard({ actions });

    await user.click(screen.getByRole('button', { name: /^Play Launch horn/ }));
    await user.click(screen.getByRole('button', { name: 'Stop sound' }));

    expect(actions.stopSound).toHaveBeenCalledWith('channel-1');
    expect(screen.getByText('No sound playing')).toBeInTheDocument();
  });

  test('allows preview without a selected guild but disables Discord playback', async () => {
    const user = userEvent.setup();
    const actions = successfulActions();
    renderBoard({ selectedGuildId: null, actions });

    expect(screen.getByText('Select a Discord server before playing sounds')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Play Launch horn/ })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Preview Launch horn' }));
    expect(actions.getSoundPlayableUrl).toHaveBeenCalledWith(launchHorn.id);
    expect(actions.playSound).not.toHaveBeenCalled();
    await waitFor(() => expect(document.querySelector('audio')).toHaveAttribute('src', 'https://signed.example/playable'));
  });

  test('uses native button keyboard activation for a pad', async () => {
    const user = userEvent.setup();
    const actions = successfulActions();
    renderBoard({ actions });

    const pad = screen.getByRole('button', { name: /^Play Airhorn/ });
    pad.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(actions.playSound).toHaveBeenCalledWith({ soundId: airhorn.id, channelId: 'channel-1' }));
  });

  test('renders an empty state when filters remove every sound', async () => {
    const user = userEvent.setup();
    renderBoard();

    await user.type(screen.getByRole('searchbox', { name: 'Search sounds' }), 'does-not-exist');
    expect(screen.getByText('No sounds match your filters')).toBeInTheDocument();
  });
});
