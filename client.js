// Settings page for dsh-preset-manager. The manifest editor is the single source of truth: the bindings table,
// dry run and explain all read or edit that text, and nothing reaches the host until "Save & apply".
window.__ModuleLoader__.load({
  id: 'dsh-preset-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const API = '/preset-manager-api';

    async function call(action, body = {}) {
      const res = await fetch(`${API}/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
      });
      let data;
      try { data = await res.json(); } catch { throw new Error(`HTTP ${res.status}`); }
      if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data.value;
    }

    const line = '1px solid var(--dsw-alias-border-primary, rgba(128,128,128,.4))';
    const field = { display: 'grid', gap: 4, fontSize: 13 };
    const input = { padding: '6px 8px', borderRadius: 6, fontSize: 13, boxSizing: 'border-box', border: line, background: 'var(--dsw-alias-background-primary, transparent)', color: 'var(--dsw-alias-label-primary, inherit)' };
    const btn = { padding: '6px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer', border: line, background: 'none', color: 'inherit' };
    const hint = { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)' };
    const card = { border: line, borderRadius: 8, padding: 12, display: 'grid', gap: 8 };
    const bad = '#d33833';
    const good = '#2a9d4b';
    const cell = { padding: '4px 8px', textAlign: 'left', fontSize: 13, borderBottom: line };

    const list = (ids) => `${ids.slice(0, 20).map((id) => id.replace(/^tool:/, '')).join(', ')}${ids.length > 20 ? ` and ${ids.length - 20} more` : ''}`;

    const Issues = ({ items, color }) => (items && items.length
      ? h('ul', { style: { margin: 0, paddingLeft: 18, fontSize: 12, color } }, items.map((e, i) => h('li', { key: i }, e.path ? `${e.path}: ${e.message}` : e.message)))
      : null);

    function Table({ head, rows }) {
      return h('table', { style: { borderCollapse: 'collapse', width: '100%' } },
        h('thead', null, h('tr', null, head.map((c) => h('th', { key: c, style: { ...cell, fontWeight: 600 } }, c)))),
        h('tbody', null, rows.map((r, i) => h('tr', { key: i }, r.map((c, j) => h('td', { key: j, style: cell }, c))))));
    }

    function PresetManagerSection() {
      const [data, setData] = React.useState(null);
      const [text, setText] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [msg, setMsg] = React.useState(null); // { ok, text }
      const [check, setCheck] = React.useState(null); // { errors, warnings }
      const [dry, setDry] = React.useState(null);
      const [agent, setAgent] = React.useState('*');
      const [cap, setCap] = React.useState('tool:bash');
      const [why, setWhy] = React.useState(null);
      const [events, setEvents] = React.useState([]);

      const load = (keepText) => call('get').then((v) => {
        setData(v);
        if (!keepText) setText(v.raw ?? '');
        if (v.agents?.length) setAgent((a) => (a === '*' && !v.agents.some((x) => x.key === '*') ? v.agents[0].key : a));
      }).catch((e) => setMsg({ ok: false, text: e.message }));
      React.useEffect(() => { load(false); }, []);

      const run = (fn) => async () => {
        setBusy(true); setMsg(null);
        try { setMsg({ ok: true, text: await fn() }); } catch (e) { setMsg({ ok: false, text: e.message }); }
        setBusy(false);
      };

      const validate = async () => {
        const v = await call('validate', { manifest: text });
        setCheck(v);
        if (!v.ok) throw new Error(`${v.errors.length} problem(s) found.`);
        return v.warnings.length ? `Valid, with ${v.warnings.length} warning(s).` : 'Valid.';
      };
      const save = async () => {
        const v = await call('save', { manifest: text });
        setCheck(v);
        if (!v.ok) throw new Error('Not saved: the previous policy is still in force.');
        await load(false);
        return 'Saved and applied to running agents.';
      };
      const rollback = async () => {
        const v = await call('rollback');
        setCheck(v);
        if (!v.ok) throw new Error(v.errors?.[0]?.message ?? 'Could not roll back.');
        await load(false);
        return 'Rolled back to the previous manifest.';
      };
      const dryRun = async () => {
        const v = await call('dryrun', { manifest: text, agent });
        if (!v.ok) { setDry(null); setCheck(v); throw new Error('Dry run needs a valid manifest.'); }
        setDry(v);
        return `Dry run for "${agent}" (${v.source}). Nothing was changed.`;
      };
      const explain = async () => {
        const v = await call('explain', { manifest: text, agent, capability: cap });
        if (!v.ok) { setWhy(null); throw new Error(v.errors?.[0]?.message ?? 'Cannot explain.'); }
        setWhy(v);
        return 'Explained against the text in the editor.';
      };
      const audit = async () => { setEvents((await call('audit')).events); return 'Refreshed.'; };

      // Editing a binding rewrites the editor text; the user still has to save.
      const bind = (key, preset) => {
        try {
          const m = JSON.parse(text || '{"version":1}');
          m.agents = { ...(m.agents ?? {}), [key]: { ...(m.agents?.[key] ?? {}), preset } };
          setText(JSON.stringify(m, null, 2));
          setMsg({ ok: true, text: `Binding "${key}" -> ${preset} edited in the editor. Save to apply.` });
        } catch { setMsg({ ok: false, text: 'Fix the JSON in the editor before editing bindings.' }); }
      };
      const [newKey, setNewKey] = React.useState('');
      const presetNames = (() => { try { return Object.keys(JSON.parse(text).presets ?? {}); } catch { return (data?.presets ?? []).map((p) => p.name); } })();
      const bindings = (() => { try { return Object.entries(JSON.parse(text).agents ?? {}).map(([k, v]) => [k, v.preset]); } catch { return (data?.agents ?? []).map((a) => [a.key, a.preset]); } })();

      if (!data) return h('p', { style: hint }, msg ? msg.text : 'Loading…');

      const status = data.missing ? ['No manifest yet: nothing is restricted.', hint.color]
        : !data.valid ? ['The saved manifest is invalid; the previous policy is still in force.', bad]
        : data.active ? ['Active: presets are enforced on new and running agents.', good] : ['Saved but not active.', hint.color];

      return h('div', { style: { display: 'grid', gap: 18, maxWidth: 760 } },
        h('h2', { style: { margin: 0, fontSize: 18 } }, 'Preset Manager'),
        h('p', { style: { ...hint, color: status[1] } }, status[0], data.strict ? ' Strict mode: agents without a binding are blocked.' : ''),
        h('p', { style: hint }, `Manifest file: ${data.file}`),

        h('div', { style: card },
          h('strong', { style: { fontSize: 14 } }, 'Agent bindings'),
          h('p', { style: hint }, 'Which capability preset each dsh agent preset runs under. "*" applies to any agent without its own binding.'),
          bindings.length ? h(Table, { head: ['Agent preset', 'Capability preset'], rows: bindings.map(([k, p]) => [k, h('select', { style: input, value: p, onChange: (e) => bind(k, e.target.value) }, (presetNames.includes(p) ? presetNames : [p, ...presetNames]).map((n) => h('option', { key: n, value: n }, n)))]) }) : h('p', { style: hint }, 'No bindings yet.'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('input', { style: { ...input, width: 180 }, value: newKey, onChange: (e) => setNewKey(e.target.value), placeholder: 'agent preset, e.g. standard or *' }),
            h('button', { style: btn, disabled: !newKey || !presetNames.length, onClick: () => { bind(newKey.trim(), presetNames[0]); setNewKey(''); } }, 'Add binding'))),

        h('label', { style: field }, 'Manifest (JSON)',
          h('textarea', { style: { ...input, fontFamily: 'ui-monospace, Menlo, monospace', minHeight: 320, resize: 'vertical' }, value: text, spellCheck: false, onChange: (e) => setText(e.target.value) }),
          h('p', { style: hint }, 'Each section lists primary (always in the prompt), secondary (hidden; the model enables it with discover) and tertiary (hidden; needs your approval) capabilities. Tool names are the ones the model sees (read, bash, mcp__server__tool). Wildcards * and ? work. Anything not listed is denied.')),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('button', { style: btn, disabled: busy, onClick: run(validate) }, 'Validate'),
          h('button', { style: btn, disabled: busy, onClick: run(dryRun) }, 'Dry run'),
          h('button', { style: { ...btn, fontWeight: 600 }, disabled: busy || !text.trim(), onClick: run(save) }, 'Save & apply'),
          h('button', { style: btn, disabled: busy, onClick: () => { setText(data.raw ?? ''); setCheck(null); setMsg(null); } }, 'Revert editor'),
          data.hasPrevious ? h('button', { style: btn, disabled: busy, onClick: run(rollback) }, 'Roll back to previous') : null,
          !text.trim() && data.example ? h('button', { style: btn, onClick: () => setText(data.example) }, 'Insert example presets') : null),
        msg ? h('p', { role: 'status', style: { margin: 0, fontSize: 13, color: msg.ok ? 'var(--dsw-alias-label-primary, inherit)' : bad } }, msg.text) : null,
        check ? h(React.Fragment, null, h(Issues, { items: check.errors, color: bad }), h(Issues, { items: check.warnings, color: hint.color })) : null,

        h('div', { style: card },
          h('strong', { style: { fontSize: 14 } }, 'Try it'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('input', { style: { ...input, width: 160 }, value: agent, onChange: (e) => setAgent(e.target.value), 'aria-label': 'agent preset' }),
            h('input', { style: { ...input, width: 240 }, value: cap, onChange: (e) => setCap(e.target.value), 'aria-label': 'capability id', placeholder: 'tool:bash, mcp-tool:github/search_x, skill:swift' }),
            h('button', { style: btn, disabled: busy, onClick: run(explain) }, 'Why?')),
          why ? h('p', { style: { margin: 0, fontSize: 13 } }, why.summary) : null,
          dry ? h('div', { style: { display: 'grid', gap: 6 } },
            h('p', { style: { margin: 0, fontSize: 13 } }, `${dry.counts.allowed} of ${dry.counts.total} tools allowed: ${dry.counts.primary} primary, ${dry.counts.secondary} secondary (model enables), ${dry.counts.tertiary} tertiary (you approve). Estimated schema tokens ${dry.tokens.unrestricted} -> ${dry.tokens.inPrompt} (${dry.tokens.savedPct}% saved).`),
            dry.secondary.length ? h('p', { style: hint }, `Secondary: ${list(dry.secondary)}`) : null,
            dry.tertiary.length ? h('p', { style: hint }, `Tertiary: ${list(dry.tertiary)}`) : null,
            dry.denied.length ? h('p', { style: hint }, `Denied: ${list(dry.denied.map((d) => d.id))}`) : null,
            h(Issues, { items: dry.issues, color: hint.color })) : null),

        h('div', { style: card },
          h('strong', { style: { fontSize: 14 } }, 'Running agents'),
          data.metrics?.length
            ? h(Table, { head: ['Session', 'Preset', 'Primary / secondary / tertiary', 'Enabled now', 'Est. tokens saved', 'Not hideable'], rows: data.metrics.map((m) => [m.agent.slice(-8), m.preset ?? (m.failClosed ? 'blocked' : 'unmanaged'), `${m.tools.tiers.primary} / ${m.tools.tiers.secondary} / ${m.tools.tiers.tertiary}`, m.enabled.length ? m.enabled.map((e) => `${e.id.replace(/^tool:/, '')} (${e.duration})`).join(', ') : '-', `${m.tokens.saved} (${m.tokens.savedPct}%)`, m.leaked.length ? m.leaked.join(', ') : '-']) })
            : h('p', { style: hint }, 'No managed agents are running. Start a session to see it here.')),

        h('div', { style: card },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } }, h('strong', { style: { fontSize: 14 } }, 'Recent decisions'), h('button', { style: btn, disabled: busy, onClick: run(audit) }, 'Refresh')),
          events.length ? h(Table, { head: ['Event', 'Capability', 'Rule'], rows: events.slice(0, 25).map((e) => [e.type, e.capability ?? '', [e.layer, e.rule].filter(Boolean).join(': ')]) }) : h('p', { style: hint }, 'Press Refresh. Arguments are never recorded.')));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'preset-manager', order: 47, label: () => 'Preset Manager' },
          PresetManagerSection));
      },
    };
  },
});
