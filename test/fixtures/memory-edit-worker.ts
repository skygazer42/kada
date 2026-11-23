import { readFile } from "node:fs/promises";
import { LocalDiscovery } from "../../src/discovery.js";
import type { MemoryChange } from "../../src/user-memory.js";
const file = JSON.parse(await readFile(process.argv[2]!, "utf8")) as { data: string; home: string; workspace: string; id: string; input: MemoryChange };
const discovery = new LocalDiscovery(file.data, { home: file.home });
await discovery.memoryView(file.workspace);
const result = await discovery.memory.change(file.home, file.id, file.input, file.workspace);
console.log(JSON.stringify({ type: "saved", result }));
process.stdin.resume();
