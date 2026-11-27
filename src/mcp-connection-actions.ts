import type { McpTools } from './mcp-tools.js';

export type McpConnectionAction = 'test' | 'enable' | 'disable' | 'approval' | 'login' | 'logout';

export async function runMcpConnectionAction(mcp: McpTools, id: string, action: McpConnectionAction,
  readBody: () => Promise<Record<string, unknown>>, callback: string) {
  if (action === 'test') return mcp.test(id);
  if (action === 'disable') return mcp.disable(id);
  if (action === 'login') return mcp.login(id, callback);
  if (action === 'logout') return mcp.logout(id);
  const { tools, revision } = await readBody();
  if (!Array.isArray(tools) || !tools.every(tool => typeof tool === 'string') || typeof revision !== 'string') {
    throw new Error('Provide the displayed tools with their tested revision.');
  }
  return action === 'approval' ? mcp.setApproval(id, tools, revision) : mcp.enable(id, tools, revision);
}
