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

// Core = ships with DSH. Switching one off is allowed, but the page asks first. Extra notes where the fallout is not obvious.
export const CORE_NOTES = Object.freeze({
  skill: 'Without it the model cannot load any skill, including the discovery skill.',
  working_directory: 'Most file and shell tools depend on knowing the working directory.',
  subagent: 'Delegation to other agents stops working.',
  subagent_fork: 'Forked delegation stops working.',
  bash: 'The model can no longer run shell commands.',
  read: 'The model can no longer read files, and most coding work needs that.',
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
  const composed = new Map(compositions.filter((c) => c && c.id !== undefined).map((c) => [c.id, (Array.isArray(c.rows) ? c.rows : []).map((r) => r?.moduleName).filter(Boolean)]));
  const pluginInfo = new Map(plugins.map((p) => [p.moduleName, p]));
  const groups = new Map();
  const group = (id, kind, label, detail) => { if (!groups.has(id)) groups.set(id, { id, kind, label, detail, items: [] }); return groups.get(id); };

  for (const t of tools) {
    const cap = toolCapability(t.name);
    if (reserved(cap.id)) continue;
    const core = !cap.owner && Object.hasOwn(BUILTIN_TOOL_PLUGINS, t.name);
    const item = { id: cap.id, label: t.name, description: short(t.description), tokens: t.tokens ?? 0, core, note: core ? (CORE_NOTES[t.name] ?? null) : null };
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
    group(`skills:${provider}`, 'skills', provider, 'skills').items.push({ id: `skill:${s.name}`, label: s.name, description: short(s.description), tokens: 0, core: s.source === 'bundled', note: null });
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
  const settled = async (fn, fallback) => { try { return (await fn()) ?? fallback; } catch (e) { ctx.logger?.warn?.(`preset-manager: inventory source failed: ${e?.message}`); return fallback; } };

  const plugins = await settled(() => {
    const loader = ctx.get('loader');
    const packages = ctx.get('pluginPackages');
    const out = [];
    for (const entry of loader?.entries() ?? []) {
      if (entry.options?.group || typeof entry.options?.name !== 'string') continue;
      let meta;
      try { const base = entry.parent?.tree?.ctx?.baseUrl; meta = base === undefined ? undefined : packages?.metaOf?.(entry.options.name, base); } catch { /* display metadata is optional */ }
      out.push({ moduleName: entry.options.name, enabled: !entry.disabled, meta: typeof meta?.title === 'string' ? { title: meta.title } : undefined });
    }
    return out;
  }, []);
  return buildInventory({
    presets: await settled(() => registry?.list(), []),
    compositions: await settled(() => registry?.compositionInventory(), []),
    plugins,
    tools: await settled(() => (tools?.schemas() ?? []).map((s) => ({ name: s.name, description: s.description, tokens: estimateTokens(s) })), []),
    skills: await settled(async () => (await skills?.list({}))?.filter((x) => typeof x?.name === 'string'), []),
  });
}
