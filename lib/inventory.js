// What the Settings page lists: every agent preset, installed plugin, MCP server, tool and skill, grouped by owner.
// `buildInventory` is pure (plain data in, plain data out); `collectInventory` reads the host services.
//
// Ownership: skills carry their provider and MCP tools their server, both exact. The tool registry does not record
// which plugin registered a tool, so native tools are mapped through BUILTIN_TOOL_PLUGINS (read from the DSH
// 0.2.1-rc.2 packages). Tools it does not know, e.g. from third-party plugins, are listed under "Other tools".
import { toolCapability, estimateTokens, DISCOVER_TOOL, DISCOVERY_SKILL } from './adapter/names.js';

export const BUILTIN_TOOL_PLUGINS = Object.freeze({
  bash: 'dsh-tool-bash', read: 'dsh-tool-fs', write: 'dsh-tool-fs', edit: 'dsh-tool-fs', read_image: 'dsh-tool-fs',
  glob: 'dsh-tool-fs-search', grep: 'dsh-tool-fs-search',
  create_goal: 'dsh-tool-goal', get_goal: 'dsh-tool-goal', update_goal: 'dsh-tool-goal',
  job_list: 'dsh-tool-jobs', job_output: 'dsh-tool-jobs', job_kill: 'dsh-tool-jobs',
  skill: 'dsh-tool-skill', todo_write: 'dsh-tool-todo', working_directory: 'dsh-tool-working-directory',
  web_fetch: 'dsh-tool-web', web_search: 'dsh-tool-web', workflow: 'dsh-tool-workflow',
  subagent: 'dsh-tool-subagent', subagent_fork: 'dsh-tool-subagent',
  interrupt_agent: 'dsh-tool-subagent-control', send_message: 'dsh-tool-subagent-control',
  list_agents: 'dsh-experimental-tool-agent-team', exit_plan_mode: 'dsh-plan-mode',
});

const short = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const byLabel = (a, b) => a.label.localeCompare(b.label);
// These two are added by this plugin to every managed preset; they are not the user's to switch off.
const reserved = (id) => id === `tool:${DISCOVER_TOOL}` || id === `skill:${DISCOVERY_SKILL}`;

/**
 * @param input.presets      [{id, name?, description?, broken?}]
 * @param input.compositions [{id, rows:[{moduleName}]}] plugins composed into each preset
 * @param input.plugins      [{moduleName, enabled, fiberPhase, meta?}] every plugin the host has loaded
 * @param input.tools        [{name, description, tokens}] the global tool catalog
 * @param input.skills       [{name, description, provider, source}]
 */
export function buildInventory({ presets = [], compositions = [], plugins = [], tools = [], skills = [] } = {}) {
  const composed = new Map(compositions.map((c) => [c.id, c.rows.map((r) => r.moduleName)]));
  const pluginInfo = new Map(plugins.map((p) => [p.moduleName, p]));
  const groups = new Map();
  const group = (id, kind, label, detail) => { if (!groups.has(id)) groups.set(id, { id, kind, label, detail, items: [] }); return groups.get(id); };

  for (const t of tools) {
    const cap = toolCapability(t.name);
    if (reserved(cap.id)) continue;
    const item = { id: cap.id, label: t.name, description: short(t.description), tokens: t.tokens ?? 0 };
    if (cap.owner) {
      const server = cap.owner.slice('mcp-server:'.length);
      group(`mcp:${server}`, 'mcp', server, 'MCP server').items.push({ ...item, label: cap.id.slice(cap.id.indexOf('/') + 1) });
    } else if (BUILTIN_TOOL_PLUGINS[t.name]) {
      const mod = BUILTIN_TOOL_PLUGINS[t.name];
      group(`plugin:${mod}`, 'plugin', mod, pluginInfo.get(mod)?.enabled === false ? 'plugin (disabled)' : 'plugin').items.push(item);
    } else {
      group('other-tools', 'other', 'Other tools', 'registered by plugins that do not say which one').items.push(item);
    }
  }
  for (const s of skills) {
    if (reserved(`skill:${s.name}`)) continue;
    const provider = s.provider || s.source || 'skills';
    group(`skills:${provider}`, 'skills', provider, 'skills').items.push({ id: `skill:${s.name}`, label: s.name, description: short(s.description), tokens: 0 });
  }
  const list = [...groups.values()].sort((a, b) => (a.kind === 'other') - (b.kind === 'other') || byLabel(a, b));
  for (const g of list) g.items.sort(byLabel);

  const grouped = new Set(list.filter((g) => g.kind === 'plugin').map((g) => g.label));
  return {
    presets: presets.map((p) => ({ id: p.id, name: p.name ?? p.id, description: short(p.description, 200), broken: p.broken ?? null, plugins: composed.get(p.id) ?? [] })),
    plugins: plugins.map((p) => ({ id: p.moduleName, label: p.meta?.title ?? p.moduleName, enabled: p.enabled !== false, phase: p.fiberPhase ?? null, hasCapabilities: grouped.has(p.moduleName) })).sort(byLabel),
    groups: list,
  };
}

/** Read the live services. Every service is optional: a headless profile has no presets, a bare one has no skills. */
export async function collectInventory(ctx) {
  const tools = ctx.get('tools');
  const registry = ctx.get('agentPresets');
  const skills = ctx.get('skills');
  const loader = ctx.get('loader');
  const packages = ctx.get('pluginPackages');
  const settled = async (fn, fallback) => { try { return (await fn()) ?? fallback; } catch (e) { ctx.logger?.warn?.(`preset-manager: inventory source failed: ${e?.message}`); return fallback; } };

  const plugins = [];
  if (loader) {
    for (const entry of loader.entries()) {
      if (entry.options.group) continue;
      const base = entry.parent?.tree?.ctx?.baseUrl;
      plugins.push({ moduleName: entry.options.name, enabled: !entry.disabled, fiberPhase: entry.fiber ? String(entry.fiber.state) : null, meta: base === undefined ? undefined : packages?.metaOf?.(entry.options.name, base) });
    }
  }
  return buildInventory({
    presets: await settled(() => registry?.list(), []),
    compositions: await settled(() => registry?.compositionInventory(), []),
    plugins,
    tools: (tools?.schemas() ?? []).map((s) => ({ name: s.name, description: s.description, tokens: estimateTokens(s) })),
    skills: await settled(() => skills?.list({}), []),
  });
}
