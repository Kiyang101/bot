import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../types';
import { requireSession } from '../lib/music/guards';

const command: Command = {
  data: new SlashCommandBuilder().setName('pause').setDescription('Pause the current track.'),

  async execute(interaction: ChatInputCommandInteraction) {
    const session = await requireSession(interaction);
    if (!session) return;

    if (session.isPaused()) {
      await interaction.reply({ content: '⏸️ Already paused.' });
      return;
    }
    session.pause();
    await interaction.reply({ content: '⏸️ Paused.' });
  },
};

export default command;
