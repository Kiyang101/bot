import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import EntranceForm from './EntranceForm';

const sounds = [
  { id: 'short', name: 'Welcome', durationSec: 2 },
  { id: 'long', name: 'Long recording', durationSec: 8 },
  { id: 'unknown', name: 'Unknown recording', durationSec: null },
];

describe('EntranceForm', () => {
  test('shows eligible sounds and saves the explicit opt-in', async () => {
    const save = vi.fn().mockResolvedValue({ ok: true, message: 'Saved.' });
    const preview = vi.fn();
    const user = userEvent.setup();
    render(<EntranceForm preference={{ enabled: false, soundId: null }} sounds={sounds} guildName="Studio" save={save} preview={preview} />);
    expect(screen.getByRole('heading', { name: 'Settings for Studio' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Long recording/ })).toBeDisabled();
    expect(screen.getByRole('option', { name: /Unknown recording/ })).toBeDisabled();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Entrance sound' }), 'short');
    await user.click(screen.getByRole('checkbox', { name: 'Enable my entrance sound' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ enabled: true, soundId: 'short' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    expect(preview).not.toHaveBeenCalled();
  });

  test('reports a deleted selection and offers the Soundboard manager', () => {
    render(<EntranceForm preference={{ enabled: true, soundId: 'deleted' }} sounds={[]} guildName="Studio" save={vi.fn()} preview={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Selected sound is no longer available');
    expect(screen.getByText(/No short sounds available/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Manage sounds|Upload or trim a clip/ }).length).toBeGreaterThan(0);
  });

  test('preview requests a browser URL without saving or invoking Discord playback', async () => {
    const preview = vi.fn().mockResolvedValue({ ok: false, message: 'Preview unavailable.' });
    const save = vi.fn();
    const user = userEvent.setup();
    render(<EntranceForm preference={{ enabled: false, soundId: 'short' }} sounds={sounds} guildName="Studio" save={save} preview={preview} />);
    await user.click(screen.getByRole('button', { name: 'Preview in browser' }));
    await waitFor(() => expect(preview).toHaveBeenCalledWith('short'));
    expect(save).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent('Preview unavailable.');
  });

  test('saves speech and previews only the saved asset', async () => {
    const save = vi.fn().mockResolvedValue({ ok: true, message: 'Entrance speech saved.' });
    const previewSpeech = vi.fn().mockResolvedValue({ ok: false, message: 'Preview unavailable.' });
    const user = userEvent.setup();
    render(<EntranceForm preference={{ enabled: false, soundId: null }} sounds={sounds} guildName="Studio" save={save} preview={vi.fn()} previewSpeech={previewSpeech} googleVoices={[{ id: 'en', name: 'English' }, { id: 'th', name: 'Thai' }]} />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Entrance type' }), 'speech');
    await user.type(screen.getByRole('textbox', { name: 'Entrance speech' }), 'Hello');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'en');
    expect(screen.getByRole('button', { name: 'Preview in browser' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ enabled: false, mode: 'speech', speechText: 'Hello', speechProvider: 'google', speechVoice: 'en' }));
    await user.click(screen.getByRole('button', { name: 'Preview in browser' }));
    expect(previewSpeech).toHaveBeenCalledTimes(1);
  });
});
