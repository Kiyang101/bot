import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../types';
import { requireSession } from '../lib/music/guards';
import type { LoopMode } from '../lib/music/types';

const LABEL: Record<LoopMode, string> = {
  off: '➡️ Loop off',
  track: '🔂 Looping the current track',
  queue: '🔁 Looping the whole queue',
};

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Set the loop mode.')
    .addStringOption((opt) =>
      opt
        .setName('mode')
        .setDescription('How to repeat')
        .setRequired(true)
        .addChoices(
          { name: 'Off', value: 'off' },
          { name: 'Track', value: 'track' },
          { name: 'Queue', value: 'queue' },
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const session = await requireSession(interaction);
    if (!session) return;

    const mode = interaction.options.getString('mode', true) as LoopMode;
    session.setLoop(mode);
    await interaction.reply({ content: LABEL[mode] });
  },
};

export default command;
