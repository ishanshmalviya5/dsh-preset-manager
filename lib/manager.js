// Glue between the manifest file, the enforcer and the host. Keeps the last valid policy on any failed reload.
import { copyFileSync, existsSync } from 'node:fs';
import { createResolver, parseManifest, evaluate, PolicyError } from './engine/index.js';
import { createEnforcer } from './adapter/enforce.js';
import { createAudit } from './adapter/audit.js';
import { toolCapability, BUILTIN_HOST_CRITICAL } from './adapter/names.js';
import { loadManifest, saveManifest, readRaw, hasPrevious, defaultManifestFile, defaultAuditFile } from './store.js';

// Every resolver gets the built-in exemption for `discover`, so no preset can strand an agent's own higher tiers.
const resolverFor = (manifest) => createResolver(manifest, { builtinHostCritical: BUILTIN_HOST_CRITICAL });

// Strict and empty: every agent fails closed, nothing is host-critical.
const strictEmpty = () => createResolver(parseManifest({ version: 1, defaults: { strict: true } }).manifest);

const describe = (errors) => errors.map((e) => `${e.path}: ${e.message}`).join('; ');

export function createManager({ agentPresets, globalTools = () => [], file = defaultManifestFile(), auditFile = defaultAuditFile(), failClosedOnInvalid = false, auditAllowed = false, onActive, logger = console } = {}) {
  const audit = createAudit({ file: auditFile });
  const loaded = loadManifest(file);
  let resolver;

  if (loaded.ok) {
    resolver = resolverFor(loaded.manifest);
    audit.record('config-loaded', { count: Object.keys(loaded.manifest.presets).length });
  } else if (loaded.missing) {
    audit.record('config-missing', { detail: 'plugin inactive: no manifest' });
  } else {
    audit.record('config-invalid', { detail: describe(loaded.errors) });
    logger.error?.(`preset-manager: invalid manifest ${file}: ${loaded.errors[0]?.message}`);
    if (failClosedOnInvalid) resolver = strictEmpty();
  }

  let active = resolver !== undefined;
  const announce = () => { if (active) { try { onActive?.(); } catch (e) { logger.error?.(`preset-manager: onActive failed: ${e?.message}`); } } };
  let current = loaded.ok ? loaded.manifest : undefined;
  const enforcer = createEnforcer({ resolver: resolver ?? strictEmpty(), agentPresets, audit, auditAllowed });

  /** Swap a parsed manifest in for every live agent; all-or-nothing. Returns undefined or a failure result. */
  function swapIn(manifest) {
    try {
      enforcer.reload(resolverFor(manifest));
    } catch (e) {
      if (!(e instanceof PolicyError)) throw e;
      audit.record('reload-failed', { detail: `${e.message}: ${e.issues.map((i) => i.path).join(',')}` });
      return { ok: false, errors: e.issues, kept: 'previous' };
    }
    current = manifest;
    active = true;
    return undefined;
  }

  /** Candidate tools for a dry run: what live agents have seen, else what is registered globally. */
  const catalogNames = () => {
    const live = enforcer.catalog();
    return live.length ? live : globalTools();
  };

  return {
    audit,
    enforcer,
    file,
    announce,
    get active() { return active; },

    // A throwing `agent/created` listener rejects agent creation in DSH. Default: audit and let the agent start
    // (the failure is visible in the audit log); with failClosedOnInvalid the creation is refused instead.
    onAgentCreated(agent) {
      if (!active) return;
      try {
        enforcer.attach(agent);
      } catch (e) {
        audit.record('attach-failed', { agent: String(agent?.session?.id), detail: String(e?.message) });
        if (failClosedOnInvalid) throw e;
      }
    },
    onAgentDisposed(agent) { enforcer.detach(agent); },
    onToolsChange() { if (active) enforcer.refresh(); },

    /** Re-read the file. Invalid, missing or unresolvable: keep the previous policy, record why, report failure. */
    reloadFromDisk() {
      const next = loadManifest(file);
      if (!next.ok) {
        audit.record('reload-failed', { detail: next.missing ? 'manifest file is missing' : describe(next.errors) });
        return { ok: false, missing: next.missing === true, errors: next.errors, kept: active ? 'previous' : 'none' };
      }
      const failed = swapIn(next.manifest);
      if (!failed) announce();
      return failed ?? { ok: true, warnings: next.warnings };
    },

    /**
     * Validate, apply to live agents, then persist. If persisting fails the live policy is put back, so memory and
     * disk never disagree. Nothing changes on any failure.
     */
    apply(raw) {
      const parsed = parseManifest(raw);
      if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: parsed.warnings, kept: active ? 'previous' : 'none' };
      const before = current;
      const failed = swapIn(parsed.manifest);
      if (failed) return { ...failed, warnings: parsed.warnings };
      try {
        saveManifest(raw, file);
      } catch (e) {
        if (before) swapIn(before);
        audit.record('save-failed', { detail: String(e?.message) });
        return { ok: false, errors: [{ path: '', message: `could not write ${file}: ${e.message}` }], kept: 'previous' };
      }
      audit.record('config-saved', { count: Object.keys(parsed.manifest.presets).length });
      announce();
      return { ok: true, warnings: parsed.warnings };
    },

    /** Validate a candidate without touching anything. */
    validate(raw) {
      const parsed = parseManifest(raw);
      return { ok: parsed.ok, errors: parsed.errors, warnings: parsed.warnings };
    },

    /** Put the previous manifest back (one level), validating it first. */
    rollback() {
      const prev = `${file}.prev`;
      if (!existsSync(prev)) return { ok: false, errors: [{ path: '', message: 'no previous manifest to roll back to' }] };
      const parsed = loadManifest(prev);
      if (!parsed.ok) return { ok: false, errors: parsed.errors };
      const failed = swapIn(parsed.manifest);
      if (failed) return failed;
      copyFileSync(prev, file);
      audit.record('config-rolled-back', {});
      return { ok: true, warnings: parsed.warnings };
    },

    /** What the page shows: the raw file (as written), validity, bindings and live agents. */
    status() {
      const loadedNow = loadManifest(file);
      return {
        file,
        active,
        raw: readRaw(file) ?? null,
        hasPrevious: hasPrevious(file),
        valid: loadedNow.ok,
        missing: loadedNow.missing === true,
        errors: loadedNow.errors ?? [],
        warnings: loadedNow.warnings ?? [],
        presets: current ? Object.values(current.presets).map((p) => ({ name: p.name, description: p.description ?? '', extends: p.extends ?? null })) : [],
        agents: current ? Object.values(current.agents).map((a) => ({ key: a.key, preset: a.preset })) : [],
        strict: current?.defaults.strict ?? false,
      };
    },

    /** Per live agent metrics for the page. */
    liveMetrics: () => enforcer.allMetrics(),

    /** Evaluate a candidate manifest for one agent key against the live (or global) tool catalog. Writes nothing. */
    dryRun(raw, agentKey, session) {
      const parsed = parseManifest(raw);
      if (!parsed.ok) return { ok: false, errors: parsed.errors };
      let policy;
      try {
        policy = resolverFor(parsed.manifest).resolve(agentKey, { session });
      } catch (e) {
        if (e instanceof PolicyError) return { ok: false, errors: e.issues };
        throw e;
      }
      const names = catalogNames();
      const result = evaluate(policy, names.map((t) => ({ ...toolCapability(t.name), tokens: t.tokens })));
      return {
        ok: true,
        agent: agentKey,
        preset: result.preset,
        managed: policy.managed,
        counts: result.counts,
        tokens: result.tokens,
        issues: result.issues,
        warnings: parsed.warnings,
        source: enforcer.catalog().length ? 'live agents' : 'registered tools',
        denied: result.entries.filter((e) => e.state === 'denied').map((e) => ({ id: e.id, layer: e.layer, rule: e.rule })).slice(0, 200),
        secondary: result.entries.filter((e) => e.state === 'secondary').map((e) => e.id).slice(0, 200),
        tertiary: result.entries.filter((e) => e.state === 'tertiary').map((e) => e.id).slice(0, 200),
      };
    },

    /** Why is one capability allowed or denied for one agent key, under the saved policy (or a candidate)? */
    explain(agentKey, capabilityId, raw) {
      let manifest = current;
      if (raw !== undefined) {
        const parsed = parseManifest(raw);
        if (!parsed.ok) return { ok: false, errors: parsed.errors };
        manifest = parsed.manifest;
      }
      if (!manifest) return { ok: false, errors: [{ path: '', message: 'no manifest loaded' }] };
      try {
        return { ok: true, ...resolverFor(manifest).resolve(agentKey).explain(capabilityId) };
      } catch (e) {
        if (e instanceof TypeError || e instanceof PolicyError) return { ok: false, errors: [{ path: 'capability', message: e.message }] };
        throw e;
      }
    },
  };
}
