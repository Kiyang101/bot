import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import WaveformEditor from './WaveformEditor';

const source = new File([new Uint8Array(32)], 'launch.wav', { type: 'audio/wav' });

class TestAudioContext {
  close = vi.fn(async () => undefined);

  decodeAudioData = vi.fn(async () => ({
    duration: 2,
    getChannelData: () => Float32Array.from({ length: 640 }, (_, index) => Math.sin(index / 10)),
  }));
}

describe('WaveformEditor', () => {
  beforeEach(() => {
    vi.stubGlobal('AudioContext', TestAudioContext);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:waveform-source');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  test('decodes the source and renders no more than 160 waveform bars', async () => {
    render(<WaveformEditor source={source} onRangeChange={vi.fn()} />);

    expect(await screen.findByLabelText('Audio waveform')).toBeInTheDocument();
    expect(screen.getAllByTestId('waveform-bar')).toHaveLength(160);
  });

  test('rejects decoded sources shorter than the minimum clip length', async () => {
    class ShortAudioContext extends TestAudioContext {
      override decodeAudioData = vi.fn(async () => ({
        duration: 0.05,
        getChannelData: () => new Float32Array(16),
      }));
    }
    vi.stubGlobal('AudioContext', ShortAudioContext);

    render(<WaveformEditor source={source} onRangeChange={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Sound clips must be at least 100 ms long.');
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  test('dragging a handle updates the selected duration with integer offsets', async () => {
    const onRangeChange = vi.fn();
    render(<WaveformEditor source={source} onRangeChange={onRangeChange} />);
    const track = await screen.findByLabelText('Audio waveform');
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      bottom: 40,
      height: 40,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const startHandle = screen.getByRole('slider', { name: 'Trim start' });
    fireEvent.pointerDown(startHandle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 33.333, pointerId: 1 });
    fireEvent.pointerUp(track, { pointerId: 1 });

    expect(screen.getByText('1.33 s selected')).toBeInTheDocument();
    expect(onRangeChange).toHaveBeenLastCalledWith({ startMs: 667, endMs: 2000, durationMs: 2000 });
  });

  test('arrow keys adjust handles and keep slider ARIA values current', async () => {
    render(<WaveformEditor source={source} initialStartMs={200} initialEndMs={1800} onRangeChange={vi.fn()} />);
    const startHandle = await screen.findByRole('slider', { name: 'Trim start' });

    fireEvent.keyDown(startHandle, { key: 'ArrowRight' });

    expect(startHandle).toHaveAttribute('aria-valuemin', '0');
    expect(startHandle).toHaveAttribute('aria-valuemax', '1700');
    expect(startHandle).toHaveAttribute('aria-valuenow', '300');
    expect(screen.getByText('1.50 s selected')).toBeInTheDocument();
  });

  test('preview starts at the trim boundary and stops at the selected end', async () => {
    const listeners = new Map<string, EventListener>();
    const audio = {
      currentTime: 0,
      pause: vi.fn(),
      play: vi.fn(async () => undefined),
      addEventListener: vi.fn((name: string, listener: EventListener) => listeners.set(name, listener)),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('Audio', vi.fn(() => audio));
    render(<WaveformEditor source={source} initialStartMs={400} initialEndMs={900} onRangeChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Preview selection' }));
    expect(audio.currentTime).toBe(0.4);
    expect(audio.play).toHaveBeenCalledOnce();

    audio.currentTime = 0.91;
    listeners.get('timeupdate')?.(new Event('timeupdate'));
    await waitFor(() => expect(audio.pause).toHaveBeenCalledOnce());
  });

  test('keeps the waveform usable when browser preview cannot start', async () => {
    const audio = {
      currentTime: 0,
      pause: vi.fn(),
      play: vi.fn(async () => {
        throw new Error('Playback blocked');
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('Audio', vi.fn(() => audio));
    render(<WaveformEditor source={source} onRangeChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Preview selection' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Preview could not start. Check your browser audio settings.');
    expect(screen.getByLabelText('Audio waveform')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview selection' })).toBeEnabled();
  });
});
