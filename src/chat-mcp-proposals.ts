import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import type { McpConnectionProposal, McpConnectionProposalInput, McpProjectToolProposal, ProjectMcpTool } from './mcp-tools.js';

export function chatMcpProposals(options: {
  propose: (id: string, input: McpConnectionProposalInput) => Promise<McpConnectionProposal>;
  select: (id: string, tools: ProjectMcpTool[] | null) => Promise<McpProjectToolProposal>;
  catalog: () => Promise<unknown>;
}) {
  const output = (data: unknown) => ({ output: [{ type: 'text' as const, text: JSON.stringify(data) }] });
  const connectionId = Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,31}$' });
  return defineExtension({ name: 'local_mcp_proposals', tools: [defineTool({
    name: 'propose_mcp_connection',
    description: 'Propose registering an MCP connection when the user asks and provides the exact endpoint. Use http for Streamable HTTP or sse when the user specifies a legacy SSE server. The owner reviews the proposed endpoint and uses MCP settings to test and select tools.',
    parameters: Type.Object({ connectionId,
      endpoint: Type.String({ minLength: 1, maxLength: 2048 }), transport: Type.Optional(Type.Union([Type.Literal('http'), Type.Literal('sse')])) }, { additionalProperties: false }),
    replay: 'safe', executionMode: 'sequential',
    execute: async (input, api) => {
      if (api.conversationId !== ROOT_CONVERSATION_ID) throw new Error('Only the local main conversation can propose a connection.');
      return output(await options.propose(String(api.taskId), input));
    },
  }), defineTool({
    name: 'mcp_settings_catalog', description: 'Read the enabled MCP connections and their exact tool names, plus the current project tool selection. This lookup does not enable tools.',
    parameters: Type.Object({}, { additionalProperties: false }), replay: 'safe',
    execute: async (_input, api) => {
      if (api.conversationId !== ROOT_CONVERSATION_ID) throw new Error('Only the local main conversation can inspect MCP settings.');
      return output(await options.catalog());
    },
  }), defineTool({
    name: 'propose_project_mcp_tools', description: 'Propose the project MCP tool selection when the user asks to change it. Use exact IDs and tool names from mcp_settings_catalog. An empty array allows no tools, and null inherits the global tool selection. The owner reviews the entire requested selection before applying it to future tasks.',
    parameters: Type.Object({ tools: Type.Union([Type.Array(Type.Object({ id: connectionId, tool: Type.String({ minLength: 1 }) }, { additionalProperties: false })), Type.Null()]) },
      { additionalProperties: false }), replay: 'safe', executionMode: 'sequential',
    execute: async ({ tools }, api) => {
      if (api.conversationId !== ROOT_CONVERSATION_ID) throw new Error('Only the local main conversation can propose project tool settings.');
      return output(await options.select(String(api.taskId), tools));
    },
  })] });
}
