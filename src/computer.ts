import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { ComputerConfig } from "./config.js";
import { SerialQueue } from "./util.js";
import { VERSION } from "./version.js";

/** A thin MCP adapter and one local desktop lease. The driver owns all UI automation. */
export class ComputerBridge {
  private client?: Client;
  private queue = new SerialQueue();
  private handoff = new SerialQueue();
  private tools: Tool[] = [];
  private resources: { uri: string; name: string }[] = [];
  private config?: ComputerConfig;
  private lease?: { owner: string; expiresAt: number; observed: boolean };
  private mode: "agent" | "user" = "agent";
  private generation = 0;
  private ready = false;
  private takingOver = false;
  private activeTool?: string;
  private uncertain = false;
  async connect(config: ComputerConfig): Promise<Extension> {
    if (this.client) await this.close();
    this.tools = [];
    this.resources = [];
    this.config = config;
    const client = new Client({ name: "local-pi-harness", version: VERSION });
    this.client = client;
    client.onclose = () => {
      if (client !== this.client) return;
      this.client = undefined;
      this.ready = false;
      this.lease = undefined;
      this.generation++;
    };
    await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env: config.env, stderr: "inherit" }));
    const available: Tool[] = [];
    let cursor: string | undefined;
    do { const page = await client.listTools({ cursor }); available.push(...page.tools); cursor = page.nextCursor; } while (cursor);
    for (const name of config.tools) if (!available.some(t => t.name === name)) throw new Error(`Configured computer tool not found: ${name}`);
    this.tools = available.filter(t => config.tools.includes(t.name));
    if (client.getServerCapabilities()?.resources) {
      cursor = undefined;
      do { const page = await client.listResources({ cursor }); this.resources.push(...page.resources.map(r => ({ uri: r.uri, name: r.name }))); cursor = page.nextCursor; } while (cursor);
    }
    if (client !== this.client) throw new Error("Computer driver disconnected during setup.");
    this.ready = true;
    // Old tasks retain their per-call serialized interface. New tasks use forTask().
    return this.extension();
  }
  forTask(owner: string): Extension { return this.extension(owner); }
  release(owner: string): void { if (this.lease?.owner === owner) this.lease = undefined; }

  status() {
    const lease = this.lease && this.lease.expiresAt > Date.now() ? this.lease : undefined;
    return {
      connected: this.ready,
      mode: this.mode,
      owner: lease?.owner ?? null,
      expiresAt: lease?.expiresAt ?? null,
      observed: lease?.observed ?? false,
      busy: this.activeTool !== undefined,
      takingOver: this.takingOver,
      activeTool: this.activeTool ?? null,
      uncertain: this.uncertain,
    };
  }

  async takeover() {
    this.mode = "user";
    this.generation++;
    this.lease = undefined;
    this.takingOver = this.activeTool !== undefined;
    return this.handoff.run(async () => {
      this.mode = "user";
      this.generation++;
      this.lease = undefined;
      try {
        // An MCP cancellation can discard the reply while the driver still acts.
        await this.queue.run(async () => {});
      } finally {
        this.takingOver = false;
      }
      return this.status();
    });
  }

  async returnControl() {
    return this.handoff.run(async () => {
      this.generation++;
      this.lease = undefined;
      this.mode = "agent";
      return this.status();
    });
  }

  private agentCall<T>(call: () => Promise<T>): Promise<T> {
    if (this.mode === "user") return Promise.reject(new Error("The user has desktop control."));
    const generation = this.generation;
    return this.queue.run(async () => {
      this.requireAgentControl(generation);
      return call();
    });
  }

  private requireAgentControl(generation: number) {
    if (this.mode === "user" || generation !== this.generation) throw new Error("Desktop control changed. Reacquire a lease.");
    if (!this.ready) throw new Error("Computer driver is not connected.");
  }

  private observer(tool: Tool): boolean {
    return this.config?.observationTools ? this.config.observationTools.includes(tool.name) : tool.annotations?.readOnlyHint === true;
  }
  private extension(owner?: string): Extension {
    const client = this.client;
    if (!client) throw new Error("Computer driver is not connected");
    const isObservation = this.tools.map((tool) => this.observer(tool));
    const remote = this.tools.map((tool, index) => defineTool({
      name: `computer_${index}_${tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64),
      description: `Desktop tool ${tool.name}: ${tool.description ?? ""}. ${owner ? "Use computer_begin before a workflow and computer_end afterwards; re-observe after reconnect or a new lease." : "Calls are serialized."} An interrupted action is ambiguous; inspect the real app before retrying.`,
      parameters: tool.inputSchema as TSchema, replay: "unsafe",
      execute: async (args, _api, context) => this.agentCall(async () => {
        context.abortSignal?.throwIfAborted();
        if (owner) {
          if (!this.lease || this.lease.expiresAt <= Date.now() || this.lease.owner !== owner) throw new Error("Desktop lease missing or expired. Call computer_begin, then observe current app state before acting.");
          const hasObservers = this.tools.some(t => this.observer(t));
          if (hasObservers && !this.lease.observed && !this.observer(tool)) throw new Error("A fresh observation is required before desktop actions. Call an observation tool first.");
          this.lease.expiresAt = Date.now() + (this.config?.leaseMs ?? 120_000);
        }
        const generation = this.generation;
        const current = this.client;
        const currentTool = this.tools.find((candidate) => candidate.name === tool.name);
        if (!current || !currentTool || (current !== client && (
          JSON.stringify(currentTool.inputSchema) !== JSON.stringify(tool.inputSchema) ||
          this.observer(currentTool) !== isObservation[index]
        ))) {
          throw new Error("The computer tool changed. Reopen the task before using it.");
        }
        const observation = this.observer(currentTool);
        const lease = owner ? this.lease : undefined;
        this.activeTool = tool.name;
        let result: CallToolResult;
        try {
          result = await current.callTool(
            { name: tool.name, arguments: args as Record<string, unknown> },
            undefined,
            { timeout: 60_000 },
          ) as CallToolResult;
        } catch (error) {
          if (lease) lease.observed = false;
          if (!observation) this.uncertain = true;
          throw error;
        } finally {
          this.activeTool = undefined;
        }
        const validLease = !lease || (lease === this.lease && lease.expiresAt > Date.now());
        const discarded = !validLease || generation !== this.generation || context.abortSignal?.aborted;
        if (discarded || result.isError) {
          if (lease) lease.observed = false;
          if (!observation) this.uncertain = true;
        }
        this.requireAgentControl(generation);
        context.abortSignal?.throwIfAborted();
        if (!validLease) throw new Error("Desktop lease expired. Reacquire and observe before acting.");
        if (!result.isError && observation) {
          if (lease) lease.observed = true;
          this.uncertain = false;
        }
        return { isError: result.isError === true, output: result.content.flatMap((block): NonNullable<ToolExecutionResult["output"]> => {
          if (block.type === "text") return [{ type: "text", text: block.text }];
          if (block.type === "image") return [{ type: "image", data: block.data, mimeType: block.mimeType }];
          return [{ type: "text", text: JSON.stringify(block) }];
        }) };
      }),
    }));
    const lease = owner ? [
      defineTool({ name: "computer_begin", description: "Acquire the local desktop for one dependent workflow. If busy, continue independent work before retrying. Every new/expired lease requires observing current app state. Read computer_guide when available before using a new driver.", parameters: Type.Object({}), replay: "safe", executionMode: "sequential",
        execute: async (_args, _api, context) => this.agentCall(async () => {
          context.abortSignal?.throwIfAborted();
          if (this.lease && this.lease.expiresAt > Date.now() && this.lease.owner !== owner) throw new Error("Desktop is in use by another task. Do independent work before retrying; do not send desktop actions.");
          if (!this.lease || this.lease.expiresAt <= Date.now() || this.lease.owner !== owner) this.lease = { owner, expiresAt: 0, observed: false };
          if (!this.tools.some((tool) => this.observer(tool))) {
            this.lease = undefined;
            throw new Error("The computer driver needs an observation tool before a task can use it.");
          }
          this.lease.expiresAt = Date.now() + (this.config?.leaseMs ?? 120_000);
          return { output: [{ type: "text", text: "Desktop acquired. Observe current app state; earlier captures and coordinates may be stale. Release with computer_end after this workflow." }] };
        }),
      }),
      defineTool({ name: "computer_end", description: "Release this task's desktop workflow lease so another task can use it.", parameters: Type.Object({}), replay: "safe", executionMode: "sequential",
        execute: async () => { this.release(owner); return { output: [{ type: "text", text: "Desktop released" }] }; },
      }),
    ] : [];
    const guides = this.resources.length ? [defineTool({ name: "computer_guide", description: "List the connected driver's bundled instructions, or read one advertised resource URI. Read its main skill and platform instructions before operating apps. This reads documentation; it does not grant permissions.",
      parameters: Type.Object({ uri: Type.Optional(Type.String()) }), replay: "safe",
      execute: async (args, _api, context) => {
        if (!args.uri) return { output: [{ type: "text", text: JSON.stringify(this.resources) }] };
        if (!this.resources.some(r => r.uri === args.uri)) throw new Error("Resource URI was not advertised by this driver");
        const result = await client.readResource({ uri: args.uri }, { signal: context.abortSignal, timeout: 30_000 });
        return { output: result.contents.flatMap(c => "text" in c ? [{ type: "text" as const, text: c.text }] : []) };
      },
    })] : [];
    return defineExtension({ name: "local_computer", tools: [...remote, ...lease, ...guides] });
  }
  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.ready = false;
    this.lease = undefined;
    this.generation++;
    await client?.close();
  }
}
