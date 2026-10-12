import { Events, type Message } from 'discord.js';
import type { BotEvent } from '../types';
import { chatService } from '../features/chat/service';
import { chatSpeaker } from '../features/chat/discord';
import { replyChunks } from '../features/chat/text';

const event: BotEvent = {
  name: Events.MessageCreate,
  async execute(message: Message) {
    if (!message.guild || message.author.bot || message.webhookId || !message.client.user) return;
    const id = message.client.user.id;
    // Require an explicit user mention; role mentions/reply pings do not start chat.
    const mention = new RegExp(`<@!?${id}>`, 'g');
    if (!mention.test(message.content)) return;
    const text = message.content.replace(mention, '').trim();
    const reply = async (content: string): Promise<void> => {
      for (const chunk of replyChunks(content)) {
        await message.reply({ content: chunk, allowedMentions: { parse: [], repliedUser: false } });
      }
    };
    try {
      await chatService.submit({
        guildId: message.guild.id,
        channelId: message.channelId,
        userId: message.author.id,
        text,
        reply,
        speak: chatSpeaker(message.guild, message.author.id, reply),
      });
    } catch (err) {
      try {
        await reply(err instanceof Error ? err.message : 'ไม่สามารถรับข้อความได้ กรุณาลองใหม่อีกครั้ง');
      } catch (replyError) {
        console.error('[chat] cannot reply:', replyError);
      }
    }
  },
};
export default event;
