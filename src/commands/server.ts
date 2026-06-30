import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Command } from '../types';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('server')
    .setDescription('Shows information about this server.'),
  async execute(interaction: ChatInputCommandInteraction) {
    const { guild } = interaction;
    if (!guild) {
      await interaction.reply({
        content: 'This command can only be used inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(guild.name)
      .setThumbnail(guild.iconURL())
      .addFields(
        { name: 'Members', value: `${guild.memberCount}`, inline: true },
        {
          name: 'Created',
          value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`,
          inline: true,
        },
        { name: 'Server ID', value: guild.id, inline: false },
      );

    await interaction.reply({ embeds: [embed] });
  },
};

export default command;
