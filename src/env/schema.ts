import { z } from "zod";
import { resolveTreasuryGuardMode, TREASURY_GUARD_MODES } from "../lib/treasuryGate.js";
import { SIGNER_MODES } from "../lib/signerMode.js";
import {
  ENV_SPEC_READ,
  enumStr,
  intStr,
  isKnownEnvKey as isKnownInSpec,
  urlStr,
  type EnvCategory,
  type EnvEntry,
  type EnvSpec,
  type EnvSurface,
} from "./schemaRead.js";

/**
 * Single source of truth for every DEXE_* env var the single server
 * recognizes: the read edition's vars (./schemaRead.ts), the write edition's
 * (`ENV_SPEC_WRITE` below) and the dev toolchain's (`ENV_SPEC_DEV`), combined
 * into `ENV_SPEC` in one fixed display order.
 *
 * Consumed by:
 *   - `src/config.ts`      — `loadConfig` validates the whole surface at startup
 *   - `src/index.ts`       — `.env` loading recognizes the whole surface
 *   - `src/diag/writeChecks.ts` — `dexe_doctor` walks the whole surface
 *   - `src/lib/signer.ts`, write tools — remediation hints for write vars
 *
 * To add a new env var: add an entry to the read spec (./schemaRead.ts) or
 * here, place it in `ENV_DISPLAY_ORDER`, update docs/ENVIRONMENT.md, and the
 * parity test in tests/env/schema.test.ts will require .env.example to
 * mention it. Categories drive the .env.example layout and doctor output
 * grouping. A write or dev var also goes into `FOREIGN_WRITE_ENV_KEYS` in
 * ./schemaRead.ts (tests/env/edition-spec.test.ts checks both lists).
 */

export {
  DYNAMIC_PER_CHAIN_RPC_RE,
  PER_CHAIN_SUBGRAPH_URL_RE,
  subgraphUrlStr,
  type EnvCategory,
  type EnvEntry,
  type EnvFlow,
  type EnvSpec,
  type EnvSurface,
} from "./schemaRead.js";

const hex64 = /^0x[0-9a-fA-F]{64}$/;

/** Hot EOA key. The value never reaches the message — parse.ts redacts secrets. */
const privateKeyStr = () => {
  const msg = "must be a 0x-prefixed 64-hex private key (66 characters total), e.g. 0xabc…(64 hex chars)";
  return z.string().regex(hex64, msg).optional().describe(msg);
};

const TREASURY_GUARD_MSG = `must be one of ${TREASURY_GUARD_MODES.join(" | ")}, e.g. warn`;
const UNATTENDED_CHAINS_MSG = "must be a comma-separated list of chain ids (digits only), e.g. 97 or 97,56";
const KEYSTORE_ADDRESS_MSG = "must be a 0x-prefixed 40-hex EVM address (42 characters total), e.g. 0xAbc…(40 hex chars)";

/** The write edition's vars: signing, broadcast guards, uploads, WalletConnect, Safe, the treasury guard. */
export const ENV_SPEC_WRITE = {
  DEXE_TREASURY_GUARD: {
    // Validated by the SAME parser the config and every tool call resolve with
    // (`resolveTreasuryGuardMode`), so this layer cannot reject a posture the
    // runtime honours. A hardcoded `off|warn` enum here rejected `block` as
    // malformed — deleting the value and degrading the operator to `warn`
    // while `treasuryGuardMode()` still reported `block`.
    schema: z
      .string()
      .refine((v) => resolveTreasuryGuardMode(v).issue === undefined, TREASURY_GUARD_MSG)
      .optional()
      .describe(TREASURY_GUARD_MSG),
    category: "core",
    required: false,
    example: "warn",
    doc: "Treasury-safety posture: off | warn | block. 'warn' (default) emits advisories/alerts everywhere (build, deploy, execute, risk_assess) but NEVER blocks; 'block' additionally REFUSES a deploy/execute whose treasury-safety checks failed; 'off' silences them.",
  },
  DEXE_TX_WAIT_TIMEOUT_MS: {
    schema: intStr("a timeout in milliseconds", "180000 for 3 minutes"),
    category: "rpc",
    required: false,
    example: "180000",
    doc: "Max milliseconds to wait for a broadcast tx to mine before returning a check-with-dexe_tx_status error. Default 180000 (3 min).",
  },

  // ─── signer ──────────────────────────────────────────────────────────────
  DEXE_SIGNER_MODE: {
    schema: enumStr(SIGNER_MODES),
    category: "signer",
    required: false,
    example: "walletconnect",
    doc:
      "How this server signs: walletconnect (default — the phone wallet signs) | keystore (encrypted local key; the owner " +
      "approves every batch with its password on a local page) | readonly (never signs) | unattended (hot keys, NO human " +
      "confirmation, only on DEXE_UNATTENDED_CHAINS). Unset + a hot key = unattended by a DEPRECATED implicit default that flips in the next major.",
    enablesFlows: ["broadcast"],
  },
  DEXE_PRIVATE_KEY: {
    schema: privateKeyStr(),
    category: "signer",
    required: false,
    example: "0x<64-hex>",
    doc:
      "Hot EOA key — read ONLY in DEXE_SIGNER_MODE=unattended (or the deprecated implicit default). Plaintext on disk; " +
      "move it into the encrypted keystore with `dexe-mcp key import --from-env`. Requires an RPC.",
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
  DEXE_UNATTENDED_CHAINS: {
    schema: z
      .string()
      .regex(/^\s*\d+\s*(,\s*\d+\s*)*$/, UNATTENDED_CHAINS_MSG)
      .optional()
      .describe(UNATTENDED_CHAINS_MSG),
    category: "signer",
    required: false,
    example: "97",
    doc:
      "Chains unattended mode may sign on, comma-separated. Default 97 (BSC testnet) when DEXE_SIGNER_MODE=unattended is " +
      "explicit. Mainnet only if you list 56 — and set DEXE_SIGNER_ALLOWLIST / DEXE_SIGNER_MAX_VALUE_WEI with it.",
  },
  DEXE_KEYSTORE_PATH: {
    schema: z.string().optional(),
    category: "signer",
    required: false,
    example: "",
    doc: "Keystore directory, or one keystore file. Default ~/.dexe-mcp/keystore. Created by `dexe-mcp key create` / `key import`.",
  },
  DEXE_KEYSTORE_ADDRESS: {
    schema: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/, KEYSTORE_ADDRESS_MSG)
      .optional()
      .describe(KEYSTORE_ADDRESS_MSG),
    category: "signer",
    required: false,
    example: "",
    doc: "Which keystore to sign with when the directory holds several (the address it holds).",
  },
  DEXE_APPROVAL_WAIT_MS: {
    schema: intStr("a wait in milliseconds", "120000 for 2 minutes"),
    category: "signer",
    required: false,
    example: "120000",
    doc:
      "Keystore mode: how long a tool call waits for the owner to approve before returning `awaiting_approval` " +
      "(then re-run the same call). Default 120000, max 600000; 0 = return at once.",
  },
  DEXE_APPROVAL_TTL_S: {
    schema: intStr("a lifetime in seconds", "900 for 15 minutes"),
    category: "signer",
    required: false,
    example: "900",
    doc: "Keystore mode: how long an approval link (and an approved-but-unused batch) stays valid. Default 900, range 60–3600.",
  },
  DEXE_APPROVAL_OPEN_BROWSER: {
    schema: enumStr(["1", "0", "true", "false"]),
    category: "signer",
    required: false,
    example: "1",
    doc: "Keystore mode: open the approval page in the default browser automatically. Default 1; 0 only prints the link.",
  },
  DEXE_KEYSTORE_PASSWORD_FILE: {
    schema: z.string().optional(),
    category: "signer",
    required: false,
    example: "",
    doc:
      "Unattended/CI only: a file holding the keystore password, so DEXE_SIGNER_MODE=unattended can sign with the keystore " +
      "instead of a plaintext DEXE_PRIVATE_KEY. Ignored in keystore mode, which never reads a password from a file.",
  },

  // ─── ipfs (uploads) ──────────────────────────────────────────────────────
  DEXE_PINATA_JWT: {
    schema: z.string().optional(),
    category: "ipfs",
    required: false,
    example: "eyJhbGciOiJIUzI1NiIs...",
    doc: "Pinata pinning JWT. Required for IPFS uploads; reads work without it.",
    enablesFlows: ["ipfs-upload", "dao-deploy"],
    secret: true,
  },
  DEXE_IPFS_AVATAR_GATEWAY: {
    schema: urlStr("https://gateway.pinata.cloud"),
    category: "ipfs",
    required: false,
    example: "",
    doc: "Optional override for the avatar fetch gateway.",
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
  DEXE_SAFE_DELEGATECALL: {
    schema: enumStr(["block"]),
    category: "safe",
    required: false,
    example: "block",
    doc: "Set to `block` to forbid Safe DELEGATECALL (operation=1) outright, overriding the per-call allowDelegateCall flag.",
  },

  DEXE_MAX_DESCRIPTION_LEN: {
    schema: intStr("a character count", "20000"),
    category: "core",
    required: false,
    example: "20000",
    doc: "Max characters accepted for proposal/DAO description markdown before conversion (guards IPFS payload size). Default 20000.",
  },
} as const satisfies Record<string, EnvEntry>;

/** The dev toolchain's vars (dexe_compile / dexe_test and the protocol checkout). */
export const ENV_SPEC_DEV = {
  DEXE_PROTOCOL_PATH: {
    schema: z.string().optional(),
    category: "core",
    required: false,
    example: "",
    doc: "Override the DeXe-Protocol checkout path. Auto-managed when unset.",
  },
  DEXE_FORK_BLOCK: {
    schema: intStr("a block number", "45000000"),
    category: "dev",
    required: false,
    example: "",
    doc: "Optional fork block pin (Phase B).",
  },
  DEXE_PROTOCOL_REF: {
    schema: z.string().optional(),
    category: "dev",
    required: false,
    example: "",
    doc: "Git ref (branch/tag/commit) checked out for the auto-managed DeXe-Protocol clone. Default: the pinned release the MCP ships with.",
  },
} as const satisfies Record<string, EnvEntry>;

const ALL_ENTRIES = { ...ENV_SPEC_READ, ...ENV_SPEC_WRITE, ...ENV_SPEC_DEV };

export type EnvKey = keyof typeof ENV_SPEC_READ | keyof typeof ENV_SPEC_WRITE | keyof typeof ENV_SPEC_DEV;

/**
 * The order the single server has always walked the env surface in: startup
 * validation messages, doctor's presence rows and the "set in the MCP host
 * env block" list all follow it. Kept from before the read/write split so
 * none of that output moved. tests/env/edition-spec.test.ts checks it names
 * every entry of the three specs exactly once.
 */
export const ENV_DISPLAY_ORDER: readonly string[] = [
  "DEXE_PROTOCOL_PATH",
  "DEXE_MIN_SAFE_QUORUM_PCT",
  "DEXE_TREASURY_GUARD",
  "DEXE_CONTROLLING_TOPN",
  "DEXE_MAX_RESPONSE_BYTES",
  "DEXE_TOOLSETS",
  "DEXE_STATE_PATH",
  "DEXE_ENV_FILE",
  "DEXE_DEBUG",
  "DEXE_RPC_URL",
  "DEXE_CHAIN_ID",
  "DEXE_RPC_URL_TESTNET",
  "DEXE_RPC_URL_MAINNET",
  "DEXE_RPC_TIMEOUT_MS",
  "DEXE_TX_WAIT_TIMEOUT_MS",
  "DEXE_DEFAULT_CHAIN_ID",
  "DEXE_CONTRACTS_REGISTRY",
  "DEXE_DISABLE_PUBLIC_RPC",
  "DEXE_SIGNER_MODE",
  "DEXE_PRIVATE_KEY",
  ...Array.from({ length: 16 }, (_, i) => `DEXE_AGENT_PK_${i + 1}`),
  "DEXE_AGENT_FUNDER_PK",
  "DEXE_AGENT_FUND_MAX_WEI",
  "DEXE_SIGNER_ALLOWLIST",
  "DEXE_SIGNER_MAX_VALUE_WEI",
  "DEXE_SIGNER_MAX_BROADCASTS_PER_MIN",
  "DEXE_UNATTENDED_CHAINS",
  "DEXE_KEYSTORE_PATH",
  "DEXE_KEYSTORE_ADDRESS",
  "DEXE_APPROVAL_WAIT_MS",
  "DEXE_APPROVAL_TTL_S",
  "DEXE_APPROVAL_OPEN_BROWSER",
  "DEXE_KEYSTORE_PASSWORD_FILE",
  "DEXE_PINATA_JWT",
  "DEXE_IPFS_GATEWAY",
  "DEXE_IPFS_GATEWAYS_FALLBACK",
  "DEXE_IPFS_DISABLE_PUBLIC_FALLBACK",
  "DEXE_IPFS_MAX_BYTES",
  "DEXE_PINATA_GATEWAY_TOKEN",
  "DEXE_IPFS_AVATAR_GATEWAY",
  "DEXE_SUBGRAPH_POOLS_URL",
  "DEXE_SUBGRAPH_VALIDATORS_URL",
  "DEXE_SUBGRAPH_INTERACTIONS_URL",
  "DEXE_SUBGRAPH_CHAIN_ID",
  "DEXE_GRAPH_API_KEY",
  "DEXE_WALLETCONNECT_PROJECT_ID",
  "DEXE_WALLETCONNECT_RELAY_URL",
  "DEXE_WALLETCONNECT_APPROVAL_TIMEOUT_MS",
  "DEXE_SAFE_TX_SERVICE_URL",
  "DEXE_SAFE_API_KEY",
  "DEXE_SAFE_DELEGATECALL",
  "DEXE_BACKEND_API_URL",
  "DEXE_FORK_BLOCK",
  "DEXE_MAX_DESCRIPTION_LEN",
  "DEXE_PROTOCOL_REF",
  "DEXE_DOCTOR_STRICT",
];

/**
 * Rebuild `entries` with its keys in `order`. A key missing from `order` is
 * appended rather than dropped — a var must never vanish from validation over
 * an ordering slip (the edition-spec test fails on it instead).
 */
function inDisplayOrder<T extends EnvSpec>(entries: T, order: readonly string[]): T {
  const out: Record<string, EnvEntry> = {};
  for (const k of order) {
    if (Object.prototype.hasOwnProperty.call(entries, k)) out[k] = entries[k]!;
  }
  for (const k of Object.keys(entries)) {
    if (!(k in out)) out[k] = entries[k]!;
  }
  return out as T;
}

/** Every var the single server recognizes — read + write + dev — in display order. */
export const ENV_SPEC: typeof ALL_ENTRIES = inDisplayOrder(ALL_ENTRIES, ENV_DISPLAY_ORDER);

/**
 * Re-export with the structural interface so consumers see optional fields
 * (`secret`, `enablesFlows`). `as const` narrows literals but hides any field
 * not present on every entry, which trips `.secret`/`.enablesFlows` reads.
 */
export const ENV_REGISTRY: Record<EnvKey, EnvEntry> = ENV_SPEC;

/**
 * Does the single server recognize this env var name? The full spec plus the
 * dynamic per-chain families (see `isKnownEnvKey` in ./schemaRead.ts).
 */
export function isKnownEnvKey(k: string): boolean {
  return isKnownInSpec(k, ENV_SPEC);
}

export function envKeys(): EnvKey[] {
  return Object.keys(ENV_SPEC) as EnvKey[];
}

/**
 * Startup-issue keys that are family names, not spec entries — the keyring
 * degrades as `DEXE_AGENT_PK_*` / `DEXE_AGENT_PK_* (agent3)`. Filed with the
 * signer rows, where the user is looking.
 */
function signerFamilyCategory(key: string): EnvCategory | undefined {
  if (key.includes("SIGNER") || key.includes("AGENT_PK") || key.includes("PRIVATE_KEY")) return "signer";
  return undefined;
}

/** The single server's env surface: everything, nothing foreign. */
export const FULL_ENV_SURFACE: EnvSurface = {
  spec: ENV_SPEC,
  categoryOf: signerFamilyCategory,
};
