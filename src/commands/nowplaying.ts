import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../types';
import { requireSession } from '../lib/music/guards';
import { nowPlayingEmbed, controlComponents } from '../lib/music/ui';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show the track that is currently playing.'),

  async execute(interaction: ChatInputCommandInteraction) {
    const session = await requireSession(interaction);
    if (!session) return;

    const state = session.getState();
    await interaction.reply({
      embeds: [nowPlayingEmbed(state)],
      components: state.current ? controlComponents(state) : [],
    });
  },
};

export default command;
