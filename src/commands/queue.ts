import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../types';
import { requireSession } from '../lib/music/guards';
import { queueEmbed } from '../lib/music/ui';

const command: Command = {
  data: new SlashCommandBuilder().setName('queue').setDescription('Show the current music queue.'),

  async execute(interaction: ChatInputCommandInteraction) {
    const session = await requireSession(interaction);
    if (!session) return;

    await interaction.reply({ embeds: [queueEmbed(session.getState())] });
  },
};

export default command;
