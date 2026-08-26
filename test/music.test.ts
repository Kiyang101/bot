import test from 'node:test';
import assert from 'node:assert/strict';
import * as musicTypes from '../src/lib/music/types';

test('uses 80 percent as the default music volume', () => {
  assert.equal((musicTypes as { DEFAULT_VOLUME?: number }).DEFAULT_VOLUME, 80);
});
