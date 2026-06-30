import fs from 'node:fs';
import path from 'node:path';
import {
  REST,
  Routes,
  type RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';
import { config } from 'dotenv';
import type { Command } from './types';

config(); // load .env

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId) {
  console.error('❌ Missing DISCORD_TOKEN or CLIENT_ID in .env.');
  process.exit(1);
}

const commands: RESTPostAPIApplicationCommandsJSONBody[] = [];
const commandsPath = path.join(__dirname, 'commands');
const files = fs
  .readdirSync(commandsPath)
  .filter((f) => (f.endsWith('.ts') || f.endsWith('.js')) && !f.endsWith('.d.ts'));

for (const file of files) {
  const command = require(path.join(commandsPath, file)).default as Command | undefined;
  if (command?.data && typeof command.execute === 'function') {
    commands.push(command.data.toJSON());
  }
}

const rest = new REST().setToken(token);

(async () => {
  try {
    console.log(`⏳ Refreshing ${commands.length} application (/) command(s)...`);
    if (guildId) {
      const data = (await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
        body: commands,
      })) as unknown[];
      console.log(`✅ Registered ${data.length} command(s) to test server ${guildId}.`);
    } else {
      const data = (await rest.put(Routes.applicationCommands(clientId), {
        body: commands,
      })) as unknown[];
      console.log(`✅ Registered ${data.length} global command(s). May take up to an hour.`);
    }
  } catch (error) {
    console.error('❌ Failed to register commands:', error);
  }
})();
