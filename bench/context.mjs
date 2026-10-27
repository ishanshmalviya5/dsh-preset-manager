// Context benchmark: model-visible tool schema cost, unrestricted vs each bundled example preset.
// Catalog = the 25 tool schemas a real dsh 0.2.1-rc.2 headless profile sent to the model (bench/catalog.json).
// "tokens" are an estimate (~4 chars/token); "bytes" are the exact JSON bytes of the tool schemas in that wire form.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseManifest, createResolver, evaluate } from '../lib/engine/index.js';
import { toolCapability, estimateTokens, BUILTIN_HOST_CRITICAL } from '../lib/adapter/names.js';
import { createDiscovery } from '../lib/adapter/discover.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const catalog = JSON.parse(readFileSync(here('./catalog.json'), 'utf8'));
const manifest = parseManifest(JSON.parse(readFileSync(here('../examples/presets.json'), 'utf8'))).manifest;

const schemaOf = (t) => ({ name: t.name, description: t.description, parameters: t.parameters ?? t.input_schema });
const wire = (t) => ({ name: t.name, description: t.description, input_schema: t.input_schema ?? t.parameters }); // the shape the host sends
const bytes = (tools) => JSON.stringify(tools.map(wire)).length;
// The discover tool is part of the bill: every managed agent carries it.
const discoverTool = createDiscovery({ enforcer: {}, audit: {} }).tool;
const discoverSchema = { name: discoverTool.name, description: discoverTool.description, input_schema: discoverTool.parameters };

export function bench() {
  const resolver = createResolver(manifest, { builtinHostCritical: BUILTIN_HOST_CRITICAL });
  const unrestricted = { bytes: bytes(catalog), tokens: catalog.reduce((n, t) => n + estimateTokens(schemaOf(t)), 0) };
  const rows = [];
  for (const [key, binding] of Object.entries(manifest.agents)) {
    const policy = resolver.resolve(key);
    const r = evaluate(policy, catalog.map((t) => ({ ...toolCapability(t.name), tokens: estimateTokens(schemaOf(t)) })));
    const primary = catalog.filter((t) => r.entries.find((e) => e.id === toolCapability(t.name).id)?.state === 'primary');
    const cost = { bytes: bytes(primary) + JSON.stringify(discoverSchema).length, tokens: r.tokens.inPrompt + estimateTokens({ ...discoverSchema, parameters: discoverSchema.input_schema }) };
    rows.push({ agent: key, preset: binding.preset, counts: r.counts, ...cost, savedPct: Math.round((1 - cost.bytes / unrestricted.bytes) * 1000) / 10, tokenSavedPct: Math.round((1 - cost.tokens / unrestricted.tokens) * 1000) / 10 });
  }
  return { tools: catalog.length, unrestricted, discover: { bytes: JSON.stringify(discoverSchema).length, tokens: estimateTokens({ ...discoverSchema, parameters: discoverSchema.input_schema }) }, rows };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = bench();
  console.log(`catalog: ${r.tools} real dsh tools, ${r.unrestricted.bytes} bytes (~${r.unrestricted.tokens} tokens) unrestricted`);
  console.log(`discover tool (carried by every managed agent): ${r.discover.bytes} bytes (~${r.discover.tokens} tokens)\n`);
  console.log('agent      preset     primary/secondary/tertiary/denied   bytes   ~tokens   saved(bytes)  saved(tokens)');
  for (const x of r.rows) console.log(`${x.agent.padEnd(10)} ${x.preset.padEnd(10)} ${`${x.counts.primary}/${x.counts.secondary}/${x.counts.tertiary}/${x.counts.denied}`.padEnd(35)} ${String(x.bytes).padStart(5)}   ${String(x.tokens).padStart(7)}   ${`${x.savedPct}%`.padStart(11)}  ${`${x.tokenSavedPct}%`.padStart(12)}`);
}
