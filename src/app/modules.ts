import fs from 'node:fs';
import path from 'node:path';
import type { BotEvent, Command } from '../types';

/** Works with both tsx sources and the compiled CommonJS tree. */
function moduleFiles(directory: string): string[] {
  return fs.readdirSync(directory)
    .filter((file) => (file.endsWith('.ts') || file.endsWith('.js')) && !file.endsWith('.d.ts'));
}

/** The runtime and command deployment must discover the same commands. */
export function loadCommands(directory = path.join(__dirname, '..', 'commands')): Command[] {
  const commands: Command[] = [];
  for (const file of moduleFiles(directory)) {
    const command = require(path.join(directory, file)).default as Command | undefined;
    if (!command?.data || typeof command.execute !== 'function') {
      console.warn(`[WARNING] Command ${file} is missing "data" or "execute".`);
      continue;
    }
    commands.push(command);
  }
  return commands;
}

export function loadEvents(directory = path.join(__dirname, '..', 'events')): BotEvent[] {
  return moduleFiles(directory).map((file) => require(path.join(directory, file)).default as BotEvent);
}
