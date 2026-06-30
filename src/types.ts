import type {
  Collection,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  SlashCommandOptionsOnlyBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  ClientEvents,
} from 'discord.js';

/** A slash command: its definition plus the handler that runs it. */
export interface Command {
  data:
    | SlashCommandBuilder
    | SlashCommandSubcommandsOnlyBuilder
    | SlashCommandOptionsOnlyBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void> | void;
  /** Optional handler for option autocomplete (e.g. the VOICEVOX voice picker). */
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void> | void;
}

/** A Discord gateway event handler. */
export interface BotEvent {
  name: keyof ClientEvents | string;
  once?: boolean;
  execute: (...args: any[]) => Promise<void> | void;
}

// Teach TypeScript that our Client carries a `commands` collection.
declare module 'discord.js' {
  interface Client {
    commands: Collection<string, Command>;
  }
}
