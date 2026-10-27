# Live end-to-end check (isolated profile, mock model)

Proves the plugin inside a booted `dsh`, with no real credentials and nothing leaving the machine.
Everything lives under a temp `DSH_HOME`; never point this at your real `~/.dsh`.

1. `export DSH_HOME=$(mktemp -d)`; create the profile: `dsh --profile hl --from-default-profile headless --dump-config >/dev/null`
2. Overlay (`overlay.yml`) mounting the plugin by entry file (a bare directory is rejected by DSH):
   `- insert: [{ id: dsh-preset-manager, name: <repo>/lib/index.js }]`
3. Manifest at `$DSH_HOME/preset-manager/presets.json`, e.g. a `readonly` preset allowing `read`, `glob`, `grep`, bound with `"agents": {"*": {"preset": "readonly"}}`.
4. Script the model: `[{"tool":"bash","input":{...}},{"tool":"read","input":{"file_path":"..."}}]`, then
   `node test/e2e/mock-llm.mjs <portFile> <logFile> script.json`.
5. Run: `DEEPSEEK_API_KEY=dummy DEEPSEEK_BASE_URL=http://127.0.0.1:<port>/anthropic dsh hl --patch overlay.yml "do the task"`
6. Read `<logFile>` (tools the model was offered, tool results) and `$DSH_HOME/preset-manager/audit.jsonl`.

Control: run step 5 without `--patch` to see the unrestricted tool list.
