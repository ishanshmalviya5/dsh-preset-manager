// The Settings page's table <-> the manifest. `statesFor` reads what a preset currently allows; `withMatrix` writes the
// table back as explicit lists. Pure functions over plain data, so both directions are tested without a host.
import { createResolver, parseManifest } from './engine/index.js';
import { capabilityOf, BUILTIN_HOST_CRITICAL } from './adapter/names.js';

export const TIERS = Object.freeze(['denied', 'primary', 'secondary', 'tertiary']);

/** Tier of every inventory item under `presetId`. A preset with no policy yet is unmanaged: everything is primary. */
export function statesFor(raw, presetId, inventory) {
  const items = inventory.groups.flatMap((g) => g.items);
  const states = Object.fromEntries(items.map((i) => [i.id, 'primary']));
  const parsed = raw ? parseManifest(raw) : undefined;
  if (!parsed?.ok) return { states, managed: false };
  let policy;
  try { policy = createResolver(parsed.manifest, { builtinHostCritical: BUILTIN_HOST_CRITICAL }).resolve(presetId); } catch { return { states, managed: false }; }
  if (!policy.managed) return { states, managed: false };
  for (const i of items) states[i.id] = policy.state(capabilityOf(i.id));
  return { states, managed: true };
}

const section = (lists) => ({ mode: 'allowlist', primary: lists.primary, secondary: lists.secondary, tertiary: lists.tertiary });
const empty = () => ({ primary: [], secondary: [], tertiary: [] });

/**
 * A copy of `raw` in which `presetId` has the given states and is bound to itself. Rewrites only the tools, MCP and
 * skills sections of that preset; its description, subagents section and every other preset are kept. A preset that
 * had no subagents section gets an open one, because a missing section would deny delegation outright.
 */
export function withMatrix(raw, presetId, states, inventory) {
  const out = structuredClone(raw ?? { version: 1 });
  out.version = 1;
  out.presets = out.presets ?? {};
  const previous = out.presets[presetId] ?? {};
  const tools = empty(), mcpTools = empty(), skills = empty();
  const servers = new Set();
  for (const item of inventory.groups.flatMap((g) => g.items)) {
    const tier = states[item.id];
    if (tier === undefined) throw new TypeError(`no state for ${item.id}`);
    if (!TIERS.includes(tier)) throw new TypeError(`unknown state "${tier}" for ${item.id}`);
    if (tier === 'denied') continue;
    if (item.id.startsWith('mcp-tool:')) {
      const name = item.id.slice('mcp-tool:'.length);
      mcpTools[tier].push(name);
      const server = name.slice(0, name.indexOf('/'));
      servers.add(server);
    } else if (item.id.startsWith('skill:')) skills[tier].push(item.id.slice('skill:'.length));
    else tools[tier].push(item.id.slice('tool:'.length));
  }
  // A server is itself a capability: it must be allowed for its tools to be. Its tools carry the real tier.
  const mcpServers = { ...empty(), primary: [...servers].sort() };
  const next = { ...previous, tools: section(tools), skills: section(skills), mcp: { servers: section(mcpServers), tools: section(mcpTools) } };
  if (!next.subagents) next.subagents = { mode: 'denylist', deny: [] };
  out.presets[presetId] = next;
  out.agents = { ...(out.agents ?? {}), [presetId]: { ...(out.agents?.[presetId] ?? {}), preset: presetId } };
  return out;
}
