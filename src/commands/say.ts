import {
  SlashCommandBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import type { Command } from '../types';
import { voiceSession } from '../lib/voiceAI/session';
import { getSelectedProviders, resolveApiKey, ttsVoiceChoices } from '../lib/voiceAI/providers/config';

/**
 * Voice choices for the dropdown, based on whichever TTS provider is
 * configured at deploy time. Read once when this module loads (which is also
 * when `deploy-commands.ts` registers the command). Falls back to an empty
 * list if the provider env is missing/misconfigured — the option then just
 * accepts free text and the provider applies its default voice.
 *
 * For Japanese / VOICEVOX anime voices, use the dedicated `/sayjp` command.
 */
function voiceChoices(): { name: string; value: string }[] {
  try {
    return ttsVoiceChoices(getSelectedProviders().tts);
  } catch {
    return [];
  }
}

/**
 * Check that the configured TTS provider is usable. Returns an error string
 * to show the user, or null if everything is set.
 *
 * VOICEVOX is a local engine with no API key, so it always passes here — if
 * the engine isn't running, `speak()` surfaces a clear runtime error instead.
 */
function ttsConfigError(): string | null {
  let tts: ReturnType<typeof getSelectedProviders>['tts'];
  try {
    ({ tts } = getSelectedProviders());
  } catch (err: unknown) {
    return err instanceof Error ? err.message : 'Unknown TTS configuration error.';
  }
  if (tts === 'voicevox') {
    return null; // keyless local engine
  }
  if (!resolveApiKey('TTS', tts)) {
    return `No API key for the "${tts}" TTS provider. Set \`AI_TTS_API_KEY\` (or the provider's key) in \`.env\`.`;
  }
  return null;
}

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('say')
    .setDescription('Send a message for the bot to speak in your voice channel.')
    .addSubcommand((sub) =>
      sub
        .setName('text')
        .setDescription('Bot joins your voice channel and speaks the message.')
        .addStringOption((opt) =>
          opt
            .setName('message')
            .setDescription('What the bot should say')
            .setRequired(true)
            .setMaxLength(500),
        )
        .addStringOption((opt) =>
          opt
            .setName('voice')
            .setDescription('Which voice to use (defaults to AI_TTS_VOICE from .env)')
            .setRequired(false)
            .addChoices(...voiceChoices()),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('leave').setDescription('Bot leaves the voice channel.'),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        content: 'This command can only be used inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'leave') {
      try {
        voiceSession.leave(guildId);
        await interaction.reply({
          content: '👋 Left the voice channel.',
          flags: MessageFlags.Ephemeral,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error.';
        await interaction.reply({
          content: `❌ Failed to leave voice channel: ${message}`,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (sub === 'text') {
      // Guard: TTS provider must be configured.
      const configError = ttsConfigError();
      if (configError) {
        await interaction.reply({
          content: `⚠️ Text-to-speech is misconfigured: ${configError}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Guard: user must be in a voice channel.
      const member = interaction.member as GuildMember | null;
      const voiceChannel = member?.voice?.channel;
      if (!voiceChannel) {
        await interaction.reply({
          content: '❌ You must be in a voice channel to use this command.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const message = interaction.options.getString('message', true);
      const voice = interaction.options.getString('voice') ?? undefined;

      // Synthesis + playback can take a moment — defer so we don't time out.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        await voiceSession.speak(voiceChannel, message, voice);
        const voiceNote = voice ? ` _(voice: ${voice})_` : '';
        await interaction.editReply({
          content: `🔊 Speaking in **${voiceChannel.name}**${voiceNote}: "${message}"`,
        });
      } catch (err: unknown) {
        const errMessage = err instanceof Error ? err.message : 'Unknown error.';
        await interaction.editReply({
          content: `❌ Failed to speak: ${errMessage}`,
        });
      }
      return;
    }

    await interaction.reply({
      content: 'Unknown subcommand.',
      flags: MessageFlags.Ephemeral,
    });
  },
};

export default command;
