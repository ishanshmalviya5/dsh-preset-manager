// Evaluate a resolved policy against a catalog snapshot: per-capability state, context-cost metrics and issues.
// Catalog entry: {id, owner?, tokens?, discoveryTokens?, dependencies?, mandatory?, dynamic?, description?}.
import { normalizeCap } from './ids.js';
import { matchAny } from './match.js';

const SECTION_FIELDS = ['allow', 'primary', 'secondary', 'tertiary', 'deny', 'except'];

export function evaluate(policy, catalog) {
  const entries = [];
  const byId = new Map(catalog.map((e) => [e.id, e]));
  for (const e of catalog) {
    const cap = normalizeCap(e);
    const opts = { dynamic: e.dynamic === true };
    const d = policy.decide(cap, opts);
    entries.push({ id: e.id, category: cap.category, state: policy.state(cap, opts), allowed: d.allowed, reason: d.reason, layer: d.layer, rule: d.rule, tokens: e.tokens, discoveryTokens: e.discoveryTokens ?? 0, ownAllowed: d.ownAllowed });
  }

  const issues = [];
  for (const e of catalog) {
    const r = entries.find((x) => x.id === e.id);
    if (e.mandatory && !r.allowed) issues.push({ severity: 'error', kind: 'mandatory-denied', id: e.id, message: `${e.id} is mandatory but denied (${r.layer}: ${r.rule})` });
    if (r.reason === 'owner-denied' && r.ownAllowed) issues.push({ severity: 'warning', kind: 'allowed-but-owner-denied', id: e.id, message: `${e.id} is allowed by its own rule but denied because its owner ${e.owner} is denied` });
    if (r.allowed) for (const dep of e.dependencies ?? []) {
      const target = entries.find((x) => x.id === dep);
      if (!byId.has(dep)) issues.push({ severity: 'error', kind: 'missing-dependency', id: e.id, message: `${e.id} depends on ${dep}, which is not in the catalog` });
      else if (!target.allowed) issues.push({ severity: 'error', kind: 'denied-dependency', id: e.id, message: `${e.id} is allowed but its dependency ${dep} is denied` });
    }
  }

  // Rules that match nothing: usually a typo, or a capability that is not registered (yet).
  for (const layer of policy.layerSections) {
    for (const [category, s] of Object.entries(layer.sections)) {
      const names = catalog.filter((e) => e.id.startsWith(`${category}:`)).map((e) => e.id.slice(category.length + 1));
      for (const field of SECTION_FIELDS) for (const p of s[field]) {
        if (!names.some((n) => matchAny([p], n) !== undefined)) issues.push({ severity: 'warning', kind: 'unmatched-rule', layer: layer.name, message: `${layer.name}: ${category} ${field} "${p}" matches no known capability` });
      }
    }
  }

  const sum = (rows, f) => rows.reduce((n, r) => n + (f(r) ?? 0), 0);
  const tier = (t) => entries.filter((e) => e.state === t);
  const primary = tier('primary');
  const hidden = [...tier('secondary'), ...tier('tertiary')];
  const unrestricted = sum(entries, (e) => e.tokens);
  // Only primary schemas are in the prompt. Hidden tiers cost their short discovery metadata, if the catalog has it.
  const inPrompt = sum(primary, (e) => e.tokens) + sum(hidden, (e) => e.discoveryTokens);
  const counts = { total: entries.length, allowed: entries.filter((e) => e.allowed).length, denied: entries.filter((e) => !e.allowed).length, primary: primary.length, secondary: tier('secondary').length, tertiary: tier('tertiary').length };
  const tokens = { unrestricted, inPrompt, saved: unrestricted - inPrompt, savedPct: unrestricted ? Math.round(((unrestricted - inPrompt) / unrestricted) * 1000) / 10 : 0, unmeasured: entries.filter((e) => e.tokens === undefined).length };
  return { agent: policy.agent, preset: policy.preset, entries, counts, tokens, issues };
}

/** Capabilities whose state differs between two evaluations of the same catalog (preset diff). */
export function diffStates(a, b) {
  const before = new Map(a.entries.map((e) => [e.id, e.state]));
  return b.entries.filter((e) => before.get(e.id) !== e.state).map((e) => ({ id: e.id, from: before.get(e.id), to: e.state }));
}
