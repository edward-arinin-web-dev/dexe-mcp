/**
 * Which edition every source module under src/ belongs to — the module-level
 * half of the edition manifest (the tool-level half is src/editions.ts).
 *
 * The read edition's modules are not here: they live in the read edition's own
 * package, @dexe-network/dexe-mcp, and this repo consumes them through its
 * entry points (`@dexe-network/dexe-mcp/core` for the library API, `/bin` for
 * the binary). src/ keeps no copy of a read module
 * (tests/boundary/import-boundary.test.ts).
 *
 *   write  write edition only: signing, broadcast, uploads, calldata builders,
 *          simulators, the dev toolchain, and the CLI commands that write files.
 *   mixed  holds code for both. Counts as READ side in the import walk, so
 *          every write module it imports is a listed boundary crossing until
 *          the file is split (the crossing then disappears from the list).
 *   root   a composition root that wires BOTH editions into the single server
 *          this repo ships today. Not a walk source: it is supposed to import
 *          both sides.
 *   shim   a bin entry of this package for a binary that IS the read edition's:
 *          it imports the package's entry points and no src/ module at all.
 *
 * Paths are relative to src/, forward slashes. Not a test file (vitest only
 * collects *.test.ts); tests/boundary/import-boundary.test.ts fails on any src
 * file missing from this map and on any entry with no file behind it.
 *
 * Not used by the server. A new file goes in whichever group matches what it
 * does; when unsure, `write` is the conservative choice (it can only add
 * crossings, never hide one). Read code goes to @dexe-network/dexe-mcp.
 */
export type ModuleClass = "write" | "mixed" | "root" | "shim";

const WRITE = [
  "bootstrap.ts",
  // `dexe-mcp approve` — decide keystore approvals in a terminal (2c Phase B)
  "cli/approve.ts",
  // `dexe-mcp skills` — copies this package's dexe-plugin/skills into a skills dir
  "cli/skills.ts",
  // `dexe-mcp key` — create / import / list / change-password / remove the encrypted keystore
  "cli/key.ts",
  // WriteConfig + the single server's loadConfig; re-exports the read config API
  // (@dexe-network/dexe-mcp/core) so pre-split importers keep compiling
  "config.ts",
  "hardhat.ts",
  // the write edition's handshake, the single server's (unchanged) handshake,
  // the shipped skill roster
  "instructionsWrite.ts",
  // npm / hardhat / git resolvers for the dev toolchain
  "runtimeDev.ts",
  // Pinata JWT / pin probe, signer + keyring + broadcast guards, the
  // WalletConnect shared default — handed to runAllChecks as ExtraChecks
  "diag/writeChecks.ts",
  // the write + dev env specs and the full ENV_SPEC (display order) the
  // single server validates, loads and doctors
  "env/schema.ts",
  "governor/encoder.ts",
  "governor/tools/build.ts",
  // dexe_gov_build_cancel, dexe_gov_decode_calldata, dexe_gov_hash_*
  "governor/tools/extrasWrite.ts",
  // dexe_gov_simulate_proposal (execute() dry-run)
  "governor/tools/simulateWrite.ts",
  // the write half of the governor surface, slotted in by governor/index.ts
  "governor/write.ts",
  // the write corpus: the eight journeys, their gotchas (read ones cited by
  // id), the agent protocol, next-step chaining
  "knowledge/write/flows.ts",
  "knowledge/write/gotchas.ts",
  "knowledge/write/index.ts",
  "knowledge/write/nextSteps.ts",
  "lib/agentLedger.ts",
  // keystore-mode approvals: store, loopback server, page, review, browser opener,
  // per-call scope, the ordered-only ApprovedSigner (2c Phase A); message / SafeTx
  // signature approvals, the Safe review, the terminal channel + its rendezvous
  // and text review (2c Phase B)
  "lib/approval/approvedSigner.ts",
  "lib/approval/control.ts",
  "lib/approval/controlProtocol.ts",
  "lib/approval/index.ts",
  "lib/approval/openBrowser.ts",
  "lib/approval/page.ts",
  "lib/approval/rendezvous.ts",
  "lib/approval/review.ts",
  "lib/approval/safeReview.ts",
  "lib/approval/scope.ts",
  "lib/approval/server.ts",
  "lib/approval/signing.ts",
  "lib/approval/store.ts",
  "lib/approval/terminalReview.ts",
  "lib/avatarImage.ts",
  "lib/avatarUpload.ts",
  "lib/blacklist.ts",
  "lib/broadcastGuards.ts",
  // the build-time harm pass; its governance classifier is the read edition's
  "lib/buildAdvisories.ts",
  "lib/buildWarning.ts",
  "lib/calldata.ts",
  "lib/deployGuard.ts",
  "lib/deployRevertMap.ts",
  "lib/deploySim.ts",
  "lib/ethersProvider.ts",
  "lib/flowChain.ts",
  "lib/imageSniff.ts",
  // Pinata client + the pin-or-preview fork
  "lib/ipfsPin.ts",
  "lib/ipfsPreview.ts",
  // keystore v3 at rest: native scrypt, select / write (0600) / decrypt + address check
  "lib/keystore.ts",
  "lib/markdownToSlate.ts",
  // DEXE_PINATA_JWT guard and hint for upload sites
  "lib/pinata.ts",
  "lib/preflight.ts",
  "lib/proposalBuilders.ts",
  "lib/proposalCatalog.ts",
  // build-time advisories, F15 included; the advisory constructor is the read edition's
  "lib/protocolAdvisories.ts",
  "lib/qr.ts",
  // dexe_dao_report snapshots on disk (reports.json), injected by the composition root
  "lib/reportStoreFile.ts",
  "lib/resumeContract.ts",
  "lib/signer.ts",
  // the ONE signer-mode resolver (walletconnect | keystore | readonly | unattended) + chain fence
  "lib/signerMode.ts",
  // eth_call simulation core: pre-checks for writes (sim tools, broadcast guard)
  "lib/simulate.ts",
  // treasury-guard advisories + the build/deploy/execute gate
  "lib/treasuryGate.ts",
  "lib/txWait.ts",
  "lib/walletconnect.ts",
  // write remedy table, registered into the read edition's registry by the composition root
  "lib/writeErrors.ts",
  // builder chainId, signerKey, off-chain proposal id
  "lib/writeParams.ts",
  "tools/agents.ts",
  // deprecated tool names the single server still answers to (D4 renames)
  "tools/aliases.ts",
  // the write edition's annotation classes + the single server's merged table
  "tools/annotationsWrite.ts",
  "tools/build.ts",
  "tools/buildResult.ts",
  "tools/daoCreate.ts",
  "tools/daoDeploy.ts",
  "tools/flow.ts",
  // the single server's toolset table (TOOLSETS, defaults, unlocks) and the
  // write edition's (the same sets narrowed to WRITE_TOOLS). Names read tools
  // only as members of the single server's sets.
  "tools/gate.ts",
  // the write half of the guide: interrupted-flow context, flow prompts, flow wording
  "tools/guideWrite.ts",
  "tools/introspect.ts",
  // the Pinata uploads, generated avatar, profile re-upload, dexe_ipfs_cid_for_json
  "tools/ipfsWrite.ts",
  "tools/merkle.ts",
  // dexe_write_context: signer, keyring, Pinata/WalletConnect/Safe posture, activeFlow
  "tools/operationalContextWrite.ts",
  // OTC composites; the read-only position view is the read edition's
  "tools/otc.ts",
  "tools/proposalBuild.ts",
  "tools/proposalBuildComplex.ts",
  "tools/proposalBuildInternal.ts",
  "tools/proposalBuildMore.ts",
  "tools/proposalBuildOffchain.ts",
  "tools/safe.ts",
  "tools/simulate.ts",
  "tools/txSend.ts",
  "tools/voteBuild.ts",
  "tools/walletconnectStatus.ts",
  // ToolContext with the write config and the hardhat runner
  "tools/writeContext.ts",
];

const MIXED = [
  // lists both editions' tools; each edition will carry its own list
  "editions.ts",
  // read wizard (RPC, subgraph, gateway) + write wizard (key, Pinata, WC)
  "cli/init.ts",
];

const ROOT = [
  // CLI dispatch + stdio server start
  "index.ts",
  // the single server's knowledge: write flows + read topics, bound to the gate
  "knowledge/index.ts",
  // registerAll(): every register function of both editions
  "tools/index.ts",
];

const SHIM = [
  // `dexe-mcp-read` (package.json "bin", and the child `dexe-mcp serve-http`
  // spawns): runs @dexe-network/dexe-mcp's binary
  "read/bin.ts",
];

/** The raw lists, so the boundary test can check nothing is listed twice. */
export const MODULE_GROUPS: Readonly<Record<ModuleClass, readonly string[]>> = {
  write: WRITE,
  mixed: MIXED,
  root: ROOT,
  shim: SHIM,
};

/** File → class. A file listed twice keeps its last class; the test fails on it. */
export const MODULE_CLASSES: ReadonlyMap<string, ModuleClass> = new Map(
  (Object.entries(MODULE_GROUPS) as [ModuleClass, readonly string[]][]).flatMap(([cls, files]) =>
    files.map((f) => [f, cls] as const),
  ),
);
