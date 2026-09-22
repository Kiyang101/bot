import { Client, Collection, GatewayIntentBits } from 'discord.js';
import type { Command } from '../types';
import { loadCommands, loadEvents } from './modules';

/** Construct and wire the client without logging in or starting any servers. */
export function createClient(): Client {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  client.commands = new Collection<string, Command>();

  for (const command of loadCommands()) {
    client.commands.set(command.data.name, command);
  }
  for (const event of loadEvents()) {
    if (event.once) {
      client.once(event.name as any, (...args) => event.execute(...args));
    } else {
      client.on(event.name as any, (...args) => event.execute(...args));
    }
  }
  return client;
}
