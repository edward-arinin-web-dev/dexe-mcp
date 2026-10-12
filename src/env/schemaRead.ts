import { z } from "zod";

/**
 * The READ edition's env vars: chains/RPC, subgraphs, the DeXe backend, IPFS
 * reads, the analysis knobs read tools use, and process plumbing.
 *
 * The full spec the single server walks — this plus the write edition's vars
 * (signing keys, keyring, broadcast guards, Pinata, WalletConnect, Safe, the
 * treasury guard) and the dev toolchain's — is `ENV_SPEC` in ./schema.ts, in
 * the display order the doctor and `.env.example` have always used.
 *
 * Consumed by:
 *   - `src/env/parse.ts`   — validation (the spec is a parameter)
 *   - `src/env/loader.ts`  — typo detection for `.env` keys (`EnvSurface`)
 *   - `src/diag/checks.ts` — `dexe_doctor` presence rows (`EnvSurface`)
 *   - `src/lib/requireEnv.ts` — remediation hints
 *   - `src/configRead.ts`  — `loadReadConfig`
 *
 * To add a new env var: add it here (read) or to ./schema.ts (write / dev),
 * place it in `ENV_DISPLAY_ORDER` there, update docs/ENVIRONMENT.md, and the
 * parity test in tests/env/schema.test.ts will require .env.example to mention
 * it. Categories drive the .env.example layout and doctor output grouping.
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

/** An env spec: var name → entry, in display order. */
export type EnvSpec = Readonly<Record<string, EnvEntry>>;

const hex40 = /^0x[0-9a-fA-F]{40}$/;

/*
 * Validator factories — shared with the write spec in ./schema.ts.
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
export const intStr = (what: string, example: string) => {
  const msg = `must be ${what}, written as digits only (no sign, no decimal point, no unit suffix), e.g. ${example}`;
  return z.string().regex(/^\d+$/, msg).optional().describe(msg);
};

/**
 * A closed set of literal values. Same contract as the other factories: state
 * the shape, show a concrete value, and repeat both as the description — zod's
 * stock "Invalid enum value" is exactly the text this file exists to keep off
 * the surface.
 */
export const enumStr = <T extends readonly [string, ...string[]]>(values: T) => {
  const msg = `must be one of ${values.map((v) => `\`${v}\``).join(" | ")}, e.g. ${values[0]}`;
  return z.enum(values, { error: () => msg }).optional().describe(msg);
};

/** One absolute URL. `scheme` names the shape we document, not what zod accepts. */
/**
 * `scheme` is not just label text — it is enforced. Previously the message
 * promised "websocket (ws/wss)" while `z.string().url()` happily accepted
 * `https://`, so a user with an https WalletConnect relay got a green doctor
 * and a signer that never connects.
 */
export const urlStr = (example: string, scheme = "http(s)", protocols: string[] = ["http:", "https:"]) => {
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

const addressStr = () => {
  const msg = "must be a 0x-prefixed 40-hex EVM address (42 characters total), e.g. 0xAbc…(40 hex chars)";
  return z.string().regex(hex40, msg).optional().describe(msg);
};

/**
 * One GraphQL endpoint URL. Shared by the three unsuffixed subgraph vars AND
 * by the dynamic `DEXE_SUBGRAPH_<KIND>_URL_<chainId>` family, so a per-chain
 * endpoint is held to exactly the same shape (and gets the same message) as
 * the unsuffixed one it overrides.
 */
export const subgraphUrlStr = () => urlStr("https://gateway.thegraph.com/api/subgraphs/id/<id>");

export const ENV_SPEC_READ = {
  // ─── core ─────────────────────────────────────────────────────────────────
  DEXE_MIN_SAFE_QUORUM_PCT: {
    schema: intStr("a percent from 0 to 100", "50"),
    category: "core",
    required: false,
    example: "50",
    doc: "Minimum safe quorum percent (0–100). Quorum below this is flagged as a governance-safety risk for treasury-moving proposals. Default 50.",
  },
  DEXE_CONTROLLING_TOPN: {
    schema: intStr("how many top holders to include", "5"),
    category: "core",
    required: false,
    example: "5",
    doc: "Top-N token holders (by voting weight) in the treasury-guard controlling set, alongside validators. The guard checks whether ≥1 member voted For. Needs a pools AND validators subgraph for the chain being analyzed; an unindexed chain yields 'unknown', never another chain's set. Default 5.",
  },
  DEXE_MAX_RESPONSE_BYTES: {
    schema: intStr("a size in bytes", "262144 for 256 KB"),
    category: "core",
    required: false,
    example: "262144",
    doc: "Size limit for one read-tool result (text + structuredContent). A larger result is cut to fit — rows dropped from the end, long strings shortened — with a first line saying what was cut and how to page or narrow; offset-paged tools get a corrected returned/nextOffset. Clamped to 16 KB–16 MB. Default 262144 (256 KB).",
  },
  DEXE_TOOLSETS: {
    schema: z.string().optional(),
    category: "core",
    required: false,
    example: "core",
    doc: "Comma list of tool profiles to load: core, proposals, read, vote, agents, governor, dev, or full. Default 'core' since v0.31.0 — the composites plus the zero-config reporting reads. 'core,proposals' restores the pre-0.31 builder surface; 'core,agents' adds the keyring fleet (v0.32.0); 'full' loads every tool. An unknown name is DROPPED (the recognized sets still apply) rather than escalating to full. Reduces tools/list tokens per session.",
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
  // Deliberately `z.string()` rather than an enum: an unparseable DEXE_DEBUG
  // must never be the thing that spoils a startup, and the reader
  // (isDebugEnabled() in src/runtime.ts) already treats anything outside the
  // truthy set as "off".
  DEXE_DEBUG: {
    schema: z.string().optional(),
    category: "core",
    required: false,
    example: "1",
    doc: "Set to 1 (or true/yes/on) for verbose diagnostics on stderr — startup facts, transport errors, RPC/state activity, and full stack traces for crashes the server survives. Every line is redacted (credentialed RPC URLs are masked) and goes to stderr only, never stdout. Off by default; this is what to enable before filing a bug report.",
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
  // Registered here (not by src/rpc.ts, which owns the timeout itself) because
  // the env spec is the single source of truth: an unregistered DEXE_* var is
  // reported as a typo by the loader and is invisible to dexe_doctor.
  DEXE_RPC_TIMEOUT_MS: {
    schema: intStr("a timeout in milliseconds", "15000 for 15 seconds"),
    category: "rpc",
    required: false,
    example: "15000",
    doc: "Per-request timeout (milliseconds) for a single JSON-RPC call. Without it a blackholing endpoint stalls the whole tool call until the OS gives up (~20 min) and the host shows a frozen tool. On timeout the request fails fast and rotates to the next URL in the fallback list. Default 15000.",
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

  // ─── ipfs (reads) ─────────────────────────────────────────────────────────
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
  DEXE_IPFS_MAX_BYTES: {
    schema: intStr("a size in bytes", "2097152 for 2 MB"),
    category: "ipfs",
    required: false,
    example: "2097152",
    doc: "Byte limit for one IPFS read (dexe_ipfs_fetch and every internal metadata read). The body is streamed and the fetch stops at the limit with an actionable error. Clamped to 1 KB–256 MB. Default 2097152 (2 MB); DeXe metadata is a few KB.",
  },
  DEXE_PINATA_GATEWAY_TOKEN: {
    schema: z.string().optional(),
    category: "ipfs",
    required: false,
    example: "",
    doc: "Auth token for a private Pinata dedicated gateway (optional).",
    secret: true,
  },

  // ─── subgraph ────────────────────────────────────────────────────────────
  // A subgraph endpoint indexes exactly ONE chain, so every entry here is
  // chain-scoped. The three unsuffixed vars below cover the chain named by
  // DEXE_SUBGRAPH_CHAIN_ID (56 by default); per-chain endpoints use the
  // DEXE_SUBGRAPH_<KIND>_URL_<chainId> form (see PER_CHAIN_SUBGRAPH_URL_RE),
  // which is dynamic and therefore not enumerable in the spec.
  DEXE_SUBGRAPH_POOLS_URL: {
    schema: subgraphUrlStr(),
    category: "subgraph",
    required: false,
    example: "https://gateway.thegraph.com/api/subgraphs/id/<id>",
    doc: "Pools subgraph endpoint for the chain named by DEXE_SUBGRAPH_CHAIN_ID (default 56, BSC mainnet). Per-chain form: DEXE_SUBGRAPH_POOLS_URL_<chainId>.",
    enablesFlows: ["subgraph-read"],
  },
  DEXE_SUBGRAPH_VALIDATORS_URL: {
    schema: subgraphUrlStr(),
    category: "subgraph",
    required: false,
    example: "https://gateway.thegraph.com/api/subgraphs/id/<id>",
    doc: "Validators subgraph endpoint for the chain named by DEXE_SUBGRAPH_CHAIN_ID (default 56, BSC mainnet). Per-chain form: DEXE_SUBGRAPH_VALIDATORS_URL_<chainId>.",
    enablesFlows: ["subgraph-read"],
  },
  DEXE_SUBGRAPH_INTERACTIONS_URL: {
    schema: subgraphUrlStr(),
    category: "subgraph",
    required: false,
    example: "https://gateway.thegraph.com/api/subgraphs/id/<id>",
    doc: "Interactions subgraph endpoint for the chain named by DEXE_SUBGRAPH_CHAIN_ID (default 56, BSC mainnet). Per-chain form: DEXE_SUBGRAPH_INTERACTIONS_URL_<chainId>.",
    enablesFlows: ["subgraph-read"],
  },
  DEXE_SUBGRAPH_CHAIN_ID: {
    schema: intStr("the EVM chain id that the unsuffixed DEXE_SUBGRAPH_*_URL endpoints index", "56 for BSC mainnet"),
    category: "subgraph",
    required: false,
    example: "56",
    doc: "Which chain the unsuffixed DEXE_SUBGRAPH_*_URL endpoints index. Default 56 (BSC mainnet) — both the built-in endpoints and every documented DeXe subgraph are mainnet. Set this when your own endpoints index a different chain, so reads for other chains fail loudly instead of returning this chain's data.",
  },
  DEXE_GRAPH_API_KEY: {
    schema: z.string().optional(),
    category: "subgraph",
    required: false,
    example: "",
    doc: "The Graph API key for bearer auth (required by decentralized gateway).",
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

  // ─── diagnostics ─────────────────────────────────────────────────────────
  DEXE_DOCTOR_STRICT: {
    schema: enumStr(["1", "0"]),
    category: "dev",
    required: false,
    example: "1",
    doc: "Set to 1 to make `npx dexe-mcp doctor` exit 1 on warnings (same as --strict), for CI wrappers that cannot add a flag.",
  },
} as const satisfies Record<string, EnvEntry>;

export type ReadEnvKey = keyof typeof ENV_SPEC_READ;

/**
 * Pattern for dynamic per-chain RPC keys (DEXE_RPC_URL_1, DEXE_RPC_URL_10…).
 * Not in the spec because the suffix is open-ended.
 */
export const DYNAMIC_PER_CHAIN_RPC_RE = /^DEXE_RPC_URL_(\d+)$/;

/**
 * Pattern for dynamic per-chain subgraph keys —
 * `DEXE_SUBGRAPH_POOLS_URL_97`, `DEXE_SUBGRAPH_VALIDATORS_URL_56`, …
 * Capture 1 is the kind (upper-case), capture 2 is the chain id.
 *
 * Same open-ended-suffix reason as the RPC family: one endpoint indexes one
 * chain, and the set of chains a user may point at is not ours to enumerate.
 */
export const PER_CHAIN_SUBGRAPH_URL_RE = /^DEXE_SUBGRAPH_(POOLS|VALIDATORS|INTERACTIONS)_URL_(\d+)$/;

/**
 * Does this spec recognize the env var name? Answers for the spec's entries
 * **and** for the dynamic per-chain families, whose numeric suffix is
 * open-ended and so cannot be enumerated. The "unknown DEXE_* var" typo check
 * in env/loader.ts is the caller: a var listed here must never be reported as
 * a typo just because it carries a chain-id suffix.
 *
 * Deliberately not a type predicate — a per-chain key is recognized but is NOT
 * a spec entry, and narrowing it to a spec key would license a lookup that
 * returns undefined. Read entries with an explicit `hasOwnProperty` guard.
 */
export function isKnownEnvKey(k: string, spec: EnvSpec = ENV_SPEC_READ): boolean {
  return (
    Object.prototype.hasOwnProperty.call(spec, k) ||
    DYNAMIC_PER_CHAIN_RPC_RE.test(k) ||
    PER_CHAIN_SUBGRAPH_URL_RE.test(k)
  );
}

/**
 * The names of the vars the WRITE edition and the dev toolchain read — names
 * only, no schema, no docs. A read-only process shares a `.env` with the write
 * edition, so it treats these as FOREIGN: never parsed, never loaded into its
 * config, never reported as typos. tests/env/edition-spec.test.ts keeps this
 * list equal to the write and dev specs in ./schema.ts.
 */
export const FOREIGN_WRITE_ENV_KEYS: ReadonlySet<string> = new Set([
  "DEXE_TREASURY_GUARD",
  "DEXE_TX_WAIT_TIMEOUT_MS",
  "DEXE_PRIVATE_KEY",
  ...Array.from({ length: 16 }, (_, i) => `DEXE_AGENT_PK_${i + 1}`),
  "DEXE_AGENT_FUNDER_PK",
  "DEXE_AGENT_FUND_MAX_WEI",
  "DEXE_SIGNER_ALLOWLIST",
  "DEXE_SIGNER_MAX_VALUE_WEI",
  "DEXE_SIGNER_MAX_BROADCASTS_PER_MIN",
  "DEXE_PINATA_JWT",
  "DEXE_IPFS_AVATAR_GATEWAY",
  "DEXE_WALLETCONNECT_PROJECT_ID",
  "DEXE_WALLETCONNECT_RELAY_URL",
  "DEXE_WALLETCONNECT_APPROVAL_TIMEOUT_MS",
  "DEXE_SAFE_TX_SERVICE_URL",
  "DEXE_SAFE_API_KEY",
  "DEXE_SAFE_DELEGATECALL",
  "DEXE_MAX_DESCRIPTION_LEN",
  // dev toolchain
  "DEXE_PROTOCOL_PATH",
  "DEXE_FORK_BLOCK",
  "DEXE_PROTOCOL_REF",
]);

/**
 * Is `key` something only the write edition (or its test harness) reads — a
 * signing key, an agent key under either spelling, the keyring ledger, an
 * upload or WalletConnect credential, a dev-toolchain path?
 */
export function isWriteEnvKey(key: string): boolean {
  return (
    FOREIGN_WRITE_ENV_KEYS.has(key) ||
    /^(DEXE_)?AGENT_PK_\d+$/.test(key) ||
    key === "AGENT_FUNDER_PK" ||
    /^DEXE_AGENT_LEDGER/.test(key) ||
    /^SWARM_/.test(key)
  );
}

/**
 * Delete every write-edition var from `env`, in place, and return how many
 * went. The read edition's stdio binary calls this after loading `.env`: a
 * `.env` shared with the write edition puts signing keys into the process, and
 * nothing in a read-only process — a tool, a dependency, an error message —
 * should be able to read one back. (The HTTP server goes further and keeps an
 * allowlist: src/http/remoteEnv.ts.)
 */
export function dropWriteEnv(env: NodeJS.ProcessEnv = process.env): number {
  let removed = 0;
  for (const key of Object.keys(env)) {
    if (isWriteEnvKey(key)) {
      delete env[key];
      removed++;
    }
  }
  return removed;
}

/**
 * The env surface one edition reads: what its `.env` loading, its doctor and
 * its startup-issue rows walk. The read edition's is `READ_ENV_SURFACE`; the
 * single server passes the full one from ./schema.ts.
 */
export interface EnvSurface {
  /** Every var this edition reads, in display order. */
  readonly spec: EnvSpec;
  /** Recognized, but another edition's: silently ignored, never reported as a typo. */
  isForeign?(key: string): boolean;
  /** Category for a startup-issue key that is not a spec entry (a family name such as `DEXE_AGENT_PK_*`). */
  categoryOf?(key: string): EnvCategory | undefined;
}

export const READ_ENV_SURFACE: EnvSurface = {
  spec: ENV_SPEC_READ,
  isForeign: isWriteEnvKey,
};
