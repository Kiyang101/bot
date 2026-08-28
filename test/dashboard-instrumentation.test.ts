import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const instrumentationSource = readFileSync(
  new URL('../dashboard/instrumentation.ts', import.meta.url),
  'utf8',
);
const nodeInstrumentationUrl = new URL('../dashboard/instrumentation.node.ts', import.meta.url);

test('Node-only recovery worker stays behind Next instrumentation runtime boundary', () => {
  assert.equal(
    existsSync(nodeInstrumentationUrl),
    true,
    'Node-only startup code must live in dashboard/instrumentation.node.ts.',
  );
  assert.doesNotMatch(
    instrumentationSource,
    /sound-recovery-worker/,
    'Universal instrumentation must not expose the Node-only worker graph to Next webpack.',
  );
  assert.match(
    instrumentationSource,
    /if \(process\.env\.NEXT_RUNTIME === 'nodejs'\) \{\s*const \{ registerNodeInstrumentation \} = await import\('\.\/instrumentation\.node'\);\s*registerNodeInstrumentation\(\);\s*\}/s,
    'Universal instrumentation must conditionally load the Node-specific module.',
  );

  const nodeInstrumentationSource = readFileSync(nodeInstrumentationUrl, 'utf8');
  assert.match(nodeInstrumentationSource, /sound-recovery-worker/);
  assert.match(nodeInstrumentationSource, /setInterval/);
  assert.match(nodeInstrumentationSource, /runSoundRecoveryWorker/);
});
