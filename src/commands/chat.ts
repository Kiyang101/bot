import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types';
import { chatService } from '../features/chat/service';
import { chatSpeaker } from '../features/chat/discord';
import { replyChunks } from '../features/chat/text';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('chat')
    .setDescription('คุยกับ Qwen ในเครื่อง และพูดคำตอบในห้องเสียงของคุณ')
    .addStringOption((option) => option.setName('message').setDescription('ข้อความที่ต้องการคุย')
      .setRequired(true).setMaxLength(2000)),
  async execute(interaction) {
    if (!interaction.guild) {
      await interaction.reply({ content: 'ใช้คำสั่งนี้ในเซิร์ฟเวอร์เท่านั้น', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply();
    let answered = false;
    const reply = async (content: string): Promise<void> => {
      for (const chunk of replyChunks(content)) {
        if (answered) await interaction.followUp({ content: chunk, allowedMentions: { parse: [] } });
        else {
          await interaction.editReply({ content: chunk, allowedMentions: { parse: [] } });
          answered = true;
        }
      }
    };
    try {
      await chatService.submit({
        guildId: interaction.guild.id,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        text: interaction.options.getString('message', true),
        reply,
        speak: chatSpeaker(interaction.guild, interaction.user.id, reply),
      });
    } catch (err) {
      await reply(err instanceof Error ? err.message : 'ไม่สามารถรับข้อความได้ กรุณาลองใหม่อีกครั้ง');
    }
  },
};
export default command;
