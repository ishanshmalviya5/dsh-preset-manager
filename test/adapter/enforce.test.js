// Integration: the enforcer against the REAL dsh ToolRuntime. Every "denied" case also asserts the body never ran.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world } from '../helpers/world.js';
import { parseManifest, createResolver, PolicyError } from '../../lib/engine/index.js';
import { createEnforcer } from '../../lib/adapter/enforce.js';
import { createAudit } from '../../lib/adapter/audit.js';

const resolverOf = (raw) => {
  const r = parseManifest(raw);
  assert.ok(r.ok, JSON.stringify(r.errors));
  return createResolver(r.manifest);
};

async function setup(manifest, { presetFor = 'coder', agentId = 's1', auditAllowed = false } = {}) {
  const w = await world();
  const audit = createAudit();
  const enforcer = createEnforcer({ resolver: resolverOf(manifest), agentPresets: w.agentPresets, audit, auditAllowed });
  w.ctx.on('tools/change', () => enforcer.refresh()); // what the plugin wires
  return { w, audit, enforcer, agent: w.agent(agentId, presetFor) };
}

const CODER = {
  version: 1,
  presets: { coder: { tools: { allow: ['fs_read', 'fs_write', 'edit'] }, mcp: { servers: { allow: ['github'] }, tools: { allow: ['github/*'] } } } },
  agents: { coder: { preset: 'coder' } },
};

test('denied tools are hidden from the schema, and calling one never runs the body', async () => {
  const { w, enforcer, agent } = await setup(CODER);
  for (const n of ['fs_read', 'fs_write', 'edit', 'bash', 'browser']) w.reg(n);
  enforcer.attach(agent);
  assert.deepEqual(w.names(agent), ['edit', 'fs_read', 'fs_write']);
  const bad = await w.call(agent, 'bash');
  assert.equal(bad.isError, true);
  assert.deepEqual(w.ran, []);
  const ok = await w.call(agent, 'fs_read');
  assert.equal(ok.isError, false);
  assert.deepEqual(w.ran, ['fs_read']);
});

test('an agent with no preset is unmanaged: nothing hidden, nothing denied', async () => {
  const { w, enforcer } = await setup(CODER);
  w.reg('bash');
  const other = w.agent('s9'); // no preset bound
  enforcer.attach(other);
  assert.deepEqual(w.names(other), ['bash']);
  assert.equal((await w.call(other, 'bash')).isError, false);
});

test('late-registered tools are denied by default (dynamic_registration: deny), hidden after the change event', async () => {
  const { w, enforcer, agent } = await setup({ ...CODER, presets: { coder: { tools: { allow: ['*'] } } } });
  w.reg('a');
  enforcer.attach(agent);
  w.reg('late');
  assert.ok(!w.names(agent).includes('late'), 'late tool must not stay visible');
  const r = await w.call(agent, 'late');
  assert.equal(r.isError, true);
  assert.ok(!w.ran.includes('late'));
  assert.equal((await w.call(agent, 'a')).isError, false);
});

test('dynamic_registration: allow admits a late tool that the preset allows', async () => {
  const { w, enforcer, agent } = await setup({ ...CODER, defaults: { dynamic_registration: 'allow' }, presets: { coder: { tools: { allow: ['*'] } } } });
  w.reg('a');
  enforcer.attach(agent);
  w.reg('late');
  assert.ok(w.names(agent).includes('late'));
  assert.equal((await w.call(agent, 'late')).isError, false);
});

test('MCP: unlisted server and unlisted tools are denied, listed ones work', async () => {
  const { w, enforcer, agent } = await setup({ ...CODER, presets: { coder: { tools: { allow: ['*'] }, mcp: { servers: { allow: ['github'] }, tools: { allow: ['github/search_*'] } } } } });
  for (const n of ['mcp__github__search_repos', 'mcp__github__delete_repo', 'mcp__slack__post', 'plain']) w.reg(n);
  enforcer.attach(agent);
  assert.deepEqual(w.names(agent), ['mcp__github__search_repos', 'plain']);
  for (const n of ['mcp__github__delete_repo', 'mcp__slack__post']) assert.equal((await w.call(agent, n)).isError, true);
  assert.equal((await w.call(agent, 'mcp__github__search_repos')).isError, false);
  assert.deepEqual(w.ran, ['mcp__github__search_repos']);
});

test('skill loading and delegation targets are checked from call arguments', async () => {
  const { w, enforcer, agent } = await setup({ ...CODER, presets: { coder: { tools: { allow: ['skill', 'spawn'] }, skills: { allow: ['swift'] }, subagents: { allow: ['reviewer'] } } } });
  w.reg('skill', { name: { type: 'string' } });
  w.reg('spawn', { agent_preset: { type: 'string' } });
  enforcer.attach(agent);
  assert.equal((await w.call(agent, 'skill', { name: 'swift' })).isError, false);
  assert.equal((await w.call(agent, 'skill', { name: 'planning' })).isError, true);
  assert.equal((await w.call(agent, 'spawn', { agent_preset: 'reviewer' })).isError, false);
  assert.equal((await w.call(agent, 'spawn', { agent_preset: 'coder' })).isError, true);
  assert.deepEqual(w.ran, ['skill', 'spawn']);
});

test('nested (PTC-style) dispatch is denied through the same guard', async () => {
  const { w, enforcer, agent } = await setup(CODER);
  w.reg('fs_read'); w.reg('bash');
  enforcer.attach(agent);
  const r = await w.call(agent, 'bash', {}, { parent: Symbol('outer') });
  assert.equal(r.isError, true);
  assert.deepEqual(w.ran, []);
});

test('tools registered in the agent own scope cannot be hidden, but are still denied and reported', async () => {
  const { w, audit, enforcer, agent } = await setup(CODER);
  w.reg('fs_read');
  w.reg('own', {}, agent.ctx);
  enforcer.attach(agent);
  assert.ok(w.names(agent).includes('own'), 'restrict() cannot name an own-scope tool');
  assert.equal((await w.call(agent, 'own')).isError, true);
  assert.deepEqual(w.ran, []);
  assert.ok(audit.events('schema-leak').some((e) => e.capability === 'tool:own'));
  assert.deepEqual(enforcer.metrics(agent).leaked, ['own']);
});

test('agents are isolated: each gets its own preset policy', async () => {
  const m = { version: 1, presets: { a: { tools: { allow: ['x'] } }, b: { tools: { allow: ['y'] } } }, agents: { a: { preset: 'a' }, b: { preset: 'b' } } };
  const { w, enforcer } = await setup(m, { presetFor: 'a' });
  w.reg('x'); w.reg('y');
  const A = w.agent('A', 'a'), B = w.agent('B', 'b');
  enforcer.attach(A); enforcer.attach(B);
  assert.deepEqual(w.names(A), ['x']);
  assert.deepEqual(w.names(B), ['y']);
  assert.equal((await w.call(B, 'x')).isError, true);
  assert.equal((await w.call(A, 'y')).isError, true);
});

test('strict mode: an agent with no bound preset fails closed except host-critical tools', async () => {
  const { w, enforcer } = await setup({ ...CODER, defaults: { strict: true }, admin: { host_critical: ['tool:ask_user'] } });
  w.reg('ask_user'); w.reg('bash');
  const a = w.agent('s2');
  enforcer.attach(a);
  assert.deepEqual(w.names(a), ['ask_user']);
  assert.equal((await w.call(a, 'bash')).isError, true);
  assert.equal((await w.call(a, 'ask_user')).isError, false);
});

test('reload applies a new policy to live agents', async () => {
  const { w, enforcer, agent } = await setup(CODER);
  w.reg('fs_read'); w.reg('bash');
  enforcer.attach(agent);
  assert.deepEqual(w.names(agent), ['fs_read']);
  enforcer.reload(resolverOf({ ...CODER, presets: { coder: { tools: { allow: ['fs_read', 'bash'] } } } }));
  assert.deepEqual(w.names(agent), ['bash', 'fs_read']);
  assert.equal((await w.call(agent, 'bash')).isError, false);
  enforcer.reload(resolverOf({ ...CODER, presets: { coder: { tools: { allow: ['fs_read'] } } } }));
  assert.deepEqual(w.names(agent), ['fs_read']); // tightening works too
});

test('a failed reload changes nothing', async () => {
  const { w, enforcer, agent } = await setup(CODER);
  w.reg('fs_read'); w.reg('bash');
  enforcer.attach(agent);
  const before = w.names(agent);
  const broken = { resolve() { throw new PolicyError('boom'); }, failClosed() { throw new Error('unused'); } };
  assert.throws(() => enforcer.reload(broken), PolicyError);
  assert.deepEqual(w.names(agent), before);
  assert.equal((await w.call(agent, 'fs_read')).isError, false);
  assert.equal((await w.call(agent, 'bash')).isError, true);
});

test('preset recompose on a live agent re-resolves policy', async () => {
  const m = { version: 1, presets: { a: { tools: { allow: ['x'] } }, b: { tools: { allow: ['y'] } } }, agents: { a: { preset: 'a' }, b: { preset: 'b' } } };
  const { w, enforcer, audit } = await setup(m, { presetFor: 'a' });
  w.reg('x'); w.reg('y');
  const A = w.agent('A', 'a');
  enforcer.attach(A);
  assert.deepEqual(w.names(A), ['x']);
  w.bind(A, 'b');
  enforcer.refresh();
  assert.deepEqual(w.names(A), ['y']);
  assert.deepEqual(audit.events('preset-changed').map((e) => [e.from, e.to]), [['a', 'b']]);
});

test('session override narrows a live agent; an invalid one throws and changes nothing', async () => {
  const { w, enforcer, agent } = await setup(CODER);
  w.reg('fs_read'); w.reg('fs_write');
  enforcer.attach(agent);
  assert.deepEqual(w.names(agent), ['fs_read', 'fs_write']);
  enforcer.setSession(agent, { tools: { mode: 'denylist', deny: ['fs_write'] } });
  assert.deepEqual(w.names(agent), ['fs_read']);
  assert.throws(() => enforcer.setSession(agent, { tools: { mode: 'bogus' } }), PolicyError);
  assert.deepEqual(w.names(agent), ['fs_read']);
});

test('a policy that cannot be resolved at attach time fails closed (host-critical only) and is audited', async () => {
  const real = resolverOf({ ...CODER, admin: { host_critical: ['tool:ask_user'] } });
  const broken = { resolve() { throw new PolicyError('bad override', [{ path: 'override.tools.mode', message: 'x' }]); }, failClosed: (r, a) => real.failClosed(r, a) };
  const w = await world();
  const audit = createAudit();
  const enforcer = createEnforcer({ resolver: broken, agentPresets: w.agentPresets, audit });
  w.reg('ask_user'); w.reg('bash'); w.reg('fs_read');
  const agent = w.agent('s1', 'coder');
  enforcer.attach(agent);
  assert.deepEqual(w.names(agent), ['ask_user']);
  assert.equal((await w.call(agent, 'bash')).isError, true);
  assert.equal((await w.call(agent, 'ask_user')).isError, false);
  assert.deepEqual(w.ran, ['ask_user']);
  assert.match(audit.events('policy-error')[0].detail, /bad override/);
  assert.ok(enforcer.metrics(agent).failClosed);
});

test('audit records denials with argument KEYS only, never values', async () => {
  const { w, audit, enforcer, agent } = await setup(CODER);
  w.reg('bash', { command: { type: 'string' } });
  enforcer.attach(agent);
  await w.call(agent, 'bash', { command: 'echo hunter2' });
  const events = audit.events('invocation-denied');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].argKeys, ['command']);
  assert.ok(!JSON.stringify(audit.events()).includes('hunter2'));
});

test('metrics: hidden tools reduce estimated prompt tokens', async () => {
  const { w, enforcer, agent } = await setup(CODER);
  for (const n of ['fs_read', 'bash', 'browser', 'deploy']) w.reg(n);
  enforcer.attach(agent);
  const m = enforcer.metrics(agent);
  assert.equal(m.tools.known, 4);
  assert.equal(m.tools.visible, 1);
  assert.equal(m.tools.hidden, 3);
  assert.ok(m.tokens.saved > 0 && m.tokens.savedPct > 50);
  assert.equal(m.tokens.estimated, true);
});

test('detach lifts both the hiding and the guard', async () => {
  const { w, enforcer, agent } = await setup(CODER);
  w.reg('fs_read'); w.reg('bash');
  enforcer.attach(agent);
  assert.deepEqual(w.names(agent), ['fs_read']);
  enforcer.detach(agent);
  assert.deepEqual(w.names(agent), ['bash', 'fs_read']);
  assert.equal((await w.call(agent, 'bash')).isError, false);
});

test('re-attaching the same agent is idempotent (no stacked restrictions)', async () => {
  const { w, enforcer, agent } = await setup(CODER);
  w.reg('fs_read'); w.reg('bash');
  enforcer.attach(agent); enforcer.attach(agent);
  assert.equal(enforcer.agents().length, 1);
  enforcer.detach(agent);
  assert.deepEqual(w.names(agent), ['bash', 'fs_read']);
});
