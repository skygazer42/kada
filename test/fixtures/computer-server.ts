import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { setTimeout } from "node:timers/promises";

const browser = process.argv.includes("--browser");
const browserSession = browser ? process.env.AGENT_BROWSER_SESSION : undefined;
const server = new Server({ name: browser ? "kada-agent-browser-cli" : "simulated-desktop", version: "1.0.0" }, {
  capabilities: { tools: {} }, ...(browserSession ? { instructions: JSON.stringify({ browserSession }) } : {}),
});
const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l4cAAAAASUVORK5CYII=" };
let active = 0;
const actions: unknown[] = [];
let snapshots = 0, screenshots = 0;
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: browser ? [
  { name: "agent_browser_snapshot", inputSchema: { type: "object", properties: { interactive: { type: "boolean" }, fail: { type: "boolean" } } }, annotations: { readOnlyHint: true } },
  { name: "agent_browser_screenshot", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "agent_browser_click", inputSchema: { type: "object", properties: {} } },
] : [
  { name: "desktop_action", description: "Simulated action for integration tests.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "screen", description: "Simulated screenshot for integration tests.", inputSchema: { type: "object", properties: {} } },
] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  active++;
  const atStart = active;
  try {
    await setTimeout(40);
    if (browser) {
      const name = request.params.name;
      if (name === "agent_browser_snapshot") {
        if (request.params.arguments?.fail) return { isError: true, content: [{ type: "text", text: "snapshot error " + "!".repeat(2_000) }] };
        const text = request.params.arguments?.interactive === false ? "full snapshot " + ".".repeat(2_000) :
          ++snapshots === 1 ? "first snapshot " + ".".repeat(2_000) : `snapshot ${snapshots}`;
        return { content: [{ type: "text", text: process.argv.includes("--named") ? text + " fixture session " + browserSession : text }] };
      }
      if (name === "agent_browser_screenshot") return { content: [{ type: "text", text: `screenshot receipt ${++screenshots}` }, image] };
      return { content: [{ type: "text", text: "clicked " + "+".repeat(2_000) }] };
    }
    if (request.params.name === "screen") return { content: [
      image,
      { type: "text", text: JSON.stringify(actions) },
    ] };
    const text = request.params.arguments?.text;
    actions.push(text);
    return { ...(text === "partial error" ? { isError: true } : {}),
      content: [{ type: "text", text: JSON.stringify({ atStart, text }) }] };
  } finally { active--; }
});
await server.connect(new StdioServerTransport());
