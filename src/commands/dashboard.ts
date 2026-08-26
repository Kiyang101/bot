import {
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Command } from '../types';

/**
 * Builds the dashboard link for a specific server. The `?guild=` param tells the
 * dashboard to pin itself to that server (the middleware stores it in a cookie),
 * so the link only ever shows this server's logs/settings.
 */
function dashboardLinkFor(guildId: string): string | null {
  const base = process.env.DASHBOARD_URL?.trim();
  if (!base) return null;
  const url = new URL(base);
  url.searchParams.set('guild', guildId);
  return url.toString();
}

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('dashboard')
    .setDescription('Get a link to the web dashboard for this server.'),
  async execute(interaction: ChatInputCommandInteraction) {
    const { guild } = interaction;
    if (!guild) {
      await interaction.reply({
        content: 'This command can only be used inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const link = dashboardLinkFor(guild.id);
    if (!link) {
      await interaction.reply({
        content:
          '⚠️ The dashboard URL is not configured. Set `DASHBOARD_URL` in the bot\'s `.env`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('📊 Server Dashboard')
      .setDescription(`Voice logs, settings, TTS and the music player for **${guild.name}**.`)
      .setFooter({ text: 'This link is scoped to this server only.' });

    const button = new ButtonBuilder()
      .setLabel('Open Dashboard')
      .setStyle(ButtonStyle.Link)
      .setURL(link);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

    // Ephemeral so the link isn't broadcast to the whole channel.
    await interaction.reply({
      embeds: [embed],
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  },
};

export default command;
