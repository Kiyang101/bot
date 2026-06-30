import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../types';
import { requireSession } from '../lib/music/guards';

const command: Command = {
  data: new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the queue.'),

  async execute(interaction: ChatInputCommandInteraction) {
    const session = await requireSession(interaction);
    if (!session) return;

    const { queue } = session.getState();
    if (queue.length < 2) {
      await interaction.reply({ content: '🔀 Not enough tracks in the queue to shuffle.' });
      return;
    }
    session.shuffle();
    await interaction.reply({ content: `🔀 Shuffled **${queue.length}** tracks.` });
  },
};

export default command;
