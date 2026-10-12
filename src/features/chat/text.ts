/** Never expose a model's reasoning, even if an older model ignores think:false. */
export function finalAnswer(text: string): string {
  const cleaned = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');
  // Some Ollama templates prefill <think>, so only its closing tag is returned.
  const closing = cleaned.toLowerCase().lastIndexOf('</think>');
  return (closing < 0 ? cleaned : cleaned.slice(closing + '</think>'.length)).trim();
}

export function limitText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const segmenter = new Intl.Segmenter('th', { granularity: 'sentence' });
  let end = 0;
  for (const part of segmenter.segment(text)) {
    const next = part.index + part.segment.length;
    if (next > limit) break;
    end = next;
  }
  // ICU can treat an English period before lowercase text as an abbreviation.
  for (const match of text.matchAll(/[.!?。！？…]["'”’)]*(?:\s+|$)|\n+/g)) {
    const next = match.index + match[0].length;
    if (next > limit) break;
    end = Math.max(end, next);
  }
  // A single long sentence still needs a hard cap; avoid splitting surrogate pairs.
  let prefix = text.slice(0, limit);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return (end ? text.slice(0, end) : prefix).trimEnd();
}

export function spokenAnswer(text: string): string {
  const plain = finalAnswer(text)
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[*_~`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return limitText(plain, 1000);
}

export function replyChunks(text: string): string[] {
  text = text.trim();
  const chunks: string[] = [];
  while (text.length > 2000) {
    const chunk = limitText(text, 2000);
    chunks.push(chunk);
    text = text.slice(chunk.length).trimStart();
  }
  if (text) chunks.push(text);
  return chunks;
}
