import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { McpTools } from '../../src/mcp-tools.js';

const [phase, dataDir] = process.argv.slice(2) as [string, string];
const workspace = join(dataDir, 'project'), task = 'source-chat', id = '57', connectionId = 'proposal-recovery';
const endpoint = 'http://127.0.0.1:65100/fixture';
const mcp = new McpTools(dataDir);
if (phase === 'create') {
  await mkdir(workspace);
  await mcp.proposeConnection(workspace, task, id, { connectionId, endpoint });
  const receipt = await mcp.decideConnectionProposal(workspace, task, id, 'apply');
  console.log(JSON.stringify({ type: 'ready', receipt }));
  await setTimeout(60_000);
} else {
  assert.equal((await mcp.connectionProposals(workspace, task))[0]?.state, 'registered');
  const later = await mcp.configure({ id: connectionId, url: endpoint + '/new-owner-choice', transport: 'http' });
  const receipt = await mcp.decideConnectionProposal(workspace, task, id, 'apply');
  const connections = await mcp.list();
  console.log(JSON.stringify({ receipt, connections: connections.length, currentRevision: connections[0]?.revision, laterRevision: later.revision }));
}
