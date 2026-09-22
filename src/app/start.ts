import { Events } from 'discord.js';
import { createClient } from './client';
import { startControlServer } from '../control/server';
import { markBotError, markBotRunning, markBotStarting, markBotStopped, markBotStopping } from '../infrastructure/botRuntime';

export function startBot(): void {
  // Safety net: a single stray rejection or thrown error (e.g. from a killed
  // yt-dlp/ffmpeg child for the music player) should be logged, not crash the
  // whole bot. Without these, one bad child process takes the bot fully offline.
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason instanceof Error ? reason.stack ?? reason.message : reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err.stack ?? err.message);
  });

  let shuttingDown = false;

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[lifecycle] stopping (${reason})`);
    await markBotStopping().catch((err) => console.error('[lifecycle] could not mark stopping:', err));
    client.destroy();
    await markBotStopped().catch((err) => console.error('[lifecycle] could not mark stopped:', err));
    process.exit(0);
  }

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  const client = createClient();

  // --- Log in ---
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error('❌ Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }

  void markBotStarting(process.pid).catch((err) => {
    console.error('[lifecycle] could not mark starting:', err);
  });

  // Start the local control endpoint once the bot is connected, so the web
  // dashboard can ask the bot to speak in a voice channel.
  client.once(Events.ClientReady, async () => {
    await markBotRunning(process.pid).catch((err) => {
      console.error('[lifecycle] could not mark running:', err);
    });
    startControlServer(client, () => void shutdown('dashboard'));
  });

  client.login(token).catch(async (err) => {
    console.error('[login] failed:', err);
    await markBotError(err).catch(() => undefined);
    process.exitCode = 1;
  });
}
