import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildInventory, collectInventory, BUILTIN_TOOL_PLUGINS } from '../lib/inventory.js';
import { statesFor, withMatrix } from '../lib/matrix.js';
import { createManager } from '../lib/manager.js';
import { createActions } from '../lib/settings-api.js';
import { parseManifest, createResolver } from '../lib/engine/index.js';
import { capabilityOf, BUILTIN_HOST_CRITICAL } from '../lib/adapter/names.js';

const inventory = () => buildInventory({
  presets: [{ id: 'standard', name: 'Standard', description: 'Default' }, { id: 'junior-dev' }],
  compositions: [{ id: 'standard', rows: [{ moduleName: 'dsh-tool-fs' }, { moduleName: 'dsh-tool-web' }] }],
  plugins: [{ moduleName: 'dsh-tool-fs', enabled: true }, { moduleName: 'dsh-tool-web', enabled: false }, { moduleName: 'dsh-theme', enabled: true }],
  tools: [
    { name: 'read', description: 'Read a file', tokens: 100 }, { name: 'write', description: 'Write', tokens: 120 }, { name: 'web_fetch', description: 'Fetch', tokens: 90 },
    { name: 'mcp__github__create_issue', description: 'Create', tokens: 80 }, { name: 'mcp__github__search', description: 'Search', tokens: 70 },
    { name: 'mystery', description: 'from a third-party plugin', tokens: 50 }, { name: 'discover', description: 'ours', tokens: 300 },
  ],
  skills: [{ name: 'swift', description: 'Swift help', provider: 'filesystem' }, { name: 'discovery', description: 'ours', provider: 'preset-manager' }],
});
const ids = (inv) => inv.groups.flatMap((g) => g.items.map((i) => i.id));

test('inventory groups tools under their plugin, MCP server and skill provider; unknown tools are not guessed', () => {
  const inv = inventory();
  const byId = Object.fromEntries(inv.groups.map((g) => [g.id, g.items.map((i) => i.label)]));
  assert.deepEqual(byId['plugin:dsh-tool-fs'], ['read', 'write']);
  assert.deepEqual(byId['plugin:dsh-tool-web'], ['web_fetch']);
  assert.deepEqual(byId['mcp:github'], ['create_issue', 'search']);
  assert.deepEqual(byId['skills:filesystem'], ['swift']);
  assert.deepEqual(byId['other-tools'], ['mystery']);
  assert.equal(inv.groups.at(-1).id, 'other-tools', 'the catch-all group is last');
  assert.match(inv.groups.find((g) => g.id === 'plugin:dsh-tool-web').detail, /disabled/);
});

test('discover and its skill are never listed: they are not the user\'s to switch off', () => {
  assert.ok(!ids(inventory()).includes('tool:discover'));
  assert.ok(!ids(inventory()).includes('skill:discovery'));
});

test('every preset and every plugin is listed, with what each preset composes', () => {
  const inv = inventory();
  assert.deepEqual(inv.presets.map((p) => p.id), ['standard', 'junior-dev']);
  assert.deepEqual(inv.presets[0].plugins, ['dsh-tool-fs', 'dsh-tool-web']);
  assert.equal(inv.presets[1].name, 'junior-dev');
  assert.deepEqual(inv.plugins.map((p) => [p.id, p.hasCapabilities]).sort(), [['dsh-theme', false], ['dsh-tool-fs', true], ['dsh-tool-web', true]]);
});

test('the built-in owner map only names real tool plugins', () => {
  assert.ok(Object.values(BUILTIN_TOOL_PLUGINS).every((m) => /^dsh-/.test(m)));
});

test('a preset with no policy is unmanaged: everything shows as always on', () => {
  const inv = inventory();
  const { states, managed } = statesFor(undefined, 'standard', inv);
  assert.equal(managed, false);
  assert.ok(Object.values(states).every((s) => s === 'primary'));
});

test('table -> manifest -> table is lossless, through the real parser and resolver', () => {
  const inv = inventory();
  const chosen = {
    'tool:read': 'primary', 'tool:write': 'tertiary', 'tool:web_fetch': 'secondary', 'tool:mystery': 'denied',
    'mcp-tool:github/create_issue': 'tertiary', 'mcp-tool:github/search': 'primary', 'skill:swift': 'secondary',
  };
  const raw = withMatrix(undefined, 'standard', chosen, inv);
  const parsed = parseManifest(raw);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  assert.deepEqual(statesFor(raw, 'standard', inv).states, chosen);
  const policy = createResolver(parsed.manifest, { builtinHostCritical: BUILTIN_HOST_CRITICAL }).resolve('standard');
  assert.equal(policy.state(capabilityOf('tool:mystery')), 'denied');
  assert.equal(policy.state(capabilityOf('mcp-tool:github/create_issue')), 'tertiary');
  assert.equal(policy.decide('tool:discover').allowed, true, 'discover stays reachable');
  assert.equal(policy.decide('subagent:anything').allowed, true, 'a new preset keeps delegation open');
});

test('turning every item off still yields a valid manifest', () => {
  const inv = inventory();
  const off = Object.fromEntries(ids(inv).map((id) => [id, 'denied']));
  const raw = withMatrix(undefined, 'standard', off, inv);
  assert.equal(parseManifest(raw).ok, true);
  assert.ok(Object.values(statesFor(raw, 'standard', inv).states).every((s) => s === 'denied'));
});

test('saving one preset leaves the others, its subagents rules and the admin section alone', () => {
  const inv = inventory();
  const before = { version: 1, admin: { host_critical: ['tool:working_directory'] }, presets: { other: { tools: { allow: ['read'] } }, standard: { description: 'mine', subagents: { mode: 'allowlist', allow: ['other'] } } }, agents: { other: { preset: 'other' } } };
  const copy = structuredClone(before);
  const raw = withMatrix(before, 'standard', Object.fromEntries(ids(inv).map((id) => [id, 'primary'])), inv);
  assert.deepEqual(before, copy, 'the input is not mutated');
  assert.deepEqual(raw.presets.other, before.presets.other);
  assert.equal(raw.presets.standard.description, 'mine');
  assert.deepEqual(raw.presets.standard.subagents, { mode: 'allowlist', allow: ['other'] });
  assert.deepEqual(raw.admin, before.admin);
  assert.equal(raw.agents.other.preset, 'other');
  assert.equal(raw.agents.standard.preset, 'standard');
});

test('withMatrix rejects a missing or unknown state instead of guessing', () => {
  const inv = inventory();
  const all = Object.fromEntries(ids(inv).map((id) => [id, 'primary']));
  assert.throws(() => withMatrix(undefined, 'standard', { ...all, 'tool:read': 'bogus' }, inv), /unknown state/);
  const { 'tool:read': _gone, ...partial } = all;
  assert.throws(() => withMatrix(undefined, 'standard', partial, inv), /no state for tool:read/);
});

async function api(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpm-inv-'));
  const file = path.join(dir, 'presets.json');
  if (initial) fs.writeFileSync(file, JSON.stringify(initial));
  const manager = createManager({ agentPresets: { composedPreset: () => undefined }, file, auditFile: path.join(dir, 'a.jsonl'), logger: { error() {}, warn() {} } });
  return { manager, file, actions: createActions(manager, { collect: async () => inventory() }) };
}

test('API: inventory for a fresh install, then savematrix persists and applies it', async () => {
  const { actions, file, manager } = await api();
  const first = await actions.inventory({});
  assert.equal(first.preset, 'standard');
  assert.equal(first.managed, false);
  const states = Object.fromEntries(ids(first).map((id) => [id, id === 'tool:read' ? 'primary' : 'denied']));
  const saved = await actions.savematrix({ preset: 'standard', states });
  assert.equal(saved.ok, true, JSON.stringify(saved.errors));
  assert.equal(manager.active, true);
  assert.ok(fs.existsSync(file));
  const again = await actions.inventory({ preset: 'standard' });
  assert.equal(again.managed, true);
  assert.equal(again.states['tool:read'], 'primary');
  assert.equal(again.states['tool:write'], 'denied');
  assert.equal((await actions.inventory({ preset: 'junior-dev' })).managed, false, 'other presets are untouched');
});

test('API: savematrix refuses a stale table instead of silently allowing the new item', async () => {
  const { actions } = await api();
  const states = Object.fromEntries(ids(inventory()).filter((id) => id !== 'tool:mystery').map((id) => [id, 'primary']));
  await assert.rejects(() => actions.savematrix({ preset: 'standard', states }), /changed while you were editing/);
  await assert.rejects(() => actions.savematrix({ preset: 'standard', states: [] }), /states must be an object/);
});

test('API: a hand-broken saved manifest is reported, not overwritten', async () => {
  const { actions, file } = await api();
  fs.writeFileSync(file, '{ not json');
  await assert.rejects(() => actions.inventory({}), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('collectInventory tolerates missing services and a failing source', async () => {
  const ctx = { get: (n) => ({ tools: { schemas: () => [{ name: 'read', description: 'r', parameters: {} }] }, agentPresets: { list: async () => { throw new Error('boom'); } } })[n], logger: { warn() {} } };
  const inv = await collectInventory(ctx);
  assert.deepEqual(ids(inv), ['tool:read']);
  assert.deepEqual(inv.presets, []);
});

test('a broken or still-loading preset (no rows, odd entries) does not break the inventory', () => {
  const inv = buildInventory({
    presets: [{ id: 'a', broken: 'failed to load' }, { id: 'b' }],
    compositions: [{ id: 'a', broken: 'failed to load' }, null, { id: 'b', rows: [null, { moduleName: 'dsh-tool-fs' }] }],
    plugins: [{ moduleName: 'dsh-tool-fs' }], tools: [{ name: 'read' }], skills: [{ name: 'x' }],
  });
  assert.deepEqual(inv.presets.map((p) => [p.id, p.plugins, p.broken]), [['a', [], 'failed to load'], ['b', ['dsh-tool-fs'], null]]);
});

test('collectInventory survives a loader or metadata lookup that throws, and still returns tools', async () => {
  const entry = (name, base) => ({ options: { name }, disabled: false, parent: { tree: { ctx: { baseUrl: base } } } });
  const ctx = { logger: { warn() {} }, get: (n) => ({
    tools: { schemas: () => [{ name: 'read', description: 'r' }] },
    loader: { entries: () => [entry('dsh-tool-fs', '/x'), { options: { group: true } }, { options: {} }] },
    pluginPackages: { metaOf: () => { throw new Error('no meta'); } },
  })[n] };
  const inv = await collectInventory(ctx);
  assert.deepEqual(ids(inv), ['tool:read']);
  assert.deepEqual(inv.plugins.map((p) => p.id), ['dsh-tool-fs']);
  const dead = { logger: { warn() {} }, get: (n) => (n === 'loader' ? { entries: () => { throw new Error('loader gone'); } } : n === 'tools' ? { schemas: () => [] } : undefined) };
  assert.deepEqual((await collectInventory(dead)).plugins, []);
});
