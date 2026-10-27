import test from 'node:test';
import assert from 'node:assert/strict';
import { matches, matchAny, parseManifest, parseOverride, createResolver, evaluate, diffStates, PolicyError, normalizeCap } from '../../lib/engine/index.js';

const build = (raw) => {
  const r = parseManifest(raw);
  assert.ok(r.ok, JSON.stringify(r.errors));
  return createResolver(r.manifest);
};
const errs = (raw) => parseManifest(raw).errors.map((e) => `${e.path}: ${e.message}`);

test('match: glob only, anchored, regex metacharacters are literal', () => {
  assert.ok(matches('fs_*', 'fs_read'));
  assert.ok(!matches('fs_*', 'xfs_read'));
  assert.ok(matches('a?c', 'abc'));
  assert.ok(!matches('a.c', 'abc'));
  assert.ok(matches('github/*', 'github/create_issue'));
  assert.ok(matches('a(b)+', 'a(b)+'));
  assert.equal(matchAny(['x', 'y*'], 'yz'), 'y*');
  assert.equal(matchAny([], 'x'), undefined);
});

test('manifest: rejects bad shape with paths', () => {
  assert.deepEqual(errs(null), [': manifest must be an object']);
  assert.ok(errs({ version: 2 }).includes('version: must be 1'));
  assert.ok(errs({ version: 1, bogus: 1 }).includes('bogus: unknown key'));
  assert.ok(errs({ version: 1, presets: { p: { tools: { mode: 'nope' } } } }).some((e) => e.startsWith('presets.p.tools.mode')));
  assert.ok(errs({ version: 1, presets: { p: { tools: {} } } }).some((e) => e.includes('required when no list is given')));
  assert.ok(errs({ version: 1, presets: { p: { tools: { allow: ['a'], deny: ['b'] } } } }).some((e) => e.includes('required when both')));
  assert.ok(errs({ version: 1, presets: { p: { tools: { allow: ['*'.repeat(9)] } } } }).some((e) => e.includes('wildcards')));
  assert.ok(errs({ version: 1, presets: { p: { tools: { allow: [''] } } } }).length);
  assert.ok(errs({ version: 1, presets: { 'bad name': {} } }).length);
});

test('manifest: extends and agents references, cycles, aliases', () => {
  assert.ok(errs({ version: 1, presets: { a: { extends: 'zzz' } } }).some((e) => e.includes('unknown preset')));
  assert.ok(errs({ version: 1, presets: { a: { extends: 'b' }, b: { extends: 'a' } } }).some((e) => e.includes('extends cycle')));
  assert.ok(errs({ version: 1, agents: { standard: { preset: 'nope' } } }).some((e) => e.includes('unknown preset')));
  assert.ok(errs({ version: 1, aliases: { a: ['@b'], b: ['@a'] } }).some((e) => e.includes('alias cycle')));
  assert.ok(errs({ version: 1, presets: { p: { tools: { allow: ['@missing'] } } } }).some((e) => e.includes('unknown alias')));
  const r = build({ version: 1, aliases: { ro: ['fs_read', 'fs_glob'], more: ['@ro', 'grep'] }, presets: { p: { tools: { allow: ['@more'] } } }, agents: { std: { preset: 'p' } } });
  assert.deepEqual(r.manifest.presets.p.sections.tool.allow, ['fs_read', 'fs_glob', 'grep']);
});

test('manifest: warnings for conflicts, never errors', () => {
  const r = parseManifest({ version: 1, presets: { p: { tools: { mode: 'allowlist', allow: ['a'], deny: ['a'] }, skills: { mode: 'allowlist' }, plugins: { mode: 'denylist', allow: ['x'], deny: ['y'] } } } });
  assert.ok(r.ok);
  const w = r.warnings.map((x) => x.message).join('|');
  assert.match(w, /allowed and denied/);
  assert.match(w, /empty allowlist/);
  assert.match(w, /ignored in denylist/);
});

test('manifest: result is frozen', () => {
  const r = parseManifest({ version: 1, presets: { p: { tools: { allow: ['a'] } } } });
  assert.throws(() => { 'use strict'; r.manifest.presets.p.sections.tool.allow.push('b'); });
});

const planner = {
  version: 1,
  presets: {
    base: { tools: { mode: 'denylist', deny: ['bash'] } },
    coder: { extends: 'base', tools: { allow: ['fs_*', 'bash', 'edit'] }, mcp: { servers: { allow: ['github'] }, tools: { allow: ['github/search_*', 'github/get_file'] } }, skills: { allow: ['swift', 'testing'] }, subagents: { allow: ['reviewer'] } },
  },
  agents: { standard: { preset: 'coder' } },
};

test('resolve: allowlist semantics per category', () => {
  const p = build(planner).resolve('standard');
  assert.equal(p.decide('tool:fs_read').allowed, true);
  assert.equal(p.decide('tool:browser').allowed, false);
  assert.equal(p.decide('mcp-server:github').allowed, true);
  assert.equal(p.decide('mcp-server:slack').allowed, false);
  assert.equal(p.decide('mcp-tool:github/search_repositories').allowed, true);
  assert.equal(p.decide('mcp-tool:github/delete_repo').allowed, false);
  assert.equal(p.decide('skill:swift').allowed, true);
  assert.equal(p.decide('skill:planning').allowed, false);
  assert.equal(p.decide('subagent:reviewer').allowed, true);
  assert.equal(p.decide('subagent:coder').allowed, false);
});

test('resolve: parent preset is intersected, child cannot broaden it', () => {
  const p = build(planner).resolve('standard');
  const d = p.decide('tool:bash'); // coder allows bash, base denies it
  assert.equal(d.allowed, false);
  assert.equal(d.layer, 'parent:base');
  assert.deepEqual(p.chain, ['coder', 'base']);
});

test('resolve: explicit exception carves out of a deny in the same layer only', () => {
  const r = build({ version: 1, presets: { p: { tools: { mode: 'denylist', deny: ['fs_*'], except: ['fs_read'] } }, q: { extends: 'p', tools: { mode: 'denylist', deny: ['fs_read'] } } }, agents: { a: { preset: 'p' }, b: { preset: 'q' } } });
  assert.equal(r.resolve('a').decide('tool:fs_read').allowed, true);
  assert.equal(r.resolve('a').decide('tool:fs_write').allowed, false);
  assert.equal(r.resolve('b').decide('tool:fs_read').allowed, false); // another layer still denies it
});

test('resolve: agent-level restriction and session override only narrow', () => {
  const m = { ...planner, agents: { standard: { preset: 'coder', restrict: { tools: { mode: 'denylist', deny: ['edit'] } } } } };
  const r = build(m);
  assert.equal(r.resolve('standard').decide('tool:edit').layer, 'agent:standard');
  const s = r.resolve('standard', { session: { tools: { mode: 'allowlist', allow: ['fs_read', 'browser'] } } });
  assert.equal(s.decide('tool:fs_read').allowed, true);
  assert.equal(s.decide('tool:fs_write').allowed, false); // narrowed by session
  assert.equal(s.decide('tool:browser').allowed, false); // session cannot grant what the preset does not
});

test('resolve: invalid session override throws PolicyError with issues', () => {
  const r = build(planner);
  assert.throws(() => r.resolve('standard', { session: { tools: { mode: 'x' } } }), (e) => e instanceof PolicyError && e.issues.length > 0);
});

test('admin deny is final, even over host-critical', () => {
  const r = build({ ...planner, admin: { host_critical: ['tool:ask_user', 'tool:bash'], tools: { mode: 'denylist', deny: ['bash', 'rm_*'] } } });
  const p = r.resolve('standard');
  assert.equal(p.decide('tool:bash').allowed, false);
  assert.equal(p.decide('tool:bash').layer, 'admin');
  assert.equal(p.decide('tool:ask_user').reason, 'host-critical'); // exempt from preset layers
  assert.equal(p.decide('tool:rm_rf').allowed, false);
});

test('fail-closed: only host-critical stays reachable', () => {
  const r = build({ ...planner, admin: { host_critical: ['tool:ask_user'] } });
  const p = r.failClosed('manifest unreadable');
  assert.equal(p.decide('tool:ask_user').allowed, true);
  assert.equal(p.decide('tool:fs_read').allowed, false);
  assert.equal(p.decide('tool:fs_read').reason, 'fail-closed');
  assert.equal(p.state('tool:fs_read'), 'denied');
});

test('unbound agents: unmanaged allows (preserves behaviour), strict fails closed', () => {
  const loose = build(planner).resolve('other');
  assert.equal(loose.managed, false);
  assert.equal(loose.decide('tool:anything').allowed, true);
  const strict = build({ ...planner, defaults: { strict: true }, admin: { host_critical: ['tool:ask_user'] } }).resolve('other');
  assert.equal(strict.failClosed.includes('no preset bound'), true);
  assert.equal(strict.decide('tool:anything').allowed, false);
  assert.equal(strict.decide('tool:ask_user').allowed, true);
});

test('unknown_capability governs categories a managed agent has no section for', () => {
  const deny = build({ version: 1, presets: { p: { tools: { allow: ['a'] } } }, agents: { x: { preset: 'p' } } }).resolve('x');
  assert.equal(deny.decide('skill:s').allowed, false);
  assert.equal(deny.decide('skill:s').reason, 'unknown-capability-default');
  const allow = build({ version: 1, defaults: { unknown_capability: 'allow' }, presets: { p: { tools: { allow: ['a'] } } }, agents: { x: { preset: 'p' } } }).resolve('x');
  assert.equal(allow.decide('skill:s').allowed, true);
});

test('owner propagation: denied MCP server denies its tools; unopinionated owners are ignored', () => {
  const p = build({ version: 1, presets: { p: { mcp: { servers: { allow: ['github'] }, tools: { allow: ['*/*'] } }, tools: { allow: ['*'] } } }, agents: { x: { preset: 'p' } } }).resolve('x');
  assert.equal(p.decide({ id: 'mcp-tool:github/a', owner: 'mcp-server:github' }).allowed, true);
  const d = p.decide({ id: 'mcp-tool:slack/a', owner: 'mcp-server:slack' });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'owner-denied');
  assert.equal(d.ownAllowed, true);
  // no plugins section anywhere -> a native tool owned by some plugin is not swept up
  assert.equal(p.decide({ id: 'tool:fs_read', owner: 'plugin:dsh-tool-fs' }).allowed, true);
});

test('dynamic registration is denied by default, allowed when configured, never for admin-denied', () => {
  const m = { version: 1, presets: { p: { tools: { allow: ['*'] } } }, agents: { x: { preset: 'p' } } };
  assert.equal(build(m).resolve('x').decide('tool:late', { dynamic: true }).reason, 'dynamic-registration');
  assert.equal(build({ ...m, defaults: { dynamic_registration: 'allow' } }).resolve('x').decide('tool:late', { dynamic: true }).allowed, true);
  assert.equal(build(m).resolve('x').decide('tool:late').allowed, true); // not dynamic
});

test('tiers: listing in secondary/tertiary also allows; allow and primary are the primary tier', () => {
  const p = build({ version: 1, presets: { p: { tools: { allow: ['a'], primary: ['b'], secondary: ['big_*'], tertiary: ['danger'] } } }, agents: { x: { preset: 'p' } } }).resolve('x');
  assert.equal(p.state('tool:a'), 'primary');
  assert.equal(p.state('tool:b'), 'primary');
  assert.equal(p.state('tool:big_report'), 'secondary');
  assert.equal(p.state('tool:danger'), 'tertiary');
  assert.equal(p.state('tool:other'), 'denied');
  assert.equal(p.decide('tool:big_report').allowed, true);
  assert.equal(p.decide('tool:danger').allowed, true);
});

test('tiers: tertiary beats secondary beats primary, across patterns and across layers', () => {
  const same = build({ version: 1, presets: { p: { tools: { primary: ['x*'], secondary: ['xa*'], tertiary: ['xab'] } } }, agents: { x: { preset: 'p' } } }).resolve('x');
  assert.equal(same.state('tool:xz'), 'primary');
  assert.equal(same.state('tool:xaz'), 'secondary');
  assert.equal(same.state('tool:xab'), 'tertiary');
  const layered = build({ version: 1, presets: { base: { tools: { mode: 'denylist', tertiary: ['bash'] } }, p: { extends: 'base', tools: { primary: ['bash', 'read'] } } }, agents: { x: { preset: 'p' } } }).resolve('x');
  assert.equal(layered.state('tool:bash'), 'tertiary', 'a child cannot make a parent tertiary tool easier to reach');
  assert.equal(layered.state('tool:read'), 'primary');
});

test('tiers: a denylist section can still mark tiers on what it does not deny', () => {
  const p = build({ version: 1, presets: { p: { tools: { mode: 'denylist', deny: ['rm'], secondary: ['web_*'] } } }, agents: { x: { preset: 'p' } } }).resolve('x');
  assert.equal(p.state('tool:read'), 'primary');
  assert.equal(p.state('tool:web_fetch'), 'secondary');
  assert.equal(p.state('tool:rm'), 'denied');
});

test('tiers: a denied capability is denied whatever tier lists say; except still carves out of deny', () => {
  const p = build({ version: 1, presets: { p: { tools: { mode: 'allowlist', secondary: ['*'], deny: ['bash'] } } }, agents: { x: { preset: 'p' } } }).resolve('x');
  assert.equal(p.state('tool:bash'), 'denied');
  assert.equal(p.state('tool:read'), 'secondary');
});

test('tiers: built-in host-critical capabilities are always primary and survive any allowlist', () => {
  const m = parseManifest({ version: 1, presets: { p: { tools: { allow: ['read'] } } }, agents: { x: { preset: 'p' } } }).manifest;
  const p = createResolver(m, { builtinHostCritical: ['tool:discover', 'skill:discovery'] }).resolve('x');
  assert.equal(p.state('tool:discover'), 'primary');
  assert.equal(p.state('skill:discovery'), 'primary');
  assert.equal(p.state('tool:other'), 'denied');
  // fail-closed means closed: the built-in exemption does not apply
  assert.equal(createResolver(m, { builtinHostCritical: ['tool:discover'] }).failClosed('x').decide('tool:discover').allowed, false);
});

test('tiers: tier lists are validated like every other list', () => {
  assert.ok(errs({ version: 1, presets: { p: { tools: { secondary: ['*'.repeat(9)] } } } }).some((e) => e.includes('wildcards')));
  assert.ok(errs({ version: 1, presets: { p: { tools: { tertiary: 'bash' } } } }).some((e) => e.includes('array')));
  assert.ok(errs({ version: 1, presets: { p: { tools: { discoverable: ['x'] } } } }).some((e) => e.includes('unknown key')), 'the old name is gone');
  const w = parseManifest({ version: 1, presets: { p: { tools: { secondary: ['a'], tertiary: ['a'] } } } }).warnings.map((x) => x.message).join('|');
  assert.match(w, /both secondary and tertiary/);
});

test('explain names the blamed layer and rule', () => {
  const e = build(planner).resolve('standard').explain('tool:browser');
  assert.equal(e.state, 'denied');
  assert.equal(e.layer, 'preset:coder');
  assert.equal(e.rule, 'not-in-allowlist');
  assert.match(e.summary, /tool:browser is denied/);
});

test('decide rejects malformed capability ids', () => {
  const p = build(planner).resolve('standard');
  assert.throws(() => p.decide('nope'), TypeError);
  assert.throws(() => p.decide('bogus:x'), TypeError);
  assert.throws(() => normalizeCap({ id: 'tool:x', owner: 'zzz' }), TypeError);
});

test('evaluate: counts per tier, and only primary schemas (plus discovery metadata) cost prompt tokens', () => {
  const p = build({ version: 1, presets: { p: { tools: { primary: ['a'], secondary: ['big'], tertiary: ['risky'] } } }, agents: { x: { preset: 'p' } } }).resolve('x');
  const catalog = [
    { id: 'tool:a', tokens: 100 }, { id: 'tool:big', tokens: 900, discoveryTokens: 20 }, { id: 'tool:risky', tokens: 500, discoveryTokens: 10 },
    { id: 'tool:c', tokens: 400 }, { id: 'tool:d' },
  ];
  const r = evaluate(p, catalog);
  assert.deepEqual(r.counts, { total: 5, allowed: 3, denied: 2, primary: 1, secondary: 1, tertiary: 1 });
  assert.equal(r.tokens.unrestricted, 1900);
  assert.equal(r.tokens.inPrompt, 130);
  assert.equal(r.tokens.saved, 1770);
  assert.equal(r.tokens.unmeasured, 1);
});

test('evaluate: issues for mandatory-denied, dependencies, unmatched rules, owner conflicts', () => {
  const p = build({ version: 1, presets: { p: { tools: { allow: ['a', 'typo_*', 'child'] }, plugins: { allow: ['other'] } } }, agents: { x: { preset: 'p' } } }).resolve('x');
  const r = evaluate(p, [
    { id: 'tool:a', dependencies: ['tool:gone', 'tool:blocked'] },
    { id: 'tool:blocked' },
    { id: 'tool:must', mandatory: true },
    { id: 'tool:child', owner: 'plugin:nope' },
    { id: 'plugin:other' },
  ]);
  const kinds = r.issues.map((i) => `${i.kind}:${i.id ?? ''}`);
  assert.ok(kinds.includes('missing-dependency:tool:a'));
  assert.ok(kinds.includes('denied-dependency:tool:a'));
  assert.ok(kinds.includes('mandatory-denied:tool:must'));
  assert.ok(kinds.includes('allowed-but-owner-denied:tool:child'));
  assert.ok(r.issues.some((i) => i.kind === 'unmatched-rule' && i.message.includes('typo_*')));
});

test('diffStates lists capabilities that change between presets', () => {
  const r = build({ version: 1, presets: { a: { tools: { allow: ['x', 'y'] } }, b: { tools: { allow: ['x'] } } }, agents: { A: { preset: 'a' }, B: { preset: 'b' } } });
  const cat = [{ id: 'tool:x' }, { id: 'tool:y' }];
  assert.deepEqual(diffStates(evaluate(r.resolve('A'), cat), evaluate(r.resolve('B'), cat)), [{ id: 'tool:y', from: 'primary', to: 'denied' }]);
});

test('parseOverride keeps alias expansion and reports errors', () => {
  const m = parseManifest({ version: 1, aliases: { ro: ['a', 'b'] } }).manifest;
  assert.deepEqual(parseOverride({ tools: { allow: ['@ro'] } }, m).sections.tool.allow, ['a', 'b']);
  assert.equal(parseOverride({ tools: { mode: 'x' } }, m).ok, false);
  assert.equal(parseOverride(null, m).ok, false);
});

test('agents: "*" is the fallback binding; an exact binding wins; strict no longer fails closed when "*" exists', () => {
  const r = build({ version: 1, defaults: { strict: true }, presets: { a: { tools: { allow: ['x'] } }, b: { tools: { allow: ['y'] } } }, agents: { '*': { preset: 'a' }, special: { preset: 'b' } } });
  assert.equal(r.resolve('anything').decide('tool:x').allowed, true);
  assert.equal(r.resolve('anything').decide('tool:y').allowed, false);
  assert.equal(r.resolve('anything').managed, true);
  assert.equal(r.resolve('special').decide('tool:y').allowed, true);
  assert.equal(r.resolve('anything').layers.includes('agent:*'), true);
});
