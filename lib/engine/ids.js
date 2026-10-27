// Capability identity: `<category>:<name>`. The engine only ever sees these ids; mapping to runtime names
// (e.g. mcp-tool `github/create_issue` -> `mcp__github__create_issue`) belongs to the catalog.
export const CATEGORIES = Object.freeze(['tool', 'plugin', 'mcp-server', 'mcp-tool', 'skill', 'subagent']);

export const capId = (category, name) => `${category}:${name}`;

export function parseCapId(id) {
  if (typeof id !== 'string') return null;
  const i = id.indexOf(':');
  if (i <= 0 || i === id.length - 1) return null;
  const category = id.slice(0, i);
  return CATEGORIES.includes(category) ? { category, name: id.slice(i + 1) } : null;
}

/** Accepts an id string or `{id, owner?}`; returns `{id, category, name, owner}` or throws TypeError. */
export function normalizeCap(input) {
  const raw = typeof input === 'string' ? { id: input } : input;
  const parsed = parseCapId(raw?.id);
  if (!parsed) throw new TypeError(`invalid capability id: ${JSON.stringify(raw?.id)}`);
  if (raw.owner !== undefined && !parseCapId(raw.owner)) throw new TypeError(`invalid owner id: ${JSON.stringify(raw.owner)}`);
  return { id: raw.id, ...parsed, owner: raw.owner };
}
