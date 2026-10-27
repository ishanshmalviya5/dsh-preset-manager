# Limitations

This is a **guardrail on what an agent is given and what it may call**, not a sandbox. dsh's own documentation says
agent presets are not security sandboxes, and this plugin does not change that.

## What is enforced, and where
| Capability | Hidden from the model | Blocked at call time | Notes |
|---|---|---|---|
| Native tool, plugin tool (global or preset scope) | yes | yes | solid |
| MCP tool, MCP server | yes | yes | server parsed from `mcp__<server>__<tool>` |
| Nested calls from `run_code` (PTC) | n/a | yes | each nested call is checked on its own |
| Delegation target | n/a | yes | from the `agent_preset` argument |
| Skill | **no** | yes, when loaded | see below |
| Plugin code (hooks, services, listeners) | no | no | **cannot be isolated** |

## Cannot be isolated
- **A plugin's own code.** Tool filtering cannot stop a plugin's hooks, event listeners or services. Only whether the
  plugin is mounted (the dsh agent-preset composition) controls that, and that is not a boundary against a hostile plugin.
- **`plugin` rules.** dsh does not report which plugin owns a native tool, so `plugins` rules cannot be applied per tool.
- **Tools a plugin registers in an agent's own scope** cannot be hidden (dsh refuses to restrict them). They are still
  blocked at call time and reported as `schema-leak` in the audit log; their schemas cost context.
- **The `run_code` transport** is exempt from the guard because it cannot be restricted; the tools it calls are not.

## Skills
dsh has no per-skill mask. Tiers and denials on skills are enforced when a skill is loaded. A secondary or tertiary
skill's name and description still appear in the skill catalog. User-invoked skills (typed by a person) are not
passed through the tool guard. To remove the whole catalog, deny `tool:skill`.

## MCP naming
dsh gives MCP tools no server metadata. A server whose name contains `__` cannot be told apart, and a tool name that
dsh shortened with a hash will not match tool rules (it fails closed).

## Tertiary approval
dsh's approval prompt is Allow / Deny only (one grant, `allowed-once`). "Session" is the model's proposal shown in the
prompt text. The human-approval path has been exercised against the real tool registry with a fake approval service,
and live only for the unattended (denied) case; it has not been run against dsh's web approval UI.

## Context accounting
Token numbers are estimates (about 4 characters per token). Byte counts in `npm run bench` are exact for the tools
captured. A tool enabled through `discover` changes the prompt prefix, which can invalidate the model's cache from
that point.

## Other
- The Settings page is tested against a fake React and fake fetch, not in a real browser.
- Agents running when a manifest is first created are not governed until their next session.
- A `now` grant is spent by the first completed call that uses it, not by time.
- Preset binding was verified against a faked preset registry and from dsh's source ordering, not against a live
  `standard`/`minimal`/`ptc` session.
- dsh API versions: built and tested against dsh 0.2.1-rc.2. The plugin depends on `ctx.tools.restrict/guard`, the
  `tools/*` events, `agent/created`, `agentPresets.composedPreset` and the approval service; other versions are untested.
