import { createServer } from 'node:http';

export async function startMcpProposalService() {
  const methods: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    methods.push(request.method);
    if (request.id === undefined) { res.writeHead(202).end(); return; }
    const results: Record<string, unknown> = {
      initialize: { protocolVersion: request.params?.protocolVersion, serverInfo: { name: 'proposal-fixture', version: '1' }, capabilities: { tools: {} } },
      'tools/list': { tools: [{ name: 'status', description: 'Read sample status.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: 'unselected', description: 'Unselected test tool.', inputSchema: { type: 'object' } }] },
      'tools/call': { content: [{ type: 'text', text: 'PROPOSAL_TOOL_RESULT' }] },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: results[request.method] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { methods, address: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
    async close() { await new Promise<void>(resolve => server.close(() => resolve())); } };
}
