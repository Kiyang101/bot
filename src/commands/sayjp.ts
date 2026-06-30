import {
  SlashCommandBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  type GuildMember,
} from 'discord.js';
import type { Command } from '../types';
import { voiceSession } from '../lib/voiceAI/session';
import { resolveVoicevoxUrl, resolveTtsVoice } from '../lib/voiceAI/providers/config';
import { createVoicevoxTTS, fetchVoicevoxSpeakers } from '../lib/voiceAI/providers/voicevox';
import { translateToJapanese } from '../lib/voiceAI/translate';

/**
 * Does the text contain any Japanese characters (hiragana, katakana — incl.
 * half-width — or CJK kanji)? VOICEVOX only synthesizes Japanese, so reading
 * non-Japanese text "as typed" produces silence.
 */
function hasJapanese(text: string): boolean {
  // Hiragana + katakana (぀-ヿ), half-width katakana (ｦ-ﾟ),
  // and CJK kanji incl. extension A (㐀-䶿, 一-鿿).
  return /[぀-ヿｦ-ﾟ㐀-䶿一-鿿]/.test(text);
}

/**
 * `/sayjp` — Japanese anime-voice version of `/say`.
 *
 * Always uses the local VOICEVOX engine (regardless of AI_TTS_PROVIDER) and,
 * by default, translates your Thai/English message into Japanese first so the
 * anime characters can read it. Pick `reading: Read exactly as typed` to skip
 * translation (e.g. when you type Japanese yourself).
 *
 * The `voice` option autocompletes live from your running VOICEVOX engine, so
 * every installed character/style is searchable (Discord's 25-choice cap on
 * static dropdowns would otherwise be far too small).
 */
const command: Command = {
  data: new SlashCommandBuilder()
    .setName('sayjp')
    .setDescription('Bot speaks your message in a Japanese anime voice (VOICEVOX).')
    .addStringOption((opt) =>
      opt
        .setName('message')
        .setDescription('What to say')
        .setRequired(true)
        .setMaxLength(500),
    )
    // Required options must come before optional ones in a slash command.
    .addStringOption((opt) =>
      opt
        .setName('reading')
        .setDescription('Translate your message to Japanese, or read it exactly as typed')
        .setRequired(true)
        .addChoices(
          { name: 'Translate to Japanese', value: 'jp' },
          { name: 'Read exactly as typed', value: 'raw' },
        ),
    )
    .addStringOption((opt) =>
      opt
        .setName('voice')
        .setDescription('VOICEVOX voice — type a name to search or a speaker id number (default: Zundamon #3)')
        .setRequired(false)
        .setAutocomplete(true),
    ),

  async autocomplete(interaction: AutocompleteInteraction) {
    const focused = interaction.options.getFocused().toString().trim();
    let voices: { name: string; id: string }[] = [];
    try {
      voices = await fetchVoicevoxSpeakers(resolveVoicevoxUrl());
    } catch {
      // Engine not reachable — leave the list empty; numeric input still works below.
      voices = [];
    }

    const isNumeric = /^\d+$/.test(focused);
    const lower = focused.toLowerCase();

    // Numeric input → match by speaker id (exact, then prefix). Otherwise match
    // by character/style name. Empty input → show everything.
    let matched = !focused
      ? voices
      : isNumeric
        ? voices.filter((v) => v.id === focused || v.id.startsWith(focused))
        : voices.filter((v) => v.name.toLowerCase().includes(lower));

    const out = matched.slice(0, 25).map((v) => ({ name: v.name.slice(0, 100), value: v.id }));

    // Always let the user commit a raw id they typed, even if it's not in the
    // list (engine offline, or an id our fetch didn't surface).
    if (isNumeric && !out.some((o) => o.value === focused)) {
      out.unshift({ name: `Use speaker id #${focused}`, value: focused });
    }

    await interaction.respond(out.slice(0, 25));
  },

  async execute(interaction: ChatInputCommandInteraction) {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        content: 'This command can only be used inside a server.',
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
    const translate = interaction.options.getString('reading', true) === 'jp';

    // Translation + synthesis + playback can take a moment — defer first.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Step 1: optionally translate the text to Japanese.
    let spoken = message;
    if (translate) {
      try {
        spoken = await translateToJapanese(message);
      } catch (err: unknown) {
        const errMessage = err instanceof Error ? err.message : 'Unknown error.';
        await interaction.editReply({
          content: `❌ Failed to translate to Japanese: ${errMessage}`,
        });
        return;
      }
    }

    // Step 2: speak it through VOICEVOX (forced, independent of AI_TTS_PROVIDER).
    const tts = createVoicevoxTTS(resolveVoicevoxUrl(), resolveTtsVoice('voicevox'));
    try {
      await voiceSession.speak(voiceChannel, spoken, voice, tts);
      const body = translate ? `${message}\n→ 🇯🇵 ${spoken}` : spoken;
      await interaction.editReply({
        content: `🔊 Speaking in **${voiceChannel.name}** _(VOICEVOX)_: "${body}"`,
      });
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : 'Unknown error.';

      // If we read text as-typed and VOICEVOX couldn't pronounce any of it,
      // nudge toward translating — but only as a hint, since plenty of
      // non-Japanese input (numbers, some words) does read fine.
      const couldntRead = !translate && !hasJapanese(spoken);
      const hint = couldntRead
        ? '\nℹ️ VOICEVOX reads Japanese — it couldn’t pronounce this text. Try `reading: Translate to Japanese`, or type in Japanese.'
        : '\nMake sure the VOICEVOX engine is running (default http://localhost:50021).';

      await interaction.editReply({ content: `❌ Failed to speak: ${errMessage}${hint}` });
    }
  },
};

export default command;
