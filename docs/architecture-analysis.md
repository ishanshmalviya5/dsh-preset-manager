# DSH Capability Manager — architecture analysis (pre-implementation)

Target: `@deepseek-ai/dsh@0.2.1-rc.2` (global install, read-only inspection). No code has been written.
Evidence labels: **[types]** read in installed `.d.ts`, **[src]** read in installed `lib/index.js`, **[readme]** package README only, **[unverified]** must be proven by a test before we rely on it.

## 1. Verified enforcement hooks

| Hook | What it does | Evidence |
|---|---|---|
| `ctx.tools.restrict({allow?, deny?})` | Per-agent mask over *inherited* (global + ancestor) tools. Exact names only. **Throws** on empty filter, unknown name, scope-local name, reserved transport name. Restrictions intersect. Returns disposer. | [types] dsh-tools `index.d.ts:508-513, 638-645` |
| Restriction exemption | A restriction never filters the scope's **own** registrations (a plugin registering into the agent scope bypasses `restrict`). | [types] `index.d.ts:666-672` |
| `ctx.tools.guard(fn)` | Sync, deny-only, runs after `tools/pre-execute`, before tool body. Global (plain ctx) or per-agent (`agent.ctx`). No listener can undo a denial. | [types] `:514-522, 646-656`; [src] `dsh-tools/lib/index.js:3337` (central execute path) |
| `tools/pre-execute`, `tools/execute`, `tools/post-execute`, `tools/result` | Allow/deny/ask waterfall, wrap, inspect, observe. Scope-filtered by `exec.agent`. | [types] `:47-92` |
| `tools/change` | Unfiltered event: tool registered/unregistered or restriction changed. | [types] `:94-104` |
| `agent/created` | Serial, scope-filtered; payload has live `agent` (with `agent.ctx`). Correct place to attach per-agent policy. | [types] dsh-agent `runtime-types.d.ts:227-238` |
| `ctx.tools.schemas(scope)` / `get(name, scope)` | Exactly what the model sees / can execute for a scope. Basis for context-cost measurement. | [types] `:691, 712` |
| Subagent `toolFilter` | Child gets `childCtx.tools.restrict(composition.toolFilter)`. | [src] `dsh-subagent/lib/index.js:395` |
| Subagent `agentPreset` / `allowedAgentPresets` | Native allowlist of which presets a delegation tool may select. | [types] dsh-tool-subagent `preset-selection.d.ts` |
| PTC | In `ptc` mode, model-direct calls to anything but `run_code` → `UNKNOWN_TOOL`; nested SDK calls resolve through the same visibility view. | [readme] dsh-tools, [types] `:693-705` |
| MCP tools | Registered as ordinary tools `mcp__<server>__<tool>`; `serverName` namespaced per registration scope. Connection exists only if the plugin row is mounted. | [readme] dsh-mcp-client |

## 2. Existing overlap we must not duplicate

- `dsh-agent-preset` / `dsh-agent-preset-registry`: a preset is a **list of child plugins** per Agent (Cordis YAML), selected per session; live agents keep their composition, new agents pick up edits. It does **not** carry tool/skill/MCP-tool allowlists, wildcards, inheritance, audit or metrics. [readme]
- `dsh-agent-tool-presentation`: per-agent native vs PTC.
- `dsh-permission-presets`: sandbox mode + approval policy; unrelated to capability visibility.
- Registry README states: *"Presets are not security sandboxes: YAML and plugins can execute Host code."* Our limitations doc must inherit this.

Consequence: our "Agentic Preset" should be a **policy layer keyed to existing agent-preset ids**, not a replacement registry. Plugin-level and MCP-server-level *activation* is done by the existing agent-preset composition (that is the only real way to avoid connecting an MCP server); we validate and document it, we do not reimplement it.

## 3. Gaps found

1. **No wildcard support** in `restrict`, and unknown names throw → the plugin must expand wildcards against the live catalog, drop names not yet registered, and re-resolve on every `tools/change` (swap: register new restriction, then dispose old; intersection makes the overlap strictly tighter, never looser).
2. **Allowlist is naturally fail-closed for late registration** (non-listed tools stay hidden); **denylist is not** — a late-registered tool is visible until re-resolved. Strict mode therefore must default to allowlist semantics and add a `guard` fallback.
3. **Scope-local registrations bypass `restrict`** → every capability decision must be duplicated in an agent-scoped `guard` (name-based). Guard is the authoritative layer; `restrict` is the context-saving layer.
4. **Skills have no per-agent mask** in `ctx.skills` types (no allow/deny; only layered providers + scope). [types] Options: (a) guard the `skill` tool by `exec.arguments.name`; (b) mount only permitted skill providers in the agent-preset composition; (c) both. Skill *catalog text in the prompt* is not filterable by (a) alone — **[unverified]** how the catalog reaches the prompt; needs a source read of `dsh-tool-skill`/`dsh-skill` before promising "denied skill instructions never enter the prompt".
5. **Guard cannot see/modify arguments for rewrite** (`pre-execute` cannot rewrite args by design). Fine for allow/deny.
6. **Plugin code is unrestricted Host code.** Tool filtering cannot isolate a plugin's hooks, event listeners or services. Only activation (plugin rows in the profile / agent preset) controls it, and that is not a security boundary against a hostile plugin.

## 4. Spike results (test/spike/registry.spike.test.js, 14/14 pass against the real ToolRuntime)

Resolved by test, not by reading:
- **U1 resolved.** A nested dispatch carrying a `parent` token is denied by `guard`; body never runs. Source agrees: PTC sub-calls go through `prepareExecution` (`dsh-tools/lib/index.js:1375,1431,3337`).
- **U2 resolved (registry level).** A parent scope's `restrict` and `guard` both bind child scopes (scope chain). A child's own guard cannot lift the parent's denial; siblings are unaffected. Caveat: this holds when the child scope is parented under the delegating scope. In the real host `bindScopeParent` is only called by `dsh-agent-preset-registry` (preset generation scope -> agent key), so what binds a delegated child is the **preset scope**, not the parent agent. Policy must therefore be attached at the preset-scope level (and per agent), and tested end to end with real subagent spawn later.
- `restrict` throws on unknown names and empty filters; disposing restores visibility; registering the new restriction before disposing the old gives the intersection in between (never looser) — this is the atomic swap.
- Late registration: allowlisted agent never sees it; denylisted agent does (`['a','late']`) until re-resolved.
- Scope-local registration stays visible despite `allow`.
- Hidden tool call -> `UNKNOWN_TOOL`; guard denial -> `Error: <reason>`; bodies never run in either case.
- `tools/change` fires on register and restrict.
- Harness notes: mount `dsh-system-prompt` then `dsh-tools`; access via `ctx.get('tools')`; install path resolved at runtime (`DSH_PKG_DIR` or `npm root -g`).

U3 answered from source (`dsh-tool-skill/lib/index.js`): the catalog is built in `agent/pre-step` from `ctx.skills.snapshot({scope})` **only if** `ctx.tools.get('skill', agent)` is visible. So restricting the `skill` tool removes catalog and bodies together (all-or-nothing, proven path). Per-skill hiding has no mask: `guard` on `skill` by `arguments.name` blocks body loading but the name/description stays in the catalog, and user-invoked skills (`skill-invocation` injection in `agent/pre-step`) never pass through `guard`. Per-skill context savings need a preset-level skill-provider mount or a catalog filter; treated as a known weak spot until proven.

U4/U5 answered from sibling plugins: config lives in `~/.dsh/<plugin>/config.json` written atomically (tmp + rename, mode 0600) with `DSH_HOME` override; slash commands via `dsh-commands` `CommandRuntime.register`; CLI as a plain Node bin (junior-dev ships `bin/`). Node >= 26, `node --test`, no runtime deps. Config format will be JSON (no js-yaml dependency from the plugin); a YAML import can come later.

Still open:
- Real end-to-end: policy attached to the `agent-preset` scope of `standard`/`minimal`/`ptc`/creator/`junior-dev` and observed through a real child spawn.

U6 closed: not needed. Subagents are always composed from an existing preset (`dsh-subagent/lib/index.js` `applyChildComposition`): an explicit `agentPreset` is mounted on the child, otherwise `composeFrom(childCtx, parent.ctx)` reuses the parent's composition. Policy keyed by preset id therefore covers children with no delegation-time injection. A child's optional `toolFilter` can only narrow (restrictions intersect).

## 4b. Layering on existing presets

An Agentic Preset is a policy record keyed by an existing agent-preset id (`standard`, `minimal`, `ptc`, creator, custom such as `junior-dev`). It never copies or replaces the child-plugin list. Presets cannot extend each other in DSH (junior-dev copies `standard`), so policy `extends` lives in our layer only.

## 4c. Seam for the future discovery tool (out of scope this session)

Goal is fewer input tokens: expose a small visible set and let the model discover the rest on demand. The policy engine will therefore classify every capability into three states per agent: **denied**, **visible** (schema in prompt), **discoverable** (allowed, not in prompt). The resolver and catalog will expose `discoverable(agent)` with concise metadata (id, one-line description, owner), and the metrics will count discoverable separately. `defineTool` already supports `deferLoading: true`. A later discovery tool only has to read that set and, on request, widen visibility within what policy allows; it can never exceed the allowed set because `guard` stays authoritative. No discovery tool is built now.

- U2: `agent.ctx.tools.guard` on a parent does **not** propagate to a child agent (and what the child's scope chain inherits). Needed for "child must not gain capabilities from parent" and for "parent restrictions bind children".
- U3: Skill prompt-catalog path (gap 4).
- U4: How a plugin adds CLI commands. `dsh` uses `commander`; we have not located a plugin-facing command API. Candidates: `dsh-commands`/`dsh-cmdline` (slash commands), or a plain Node bin shipped by the plugin.
- U5: Config precedence/runtime update mechanism for plugin config (`dsh-settings`, `dsh-config-editor`, Loader HMR) and where a plugin should keep `presets.yaml`.

## 5. Capability and enforcement matrix (provisional; skill row updated)

| Capability | Hide from model | Invocation-time deny | Avoid init | Notes |
|---|---|---|---|---|
| Native tool | `restrict` | `guard` | n/a (already loaded) | solid |
| Plugin-registered global tool | `restrict` | `guard` | plugin mount in agent-preset | solid for the tool, not for the plugin's other code |
| Plugin scope-local tool | **not hideable** by `restrict` | `guard` only | mount | schema still costs context [unverified how to hide] |
| MCP server | restrict all `mcp__srv__*` | `guard` | agent-preset mount (only true way) | per-agent isolation of namespace confirmed [readme] |
| MCP tool | `restrict` | `guard` | n/a | |
| Skill | unverified (U3) | `guard` on `skill` tool | provider mount | weakest area |
| Subagent / delegation target | existing `allowedAgentPresets` | same, plus `guard` on spawn tool | n/a | child tool set via `toolFilter` |
| Non-tool plugin hooks/services | no | no | mount only | **cannot be isolated** |

## 6. Proposed implementation plan

Packaging follows the sibling plugins (`dsh-jenkins-manager`): plain ESM JS, `index.js` exporting `name` + `inject`, `cordis.patch.yml`, `node --test`, no new runtime dependencies. TypeScript only if you want types generated from JSDoc; the ecosystem here does not require it.

1. **Spike (tests only)**: (done: U1, U2 and the `restrict` throw/intersect/late-registration behaviours proven against the real registry, 14/14).
2. **Policy engine (pure, no DSH imports)**: schema + validation, matcher (exact/glob/alias), resolver (intersection; admin > agent > parent > preset > session > defaults), explain/dry-run, dependency + conflict detection. 100% unit-testable.
3. **Catalog**: normalize `ctx.tools.schemas()`, MCP name parsing, skills list, subagent presets; owner = plugin/server where derivable.
4. **Enforcement adapter**: on `agent/created` → resolve policy → `restrict` (expanded) + agent-scoped `guard`; re-resolve on `tools/change`; atomic swap on preset change; strict mode = fail closed with a host-critical allowlist.
5. **Optimizer/metrics**: token estimates from `schemas(scope)` vs unrestricted, per-agent snapshot; skill tokens once U3 is resolved.
6. **Audit logger** (redacting; never log arguments, only names + arg keys).
7. **CLI/config**: after U4/U5. Commands as listed in the brief, adapted.
8. Examples, benchmark, install/migration/rollback, limitations doc.

Out of scope unless you say otherwise: web UI, any claim of a hard boundary for plugin code.

## 7. Adapter findings (built; 67/67 tests against the real ToolRuntime)

Proven while building `lib/adapter/`:
- **Preset-plugin tools can be hidden.** A tool registered in an ancestor (preset) scope is nameable by `restrict` and disappears from the agent's schema. A tool registered in the **agent's own scope** cannot (`restrict` throws `names unknown global tool`) and stays visible; only `guard` denies it. The adapter reports these as `schema-leak` audit events and `metrics().leaked`.
- **`restrict` error is parseable** (`unknown global tool "<name>"`), so the adapter prunes unregistered/own-scope names and retries.
- **Deny-form restriction** is used for hiding (an allow-form one cannot admit late tools). New names appear in `schemas(agent)` and are classified in the same synchronous tick as the `tools/change` that announced them; `guard` covers the gap and enforces `dynamic_registration`.
- **`recompose()` emits `tools/change`** after mounting the new preset, so a blank agent switching presets re-resolves policy through the same refresh path.
- **MCP names carry no server metadata**: server/tool are recovered by splitting `mcp__<server>__<tool>` at the first `__`. A server name containing `__`, or a tool name DSH shortened with a hash, cannot be matched (fails closed).
- **Plugin-level rules are not enforceable per tool**: the registry does not say which plugin owns a native tool. Plugin activation is controlled by the agent-preset composition, not by this plugin.
- **`run_code` (PTC transport) is exempt from the guard** because it cannot be restricted; every nested call goes through the guard individually (proven).
- Plugins import no DSH packages: services come through `inject`, the entry is `export const name / inject / apply(ctx)`, state in `~/.dsh/<plugin>/`.

Not yet verified on a booted dsh: that `agent/created` / `agent/disposed` / `tools/change` reach `apply()` in the live host, and a real model call at a denied tool. Needs an isolated `DSH_HOME` profile (`--from-default-profile`, `--patch`) and model credentials or a mock LLM.

## 8. Live verification (booted `dsh 0.2.1-rc.2`, isolated `DSH_HOME`, local mock model)

Setup: headless profile + the plugin via `--patch` overlay, manifest binding every agent (`"*"`) to a `readonly` preset (`read`, `glob`, `grep`), a local mock of the Anthropic Messages API (`test/e2e/mock-llm.mjs`), dummy API key. See `test/e2e/README.md`.

| | Without plugin (control) | With plugin |
|---|---|---|
| Tools offered to the model | 25 | 3 (`glob`, `grep`, `read`) |
| Tool schema bytes on the wire | 19,629 | 1,900 (-90.3%) |
| Plugin's own estimate | | 4,897 -> 474 tokens (-90.3%) |
| Model calls `bash` | host sandbox refuses (no backend in this environment) | `Error: tool:bash is not permitted for this agent (preset:readonly: not-in-allowlist)`; audit `invocation-denied`, argument keys only |
| Model calls `read` | runs | runs, file contents returned |

Honest limits of this evidence: the control's `bash` was also blocked, by this machine's missing sandbox backend, so a missing side-effect file does not by itself discriminate. The denial is attributed to the plugin by its error text and audit event; that the tool body never runs after a guard denial is asserted by the registry-level tests.

Bugs the live run found (both fixed, both now covered by tests):
1. Headless has no `agentPresets` service, so `inject: ['tools','agentPresets']` left the plugin inactive. `agentPresets` is now looked up lazily; a `"*"` fallback agent binding was added for agents with no preset.
2. An asynchronous `EMFILE` from the manifest `fs.watch` was an uncaught exception that killed the host. The watcher now handles `error` and degrades to no auto-reload (`lib/watch.js`).
Also learned: DSH rejects a bare directory as a plugin `name`; a local path must name the entry file.

Ordering verified from source (not live): the session controller's `composeAgent` setup callback awaits `agentPresets.mount(agentCtx, id)` as pre-publication setup, and `agent/created` is announced afterwards, so `composedPreset(agent.ctx)` is already set when our listener runs. A throwing `agent/created` listener rejects agent creation, so the manager audits and swallows attach failures unless `failClosedOnInvalid` is set.

Why no live preset-registry run: the web profile's `/api` is a generated, authenticated peer protocol, and the SDK JSON-RPC protocol has no preset parameter (a session is created implicitly by `session/prompt`). Selecting `minimal`/`standard` live needs the Web UI or a typert client; neither was scriptable here without reverse-engineering the wire format.

Not yet verified live: a profile that has the preset registry (`standard`/`minimal`/`ptc`/creator/`junior-dev`), so `composedPreset()` binding, and a subagent spawn, are covered only by registry-level tests with a faked `agentPresets`.

## 9. Tiers, `discover`, and the Settings page

**Tiers.** Each manifest section (`tools`, `mcp.servers`, `mcp.tools`, `skills`, `subagents`, `plugins`) takes `primary`, `secondary`, `tertiary` lists (plus `allow` = primary, `deny`, `except`). Listing a capability in any tier list allows it; a capability matched by several takes the most restrictive tier, across patterns and across layers (a child preset cannot make a parent's tertiary tool easier to reach).

| Tier | In the prompt | How it becomes usable |
|---|---|---|
| primary | yes | always |
| secondary | no | the model calls `discover` and enables it itself, `duration: now` (one use) or `session` |
| tertiary | no | the model calls `discover`; DSH's approval prompt asks the human (Allow/Deny). The model proposes the duration; it is in the prompt text. No approval channel (headless, scheduled) means denied and logged |

**Built in to every managed preset:** `tool:discover` and `skill:discovery` are exempt from every allowlist (and are *not* exempt in fail-closed mode). They exist only while a manifest is active.

**Why approval is allow/deny only:** DSH's `ApprovalOutcome` has a single grant, `allowed-once`; there is no session-scoped grant in the prompt. "Session" is therefore the model's proposal, shown to the human in the prompt text, which the human allows or denies as a whole.

**Safety properties (each has a test):** a tertiary grant needs proof that DSH's prompt allowed that exact call; the tool body refuses without the ask recorded by `tools/pre-execute`, and `enforcer.enable` independently refuses tertiary grants without the proof flag. Denied and non-existent names return the same message. Prompt text from the model has whitespace collapsed and is length-capped. Grants are per agent, revoked when a policy change makes the capability denied, primary or stricter, and cleared on a preset switch. Nested PTC calls obey tiers through the same guard.

**Settings page.** `client.js` registers a `settings.section` ("Preset Manager"): manifest editor, agent bindings, validate, dry run (tier counts and token estimate), "why is X denied", save and apply to running agents, one-level rollback, running agents with active grants, recent decisions. Backend: `POST /preset-manager-api/<action>` behind dsh's own request check. The editor text is the single source of truth.

**Live evidence (booted `dsh`, mock model, isolated `DSH_HOME`).** With `primary: [read, glob, grep]`, `secondary: [web_fetch, read_image]`, `tertiary: [bash]`: round 0 offered `discover, glob, grep, read`; `discover search` listed the hidden tools; after enabling `web_fetch` (session) the next round offered it; a direct `bash` call was refused with the approval hint; `discover enable bash` failed with "no approval channel is available" and was audited as `approval-requested` then `approval-denied`; no side effect occurred. Estimated schema tokens 5230 -> 807 at start. A final `tools/change` during shutdown showed `web_fetch` gone because `dsh-tool-web` unregisters its tools when plugins are disposed; that is DSH teardown, now pinned by a test.

**Limits.**
- **Skills:** tiers are enforced when a skill is loaded (guard on the `skill` tool). DSH has no per-skill mask, so a secondary or tertiary skill's name and description still appear in the skill catalog.
- The browser page is tested against a fake React and fake fetch, not in a real browser; layout and styling are unverified.
- A tertiary approval cannot be exercised live without a DSH approval answerer (the web UI). Only the unattended path was run live; the allow and reject paths are covered against the real registry with a fake `approval` service.
- Agents already running when a manifest is first created are not governed until their next session; agents attached earlier follow edits live.
- A "now" grant is spent by the first call that completes using it, not by time.
