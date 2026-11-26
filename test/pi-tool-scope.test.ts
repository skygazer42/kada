import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, Type } from '@earendil-works/pi-ai';
import { createRegistry, defineExtension, defineTool, Harness, hook, MemoryStorage, ToolTask } from '@earendil-works/pi-durable';

// Pin Pi's actual enablement contract before named assistants rely on it.
for (const mode of ['model-visible-only', 'enabled-tools-only', 'loaded-adds-enabled-tool', 'gate-blocks-nested', 'gate-blocks-loaded']) {
  test('Pi tool scope: ' + mode, async () => {
    let effects = 0; const blocked: string[] = [], offered: string[][] = [];
    const write = defineTool({ name: 'hidden_write', description: 'Synthetic write side effect.', parameters: Type.Object({}), execute: async () => {
      effects++; return { output: [{ type: 'text' as const, text: 'Synthetic write completed.' }] };
    } });
    const bridge = defineTool({ name: 'bridge', description: 'Call hidden_write as a nested tool.', parameters: Type.Object({}), execute: async (_args, api, context) => {
      const nested = await api.executeTool('hidden_write', {}, context);
      return { output: [{ type: 'text' as const, text: JSON.stringify(nested) }], isError: nested.isError };
    } });
    const loader = defineTool({ name: 'load_hidden_write', description: 'Load a registered tool.', parameters: Type.Object({}), execute: async () => ({
      output: [{ type: 'text' as const, text: 'Loaded.' }], control: { addTools: [write.name] },
    }) });
    const isLoading = mode.includes('loaded'), entry = isLoading ? loader : bridge, allowed = new Set([entry.name]);
    const gate = defineExtension({ name: 'fixed_scope_probe', hooks: [hook(ToolTask, { beforeTool(call) {
      if (!allowed.has(call.name)) { blocked.push(call.name); return { block: 'Pinned scope excludes this action.' }; }
    } })] });
    const tools = defineExtension({ name: 'synthetic_actions', tools: [write, bridge, loader] });
    const extensions = [tools, ...(mode.startsWith('gate-') ? [gate] : [])], registry = createRegistry();
    for (const extension of extensions) registry.install(extension);
    const model = { provider: 'scope-probe', modelId: mode }, faux = fauxProvider({ provider: model.provider, models: [{ id: mode }] });
    faux.setResponses(Array.from({ length: 4 }, () => context => {
      offered.push(getCurrentTools(context.messages).map(tool => tool.name));
      const results = context.messages.filter(message => message.role === 'toolResult');
      if (!results.length) return fauxAssistantMessage(fauxToolCall(entry.name, {}), { stopReason: 'toolUse' });
      if (isLoading && !results.some(result => result.toolName === write.name)) return fauxAssistantMessage(fauxToolCall(write.name, {}), { stopReason: 'toolUse' });
      return fauxAssistantMessage('Boundary observed.');
    }));
    const models = createModels(); models.setProvider(faux.provider);
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
    try {
      const root = await harness.root(ctx, { agent: { model, extensions,
        ...(mode === 'enabled-tools-only' || isLoading ? { tools: [entry] } : {}), modelTools: [entry] } });
      const submission = await root.submit({ type: 'input', content: 'Exercise the synthetic boundary once.' }, ctx);
      assert.equal((await submission.wait(ctx)).status, 'done');
      assert.equal(effects, ['model-visible-only', 'loaded-adds-enabled-tool'].includes(mode) ? 1 : 0, mode);
      assert.deepEqual(offered[0], [entry.name]);
      if (isLoading) assert(offered[1].includes(write.name), 'loading changes the native enabled and offered lists');
      if (mode.startsWith('gate-')) assert.deepEqual(blocked, ['hidden_write']);
    } finally { await harness.close(ctx); }
  });
}
