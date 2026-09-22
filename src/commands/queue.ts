import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../types';
import { requireSession } from '../features/music/guards';
import { queueEmbed } from '../features/music/ui';

const command: Command = {
  data: new SlashCommandBuilder().setName('queue').setDescription('Show the current music queue.'),

  async execute(interaction: ChatInputCommandInteraction) {
    const session = await requireSession(interaction);
    if (!session) return;

    await interaction.reply({ embeds: [queueEmbed(session.getState())] });
  },
};

export default command;
