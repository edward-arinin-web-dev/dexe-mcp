import { z } from "zod";

/**
 * Single source of truth for every DEXE_* env var the MCP recognizes.
 *
 * Consumed by:
 *   - `src/env/parse.ts`  — validation at startup, accumulates issues
 *   - `src/diag/checks.ts` — `dexe_doctor` walks ENV_SPEC for presence checks
 *   - `src/lib/requireEnv.ts` — fail-soft tool guards build remediation hints
 *
 * To add a new env var: add an entry here, update docs/ENVIRONMENT.md, and
 * the parity test in tests/env/schema.test.ts will require .env.example to
 * mention it. Categories drive the .env.example layout and doctor output
 * grouping.
 */

export type EnvCategory =
  | "core"
  | "rpc"
  | "signer"
  | "ipfs"
  | "subgraph"
  | "walletconnect"
  | "safe"
  | "backend"
  | "dev";

/**
 * Feature surfaces that depend on a given env var. Used by hintFor() to tell
 * the user which tools light up when the var is set.
 */
export type EnvFlow =
  | "read"
  | "broadcast"
  | "ipfs-upload"
  | "ipfs-read"
  | "subgraph-read"
  | "dao-deploy"
  | "safe-tx"
  | "walletconnect-sign"
  | "backend-offchain";

export interface EnvEntry {
  schema: z.ZodType<unknown>;
  category: EnvCategory;
  /** True only for vars without which the MCP cannot start. None today. */
  required: boolean;
  /** Placeholder shown in `.env.example`. */
  example: string;
  /** One-line description mirrored in docs/ENVIRONMENT.md. */
  doc: string;
  /** Which user-visible flows this var unlocks. Doctor + hintFor() use this. */
  enablesFlows?: readonly EnvFlow[];
  /** Mask the value when echoing it (banner, doctor, logs). */
  secret?: boolean;
}

const hex64 = /^0x[0-9a-fA-F]{64}$/;
const hex40 = /^0x[0-9a-fA-F]{40}$/;

/*
 * Validator factories.
 *
 * Since 0.30.1 a bad value degrades to the documented default instead of
 * killing the process, so this message is the only thing the user ever learns
 * about the rejection — zod's bare "Invalid" / "Invalid url" leaves them
 * guessing at the shape. Every factory therefore states what is expected AND
 * shows a concrete value, and repeats it as the schema description so a
 * consumer can render "expected: …" without re-deriving it from the regex.
 *
 * Vars that accept any string keep a bare `z.string()`: they have no rejection
 * path, so there is nothing to explain.
 */

/** Digits-only integer. `what` completes "must be …"; keep `example` paste-able. */
const intStr = (what: string, example: string) => {
  const msg = `must be ${what}, written as digits only (no sign, no decimal point, no unit suffix), e.g. ${example}`;
  return z.string().regex(/^\d+$/, msg).optional().describe(msg);
};

/** One absolute URL. `scheme` names the shape we document, not what zod accepts. */
/**
 * `scheme` is not just label text — it is enforced. Previously the message
 * promised "websocket (ws/wss)" while `z.string().url()` happily accepted
 * `https://`, so a user with an https WalletConnect relay got a green doctor
 * and a signer that never connects.
 */
const urlStr = (example: string, scheme = "http(s)", protocols: string[] = ["http:", "https:"]) => {
  const msg = `must be one absolute ${scheme} URL including the scheme, e.g. ${example}`;
  return z
    .string()
    .url(msg)
    .refine(
      (v) => {
        try {
          return protocols.includes(new URL(v).protocol);
        } catch {
          return false;
        }
      },
      { message: msg },
    )
    .optional()
    .describe(msg);
};

/**
 * One URL, or a comma-separated list of URLs. The first is the primary
 * endpoint; the rest are transport-failure fallbacks rotated by
 * ResilientRpcProvider (src/rpc.ts).
 */
const urlListStr = (example: string) => {
  const msg = `must be one absolute http(s) URL, or a comma-separated list of URLs (first is primary, the rest are failover), e.g. ${example}`;
  return z
    .string()
    .refine(
      (v) => v.split(",").map((s) => s.trim()).filter(Boolean).every((u) => z.string().url().safeParse(u).success),
      { message: msg },
    )
    .optional()
    .describe(msg);
};

/** Hot EOA key. The value never reaches the message — parse.ts redacts secrets. */
const privateKeyStr = () => {
  const msg = "must be a 0x-prefixed 64-hex private key (66 characters total), e.g. 0xabc…(64 hex chars)";
  return z.string().regex(hex64, msg).optional().describe(msg);
};

const addressStr = () => {
  const msg = "must be a 0x-prefixed 40-hex EVM address (42 characters total), e.g. 0xAbc…(40 hex chars)";
  return z.string().regex(hex40, msg).optional().describe(msg);
};

const TREASURY_GUARD_MSG = "must be exactly 'off' or 'warn' (lowercase), e.g. warn";

export const ENV_SPEC = {
  // ─── core / dev ───────────────────────────────────────────────────────────
  DEXE_PROTOCOL_PATH: {
    schema: z.string().optional(),
    category: "core",
    required: false,
    example: "",
    doc: "Override the DeXe-Protocol checkout path. Auto-managed when unset.",
  },
  DEXE_MIN_SAFE_QUORUM_PCT: {
    schema: intStr("a percent from 0 to 100", "50"),
    category: "core",
    required: false,
    example: "50",
    doc: "Minimum safe quorum percent (0–100). Quorum below this is flagged as a governance-safety risk for treasury-moving proposals. Default 50.",
  },
  DEXE_TREASURY_GUARD: {
    schema: z
      .enum(["off", "warn"], { errorMap: () => ({ message: TREASURY_GUARD_MSG }) })
      .optional()
      .describe(TREASURY_GUARD_MSG),
    category: "core",
    required: false,
    example: "warn",
    doc: "Treasury-safety advisory posture: off | warn. 'warn' (default) emits advisories/alerts everywhere (build, deploy, execute, risk_assess) but NEVER blocks; 'off' silences them.",
  },
  DEXE_CONTROLLING_TOPN: {
    schema: intStr("how many top holders to include", "5"),
    category: "core",
    required: false,
    example: "5",
    doc: "Top-N token holders (by voting weight) in the treasury-guard controlling set, alongside validators. The guard checks whether ≥1 member voted For. Subgraph/mainnet-only. Default 5.",
  },
  DEXE_TOOLSETS: {
    schema: z.string().optional(),
    category: "core",
    required: false,
    example: "core,proposals",
    doc: "Comma list of tool profiles to load: core, proposals, read, vote, governor, dev, or full. Default 'core,proposals' (slim). 'full' or an unknown name loads all tools. Reduces tools/list tokens per session.",
  },
  DEXE_STATE_PATH: {
    schema: z.string().optional(),
    category: "core",
    required: false,
    example: "",
    doc: "Override path for the persistent operational-state JSON (known DAOs / recent proposals surfaced by dexe_context). Default ~/.dexe-mcp/state.json. Must be in a writable directory.",
  },
  DEXE_ENV_FILE: {
    schema: z.string().optional(),
    category: "core",
    required: false,
    example: "",
    doc: "Absolute path to a .env file to load first, for hosts/CI/containers that can inject one variable but not a working directory. Must be set in the real process environment (not inside a .env), since it is read before any file loads. The default cwd-independent search (<cwd>/.env, then ~/.dexe-mcp/.env) needs no override.",
  },

  // ─── rpc ──────────────────────────────────────────────────────────────────
  DEXE_RPC_URL: {
    schema: urlListStr("https://bsc-dataseed.bnbchain.org"),
    category: "rpc",
    required: false,
    example: "https://bsc-dataseed.bnbchain.org",
    doc: "Legacy single-chain RPC. Prefer DEXE_RPC_URL_TESTNET / _MAINNET / _<chainId>. Accepts a comma-separated fallback list.",
    enablesFlows: ["read", "broadcast"],
  },
  DEXE_CHAIN_ID: {
    schema: intStr("an EVM chain id", "56 for BSC mainnet"),
    category: "rpc",
    required: false,
    example: "56",
    doc: "Chain id for legacy DEXE_RPC_URL. Inferred from hostname when unset.",
  },
  DEXE_RPC_URL_TESTNET: {
    schema: urlListStr("https://data-seed-prebsc-1-s1.bnbchain.org:8545"),
    category: "rpc",
    required: false,
    example: "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
    doc: "RPC URL for BSC testnet (chain 97). Accepts a comma-separated fallback list — the first is primary, the rest rotate on transport failures.",
    enablesFlows: ["read", "broadcast"],
  },
  DEXE_RPC_URL_MAINNET: {
    schema: urlListStr("https://bsc-dataseed.bnbchain.org"),
    category: "rpc",
    required: false,
    example: "https://bsc-dataseed.bnbchain.org",
    doc: "RPC URL for BSC mainnet (chain 56). Accepts a comma-separated fallback list — the first is primary, the rest rotate on transport failures.",
    enablesFlows: ["read", "broadcast"],
  },
  DEXE_TX_WAIT_TIMEOUT_MS: {
    schema: intStr("a timeout in milliseconds", "180000 for 3 minutes"),
    category: "rpc",
    required: false,
    example: "180000",
    doc: "Max milliseconds to wait for a broadcast tx to mine before returning a check-with-dexe_tx_status error. Default 180000 (3 min).",
  },
  DEXE_DEFAULT_CHAIN_ID: {
    schema: intStr("an EVM chain id that has an RPC configured", "97 for BSC testnet"),
    category: "rpc",
    required: false,
    example: "97",
    doc: "Default chain id when a tool omits chainId. Must match a configured RPC.",
  },
  DEXE_CONTRACTS_REGISTRY: {
    schema: addressStr(),
    category: "rpc",
    required: false,
    example: "",
    doc: "Override ContractsRegistry address for the default chain. Rarely needed.",
  },
  DEXE_DISABLE_PUBLIC_RPC: {
    schema: z.string().optional(),
    category: "rpc",
    required: false,
    example: "1",
    doc: "Set to 1 to disable the built-in public BSC RPC fallback (which activates only when no RPC is configured).",
  },

  // ─── signer ──────────────────────────────────────────────────────────────
  DEXE_PRIVATE_KEY: {
    schema: privateKeyStr(),
    category: "signer",
    required: false,
    example: "0x<64-hex>",
    doc: "Hot EOA key for dexe_tx_send broadcast. Requires an RPC.",
    enablesFlows: ["broadcast"],
    secret: true,
  },
  // Opt-in agent keyring for multi-persona/swarm flows — selected per call
  // via `signerKey: "agent<n>"` on dexe_tx_send + the composites. Slots 1–16;
  // declared individually so doctor validates/redacts each like any secret.
  ...(Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => [
      `DEXE_AGENT_PK_${i + 1}`,
      {
        schema: privateKeyStr(),
        category: "signer",
        required: false,
        example: "0x<64-hex>",
        doc: `Agent keyring slot ${i + 1} — extra hot EOA key, selected via signerKey "agent${i + 1}". Alias: AGENT_PK_${i + 1} (swarm-harness naming; DEXE_-prefixed wins if both set). Same RPC requirement and plaintext-on-disk caveats as DEXE_PRIVATE_KEY.`,
        secret: true,
      },
    ]),
  ) as Record<`DEXE_AGENT_PK_${number}`, EnvEntry>),
  DEXE_AGENT_FUNDER_PK: {
    schema: privateKeyStr(),
    category: "signer",
    required: false,
    example: "0x<64-hex>",
    doc: 'Gas-funder wallet for the agent keyring, selected via signerKey "funder" (e.g. as the dexe_agents_fund source). Alias: AGENT_FUNDER_PK (the swarm-harness naming). Same caveats as DEXE_PRIVATE_KEY.',
    secret: true,
  },
  DEXE_AGENT_FUND_MAX_WEI: {
    schema: intStr("an amount in wei", "100000000000000000 for 0.1 native"),
    category: "signer",
    required: false,
    example: "100000000000000000",
    doc: "Per-agent cap (wei) for dexe_agents_fund transfers. Default 0.1 native when unset.",
  },
  DEXE_SIGNER_ALLOWLIST: {
    schema: z.string().optional(),
    category: "signer",
    required: false,
    example: "",
    doc: "Comma-separated destination address allowlist for dexe_tx_send (B6 guard).",
  },
  DEXE_SIGNER_MAX_VALUE_WEI: {
    schema: intStr("an amount in wei", "100000000000000000 for 0.1 native"),
    category: "signer",
    required: false,
    example: "",
    doc: "Max wei value per broadcast (B7 guard).",
  },
  DEXE_SIGNER_MAX_BROADCASTS_PER_MIN: {
    schema: intStr("a broadcast count per rolling minute", "10"),
    category: "signer",
    required: false,
    example: "",
    doc: "Rate limit broadcasts per rolling minute (B10 guard).",
  },

  // ─── ipfs ────────────────────────────────────────────────────────────────
  DEXE_PINATA_JWT: {
    schema: z.string().optional(),
    category: "ipfs",
    required: false,
    example: "eyJhbGciOiJIUzI1NiIs...",
    doc: "Pinata pinning JWT. Required for IPFS uploads; reads work without it.",
    enablesFlows: ["ipfs-upload", "dao-deploy"],
    secret: true,
  },
  DEXE_IPFS_GATEWAY: {
    schema: urlStr("https://gateway.pinata.cloud"),
    category: "ipfs",
    required: false,
    example: "https://<subdomain>.mypinata.cloud",
    doc: "Primary IPFS gateway base URL for reads.",
    enablesFlows: ["ipfs-read"],
  },
  DEXE_IPFS_GATEWAYS_FALLBACK: {
    schema: z.string().optional(),
    category: "ipfs",
    required: false,
    example: "",
    doc: "Comma-separated public IPFS gateway fallbacks for reads.",
  },
  DEXE_IPFS_DISABLE_PUBLIC_FALLBACK: {
    schema: z.string().optional(),
    category: "ipfs",
    required: false,
    example: "1",
    doc: "Set to 1 to disable the built-in public IPFS read-gateway default (ipfs.io, dweb.link, cloudflare). Reads then require DEXE_IPFS_GATEWAY.",
  },
  DEXE_PINATA_GATEWAY_TOKEN: {
    schema: z.string().optional(),
    category: "ipfs",
    required: false,
    example: "",
    doc: "Auth token for a private Pinata dedicated gateway (optional).",
    secret: true,
  },
  DEXE_IPFS_AVATAR_GATEWAY: {
    schema: urlStr("https://gateway.pinata.cloud"),
    category: "ipfs",
    required: false,
    example: "",
    doc: "Optional override for the avatar fetch gateway.",
  },

  // ─── subgraph ────────────────────────────────────────────────────────────
  DEXE_SUBGRAPH_POOLS_URL: {
    schema: urlStr("https://gateway.thegraph.com/api/subgraphs/id/<id>"),
    category: "subgraph",
    required: false,
    example: "https://gateway.thegraph.com/api/subgraphs/id/<id>",
    doc: "Pools subgraph endpoint.",
    enablesFlows: ["subgraph-read"],
  },
  DEXE_SUBGRAPH_VALIDATORS_URL: {
    schema: urlStr("https://gateway.thegraph.com/api/subgraphs/id/<id>"),
    category: "subgraph",
    required: false,
    example: "https://gateway.thegraph.com/api/subgraphs/id/<id>",
    doc: "Validators subgraph endpoint.",
    enablesFlows: ["subgraph-read"],
  },
  DEXE_SUBGRAPH_INTERACTIONS_URL: {
    schema: urlStr("https://gateway.thegraph.com/api/subgraphs/id/<id>"),
    category: "subgraph",
    required: false,
    example: "https://gateway.thegraph.com/api/subgraphs/id/<id>",
    doc: "Interactions subgraph endpoint.",
    enablesFlows: ["subgraph-read"],
  },
  DEXE_GRAPH_API_KEY: {
    schema: z.string().optional(),
    category: "subgraph",
    required: false,
    example: "",
    doc: "The Graph API key for bearer auth (required by decentralized gateway).",
    secret: true,
  },

  // ─── walletconnect ───────────────────────────────────────────────────────
  DEXE_WALLETCONNECT_PROJECT_ID: {
    schema: z.string().optional(),
    category: "walletconnect",
    required: false,
    example: "",
    doc: "Reown/WalletConnect project id. Enables phone-approval signer when DEXE_PRIVATE_KEY is unset.",
    enablesFlows: ["walletconnect-sign"],
  },
  DEXE_WALLETCONNECT_RELAY_URL: {
    schema: urlStr("wss://relay.walletconnect.com", "websocket (ws/wss)", ["ws:", "wss:"]),
    category: "walletconnect",
    required: false,
    example: "wss://relay.walletconnect.com",
    doc: "Override WC relay websocket URL.",
  },
  DEXE_WALLETCONNECT_APPROVAL_TIMEOUT_MS: {
    schema: intStr("a timeout in milliseconds", "120000 for 2 minutes"),
    category: "walletconnect",
    required: false,
    example: "120000",
    doc: "Per-tx phone-approval timeout in milliseconds.",
  },

  // ─── safe ────────────────────────────────────────────────────────────────
  DEXE_SAFE_TX_SERVICE_URL: {
    schema: urlStr("https://api.safe.global/tx-service/bnb/api/v2"),
    category: "safe",
    required: false,
    example: "https://api.safe.global/tx-service/bnb/api/v2",
    doc: "Safe Transaction Service base. Required for chains without a hosted service.",
    enablesFlows: ["safe-tx"],
  },
  DEXE_SAFE_API_KEY: {
    schema: z.string().optional(),
    category: "safe",
    required: false,
    example: "",
    doc: "Bearer token for Safe Transaction Service.",
    secret: true,
  },

  // ─── backend ─────────────────────────────────────────────────────────────
  DEXE_BACKEND_API_URL: {
    schema: urlStr("https://api.dexe.io"),
    category: "backend",
    required: false,
    example: "https://api.dexe.io",
    doc: "DeXe backend API root for off-chain proposal flows.",
    enablesFlows: ["backend-offchain"],
  },

  // ─── dev ─────────────────────────────────────────────────────────────────
  DEXE_FORK_BLOCK: {
    schema: intStr("a block number", "45000000"),
    category: "dev",
    required: false,
    example: "",
    doc: "Optional fork block pin (Phase B).",
  },
  DEXE_MAX_DESCRIPTION_LEN: {
    schema: intStr("a character count", "20000"),
    category: "core",
    required: false,
    example: "20000",
    doc: "Max characters accepted for proposal/DAO description markdown before conversion (guards IPFS payload size). Default 20000.",
  },
  DEXE_PROTOCOL_REF: {
    schema: z.string().optional(),
    category: "dev",
    required: false,
    example: "",
    doc: "Git ref (branch/tag/commit) checked out for the auto-managed DeXe-Protocol clone. Default: the pinned release the MCP ships with.",
  },
} as const satisfies Record<string, EnvEntry>;

/**
 * Re-export with the structural interface so consumers see optional fields
 * (`secret`, `enablesFlows`). `as const` narrows literals but hides any field
 * not present on every entry, which trips `.secret`/`.enablesFlows` reads.
 */
export const ENV_REGISTRY: Record<EnvKey, EnvEntry> = ENV_SPEC;

export type EnvKey = keyof typeof ENV_SPEC;

export function isKnownEnvKey(k: string): k is EnvKey {
  return Object.prototype.hasOwnProperty.call(ENV_SPEC, k);
}

export function envKeys(): EnvKey[] {
  return Object.keys(ENV_SPEC) as EnvKey[];
}

/**
 * Pattern for dynamic per-chain RPC keys (DEXE_RPC_URL_1, DEXE_RPC_URL_10…).
 * Not in ENV_SPEC because the suffix is open-ended.
 */
export const DYNAMIC_PER_CHAIN_RPC_RE = /^DEXE_RPC_URL_(\d+)$/;
