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
  const useEffect = (fn) => { if (!cur.ran) cur.pending.push(fn); };
  function expand(node) {
    if (node === null || node === undefined || node === false || node === true) return [];
    if (typeof node === 'string' || typeof node === 'number') return [String(node)];
    if (Array.isArray(node)) return node.flatMap(expand);
    if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }));
    return [{ type: node.type, props: node.props, kids: node.children.flatMap(expand) }];
  }
  function mount(Comp) {
    const inst = { slots: {}, idx: 0, pending: [], ran: false, tree: [], render() { cur = inst; inst.idx = 0; inst.tree = expand(Comp({})); cur = undefined; if (!inst.ran) { inst.ran = true; inst.pending.splice(0).forEach((f) => f()); } } };
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
  assert.deepEqual(calls.map((c) => c.action), ['get']);
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
