// Spike: prove how the REAL dsh-tools registry behaves before any plugin code relies on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dshImport, dshVersion } from '../helpers/dsh.js';

const { Context } = await dshImport('@deepseek-ai/cordis');
const { ToolRuntime, defineTool } = await dshImport('@deepseek-ai/dsh-tools');
const { createScope } = await dshImport('@deepseek-ai/dsh-scope');
const systemPrompt = await dshImport('@deepseek-ai/dsh-system-prompt');

const tool = (name, onRun = () => {}) => defineTool({
  name, description: `tool ${name}`, parameters: {},
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
  async execute() { onRun(); return `ran ${name}`; },
});

async function world() {
  const ctx = new Context();
  ctx.plugin(systemPrompt.default ?? systemPrompt.SystemPrompt);
  ctx.plugin(ToolRuntime);
  await new Promise((r) => setImmediate(r));
  const ran = [];
  const reg = (n, c = ctx) => c.get('tools').register(tool(n, () => ran.push(n)));
  const parent = {}, child = {}, sibling = {};
  const P = createScope(ctx, parent);
  const C = createScope(ctx, child, { parent });
  const S = createScope(ctx, sibling);
  const call = (agent, name) => ctx.get('tools').execute({ callId: `c${Math.random()}`, name, arguments: {}, agent, signal: new AbortController().signal });
  const names = (agent) => ctx.get('tools').schemas(agent).map((s) => s.name).sort();
  return { ctx, ran, reg, parent, child, sibling, P, C, S, call, names };
}

test('environment', () => { console.log('dsh', dshVersion()); });

test('restrict(allow) hides tools for one agent only', async () => {
  const w = await world();
  for (const n of ['a', 'b', 'c']) w.reg(n);
  w.P.ctx.get('tools').restrict({ allow: ['a'] });
  assert.deepEqual(w.names(w.parent), ['a']);
  assert.deepEqual(w.names(w.sibling), ['a', 'b', 'c']);
});

test('restrict throws on unknown name and on empty filter', async () => {
  const w = await world();
  w.reg('a');
  assert.throws(() => w.P.ctx.get('tools').restrict({ allow: ['nope'] }));
  assert.throws(() => w.P.ctx.get('tools').restrict({}));
});

test('U2: does a PARENT restriction bind its CHILD?', async () => {
  const w = await world();
  for (const n of ['a', 'b']) w.reg(n);
  w.P.ctx.get('tools').restrict({ allow: ['a'] });
  console.log('U2 restrict: child sees', w.names(w.child));
  assert.ok(Array.isArray(w.names(w.child)));
});

test('U2: does a PARENT guard bind its CHILD?', async () => {
  const w = await world();
  for (const n of ['a', 'b']) w.reg(n);
  w.P.ctx.get('tools').guard((e) => (e.name === 'b' ? 'denied by parent guard' : undefined));
  const r = await w.call(w.child, 'b');
  console.log('U2 guard: child calling b ->', JSON.stringify(r).slice(0, 200));
  assert.ok(r);
});

test('guard denies execution even when tool is visible, and the body never runs', async () => {
  const w = await world();
  w.reg('a'); w.reg('b');
  w.P.ctx.get('tools').guard((e) => (e.name === 'b' ? 'policy: b denied' : undefined));
  const ok = await w.call(w.parent, 'a');
  const bad = await w.call(w.parent, 'b');
  assert.deepEqual(w.ran, ['a']);
  console.log('guard result shape:', JSON.stringify(bad).slice(0, 240));
  assert.ok(ok && bad);
});

test('model calling a tool restricted away is rejected and body never runs', async () => {
  const w = await world();
  w.reg('a'); w.reg('b');
  w.P.ctx.get('tools').restrict({ allow: ['a'] });
  const bad = await w.call(w.parent, 'b');
  assert.deepEqual(w.ran, []);
  console.log('hidden-call result:', JSON.stringify(bad).slice(0, 240));
});

test('late registration: allowlist stays closed, denylist leaks until re-resolved', async () => {
  const w = await world();
  w.reg('a'); w.reg('b');
  const pAllow = createScope(w.ctx, {}); const kAllow = {};
  const A = createScope(w.ctx, kAllow); A.ctx.get('tools').restrict({ allow: ['a'] });
  const kDeny = {}; const D = createScope(w.ctx, kDeny); D.ctx.get('tools').restrict({ deny: ['b'] });
  w.reg('late');
  console.log('late reg  allow-agent sees', w.names(kAllow), '| deny-agent sees', w.names(kDeny));
  assert.ok(!w.names(kAllow).includes('late'), 'allowlist must hide late tool');
});

test('scope-local registration bypasses restrict', async () => {
  const w = await world();
  w.reg('a');
  w.P.ctx.get('tools').restrict({ allow: ['a'] });
  w.P.ctx.get('tools').register(tool('local'));
  console.log('scope-local tool visible despite allow:', w.names(w.parent));
});

test('tools/change fires on restrict and on register', async () => {
  const w = await world();
  let n = 0; w.ctx.on('tools/change', () => { n++; });
  w.reg('a'); w.P.ctx.get('tools').restrict({ deny: ['a'] });
  console.log('tools/change count', n);
  assert.ok(n >= 2);
});

test('U1: guard also denies a nested (PTC-style, parent-token) dispatch; body never runs', async () => {
  const w = await world();
  w.reg('a'); w.reg('b');
  w.P.ctx.get('tools').guard((e) => (e.name === 'b' ? 'policy: b denied' : undefined));
  const nested = (name) => w.ctx.get('tools').execute({ callId: `n${name}`, name, arguments: {}, agent: w.parent, parent: Symbol('outer'), signal: new AbortController().signal });
  const bad = await nested('b');
  assert.equal(bad.isError, true);
  assert.deepEqual(w.ran, []);
});

test('guard cannot be removed by a lower scope; sibling unaffected', async () => {
  const w = await world();
  w.reg('b');
  w.P.ctx.get('tools').guard((e) => (e.name === 'b' ? 'no' : undefined));
  w.C.ctx.get('tools').guard(() => undefined); // child "allow" has no effect
  assert.equal((await w.call(w.child, 'b')).isError, true);
  assert.equal((await w.call(w.sibling, 'b')).isError, false);
});

test('disposing a restriction restores visibility (needed for atomic swap)', async () => {
  const w = await world();
  w.reg('a'); w.reg('b');
  const off = w.P.ctx.get('tools').restrict({ allow: ['a'] });
  off();
  assert.deepEqual(w.names(w.parent), ['a', 'b']);
});

test('swap: new restriction first, then dispose old -> never looser in between', async () => {
  const w = await world();
  w.reg('a'); w.reg('b'); w.reg('c');
  const old = w.P.ctx.get('tools').restrict({ allow: ['a', 'b'] });
  w.P.ctx.get('tools').restrict({ allow: ['b', 'c'] });
  assert.deepEqual(w.names(w.parent), ['b']); // intersection while both live
  old();
  assert.deepEqual(w.names(w.parent), ['b', 'c']);
});
