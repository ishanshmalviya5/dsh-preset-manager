import test from 'node:test';
import assert from 'node:assert/strict';
import { toolCapability, callCapabilities, estimateTokens } from '../../lib/adapter/names.js';
import { createAudit } from '../../lib/adapter/audit.js';

test('toolCapability: native vs MCP naming', () => {
  assert.deepEqual(toolCapability('bash'), { id: 'tool:bash' });
  assert.deepEqual(toolCapability('mcp__github__create_issue'), { id: 'mcp-tool:github/create_issue', owner: 'mcp-server:github' });
  assert.deepEqual(toolCapability('mcp__web__a__b'), { id: 'mcp-tool:web/a__b', owner: 'mcp-server:web' });
  assert.deepEqual(toolCapability('mcp__broken'), { id: 'tool:mcp__broken' }); // no tool part: not treated as MCP
  assert.deepEqual(toolCapability('mcp____x'), { id: 'tool:mcp____x' });
});

test('callCapabilities: skill name and delegated preset are capabilities too', () => {
  assert.deepEqual(callCapabilities({ name: 'skill', arguments: { name: 'swift' } }).map((c) => c.id), ['tool:skill', 'skill:swift']);
  assert.deepEqual(callCapabilities({ name: 'spawn', arguments: { agent_preset: 'reviewer', task: 'x' } }).map((c) => c.id), ['tool:spawn', 'subagent:reviewer']);
  assert.deepEqual(callCapabilities({ name: 'bash', arguments: 'not an object' }).map((c) => c.id), ['tool:bash']);
  assert.deepEqual(callCapabilities({ name: 'skill', arguments: { name: 5 } }).map((c) => c.id), ['tool:skill']);
});

test('estimateTokens grows with description size', () => {
  const small = estimateTokens({ name: 'a', description: 'x', parameters: {} });
  const big = estimateTokens({ name: 'a', description: 'x'.repeat(4000), parameters: {} });
  assert.ok(big > small + 900);
});

test('audit: only whitelisted fields, truncated, ring-bounded, never throws on bad file', () => {
  const a = createAudit({ capacity: 3, file: '/nonexistent-root-dir/\0/x' });
  a.record('t', { agent: 's1', arguments: { secret: 'hunter2' }, argKeys: ['secret'], detail: 'x'.repeat(500) });
  const e = a.events()[0];
  assert.equal(e.arguments, undefined);
  assert.deepEqual(e.argKeys, ['secret']);
  assert.ok(e.detail.length <= 201);
  for (let i = 0; i < 5; i++) a.record('n', {});
  assert.equal(a.events().length, 3);
});
