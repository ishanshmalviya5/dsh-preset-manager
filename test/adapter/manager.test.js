import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { world } from '../helpers/world.js';
import { createManager } from '../../lib/manager.js';
import { saveManifest, loadManifest } from '../../lib/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dpm-'));
const logger = { error() {}, warn() {} };
const manifest = (allow) => ({ version: 1, presets: { coder: { tools: { allow } } }, agents: { coder: { preset: 'coder' } } });

async function boot(dir, opts = {}) {
  const w = await world();
  const file = path.join(dir, 'presets.json');
  const m = createManager({ agentPresets: w.agentPresets, file, auditFile: path.join(dir, 'audit.jsonl'), logger, ...opts });
  w.ctx.on('tools/change', () => m.onToolsChange());
  return { w, m, file };
}

test('no manifest: plugin is inactive and changes nothing', async () => {
  const { w, m } = await boot(tmp());
  w.reg('bash');
  const a = w.agent('s1', 'coder');
  m.onAgentCreated(a);
  assert.equal(m.active, false);
  assert.deepEqual(w.names(a), ['bash']);
  assert.equal(m.audit.events('config-missing').length, 1);
});

test('valid manifest on disk: policy applies to new agents', async () => {
  const dir = tmp();
  saveManifest(manifest(['fs_read']), path.join(dir, 'presets.json'));
  const { w, m } = await boot(dir);
  w.reg('fs_read'); w.reg('bash');
  const a = w.agent('s1', 'coder');
  m.onAgentCreated(a);
  assert.equal(m.active, true);
  assert.deepEqual(w.names(a), ['fs_read']);
});

test('reloadFromDisk applies a valid edit to live agents', async () => {
  const dir = tmp();
  saveManifest(manifest(['fs_read']), path.join(dir, 'presets.json'));
  const { w, m, file } = await boot(dir);
  w.reg('fs_read'); w.reg('bash');
  const a = w.agent('s1', 'coder');
  m.onAgentCreated(a);
  saveManifest(manifest(['fs_read', 'bash']), file);
  assert.equal(m.reloadFromDisk().ok, true);
  assert.deepEqual(w.names(a), ['bash', 'fs_read']);
});

test('reload with a corrupt or invalid file keeps the previous policy and says why', async () => {
  const dir = tmp();
  saveManifest(manifest(['fs_read']), path.join(dir, 'presets.json'));
  const { w, m, file } = await boot(dir);
  w.reg('fs_read'); w.reg('bash');
  const a = w.agent('s1', 'coder');
  m.onAgentCreated(a);

  fs.writeFileSync(file, '{ not json');
  let r = m.reloadFromDisk();
  assert.equal(r.ok, false);
  assert.deepEqual(w.names(a), ['fs_read']);
  assert.equal((await w.call(a, 'bash')).isError, true);

  fs.writeFileSync(file, JSON.stringify({ version: 1, presets: { coder: { tools: { mode: 'nope' } } } }));
  r = m.reloadFromDisk();
  assert.equal(r.ok, false);
  assert.equal(r.kept, 'previous');
  assert.deepEqual(w.names(a), ['fs_read']);

  fs.rmSync(file);
  r = m.reloadFromDisk();
  assert.equal(r.missing, true);
  assert.deepEqual(w.names(a), ['fs_read']);
  assert.equal(m.audit.events('reload-failed').length, 3);
});

test('invalid manifest at startup: inactive by default, fail-closed when asked', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'presets.json'), '{ broken');
  const open = await boot(dir);
  open.w.reg('bash');
  const a = open.w.agent('s1', 'coder');
  open.m.onAgentCreated(a);
  assert.equal(open.m.active, false);
  assert.deepEqual(open.w.names(a), ['bash']);

  const closed = await boot(dir, { failClosedOnInvalid: true });
  closed.w.reg('bash');
  const b = closed.w.agent('s1', 'coder');
  closed.m.onAgentCreated(b);
  assert.equal(closed.m.active, true);
  assert.deepEqual(closed.w.names(b), []);
  assert.equal((await closed.w.call(b, 'bash')).isError, true);
  assert.deepEqual(closed.w.ran, []);
});

test('saveManifest refuses an invalid manifest and leaves the old file untouched', () => {
  const file = path.join(tmp(), 'presets.json');
  assert.equal(saveManifest(manifest(['a']), file).ok, true);
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(saveManifest({ version: 9 }, file).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(loadManifest(file).ok, true);
});

test('agent disposal detaches policy', async () => {
  const dir = tmp();
  saveManifest(manifest(['fs_read']), path.join(dir, 'presets.json'));
  const { w, m } = await boot(dir);
  w.reg('fs_read'); w.reg('bash');
  const a = w.agent('s1', 'coder');
  m.onAgentCreated(a);
  m.onAgentDisposed(a);
  assert.equal(m.enforcer.agents().length, 0);
  assert.deepEqual(w.names(a), ['bash', 'fs_read']);
});

test('an attach failure is audited and does not block agent creation, unless fail-closed is configured', async () => {
  const dir = tmp();
  saveManifest(manifest(['fs_read']), path.join(dir, 'presets.json'));
  const bad = { session: { id: 's1' }, get ctx() { throw new Error('ctx unavailable'); } };
  const open = await boot(dir);
  assert.doesNotThrow(() => open.m.onAgentCreated(bad));
  assert.equal(open.m.audit.events('attach-failed').length, 1);
  const closed = await boot(dir, { failClosedOnInvalid: true });
  assert.throws(() => closed.m.onAgentCreated(bad), /ctx unavailable/);
});
