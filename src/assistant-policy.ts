import { AgentDoc, defineExtension, hook, section, ToolTask, type ToolRegistration } from '@earendil-works/pi-durable';
import type { AssistantPin } from './assistants.js';
import { isPinnedSkillRead } from './skills.js';
import { localEnvironment } from './execution.js';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import { nativePath } from './remote-policy.js';

const controls = new Set(['task_prepare', 'task_plan', 'task_checkpoint', 'task_status', 'task_submit', 'task_blocked', 'ask_user', 'delegation_ask']);
export const assistantPolicyName = 'local_named_assistant';
function permits(pin: AssistantPin, name: string): boolean {
  if (name === 'task_verify') return pin.tools.includes('bash');
  return controls.has(name) || pin.tools.includes(name);
}

export function assistantTools(tools: readonly ToolRegistration[], pin: AssistantPin, child = false): ToolRegistration[] {
  return tools.filter(tool => (child || tool.name !== 'delegation_ask') && permits(pin, tool.name));
}

export function assistantPolicy(pin: AssistantPin) {
  const fixed = structuredClone(pin);
  return defineExtension({ name: assistantPolicyName, sections: [section('assistant_role', () =>
    `Assistant: ${fixed.name} · revision ${fixed.revision}\n${fixed.instructions}\n\nThe role does not authorize additional work or change the current user's request, confirmation or budget. Its tool scope is fixed for this task; unavailable tools are not permission to substitute another channel.`)],
    hooks: [hook(ToolTask, {
      async beforeTool(call, api, context) {
        if (!permits(fixed, call.name)) return { block: 'This action is outside the task’s fixed assistant tool scope.' };
        if (call.name === 'read' && fixed.skillPins?.pins.length) {
          const agent = await api.snapshot(AgentDoc, api.conversationId, context);
          const path = getOrThrow(await localEnvironment(agent?.cwd ?? '.').absolutePath(nativePath(call.arguments.path as string), context));
          await isPinnedSkillRead(nativePath(path), fixed.skillPins.pins);
        }
        if (!fixed.tools.includes('bash') && call.name === 'task_prepare' &&
          (call.arguments.criteria as { verification?: unknown }[]).some(criterion => criterion.verification !== undefined)) {
          return { block: 'Command verification requires bash in the assistant tool scope; use inspection criteria or select a suitable role.' };
        }
      },
      afterTool(_call, result) {
        const added = result.control?.addTools;
        // Child questions are enabled at child creation; loading must not expose them to the coordinator.
        if (added?.some(name => name === 'delegation_ask' || !permits(fixed, name))) return { ...result, control: {
          ...result.control, addTools: added.filter(name => name !== 'delegation_ask' && permits(fixed, name)),
        } };
      },
    })],
  });
}
