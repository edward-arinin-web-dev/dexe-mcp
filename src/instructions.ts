import { DEFAULT_TOOLSETS, defaultProfileToolNames } from "./tools/gate.js";
import { RESUME_SUMMARY } from "./lib/resumeContract.js";

/**
 * The skill directories shipped in `dexe-plugin/skills` (package.json `files`).
 *
 * Pinned at COMPILE time on purpose. The runtime layout differs between the npm
 * tree (`dist/instructions.js` → `../dexe-plugin/skills`) and the bundled plugin
 * (`dexe-plugin/server/index.mjs`, where that relative path does not exist), so
 * a `readdirSync` here would silently yield an EMPTY skill list in the handshake
 * for every plugin user — the primary install path.
 * `tests/instructions.test.ts` pins this constant to the real directory instead,
 * so adding a skill folder without adding it here fails CI.
 */
export const SHIPPED_SKILLS = [
  "dexe-agent-team",
  "dexe-create-dao",
  "dexe-create-proposal",
  "dexe-otc",
  "dexe-report",
  "dexe-setup",
  "dexe-staking",
  "dexe-vote-execute",
] as const;

/**
 * The MCP handshake `instructions` — the one block of text EVERY session reads
 * before it acts.
 *
 * Exported and DERIVED (not a literal) so it can never drift from the gate
 * again: the v0.31.0 narrowing of `DEFAULT_TOOLSETS` to `["core"]` left this
 * string claiming `'core,proposals'` for three releases, and an agent that
 * believes it plans a flow around `dexe_proposal_build_*` tools the session
 * never registered.
 *
 * Every tool named here that is NOT in the default profile carries the repo's
 * standard `(needs DEXE_TOOLSETS=core,<set>)` annotation, so the handshake can
 * be checked by the same machinery as the tool descriptions
 * (tests/instructions.test.ts, mirroring tests/tools/default-profile-references.test.ts).
 *
 * Pinned by `tests/instructions.test.ts`.
 */
export function serverInstructions(): string {
  const defaultCount = defaultProfileToolNames().size;
  return (
    "Tools for DeXe Protocol governance DAOs, plus dexe_gov_* (needs DEXE_TOOLSETS=core,governor) — a generic surface for external OpenZeppelin/Compound Governor DAOs. " +
    "For any MULTI-STEP request (create a DAO, launch a token economy, OTC sale, staking, distribution, pass a proposal) call dexe_guide FIRST — it returns the exact plan, the questions to ask the user with risk notes, and the known pitfalls. " +
    "Call dexe_context first WHEN you need orientation (signer, active chain, env readiness, DAOs/proposals from prior sessions) — skip it when the user already gave you the target DAO and chain. " +
    "Prefer the composite flow tools over hand-sequencing calldata: dexe_dao_create (deploy a DAO), dexe_proposal_create (ANY of the 33 catalog proposal types — pass proposalType + params), dexe_proposal_vote_and_execute (auto-deposits when power is short). " +
    "Amounts accept raw wei (digits-only) or human units with a decimal point ('12.5'); durations are seconds. " +
    "For images (DAO avatars): pass a LOCAL FILE PATH (avatarPath / newAvatarPath / filePath) and the server reads, validates, and pins it — never read image files or pass base64 through the conversation. " +
    "The composites handle approve→deposit→create sequencing, correct IPFS metadata, and the known deploy/proposal reverts; on partial failure they return the landed-steps ledger — fix the cause and re-run the same call. " +
    RESUME_SUMMARY +
    " " +
    "When depositing, ERC20.approve the UserKeeper, never GovPool. Validate DAO deploys on BSC testnet (chain 97). " +
    "Contract introspection — dexe_compile, dexe_get_abi, dexe_get_source, dexe_list_contracts, dexe_find_selector (needs DEXE_TOOLSETS=core,dev): run the compile step once per session before the reads. " +
    `The tool surface is gated by DEXE_TOOLSETS (default '${DEFAULT_TOOLSETS.join(",")}' — ${defaultCount} tools: the composites plus the zero-config reporting reads). ` +
    "The ~30 single-purpose dexe_proposal_build_* (needs DEXE_TOOLSETS=core,proposals) builders are NOT in it, and you do not need them: dexe_proposal_create covers every on-chain catalog type. " +
    "dexe_context reports which sets are off and what they unlock — check it BEFORE telling a user to edit DEXE_TOOLSETS. " +
    "Full intent→call recipes + error→remedy table: docs/PLAYBOOK.md (shipped in the package). " +
    "MCP resources: dexe://playbook (recipes + error remedies), dexe://graph-schema (subgraph entity reference for dexe_graph_query), dexe://tools (full tool catalog). " +
    `Recipe skills ship with the package (${SHIPPED_SKILLS.join(", ")}); dexe-agent-team also needs DEXE_TOOLSETS=core,agents plus hot keys. ` +
    "Installed automatically with the Claude Code plugin (`/plugin install dexe@dexe-mcp`), or copy them standalone with `npx dexe-mcp skills`."
  );
}
