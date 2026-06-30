/**
 * components.ts — Router for `music:*` button and select-menu interactions.
 *
 * Wired into src/events/interactionCreate.ts. Button ids come from
 * {@link controlRow}; the search picker uses `music:pick`, whose options are
 * indices into the search results stashed by the /play command via
 * {@link registerSearch}.
 */

import {
  MessageFlags,
  type Interaction,
  type GuildMember,
  type GuildTextBasedChannel,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { getVoiceConnection } from '@discordjs/voice';
import type { Track } from './types';
import { musicManager } from './musicSession';
import { formatDuration } from './ui';

/** Search results awaiting a pick, keyed by the picker message id. */
interface PendingSearch {
  tracks: Track[];
  expiresAt: number;
}
const pendingSearches = new Map<string, PendingSearch>();
const PICK_TTL_MS = 60_000;

/** Stash search results so the `music:pick` handler can resolve a choice. */
export function registerSearch(messageId: string, tracks: Track[]): void {
  pendingSearches.set(messageId, { tracks, expiresAt: Date.now() + PICK_TTL_MS });
  // Opportunistic cleanup of stale entries.
  for (const [id, p] of pendingSearches) {
    if (p.expiresAt < Date.now()) pendingSearches.delete(id);
  }
}

/** The voice channel the bot is currently connected to in this guild, if any. */
function botChannelId(guildId: string): string | null {
  return getVoiceConnection(guildId)?.joinConfig.channelId ?? null;
}

/** Dispatch a `music:*` component interaction. */
export async function handleMusicComponent(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: 'Music only works in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const member = interaction.member as GuildMember | null;
  const userChannelId = member?.voice?.channel?.id ?? null;

  // The search picker is its own flow (starts playback).
  if (interaction.isStringSelectMenu() && interaction.customId === 'music:pick') {
    await handlePick(interaction, guildId, member, userChannelId);
    return;
  }

  // Everything else controls an existing session.
  const session = musicManager.get(guildId);
  if (!session) {
    await interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Must be in the same voice channel as the bot to control it.
  if (userChannelId && botChannelId(guildId) && userChannelId !== botChannelId(guildId)) {
    await interaction.reply({
      content: "❌ You need to be in the bot's voice channel to control playback.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.isButton()) return;

  switch (interaction.customId) {
    case 'music:toggle':
      session.isPaused() ? session.resume() : session.pause();
      await interaction.deferUpdate();
      break;
    case 'music:skip':
      session.skip();
      await interaction.deferUpdate();
      break;
    case 'music:stop':
      session.stop();
      await interaction.deferUpdate();
      break;
    case 'music:loop':
      session.cycleLoop();
      await interaction.deferUpdate();
      break;
    case 'music:shuffle':
      session.shuffle();
      await interaction.deferUpdate();
      break;
    case 'music:effect':
      session.cycleEffect();
      await interaction.deferUpdate();
      break;
    case 'music:intensity-down':
      session.setIntensity(session.getState().intensity - 10);
      await interaction.deferUpdate();
      break;
    case 'music:intensity-up':
      session.setIntensity(session.getState().intensity + 10);
      await interaction.deferUpdate();
      break;
    case 'music:seek-back':
      void session.seek(session.getState().positionSec - 10);
      await interaction.deferUpdate();
      break;
    case 'music:seek-fwd':
      void session.seek(session.getState().positionSec + 10);
      await interaction.deferUpdate();
      break;
    default:
      await interaction.deferUpdate();
  }
}

/** Resolve a search pick and start/queue it. */
async function handlePick(
  interaction: StringSelectMenuInteraction,
  guildId: string,
  member: GuildMember | null,
  userChannelId: string | null,
): Promise<void> {
  const pending = pendingSearches.get(interaction.message.id);
  if (!pending || pending.expiresAt < Date.now()) {
    pendingSearches.delete(interaction.message.id);
    await interaction.update({ content: '⌛ This search expired. Run `/play` again.', components: [] });
    return;
  }

  const track = pending.tracks[Number(interaction.values[0])];
  const voiceChannel = member?.voice?.channel ?? null;
  if (!voiceChannel || !userChannelId) {
    await interaction.reply({
      content: '❌ Join a voice channel first, then pick a track.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  pendingSearches.delete(interaction.message.id);
  await interaction.deferUpdate();

  const textChannel = interaction.channel as GuildTextBasedChannel | null;
  const session = musicManager.getOrCreate(guildId);
  try {
    const { startedNow } = await session.enqueue(voiceChannel, textChannel!, [track]);
    await interaction.editReply({
      content: startedNow
        ? `▶️ Playing **${track.title}** \`${formatDuration(track.durationSec)}\``
        : `➕ Queued **${track.title}** \`${formatDuration(track.durationSec)}\``,
      components: [],
    });
  } catch (err) {
    await interaction.editReply({
      content: `❌ Couldn't play that: ${(err as Error).message}`,
      components: [],
    });
  }
}
