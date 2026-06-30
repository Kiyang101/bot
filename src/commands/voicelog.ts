import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Command } from '../types';
import * as store from '../lib/voiceLogStore';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('voicelog')
    .setDescription('Configure logging of who joins/leaves voice channels.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Choose the text channel where voice activity is logged.')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('The text channel to send voice logs to.')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('off').setDescription('Stop logging voice activity.'),
    )
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Show the current voice log channel.'),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        content: 'Use this command inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'set') {
      const channel = interaction.options.getChannel('channel', true);
      await store.setLogChannel(guildId, channel.id);
      await interaction.reply({
        content: `✅ Voice activity will now be logged in <#${channel.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'off') {
      await store.clearLogChannel(guildId);
      await interaction.reply({
        content: '🛑 Voice logging is now disabled.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // status
    const channelId = await store.getLogChannel(guildId);
    await interaction.reply({
      content: channelId
        ? `📋 Voice activity is being logged in <#${channelId}>.`
        : 'Voice logging is currently **off**. Use `/voicelog set` to turn it on.',
      flags: MessageFlags.Ephemeral,
    });
  },
};

export default command;
