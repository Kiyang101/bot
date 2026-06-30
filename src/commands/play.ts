import {
  SlashCommandBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Command } from '../types';
import { resolve } from '../lib/music/ytdlp';
import { musicManager } from '../lib/music/musicSession';
import { requireGuildVoice } from '../lib/music/guards';
import { searchSelect, formatDuration } from '../lib/music/ui';
import { registerSearch } from '../lib/music/components';

/**
 * `/play <query>` — play YouTube audio.
 *
 * Accepts a video URL, a playlist URL, or free-text search. URLs/playlists are
 * enqueued immediately; a search shows a 5-result picker (handled by the
 * `music:pick` component in src/lib/music/components.ts).
 */
const command: Command = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song or playlist from YouTube (URL or search terms).')
    .addStringOption((opt) =>
      opt
        .setName('query')
        .setDescription('YouTube URL, playlist URL, or search terms')
        .setRequired(true)
        .setMaxLength(500),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const ctx = await requireGuildVoice(interaction);
    if (!ctx) return;

    const query = interaction.options.getString('query', true).trim();

    // Resolving + buffering can take a few seconds — defer publicly.
    await interaction.deferReply();

    let result: Awaited<ReturnType<typeof resolve>>;
    try {
      result = await resolve(query, interaction.user.id, interaction.user.username);
    } catch (err) {
      await interaction.editReply({
        content: `❌ Couldn't look that up: ${(err as Error).message}`,
      });
      return;
    }

    if (result.tracks.length === 0) {
      await interaction.editReply({ content: '🔍 No results found.' });
      return;
    }

    // Search → let the user pick from the top results.
    if (result.kind === 'search') {
      const message = await interaction.editReply({
        content: `🔍 Top results for **${query}** — pick one:`,
        components: [searchSelect(result.tracks)],
      });
      registerSearch(message.id, result.tracks);
      return;
    }

    // URL or playlist → enqueue immediately.
    const session = musicManager.getOrCreate(ctx.guildId);
    try {
      const { startedNow, added } = await session.enqueue(
        ctx.voiceChannel,
        ctx.textChannel,
        result.tracks,
      );

      if (result.kind === 'playlist') {
        await interaction.editReply({
          content: `📋 Queued **${added}** track(s) from the playlist.${
            startedNow ? ' Starting now ▶️' : ''
          }`,
        });
      } else {
        const t = result.tracks[0];
        await interaction.editReply({
          content: startedNow
            ? `▶️ Playing **${t.title}** \`${formatDuration(t.durationSec)}\``
            : `➕ Queued **${t.title}** \`${formatDuration(t.durationSec)}\``,
        });
      }
    } catch (err) {
      await interaction.editReply({ content: `❌ Couldn't play that: ${(err as Error).message}` });
    }
  },
};

export default command;
