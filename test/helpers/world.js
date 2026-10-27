// A real dsh ToolRuntime in-process, with agents modelled as scope keys (exactly how the loop addresses them).
// Only the agentPresets service is faked: composedPreset(ctx) -> preset id.
import { dshImport } from './dsh.js';

const { Context } = await dshImport('@deepseek-ai/cordis');
const { ToolRuntime, defineTool } = await dshImport('@deepseek-ai/dsh-tools');
const { createScope } = await dshImport('@deepseek-ai/dsh-scope');
const systemPrompt = await dshImport('@deepseek-ai/dsh-system-prompt');

export async function world() {
  const ctx = new Context();
  ctx.plugin(systemPrompt.default);
  ctx.plugin(ToolRuntime);
  await new Promise((r) => setImmediate(r));
  const T = ctx.get('tools');
  const ran = [];
  const bound = new Map();
  const agentPresets = { composedPreset: (c) => bound.get(c) };

  const tool = (name, params = {}) => defineTool({
    name, description: `tool ${name}`, parameters: params,
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute() { ran.push(name); return `ran ${name}`; },
  });

  const w = {
    ctx, T, ran, agentPresets,
    tool,
    reg: (name, params, c = ctx) => c.get('tools').register(tool(name, params)),
    agent(id, presetId) {
      const agent = { session: { id } };
      const scope = createScope(ctx, agent);
      agent.ctx = scope.ctx;
      if (presetId !== undefined) bound.set(agent.ctx, presetId);
      return agent;
    },
    bind: (agent, presetId) => bound.set(agent.ctx, presetId),
    call: (agent, name, args = {}, extra = {}) => T.execute({ callId: `c${Math.random()}`, name, arguments: args, agent, signal: new AbortController().signal, ...extra }),
    names: (agent) => T.schemas(agent).map((s) => s.name).sort(),
  };
  return w;
}
