import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

const transport = new StdioClientTransport({
  command: "node",
  args: [resolve("dist/index.js")],
  env: { ...process.env, DEXE_PRIVATE_KEY: "" },
  cwd: process.cwd(),
});
const c = new Client({ name: "swarm-orch", version: "0.1.0" });
await c.connect(transport);
console.log("connected");

const tools = await c.listTools();
console.log("tool count:", tools.tools.length);
console.log("has proposal_create:", tools.tools.some(t => t.name === "dexe_proposal_create"));
console.log("has proposal_build_modify_dao_profile:", tools.tools.some(t => t.name === "dexe_proposal_build_modify_dao_profile"));

const r = await c.callTool({
  name: "dexe_dao_info",
  arguments: { govPool: "0x9820e732799dd73069692C9aC2cD561487ec1C38" },
});
console.log("dao_info isError:", r.isError);
const sc = r.structuredContent ?? null;
console.log("dao_info has descriptionURL:", !!(sc && sc.descriptionURL));

// Unsigned mode: pass `user` so server knows who the proposer is, no DEXE_PRIVATE_KEY → returns TxPayload list
const proposer = "0x9572f3Bc4F88758259F29D80d73EAc012d7Fa09f"; // AGENT_PK_1 derived
const pcRes = await c.callTool({
  name: "dexe_proposal_create",
  arguments: {
    govPool: "0x9820e732799dd73069692C9aC2cD561487ec1C38",
    proposalType: "modify_dao_profile",
    title: "S01 bridge smoke",
    description: "Phase 1.5 MCP bridge test",
    newDaoDescription: "Phase 1.5 bridge test 2026-04-29",
    category: "DAO Profile",
    user: proposer,
  },
});
console.log("proposal_create isError:", pcRes.isError);
console.log("proposal_create raw content:", JSON.stringify(pcRes.content).slice(0, 1500));
console.log("proposal_create structured:", JSON.stringify(pcRes.structuredContent).slice(0, 1500));

await c.close();
console.log("closed");
