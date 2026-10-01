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
 * BUDGET: `INSTRUCTIONS_MAX_CHARS`. Claude Code cuts the handshake at 2,048
 * characters (measured 2026-10-01: the 0.34.x text was 3,129 and arrived ending
 * "run the compile step once p… [truncated]"), so everything after that point
 * — the default profile, the resources, the skills — never reached the model.
 * Order is priority: what an agent must do first comes first, and anything a
 * tool can report on demand (`dexe_context`, `dexe://playbook`) is named, not
 * restated.
 *
 * Pinned by `tests/instructions.test.ts`.
 */
export const INSTRUCTIONS_MAX_CHARS = 2048;

export function serverInstructions(): string {
  const defaultCount = defaultProfileToolNames().size;
  return (
    "Tools for DeXe Protocol governance DAOs, plus dexe_gov_* (needs DEXE_TOOLSETS=core,governor) for external OpenZeppelin/Compound Governors. " +
    "For any MULTI-STEP request (create a DAO, token sale, staking, pass a proposal) call dexe_guide FIRST: it returns the plan, the questions to ask the user, and the known pitfalls. " +
    "Call dexe_context when you need orientation (signer, chain, env readiness, known DAOs, which toolsets are off) — skip it when the user already named the DAO and chain. " +
    "Prefer the composites over hand-sequenced calldata: dexe_dao_create, dexe_proposal_create (any of the 33 proposal types — proposalType + params), dexe_proposal_vote_and_execute (auto-deposits). " +
    "On partial failure they return the landed-steps ledger — fix the cause and re-run the same call. " +
    RESUME_SUMMARY +
    " " +
    "Amounts: composites and proposal builders take raw wei (digits only) or human units with a decimal point ('12.5'); dexe_vote_build_* take RAW base units only. Durations are seconds. " +
    "Images: pass a LOCAL FILE PATH, never base64 through the conversation. " +
    "ERC20.approve the UserKeeper, never GovPool. Validate DAO deploys on BSC testnet (chain 97). " +
    `The tool surface is gated by DEXE_TOOLSETS (default '${DEFAULT_TOOLSETS.join(",")}' — ${defaultCount} tools). ` +
    "dexe_proposal_build_* (needs DEXE_TOOLSETS=core,proposals) are off and not needed: dexe_proposal_create covers every type. " +
    "dexe_compile, dexe_get_abi, dexe_find_selector (needs DEXE_TOOLSETS=core,dev): compile once before the reads. " +
    "Recipes and error remedies: resource dexe://playbook; full catalog: dexe://tools. " +
    `Skills: ${SHIPPED_SKILLS.join(", ")}; dexe-agent-team needs DEXE_TOOLSETS=core,agents plus hot keys.`
  );
}
