import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../types';
import { requireSession } from '../lib/music/guards';

const command: Command = {
  data: new SlashCommandBuilder().setName('skip').setDescription('Skip the current track.'),

  async execute(interaction: ChatInputCommandInteraction) {
    const session = await requireSession(interaction);
    if (!session) return;

    const skipped = session.skip();
    await interaction.reply({
      content: skipped ? `⏭️ Skipped **${skipped.title}**.` : '⏭️ Skipped.',
    });
  },
};

export default command;
