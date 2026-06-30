import { Events, type Client } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import type { BotEvent } from '../types';

const event: BotEvent = {
  name: Events.ClientReady,
  once: true,
  execute(client: Client) {
    console.log(`✅ Logged in as ${client.user?.tag}`);
    console.log(`   Serving ${client.guilds.cache.size} server(s).`);
    console.log('--- @discordjs/voice dependency report ---');
    console.log(generateDependencyReport());
    console.log('------------------------------------------');
  },
};

export default event;
