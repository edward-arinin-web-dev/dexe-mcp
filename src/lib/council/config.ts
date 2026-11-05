import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { isAddress, getAddress } from "ethers";

/**
 * `council.json` — what `dexe-mcp council` runs. Kept small on purpose: a
 * three-agent council is ~20 lines (docs/AGENT-COUNCIL.md).
 *
 *   {
 *     "chain": 97,
 *     "govPool": "0x…",
 *     "addressBook": { "0x…": "vendor" },
 *     "agents": [
 *       { "name": "ops", "signer": "agent1", "model": "claude-cli:haiku", "role": "…" }
 *     ]
 *   }
 *
 * `model` is "<adapter>:<model>" or an object for the HTTP adapters:
 *   { "adapter": "anthropic", "model": "claude-opus-5-5", "apiKeyEnv": "ANTHROPIC_API_KEY" }
 *   { "adapter": "openai-compatible", "model": "…", "baseURL": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY" }
 * The key itself never lives in the config — only the NAME of the env var.
 */

export const ADAPTER_NAMES = ["claude-cli", "anthropic", "openai-compatible"] as const;
export type AdapterName = (typeof ADAPTER_NAMES)[number];

export interface ModelSpec {
  adapter: AdapterName;
  model: string;
  apiKeyEnv?: string;
  baseURL?: string;
  timeoutMs?: number;
}

const ModelObject = z.object({
  adapter: z.enum(ADAPTER_NAMES),
  model: z.string().min(1),
  apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "an env var NAME, not a key").optional(),
  baseURL: z.string().url().optional(),
  timeoutMs: z.number().int().positive().max(900_000).optional(),
});

const AgentSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, "letters, digits, - and _ only (used as a log key)"),
  /** "agent1".."agent16" (keyring slot), "primary", or the slot number. */
  signer: z.union([z.string(), z.number().int().min(1).max(16)]),
  model: z.union([z.string(), ModelObject]),
  role: z.string().min(1).max(2000),
});

const CouncilSchema = z.object({
  chain: z.number().int().positive(),
  govPool: z.string(),
  addressBook: z.record(z.string(), z.string()).default({}),
  limits: z.object({ maxTreasuryPct: z.number().positive().max(100).optional() }).default({}),
  agents: z.array(AgentSchema).min(1).max(16),
  /** JSONL decision log; relative to the config file. */
  log: z.string().default("council-log.jsonl"),
  pollSeconds: z.number().int().min(5).max(3600).default(30),
  /** How many of the newest proposals to scan for Voting ones. */
  scanLatest: z.number().int().min(1).max(100).default(20),
});

export interface CouncilAgent {
  name: string;
  signerKey: string;
  model: ModelSpec;
  role: string;
}

export interface CouncilConfig {
  chain: number;
  govPool: string;
  addressBook: Record<string, string>;
  limits: { maxTreasuryPct?: number };
  agents: CouncilAgent[];
  logPath: string;
  pollSeconds: number;
  scanLatest: number;
}

export function parseModel(m: string | z.infer<typeof ModelObject>): ModelSpec {
  if (typeof m !== "string") return { ...m };
  const idx = m.indexOf(":");
  const adapter = (idx === -1 ? "claude-cli" : m.slice(0, idx)) as AdapterName;
  const model = idx === -1 ? m : m.slice(idx + 1);
  if (!(ADAPTER_NAMES as readonly string[]).includes(adapter)) {
    throw new Error(`model "${m}": unknown adapter "${adapter}" (use ${ADAPTER_NAMES.join(" | ")})`);
  }
  if (!model) throw new Error(`model "${m}": no model name after the adapter`);
  if (adapter !== "claude-cli") {
    throw new Error(`model "${m}": the ${adapter} adapter needs an object with apiKeyEnv${adapter === "openai-compatible" ? " and baseURL" : ""}`);
  }
  return { adapter, model };
}

export function parseSignerSlot(s: string | number): string {
  if (typeof s === "number") return `agent${s}`;
  const t = s.trim().toLowerCase();
  if (t === "primary" || t === "default") return "primary";
  if (/^agent([1-9]|1[0-6])$/.test(t)) return t;
  if (/^([1-9]|1[0-6])$/.test(t)) return `agent${t}`;
  throw new Error(`signer "${s}": use a keyring slot "agent1".."agent16", its number, or "primary"`);
}

/** Validate a parsed JSON object. `baseDir` resolves the relative log path. */
export function parseCouncilConfig(raw: unknown, baseDir = process.cwd()): CouncilConfig {
  const r = CouncilSchema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`council config invalid — ${issues}`);
  }
  const c = r.data;
  if (!isAddress(c.govPool)) throw new Error(`council config: govPool ${c.govPool} is not an address`);
  for (const a of Object.keys(c.addressBook)) {
    if (!isAddress(a)) throw new Error(`council config: addressBook key ${a} is not an address`);
  }
  const agents = c.agents.map((a) => {
    const model = parseModel(a.model);
    if (model.adapter === "openai-compatible" && !model.baseURL) {
      throw new Error(`agent ${a.name}: openai-compatible needs baseURL`);
    }
    if (model.adapter === "anthropic" && !model.apiKeyEnv) {
      throw new Error(`agent ${a.name}: anthropic needs apiKeyEnv (the NAME of the env var holding the key)`);
    }
    return { name: a.name, signerKey: parseSignerSlot(a.signer), model, role: a.role };
  });
  const names = new Set<string>();
  const slots = new Set<string>();
  for (const a of agents) {
    if (names.has(a.name)) throw new Error(`council config: duplicate agent name ${a.name}`);
    if (slots.has(a.signerKey)) throw new Error(`council config: two agents share signer ${a.signerKey} — one key, one vote`);
    names.add(a.name);
    slots.add(a.signerKey);
  }
  return {
    chain: c.chain,
    govPool: getAddress(c.govPool),
    addressBook: c.addressBook,
    limits: c.limits,
    agents,
    logPath: resolve(baseDir, c.log),
    pollSeconds: c.pollSeconds,
    scanLatest: c.scanLatest,
  };
}

export function loadCouncilConfig(path: string): CouncilConfig {
  const abs = resolve(path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new Error(`cannot read council config ${abs}: ${(e as Error).message}`);
  }
  return parseCouncilConfig(raw, dirname(abs));
}
