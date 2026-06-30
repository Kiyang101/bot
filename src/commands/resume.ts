import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../types';
import { requireSession } from '../lib/music/guards';

const command: Command = {
  data: new SlashCommandBuilder().setName('resume').setDescription('Resume a paused track.'),

  async execute(interaction: ChatInputCommandInteraction) {
    const session = await requireSession(interaction);
    if (!session) return;

    if (!session.isPaused()) {
      await interaction.reply({ content: '▶️ Already playing.' });
      return;
    }
    session.resume();
    await interaction.reply({ content: '▶️ Resumed.' });
  },
};

export default command;
