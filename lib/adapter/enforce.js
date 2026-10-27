// Enforcement adapter: turns a resolved policy into (1) an agent-scoped monotonic `guard` (authoritative: runs on
// every call, nested PTC calls included) and (2) a deny-form `restrict` that removes schemas the model should not see.
// Guard is installed before anything is hidden. Hiding is a context optimisation; the guard is the boundary.
//
// Tiers: PRIMARY is visible. SECONDARY is hidden until the model enables it through `discover`. TERTIARY is hidden
// until a human approves it. Both stay hidden from the schema and blocked by the guard until granted.
//
// Why deny-form restrict: an allow-form restriction needs every allowed name to exist, so a late-registered tool
// could never be admitted. A deny-form restriction lets new names appear in schemas(agent), where they are
// classified in the same synchronous tick as the `tools/change` that announced them; the guard covers the gap.
import { PolicyError } from '../engine/index.js';
import { RUN_CODE, toolCapability, capabilityOf, callCapabilities, estimateTokens } from './names.js';

// restrict() words it "unknown global tool "a"" for one name and "unknown global tools "a", "b"" for several.
const unknownNames = (message) => {
  const m = /unknown global tools? (.*?)(?:; known global tools:|$)/s.exec(message);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
};
const UNBOUND = '(unbound)';
const RANK = { primary: 0, secondary: 1, tertiary: 2 };
const MAX_DESCRIPTION = 200;

export function createEnforcer({ resolver, agentPresets, audit, auditAllowed = false }) {
  let current = resolver;
  let applying = 0; // restrict()/dispose emit tools/change; ignore our own echoes
  const states = new Map();

  const sessionIdOf = (agent) => String(agent.session.id);
  const presetOf = (agent) => agentPresets?.composedPreset?.(agent.ctx);
  const isToolId = (id) => id.startsWith('tool:') || id.startsWith('mcp-tool:');

  /** Resolve, or fail closed (and say so) when the policy cannot be established. */
  function policyFor(state, from = current) {
    try {
      return from.resolve(state.presetId ?? UNBOUND, { session: state.session });
    } catch (e) {
      audit.record('policy-error', { agent: state.id, preset: state.presetId, detail: e instanceof PolicyError ? `${e.message}: ${e.issues.map((i) => i.path).join(',')}` : String(e?.message) });
      return from.failClosed(`policy could not be resolved: ${e?.message}`, state.presetId);
    }
  }

  /** 'denied' | 'primary' | 'secondary' | 'tertiary' for one capability id, as this agent's policy sees it. */
  function tierOf(state, id, policy = state.policy) {
    const dynamic = isToolId(id) && !state.initial.has(runtimeNameOf(state, id));
    return policy.state(capabilityOf(id), { dynamic });
  }

  /** Visible to the model: primary, or a higher tier that has been granted. */
  const reachable = (state, id, tier) => tier === 'primary' || (tier !== 'denied' && state.enabled.has(id));

  // tool id -> runtime name, for the tools this agent has seen (`mcp-tool:s/t` -> `mcp__s__t`)
  const runtimeNameOf = (state, id) => state.names.get(id) ?? id.replace(/^tool:/, '');

  function makeGuard(state) {
    return (exec) => {
      if (exec.name === RUN_CODE) return undefined; // transport only; every nested call arrives here by itself
      try {
        const caps = callCapabilities(exec);
        for (let i = 0; i < caps.length; i++) {
          const dynamic = i === 0 && !state.initial.has(exec.name);
          const d = state.policy.decide(caps[i], { dynamic });
          const argKeys = exec.arguments && typeof exec.arguments === 'object' ? Object.keys(exec.arguments) : [];
          if (!d.allowed) {
            audit.record('invocation-denied', { agent: state.id, preset: state.policy.preset, capability: caps[i].id, layer: d.layer, rule: d.rule, reason: d.reason, argKeys });
            return `${caps[i].id} is not permitted for this agent (${d.layer}: ${d.rule})`;
          }
          const tier = state.policy.state(caps[i], { dynamic });
          if (!reachable(state, caps[i].id, tier)) {
            audit.record('invocation-denied', { agent: state.id, preset: state.policy.preset, capability: caps[i].id, layer: 'tier', rule: `${tier}-not-enabled`, reason: 'not-enabled', argKeys });
            return tier === 'tertiary'
              ? `${caps[i].id} is a tertiary capability: it needs the user's approval. Call discover to request it.`
              : `${caps[i].id} is a secondary capability: call discover to enable it first.`;
          }
        }
        if (auditAllowed) audit.record('invocation-allowed', { agent: state.id, preset: state.policy.preset, capability: caps[0].id });
        return undefined;
      } catch (e) {
        audit.record('policy-error', { agent: state.id, detail: `guard: ${e?.message}` });
        return 'capability policy could not be evaluated'; // fail closed
      }
    };
  }

  /** Drop grants that no longer fit the policy: now denied, now primary, or now a stricter tier than was granted. */
  function pruneGrants(state, policy) {
    for (const [id, grant] of state.enabled) {
      const tier = tierOf(state, id, policy);
      if (tier === 'denied' || tier === 'primary' || RANK[tier] > RANK[grant.tier]) {
        state.enabled.delete(id);
        audit.record('capability-expired', { agent: state.id, capability: id, reason: tier === 'denied' ? 'denied' : tier === 'primary' ? 'now-primary' : 'stricter-tier' });
      }
    }
  }

  /** Make the model-visible tool set match `policy`. Synchronous so no request can interleave with the swap. */
  function hide(state, policy, why = 'apply') {
    const { tools, agent } = state;
    pruneGrants(state, policy);
    const visible = tools.schemas(agent);
    for (const s of visible) {
      state.known.set(s.name, { tokens: estimateTokens(s), description: String(s.description ?? '').replace(/\s+/g, ' ').slice(0, MAX_DESCRIPTION) });
      state.names.set(toolCapability(s.name).id, s.name);
    }

    const shouldShow = (name) => {
      const id = toolCapability(name).id;
      const tier = policy.state(toolCapability(name), { dynamic: !state.initial.has(name) });
      return reachable(state, id, tier);
    };

    const candidates = new Set();
    for (const name of state.known.keys()) if (name !== RUN_CODE && !shouldShow(name)) candidates.add(name);

    let next;
    while (candidates.size) {
      try {
        next = tools.restrict({ deny: [...candidates] });
        break;
      } catch (e) {
        const gone = unknownNames(String(e?.message)).filter((n) => candidates.has(n));
        if (!gone.length) throw e;
        for (const name of gone) { // gone, or registered in the agent's own scope: restrict() cannot name it
          candidates.delete(name);
          if (!visible.some((s) => s.name === name)) { state.known.delete(name); state.names.delete(toolCapability(name).id); }
        }
      }
    }
    state.restriction?.(); // new restriction first, then lift the old one: never looser in between
    state.restriction = next;

    const nowVisible = tools.schemas(agent);
    for (const s of nowVisible) {
      if (s.name !== RUN_CODE && !shouldShow(s.name) && !state.leaked.has(s.name)) {
        state.leaked.add(s.name);
        audit.record('schema-leak', { agent: state.id, capability: toolCapability(s.name).id, detail: 'should be hidden but is not hideable (registered in the agent scope); the guard still blocks execution' });
      }
    }
    audit.record('policy-applied', { agent: state.id, why, enabled: state.enabled.size, ids: [...candidates], preset: policy.preset, hidden: state.known.size - nowVisible.filter((s) => state.known.has(s.name)).length, visible: nowVisible.length, tokens: tokenSummary(state, nowVisible) });
  }

  function tokenSummary(state, visible) {
    const unrestricted = [...state.known.values()].reduce((n, k) => n + k.tokens, 0);
    const inPrompt = visible.reduce((n, s) => n + (state.known.get(s.name)?.tokens ?? estimateTokens(s)), 0);
    return { unrestricted, inPrompt, saved: unrestricted - inPrompt, savedPct: unrestricted ? Math.round(((unrestricted - inPrompt) / unrestricted) * 1000) / 10 : 0 };
  }

  const quietly = (fn) => { applying++; try { return fn(); } finally { applying--; } };
  const stateOf = (agent) => states.get(sessionIdOf(agent));

  return {
    /** Attach policy to a freshly created agent (call from `agent/created`). */
    attach(agent) {
      const id = sessionIdOf(agent);
      if (states.has(id)) this.detach(agent);
      const tools = agent.ctx.get('tools');
      const state = { id, agent, tools, presetId: presetOf(agent), session: undefined, initial: new Set(tools.schemas(agent).map((s) => s.name)), known: new Map(), names: new Map(), enabled: new Map(), restriction: undefined, leaked: new Set(), policy: undefined, disposeGuard: undefined };
      state.policy = policyFor(state);
      state.disposeGuard = tools.guard(makeGuard(state)); // enforcement first
      states.set(id, state);
      try {
        quietly(() => hide(state, state.policy));
      } catch (e) {
        audit.record('apply-failed', { agent: id, detail: String(e?.message) }); // the guard still enforces
      }
      return state;
    },

    detach(agent) {
      const state = stateOf(agent);
      if (!state) return;
      states.delete(state.id);
      quietly(() => { state.disposeGuard?.(); state.restriction?.(); });
      audit.record('agent-detached', { agent: state.id });
    },

    /** Re-evaluate every attached agent (wire to `tools/change`). Follows preset switches on blank agents. */
    refresh() {
      if (applying) return;
      quietly(() => {
        for (const state of states.values()) {
          try {
            const presetId = presetOf(state.agent);
            if (presetId !== state.presetId) {
              audit.record('preset-changed', { agent: state.id, from: state.presetId, to: presetId });
              state.presetId = presetId;
              state.enabled.clear(); // grants belong to the policy that issued them
              state.initial = new Set([...state.known.keys(), ...state.tools.schemas(state.agent).map((s) => s.name)]);
              state.policy = policyFor(state);
            }
            hide(state, state.policy, 'tools-change');
          } catch (e) {
            audit.record('apply-failed', { agent: state.id, detail: String(e?.message) });
          }
        }
      });
    },

    /** Swap in a new resolver for all agents. All-or-nothing: if any agent cannot be resolved, nothing changes. */
    reload(next) {
      const prepared = [...states.values()].map((state) => [state, next.resolve(state.presetId ?? UNBOUND, { session: state.session })]);
      current = next;
      quietly(() => {
        for (const [state, policy] of prepared) {
          state.policy = policy;
          try { hide(state, policy); } catch (e) { audit.record('apply-failed', { agent: state.id, detail: String(e?.message) }); }
        }
      });
      audit.record('preset-reloaded', { count: prepared.length });
    },

    /** Narrowing-only override for one live agent. Throws PolicyError (and changes nothing) when invalid. */
    setSession(agent, override) {
      const state = stateOf(agent);
      if (!state) throw new Error('agent is not managed');
      const policy = current.resolve(state.presetId ?? UNBOUND, { session: override });
      state.session = override;
      state.policy = policy;
      quietly(() => hide(state, policy));
      audit.record('session-override', { agent: state.id, preset: policy.preset });
    },

    // ---- tiers: what `discover` needs ----

    isManaged: (agent) => agent !== undefined && states.has(sessionIdOf(agent)),

    /** Tier of one capability for this agent, or undefined when the agent is not managed. */
    tierOf(agent, id) {
      const state = stateOf(agent);
      return state ? tierOf(state, id) : undefined;
    },

    isEnabled: (agent, id) => stateOf(agent)?.enabled.has(id) === true,

    /** Allowed secondary/tertiary tools this agent has seen, with their short description. */
    hiddenTools(agent) {
      const state = stateOf(agent);
      if (!state) return [];
      const out = [];
      for (const [name, k] of state.known) {
        if (name === RUN_CODE) continue;
        const id = toolCapability(name).id;
        const tier = tierOf(state, id);
        if (tier === 'secondary' || tier === 'tertiary') out.push({ id, name, tier, enabled: state.enabled.has(id), description: k.description, tokens: k.tokens });
      }
      return out;
    },

    /**
     * Grant a secondary or tertiary capability. A tertiary grant is refused unless the caller passes `humanApproved`,
     * which only the discover tool does, and only after DSH's approval prompt allowed that exact call.
     */
    enable(agent, id, { duration = 'now', humanApproved = false } = {}) {
      const state = stateOf(agent);
      if (!state) return { ok: false, error: 'agent is not managed' };
      const tier = tierOf(state, id);
      if (tier === 'denied') return { ok: false, error: `${id} is not available to this agent` };
      if (tier === 'primary') return { ok: true, tier, already: true };
      if (tier === 'tertiary' && !humanApproved) {
        audit.record('enable-refused', { agent: state.id, capability: id, reason: 'tertiary-needs-human' });
        return { ok: false, error: `${id} needs the user's approval` };
      }
      state.enabled.set(id, { duration: duration === 'session' ? 'session' : 'now', tier });
      audit.record('capability-enabled', { agent: state.id, preset: state.policy.preset, capability: id, tier, detail: `${duration === 'session' ? 'session' : 'now'}; ${tier === 'tertiary' ? 'approved by user' : 'chosen by model'}` });
      if (isToolId(id)) quietly(() => hide(state, state.policy, 'enable'));
      return { ok: true, tier, duration: duration === 'session' ? 'session' : 'now' };
    },

    /** A call finished: a "now" grant is spent once the capability it covers has been used. */
    noteResult(exec) {
      const state = exec.agent ? stateOf(exec.agent) : undefined;
      if (!state || state.enabled.size === 0) return;
      let changed = false;
      for (const cap of callCapabilities(exec)) {
        const grant = state.enabled.get(cap.id);
        if (grant?.duration === 'now') {
          state.enabled.delete(cap.id);
          audit.record('capability-expired', { agent: state.id, capability: cap.id, reason: 'used-once' });
          changed ||= isToolId(cap.id);
        }
      }
      if (changed) quietly(() => hide(state, state.policy, 'expire'));
    },

    policyOf: (agent) => stateOf(agent)?.policy,
    explain: (agent, id, opts) => stateOf(agent)?.policy.explain(id, opts),

    /** Every tool name seen by any attached agent, with estimated schema tokens (the live catalog). */
    catalog() {
      const out = new Map();
      for (const state of states.values()) for (const [name, k] of state.known) if (!out.has(name)) out.set(name, k.tokens);
      return [...out].map(([name, tokens]) => ({ name, tokens }));
    },

    metrics(agent) {
      const state = stateOf(agent);
      if (!state) return undefined;
      const visible = state.tools.schemas(state.agent);
      const tiers = { primary: 0, secondary: 0, tertiary: 0, denied: 0 };
      for (const name of state.known.keys()) tiers[tierOf(state, toolCapability(name).id)]++;
      return { agent: state.id, preset: state.policy.preset, managed: state.policy.managed, failClosed: state.policy.failClosed, tools: { known: state.known.size, visible: visible.length, hidden: state.known.size - visible.filter((s) => state.known.has(s.name)).length, tiers }, enabled: [...state.enabled].map(([id, g]) => ({ id, tier: g.tier, duration: g.duration })), tokens: { ...tokenSummary(state, visible), estimated: true }, leaked: [...state.leaked] };
    },

    allMetrics() { return [...states.values()].map((st) => this.metrics(st.agent)); },

    agents: () => [...states.values()].map((s) => ({ id: s.id, preset: s.policy.preset, bound: s.presetId, managed: s.policy.managed, failClosed: s.policy.failClosed })),
  };
}
