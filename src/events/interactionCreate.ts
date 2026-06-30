import {
  Events,
  MessageFlags,
  type Interaction,
  type InteractionReplyOptions,
} from 'discord.js';
import type { BotEvent } from '../types';
import { handleMusicComponent } from '../lib/music/components';

const event: BotEvent = {
  name: Events.InteractionCreate,
  async execute(interaction: Interaction) {
    // Option autocomplete (e.g. the /sayjp VOICEVOX voice picker).
    if (interaction.isAutocomplete()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (command?.autocomplete) {
        try {
          await command.autocomplete(interaction);
        } catch (error) {
          console.error(`Autocomplete error for /${interaction.commandName}:`, error);
        }
      }
      return;
    }

    // Music player buttons + search picker (custom ids prefixed `music:`).
    if (
      (interaction.isButton() || interaction.isStringSelectMenu()) &&
      interaction.customId.startsWith('music:')
    ) {
      try {
        await handleMusicComponent(interaction);
      } catch (error) {
        console.error('Music component error:', error);
        if (!interaction.replied && !interaction.deferred) {
          await interaction
            .reply({ content: '⚠️ That control failed.', flags: MessageFlags.Ephemeral })
            .catch(() => {});
        }
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = interaction.client.commands.get(interaction.commandName);
    if (!command) {
      console.error(`No command matching "${interaction.commandName}" was found.`);
      return;
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(`Error running /${interaction.commandName}:`, error);
      const errorReply: InteractionReplyOptions = {
        content: '⚠️ Something went wrong while running that command.',
        flags: MessageFlags.Ephemeral,
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorReply);
      } else {
        await interaction.reply(errorReply);
      }
    }
  },
};

export default event;
