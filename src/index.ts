import fs from 'node:fs';
import path from 'node:path';
import { Client, Collection, GatewayIntentBits, Events } from 'discord.js';
import { config } from 'dotenv';
import type { Command, BotEvent } from './types';
import { startControlServer } from './control/server';
import { markBotError, markBotRunning, markBotStarting, markBotStopped, markBotStopping } from './lib/botRuntime';

config(); // load .env

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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates, // needed to detect voice channel joins/leaves/moves
  ],
});

client.commands = new Collection<string, Command>();

/** Lists loadable module files in a folder (.ts under tsx, .js when compiled). */
function moduleFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => (f.endsWith('.ts') || f.endsWith('.js')) && !f.endsWith('.d.ts'));
}

// --- Load commands ---
const commandsPath = path.join(__dirname, 'commands');
for (const file of moduleFiles(commandsPath)) {
  const command = require(path.join(commandsPath, file)).default as Command | undefined;
  if (!command?.data || typeof command.execute !== 'function') {
    console.warn(`[WARNING] Command ${file} is missing "data" or "execute".`);
    continue;
  }
  client.commands.set(command.data.name, command);
}

// --- Load events ---
const eventsPath = path.join(__dirname, 'events');
for (const file of moduleFiles(eventsPath)) {
  const event = require(path.join(eventsPath, file)).default as BotEvent;
  if (event.once) {
    client.once(event.name as any, (...args) => event.execute(...args));
  } else {
    client.on(event.name as any, (...args) => event.execute(...args));
  }
}

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
