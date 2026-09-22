import {
  REST,
  Routes,
} from 'discord.js';
import { config } from 'dotenv';
import { loadCommands } from './app/modules';

config(); // load .env

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId) {
  console.error('❌ Missing DISCORD_TOKEN or CLIENT_ID in .env.');
  process.exit(1);
}

const commands = loadCommands().map((command) => command.data.toJSON());

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
