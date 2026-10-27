// Manifest parsing: raw JSON -> validated, alias-expanded, frozen structure. Pure; never throws on bad input
// (returns issues) so a failed reload can keep the previous manifest.
import { CATEGORIES } from './ids.js';
import { patternProblem } from './match.js';

export class PolicyError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'PolicyError';
    this.issues = issues;
  }
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const AGENT_RE = /^(\*|[A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/; // `*` = fallback binding for agents with no preset of their own
const SECTION_KEYS = ['mode', 'allow', 'primary', 'secondary', 'tertiary', 'deny', 'except'];
const GRANT_KEYS = ['allow', 'primary', 'secondary', 'tertiary'];
const MODES = ['allowlist', 'denylist'];
const TOP_SECTIONS = { tools: 'tool', plugins: 'plugin', skills: 'skill', subagents: 'subagent' };
const MCP_SECTIONS = { servers: 'mcp-server', tools: 'mcp-tool' };

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.hasOwn(o, k);

function collector() {
  const errors = [];
  const warnings = [];
  return { errors, warnings, err: (path, message) => errors.push({ path, message }), warn: (path, message) => warnings.push({ path, message }) };
}

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

function unknownKeys(obj, allowed, path, issues) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) issues.err(path ? `${path}.${k}` : k, 'unknown key');
}

/** Expand `@alias` references in one list. Unknown aliases are errors; values are deduplicated. */
function parseList(value, path, ctx) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { ctx.issues.err(path, 'must be an array of strings'); return []; }
  const out = [];
  value.forEach((item, i) => {
    const at = `${path}[${i}]`;
    if (typeof item === 'string' && item.startsWith('@')) {
      const name = item.slice(1);
      if (!ctx.aliases.has(name)) ctx.issues.err(at, `unknown alias "${name}"`);
      else out.push(...ctx.aliases.get(name));
      return;
    }
    const problem = patternProblem(item);
    if (problem) ctx.issues.err(at, `pattern ${problem}`);
    else out.push(item);
  });
  return [...new Set(out)];
}

function parseSection(raw, path, ctx) {
  if (!isObject(raw)) { ctx.issues.err(path, 'must be an object'); return undefined; }
  unknownKeys(raw, SECTION_KEYS, path, ctx.issues);
  const lists = Object.fromEntries(['allow', 'primary', 'secondary', 'tertiary', 'deny', 'except'].map((k) => [k, parseList(raw[k], `${path}.${k}`, ctx)]));
  let mode = raw.mode;
  if (mode !== undefined && !MODES.includes(mode)) { ctx.issues.err(`${path}.mode`, `must be one of ${MODES.join(', ')}`); mode = undefined; }
  if (raw.mode === undefined) {
    const hasGrant = GRANT_KEYS.some((k) => raw[k] !== undefined), hasDeny = raw.deny !== undefined;
    if (hasGrant && !hasDeny) mode = 'allowlist';
    else if (hasDeny && !hasGrant) mode = 'denylist';
    else ctx.issues.err(`${path}.mode`, hasGrant ? 'required when both allow-type lists and deny are given' : 'required when no list is given');
  }
  // Tiers: listing a capability in primary/secondary/tertiary also allows it (allowlist mode). `allow` is the primary
  // tier. A capability matched by several tier lists takes the most restrictive tier: tertiary > secondary > primary.
  const grant = [...new Set([...lists.allow, ...lists.primary, ...lists.secondary, ...lists.tertiary])];
  if (mode === 'denylist') for (const k of ['allow', 'primary']) if (lists[k].length) ctx.issues.warn(`${path}.${k}`, 'ignored in denylist mode (everything not denied is already primary)');
  if (mode === 'allowlist' && grant.length === 0) ctx.issues.warn(path, 'empty allowlist denies everything in this category');
  for (const p of grant) if (lists.deny.includes(p)) ctx.issues.warn(path, `"${p}" is allowed and denied (deny wins)`);
  for (const p of lists.secondary) if (lists.tertiary.includes(p)) ctx.issues.warn(path, `"${p}" is in both secondary and tertiary (tertiary wins)`);
  if (lists.except.length && lists.deny.length === 0) ctx.issues.warn(`${path}.except`, 'has no effect without deny rules');
  return { mode, ...lists, grant };
}

/** Parse the per-category sections shared by admin, presets, agents and session overrides. */
function parseSections(raw, path, ctx, extraKeys = []) {
  const sections = {};
  unknownKeys(raw, [...Object.keys(TOP_SECTIONS), 'mcp', ...extraKeys], path, ctx.issues);
  for (const [key, category] of Object.entries(TOP_SECTIONS)) {
    if (own(raw, key)) { const s = parseSection(raw[key], `${path}.${key}`, ctx); if (s) sections[category] = s; }
  }
  if (own(raw, 'mcp')) {
    if (!isObject(raw.mcp)) ctx.issues.err(`${path}.mcp`, 'must be an object');
    else {
      unknownKeys(raw.mcp, Object.keys(MCP_SECTIONS), `${path}.mcp`, ctx.issues);
      for (const [key, category] of Object.entries(MCP_SECTIONS)) {
        if (own(raw.mcp, key)) { const s = parseSection(raw.mcp[key], `${path}.mcp.${key}`, ctx); if (s) sections[category] = s; }
      }
    }
  }
  return sections;
}

function expandAliases(raw, issues) {
  const expanded = new Map();
  if (raw === undefined) return expanded;
  if (!isObject(raw)) { issues.err('aliases', 'must be an object'); return expanded; }
  const visit = (name, stack) => {
    if (expanded.has(name)) return expanded.get(name);
    if (stack.includes(name)) { issues.err(`aliases.${name}`, `alias cycle: ${[...stack, name].join(' -> ')}`); return []; }
    const list = raw[name];
    if (!Array.isArray(list)) { issues.err(`aliases.${name}`, 'must be an array of strings'); return []; }
    const out = [];
    list.forEach((item, i) => {
      if (typeof item === 'string' && item.startsWith('@')) {
        const ref = item.slice(1);
        if (!own(raw, ref)) issues.err(`aliases.${name}[${i}]`, `unknown alias "${ref}"`);
        else out.push(...visit(ref, [...stack, name]));
      } else {
        const problem = patternProblem(item);
        if (problem) issues.err(`aliases.${name}[${i}]`, `pattern ${problem}`);
        else out.push(item);
      }
    });
    const unique = [...new Set(out)];
    expanded.set(name, unique);
    return unique;
  };
  for (const name of Object.keys(raw)) {
    if (!NAME_RE.test(name)) issues.err(`aliases.${name}`, 'invalid alias name');
    else visit(name, []);
  }
  return expanded;
}

function parseHostCritical(raw, path, issues) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { issues.err(path, 'must be an array of capability id patterns'); return []; }
  const out = [];
  raw.forEach((p, i) => {
    const problem = patternProblem(p);
    if (problem) return issues.err(`${path}[${i}]`, `pattern ${problem}`);
    const category = p.split(':')[0];
    if (!p.includes(':') || !(category === '*' || CATEGORIES.includes(category))) return issues.err(`${path}[${i}]`, 'must be a full id pattern like "tool:ask_user"');
    out.push(p);
  });
  return out;
}

/** @returns {{ok: boolean, errors: object[], warnings: object[], manifest?: object}} */
export function parseManifest(raw) {
  const issues = collector();
  const result = () => ({ ok: issues.errors.length === 0, errors: issues.errors, warnings: issues.warnings });
  if (!isObject(raw)) { issues.err('', 'manifest must be an object'); return result(); }
  unknownKeys(raw, ['version', 'defaults', 'admin', 'aliases', 'presets', 'agents'], '', issues);
  if (raw.version !== 1) issues.err('version', 'must be 1');

  const aliases = expandAliases(raw.aliases, issues);
  const ctx = { aliases, issues };

  const defaults = { unknown_capability: 'deny', inheritance: 'restrictive', dynamic_registration: 'deny', strict: false };
  if (raw.defaults !== undefined) {
    if (!isObject(raw.defaults)) issues.err('defaults', 'must be an object');
    else {
      unknownKeys(raw.defaults, Object.keys(defaults), 'defaults', issues);
      for (const [k, allowed] of [['unknown_capability', ['deny', 'allow']], ['inheritance', ['restrictive']], ['dynamic_registration', ['deny', 'allow']]]) {
        if (raw.defaults[k] === undefined) continue;
        if (allowed.includes(raw.defaults[k])) defaults[k] = raw.defaults[k];
        else issues.err(`defaults.${k}`, `must be one of ${allowed.join(', ')}`);
      }
      if (raw.defaults.strict !== undefined) {
        if (typeof raw.defaults.strict === 'boolean') defaults.strict = raw.defaults.strict;
        else issues.err('defaults.strict', 'must be a boolean');
      }
    }
  }

  let admin = { hostCritical: [], sections: {} };
  if (raw.admin !== undefined) {
    if (!isObject(raw.admin)) issues.err('admin', 'must be an object');
    else admin = { hostCritical: parseHostCritical(raw.admin.host_critical, 'admin.host_critical', issues), sections: parseSections(raw.admin, 'admin', ctx, ['host_critical']) };
  }

  const presets = {};
  if (raw.presets !== undefined) {
    if (!isObject(raw.presets)) issues.err('presets', 'must be an object');
    else for (const [name, p] of Object.entries(raw.presets)) {
      const path = `presets.${name}`;
      if (!NAME_RE.test(name)) { issues.err(path, 'invalid preset name'); continue; }
      if (!isObject(p)) { issues.err(path, 'must be an object'); continue; }
      if (p.description !== undefined && typeof p.description !== 'string') issues.err(`${path}.description`, 'must be a string');
      if (p.extends !== undefined && typeof p.extends !== 'string') issues.err(`${path}.extends`, 'must be a string');
      presets[name] = { name, description: p.description, extends: p.extends, sections: parseSections(p, path, ctx, ['description', 'extends']) };
    }
  }
  for (const p of Object.values(presets)) {
    if (p.extends !== undefined && typeof p.extends === 'string' && !own(presets, p.extends)) issues.err(`presets.${p.name}.extends`, `unknown preset "${p.extends}"`);
  }
  for (const p of Object.values(presets)) {
    const seen = [p.name];
    for (let n = p.extends; n && own(presets, n); n = presets[n].extends) {
      if (seen.includes(n)) { issues.err(`presets.${p.name}.extends`, `extends cycle: ${[...seen, n].join(' -> ')}`); break; }
      seen.push(n);
    }
  }

  const agents = {};
  if (raw.agents !== undefined) {
    if (!isObject(raw.agents)) issues.err('agents', 'must be an object');
    else for (const [key, a] of Object.entries(raw.agents)) {
      const path = `agents.${key}`;
      if (!AGENT_RE.test(key)) { issues.err(path, 'invalid agent key'); continue; }
      if (!isObject(a)) { issues.err(path, 'must be an object'); continue; }
      unknownKeys(a, ['preset', 'restrict'], path, issues);
      if (typeof a.preset !== 'string') issues.err(`${path}.preset`, 'required string');
      else if (!own(presets, a.preset)) issues.err(`${path}.preset`, `unknown preset "${a.preset}"`);
      let sections = {};
      if (a.restrict !== undefined) {
        if (!isObject(a.restrict)) issues.err(`${path}.restrict`, 'must be an object');
        else sections = parseSections(a.restrict, `${path}.restrict`, ctx);
      }
      agents[key] = { key, preset: a.preset, sections };
    }
  }

  if (issues.errors.length) return result();
  const manifest = deepFreeze({ version: 1, defaults, admin, aliases: Object.fromEntries(aliases), presets, agents });
  return { ...result(), manifest };
}

/** Session override: same section shape, narrowing only (it becomes one more intersected layer). */
export function parseOverride(raw, manifest) {
  const issues = collector();
  const aliases = new Map(Object.entries(manifest?.aliases ?? {}));
  if (!isObject(raw)) issues.err('', 'override must be an object');
  const sections = isObject(raw) ? parseSections(raw, 'override', { aliases, issues }) : {};
  return { ok: issues.errors.length === 0, errors: issues.errors, warnings: issues.warnings, sections: deepFreeze(sections) };
}
