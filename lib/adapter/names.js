// Map runtime tool names and call arguments onto policy capabilities. Pure; no DSH imports.
export const RUN_CODE = 'run_code'; // reserved PTC transport: cannot be restricted; nested calls are checked one by one.
export const DISCOVER_TOOL = 'discover';
export const DISCOVERY_SKILL = 'discovery';
/** Exempt from every preset allowlist: without these an agent could not reach its own secondary/tertiary tools. */
export const BUILTIN_HOST_CRITICAL = Object.freeze([`tool:${DISCOVER_TOOL}`, `skill:${DISCOVERY_SKILL}`]);

const MCP_PREFIX = 'mcp__';

/**
 * `mcp__<server>__<tool>` -> mcp-tool `server/tool`, owned by `mcp-server:server`. The registry attaches no server
 * metadata, so the split is on the first `__` after the prefix; a server name containing `__` cannot be told apart.
 * Names that DSH shortened with a hash suffix will not match tool patterns (fail closed).
 */
export function toolCapability(name) {
  if (name.startsWith(MCP_PREFIX)) {
    const rest = name.slice(MCP_PREFIX.length);
    const i = rest.indexOf('__');
    if (i > 0 && i < rest.length - 2) {
      const server = rest.slice(0, i);
      return { id: `mcp-tool:${server}/${rest.slice(i + 2)}`, owner: `mcp-server:${server}` };
    }
  }
  return { id: `tool:${name}` };
}

/** Capability (with owner) for an id string; MCP tools get their server as owner. */
export function capabilityOf(id) {
  const m = /^mcp-tool:([^/]+)\//.exec(id);
  return m ? { id, owner: `mcp-server:${m[1]}` } : { id };
}

/** What the model typed -> capability id: a full id as-is, otherwise a tool name. */
export function targetId(name) {
  return /^(tool|mcp-tool|mcp-server|skill|plugin|subagent):./.test(name) ? name : toolCapability(name).id;
}

/** Every capability one call touches: the tool itself, the skill it loads, the subagent preset it delegates to. */
export function callCapabilities(exec) {
  const caps = [toolCapability(exec.name)];
  const a = exec.arguments;
  if (a && typeof a === 'object') {
    if (exec.name === 'skill' && typeof a.name === 'string' && a.name) caps.push({ id: `skill:${a.name}` });
    if (typeof a.agent_preset === 'string' && a.agent_preset) caps.push({ id: `subagent:${a.agent_preset}` });
  }
  return caps;
}

/** Rough prompt cost of one model-visible tool schema (~4 chars/token). An estimate, never a measurement. */
export function estimateTokens(schema) {
  return Math.ceil(JSON.stringify({ name: schema.name, description: schema.description, parameters: schema.parameters ?? schema.inputSchema }).length / 4);
}
