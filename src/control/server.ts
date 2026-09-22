/**
 * control/server.ts — Local HTTP control endpoint for the bot.
 *
 * Lets the web dashboard (a separate process) tell the running bot to speak
 * in a voice channel. Bound to 127.0.0.1 only and guarded by a shared secret
 * (`BOT_CONTROL_SECRET`) — it is NOT meant to be exposed to the internet.
 *
 *   POST /speak
 *   headers: { 'x-control-secret': <BOT_CONTROL_SECRET>, 'content-type': 'application/json' }
 *   body: { guildId, channelId? or userId?, text, voice?, provider?, translate? }
 */

import http from 'node:http';
import type { Client } from 'discord.js';
import { assertSupabaseResult } from '../infrastructure/database';
import { getSupabaseAdmin } from '../infrastructure/supabase';
import { readBody, sendJson, sniffAudioMime } from './http';
import { handleSpeak, handlePreview, handleLeave, type SpeakBody } from './handlers/voice';
import { handleMusic, getMusicState, type MusicBody } from './handlers/music';
import { handleSoundboard, soundboardErrorResponse, type SoundboardBody } from './handlers/soundboard';

/** Start the local control HTTP server. No-op if BOT_CONTROL_PORT is "0"/"off". */
export function startControlServer(client: Client, onStop: () => void): void {
  const portRaw = process.env.BOT_CONTROL_PORT ?? '8787';
  if (portRaw === '0' || portRaw.toLowerCase() === 'off') {
    console.log('[control] disabled (BOT_CONTROL_PORT=0)');
    return;
  }
  const port = Number(portRaw);
  const secret = process.env.BOT_CONTROL_SECRET ?? '';
  if (!secret) {
    console.warn(
      '[control] BOT_CONTROL_SECRET is not set — the control endpoint will reject all requests. ' +
        'Set the same secret here and in the dashboard.',
    );
  }

  const authorized = (req: http.IncomingMessage): boolean =>
    !!secret && req.headers['x-control-secret'] === secret;

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '';
    const path = url.split('?')[0];

    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && path === '/status') {
      if (!authorized(req)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      try {
        const runtime = assertSupabaseResult(
          'read BotRuntime',
          await getSupabaseAdmin().from('BotRuntime').select('*').eq('id', 1).maybeSingle(),
        );
        sendJson(res, 200, { ok: true, runtime });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'database unavailable' });
      }
      return;
    }

    // Live music state for the dashboard (polled). Secret-guarded.
    if (req.method === 'GET' && path === '/music/state') {
      if (!authorized(req)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      try {
        const guildId = new URL(url, 'http://localhost').searchParams.get('guildId') ?? '';
        sendJson(res, 200, { ok: true, state: getMusicState(guildId) });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'unknown error' });
      }
      return;
    }

    const postRoutes = [
      '/speak',
      '/leave',
      '/music',
      '/preview',
      '/lifecycle',
      '/soundboard/play',
      '/soundboard/stop',
    ];
    if (req.method !== 'POST' || !postRoutes.includes(path)) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}') as SpeakBody & MusicBody & SoundboardBody;
      if (path === '/lifecycle') {
        if (body.action !== 'stop') throw new Error('unsupported lifecycle action');
        sendJson(res, 202, { ok: true, status: 'STOPPING' });
        setImmediate(onStop);
        return;
      }
      if (path === '/leave') {
        handleLeave(body);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (path === '/music') {
        const result = await handleMusic(client, body);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      if (path === '/soundboard/play' || path === '/soundboard/stop') {
        const result = await handleSoundboard(
          client,
          body,
          path === '/soundboard/play' ? 'play' : 'stop',
        );
        sendJson(res, 200, result);
        return;
      }
      if (path === '/preview') {
        const { audio, spoken } = await handlePreview(body);
        res.writeHead(200, {
          'Content-Type': sniffAudioMime(audio),
          'Content-Length': audio.length,
          // The (possibly translated) spoken text, URL-encoded so it's header-safe.
          'x-spoken': encodeURIComponent(spoken),
        });
        res.end(audio);
        return;
      }
      const result = await handleSpeak(client, body);
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      console.error(`[control] ${path} failed:`, message);
      if (path === '/soundboard/play' || path === '/soundboard/stop') {
        const response = soundboardErrorResponse(err);
        sendJson(res, response.status, response.payload);
      } else {
        sendJson(res, 500, { error: message });
      }
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[control] Port ${port} is already in use — another bot instance is probably still ` +
          `running. Stop it (or set a different BOT_CONTROL_PORT). The dashboard "Speak" page ` +
          `won't work until this is resolved.`,
      );
      return;
    }
    console.error('[control] server error:', err);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[control] HTTP control server listening on http://127.0.0.1:${port}`);
  });
}
