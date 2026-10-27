// `dpm`: manage the manifest from a terminal. Offline: it reads and writes the same file the plugin watches, through
// the same validation, atomically, keeping one rollback copy. Running agents pick edits up live via the plugin.
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createResolver, parseManifest, evaluate, diffStates } from './engine/index.js';
import { saveManifest, readRaw, defaultManifestFile } from './store.js';
import { toolCapability, estimateTokens, BUILTIN_HOST_CRITICAL } from './adapter/names.js';
import { loadExample } from './settings-api.js';

const HELP = `dpm - capability presets for dsh agents

  init [--example]                       create a manifest (refuses to overwrite)
  preset list                            presets and which agents use them
  preset show <name>                     the preset as written
  preset validate [name]                 check the manifest (exit 1 on errors)
  preset diff <a> <b>                    what differs between two presets, per tier
  preset create <name>                   a deny-everything starter to edit
  preset clone <source> <destination>
  preset activate <preset> [--agent K]   bind an agent preset to a capability preset (default agent: *)
  capability explain <agent> <id>        why one capability is allowed or denied, and its tier
  capability test <agent> <id>           exit 0 if allowed (any tier), 1 if denied
  agent capabilities <agent> [--catalog tools.json]
                                         effective rules; with a catalog, every tool by tier and the token saving
  rollback                               restore the previous manifest

options: --file <manifest>  --json  (capability ids look like tool:bash, mcp-tool:github/search_x, skill:swift)
`;

class UsageError extends Error {}

function parse(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args._.push('help');
    else if (a === '--json' || a === '--example') args.flags[a.slice(2)] = true;
    else if (a === '--file' || a === '--agent' || a === '--catalog' || a === '--description') {
      if (argv[i + 1] === undefined) throw new UsageError(`${a} needs a value`);
      args.flags[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else args._.push(a);
  }
  return args;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TIERS = ['allow', 'primary', 'secondary', 'tertiary', 'deny', 'except'];

export function run(argv, { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`), file: defaultFile } = {}) {
  let args;
  try { args = parse(argv); } catch (e) { err(e.message); return 2; }
  const file = args.flags.file ?? defaultFile ?? defaultManifestFile();
  const json = args.flags.json === true;
  const [a, b, c, d] = args._;
  const emit = (value, text) => out(json ? JSON.stringify(value, null, 2) : text);

  const loadRaw = () => {
    const text = readRaw(file);
    if (text === undefined) throw new UsageError(`no manifest at ${file}; run "dpm init"`);
    try { return JSON.parse(text); } catch (e) { throw new UsageError(`${file} is not valid JSON: ${e.message}`); }
  };
  const loadParsed = () => {
    const raw = loadRaw();
    const parsed = parseManifest(raw);
    if (!parsed.ok) throw new UsageError(`${file} is invalid:\n${parsed.errors.map((e) => `  ${e.path || '(root)'}: ${e.message}`).join('\n')}`);
    return { raw, ...parsed };
  };
  const resolver = (manifest) => createResolver(manifest, { builtinHostCritical: BUILTIN_HOST_CRITICAL });
  const write = (raw) => {
    const r = saveManifest(raw, file);
    if (!r.ok) throw new UsageError(`not saved; the previous manifest is untouched:\n${r.errors.map((e) => `  ${e.path || '(root)'}: ${e.message}`).join('\n')}`);
    return r;
  };

  try {
    if (!a || a === 'help' || a === '--help') { out(HELP); return a ? 0 : 2; }

    if (a === 'init') {
      if (existsSync(file)) throw new UsageError(`${file} already exists; not overwriting`);
      const text = args.flags.example ? loadExample() : JSON.stringify({ version: 1, presets: {}, agents: {} });
      write(JSON.parse(text));
      emit({ file }, `created ${file}${args.flags.example ? ' with example presets' : ''}`);
      return 0;
    }

    if (a === 'rollback') {
      const prev = `${file}.prev`;
      if (!existsSync(prev)) throw new UsageError('no previous manifest to roll back to');
      const parsed = parseManifest(JSON.parse(readFileSync(prev, 'utf8')));
      if (!parsed.ok) throw new UsageError('the previous manifest is no longer valid; not restoring it');
      copyFileSync(prev, file);
      emit({ ok: true }, `restored ${file} from its previous version`);
      return 0;
    }

    if (a === 'preset') {
      if (b === 'list') {
        const { manifest } = loadParsed();
        const rows = Object.values(manifest.presets).map((p) => ({ name: p.name, extends: p.extends ?? null, agents: Object.values(manifest.agents).filter((x) => x.preset === p.name).map((x) => x.key), description: p.description ?? '' }));
        emit(rows, rows.length ? rows.map((r) => `${r.name}${r.extends ? ` (extends ${r.extends})` : ''}  agents: ${r.agents.join(', ') || '-'}${r.description ? `  ${r.description}` : ''}`).join('\n') : 'no presets');
        return 0;
      }
      if (b === 'show') {
        const raw = loadRaw();
        if (!c || !raw.presets?.[c]) throw new UsageError(`unknown preset "${c ?? ''}"`);
        out(JSON.stringify(raw.presets[c], null, 2));
        return 0;
      }
      if (b === 'validate') {
        const raw = loadRaw();
        const parsed = parseManifest(raw);
        if (c && parsed.ok && !parsed.manifest.presets[c]) throw new UsageError(`unknown preset "${c}"`);
        const issues = [...parsed.errors.map((e) => `error    ${e.path || '(root)'}: ${e.message}`), ...parsed.warnings.map((e) => `warning  ${e.path || '(root)'}: ${e.message}`)];
        emit({ ok: parsed.ok, errors: parsed.errors, warnings: parsed.warnings }, `${parsed.ok ? 'valid' : 'INVALID'}${issues.length ? `\n${issues.join('\n')}` : ''}`);
        return parsed.ok ? 0 : 1;
      }
      if (b === 'diff') {
        const { manifest } = loadParsed();
        if (!manifest.presets[c] || !manifest.presets[d]) throw new UsageError('usage: preset diff <a> <b> (both must exist)');
        const rows = [];
        const cats = new Set([...Object.keys(manifest.presets[c].sections), ...Object.keys(manifest.presets[d].sections)]);
        for (const cat of [...cats].sort()) for (const f of TIERS) {
          const x = manifest.presets[c].sections[cat]?.[f] ?? [], y = manifest.presets[d].sections[cat]?.[f] ?? [];
          const only = (p, q) => p.filter((v) => !q.includes(v));
          if (only(x, y).length || only(y, x).length) rows.push({ category: cat, list: f, onlyInA: only(x, y), onlyInB: only(y, x) });
        }
        emit(rows, rows.length ? rows.map((r) => `${r.category}.${r.list}: only ${c}: [${r.onlyInA.join(', ')}]  only ${d}: [${r.onlyInB.join(', ')}]`).join('\n') : 'no differences in rules');
        return 0;
      }
      if (b === 'create' || b === 'clone') {
        const raw = loadRaw();
        const name = b === 'create' ? c : d;
        if (!name || !NAME.test(name)) throw new UsageError(`invalid preset name "${name ?? ''}"`);
        if (raw.presets?.[name]) throw new UsageError(`preset "${name}" already exists`);
        if (b === 'clone' && !raw.presets?.[c]) throw new UsageError(`unknown preset "${c ?? ''}"`);
        raw.presets = { ...(raw.presets ?? {}), [name]: b === 'clone' ? structuredClone(raw.presets[c]) : { description: args.flags.description ?? '', tools: { mode: 'allowlist', primary: [] } } };
        write(raw);
        emit({ created: name }, b === 'create' ? `created "${name}" (denies every tool until you add some under tools.primary / secondary / tertiary)` : `cloned "${c}" to "${name}"`);
        return 0;
      }
      if (b === 'activate') {
        const raw = loadRaw();
        const key = args.flags.agent ?? '*';
        if (!c || !raw.presets?.[c]) throw new UsageError(`unknown preset "${c ?? ''}"`);
        raw.agents = { ...(raw.agents ?? {}), [key]: { ...(raw.agents?.[key] ?? {}), preset: c } };
        write(raw);
        emit({ agent: key, preset: c }, `agent "${key}" now uses preset "${c}". New sessions get it at once; running sessions follow while the Preset Manager plugin is running.`);
        return 0;
      }
    }

    if (a === 'capability' && (b === 'explain' || b === 'test')) {
      const { manifest } = loadParsed();
      if (!c || !d) throw new UsageError(`usage: capability ${b} <agent> <capability-id>`);
      const policy = resolver(manifest).resolve(c);
      const e = policy.explain(d);
      if (b === 'explain') emit(e, `${e.summary}${policy.managed ? '' : ' (no preset is bound to this agent, so nothing is restricted)'}`);
      else emit({ allowed: e.allowed, tier: e.state }, `${e.allowed ? 'allowed' : 'denied'} (${e.state})`);
      return e.allowed ? 0 : 1;
    }

    if (a === 'agent' && b === 'capabilities') {
      const { manifest } = loadParsed();
      if (!c) throw new UsageError('usage: agent capabilities <agent> [--catalog tools.json]');
      const policy = resolver(manifest).resolve(c);
      const head = `agent ${c}: ${policy.managed ? `preset ${policy.preset}${policy.chain.length > 1 ? ` (extends ${policy.chain.slice(1).join(', ')})` : ''}` : 'unmanaged (no binding; nothing restricted)'}\nlayers: ${policy.layers.join(' > ')}`;
      if (!args.flags.catalog) {
        const sections = policy.layerSections.flatMap((l) => Object.entries(l.sections).map(([cat, s]) => ({ layer: l.name, category: cat, mode: s.mode, ...Object.fromEntries(TIERS.filter((f) => s[f].length).map((f) => [f, s[f]])) })));
        emit({ agent: c, layers: policy.layers, sections }, `${head}\n${sections.map((s) => `  ${s.layer} ${s.category} ${s.mode}: ${TIERS.filter((f) => s[f]).map((f) => `${f}=[${s[f].join(', ')}]`).join(' ')}`).join('\n')}`);
        return 0;
      }
      const tools = JSON.parse(readFileSync(args.flags.catalog, 'utf8'));
      const result = evaluate(policy, tools.map((t) => ({ ...toolCapability(t.name), tokens: estimateTokens({ name: t.name, description: t.description, parameters: t.parameters ?? t.input_schema }) })));
      const by = (s) => result.entries.filter((e) => e.state === s).map((e) => e.id.replace(/^tool:/, ''));
      const text = [head, `primary (${result.counts.primary}): ${by('primary').join(', ') || '-'}`, `secondary (${result.counts.secondary}): ${by('secondary').join(', ') || '-'}`, `tertiary (${result.counts.tertiary}): ${by('tertiary').join(', ') || '-'}`, `denied (${result.counts.denied}): ${by('denied').join(', ') || '-'}`, `estimated schema tokens ${result.tokens.unrestricted} -> ${result.tokens.inPrompt} (${result.tokens.savedPct}% saved), before the discover tool's own cost`, ...result.issues.map((i) => `${i.severity}: ${i.message}`)].join('\n');
      emit({ agent: c, counts: result.counts, tokens: result.tokens, issues: result.issues }, text);
      return 0;
    }

    throw new UsageError(`unknown command: ${argv.filter((x) => !x.startsWith('--')).join(' ')}\n\n${HELP}`);
  } catch (e) {
    if (e instanceof UsageError) { err(e.message); return 2; }
    err(`dpm: ${e?.message ?? e}`);
    return 1;
  }
}
