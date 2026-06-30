# Implementation Plan — AI Voice Assistant (#3) + PoE2 Deal Sniper (#6)

> แผนสำหรับลงมือเขียนเองใน VSCode ของที่ "หายาก" (endpoint จริง, ลำดับ pipeline, signature ของ API)
> ถูกใส่ไว้ให้แล้ว จะได้ไม่ต้องไปหาใหม่ ส่วนที่เป็น scaffold ทำให้แล้วจะมี ✅ กำกับ

---

## 0. สถานะปัจจุบัน (ทำให้แล้ว ✅ / ต้องทำเอง ⬜)

| สิ่งที่ทำ | สถานะ | หมายเหตุ |
|---|---|---|
| `npm install @anthropic-ai/sdk @discordjs/voice prism-media opusscript ffmpeg-static ws` | ✅ | ติดตั้งแล้ว |
| เพิ่ม `Poe2Watch` model ใน `prisma/schema.prisma` | ✅ | ดูล่างสุดของไฟล์ schema |
| เพิ่ม env keys ใน `.env.example` | ✅ | ANTHROPIC/OPENAI/POESESSID ฯลฯ |
| `prisma generate` (สร้าง client ใหม่ให้รู้จัก Poe2Watch) | ✅ | type `Poe2Watch` พร้อมใช้ |
| **ติดตั้ง encryption lib ให้ @discordjs/voice** | ⬜ | **สำคัญ!** ดูข้อ 1 |
| รัน `prisma migrate` สร้างตารางจริงใน DB | ⬜ | `npm run db:migrate` |
| เขียนโค้ดฟีเจอร์ #6 และ #3 | ⬜ | ตามแผนข้อ 4–5 |
| `npm run deploy` ลงทะเบียน slash command ใหม่ | ⬜ | หลังเขียน command เสร็จ |

---

## 1. ⚠️ Dependency ที่ยังขาด (ต้องเพิ่มก่อนเทสต์เสียง)

`@discordjs/voice` ต้องมี encryption library อย่างน้อย 1 ตัว ไม่งั้น "ต่อห้องเสียงไม่ติด" ตอน runtime:

```bash
npm install libsodium-wrappers
# ทางเลือกอื่น: tweetnacl (ช้ากว่า) หรือ sodium-native (เร็วสุดแต่ต้อง build native)
```

`ffmpeg-static` ติดตั้งแล้ว — `prism-media` จะหาเจอเอง ถ้าไม่เจอให้ตั้ง
`process.env.FFMPEG_PATH = require('ffmpeg-static')` ตอน start bot

---

## 2. Environment variables (เติมค่าจริงใน `.env`)

```env
ANTHROPIC_API_KEY=         # console.anthropic.com — สมองของบอท
OPENAI_API_KEY=            # platform.openai.com — ใช้แค่ STT (Whisper) + TTS
AI_VOICE_MODEL=claude-opus-4-8      # อยากให้ตอบไวขึ้นเปลี่ยนเป็น claude-haiku-4-5
AI_VOICE_TTS_VOICE=alloy            # alloy/echo/fable/onyx/nova/shimmer
AI_VOICE_WAKE_WORDS=bot,บอท         # คำปลุกบอทในห้องเสียง

POESESSID=                 # cookie จาก pathofexile.com (DevTools > Application > Cookies)
POE2_USER_AGENT=discord-bot/1.0 (contact: your-email@example.com)
```

> POESESSID = รหัสผ่านดีๆ นี่เอง อย่า commit / อย่าแชร์

---

## 3. คำสั่ง setup (รันตามลำดับ)

```bash
npm install libsodium-wrappers   # ข้อ 1
npm run db:migrate               # สร้างตาราง Poe2Watch ใน Postgres
# ...เขียนโค้ดตามข้อ 4–5...
npm run deploy                   # ลงทะเบียน /poe2 และ /voice-ai
npm run dev                      # รันบอท (auto-reload)
```

---

# 4. Feature #6 — PoE2 Deal Sniper

## 4.1 ภาพรวมการทำงาน

```
ผู้ใช้: /poe2 watch add url:<trade2 search URL> name:"cheap divines"
   │  (parse URL → league + queryId) → บันทึกลง DB (Poe2Watch)
   ▼
SniperManager เปิด WebSocket ค้างไว้ 1 ตัวต่อ 1 watch
   │  PoE ส่ง {"new": [id...]} เมื่อมีของลงขายใหม่ที่ตรงเงื่อนไข
   ▼
ดึงรายละเอียดของ(fetch API, ทีละ ≤10 ids) → โพสต์ embed + คำ whisper ลงห้องที่ตั้งไว้
```

ข้อดี: live search **ไม่ dump ของเก่า** ตอนต่อใหม่ → ส่งเฉพาะของที่ลงขาย *หลัง* เราต่อ → ไม่ spam

## 4.2 Endpoint จริง (ยืนยันจาก source ของ POEFlip แล้ว — ใช้ได้เลย)

```
WebSocket : wss://www.pathofexile.com/api/trade2/live/poe2/{league}/{queryId}
Fetch     : https://www.pathofexile.com/api/trade2/fetch/{ids}?query={queryId}&realm=poe2
Trade URL : https://www.pathofexile.com/trade2/search/poe2/{league}/{queryId}   ← อันที่ผู้ใช้ paste
```

- **Headers (ทั้ง WS และ fetch):** `Cookie: POESESSID=<ค่า>`, `User-Agent: <ค่าจาก POE2_USER_AGENT>`
  - WS เพิ่ม `Origin: https://www.pathofexile.com`
- **ข้อความจาก WS:** ต่อสำเร็จได้ `{"auth": true}` ก่อน, แล้วของใหม่มาเป็น `{"new": ["id1","id2",...]}`
- **Fetch:** ใส่ id ได้ **สูงสุด 10 ตัว/ครั้ง** (คั่นด้วย comma) → ต้องแบ่ง chunk ละ 10
- **Rate limit (429):** อ่าน header `Retry-After` แล้ว sleep (default ~10s), retry ได้ ~2 ครั้ง;
  เว้นจังหวะระหว่าง chunk ~350–400ms
- **โครง response ของ fetch:**
  ```jsonc
  { "result": [ {
      "id": "abc...",
      "listing": {
        "indexed": "2026-...",
        "account": { "name": "SellerName" },
        "price": { "type": "~price", "amount": 5, "currency": "exalted" },
        "whisper": "@SellerName Hi, I would like to buy your ..."
      },
      "item": { "name": "", "typeLine": "...", "baseType": "..." }
  } ] }
  ```

## 4.3 ไฟล์ที่ต้องสร้าง

### `src/lib/poe2/tradeApi.ts`
หน้าที่: คุยกับ trade API + parse URL + ย่อข้อมูลของ
- `export const POE2 = { httpBase: 'https://www.pathofexile.com', wsBase: 'wss://www.pathofexile.com' }`
- `headers()` → `{ Cookie: 'POESESSID=' + process.env.POESESSID, 'User-Agent': process.env.POE2_USER_AGENT }`
- `parseTradeUrl(url): { league, queryId, realm } | null`
  ```ts
  const m = url.match(/trade2\/search\/poe2\/([^/]+)\/([^/?#]+)/);
  if (!m) return null;
  return { league: decodeURIComponent(m[1]), queryId: m[2], realm: 'poe2' };
  ```
- `fetchListings(ids: string[], queryId: string, realm = 'poe2'): Promise<Listing[]>`
  - แบ่ง `ids` เป็น chunk ละ 10 → `GET {httpBase}/api/trade2/fetch/{chunk.join(',')}?query={queryId}&realm={realm}`
  - ใช้ global `fetch` (Node 18+); ถ้า status 429 → อ่าน `res.headers.get('retry-after')` → `await sleep(...)` → retry (≤2)
  - เว้น ~400ms ระหว่าง chunk
  - คืน `json.result` (กรอง null ออก)
- `summarize(listing): { itemName, priceText, seller, whisper }` — ทำข้อความสั้นๆ สำหรับ embed
  - priceText เช่น `${amount} ${currency}` ; itemName ใช้ `item.name || item.typeLine || item.baseType`

### `src/lib/poe2/liveSearch.ts`
หน้าที่: WebSocket 1 ตัว/watch + auto-reconnect
- `import WebSocket from 'ws';`
- `class LiveSearchConnection`
  - ctor(opts: `{ league, queryId, realm, onNewIds: (ids:string[])=>void, onLog?:(m:string)=>void }`)
  - `connect()`:
    ```ts
    const url = `${POE2.wsBase}/api/trade2/live/${this.realm}/${encodeURIComponent(this.league)}/${this.queryId}`;
    this.ws = new WebSocket(url, { headers: { ...headers(), Origin: POE2.httpBase } });
    ```
  - `ws.on('message', raw => { const j = JSON.parse(raw.toString()); if (j.new?.length) this.onNewIds(j.new); })`
  - `ws.on('open')` → reset backoff ; `ws.on('close'|'error')` → `scheduleReconnect()`
  - `scheduleReconnect()` → exponential backoff (5s→10s→20s→…→cap 60s)
  - keepalive: `setInterval(() => this.ws?.ping(), 30_000)` (clear ตอน close)
  - `close()` → ตั้ง flag `intentional=true` กัน reconnect แล้ว `ws.close()` + clear timers

### `src/lib/poe2/watchStore.ts`
หน้าที่: Prisma CRUD (เลียนแบบ `voiceLogStore.ts`)
```ts
import { prisma } from '../db';
export const addWatch = (d: {...}) => prisma.poe2Watch.create({ data: d });   // จับ unique error (P2002)
export const listWatches = (guildId: string) => prisma.poe2Watch.findMany({ where: { guildId } });
export const removeWatch = (guildId: string, id: number) =>
  prisma.poe2Watch.deleteMany({ where: { id, guildId } });   // deleteMany กัน error ถ้าไม่เจอ
export const allEnabled = () => prisma.poe2Watch.findMany({ where: { enabled: true } });
```

### `src/lib/poe2/sniperManager.ts`
หน้าที่: orchestrator (singleton) — ถือ Discord `client` + `Map<watchId, LiveSearchConnection>`
- `start(client)` → ตรวจ POESESSID มีไหม ; `for (w of await allEnabled()) this.connect(w)`
- `connect(watch)`:
  - สร้าง `LiveSearchConnection` ; `onNewIds = (ids) => this.handleNewIds(watch, ids)`
  - เก็บลง map
- `handleNewIds(watch, ids)`:
  - `const listings = await fetchListings(ids, watch.queryId, watch.realm)`
  - resolve channel: `client.channels.cache.get(watch.channelId)` → ถ้า text-based ส่ง embed
  - โพสต์สูงสุด ~5 ชิ้น/burst (กัน spam) — แต่ละชิ้น embed สี gold: itemName, field Price/Seller, whisper ใน code block, ลิงก์ trade
  - กัน dedup ด้วย `Set<string>` ของ id ที่เคยเห็น (cap ~500) ต่อ connection
- `disconnect(watchId)` → `map.get(id)?.close(); map.delete(id)`

### `src/commands/poe2.ts`
Slash command (ดู `voicelog.ts` เป็น template — มี subcommand + `setDefaultMemberPermissions`)
```
/poe2 watch add  url:<string,required>  name:<string,required>  [channel:<text channel>]
/poe2 watch list
/poe2 watch remove  id:<integer,required>
```
- ตั้ง `.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)`
- `add`: ถ้าไม่มี POESESSID → ตอบ ephemeral เตือน ; `parseTradeUrl` ถ้า null → เตือน format ผิด ;
  channel default = `interaction.channel` ; บันทึก DB → `sniperManager.connect(saved)` → ตอบยืนยัน
- `list`: ดึง `listWatches` → แสดงเป็น embed (id, name, league, channel)
- `remove`: `removeWatch` → `sniperManager.disconnect(id)` → ตอบยืนยัน

### แก้ `src/events/ready.ts` (wire startup)
```ts
import { sniperManager } from '../lib/poe2/sniperManager';
// ใน execute(client): หลัง log
sniperManager.start(client).catch(e => console.error('Sniper start failed:', e));
```

## 4.4 ข้อควรระวัง (PoE2)
- **ToS:** ใช้ "แจ้งเตือน" โอเค แต่ **auto-buy/auto-whisper เสี่ยงโดนแบน** — แค่โพสต์ embed ให้คนกดเอง
- POESESSID หมดอายุเป็นระยะ → ถ้า WS เด้ง 401/ปิดรัวๆ ให้ผู้ใช้ไป copy ค่าใหม่
- User-Agent ต้องมี contact จริง (กฎ GGG)

---

# 5. Feature #3 — AI Voice Assistant

## 5.1 Pipeline

```
/voice-ai join  → บอทเข้าห้องเสียง (selfDeaf:false ห้ามลืม!)
   │
ฟัง receiver.speaking 'start' ต่อ user → subscribe เอา Opus packets
   │  จบเมื่อเงียบ 1 วิ (EndBehaviorType.AfterSilence)
   ▼
Opus → PCM (prism opus.Decoder) → ห่อเป็น WAV (48kHz, 2ch, 16-bit)
   ▼
STT: OpenAI Whisper (/v1/audio/transcriptions) → ข้อความ
   ▼
เช็ค "wake word" (ขึ้นต้นด้วย bot/บอท?) — ถ้าไม่มี → ข้าม (กันบอทตอบทุกประโยค)
   ▼
Brain: Claude (Anthropic SDK) + memory สั้นๆ ต่อห้อง → คำตอบ (สั่งให้ตอบสั้น พูดลื่น)
   ▼
TTS: OpenAI (/v1/audio/speech) → mp3 → createAudioResource → player.play → ออกลำโพง
```

## 5.2 ไฟล์ที่ต้องสร้าง

### `src/lib/voiceAI/audio.ts`
- `pcmToWav(pcm: Buffer, rate=48000, channels=2, bits=16): Buffer`
  - เขียน WAV header 44 ไบต์ (RIFF/WAVE/fmt /data) ครอบ `pcm` — มี helper สั้นๆ เขียนเองได้
  - (ทางเลือก: ใช้ lib `wav` แต่เขียน header เองก็ ~20 บรรทัด)

### `src/lib/voiceAI/stt.ts`
```ts
export async function transcribe(wav: Buffer): Promise<string> {
  const form = new FormData();                         // global ใน Node 18+
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', 'whisper-1');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  const json = await res.json();
  return (json.text ?? '').trim();
}
```

### `src/lib/voiceAI/tts.ts`
```ts
export async function synthesize(text: string): Promise<Buffer> {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'tts-1',
      voice: process.env.AI_VOICE_TTS_VOICE ?? 'alloy',
      input: text,
      response_format: 'mp3',
    }),
  });
  return Buffer.from(await res.arrayBuffer());
}
```

### `src/lib/voiceAI/brain.ts`
```ts
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();   // อ่าน ANTHROPIC_API_KEY จาก env เอง

// memory สั้นๆ ต่อ channel: Map<channelId, {role,content}[]>  (เก็บ ~6 ข้อความล่าสุด)
export async function ask(channelId: string, userText: string): Promise<string> {
  const history = getHistory(channelId);
  history.push({ role: 'user', content: userText });
  const res = await client.messages.create({
    model: process.env.AI_VOICE_MODEL ?? 'claude-opus-4-8',
    max_tokens: 300,                          // คำตอบสั้น เพราะจะเอาไปพูด
    system: 'You are a friendly voice assistant in a Discord call. Reply in 1–3 short spoken sentences, in the user\'s language. No markdown, no emoji, no lists — it will be read aloud.',
    messages: history,
  });
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join(' ');
  history.push({ role: 'assistant', content: text });
  trim(history, 6);
  return text;
}
```
> หมายเหตุ model: default `claude-opus-4-8` (ฉลาดสุด) — ถ้าอยากให้ **ตอบไวในห้องเสียง** เซ็ต `AI_VOICE_MODEL=claude-haiku-4-5`

### `src/lib/voiceAI/session.ts`
หน้าที่: จัดการ session ต่อ guild
```ts
import { joinVoiceChannel, getVoiceConnection, EndBehaviorType,
         createAudioPlayer, createAudioResource, StreamType } from '@discordjs/voice';
import prism from 'prism-media';
import { Readable } from 'node:stream';
```
- `join(channel)`:
  ```ts
  const connection = joinVoiceChannel({
    channelId: channel.id, guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,           // ⚠️ ต้อง false ถึงจะ"ได้ยิน"
  });
  const player = createAudioPlayer();
  connection.subscribe(player);
  this.listen(connection, player, channel.id);
  ```
- `listen(connection, player, channelId)`:
  ```ts
  const receiver = connection.receiver;
  receiver.speaking.on('start', (userId) => {
    if (this.busy) return;                    // ทำทีละคน กัน overlap
    const opus = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const chunks: Buffer[] = [];
    opus.pipe(decoder).on('data', c => chunks.push(c));
    decoder.on('end', () => this.handleUtterance(Buffer.concat(chunks), channelId, player));
  });
  ```
- `handleUtterance(pcm, channelId, player)`:
  1. `wav = pcmToWav(pcm)`
  2. `text = await transcribe(wav)` ; ถ้าว่าง → return
  3. wake-word: `const ww = (process.env.AI_VOICE_WAKE_WORDS ?? 'bot').split(',')` →
     เช็ค text (lowercase) ขึ้นต้น/มีคำใดคำหนึ่ง → ถ้าไม่มี return ; ถ้ามี → ตัดคำปลุกออก
  4. `reply = await ask(channelId, cleanedText)`
  5. `mp3 = await synthesize(reply)` →
     `player.play(createAudioResource(Readable.from(mp3), { inputType: StreamType.Arbitrary }))`
  6. set `this.busy` ระหว่างทำ แล้วปลดตอนเสร็จ (กันตอบซ้อน)
- `leave(guildId)` → `getVoiceConnection(guildId)?.destroy()`

### `src/commands/voice-ai.ts`
```
/voice-ai join     ← คนสั่งต้องอยู่ในห้องเสียง (อ่าน interaction.member.voice.channel)
/voice-ai leave
```
- `join`: ถ้าไม่มี ANTHROPIC/OPENAI key → ตอบ ephemeral เตือน ; ถ้าไม่อยู่ห้องเสียง → เตือน ;
  เรียก `session.join(voiceChannel)` → ตอบ "เข้าห้องแล้ว พูด 'บอท ...' ได้เลย"
- `leave`: `session.leave(guildId)` → ตอบยืนยัน

## 5.3 ข้อควรระวัง (Voice AI)
- **sodium lib** (ข้อ 1) ขาดไม่ได้
- **`selfDeaf: false`** ไม่งั้นบอทไม่ได้ยิน
- **ffmpeg** ต้องใช้ได้ (มี `ffmpeg-static` แล้ว; ถ้าหาไม่เจอ set `FFMPEG_PATH`)
- อย่าประมวลผลเสียงบอทเอง / ทำทีละ utterance (flag `busy`) กันตอบซ้อน
- **ค่าใช้จ่าย:** STT + TTS + Claude คิดเงินตามใช้จริง — เริ่มทดสอบในห้องเล็กๆ ก่อน
- Latency: opus→pcm→wav→STT→Claude→TTS รวมแล้วหลายวินาที เป็นเรื่องปกติ; ลดได้ด้วย haiku + คำตอบสั้น

---

## 6. ลำดับการ build ที่แนะนำ

1. `npm install libsodium-wrappers` + `npm run db:migrate`
2. **ทำ #6 ก่อน** (ไม่ต้องพึ่ง 3 external service, เห็นผลเร็ว, ใช้ stack เดิม):
   `tradeApi.ts` → `liveSearch.ts` → `watchStore.ts` → `sniperManager.ts` → `commands/poe2.ts` → แก้ `ready.ts`
   → `npm run deploy` → ลอง `/poe2 watch add`
3. **แล้วค่อยทำ #3:** `audio.ts` → `stt.ts` → `tts.ts` → `brain.ts` → `session.ts` → `commands/voice-ai.ts`
   → `npm run deploy` → ลอง `/voice-ai join`
4. `npm run typecheck` ระหว่างทางบ่อยๆ

---

## 7. เช็กลิสต์ปิดงาน
- [ ] `npm install libsodium-wrappers`
- [ ] `.env` เติม ANTHROPIC_API_KEY, OPENAI_API_KEY, POESESSID, POE2_USER_AGENT
- [ ] `npm run db:migrate` (ตาราง Poe2Watch ขึ้นจริง)
- [ ] เขียนไฟล์ #6 (6 ไฟล์ + แก้ ready.ts)
- [ ] เขียนไฟล์ #3 (6 ไฟล์)
- [ ] `npm run typecheck` ผ่าน
- [ ] `npm run deploy` แล้วเห็น `/poe2` กับ `/voice-ai`
- [ ] เทสต์: เพิ่ม watch แล้วรอ deal เด้ง / เข้าห้องเสียงแล้วพูด "บอท ..."
