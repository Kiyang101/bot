/**
 * audio.ts — PCM to WAV conversion utility
 * Writes a standard 44-byte WAV header and concatenates the raw PCM data.
 * No external dependencies — header is constructed manually.
 */

/**
 * Wraps a raw PCM buffer in a WAV container.
 *
 * @param pcm      Raw PCM audio data
 * @param rate     Sample rate in Hz (default: 48000 — Discord's native rate)
 * @param channels Number of audio channels (default: 2 — stereo)
 * @param bits     Bits per sample (default: 16)
 * @returns        A Buffer containing a valid WAV file
 */
export function pcmToWav(pcm: Buffer, rate = 48000, channels = 2, bits = 16): Buffer {
  const byteRate = (rate * channels * bits) / 8;
  const blockAlign = (channels * bits) / 8;
  const dataSize = pcm.length;
  // RIFF chunk size = 4 (WAVE) + 24 (fmt  subchunk) + 8 (data header) + dataSize
  const chunkSize = 4 + 24 + 8 + dataSize;

  const header = Buffer.alloc(44);
  let offset = 0;

  // RIFF chunk descriptor
  header.write('RIFF', offset, 'ascii');          offset += 4;
  header.writeUInt32LE(chunkSize, offset);         offset += 4;
  header.write('WAVE', offset, 'ascii');           offset += 4;

  // fmt  sub-chunk
  header.write('fmt ', offset, 'ascii');           offset += 4;
  header.writeUInt32LE(16, offset);                offset += 4; // PCM fmt chunk size = 16
  header.writeUInt16LE(1, offset);                 offset += 2; // AudioFormat: PCM = 1
  header.writeUInt16LE(channels, offset);          offset += 2;
  header.writeUInt32LE(rate, offset);              offset += 4;
  header.writeUInt32LE(byteRate, offset);          offset += 4;
  header.writeUInt16LE(blockAlign, offset);        offset += 2;
  header.writeUInt16LE(bits, offset);              offset += 2;

  // data sub-chunk
  header.write('data', offset, 'ascii');           offset += 4;
  header.writeUInt32LE(dataSize, offset);          // offset += 4 (last field)

  return Buffer.concat([header, pcm]);
}
