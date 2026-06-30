import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Command } from '../types';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Lists all available commands.'),
  async execute(interaction: ChatInputCommandInteraction) {
    const commandList = interaction.client.commands
      .map((cmd) => `**/${cmd.data.name}** — ${cmd.data.description}`)
      .join('\n');

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('📖 Available Commands')
      .setDescription(commandList || 'No commands loaded.')
      .setFooter({ text: 'Built with discord.js + TypeScript' });

    await interaction.reply({ embeds: [embed] });
  },
};

export default command;
