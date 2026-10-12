import { DEFAULT_TOOLSETS, WRITE_EDITION_TOOLSETS, defaultProfileToolNames } from "./tools/gate.js";
import { defaultToolNames } from "./tools/toolsets.js";
import { RESUME_SUMMARY } from "./lib/resumeContract.js";
import { READ_SKILLS } from "./instructions.js";

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

/** The write edition's skills: every shipped skill the read edition does not own. */
export const WRITE_SKILLS: readonly string[] = SHIPPED_SKILLS.filter(
  (s) => !(READ_SKILLS as readonly string[]).includes(s),
);

/**
 * The single server's MCP handshake `instructions` — the one block of text
 * EVERY session reads before it acts.
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
 * Budget: `INSTRUCTIONS_MAX_CHARS` (src/instructions.ts). The per-edition texts
 * are `readInstructions()` (src/instructions.ts) and `writeInstructions()`
 * below; this one is pinned byte-for-byte while the single server ships.
 */
export function serverInstructions(): string {
  const defaultCount = defaultProfileToolNames().size;
  return (
    "Tools for DeXe Protocol governance DAOs, plus dexe_gov_* (needs DEXE_TOOLSETS=core,governor) for external OpenZeppelin/Compound Governors. " +
    "For any MULTI-STEP request (create a DAO, token sale, staking, pass a proposal) call dexe_guide FIRST: it returns the plan, the questions to ask the user, and the known pitfalls. " +
    "Orientation: dexe_context (chain, env readiness, known DAOs, toolsets off); dexe_write_context (signer, keyring, upload posture). Skip both when the user already named the DAO and chain. " +
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

/**
 * The write edition's handshake: the single server's text minus the read
 * material. It names write tools only — the reads, the report and the flow
 * guide belong to the DeXe read server, which it points at without naming its
 * tools. The toolset sentence is derived from the write edition's own table.
 */
export function writeInstructions(): string {
  const defaultCount = defaultToolNames(WRITE_EDITION_TOOLSETS).size;
  return (
    "Tools that build, sign and send DeXe Protocol governance transactions, plus dexe_gov_build_* (needs " +
    "DEXE_TOOLSETS=core,governor) for external OpenZeppelin/Compound Governors. " +
    "DAO data, reports and the step-by-step flow plans come from the DeXe read server — install it next to this " +
    "one; plan any MULTI-STEP request (create a DAO, token sale, staking, pass a proposal) with its guide or the " +
    "dexe-flow-* prompts first. " +
    "Orientation: dexe_write_context (signer, keyring, upload posture, an unfinished flow). " +
    "Prefer the composites over hand-sequenced calldata: dexe_dao_create, dexe_proposal_create (any of the 33 proposal types — proposalType + params), dexe_proposal_vote_and_execute (auto-deposits). " +
    "On partial failure they return the landed-steps ledger — fix the cause and re-run the same call. " +
    RESUME_SUMMARY +
    " " +
    "Amounts: composites and proposal builders take raw wei (digits only) or human units with a decimal point ('12.5'); dexe_vote_build_* take RAW base units only. Durations are seconds. " +
    "Images: pass a LOCAL FILE PATH, never base64 through the conversation. " +
    "ERC20.approve the UserKeeper, never GovPool. Validate DAO deploys on BSC testnet (chain 97). " +
    `The tool surface is gated by DEXE_TOOLSETS (default '${WRITE_EDITION_TOOLSETS.defaults.join(",")}' — ${defaultCount} tools). ` +
    "dexe_proposal_build_* (needs DEXE_TOOLSETS=core,proposals) are off and not needed: dexe_proposal_create covers every type. " +
    "dexe_compile, dexe_get_abi, dexe_find_selector (needs DEXE_TOOLSETS=core,dev): compile once before the reads. " +
    "Recipes and error remedies: resource dexe://playbook. " +
    `Skills: ${WRITE_SKILLS.join(", ")}; dexe-agent-team needs DEXE_TOOLSETS=core,agents plus hot keys.`
  );
}
