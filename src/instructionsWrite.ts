import { DEFAULT_TOOLSETS, WRITE_EDITION_TOOLSETS, defaultProfileToolNames } from "./tools/gate.js";
import { defaultToolNames, READ_SKILLS } from "@dexe-network/dexe-mcp/core";
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

/** The write edition's skills: every shipped skill the read edition does not own. */
export const WRITE_SKILLS: readonly string[] = SHIPPED_SKILLS.filter(
  (s) => !(READ_SKILLS as readonly string[]).includes(s),
);

/** The handshake for this server's mode: the single server's text standalone, the write edition's otherwise. */
export function instructionsFor(config: { writeStandalone?: boolean }): string {
  return config.writeStandalone ? serverInstructions() : writeInstructions();
}

/**
 * The keystore-mode rule, in both handshakes. The model must never be the
 * channel the password travels through, and an `awaiting_approval` result is
 * not a failure to retry around.
 */
export const KEYSTORE_INSTRUCTION =
  "Keystore: on awaiting_approval ask the user to approve on the local page, then re-run the same call; never ask for the password.";

/**
 * The single server's MCP handshake `instructions` — the one block of text
 * EVERY session reads before it acts. Since 1.0.0 the standalone server's
 * (`DEXE_WRITE_STANDALONE=1`): it registers the read tools it names, and its
 * `dexe_guide` serves the write flows, so the 0.37 text stays true there.
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
 * Budget: `INSTRUCTIONS_MAX_CHARS` (the read edition's instructions.ts). The per-edition texts
 * are `readInstructions()` (the read edition's instructions.ts) and `writeInstructions()`
 * below; this one stays the 0.37 text for the standalone server (its default
 * tool count is derived, so it moved 46 → 48 with the write guide and doctor).
 */
export function serverInstructions(): string {
  const defaultCount = defaultProfileToolNames().size;
  return (
    "Tools for DeXe Protocol governance DAOs, plus dexe_gov_* (needs DEXE_TOOLSETS=core,governor) for external OpenZeppelin/Compound Governors. " +
    "For any MULTI-STEP request (create a DAO, token sale, staking, pass a proposal) call dexe_guide FIRST: it returns the plan, the questions to ask and the pitfalls. " +
    "Orientation: dexe_context (chain, env, known DAOs, toolsets off); dexe_write_context (signer, keyring, uploads) — skip both when the user named the DAO and chain. " +
    "Prefer the composites: dexe_dao_create, dexe_proposal_create (any of the 33 proposal types — proposalType + params), dexe_proposal_vote_and_execute (auto-deposits). " +
    "On partial failure they return the landed-steps ledger — fix the cause and re-run the same call. " +
    RESUME_SUMMARY +
    " " +
    "Amounts: composites/proposal builders take raw wei (digits only) or human units with a decimal point ('12.5'); dexe_vote_build_* take RAW base units only. Durations are seconds. " +
    "Images: pass a LOCAL FILE PATH, never base64. " +
    "ERC20.approve the UserKeeper, never GovPool. Validate DAO deploys on BSC testnet (chain 97). " +
    KEYSTORE_INSTRUCTION +
    " " +
    `Tools are gated by DEXE_TOOLSETS (default '${DEFAULT_TOOLSETS.join(",")}' — ${defaultCount} tools). ` +
    "dexe_proposal_build_* (needs DEXE_TOOLSETS=core,proposals) are off and not needed: dexe_proposal_create covers every type. " +
    "dexe_compile, dexe_get_abi, dexe_find_selector (needs DEXE_TOOLSETS=core,dev): compile once before the reads. " +
    "Recipes + error remedies: dexe://playbook; catalog: dexe://tools. " +
    `Skills: ${SHIPPED_SKILLS.join(", ")}; dexe-agent-team needs DEXE_TOOLSETS=core,agents plus hot keys.`
  );
}

/**
 * The write-only server's handshake (the 1.0.0 default): the single server's
 * text minus the read material. It names write tools only — the reads and the
 * report are the DeXe read server's, which it points at by name without naming
 * its tools; the flow plans are this server's `dexe_write_guide`. The toolset
 * sentence is derived from the write edition's own table.
 */
export function writeInstructions(): string {
  const defaultCount = defaultToolNames(WRITE_EDITION_TOOLSETS).size;
  return (
    "Tools that build, sign and send DeXe Protocol governance transactions, plus dexe_gov_build_* (needs " +
    "DEXE_TOOLSETS=core,governor) for OpenZeppelin/Compound Governors. " +
    "Reads come from the DeXe read server (dexe-mcp-read) beside this one; tools marked (read server) are its. " +
    "For any MULTI-STEP request (create a DAO, token sale, staking, pass a proposal) call dexe_write_guide FIRST: " +
    "plan, questions, pitfalls. " +
    "Orientation: dexe_write_context (signer, keyring, recorded DAOs, unfinished flow); setup: dexe_write_doctor. " +
    "Prefer the composites: dexe_dao_create, dexe_proposal_create (any of the 33 proposal types — proposalType + params), dexe_proposal_vote_and_execute (auto-deposits). " +
    "On partial failure they return the landed-steps ledger — fix the cause and re-run the same call. " +
    RESUME_SUMMARY +
    " " +
    "Amounts: composites/proposal builders take raw wei (digits only) or human units with a decimal point ('12.5'); dexe_vote_build_* take RAW base units only. Durations are seconds. " +
    "Images: pass a LOCAL FILE PATH, never base64. " +
    "ERC20.approve the UserKeeper, never GovPool. Validate DAO deploys on BSC testnet (chain 97). " +
    KEYSTORE_INSTRUCTION +
    " " +
    `Tools are gated by DEXE_TOOLSETS (default '${WRITE_EDITION_TOOLSETS.defaults.join(",")}' — ${defaultCount} tools). ` +
    "dexe_proposal_build_* (needs DEXE_TOOLSETS=core,proposals) are off and not needed: dexe_proposal_create covers every type. " +
    "dexe_compile, dexe_get_abi (needs DEXE_TOOLSETS=core,dev): compile once first. " +
    "Recipes + error remedies: dexe://playbook. " +
    `Skills: ${WRITE_SKILLS.join(", ")}; dexe-agent-team needs DEXE_TOOLSETS=core,agents plus hot keys.`
  );
}
