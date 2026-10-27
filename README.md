# dsh-preset-manager

Per-agent control over which tools, MCP servers, skills and delegation targets a dsh agent can use, so the model is
sent fewer tool schemas (fewer input tokens) and cannot run what it was not given.

It layers a **capability policy** on dsh's existing agent presets (`standard`, `minimal`, `ptc`, creator, custom ones
such as `junior-dev`). It does not replace them: a capability preset is bound to a dsh agent preset by id.

## Three tiers

| Tier | In the prompt | How it becomes usable |
|---|---|---|
| **primary** | yes | always |
| **secondary** | no | the model calls the built-in `discover` tool and enables it itself: `now` (one use) or `session` |
| **tertiary** | no | the model calls `discover`; dsh's approval prompt asks you (Allow / Deny). With nobody to ask (headless, scheduled) it is denied and logged |

`discover` (and a short `discovery` skill) are added to every managed preset automatically and cannot be removed by
an allowlist. Anything not listed in a preset is **denied**: hidden from the schema and blocked at call time.

## Configure

The manifest is `~/.dsh/preset-manager/presets.json` (`$DSH_HOME` overrides `~/.dsh`). Edit it in
**Settings → Preset Manager**, or with the `dpm` CLI, or by hand; edits apply to running agents.

```json
{
  "version": 1,
  "admin": { "host_critical": ["tool:working_directory"] },
  "aliases": { "read_only": ["read", "glob", "grep"] },
  "presets": {
    "coder": {
      "description": "Software development",
      "tools": { "primary": ["@read_only", "write", "edit", "bash"], "secondary": ["web_*"], "tertiary": ["job_kill"] },
      "mcp": { "servers": { "allow": ["github"] }, "tools": { "primary": ["github/get_*"], "secondary": ["github/search_*"] } },
      "skills": { "allow": ["*"] },
      "subagents": { "allow": ["reviewer"] }
    }
  },
  "agents": { "standard": { "preset": "coder" }, "*": { "preset": "coder" } }
}
```

- Sections: `tools`, `mcp.servers`, `mcp.tools`, `skills`, `subagents`, `plugins`. Each takes `primary` (alias
  `allow`), `secondary`, `tertiary`, `deny`, `except` and an optional `mode` (`allowlist` | `denylist`).
- Listing a capability in any tier list allows it. If several match, the most restrictive tier wins, also across
  `extends` (a child preset can only narrow its parent).
- Capability ids: `tool:bash`, `mcp-tool:github/search_code` (the model sees `mcp__github__search_code`),
  `skill:swift`, `subagent:reviewer`. Patterns use `*` and `?`.
- `agents` keys are dsh agent-preset ids; `"*"` is the fallback. An agent with no binding is unrestricted unless
  `defaults.strict` is true, which blocks it (except `admin.host_critical`).
- Defaults: `unknown_capability: deny`, `dynamic_registration: deny` (tools registered after an agent starts stay
  blocked), `inheritance: restrictive`. Session overrides can only narrow.
- Five ready-made presets (planner, coder, researcher, reviewer, automation) are in `examples/presets.json`.

## CLI

```
dpm init --example                     dpm capability explain <agent> tool:bash
dpm preset list | show | validate      dpm capability test <agent> tool:bash      # exit 0 allowed, 1 denied
dpm preset diff coder reviewer         dpm agent capabilities <agent> --catalog bench/catalog.json
dpm preset create | clone | activate   dpm rollback
```

Writes are validated and atomic; one previous version is kept for `rollback`.

## Install

Needs Node 26+ and dsh 0.2.x. The plugin is a normal dsh plugin package (`cordis.patch.yml`, `dsh.client`):

```
dsh plugin --profile web add github:<owner>/dsh-preset-manager
```

or **+ Add** in the dsh-local-plugins settings page with the same `github:<owner>/dsh-preset-manager`. Until a
manifest exists the plugin does nothing. See [docs/migration.md](docs/migration.md) to start, roll back and remove.

## Measured effect

`npm run bench` (real dsh tool schemas, `bench/catalog.json`): 25 tools, 19,629 bytes unrestricted; the bundled
`coder` preset sends 11,035 bytes (-43.8%) and `reviewer` 4,453 bytes (-77.3%), **including** the `discover` tool's
own 1,331 bytes. A live run with a three-tool preset sent 1,900 bytes instead of 19,629. Token figures are estimates
(about 4 characters per token).

## Tests

`npm test` (136 tests). The suite runs against the real dsh tool registry installed on the machine
(`DSH_PKG_DIR`, else `npm root -g`). `test/e2e/README.md` shows a live run with a mock model. Read
[docs/limitations.md](docs/limitations.md) before relying on this as a security boundary.
