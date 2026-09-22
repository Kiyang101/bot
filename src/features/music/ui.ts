/**
 * ui.ts — Pure embed/component builders for the music player.
 *
 * Component custom ids are all prefixed `music:` so the interactionCreate
 * router can dispatch them to {@link handleMusicComponent}.
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import type { Track, MusicState, LoopMode } from './types';
import { EFFECT_LABELS } from './types';

const COLOR = 0x5865f2; // blurple

/** Format seconds as m:ss or h:mm:ss; "LIVE" when duration is unknown. */
export function formatDuration(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return 'LIVE';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const LOOP_LABEL: Record<LoopMode, string> = {
  off: 'Off',
  track: '🔂 Track',
  queue: '🔁 Queue',
};

/**
 * A text seek bar like `1:05 ┃━━━━🔘────────┃ 3:42`. For livestreams (no known
 * duration) it shows a 🔴 LIVE indicator instead.
 */
function progressBar(positionSec: number, durationSec: number | null, slots = 18): string {
  if (durationSec == null || durationSec <= 0) {
    return `🔴 LIVE • ${formatDuration(positionSec)}`;
  }
  const pos = Math.min(positionSec, durationSec);
  const filled = Math.max(0, Math.min(slots - 1, Math.round((pos / durationSec) * (slots - 1))));
  const bar = '━'.repeat(filled) + '🔘' + '─'.repeat(slots - 1 - filled);
  return `${formatDuration(pos)} \`${bar}\` ${formatDuration(durationSec)}`;
}

/** The now-playing embed for the current track. */
export function nowPlayingEmbed(state: MusicState): EmbedBuilder {
  const t = state.current;
  const embed = new EmbedBuilder().setColor(COLOR);

  if (!t) {
    return embed.setTitle('Nothing playing').setDescription('The queue is empty.');
  }

  embed
    .setTitle(state.paused ? '⏸️ Paused' : '🎵 Now Playing')
    .setDescription(`**[${t.title}](${t.url})**\n\n${progressBar(state.positionSec, t.durationSec)}`)
    .addFields(
      { name: 'Duration', value: formatDuration(t.durationSec), inline: true },
      { name: 'Volume', value: `${state.volume}%`, inline: true },
      { name: 'Loop', value: LOOP_LABEL[state.loop], inline: true },
      {
        name: 'Effect',
        value:
          state.effect === 'off'
            ? EFFECT_LABELS.off
            : `${EFFECT_LABELS[state.effect]} (${state.intensity}%)`,
        inline: true,
      },
    );

  if (t.uploader) embed.setAuthor({ name: t.uploader });
  if (t.thumbnail) embed.setThumbnail(t.thumbnail);

  const up = state.queue.length;
  embed.setFooter({
    text: `Requested by ${t.requestedByTag}${up > 0 ? ` • ${up} more in queue` : ''}`,
  });

  return embed;
}

/** The button control row for the now-playing message. */
export function controlRow(state: MusicState): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('music:toggle')
      .setEmoji(state.paused ? '▶️' : '⏸️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music:skip')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music:stop')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('music:loop')
      .setEmoji('🔁')
      .setStyle(state.loop === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('music:shuffle')
      .setEmoji('🔀')
      .setStyle(ButtonStyle.Secondary),
  );
}

/** Second row: cycle through audio effects. Shows the active effect as label. */
export function effectRow(state: MusicState): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('music:effect')
      .setEmoji('🎚️')
      .setLabel(
        state.effect === 'off'
          ? 'Effect: Off'
          : `Effect: ${EFFECT_LABELS[state.effect]} (${state.intensity}%)`,
      )
      .setStyle(state.effect === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('music:intensity-down')
      .setEmoji('➖')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(state.effect === 'off'),
    new ButtonBuilder()
      .setCustomId('music:intensity-up')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(state.effect === 'off'),
  );
}

/** Third row: seek the current track backward / forward by 10 seconds. */
export function seekRow(state: MusicState): ActionRowBuilder<ButtonBuilder> {
  const seekable = !!state.current && state.current.durationSec != null;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('music:seek-back')
      .setEmoji('⏪')
      .setLabel('-10s')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!seekable),
    new ButtonBuilder()
      .setCustomId('music:seek-fwd')
      .setEmoji('⏩')
      .setLabel('+10s')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!seekable),
  );
}

/** All component rows for the now-playing message (transport + effects + seek). */
export function controlComponents(
  state: MusicState,
): ActionRowBuilder<ButtonBuilder>[] {
  return [controlRow(state), effectRow(state), seekRow(state)];
}

/** Embed listing the upcoming queue. */
export function queueEmbed(state: MusicState): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(COLOR).setTitle('🎶 Queue');

  const now = state.current
    ? `**Now:** [${state.current.title}](${state.current.url}) \`${formatDuration(
        state.current.durationSec,
      )}\``
    : '_Nothing playing._';

  if (state.queue.length === 0) {
    embed.setDescription(`${now}\n\n_Queue is empty._`);
    return embed;
  }

  const lines = state.queue
    .slice(0, 15)
    .map(
      (t, i) =>
        `\`${i + 1}.\` [${t.title}](${t.url}) \`${formatDuration(t.durationSec)}\` — ${t.requestedByTag}`,
    );
  const extra = state.queue.length - 15;
  const tail = extra > 0 ? `\n…and **${extra}** more` : '';

  embed.setDescription(`${now}\n\n${lines.join('\n')}${tail}`);
  embed.setFooter({ text: `${state.queue.length} track(s) • Loop: ${LOOP_LABEL[state.loop]}` });
  return embed;
}

/** Select menu of search results, shown when /play matches a search phrase. */
export function searchSelect(tracks: Track[]): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('music:pick')
    .setPlaceholder('Pick a track to play')
    .addOptions(
      tracks.slice(0, 25).map((t, i) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(t.title.slice(0, 100))
          .setDescription(
            `${formatDuration(t.durationSec)}${t.uploader ? ` • ${t.uploader}` : ''}`.slice(0, 100),
          )
          .setValue(String(i)),
      ),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}
