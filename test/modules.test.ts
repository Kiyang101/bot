import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Events } from 'discord.js';
import { createClient } from '../src/app/client';
import { loadCommands, loadEvents } from '../src/app/modules';

test('command discovery supports sources and compiled modules and ignores declarations', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bot-commands-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, 'source.ts'), "export default { data: { name: 'source' }, execute() {} };");
  writeFileSync(path.join(directory, 'compiled.js'), "exports.default = { data: { name: 'compiled' }, execute() {} };");
  writeFileSync(path.join(directory, 'ignored.d.ts'), 'export declare const ignored: never;');
  writeFileSync(path.join(directory, 'README.md'), 'Not a command');
  writeFileSync(path.join(directory, 'invalid.js'), 'exports.default = {};');
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));

  assert.deepEqual(loadCommands(directory).map((command) => command.data.name).sort(), ['compiled', 'source']);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /invalid\.js/);
});

test('client wires the same commands used by deployment without connecting to Discord', async () => {
  const client = createClient();
  try {
    const definitions = loadCommands().map((command) => command.data.toJSON());
    assert.ok(definitions.some((command) => command.name === 'play'));
    assert.ok(definitions.some((command) => command.name === 'say'));
    assert.ok(definitions.some((command) => command.name === 'voicelog'));
    assert.deepEqual([...client.commands.keys()], definitions.map((command) => command.name));
    assert.equal(new Set(definitions.map((command) => command.name)).size, definitions.length);
    const events = loadEvents();
    for (const name of new Set(events.map((event) => event.name))) {
      assert.equal(client.listenerCount(name), events.filter((event) => event.name === name).length);
    }
    assert.ok(client.listenerCount(Events.InteractionCreate) > 0);
    assert.equal(client.isReady(), false);
  } finally {
    await client.destroy();
  }
});
