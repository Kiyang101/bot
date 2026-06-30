import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../types';
import { requireSession } from '../lib/music/guards';
import { EFFECTS, EFFECT_LABELS, type Effect } from '../lib/music/types';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('effect')
    .setDescription('Apply an audio effect to the music (restarts the current track).')
    .addStringOption((opt) =>
      opt
        .setName('name')
        .setDescription('Which effect to apply')
        .setRequired(true)
        .addChoices(...EFFECTS.map((e) => ({ name: EFFECT_LABELS[e], value: e }))),
    )
    .addIntegerOption((opt) =>
      opt
        .setName('intensity')
        .setDescription('Strength 0–100 (default 50)')
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(100),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const session = await requireSession(interaction);
    if (!session) return;

    const effect = interaction.options.getString('name', true) as Effect;
    const intensity = interaction.options.getInteger('intensity') ?? undefined;
    session.setEffect(effect, intensity);
    const suffix = effect === 'off' ? '' : ` at **${session.getState().intensity}%**`;
    await interaction.reply({ content: `🎚️ Effect set to **${EFFECT_LABELS[effect]}**${suffix}.` });
  },
};

export default command;
