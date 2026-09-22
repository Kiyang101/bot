import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import SpeakForm from './SpeakForm';
import { speak, previewSpeak, leaveVoice } from '../actions';

vi.mock('../actions', () => ({ speak: vi.fn(), previewSpeak: vi.fn(), leaveVoice: vi.fn() }));
beforeEach(() => {
  vi.mocked(speak).mockReset().mockResolvedValue({ ok: true, message: 'Sent', spoken: 'こんにちは' });
  vi.mocked(previewSpeak).mockReset().mockResolvedValue({ ok: true, message: 'Preview', spoken: 'こんにちは', audioBase64: 'YQ==', contentType: 'audio/wav' });
  vi.mocked(leaveVoice).mockReset().mockResolvedValue({ ok: true, message: 'Left' });
});

const voices = [{ id: '3', name: 'Zundamon' }];
function message() { fireEvent.change(screen.getByLabelText('ข้อความที่ต้องการให้บอทพูด'), { target: { value: 'สวัสดี' } }); }

test('previews Japanese translation with automatic channel selection and displays spoken text', async () => {
  render(<SpeakForm channels={[]} voicevoxVoices={voices} />);
  message();
  expect(screen.getByLabelText('ห้องเสียงปลายทาง')).toHaveValue('');
  expect(screen.getByRole('button', { name: 'ส่งเสียงเข้าห้อง' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'ทดลองฟัง' }));
  await screen.findByText('こんにちは');
  expect(previewSpeak).toHaveBeenCalledWith(expect.objectContaining({ provider: 'voicevox', translate: true, text: 'สวัสดี', channelId: '' }));
  expect(speak).not.toHaveBeenCalled();
  expect(screen.getByLabelText('เสียงตัวอย่าง')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('ข้อความที่ต้องการให้บอทพูด'), { target: { value: 'ข้อความใหม่' } });
  expect(screen.queryByText('こんにちは')).not.toBeInTheDocument();
});

test('sends with automatic current-channel choice when no room is selected', async () => {
  render(<SpeakForm channels={[{ id: 'room', name: 'General' }]} voicevoxVoices={voices} />);
  message();
  fireEvent.click(screen.getByRole('button', { name: 'ส่งเสียงเข้าห้อง' }));
  await waitFor(() => expect(speak).toHaveBeenCalledWith(expect.objectContaining({ channelId: '', text: 'สวัสดี' })));
});

test('changing engine clears speaker and Japanese translation settings from request', async () => {
  render(<SpeakForm channels={[{ id: 'room', name: 'General' }]} voicevoxVoices={voices} />);
  message();
  fireEvent.change(screen.getByLabelText('เสียง / ตัวละคร'), { target: { value: '3' } });
  fireEvent.change(screen.getByLabelText('เอนจินเสียง'), { target: { value: 'google' } });
  expect(screen.getByLabelText('ภาษาที่อ่าน')).toHaveValue('th');
  fireEvent.change(screen.getByLabelText('ห้องเสียงปลายทาง'), { target: { value: 'room' } });
  fireEvent.click(screen.getByRole('button', { name: 'ส่งเสียงเข้าห้อง' }));
  await waitFor(() => expect(speak).toHaveBeenCalledWith(expect.objectContaining({ provider: 'google', voice: 'th', translate: undefined, speed: undefined, channelId: 'room' })));
});

test('raw Japanese and default VOICEVOX preserve explicit reading choice', async () => {
  render(<SpeakForm channels={[]} voicevoxVoices={voices} defaultProvider="voicevox" />);
  message();
  fireEvent.change(screen.getByLabelText('เอนจินเสียง'), { target: { value: 'default' } });
  fireEvent.change(screen.getByLabelText('การอ่านภาษาญี่ปุ่น'), { target: { value: 'raw' } });
  fireEvent.click(screen.getByRole('button', { name: 'ทดลองฟัง' }));
  await waitFor(() => expect(previewSpeak).toHaveBeenCalledWith(expect.objectContaining({ provider: 'default', translate: false })));
});

test('pending preview locks editing and failures keep message available for retry', async () => {
  let resolve!: (value: { ok: boolean; message: string }) => void;
  vi.mocked(previewSpeak).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  render(<SpeakForm channels={[]} voicevoxVoices={voices} />);
  message();
  fireEvent.click(screen.getByRole('button', { name: 'ทดลองฟัง' }));
  expect(screen.getByLabelText('เอนจินเสียง')).toBeDisabled();
  resolve({ ok: false, message: 'Translation unavailable' });
  await screen.findByRole('alert');
  expect(screen.getByLabelText('ข้อความที่ต้องการให้บอทพูด')).toHaveValue('สวัสดี');
  expect(screen.getByRole('button', { name: 'ทดลองฟัง' })).toBeEnabled();
});
