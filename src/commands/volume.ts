import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../types';
import { requireSession } from '../lib/music/guards';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set the playback volume (0–100).')
    .addIntegerOption((opt) =>
      opt
        .setName('level')
        .setDescription('Volume from 0 to 100')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(100),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const session = await requireSession(interaction);
    if (!session) return;

    const level = interaction.options.getInteger('level', true);
    const set = session.setVolume(level);
    await interaction.reply({ content: `🔊 Volume set to **${set}%**.` });
  },
};

export default command;
