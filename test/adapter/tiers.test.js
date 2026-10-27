// Tiers against the REAL dsh ToolRuntime. Only `approval` (the human prompt) and the skill list are faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world } from '../helpers/world.js';
import { parseManifest, createResolver } from '../../lib/engine/index.js';
import { createEnforcer } from '../../lib/adapter/enforce.js';
import { createAudit } from '../../lib/adapter/audit.js';
import { createDiscovery } from '../../lib/adapter/discover.js';
import { BUILTIN_HOST_CRITICAL } from '../../lib/adapter/names.js';

const resolverOf = (raw) => {
  const r = parseManifest(raw);
  assert.ok(r.ok, JSON.stringify(r.errors));
  return createResolver(r.manifest, { builtinHostCritical: BUILTIN_HOST_CRITICAL });
};
const manifest = (tools, extra = {}) => ({ version: 1, presets: { p: { tools, ...extra } }, agents: { p: { preset: 'p' } } });
const TIERED = manifest({ primary: ['read'], secondary: ['web_fetch', 'read_image'], tertiary: ['bash'] });

/** approval: undefined = no approval service (unattended); otherwise (request) => outcome. */
async function setup(raw = TIERED, { approval, skills, extra = [] } = {}) {
  const w = await world();
  const audit = createAudit();
  const enforcer = createEnforcer({ resolver: resolverOf(raw), agentPresets: w.agentPresets, audit });
  const discovery = createDiscovery({ enforcer, audit, listSkills: skills });
  const asks = [];
  if (approval) { w.ctx.provide('approval'); w.ctx.set('approval', { request: async (req) => { asks.push(req); return approval(req); } }); }
  w.T.register(discovery.tool);
  w.ctx.on('tools/pre-execute', (exec, next) => discovery.preExecute(exec, next));
  w.ctx.on('tools/result', (exec, result) => { discovery.onResult(exec, result); });
  w.ctx.on('tools/change', () => enforcer.refresh());
  for (const n of ['read', 'web_fetch', 'read_image', 'bash', 'secret']) w.reg(n);
  const offs = {};
  for (const [n, params] of extra) offs[n] = w.reg(n, params); // registered before the agent exists, like real MCP and skill tools
  const agent = w.agent('s1', 'p');
  enforcer.attach(agent);
  const discover = (args, a = agent) => w.call(a, 'discover', args);
  const text = (r) => r.content?.[0]?.text ?? '';
  return { w, audit, enforcer, discovery, agent, asks, discover, text, offs };
}

test('primary is visible; secondary and tertiary are hidden; discover is always reachable', async () => {
  const { w, agent } = await setup();
  assert.deepEqual(w.names(agent), ['discover', 'read']);
});

test('a hidden secondary or tertiary tool cannot be called directly, and its body never runs', async () => {
  const { w, agent } = await setup();
  for (const n of ['web_fetch', 'bash', 'secret']) assert.equal((await w.call(agent, n)).isError, true);
  assert.deepEqual(w.ran, []);
});

test('search lists secondary and tertiary only, never primary or denied; filters by query and tier', async () => {
  const { discover, text } = await setup();
  const all = text(await discover({ action: 'search' }));
  assert.match(all, /web_fetch \[secondary\]/);
  assert.match(all, /read_image \[secondary\]/);
  assert.match(all, /bash \[tertiary\]/);
  assert.doesNotMatch(all, /^- read /m, 'primary tools are already in the prompt');
  assert.doesNotMatch(all, /secret/, 'denied tools are invisible, not just blocked');
  assert.doesNotMatch(all, /discover/);
  assert.match(text(await discover({ action: 'search', tier: 'tertiary' })), /^1 match:\n- bash/);
  assert.match(text(await discover({ action: 'search', query: 'image' })), /read_image/);
  assert.match(text(await discover({ action: 'search', query: 'zzzz' })), /No matches/);
  assert.equal((await discover({ action: 'search', tier: 'primary' })).isError, true);
});

test('search with nothing hidden says so', async () => {
  const { discover, text } = await setup(manifest({ primary: ['read'] }));
  assert.match(text(await discover({ action: 'search' })), /No secondary or tertiary/);
});

test('secondary, "session": the model enables it, it becomes visible and stays callable', async () => {
  const { w, agent, discover, text, audit } = await setup();
  const r = await discover({ action: 'enable', name: 'web_fetch', duration: 'session' });
  assert.equal(r.isError, false);
  assert.match(text(r), /enabled for the rest of this session/);
  assert.deepEqual(w.names(agent), ['discover', 'read', 'web_fetch']);
  for (let i = 0; i < 3; i++) assert.equal((await w.call(agent, 'web_fetch')).isError, false);
  assert.equal(w.ran.filter((n) => n === 'web_fetch').length, 3);
  assert.ok(audit.events('capability-enabled').some((e) => e.capability === 'tool:web_fetch' && /chosen by model/.test(e.detail)));
});

test('secondary, "now" (the default): usable once, then hidden and blocked again', async () => {
  const { w, agent, discover, audit } = await setup();
  assert.equal((await discover({ action: 'enable', name: 'web_fetch' })).isError, false);
  assert.ok(w.names(agent).includes('web_fetch'));
  assert.equal((await w.call(agent, 'web_fetch')).isError, false);
  assert.ok(!w.names(agent).includes('web_fetch'), 'spent after one use');
  assert.equal((await w.call(agent, 'web_fetch')).isError, true);
  assert.deepEqual(w.ran, ['web_fetch']);
  assert.ok(audit.events('capability-expired').some((e) => e.reason === 'used-once'));
});

test('enabling something denied, unknown or primary: denied and unknown are indistinguishable', async () => {
  const { discover, text } = await setup();
  const denied = await discover({ action: 'enable', name: 'secret' });
  const unknown = await discover({ action: 'enable', name: 'no_such_tool' });
  assert.equal(denied.isError, true);
  assert.equal(unknown.isError, true);
  assert.equal(text(denied).replace('secret', 'X'), text(unknown).replace('no_such_tool', 'X'));
  assert.match(text(await discover({ action: 'enable', name: 'read' })), /already in your tool list/);
});

test('tertiary: the user is asked (allow), with the tool, duration and reason in the prompt text', async () => {
  const { w, agent, discover, asks, audit } = await setup(TIERED, { approval: () => 'allowed-once' });
  const r = await discover({ action: 'enable', name: 'bash', duration: 'session', reason: 'run the test suite' });
  assert.equal(r.isError, false);
  assert.equal(asks.length, 1);
  assert.match(asks[0].reason, /"bash"/);
  assert.match(asks[0].reason, /rest of this session/);
  assert.match(asks[0].reason, /run the test suite/);
  assert.equal(asks[0].toolName, 'discover');
  assert.ok(w.names(agent).includes('bash'));
  assert.equal((await w.call(agent, 'bash')).isError, false);
  assert.deepEqual(audit.events('approval-granted').map((e) => e.capability), ['tool:bash']);
});

test('tertiary: the user rejects -> not enabled, still hidden and blocked, and it is logged', async () => {
  const { w, agent, discover, audit } = await setup(TIERED, { approval: () => 'rejected' });
  const r = await discover({ action: 'enable', name: 'bash', reason: 'please' });
  assert.equal(r.isError, true);
  assert.ok(!w.names(agent).includes('bash'));
  assert.equal((await w.call(agent, 'bash')).isError, true);
  assert.deepEqual(w.ran, []);
  assert.equal(audit.events('approval-denied').length, 1);
  assert.equal(audit.events('approval-granted').length, 0);
});

test('tertiary: unattended (no approval service) denies and logs; nothing is enabled', async () => {
  const { w, agent, discover, audit, enforcer } = await setup(TIERED, { approval: undefined });
  const r = await discover({ action: 'enable', name: 'bash', duration: 'session', reason: 'nobody is watching' });
  assert.equal(r.isError, true);
  assert.ok(!w.names(agent).includes('bash'));
  assert.equal(enforcer.isEnabled(agent, 'tool:bash'), false);
  assert.deepEqual(w.ran, []);
  assert.equal(audit.events('approval-denied').length, 1);
});

test('tertiary: cancelled and unavailable outcomes also deny', async () => {
  for (const outcome of ['cancelled', 'unavailable']) {
    const { agent, discover, enforcer } = await setup(TIERED, { approval: () => outcome });
    assert.equal((await discover({ action: 'enable', name: 'bash' })).isError, true, outcome);
    assert.equal(enforcer.isEnabled(agent, 'tool:bash'), false, outcome);
  }
});

test('tertiary cannot be granted around the prompt: tool body without an ask, or the enforcer without proof', async () => {
  const { agent, discovery, enforcer } = await setup(TIERED, { approval: () => 'allowed-once' });
  await assert.rejects(() => discovery.tool.execute({ action: 'enable', name: 'bash' }, { agent, callId: 'forged' }), /approval was not recorded/);
  assert.equal(enforcer.isEnabled(agent, 'tool:bash'), false);
  assert.equal(enforcer.enable(agent, 'tool:bash', { duration: 'session' }).ok, false);
  assert.equal(enforcer.isEnabled(agent, 'tool:bash'), false);
});

test('the prompt text cannot be hijacked by the model: whitespace collapsed, length capped', async () => {
  const { discover, asks } = await setup(TIERED, { approval: () => 'rejected' });
  await discover({ action: 'enable', name: 'bash', reason: `line1\n\n\nline2 ${'x'.repeat(2000)}` });
  assert.doesNotMatch(asks[0].reason, /\n/);
  assert.ok(asks[0].reason.length < 600);
});

test('a secondary grant does not let the model reach a tertiary tool by name', async () => {
  const { w, agent, discover } = await setup(TIERED, { approval: () => 'rejected' });
  await discover({ action: 'enable', name: 'web_fetch', duration: 'session' });
  assert.equal((await w.call(agent, 'bash')).isError, true);
});

test('nested (PTC-style) dispatch honours tiers: blocked until enabled', async () => {
  const { w, agent, discover } = await setup();
  const nested = (n) => w.call(agent, n, {}, { parent: Symbol('outer') });
  assert.equal((await nested('web_fetch')).isError, true);
  await discover({ action: 'enable', name: 'web_fetch', duration: 'session' });
  assert.equal((await nested('web_fetch')).isError, false);
});

test('grants are per agent', async () => {
  const { w, agent, enforcer, discover } = await setup();
  const other = w.agent('s2', 'p');
  enforcer.attach(other);
  await discover({ action: 'enable', name: 'web_fetch', duration: 'session' });
  assert.ok(w.names(agent).includes('web_fetch'));
  assert.ok(!w.names(other).includes('web_fetch'));
  assert.equal((await w.call(other, 'web_fetch')).isError, true);
});

test('policy changes revoke grants that no longer fit: denied, or made stricter', async () => {
  const { w, agent, enforcer, discover, audit } = await setup();
  await discover({ action: 'enable', name: 'web_fetch', duration: 'session' });
  await discover({ action: 'enable', name: 'read_image', duration: 'session' });
  enforcer.reload(resolverOf(manifest({ primary: ['read'], tertiary: ['web_fetch'], secondary: ['bash'] }))); // web_fetch stricter; read_image now denied
  assert.deepEqual(w.names(agent), ['discover', 'read']);
  assert.equal(enforcer.isEnabled(agent, 'tool:web_fetch'), false);
  assert.equal(enforcer.isEnabled(agent, 'tool:read_image'), false);
  const reasons = audit.events('capability-expired').map((e) => e.reason).sort();
  assert.deepEqual(reasons, ['denied', 'stricter-tier']);
});

test('a preset switch on a live agent clears its grants', async () => {
  const raw = { version: 1, presets: { p: { tools: { primary: ['read'], secondary: ['web_fetch'] } }, q: { tools: { primary: ['read'], secondary: ['web_fetch'] } } }, agents: { p: { preset: 'p' }, q: { preset: 'q' } } };
  const { w, agent, enforcer, discover } = await setup(raw);
  await discover({ action: 'enable', name: 'web_fetch', duration: 'session' });
  assert.ok(w.names(agent).includes('web_fetch'));
  w.bind(agent, 'q');
  enforcer.refresh();
  assert.ok(!w.names(agent).includes('web_fetch'));
});

test('skills have tiers too: enforced when the skill is loaded, discoverable, and tertiary skills need approval', async () => {
  const raw = manifest({ primary: ['read', 'skill'] }, { skills: { primary: ['swift'], secondary: ['testing'], tertiary: ['deploy'] } });
  const skills = async () => [{ name: 'swift', description: 'Swift tips' }, { name: 'testing', description: 'Testing help' }, { name: 'deploy', description: 'Ship it' }, { name: 'forbidden', description: 'x' }];
  const { w, agent, discover, text } = await setup(raw, { approval: () => 'allowed-once', skills, extra: [['skill', { name: { type: 'string' } }]] });
  const load = (name) => w.call(agent, 'skill', { name });
  assert.equal((await load('swift')).isError, false);
  assert.equal((await load('testing')).isError, true);
  assert.equal((await load('forbidden')).isError, true);
  const found = text(await discover({ action: 'search' }));
  assert.match(found, /skill:testing \[secondary\]/);
  assert.match(found, /skill:deploy \[tertiary\]/);
  assert.doesNotMatch(found, /forbidden/);
  await discover({ action: 'enable', name: 'skill:testing', duration: 'session' });
  assert.equal((await load('testing')).isError, false);
  assert.equal((await load('deploy')).isError, true);
  await discover({ action: 'enable', name: 'skill:deploy', reason: 'release' });
  assert.equal((await load('deploy')).isError, false);
});

test('a broken skill catalog does not break tool search', async () => {
  const { discover, text } = await setup(TIERED, { skills: async () => { throw new Error('catalog down'); } });
  assert.match(text(await discover({ action: 'search' })), /web_fetch/);
});

test('MCP tools tier by server/tool id', async () => {
  const raw = manifest({ primary: ['read'] }, { mcp: { servers: { allow: ['github'] }, tools: { primary: ['github/get_*'], secondary: ['github/search_*'], tertiary: ['github/delete_*'] } } });
  const { w, agent, discover, text } = await setup(raw, { approval: () => 'rejected', extra: ['mcp__github__get_file', 'mcp__github__search_code', 'mcp__github__delete_repo', 'mcp__slack__post'].map((n) => [n]) });
  assert.deepEqual(w.names(agent).filter((n) => n.startsWith('mcp__')), ['mcp__github__get_file']);
  assert.match(text(await discover({ action: 'search' })), /mcp__github__search_code \[secondary\]/);
  assert.doesNotMatch(text(await discover({ action: 'search' })), /slack/);
});
test('metrics report tiers, enabled grants and the token saving', async () => {
  const { agent, enforcer, discover } = await setup();
  await discover({ action: 'enable', name: 'web_fetch', duration: 'session' });
  const m = enforcer.metrics(agent);
  assert.equal(m.tools.tiers.primary, 2); // read + discover
  assert.equal(m.tools.tiers.secondary, 2);
  assert.equal(m.tools.tiers.tertiary, 1);
  assert.equal(m.tools.tiers.denied, 1);
  assert.deepEqual(m.enabled, [{ id: 'tool:web_fetch', tier: 'secondary', duration: 'session' }]);
  assert.ok(m.tokens.saved > 0);
});

test('a granted tool that DSH unregisters (plugin teardown) does not break a refresh, and the grant returns with the tool', async () => {
  const raw = manifest({ primary: ['read'], secondary: ['temp'] });
  const { w, agent, discover, offs, audit } = await setup(raw, { extra: [['temp']] });
  await discover({ action: 'enable', name: 'temp', duration: 'session' });
  assert.ok(w.names(agent).includes('temp'));
  offs.temp(); // the owning plugin is disposed; tools/change triggers a refresh
  assert.ok(!w.names(agent).includes('temp'));
  assert.equal(audit.events('apply-failed').length, 0);
  w.reg('temp');
  assert.ok(w.names(agent).includes('temp'), 'the session grant still covers it');
});
