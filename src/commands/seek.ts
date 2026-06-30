import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../types';
import { requireSession } from '../lib/music/guards';

/** Parse "90", "1:30", or "1:02:03" into seconds, or null if unparseable. */
function parseTime(input: string): number | null {
  const parts = input.trim().split(':').map((p) => p.trim());
  if (parts.some((p) => p === '' || !/^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  if (nums.length === 1) return nums[0];
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  return null;
}

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('seek')
    .setDescription('Jump to a position in the current track.')
    .addStringOption((opt) =>
      opt
        .setName('position')
        .setDescription('Time like 90, 1:30, or 1:02:03')
        .setRequired(true),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const session = await requireSession(interaction);
    if (!session) return;

    const raw = interaction.options.getString('position', true);
    const seconds = parseTime(raw);
    if (seconds == null) {
      await interaction.reply({ content: `❌ Couldn't read "${raw}". Try \`90\` or \`1:30\`.` });
      return;
    }

    const ok = await session.seek(seconds);
    await interaction.reply({
      content: ok
        ? `⏩ Seeked to **${raw}**.`
        : '❌ This track can’t be seeked (no known duration).',
    });
  },
};

export default command;
