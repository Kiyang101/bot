/**
 * guards.ts — Common slash-command guards for the music commands.
 *
 * Keeps the "must be in a server / must be in a voice channel" boilerplate in
 * one place, matching the guard style of src/commands/say.ts.
 */

import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type GuildMember,
  type VoiceBasedChannel,
  type GuildTextBasedChannel,
} from 'discord.js';
import { musicManager, type MusicSession } from './musicSession';

export interface VoiceContext {
  guildId: string;
  voiceChannel: VoiceBasedChannel;
  textChannel: GuildTextBasedChannel;
}

/** Ensure the command runs in a guild and the caller is in a voice channel. */
export async function requireGuildVoice(
  interaction: ChatInputCommandInteraction,
): Promise<VoiceContext | null> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: 'This command can only be used inside a server.',
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  const member = interaction.member as GuildMember | null;
  const voiceChannel = member?.voice?.channel ?? null;
  if (!voiceChannel) {
    await interaction.reply({
      content: '❌ You must be in a voice channel to use this command.',
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  return { guildId, voiceChannel, textChannel: interaction.channel as GuildTextBasedChannel };
}

/**
 * Get the active session for the command's guild, or reply that nothing is
 * playing and return null. Use for control commands (skip, pause, …).
 */
export async function requireSession(
  interaction: ChatInputCommandInteraction,
): Promise<MusicSession | null> {
  const guildId = interaction.guildId;
  const session = guildId ? musicManager.get(guildId) : null;
  if (!session) {
    await interaction.reply({
      content: '❌ Nothing is playing right now.',
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  return session;
}
