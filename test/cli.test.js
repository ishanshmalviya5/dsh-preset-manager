import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../lib/cli.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dpm-cli-'));
function cli(file) {
  return (...argv) => {
    const out = []; const err = [];
    const code = run([...argv, '--file', file], { out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
}
const READ = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bench', 'catalog.json');

test('init --example creates a valid manifest, and refuses to overwrite one', () => {
  const file = path.join(dir(), 'presets.json');
  const dpm = cli(file);
  assert.equal(dpm('init', '--example').code, 0);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(dpm('preset', 'validate').code, 0);
  const again = dpm('init');
  assert.equal(again.code, 2);
  assert.match(again.err, /not overwriting/);
});

test('commands on a missing manifest tell you to run init', () => {
  const r = cli(path.join(dir(), 'nope.json'))('preset', 'list');
  assert.equal(r.code, 2);
  assert.match(r.err, /dpm init/);
});

test('preset list / show / diff', () => {
  const dpm = cli(path.join(dir(), 'p.json'));
  dpm('init', '--example');
  const list = dpm('preset', 'list');
  assert.match(list.out, /coder .*agents: standard/);
  assert.match(list.out, /reviewer .*agents: minimal/);
  assert.equal(JSON.parse(dpm('preset', 'show', 'coder').out).tools.tertiary[0], 'job_kill');
  assert.equal(dpm('preset', 'show', 'nope').code, 2);
  const diff = dpm('preset', 'diff', 'coder', 'reviewer');
  assert.match(diff.out, /tool\.tertiary: only coder: \[job_kill\]  only reviewer: \[bash\]/);
  assert.match(dpm('preset', 'diff', 'coder', 'coder').out, /no differences/);
});

test('validate: errors give exit 1 with paths, warnings do not', () => {
  const file = path.join(dir(), 'bad.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, presets: { p: { tools: { mode: 'x' } } } }));
  const bad = cli(file)('preset', 'validate');
  assert.equal(bad.code, 1);
  assert.match(bad.out, /presets\.p\.tools\.mode/);
  fs.writeFileSync(file, '{ not json');
  assert.equal(cli(file)('preset', 'validate').code, 2);
});

test('create is least privilege; clone copies; names are validated; duplicates refused', () => {
  const dpm = cli(path.join(dir(), 'p.json'));
  dpm('init', '--example');
  assert.equal(dpm('preset', 'create', 'scratch').code, 0);
  const raw = JSON.parse(dpm('preset', 'show', 'scratch').out);
  assert.deepEqual(raw.tools, { mode: 'allowlist', primary: [] }, 'denies everything until edited');
  assert.equal(dpm('preset', 'clone', 'coder', 'coder2').code, 0);
  assert.deepEqual(JSON.parse(dpm('preset', 'show', 'coder2').out), JSON.parse(dpm('preset', 'show', 'coder').out));
  assert.equal(dpm('preset', 'create', 'scratch').code, 2);
  assert.equal(dpm('preset', 'create', 'bad name').code, 2);
  assert.equal(dpm('preset', 'clone', 'missing', 'x').code, 2);
});

test('activate binds an agent (default "*"), keeps one rollback copy, and rollback restores it', () => {
  const file = path.join(dir(), 'p.json');
  const dpm = cli(file);
  dpm('init', '--example');
  assert.equal(dpm('preset', 'activate', 'researcher').code, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).agents['*'].preset, 'researcher');
  assert.equal(dpm('preset', 'activate', 'planner', '--agent', 'standard').code, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).agents.standard.preset, 'planner');
  assert.equal(dpm('rollback').code, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).agents.standard.preset, 'coder');
  assert.equal(dpm('preset', 'activate', 'ghost').code, 2);
});

test('a refused write leaves the manifest byte-for-byte unchanged', () => {
  const file = path.join(dir(), 'p.json');
  const dpm = cli(file);
  dpm('init', '--example');
  const before = fs.readFileSync(file, 'utf8');
  fs.mkdirSync(`${file}.tmp`); // make the atomic write fail
  assert.notEqual(dpm('preset', 'activate', 'planner').code, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('capability explain and test: tier, reason, and exit codes you can script on', () => {
  const dpm = cli(path.join(dir(), 'p.json'));
  dpm('init', '--example');
  assert.match(dpm('capability', 'explain', 'standard', 'tool:web_fetch').out, /web_fetch is secondary/);
  assert.match(dpm('capability', 'explain', 'minimal', 'tool:write').out, /write is denied/);
  assert.equal(dpm('capability', 'test', 'standard', 'tool:bash').code, 0);
  assert.equal(dpm('capability', 'test', 'standard', 'tool:job_kill').out, 'allowed (tertiary)');
  assert.equal(dpm('capability', 'test', 'minimal', 'tool:write').code, 1);
  assert.equal(dpm('capability', 'test', 'minimal', 'tool:discover').code, 0, 'built into every preset');
  assert.equal(dpm('capability', 'test', 'minimal', 'nonsense').code, 1);
  assert.match(dpm('capability', 'explain', 'nobody', 'tool:bash').out, /nothing is restricted/);
});

test('agent capabilities: rules without a catalog; tiers and token saving with one; --json parses', () => {
  const dpm = cli(path.join(dir(), 'p.json'));
  dpm('init', '--example');
  const rules = dpm('agent', 'capabilities', 'minimal');
  assert.match(rules.out, /preset reviewer/);
  assert.match(rules.out, /layers: admin > agent:minimal > preset:reviewer/);
  const full = dpm('agent', 'capabilities', 'minimal', '--catalog', READ);
  assert.match(full.out, /primary \(5\): .*read/);
  assert.match(full.out, /tertiary \(1\): bash/);
  assert.match(full.out, /% saved/);
  const j = JSON.parse(dpm('agent', 'capabilities', 'minimal', '--catalog', READ, '--json').out);
  assert.equal(j.counts.tertiary, 1);
  assert.ok(j.tokens.saved > 0);
});

test('usage errors: unknown command/option, missing values, help', () => {
  const dpm = cli(path.join(dir(), 'p.json'));
  assert.equal(dpm('frobnicate').code, 2);
  assert.equal(run(['--bogus'], { err() {}, out() {} }), 2);
  assert.equal(run(['preset', 'list', '--file'], { err() {}, out() {} }), 2);
  assert.equal(run(['--help'], { out() {}, err() {} }), 0);
});
