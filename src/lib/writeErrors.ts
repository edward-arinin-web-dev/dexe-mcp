import {
  toActionableError as classify,
  mergeKnownFailures,
  READ_KNOWN_FAILURES,
  registerKnownFailures,
  type ActionableError,
  type KnownFailure,
  type KnownFailureRegistration,
} from "@dexe-network/dexe-mcp/core";

/**
 * The write edition's half of the actionable-error layer (the read edition's lib/errors.ts):
 * the failures only signing, broadcasting or pinning can raise, and the
 * write-side wording of failures a read can hit too — a timed-out receipt wait
 * is not a timed-out read, and the resume rule after a reverted or flaky
 * broadcast has to be spelled out leg by leg.
 *
 * Write tools import `toActionableError` from HERE, which always classifies
 * against the combined table. Loading this module also registers the write
 * table for the whole process (`registerKnownFailures`), so wherever write
 * code runs — the single server — the read tools beside it word every failure
 * exactly as the one combined table did before the split. Read code never
 * imports this file; a read-only server keeps the read table alone.
 */
export const WRITE_KNOWN_FAILURES: KnownFailureRegistration = {
  // Matched before every read entry, in this order.
  failures: [
    {
      match: /insufficient funds for (gas|intrinsic)/i,
      slug: "no-gas",
      what: "The signer wallet has no BNB to pay gas.",
      remedy:
        "Fund the signer address with BNB on the target chain (testnet 97: use a faucet, e.g. https://www.bnbchain.org/en/testnet-faucet), then re-run.",
    },
    {
      match: /nonce (too low|has already been used)|already known|replacement transaction underpriced/i,
      slug: "nonce-conflict",
      what: "A transaction with this nonce is already pending or mined.",
      remedy:
        "A previous broadcast is still settling. Check it with dexe_tx_status FIRST: if it succeeded that step is done " +
        "and a re-run continues after it; if it is still pending, wait ~15s and check again — do not re-send. " +
        "On re-run ERC20.approve / GovPool.deposit / createProposalAndVote / GovPool.vote are re-derived from chain " +
        "state and skipped; GovPool.execute and the validator round are NOT.",
    },
    {
      match: /user rejected|user denied|rejected by user/i,
      slug: "wallet-rejected",
      what: "The transaction was rejected in the wallet.",
      remedy: "Re-run the call and approve the request on the phone/wallet when it appears.",
    },
    {
      // `Pinata JWT is required` is what PinataClient throws when constructed
      // without a key — same root cause as a missing DEXE_PINATA_JWT, so it must
      // land here and not on the transient `pinata-failed` entry below.
      match: /DEXE_PINATA_JWT|Pinata JWT is required/i,
      slug: "pinata-missing",
      what: "IPFS uploads need a Pinata JWT and none is configured.",
      remedy:
        "1) Create a free API key at https://app.pinata.cloud/developers/api-keys with pinJSONToIPFS + pinFileToIPFS permissions. " +
        "2) Add DEXE_PINATA_JWT=<jwt> to the .env at the dexe-mcp root (never .claude.json). " +
        "3) Restart Claude Code (the .env is read once at startup). Or run /dexe-setup for a guided walkthrough.",
    },
    {
      // Bounded gap so the IPFS-gateway message ("…set a dedicated Pinata
      // gateway…") can't be mistaken for a pinning failure.
      match: /Pinata [\w ]{0,24}(failed|timed out)/i,
      slug: "pinata-failed",
      what:
        "Pinata (the IPFS pinning service) rejected or never answered the upload, so the metadata was NOT pinned.",
      remedy:
        "HTTP 401/403 means the DEXE_PINATA_JWT is wrong, revoked, or lacks the pinJSONToIPFS/pinFileToIPFS scopes — " +
        "mint a fresh key at https://app.pinata.cloud/developers/api-keys, put it in .env, and restart. " +
        "A 429 or a timeout is transient (check status.pinata.cloud): wait ~30s and re-run the SAME call — " +
        "ERC20.approve / GovPool.deposit / createProposalAndVote / GovPool.vote are re-derived from chain state and " +
        "skipped, so nothing is paid for twice. If a transaction was already broadcast (you have a hash), check " +
        "dexe_tx_status first.",
    },
  ],
  wording: {
    // The single server gates tools by DEXE_TOOLSETS, so its wording says which
    // profile each fallback read needs.
    "subgraph-failed": {
      remedy:
        "Re-run once (429/5xx/timeouts are usually transient). If it persists, read the same facts on-chain instead — " +
        "dexe_proposal_list / dexe_read_settings / dexe_dao_info need no indexer and are in the default profile; " +
        "dexe_read_gov_state (needs DEXE_TOOLSETS=core,dev) and dexe_read_multicall (needs DEXE_TOOLSETS=core,read) " +
        "cover the rest. " +
        "A 401/403/429 on the shipped default endpoint means you are sharing the packaged Graph key: get a free one at " +
        "thegraph.com/studio, set DEXE_SUBGRAPH_POOLS_URL / _VALIDATORS_URL / _INTERACTIONS_URL in .env, and restart. " +
        "Entity/field names for a hand-written query: call dexe_graph_schema (live introspection, default profile) " +
        "or read the dexe://graph-schema resource.",
    },
    "backend-failed": {
      remedy:
        "For reads, re-run: tools that can fall back serve the same call on-chain and report `degraded: true` (no token auto-discovery, no USD). " +
        "For off-chain proposals/votes there is no on-chain fallback — the backend is the system of record, so wait and retry. " +
        "A 401 means the Bearer token expired: re-run dexe_auth_login (needs DEXE_TOOLSETS=core,proposals) to mint a new one. " +
        "Point DEXE_BACKEND_API_URL at another host only if you run your own.",
    },
    "rpc-timeout": {
      remedy:
        "No state was changed by a timed-out READ — re-run it. If a WRITE timed out while waiting for a receipt, do NOT re-send blindly: " +
        "check it with dexe_tx_status first, it may still land. A public endpoint that keeps stalling will not improve: set your own " +
        "DEXE_RPC_URL_MAINNET / DEXE_RPC_URL_TESTNET (Alchemy/QuickNode/Ankr) in .env and restart. " +
        "The receipt-wait budget is tunable via DEXE_TX_WAIT_TIMEOUT_MS.",
    },
    "rpc-flaky": {
      remedy:
        "Re-run the call; ERC20.approve / GovPool.deposit / createProposalAndVote / GovPool.vote are re-derived from " +
        "chain state and skipped. If the failure came after a broadcast (you have a tx hash), check dexe_tx_status " +
        "first — GovPool.execute and the validator round are NOT auto-skipped. For reliability set a private endpoint " +
        "in .env (DEXE_RPC_URL_MAINNET / DEXE_RPC_URL_TESTNET, e.g. Alchemy/QuickNode/Ankr) and restart.",
    },
    "onchain-revert": {
      what: "The transaction reverted on-chain (state was NOT changed by this step).",
      remedy:
        "Read the revert reason above if present. Common causes: proposal not in the required state " +
        "(check dexe_proposal_state), tokens locked in an active proposal (withdraw between proposals), " +
        "or a blacklisted recipient. Fix the cause and re-run — ERC20.approve / GovPool.deposit / " +
        "createProposalAndVote / GovPool.vote are re-derived and skipped; GovPool.execute and the validator round " +
        "are NOT, so check dexe_proposal_state before re-running one of those.",
    },
  },
};

/**
 * The read table with the write table on top — what the single server has
 * always classified against, slug for slug and word for word. The standalone
 * server's (DEXE_WRITE_STANDALONE=1) table.
 */
export const COMBINED_KNOWN_FAILURES: readonly KnownFailure[] = mergeKnownFailures(
  READ_KNOWN_FAILURES,
  WRITE_KNOWN_FAILURES,
);

const readRemedy = (slug: string): string => READ_KNOWN_FAILURES.find((k) => k.slug === slug)!.remedy;

/**
 * The write-only server's table (the 1.0.0 default): the same failures, but
 * every read tool a remedy names is the read server's, so it is marked
 * `(read server)` (src/editions.ts READ_SERVER_MARK) and carries no
 * `DEXE_TOOLSETS` annotation — that profile switch belongs to the standalone
 * server. Includes the read failure whose read-edition remedy names read
 * tools (`subgraph-orphan-relation`), which the standalone table leaves as the
 * read edition words it. docs/PLAYBOOK.md renders this table: it is the
 * default setup's.
 */
export const WRITE_ONLY_KNOWN_FAILURES_REGISTRATION: KnownFailureRegistration = {
  failures: WRITE_KNOWN_FAILURES.failures,
  wording: {
    ...WRITE_KNOWN_FAILURES.wording,
    "subgraph-orphan-relation": {
      remedy:
        "Do NOT retry — it will fail identically. The DAO-level reads drop the broken relation and answer anyway with " +
        "`indexerWarning` / `degraded` set (dexe_read_dao_members, dexe_read_dao_experts, dexe_proposal_voters, " +
        "dexe_dao_report (read server)), so prefer those over a hand-written dexe_graph_query (read server). For a " +
        "hand-written query, remove the named relation from the selection set (leave at least one unconditional field " +
        "in its parent) and re-send. On-chain reads are unaffected: dexe_proposal_list / dexe_read_settings / " +
        "dexe_dao_info (read server) need no indexer at all.",
    },
    "subgraph-failed": {
      remedy:
        "Re-run once (429/5xx/timeouts are usually transient). If it persists, read the same facts on-chain instead — " +
        "dexe_proposal_list / dexe_read_settings / dexe_dao_info / dexe_read_gov_state / dexe_read_multicall " +
        "(read server) need no indexer. " +
        "A 401/403/429 on the shipped default endpoint means you are sharing the packaged Graph key: get a free one at " +
        "thegraph.com/studio, set DEXE_SUBGRAPH_POOLS_URL / _VALIDATORS_URL / _INTERACTIONS_URL in .env, and restart. " +
        "Entity/field names for a hand-written query: dexe_graph_schema (read server) or the dexe://graph-schema resource.",
    },
    "onchain-revert": {
      what: "The transaction reverted on-chain (state was NOT changed by this step).",
      remedy:
        "Read the revert reason above if present. Common causes: proposal not in the required state " +
        "(check dexe_proposal_state (read server)), tokens locked in an active proposal (withdraw between proposals), " +
        "or a blacklisted recipient. Fix the cause and re-run — ERC20.approve / GovPool.deposit / " +
        "createProposalAndVote / GovPool.vote are re-derived and skipped; GovPool.execute and the validator round " +
        "are NOT, so check dexe_proposal_state (read server) before re-running one of those.",
    },
  },
};

export const WRITE_ONLY_KNOWN_FAILURES: readonly KnownFailure[] = mergeKnownFailures(
  READ_KNOWN_FAILURES,
  WRITE_ONLY_KNOWN_FAILURES_REGISTRATION,
);

/**
 * The standalone registration with every slug the write-only one rewords, so
 * switching modes in one process (tests) can never leave a write-only remedy
 * behind: `registerKnownFailures` merges wording into what is already there.
 */
const STANDALONE_REGISTRATION: KnownFailureRegistration = {
  failures: WRITE_KNOWN_FAILURES.failures,
  wording: {
    "subgraph-orphan-relation": { remedy: readRemedy("subgraph-orphan-relation") },
    ...WRITE_KNOWN_FAILURES.wording,
  },
};

let activeTable: readonly KnownFailure[] = COMBINED_KNOWN_FAILURES;

/**
 * Put this server's wording in force for the process — the table
 * `toActionableError` uses here and the one the read register functions
 * classify against. Called by `registerAll` with the server's mode; until then
 * (a module imported outside a server) the standalone table applies, which is
 * what this module registered before 1.0.0.
 */
export function useWriteFailureWording(config: { writeStandalone?: boolean }): void {
  registerKnownFailures(config.writeStandalone ? STANDALONE_REGISTRATION : WRITE_ONLY_KNOWN_FAILURES_REGISTRATION);
  activeTable = config.writeStandalone ? COMBINED_KNOWN_FAILURES : WRITE_ONLY_KNOWN_FAILURES;
}

registerKnownFailures(STANDALONE_REGISTRATION);

/** The table write tools classify against right now. */
export function writeKnownFailures(): readonly KnownFailure[] {
  return activeTable;
}

/**
 * `toActionableError` for write tools: classifies against this server's table
 * (`useWriteFailureWording`) whether or not anything else registered it.
 */
export function toActionableError(err: unknown, step?: string): ActionableError {
  return classify(err, step, activeTable);
}
