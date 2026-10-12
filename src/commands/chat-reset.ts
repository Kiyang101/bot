import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types';
import { chatService } from '../features/chat/service';

const command: Command = {
  data: new SlashCommandBuilder().setName('chat-reset').setDescription('ล้างบทสนทนาของคุณในห้องแชตนี้'),
  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'ใช้คำสั่งนี้ในเซิร์ฟเวอร์เท่านั้น', flags: MessageFlags.Ephemeral });
      return;
    }
    chatService.reset({ guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id });
    await interaction.reply({ content: 'ล้างความจำบทสนทนาของคุณในห้องนี้แล้ว', flags: MessageFlags.Ephemeral });
  },
};
export default command;
