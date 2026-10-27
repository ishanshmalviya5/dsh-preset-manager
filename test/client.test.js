// Runs the real client.js against a minimal fake React and a fake fetch. This is NOT a browser: it proves the module
// registers, renders from server data, sends the right requests and survives failures. Layout/CSS are unverified.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function makeReact() {
  const Fragment = Symbol('Fragment');
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) });
  let cur;
  const useState = (init) => {
    const inst = cur; const i = inst.idx++;
    if (!(i in inst.slots)) inst.slots[i] = typeof init === 'function' ? init() : init;
    return [inst.slots[i], (v) => { inst.slots[i] = typeof v === 'function' ? v(inst.slots[i]) : v; inst.render(); }];
  };
  const useEffect = (fn) => { const inst = cur; const i = inst.idx++; if (!inst.slots[i]) { inst.slots[i] = true; inst.pending.push(fn); } }; // once per hook, also for components that mount later
  function expand(node) {
    if (node === null || node === undefined || node === false || node === true) return [];
    if (typeof node === 'string' || typeof node === 'number') return [String(node)];
    if (Array.isArray(node)) return node.flatMap(expand);
    if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }));
    return [{ type: node.type, props: node.props, kids: node.children.flatMap(expand) }];
  }
  function mount(Comp) {
    const inst = { slots: {}, idx: 0, pending: [], ran: false, tree: [], render() { cur = inst; inst.idx = 0; inst.tree = expand(Comp({})); cur = undefined; inst.ran = true; inst.pending.splice(0).forEach((f) => f()); } };
    inst.render();
    return inst;
  }
  return { createElement, Fragment, useState, useEffect, mount };
}

const textOf = (nodes) => nodes.map((n) => (typeof n === 'string' ? n : textOf(n.kids))).join(' ');
const find = (nodes, pred, out = []) => { for (const n of nodes) { if (typeof n === 'string') continue; if (pred(n)) out.push(n); find(n.kids, pred, out); } return out; };
const button = (inst, label) => find(inst.tree, (n) => n.type === 'button' && textOf(n.kids) === label)[0];
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

const MANIFEST = { version: 1, presets: { coder: { tools: { primary: ['read'] } }, reviewer: { tools: { primary: ['read'] } } }, agents: { standard: { preset: 'coder' } } };
const DATA = {
  file: '/x/presets.json', active: true, raw: JSON.stringify(MANIFEST, null, 2), hasPrevious: true, valid: true, missing: false, errors: [], warnings: [],
  presets: [{ name: 'coder' }, { name: 'reviewer' }], agents: [{ key: 'standard', preset: 'coder' }], strict: false, example: '{"version":1,"example":true}',
  metrics: [{ agent: 'session-abcdef12', preset: 'coder', failClosed: null, tools: { known: 25, visible: 5, hidden: 20, tiers: { primary: 5, secondary: 3, tertiary: 1, denied: 16 } }, enabled: [{ id: 'tool:web_fetch', tier: 'secondary', duration: 'session' }], tokens: { saved: 4000, savedPct: 80, estimated: true }, leaked: [] }],
};

async function boot(handlers) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const action = String(url).split('/').pop();
    const body = JSON.parse(init.body);
    calls.push({ action, body });
    try {
      const value = await handlers[action](body);
      return { status: 200, json: async () => ({ ok: true, value }) };
    } catch (e) {
      return { status: 200, json: async () => ({ ok: false, error: e.message }) };
    }
  };
  let def;
  globalThis.window = { __ModuleLoader__: { load: (d) => { def = d; } } };
  await import(`../client.js?${Math.random()}`);
  const React = makeReact();
  const mod = def.factory((n) => (n === 'react' ? React : undefined));
  let registered;
  mod.apply({ slots: { inject: (_slot, fn) => fn(), register: (meta, Comp) => { registered = { meta, Comp }; return () => {}; } } });
  const inst = React.mount(registered.Comp);
  await settle();
  return { inst, calls, registered, def };
}

const editor = (inst) => find(inst.tree, (n) => n.type === 'textarea')[0];

test('registers one settings section with the right id, order and label', async () => {
  const { registered, def } = await boot({ get: () => DATA });
  assert.equal(def.id, 'dsh-preset-manager');
  assert.equal(registered.meta.name, 'settings.section');
  assert.equal(registered.meta.id, 'preset-manager');
  assert.equal(registered.meta.label(), 'Preset Manager');
  assert.equal(typeof registered.meta.order, 'number');
});

test('renders status, bindings, tiers and running agents from server data', async () => {
  const { inst } = await boot({ get: () => DATA });
  const t = textOf(inst.tree);
  assert.match(t, /Active: presets are enforced/);
  assert.match(t, /Manifest file: \/x\/presets\.json/);
  assert.match(t, /standard/);
  assert.match(t, /5 \/ 3 \/ 1/, 'primary / secondary / tertiary counts');
  assert.match(t, /web_fetch \(session\)/, 'active grants are visible');
  assert.match(t, /4000 \(80%\)/);
});

test('no manifest yet: says nothing is restricted, and "Insert example presets" fills the editor', async () => {
  const { inst } = await boot({ get: () => ({ ...DATA, raw: null, missing: true, valid: false, active: false, hasPrevious: false, agents: [], presets: [], metrics: [] }) });
  assert.match(textOf(inst.tree), /No manifest yet: nothing is restricted/);
  assert.equal(button(inst, 'Roll back to previous'), undefined);
  button(inst, 'Insert example presets').props.onClick();
  await settle();
  assert.equal(editor(inst).props.value, DATA.example);
});

test('Validate shows each problem with its path', async () => {
  const { inst, calls } = await boot({ get: () => DATA, validate: () => ({ ok: false, errors: [{ path: 'presets.coder.tools.mode', message: 'must be one of allowlist, denylist' }], warnings: [] }) });
  await button(inst, 'Validate').props.onClick();
  await settle();
  const t = textOf(inst.tree);
  assert.match(t, /presets\.coder\.tools\.mode: must be one of allowlist, denylist/);
  assert.match(t, /1 problem\(s\) found/);
  assert.equal(calls.find((c) => c.action === 'validate').body.manifest, DATA.raw);
});

test('Save & apply sends the editor text verbatim, then reloads from the server', async () => {
  const { inst, calls } = await boot({ get: () => DATA, save: () => ({ ok: true, warnings: [] }) });
  editor(inst).props.onChange({ target: { value: '{"version":1,"edited":true}' } });
  await settle();
  await button(inst, 'Save & apply').props.onClick();
  await settle();
  assert.equal(calls.find((c) => c.action === 'save').body.manifest, '{"version":1,"edited":true}');
  assert.equal(calls.filter((c) => c.action === 'get').length, 2, 'reloads after a successful save');
  assert.match(textOf(inst.tree), /Saved and applied to running agents/);
});

test('a refused save says the previous policy is still in force and lists why; the editor text is kept', async () => {
  const { inst } = await boot({ get: () => DATA, save: () => ({ ok: false, errors: [{ path: 'agents.x.preset', message: 'unknown preset "nope"' }], warnings: [] }) });
  editor(inst).props.onChange({ target: { value: 'my unsaved edit' } });
  await settle();
  await button(inst, 'Save & apply').props.onClick();
  await settle();
  const t = textOf(inst.tree);
  assert.match(t, /Not saved: the previous policy is still in force/);
  assert.match(t, /agents\.x\.preset: unknown preset "nope"/);
  assert.equal(editor(inst).props.value, 'my unsaved edit');
});

test('changing a binding edits the editor text only; nothing is sent until Save', async () => {
  const { inst, calls } = await boot({ get: () => DATA });
  const select = find(inst.tree, (n) => n.type === 'select')[0];
  select.props.onChange({ target: { value: 'reviewer' } });
  await settle();
  assert.equal(JSON.parse(editor(inst).props.value).agents.standard.preset, 'reviewer');
  assert.match(textOf(inst.tree), /Save to apply/);
  assert.deepEqual(calls.map((c) => c.action).filter((a) => a !== 'inventory'), ['get'], 'only reads; no save, validate or apply');
});

test('editing bindings with broken JSON in the editor refuses politely', async () => {
  const { inst } = await boot({ get: () => DATA });
  editor(inst).props.onChange({ target: { value: '{ broken' } });
  await settle();
  find(inst.tree, (n) => n.type === 'select')[0]?.props.onChange?.({ target: { value: 'reviewer' } });
  await settle();
  assert.equal(editor(inst).props.value, '{ broken');
});

test('Dry run explains tiers and token savings without saving', async () => {
  const dry = { ok: true, source: 'registered tools', counts: { total: 25, allowed: 9, primary: 5, secondary: 3, tertiary: 1, denied: 16 }, tokens: { unrestricted: 5000, inPrompt: 800, savedPct: 84 }, secondary: ['tool:web_fetch'], tertiary: ['tool:bash'], denied: [{ id: 'tool:write' }], issues: [] };
  const { inst, calls } = await boot({ get: () => DATA, dryrun: () => dry });
  await button(inst, 'Dry run').props.onClick();
  await settle();
  const t = textOf(inst.tree);
  assert.match(t, /9 of 25 tools allowed: 5 primary, 3 secondary \(model enables\), 1 tertiary \(you approve\)/);
  assert.match(t, /5000 -> 800 \(84% saved\)/);
  assert.match(t, /Secondary: web_fetch/);
  assert.match(t, /Tertiary: bash/);
  assert.ok(!calls.some((c) => c.action === 'save'));
});

test('"Why?" shows the server explanation for the capability typed in', async () => {
  const { inst, calls } = await boot({ get: () => DATA, explain: (b) => ({ ok: true, summary: `${b.capability} is denied: denied-by-layer by preset:coder (not-in-allowlist)` }) });
  await button(inst, 'Why?').props.onClick();
  await settle();
  assert.match(textOf(inst.tree), /tool:bash is denied/);
  assert.equal(calls.find((c) => c.action === 'explain').body.capability, 'tool:bash');
});

test('a failing server shows the error and does not crash the page', async () => {
  const { inst } = await boot({ get: () => { throw new Error('refused by dsh'); } });
  assert.match(textOf(inst.tree), /refused by dsh/);
});

test('untrusted text (audit events, model-written names) is rendered as text, never as HTML', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const { inst } = await boot({ get: () => DATA, audit: () => ({ events: [{ type: 'invocation-denied', capability: hostile, layer: 'preset:p', rule: '<script>x</script>' }] }) });
  await button(inst, 'Refresh').props.onClick();
  await settle();
  assert.ok(textOf(inst.tree).includes(hostile), 'shown literally');
  assert.deepEqual([...new Set(find(inst.tree, () => true).map((n) => n.type))].filter((t) => /img|script|iframe/.test(t)), []);
  assert.doesNotMatch(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), /dangerouslySetInnerHTML|innerHTML|eval\(|new Function/);
});

const INV = {
  preset: 'standard', managed: true, active: true,
  presets: [{ id: 'standard', name: 'standard', description: 'Default preset', plugins: ['dsh-tool-fs'], broken: null }, { id: 'junior-dev', name: 'junior-dev', description: '', plugins: [], broken: null }],
  plugins: [{ id: 'dsh-tool-fs', label: 'dsh-tool-fs', enabled: true, hasCapabilities: true }, { id: 'dsh-theme', label: 'dsh-theme', enabled: true, hasCapabilities: false }],
  groups: [
    { id: 'plugin:dsh-tool-fs', kind: 'plugin', label: 'dsh-tool-fs', detail: 'plugin', items: [{ id: 'tool:read', label: 'read', description: 'Read a file', tokens: 100 }, { id: 'tool:write', label: 'write', description: 'Write a file', tokens: 120 }] },
    { id: 'mcp:github', kind: 'mcp', label: 'github', detail: 'MCP server', items: [{ id: 'mcp-tool:github/search', label: 'search', description: 'Search', tokens: 80 }] },
    { id: 'skills:filesystem', kind: 'skills', label: 'filesystem', detail: 'skills', items: [{ id: 'skill:swift', label: 'swift', description: 'Swift help', tokens: 0 }] },
  ],
  states: { 'tool:read': 'primary', 'tool:write': 'denied', 'mcp-tool:github/search': 'secondary', 'skill:swift': 'primary' },
};

test('capability table lists presets, plugin and MCP groups and skills, and counts the tiers', async () => {
  const { inst } = await boot({ get: () => DATA, inventory: () => INV });
  const t = textOf(inst.tree);
  assert.match(t, /Capabilities per agent preset/);
  for (const w of ['dsh-tool-fs', 'github', 'filesystem', 'junior-dev', 'Plugins in this preset: dsh-tool-fs', 'dsh-theme']) assert.ok(t.includes(w), w);
  assert.match(t, /2 always on · 1 on request · 0 need your OK · 1 off/);
});

test('changing a tier marks the table dirty, and Save sends every item with its tier', async () => {
  const { inst, calls } = await boot({ get: () => DATA, inventory: () => INV, savematrix: () => ({ ok: true }) });
  assert.ok(button(inst, 'Save & apply').props.disabled !== undefined);
  const saveBefore = find(inst.tree, (n) => n.type === 'button' && textOf(n.kids) === 'Save & apply')[0];
  assert.equal(saveBefore.props.disabled, true, 'nothing to save yet');
  // the "dsh-tool-fs" group is mixed (primary + denied): click "Needs my OK" in its group control
  const group = find(inst.tree, (n) => n.type === 'button' && textOf(n.kids).startsWith('▸ dsh-tool-fs'))[0];
  group.props.onClick();
  await settle();
  const tertiary = find(inst.tree, (n) => n.type === 'button' && textOf(n.kids) === 'Needs my OK');
  tertiary[0].props.onClick();
  await settle();
  const save = find(inst.tree, (n) => n.type === 'button' && textOf(n.kids) === 'Save & apply').find((b) => !b.props.disabled);
  assert.ok(save, 'Save is enabled after a change');
  save.props.onClick();
  await settle();
  const sent = calls.find((c) => c.action === 'savematrix').body;
  assert.equal(sent.preset, 'standard');
  assert.equal(sent.states['tool:read'], 'tertiary');
  assert.equal(sent.states['tool:write'], 'tertiary');
  assert.equal(sent.states['mcp-tool:github/search'], 'secondary', 'other groups are untouched');
  assert.deepEqual(Object.keys(sent.states).sort(), Object.keys(INV.states).sort());
});

test('a rejected save shows the reason and says the old policy is still in force', async () => {
  const { inst } = await boot({ get: () => DATA, inventory: () => INV, savematrix: () => ({ ok: false, errors: [{ path: 'presets.standard', message: 'bad' }] }) });
  find(inst.tree, (n) => n.type === 'button' && textOf(n.kids).startsWith('▸ github'))[0].props.onClick();
  await settle();
  find(inst.tree, (n) => n.type === 'button' && textOf(n.kids) === 'Off')[0].props.onClick();
  await settle();
  find(inst.tree, (n) => n.type === 'button' && textOf(n.kids) === 'Save & apply').find((b) => !b.props.disabled).props.onClick();
  await settle();
  assert.match(textOf(inst.tree), /Not saved: presets\.standard: bad\. The previous policy is still in force/);
});

test('turning off a core tool asks first; declining changes nothing, and non-core items are not asked', async () => {
  const inv = structuredClone(INV);
  inv.groups[0].items[0] = { ...inv.groups[0].items[0], core: true, note: 'Needed for reading.' }; // read
  inv.groups[1].items[0] = { ...inv.groups[1].items[0], core: false };
  const asked = [];
  const { inst, calls } = await boot({ get: () => DATA, inventory: () => inv, savematrix: () => ({ ok: true }) });
  globalThis.window.confirm = (m) => { asked.push(m); return false; };
  find(inst.tree, (n) => n.type === 'button' && textOf(n.kids).startsWith('▸ dsh-tool-fs'))[0].props.onClick();
  await settle();
  const offs = () => find(inst.tree, (n) => n.type === 'button' && textOf(n.kids) === 'Off');
  offs()[0].props.onClick(); // the "read" row: primary -> off
  await settle();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /read is a core DSH tool\. Needed for reading\./);
  assert.equal(find(inst.tree, (n) => n.type === 'button' && textOf(n.kids) === 'Save & apply')[0].props.disabled, true, 'declined: the table has nothing to save (the first Save is the table\'s)');
  globalThis.window.confirm = () => true;
  offs()[0].props.onClick();
  await settle();
  find(inst.tree, (n) => n.type === 'button' && textOf(n.kids) === 'Save & apply').find((b) => !b.props.disabled).props.onClick();
  await settle();
  assert.equal(calls.find((c) => c.action === 'savematrix').body.states['tool:read'], 'denied');
  // hiding a core tool behind discover does not need a warning
  asked.length = 0;
  globalThis.window.confirm = (m) => { asked.push(m); return true; };
  find(inst.tree, (n) => n.type === 'button' && textOf(n.kids) === 'On request')[0].props.onClick();
  await settle();
  assert.equal(asked.length, 0);
});
