/**
 * ducking.ts — Shared coordination between the TTS "speak" session and the
 * music player, both of which want the single per-guild voice connection.
 *
 * `@discordjs/voice` allows only one voice connection per guild, and a
 * connection plays from one subscribed `AudioPlayer` at a time. When TTS needs
 * to speak over active music we therefore "duck": pause the music player and
 * let it re-subscribe + resume once TTS is done.
 *
 * This tiny registry decouples the two modules so neither imports the other
 * (which would be a require cycle). The music session registers callbacks under
 * its guildId; the TTS session calls `duck()` / `resume()` around playback.
 */

/** Callbacks a music session exposes so TTS can pause/resume it. */
export interface Duckable {
  /** Pause music (TTS is about to speak). */
  pause: () => void;
  /** Re-subscribe + unpause music (TTS finished). */
  resume: () => void;
}

const registry = new Map<string, Duckable>();

/** A music session announces it owns the connection for `guildId`. */
export function registerDuckable(guildId: string, handlers: Duckable): void {
  registry.set(guildId, handlers);
}

/** A music session relinquishes the connection (stopped / left). */
export function unregisterDuckable(guildId: string): void {
  registry.delete(guildId);
}

/** Is music currently holding the connection in this guild? */
export function isMusicActive(guildId: string): boolean {
  return registry.has(guildId);
}

/** Pause music so TTS can speak. No-op when no music is active. */
export function duck(guildId: string): void {
  registry.get(guildId)?.pause();
}

/** Resume music after TTS finishes. No-op when no music is active. */
export function resume(guildId: string): void {
  registry.get(guildId)?.resume();
}
