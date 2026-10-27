// The `discover` tool and its approval gate.
//   secondary: the model finds a hidden capability and enables it itself, for one use ("now") or the session.
//   tertiary:  same request, but DSH's approval prompt asks the human first. The prompt is allow/deny; the proposed
//              duration is in its text. No approval service (headless, scheduled runs) means DSH denies the call.
// A tertiary grant needs proof the prompt allowed that exact call: the pre-execute hook records the ask, and the
// tool body refuses to grant without it. The enforcer independently refuses tertiary grants without the proof flag.
import { DISCOVER_TOOL, DISCOVERY_SKILL, targetId } from './names.js';

const MAX_RESULTS = 20;
const MAX_LINE = 160;
const MAX_REASON = 300;

export const DISCOVER_DESCRIPTION = `Find and turn on capabilities that are not in your tool list. Some tools and skills are kept out of your context on purpose (secondary or tertiary).
action "search": list them; optional "query" words and "tier" (secondary | tertiary).
action "enable": turn one on by "name". Secondary: you decide; "duration" is "now" (one use, preferred) or "session". Tertiary: the user must approve; give an honest short "reason". If refused, do not retry.
A newly enabled tool appears in your tool list on your next step. Do not enable things speculatively.`;

export const DISCOVERY_SKILL_CONTENT = `# Discovery

Your tool list is deliberately short. Other capabilities exist but are kept out of your context to save it.

1. When a task needs something you do not have (fetching a web page, reading an image, a shell), call \`discover\` with action "search" and a few keywords.
2. Secondary results you can enable yourself: action "enable", the name shown, and duration "now" (one use, the default) or "session" (only when you will need it repeatedly).
3. Tertiary results need the user's approval. Give a short, honest reason. If the user refuses, do not ask again: carry on without it, or say what you could not do.
4. An enabled tool shows up in your tool list on your next step.

Every enabled schema costs context. Enable only what the task needs.
`;

export const discoverySkill = Object.freeze({
  name: DISCOVERY_SKILL,
  description: 'How to find and enable secondary and tertiary tools and skills with the discover tool.',
  source: 'runtime',
  content: DISCOVERY_SKILL_CONTENT,
});

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const durationOf = (v) => (v === 'session' ? 'session' : 'now');

/** @param {{enforcer: object, audit: object, listSkills?: (agent: object) => Promise<{name: string, description?: string}[]>}} deps */
export function createDiscovery({ enforcer, audit, listSkills }) {
  const asked = new Map(); // `${session}|${callId}` -> { id, duration, used }
  const keyOf = (exec) => `${String(exec.agent?.session?.id)}|${exec.callId}`;

  async function search(agent, args) {
    const tier = args.tier === undefined ? undefined : args.tier;
    if (tier !== undefined && tier !== 'secondary' && tier !== 'tertiary') throw new Error('tier must be "secondary" or "tertiary"');
    const rows = enforcer.hiddenTools(agent).map((t) => ({ name: t.name, tier: t.tier, enabled: t.enabled, description: t.description }));
    if (listSkills) {
      try {
        for (const s of await listSkills(agent)) {
          const id = `skill:${s.name}`;
          const t = enforcer.tierOf(agent, id);
          if (t === 'secondary' || t === 'tertiary') rows.push({ name: id, tier: t, enabled: enforcer.isEnabled(agent, id), description: clean(s.description, 200) });
        }
      } catch { /* skills are optional: a failing catalog must not break tool discovery */ }
    }
    const words = clean(args.query, 200).toLowerCase().split(' ').filter(Boolean);
    const hits = rows
      .filter((r) => !tier || r.tier === tier)
      .filter((r) => words.every((w) => `${r.name} ${r.description}`.toLowerCase().includes(w)))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (hits.length === 0) return rows.length === 0 ? 'No secondary or tertiary capabilities are available to you.' : 'No matches. Try fewer or different words, or search without a query.';
    const shown = hits.slice(0, MAX_RESULTS).map((r) => `- ${r.name} [${r.tier}${r.enabled ? ', enabled' : ''}]${r.description ? `: ${r.description.slice(0, MAX_LINE)}` : ''}`);
    return [`${hits.length} match${hits.length === 1 ? '' : 'es'}${hits.length > MAX_RESULTS ? ` (showing ${MAX_RESULTS}; narrow the query)` : ''}:`, ...shown, 'Enable with action "enable" and the name shown.'].join('\n');
  }

  function enable(agent, exec, args) {
    const name = clean(args.name, 300);
    if (!name) throw new Error('name is required');
    const id = targetId(name);
    const tier = enforcer.tierOf(agent, id);
    // A name that does not exist and one that is denied look identical on purpose.
    if (tier === undefined || tier === 'denied') throw new Error(`"${name}" is not available to you.`);
    if (tier === 'primary') return `"${name}" is already in your tool list.`;
    if (enforcer.isEnabled(agent, id)) return `"${name}" is already enabled.`;
    const duration = durationOf(args.duration);

    let humanApproved = false;
    if (tier === 'tertiary') {
      const ask = asked.get(keyOf(exec));
      if (!ask || ask.id !== id) throw new Error(`The user's approval was not recorded, so "${name}" was not enabled.`);
      ask.used = true;
      humanApproved = true;
    }
    const r = enforcer.enable(agent, id, { duration, humanApproved });
    if (!r.ok) throw new Error(r.error);
    const when = duration === 'session' ? 'for the rest of this session' : 'for one use';
    return `"${name}" is enabled ${when}. It appears in your tool list on your next step.`;
  }

  const tool = {
    name: DISCOVER_TOOL,
    description: DISCOVER_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'enable'], description: 'search lists hidden capabilities; enable turns one on.' },
        query: { type: 'string', description: 'Words to match against names and descriptions (search).' },
        tier: { type: 'string', enum: ['secondary', 'tertiary'], description: 'Only list this tier (search).' },
        name: { type: 'string', description: 'Capability to enable, exactly as listed by search.' },
        duration: { type: 'string', enum: ['now', 'session'], description: '"now" = one use (default); "session" = until the session ends.' },
        reason: { type: 'string', description: 'Why you need it. Shown to the user for tertiary capabilities.' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 30_000,
    async execute(args, exec) {
      const agent = exec.agent;
      if (!enforcer.isManaged(agent)) throw new Error('discover is not available for this agent.');
      if (args.action === 'search') return { text: await search(agent, args) };
      if (args.action === 'enable') return { text: enable(agent, exec, args) };
      throw new Error('action must be "search" or "enable"');
    },
  };

  return {
    tool,

    /** `tools/pre-execute`: a tertiary enable becomes an `ask`, which DSH routes to the approval prompt. */
    async preExecute(exec, next) {
      const decision = await next();
      if (decision.kind !== 'allow' || exec.name !== DISCOVER_TOOL) return decision;
      const a = exec.arguments;
      if (!a || typeof a !== 'object' || a.action !== 'enable' || typeof a.name !== 'string') return decision;
      if (!enforcer.isManaged(exec.agent)) return decision;
      const name = clean(a.name, 300);
      const id = targetId(name);
      if (enforcer.tierOf(exec.agent, id) !== 'tertiary' || enforcer.isEnabled(exec.agent, id)) return decision;

      const duration = durationOf(a.duration);
      const reason = clean(a.reason, MAX_REASON);
      asked.set(keyOf(exec), { id, duration, used: false });
      audit.record('approval-requested', { agent: String(exec.agent.session.id), capability: id, detail: duration });
      const when = duration === 'session' ? 'for the rest of this session' : 'for one use';
      const text = `Allow the agent to use "${name}" ${when}? It is a tertiary capability and needs your approval.${reason ? ` The agent says: ${reason}` : ''}`;
      return { kind: 'ask', reason: text, displayReason: { en: text } };
    },

    /** `tools/result`: record how an approval ended, and spend "now" grants that have been used. */
    onResult(exec, result) {
      const k = keyOf(exec);
      const ask = exec.name === DISCOVER_TOOL ? asked.get(k) : undefined;
      if (ask) {
        asked.delete(k);
        const agent = String(exec.agent?.session?.id);
        if (result.isError || !ask.used) audit.record('approval-denied', { agent, capability: ask.id, detail: clean(result.error?.message ?? 'not granted', 160) });
        else audit.record('approval-granted', { agent, capability: ask.id, detail: ask.duration });
      }
      enforcer.noteResult(exec);
    },
  };
}
