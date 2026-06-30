import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../types';
import { requireSession } from '../lib/music/guards';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a track from the queue by its position.')
    .addIntegerOption((opt) =>
      opt
        .setName('position')
        .setDescription('Queue position to remove (see /queue)')
        .setRequired(true)
        .setMinValue(1),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const session = await requireSession(interaction);
    if (!session) return;

    const position = interaction.options.getInteger('position', true);
    const removed = session.remove(position);
    await interaction.reply({
      content: removed
        ? `🗑️ Removed **${removed.title}** from position ${position}.`
        : `❌ No track at position ${position}.`,
    });
  },
};

export default command;
