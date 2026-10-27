// Policy resolution. The effective decision is the INTERSECTION of every layer's opinion: any deny wins, and a
// lower layer can never broaden a higher one. Layer order only decides which layer is blamed in the explanation:
// admin, agent restrictions, parent presets (nearest first), the preset itself, session override, then defaults.
import { normalizeCap, parseCapId } from './ids.js';
import { matchAny } from './match.js';
import { PolicyError, parseOverride } from './manifest.js';

/** One layer's opinion on one capability: null = the layer says nothing about this category. */
function opine(layer, category, name) {
  const s = layer.sections[category];
  if (!s) return null;
  const denied = matchAny(s.deny, name);
  if (denied !== undefined && matchAny(s.except, name) === undefined) return { opinion: 'deny', rule: `deny:${denied}` };
  if (s.mode === 'allowlist') {
    const allowed = matchAny(s.grant, name);
    return allowed === undefined ? { opinion: 'deny', rule: 'not-in-allowlist' } : { opinion: 'allow', rule: `allow:${allowed}` };
  }
  return { opinion: 'allow', rule: 'not-denied' };
}

const RANK = { primary: 0, secondary: 1, tertiary: 2 };

/** The tier a layer assigns to a capability it allows: the most restrictive list that matches. */
function tierIn(layer, category, name) {
  const s = layer.sections[category];
  if (!s) return 'primary';
  if (matchAny(s.tertiary, name) !== undefined) return 'tertiary';
  if (matchAny(s.secondary, name) !== undefined) return 'secondary';
  return 'primary';
}

function makePolicy({ manifest, agent, preset, chain, managed, layers, failClosed, builtinHostCritical = [] }) {
  const { defaults, admin } = manifest;
  const adminLayer = layers[0]; // layers[0] is always admin
  const hostCritical = (id) => matchAny(admin.hostCritical, id) !== undefined || (!failClosed && builtinHostCritical.includes(id));

  function decide(input, { dynamic = false } = {}) {
    const cap = normalizeCap(input);
    const done = (allowed, reason, extra = {}) => ({ id: cap.id, allowed, reason, trail, ...extra });
    const trail = [];

    if (failClosed) {
      return hostCritical(cap.id)
        ? done(true, 'host-critical', { layer: 'admin', rule: 'host_critical' })
        : done(false, 'fail-closed', { layer: 'admin', rule: failClosed });
    }

    const adminOp = opine(adminLayer, cap.category, cap.name);
    if (adminOp) trail.push({ layer: adminLayer.name, ...adminOp });
    if (adminOp?.opinion === 'deny') return done(false, 'denied-by-layer', { layer: adminLayer.name, rule: adminOp.rule });
    if (hostCritical(cap.id)) return done(true, 'host-critical', { layer: 'admin', rule: 'host_critical' });

    if (dynamic && defaults.dynamic_registration === 'deny') {
      return done(false, 'dynamic-registration', { layer: 'defaults', rule: 'dynamic_registration:deny' });
    }

    for (const layer of layers.slice(1)) {
      const op = opine(layer, cap.category, cap.name);
      if (op) trail.push({ layer: layer.name, ...op });
    }
    const ownAllowed = trail.some((t) => t.opinion === 'allow') && !trail.some((t) => t.opinion === 'deny');

    // A capability whose owner (plugin / MCP server) is explicitly denied is denied too. An owner nobody has an
    // opinion about is ignored, so native tools are not swept up just because no plugins section exists.
    const owner = cap.owner && parseCapId(cap.owner);
    if (owner) {
      for (const layer of layers) {
        const op = opine(layer, owner.category, owner.name);
        if (op?.opinion === 'deny') {
          trail.push({ layer: layer.name, opinion: 'deny', rule: `owner ${cap.owner}: ${op.rule}` });
          return done(false, 'owner-denied', { layer: layer.name, rule: `owner ${cap.owner}: ${op.rule}`, ownAllowed });
        }
      }
    }

    const deny = trail.find((t) => t.opinion === 'deny');
    if (deny) return done(false, 'denied-by-layer', { layer: deny.layer, rule: deny.rule });
    const allow = trail.find((t) => t.opinion === 'allow');
    if (allow) return done(true, 'allowed-by-layer', { layer: allow.layer, rule: allow.rule });

    const open = managed ? defaults.unknown_capability === 'allow' : !defaults.strict;
    return done(open, managed ? 'unknown-capability-default' : 'unmanaged-default', { layer: 'defaults', rule: managed ? `unknown_capability:${defaults.unknown_capability}` : 'unmanaged' });
  }

  /** 'denied', or the tier of an allowed capability: 'primary' | 'secondary' | 'tertiary'. */
  function state(input, opts) {
    const d = decide(input, opts);
    if (!d.allowed) return 'denied';
    if (d.reason === 'host-critical') return 'primary';
    const cap = normalizeCap(input);
    let tier = 'primary';
    for (const l of layers) { const t = tierIn(l, cap.category, cap.name); if (RANK[t] > RANK[tier]) tier = t; }
    return tier;
  }

  function explain(input, opts) {
    const d = decide(input, opts);
    const s = state(input, opts);
    const why = d.layer ? `${d.layer} (${d.rule})` : d.reason;
    return { id: d.id, state: s, allowed: d.allowed, reason: d.reason, layer: d.layer, rule: d.rule, trail: d.trail, summary: `${d.id} is ${s}: ${d.reason} by ${why}` };
  }

  return Object.freeze({ agent, preset, chain, managed, failClosed: failClosed ?? null, layers: layers.map((l) => l.name), layerSections: layers, defaults, decide, state, explain });
}

export function createResolver(manifest, { builtinHostCritical = [] } = {}) {
  const adminLayer = { name: 'admin', kind: 'admin', sections: manifest.admin.sections };
  const base = { manifest, builtinHostCritical };

  const chainOf = (name) => {
    const out = [];
    for (let n = name; n !== undefined; n = manifest.presets[n].extends) out.push(manifest.presets[n]);
    return out; // leaf first
  };

  return {
    manifest,
    /** Effective policy for one agent (an existing agent-preset id or agent key). */
    resolve(agent, { session } = {}) {
      const binding = Object.hasOwn(manifest.agents, agent) ? manifest.agents[agent] : manifest.agents['*'];
      if (!binding && manifest.defaults.strict) return this.failClosed(`no preset bound to agent "${agent}"`, agent);

      const layers = [adminLayer];
      let chain = [];
      let leaf = null;
      if (binding) {
        layers.push({ name: `agent:${binding.key}`, kind: 'agent', sections: binding.sections });
        const presets = chainOf(binding.preset);
        leaf = presets[0].name;
        chain = presets.map((p) => p.name);
        presets.slice(1).forEach((p) => layers.push({ name: `parent:${p.name}`, kind: 'parent', sections: p.sections }));
        layers.push({ name: `preset:${leaf}`, kind: 'preset', sections: presets[0].sections });
      }
      if (session !== undefined) {
        const o = parseOverride(session, manifest);
        if (!o.ok) throw new PolicyError('invalid session override', o.errors);
        layers.push({ name: 'session', kind: 'session', sections: o.sections });
      }
      return makePolicy({ ...base, agent, preset: leaf, chain, managed: Boolean(binding), layers });
    },
    /** Authorization could not be established: only admin host-critical capabilities stay available. */
    failClosed(reason, agent = null) {
      return makePolicy({ ...base, agent, preset: null, chain: [], managed: false, layers: [adminLayer], failClosed: reason });
    },
  };
}
