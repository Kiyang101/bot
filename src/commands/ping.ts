import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../types';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Replies with Pong and the bot latency.'),
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.reply(`🏓 Pong! WebSocket latency: ${interaction.client.ws.ping}ms`);
  },
};

export default command;
