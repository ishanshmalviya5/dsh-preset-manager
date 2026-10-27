# Install, migration and rollback

## Before you start
Nothing changes until `~/.dsh/preset-manager/presets.json` exists and is valid. Installing the plugin alone is inert.

## Adopt gradually
1. Install the plugin (see README).
2. `dpm init --example` (or Settings → Preset Manager → Insert example presets) and read it.
3. Bind **one** agent preset first: `dpm preset activate coder --agent standard`. Everything else stays unrestricted
   (no `"*"` binding, `defaults.strict` false).
4. Check what the preset does before trusting it: `dpm agent capabilities standard --catalog bench/catalog.json`
   or the page's Dry run. Unmatched-rule warnings usually mean a typo or a tool that is not registered.
5. Start a new session. Agents already running when a manifest is first created are not governed until their next
   session; agents the plugin already manages follow edits live.
6. Widen with `secondary` and `tertiary` instead of adding to `primary` when a tool is only sometimes needed.

## Roll back
- Last change: **Roll back to previous** on the page, or `dpm rollback`. One level is kept (`presets.json.prev`).
- Stop all enforcement: delete or rename `presets.json` and restart dsh. (A running dsh keeps its last valid policy
  if the file disappears or becomes invalid; it never falls open on a bad edit.)
- Unrestricted agent, one preset only: remove its entry from `agents`.

## Uninstall
Remove the plugin from the profile (`dsh plugin --profile web remove dsh-preset-manager`, or Unlink in
dsh-local-plugins). `~/.dsh/preset-manager/` (manifest, `.prev`, `audit.jsonl`) is left in place; delete it if you
no longer need it.

## Files the plugin writes
`~/.dsh/preset-manager/presets.json` and `.prev` (mode 0600), `audit.jsonl` (mode 0600; tool names, rules and argument
*keys* only, never values). Nothing else.

## Failure behaviour
| Situation | Result |
|---|---|
| No manifest | plugin inactive; nothing hidden or blocked |
| Invalid manifest at startup | inactive, error logged; with plugin config `failClosedOnInvalid: true`, every agent is blocked |
| Invalid edit while running | previous policy kept; the reason is in `audit.jsonl` and the page |
| Policy cannot be resolved for an agent | that agent fails closed (only `host_critical` allowed) |
| Saving fails after applying | the live policy is put back, so memory and disk agree |
