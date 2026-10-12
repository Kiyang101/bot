import type { ChatMessage } from '../speech/providers/types';
import { completeChat } from './ollama';
import { spokenAnswer } from './text';

export const CHAT_ERRORS = {
  input: 'กรุณาส่งข้อความระหว่าง 1 ถึง 2,000 ตัวอักษร',
  full: 'คิวแชตเต็มแล้ว (รอได้สูงสุด 5 รายการ) กรุณาลองใหม่อีกครั้ง',
  ollama: 'ไม่สามารถสร้างคำตอบได้ กรุณาตรวจว่า Ollama เปิดอยู่และติดตั้ง qwen3:4b แล้ว หรือลองใหม่อีกครั้ง',
  speech: 'สร้างเสียงไม่ได้ กรุณาตรวจว่าบริการเสียงในเครื่องเปิดอยู่ แล้วลองใหม่อีกครั้ง',
};

interface Conversation { messages: ChatMessage[]; touched: number }
export interface ChatRequest {
  guildId: string;
  channelId: string;
  userId: string;
  text: string;
  reply: (text: string) => Promise<void>;
  speak?: (text: string) => Promise<void>;
}

/** One CPU workload at a time across guilds; the waiting queue excludes the active job. */
export class ChatService {
  private readonly conversations = new Map<string, Conversation>();
  private readonly queue: { request: ChatRequest; resolve: () => void; reject: (err: unknown) => void }[] = [];
  private processing = false;

  constructor(
    private readonly complete = completeChat,
    private readonly now = Date.now,
  ) {}

  private key(request: Pick<ChatRequest, 'guildId' | 'channelId' | 'userId'>): string {
    return JSON.stringify([request.guildId, request.channelId, request.userId]);
  }

  reset(request: Pick<ChatRequest, 'guildId' | 'channelId' | 'userId'>): void {
    this.conversations.delete(this.key(request));
  }

  expireIdle(): void {
    const now = this.now();
    for (const [key, conversation] of this.conversations) {
      if (now - conversation.touched >= 30 * 60_000) this.conversations.delete(key);
    }
  }

  submit(request: ChatRequest): Promise<void> {
    if (!request.text.trim() || request.text.length > 2000) return Promise.reject(new Error(CHAT_ERRORS.input));
    if (this.processing && this.queue.length >= 5) return Promise.reject(new Error(CHAT_ERRORS.full));
    return new Promise((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        try {
          await this.run(job.request);
          job.resolve();
        } catch (err) {
          job.reject(err);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async run(request: ChatRequest): Promise<void> {
    const now = this.now();
    this.expireIdle();
    const key = this.key(request);
    const conversation = this.conversations.get(key) ?? { messages: [], touched: now };
    conversation.touched = now;
    this.conversations.set(key, conversation);
    const user: ChatMessage = { role: 'user', content: request.text.trim() };
    let answer: string;
    try {
      answer = await this.complete([...conversation.messages, user]);
      if (!answer.trim()) throw new Error('Empty answer');
    } catch (err) {
      console.error('[chat] Ollama failed:', err);
      await request.reply(CHAT_ERRORS.ollama);
      return;
    }
    await request.reply(answer);
    // A reset while generation is running must not restore the old history.
    if (this.conversations.get(key) === conversation) {
      conversation.messages = [...conversation.messages, user, { role: 'assistant' as const, content: answer }].slice(-20);
      conversation.touched = this.now();
    }
    const spoken = spokenAnswer(answer);
    if (spoken && request.speak) {
      try {
        await request.speak(spoken);
      } catch (err) {
        console.error('[chat] speech failed:', err);
        await request.reply(CHAT_ERRORS.speech);
      }
    }
  }
}

export const chatService = new ChatService();
// Evict RAM even when no new chats arrive; this timer must not keep the bot alive.
setInterval(() => chatService.expireIdle(), 60_000).unref();
