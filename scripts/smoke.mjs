// Boots the built MCP over stdio and prints: initialize response + tools/list.
// Run: node scripts/smoke.mjs
import { spawn } from "node:child_process";

const node = process.execPath;
const child = spawn(node, ["dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

let out = "";
child.stdout.on("data", (d) => {
  out += d.toString();
});
child.stderr.on("data", (d) => process.stderr.write("[child-stderr] " + d));

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  },
});
await new Promise((r) => setTimeout(r, 500));
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
await new Promise((r) => setTimeout(r, 1500));

child.kill();

const lines = out.trim().split("\n");
for (const l of lines) {
  try {
    const m = JSON.parse(l);
    if (m.id === 1 && m.result) {
      console.log(
        "INIT_OK name=" +
          m.result.serverInfo?.name +
          " version=" +
          m.result.serverInfo?.version,
      );
    }
    if (m.id === 2 && m.result) {
      const tools = m.result.tools;
      console.log("TOOLS_COUNT=" + tools.length);
      for (const t of tools) console.log(" - " + t.name);
    }
  } catch {
    /* not json */
  }
}
