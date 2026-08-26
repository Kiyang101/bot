/**
 * Spotify metadata integration.
 *
 * Spotify does not provide downloadable audio. This module only reads track
 * metadata and hands a title/artist search to the existing YouTube resolver;
 * playback therefore continues to use the bot's normal YouTube/yt-dlp path.
 */

import type { Track } from './types';
import { search } from './ytdlp';

const API_URL = 'https://api.spotify.com/v1';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const DEFAULT_MAX_IMPORT = 50;

type SpotifyReference =
  | { type: 'track' | 'playlist' | 'album'; id: string; url: string }
  | { type: 'liked'; url: string };

interface SpotifyArtist {
  name?: string;
}

interface SpotifyTrack {
  name?: string;
  artists?: SpotifyArtist[];
  duration_ms?: number;
  external_urls?: { spotify?: string };
  type?: string;
}

interface SpotifyItem {
  item?: SpotifyTrack | null;
  track?: SpotifyTrack | null;
}

interface SpotifyPage<T> {
  items?: T[];
  next?: string | null;
  total?: number;
}

interface SpotifyTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
}

let cachedToken: { value: string; expiresAt: number; user: boolean } | null = null;

function configured(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function maxImport(): number {
  const value = Number.parseInt(configured('SPOTIFY_MAX_TRACKS') ?? '', 10);
  return Number.isFinite(value) ? Math.max(1, Math.min(value, 100)) : DEFAULT_MAX_IMPORT;
}

function spotifyUrl(type: string, id: string): string {
  return `https://open.spotify.com/${type}/${id}`;
}

/** Recognize Spotify links, Spotify URIs, and the liked-songs shortcut. */
export function parseSpotifyInput(input: string): SpotifyReference | null {
  const value = input.trim();
  if (/^(spotify[\s:_-]*)?(liked|likes|liked songs|your music)$/i.test(value)) {
    return { type: 'liked', url: 'https://open.spotify.com/collection/tracks' };
  }

  const uri = /^spotify:(track|playlist|album):([A-Za-z0-9]+)$/i.exec(value);
  if (uri) {
    const type = uri[1].toLowerCase() as 'track' | 'playlist' | 'album';
    return { type, id: uri[2], url: spotifyUrl(type, uri[2]) };
  }

  try {
    const parsed = new URL(value);
    if (!/(^|\.)open\.spotify\.com$/i.test(parsed.hostname)) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && ['track', 'playlist', 'album'].includes(parts[0].toLowerCase())) {
      const type = parts[0].toLowerCase() as 'track' | 'playlist' | 'album';
      const id = parts[1];
      if (/^[A-Za-z0-9]+$/.test(id)) return { type, id, url: spotifyUrl(type, id) };
    }
  } catch {
    /* Not a URL; normal YouTube search handling will deal with it. */
  }
  return null;
}

function authConfig(): { clientId: string; clientSecret: string } {
  const clientId = configured('SPOTIFY_CLIENT_ID');
  const clientSecret = configured('SPOTIFY_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new Error(
      'Spotify support needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env.',
    );
  }
  return { clientId, clientSecret };
}

async function getAccessToken(needsUser: boolean): Promise<string> {
  const { clientId, clientSecret } = authConfig();
  const refreshToken = configured('SPOTIFY_REFRESH_TOKEN');
  if (needsUser && !refreshToken) {
    throw new Error(
      'Spotify Liked Songs needs SPOTIFY_REFRESH_TOKEN with the user-library-read scope.',
    );
  }

  if (
    cachedToken &&
    cachedToken.expiresAt > Date.now() + 30_000 &&
    (!needsUser || cachedToken.user)
  ) {
    return cachedToken.value;
  }

  const body = refreshToken
    ? new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
    : new URLSearchParams({ grant_type: 'client_credentials' });
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = (await response.json().catch(() => ({}))) as SpotifyTokenResponse & {
    error_description?: string;
  };
  if (!response.ok || !data.access_token) {
    throw new Error(`Spotify authentication failed: ${data.error_description ?? response.statusText}`);
  }

  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    user: !!refreshToken,
  };
  return data.access_token;
}

async function spotifyFetch<T>(url: string, needsUser = false): Promise<T> {
  const token = await getAccessToken(needsUser);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(`Spotify request failed: ${data.error?.message ?? response.statusText}`);
  }
  return data;
}

function marketParams(): string {
  const market = configured('SPOTIFY_MARKET');
  return market ? `&market=${encodeURIComponent(market)}` : '';
}

async function getPage<T>(path: string, needsUser: boolean, limit: number): Promise<T[]> {
  const items: T[] = [];
  let url: string | null = `${API_URL}${path}${path.includes('?') ? '&' : '?'}limit=50&offset=0${marketParams()}`;
  while (url && items.length < limit) {
    const page: SpotifyPage<T> = await spotifyFetch<SpotifyPage<T>>(url, needsUser);
    items.push(...(page.items ?? []).slice(0, limit - items.length));
    url = page.next ?? null;
  }
  return items;
}

function asTrack(item: SpotifyTrack | SpotifyItem | null | undefined): SpotifyTrack | null {
  if (!item) return null;
  if ('item' in item) return item.item ?? null;
  if ('track' in item) return item.track ?? null;
  return item as SpotifyTrack;
}

async function getSpotifyTracks(reference: SpotifyReference): Promise<SpotifyTrack[]> {
  const limit = maxImport();
  if (reference.type === 'track') {
    const track = await spotifyFetch<SpotifyTrack>(`${API_URL}/tracks/${reference.id}${marketParams().replace('&', '?')}`);
    return [track];
  }
  if (reference.type === 'album') {
    const items = await getPage<SpotifyTrack>(`/albums/${reference.id}/tracks`, false, limit);
    return items.map(asTrack).filter((track): track is SpotifyTrack => !!track);
  }
  if (reference.type === 'playlist') {
    const items = await getPage<SpotifyItem>(`/playlists/${reference.id}/items`, false, limit);
    return items.map(asTrack).filter((track): track is SpotifyTrack => !!track);
  }
  const items = await getPage<SpotifyItem>('/me/tracks', true, limit);
  return items.map(asTrack).filter((track): track is SpotifyTrack => !!track);
}

/** Resolve a Spotify link/shortcut into playable YouTube-backed tracks. */
export async function resolveSpotify(
  reference: SpotifyReference,
  requestedById: string,
  requestedByTag: string,
): Promise<{ tracks: Track[]; kind: 'spotify-track' | 'spotify-playlist' | 'spotify-liked'; label: string }> {
  const spotifyTracks = await getSpotifyTracks(reference);
  const tracks: Track[] = [];

  for (const spotifyTrack of spotifyTracks) {
    const name = spotifyTrack.name?.trim();
    const artists = (spotifyTrack.artists ?? []).map((artist) => artist.name?.trim()).filter(Boolean);
    if (!name) continue;
    const matches = await search(`${artists.join(' ')} ${name}`, requestedById, requestedByTag, 1);
    if (matches[0]) tracks.push(matches[0]);
  }

  const kind = reference.type === 'track' ? 'spotify-track' : reference.type === 'liked' ? 'spotify-liked' : 'spotify-playlist';
  const label = reference.type === 'liked' ? 'Spotify Liked Songs' : `Spotify ${reference.type}`;
  return { tracks, kind, label };
}
