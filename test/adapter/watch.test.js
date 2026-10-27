import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { watchManifest } from '../../lib/watch.js';

const quiet = () => { const warns = []; return { warns, logger: { warn: (m) => warns.push(m) } }; };

test('watcher creation failure (EMFILE) is swallowed, not thrown', () => {
  const { warns, logger } = quiet();
  const stop = watchManifest('/x/presets.json', () => {}, { watch() { throw Object.assign(new Error('too many'), { code: 'EMFILE' }); }, logger });
  assert.equal(typeof stop, 'function');
  stop();
  assert.match(warns[0], /EMFILE/);
});

test('an asynchronous watcher error is handled (this crashed the real host) and the watcher is closed', () => {
  const { warns, logger } = quiet();
  const fake = Object.assign(new EventEmitter(), { closed: false, close() { this.closed = true; } });
  watchManifest('/x/presets.json', () => {}, { watch: () => fake, logger });
  assert.doesNotThrow(() => fake.emit('error', Object.assign(new Error('boom'), { code: 'EMFILE' })));
  assert.equal(fake.closed, true);
  assert.match(warns[0], /automatic reload is off/);
});

test('only changes to the manifest file trigger a debounced reload', async () => {
  let listener;
  let calls = 0;
  const fake = Object.assign(new EventEmitter(), { close() {} });
  const stop = watchManifest('/x/presets.json', () => { calls++; }, { watch: (_d, l) => { listener = l; return fake; }, delayMs: 5 });
  listener('change', 'other.txt');
  listener('rename', 'presets.json'); listener('change', 'presets.json'); listener('change', null);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 1);
  stop();
});

test('stop() cancels a pending reload', async () => {
  let listener; let calls = 0;
  const fake = Object.assign(new EventEmitter(), { close() {} });
  const stop = watchManifest('/x/presets.json', () => { calls++; }, { watch: (_d, l) => { listener = l; return fake; }, delayMs: 5 });
  listener('change', 'presets.json');
  stop();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 0);
});
