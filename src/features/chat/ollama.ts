import type { ChatMessage } from '../speech/providers/types';
import { finalAnswer } from './text';
import { CHAT_SYSTEM_PROMPT } from './persona';

export async function completeChat(messages: readonly ChatMessage[]): Promise<string> {
  const root = (process.env.OLLAMA_URL?.trim() || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const response = await fetch(`${root}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OLLAMA_MODEL?.trim() || 'qwen3:4b',
      think: false,
      stream: false,
      messages: [{ role: 'system', content: CHAT_SYSTEM_PROMPT }, ...messages.map((message, index) => (
        index === messages.length - 1 && message.role === 'user'
          ? { ...message, content: `${message.content}\n/no_think` }
          : message
      ))],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
  const body = await response.json() as { message?: { content?: unknown }; error?: unknown };
  if (body.error || typeof body.message?.content !== 'string') throw new Error('Invalid Ollama reply');
  const answer = finalAnswer(body.message.content);
  if (!answer) throw new Error('Empty Ollama reply');
  return answer;
}
