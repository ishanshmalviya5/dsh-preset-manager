import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { world } from './helpers/world.js';
import { createManager } from '../lib/manager.js';
import { createActions, createHandler, API, loadExample } from '../lib/settings-api.js';
import { parseManifest, createResolver } from '../lib/engine/index.js';
import { estimateTokens } from '../lib/adapter/names.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dpm-api-'));
const manifest = (allow) => ({ version: 1, presets: { coder: { tools: { allow } } }, agents: { coder: { preset: 'coder' } } });
const quiet = { error() {}, warn() {} };

async function boot({ initial, connection = { requestRejection: () => undefined } } = {}) {
  const dir = tmp();
  const file = path.join(dir, 'presets.json');
  if (initial) fs.writeFileSync(file, JSON.stringify(initial));
  const w = await world();
  const manager = createManager({ agentPresets: w.agentPresets, globalTools: () => w.T.schemas().map((s) => ({ name: s.name, tokens: estimateTokens(s) })), file, auditFile: path.join(dir, 'audit.jsonl'), logger: quiet });
  w.ctx.on('tools/change', () => manager.onToolsChange());
  const server = http.createServer(createHandler(createActions(manager), connection));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}${API}`;
  const post = async (action, body = {}, init = {}) => {
    const res = await fetch(`${base}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...init });
    return { status: res.status, body: await res.json() };
  };
  return { w, manager, file, dir, post, base, close: () => { server.closeAllConnections(); server.close(); } };
}

test('guards: dsh auth first, then method, content type, size, JSON shape; no stack traces leak', async (t) => {
  const s = await boot();
  t.after(s.close);
  assert.equal((await s.post('nope')).status, 404);
  assert.equal((await fetch(`${s.base}/get`)).status, 405);
  assert.equal((await fetch(`${s.base}/get`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${s.base}/get`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1]' })).status, 200); // non-object body is treated as {}
  assert.equal((await fetch(`${s.base}/get`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' })).status, 400);
  const big = await fetch(`${s.base}/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest: 'x'.repeat(600 * 1024) }) }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
});

test('guards: rejected, throwing or missing connection never reaches an action', async (t) => {
  for (const [connection, status] of [[{ requestRejection: () => 401 }, 401], [{ requestRejection: () => 403 }, 403], [{ requestRejection: () => { throw new Error('x'); } }, 403], [{}, 503], [null, 503]]) {
    const s = await boot({ connection });
    t.after(s.close);
    assert.equal((await s.post('save', { manifest: JSON.stringify(manifest(['a'])) })).status, status);
    assert.equal(fs.existsSync(s.file), false, 'a refused request must not write anything');
  }
});

test('get: with no manifest the page gets an example to start from and nothing is active', async (t) => {
  const s = await boot();
  t.after(s.close);
  const { body } = await s.post('get');
  assert.equal(body.ok, true);
  assert.equal(body.value.missing, true);
  assert.equal(body.value.active, false);
  assert.ok(parseManifest(JSON.parse(body.value.example)).ok, 'bundled example must itself be valid');
});

test('the bundled example defines the five presets and every one resolves', () => {
  const r = parseManifest(JSON.parse(loadExample()));
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(Object.keys(r.manifest.presets).sort(), ['automation', 'coder', 'planner', 'researcher', 'reviewer']);
  const resolver = createResolver(r.manifest, { builtinHostCritical: ['tool:discover'] });
  const coder = resolver.resolve('standard');
  assert.equal(coder.state('tool:bash'), 'primary');
  assert.equal(coder.state('tool:web_fetch'), 'secondary');
  assert.equal(coder.state('tool:job_kill'), 'tertiary');
  assert.equal(coder.state('tool:secret'), 'denied');
  const reviewer = resolver.resolve('minimal');
  assert.equal(reviewer.state('tool:read'), 'primary');
  assert.equal(reviewer.state('tool:read_image'), 'secondary');
  assert.equal(reviewer.state('tool:bash'), 'tertiary');
  assert.equal(reviewer.state('tool:write'), 'denied');
  assert.equal(reviewer.state('tool:working_directory'), 'primary'); // host-critical
  assert.equal(reviewer.state('tool:discover'), 'primary'); // built-in, in every preset
});

test('validate: precise messages, never writes', async (t) => {
  const s = await boot();
  t.after(s.close);
  let r = (await s.post('validate', { manifest: '{ nope' })).body.value;
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /not valid JSON/);
  r = (await s.post('validate', { manifest: JSON.stringify({ version: 1, presets: { p: { tools: { mode: 'x' } } } }) })).body.value;
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'presets.p.tools.mode'));
  r = (await s.post('validate', { manifest: JSON.stringify(manifest(['a'])) })).body.value;
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(s.file), false);
});

test('save: applies to a live agent, persists 0600, and a second save keeps the first for rollback', async (t) => {
  const s = await boot();
  t.after(s.close);
  s.w.reg('fs_read'); s.w.reg('bash');
  const agent = s.w.agent('s1', 'coder');
  s.manager.onAgentCreated(agent); // inactive: nothing yet
  assert.deepEqual(s.w.names(agent), ['bash', 'fs_read']);

  let r = (await s.post('save', { manifest: JSON.stringify(manifest(['fs_read'])) })).body.value;
  assert.equal(r.ok, true);
  assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  assert.equal(s.manager.active, true);

  const fresh = s.w.agent('s2', 'coder');
  s.manager.onAgentCreated(fresh);
  assert.deepEqual(s.w.names(fresh), ['fs_read']);

  r = (await s.post('save', { manifest: JSON.stringify(manifest(['fs_read', 'bash'])) })).body.value;
  assert.equal(r.ok, true);
  assert.deepEqual(s.w.names(fresh), ['bash', 'fs_read']); // live agent followed the edit

  r = (await s.post('rollback')).body.value;
  assert.equal(r.ok, true);
  assert.deepEqual(s.w.names(fresh), ['fs_read']);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.file, 'utf8')), manifest(['fs_read']));
});

test('save: an invalid manifest changes nothing, on disk or in memory', async (t) => {
  const s = await boot({ initial: manifest(['fs_read']) });
  t.after(s.close);
  s.w.reg('fs_read'); s.w.reg('bash');
  const agent = s.w.agent('s1', 'coder');
  s.manager.onAgentCreated(agent);
  const before = fs.readFileSync(s.file, 'utf8');
  const r = (await s.post('save', { manifest: JSON.stringify({ version: 1, presets: { coder: { tools: { mode: 'bogus' } } } }) })).body.value;
  assert.equal(r.ok, false);
  assert.equal(r.kept, 'previous');
  assert.equal(fs.readFileSync(s.file, 'utf8'), before);
  assert.deepEqual(s.w.names(agent), ['fs_read']);
  assert.equal((await s.w.call(agent, 'bash')).isError, true);
});

test('save: if writing fails after the policy was applied, the live policy is put back', async (t) => {
  const s = await boot({ initial: manifest(['fs_read']) });
  t.after(s.close);
  s.w.reg('fs_read'); s.w.reg('bash');
  const agent = s.w.agent('s1', 'coder');
  s.manager.onAgentCreated(agent);
  fs.mkdirSync(`${s.file}.tmp`); // the atomic-write temp path is now a directory: the write must fail
  const r = (await s.post('save', { manifest: JSON.stringify(manifest(['fs_read', 'bash'])) })).body.value;
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /could not write/);
  assert.deepEqual(s.w.names(agent), ['fs_read'], 'memory and disk must not disagree');
  assert.equal((await s.w.call(agent, 'bash')).isError, true);
});

test('rollback with nothing to roll back to is a clear refusal', async (t) => {
  const s = await boot({ initial: manifest(['a']) });
  t.after(s.close);
  const r = (await s.post('rollback')).body.value;
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /no previous/);
});

test('dryrun: reports savings for a candidate without writing; uses live agents when there are any', async (t) => {
  const s = await boot();
  t.after(s.close);
  for (const n of ['fs_read', 'bash', 'browser']) s.w.reg(n);
  let r = (await s.post('dryrun', { manifest: JSON.stringify(manifest(['fs_read'])), agent: 'coder' })).body.value;
  assert.equal(r.ok, true);
  assert.equal(r.source, 'registered tools');
  assert.deepEqual(r.counts, { total: 3, allowed: 1, denied: 2, primary: 1, secondary: 0, tertiary: 0 });
  assert.ok(r.tokens.saved > 0);
  assert.deepEqual(r.denied.map((d) => d.id).sort(), ['tool:bash', 'tool:browser']);
  assert.equal(fs.existsSync(s.file), false);

  s.manager.apply(manifest(['fs_read']));
  s.manager.onAgentCreated(s.w.agent('s1', 'coder'));
  r = (await s.post('dryrun', { manifest: JSON.stringify(manifest(['fs_read', 'bash'])), agent: 'coder' })).body.value;
  assert.equal(r.source, 'live agents');
  assert.equal(r.counts.allowed, 2);

  r = (await s.post('dryrun', { manifest: '{ bad', agent: 'coder' })).body;
  assert.equal(r.ok, false);
});

test('explain: names the layer and rule; rejects malformed capability ids', async (t) => {
  const s = await boot({ initial: manifest(['fs_read']) });
  t.after(s.close);
  let r = (await s.post('explain', { agent: 'coder', capability: 'tool:bash' })).body.value;
  assert.equal(r.ok, true);
  assert.equal(r.state, 'denied');
  assert.equal(r.rule, 'not-in-allowlist');
  r = (await s.post('explain', { agent: 'coder', capability: 'nonsense' })).body.value;
  assert.equal(r.ok, false);
  assert.equal((await s.post('explain', { agent: 'coder' })).status, 400);
  r = (await s.post('explain', { agent: 'coder', capability: 'tool:bash', manifest: JSON.stringify(manifest(['bash'])) })).body.value;
  assert.equal(r.state, 'primary'); // against the candidate, not the saved one
});

test('get exposes live agent metrics; audit lists recent decisions without argument values', async (t) => {
  const s = await boot({ initial: manifest(['fs_read']) });
  t.after(s.close);
  s.w.reg('fs_read'); s.w.reg('bash', { command: { type: 'string' } });
  const agent = s.w.agent('s1', 'coder');
  s.manager.onAgentCreated(agent);
  await s.w.call(agent, 'bash', { command: 'echo hunter2' });
  const got = (await s.post('get')).body.value;
  assert.equal(got.metrics.length, 1);
  assert.equal(got.metrics[0].tools.hidden, 1);
  assert.deepEqual(got.agents, [{ key: 'coder', preset: 'coder' }]);
  const audit = (await s.post('audit')).body.value.events;
  assert.equal(audit[0].type !== undefined, true);
  assert.ok(audit.some((e) => e.type === 'invocation-denied' && e.capability === 'tool:bash'));
  assert.ok(!JSON.stringify(audit).includes('hunter2'));
});

test('an unexpected failure shows "internal error" to the page but logs the real cause for the host', async () => {
  const logged = [];
  const server = http.createServer(createHandler({ boom: () => { throw new Error('secret detail'); } }, { requestRejection: () => undefined }, { error: (m) => logged.push(m) }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${API}/boom`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.deepEqual(body, { ok: false, error: 'internal error' });
    assert.match(logged.join('\n'), /boom failed: Error: secret detail/);
  } finally { server.closeAllConnections(); server.close(); }
});
