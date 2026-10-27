// Host entry. Policy is attached per agent as it is created; with no manifest the plugin does nothing.
// `discover` (and its skill) exist only while a manifest is active. The Settings page backend is mounted only when
// the profile has a web server (headless has none).
import { createManager } from './manager.js';
import { defaultManifestFile } from './store.js';
import { watchManifest } from './watch.js';
import { estimateTokens } from './adapter/names.js';
import { createDiscovery, discoverySkill } from './adapter/discover.js';
import { API, createActions, createHandler } from './settings-api.js';

export const name = 'dsh-preset-manager';
export const inject = ['tools']; // agentPresets, skills, webServer and connection are optional: not every profile has them

export function apply(ctx, config = {}) {
  const file = config.manifest ?? defaultManifestFile();
  const agentPresets = { composedPreset: (c) => ctx.get('agentPresets')?.composedPreset(c) };
  const globalTools = () => ctx.get('tools').schemas().map((s) => ({ name: s.name, tokens: estimateTokens(s) }));

  let discovery;
  let unregisterTool;
  let unregisterSkill;
  let skills; // set while the skills service exists

  const syncSkill = () => {
    if (skills && manager.active && !unregisterSkill) unregisterSkill = skills.register(discoverySkill);
  };
  const activate = () => {
    if (!unregisterTool) unregisterTool = ctx.get('tools').register(discovery.tool);
    syncSkill();
  };

  const manager = createManager({ agentPresets, globalTools, file, failClosedOnInvalid: config.failClosedOnInvalid === true, auditAllowed: config.auditAllowed === true, onActive: () => activate(), logger: ctx.logger });
  const listSkills = async (agent) => ctx.get('skills')?.list({ scope: agent }) ?? [];
  discovery = createDiscovery({ enforcer: manager.enforcer, audit: manager.audit, listSkills });
  manager.announce(); // active from the start (valid manifest on disk): register discover now

  ctx.on('agent/created', ({ agent }) => { manager.onAgentCreated(agent); });
  ctx.on('agent/disposed', ({ agent }) => { manager.onAgentDisposed(agent); });
  ctx.on('tools/change', () => { manager.onToolsChange(); });
  ctx.on('tools/pre-execute', (exec, next) => discovery.preExecute(exec, next));
  ctx.on('tools/result', (exec, result) => { discovery.onResult(exec, result); });

  ctx.effect(() => () => { unregisterTool?.(); unregisterTool = undefined; unregisterSkill?.(); unregisterSkill = undefined; }, 'dsh-preset-manager: discover tool and skill');

  ctx.inject(['skills'], (c) => {
    skills = c.skills;
    syncSkill();
    c.effect(() => () => { unregisterSkill?.(); unregisterSkill = undefined; skills = undefined; }, 'dsh-preset-manager: skills link');
  });

  ctx.effect(() => watchManifest(file, () => {
    const result = manager.reloadFromDisk();
    if (!result.ok && !result.missing) ctx.logger.warn?.(`preset-manager: reload failed, keeping previous policy: ${result.errors[0]?.message}`);
  }, { logger: ctx.logger }), 'dsh-preset-manager: manifest watcher');

  ctx.inject(['webServer', 'connection'], (c) => {
    c.effect(() => c.webServer.register({ kind: 'prefix', path: API, handler: createHandler(createActions(manager), c.connection) }), 'dsh-preset-manager: settings api');
  });

  return manager;
}
