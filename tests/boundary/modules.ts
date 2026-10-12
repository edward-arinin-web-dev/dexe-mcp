/**
 * Which edition every source module under src/ belongs to — the module-level
 * half of the edition manifest (the tool-level half is src/editions.ts).
 *
 *   read   goes to the read edition and is library API the write edition
 *          imports from it.
 *   write  write edition only: signing, broadcast, uploads, calldata builders,
 *          simulators, the dev toolchain.
 *   mixed  holds code for both. Counts as READ side in the import walk, so
 *          every write module it imports is a listed boundary crossing until
 *          the file is split (the crossing then disappears from the list).
 *   root   a composition root that wires BOTH editions into the single server
 *          this repo ships today. Not a walk source: it is supposed to import
 *          both sides. A per-edition root replaces it when the read server gets
 *          its own entrypoint.
 *
 * Paths are relative to src/, forward slashes. Not a test file (vitest only
 * collects *.test.ts); tests/boundary/import-boundary.test.ts fails on any src
 * file missing from this map and on any entry with no file behind it.
 *
 * Not used by the server. A new file goes in whichever group matches what it
 * does; when unsure, `write` is the conservative choice (it can only add
 * crossings, never hide one).
 */
export type ModuleClass = "read" | "write" | "mixed" | "root";

const READ = [
  // bundled protocol ABI snapshot the decode tools fall back to (no compile step)
  "abi/protocolSnapshot.generated.ts",
  "artifacts.ts",
  // ReadConfig + loadReadConfig and the loader phases the write loader reuses
  "configRead.ts",
  "resources.ts",
  "rpc.ts",
  // DEXE_DEBUG diagnostics; the npm/hardhat/git resolvers are runtimeDev.ts
  "runtime.ts",
  "cli/doctor.ts",
  "cli/skills.ts",
  // the read doctor checks + the ExtraChecks hook the write checks
  // (diag/writeChecks.ts) come in through, with the full env surface to walk
  "diag/checks.ts",
  "env/loader.ts",
  "env/parse.ts",
  // the read env spec, the foreign (write) key names, the read env surface
  "env/schemaRead.ts",
  "governor/adapter.ts",
  // registers the read governor tools; the write half (governor/write.ts) is
  // passed in by the composition root
  "governor/index.ts",
  "governor/loader.ts",
  "governor/rpc.ts",
  "governor/tally.ts",
  // dexe_gov_get_state, dexe_gov_has_voted
  "governor/tools/extras.ts",
  "governor/tools/read.ts",
  // dexe_gov_simulate_vote_impact
  "governor/tools/simulate.ts",
  // serve-http transport layer (options, Host/Origin/rate-limit, the HTTP app).
  // Takes the MCP server as an injected factory; imports no tool code.
  "http/options.ts",
  "http/security.ts",
  "http/server.ts",
  // the knowledge engine and renderers, parameterized by corpus + tool locator
  "knowledge/engine.ts",
  "knowledge/render.ts",
  "knowledge/types.ts",
  // the read corpus: reference topics + the data-read gotchas
  "knowledge/read/gotchas.ts",
  "knowledge/read/index.ts",
  "knowledge/read/topics.ts",
  "lib/abi/tokenSale.ts",
  "lib/abiSnapshot.ts",
  "lib/addresses.ts",
  // A pure digits-only validator. Builders use it, but so does the read tool
  // dexe_otc_buyer_status (tier ids), so it is shared code, not write code.
  "lib/amount.ts",
  "lib/controllingVoters.ts",
  "lib/dangerousSelectors.ts",
  "lib/decoders.ts",
  "lib/decodeAbis.ts",
  // the read remedy table + the registry write code adds its table to
  "lib/errors.ts",
  "lib/govAddresses.ts",
  "lib/govEnums.ts",
  "lib/governanceHits.ts",
  "lib/govProposalView.ts",
  "lib/interactionTypes.ts",
  // gateway fetch, CID parsing, offline CIDs; pinning is lib/ipfsPin.ts
  "lib/ipfs.ts",
  "lib/merkleTree.ts",
  "lib/multicall.ts",
  "lib/page.ts",
  // shared input-param vocabulary; write-only params are lib/writeParams.ts
  "lib/params.ts",
  // pure quorum/treasury risk math; the gate and its advisories are lib/treasuryGate.ts
  "lib/quorumRisk.ts",
  "lib/redact.ts",
  // generic env guard; the Pinata guard is lib/pinata.ts
  "lib/requireEnv.ts",
  "lib/sanitize.ts",
  "lib/selectors.ts",
  // Persistence infrastructure. Read tools only call getState / findKnownDao;
  // the writers are called by write flows.
  "lib/stateStore.ts",
  "lib/subgraph.ts",
  "lib/time.ts",
  // the sanitizing result funnel shared by every OTC tool
  "lib/tokenSaleResult.ts",
  "lib/units.ts",
  "lib/upstreamAdvisories.ts",
  // ToolContext over the read config; write tools take tools/writeContext.ts
  "tools/context.ts",
  "tools/dao.ts",
  "tools/doctor.ts",
  "tools/gov.ts",
  // dexe_guide over whatever Knowledge it is handed; write extras come in as a hook
  "tools/guide.ts",
  "tools/inbox.ts",
  // dexe_ipfs_fetch, dexe_ipfs_cid_info, the gateway chain and the IPFS error sink
  "tools/ipfsRead.ts",
  "tools/predict.ts",
  "tools/proposal.ts",
  "tools/read.ts",
  "tools/report.ts",
  "tools/risk.ts",
  // generic tools/list schema post-processing (oneOf → anyOf, closed objects)
  "tools/schemaNormalize.ts",
  "tools/subgraph.ts",
  "tools/tokenSaleRead.ts",
  "tools/vote.ts",
];

const WRITE = [
  "bootstrap.ts",
  // WriteConfig + the single server's loadConfig; re-exports configRead.ts so
  // pre-split importers keep compiling (read code imports configRead.ts)
  "config.ts",
  "hardhat.ts",
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
  "lib/avatarImage.ts",
  "lib/avatarUpload.ts",
  "lib/blacklist.ts",
  "lib/broadcastGuards.ts",
  // the build-time harm pass; its governance classifier is lib/governanceHits.ts
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
  "lib/markdownToSlate.ts",
  // DEXE_PINATA_JWT guard and hint for upload sites
  "lib/pinata.ts",
  "lib/preflight.ts",
  "lib/proposalBuilders.ts",
  "lib/proposalCatalog.ts",
  // build-time advisories; the advisory core and F15 are lib/upstreamAdvisories.ts
  "lib/protocolAdvisories.ts",
  "lib/qr.ts",
  "lib/resumeContract.ts",
  "lib/signer.ts",
  // eth_call simulation core: pre-checks for writes (sim tools, broadcast guard)
  "lib/simulate.ts",
  // treasury-guard advisories + the build/deploy/execute gate
  "lib/treasuryGate.ts",
  "lib/txWait.ts",
  "lib/walletconnect.ts",
  // write remedy table, registered on top of lib/errors.ts by the composition root
  "lib/writeErrors.ts",
  // builder chainId, signerKey, off-chain proposal id
  "lib/writeParams.ts",
  "tools/agents.ts",
  "tools/build.ts",
  "tools/buildResult.ts",
  "tools/daoCreate.ts",
  "tools/daoDeploy.ts",
  "tools/flow.ts",
  // the write half of the guide: interrupted-flow context, flow prompts, flow wording
  "tools/guideWrite.ts",
  "tools/introspect.ts",
  // the Pinata uploads, generated avatar, profile re-upload, dexe_ipfs_cid_for_json
  "tools/ipfsWrite.ts",
  "tools/merkle.ts",
  // OTC composites; the read-only position view is tools/tokenSaleRead.ts
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
  "instructions.ts",
  // read wizard (RPC, subgraph, gateway) + write wizard (key, Pinata, WC)
  "cli/init.ts",
  "tools/annotations.ts",
  "tools/gate.ts",
  // reports the write posture through a structural type, not the write config
  "tools/getConfig.ts",
  "tools/operationalContext.ts",
];

const ROOT = [
  // CLI dispatch + stdio server start
  "index.ts",
  // the single server's knowledge: write flows + read topics, bound to the gate
  "knowledge/index.ts",
  // registerAll(): every register function of both editions
  "tools/index.ts",
  // serve-http entry: wires the interim factory into the HTTP app
  "http/cli.ts",
  // interim remote factory: registerAll() forced to the read profile, filtered
  // to READ_TOOLS. Replaced by the read edition's createReadServer() (A9).
  "http/readServer.ts",
];

/** The raw lists, so the boundary test can check nothing is listed twice. */
export const MODULE_GROUPS: Readonly<Record<ModuleClass, readonly string[]>> = {
  read: READ,
  write: WRITE,
  mixed: MIXED,
  root: ROOT,
};

/** File → class. A file listed twice keeps its last class; the test fails on it. */
export const MODULE_CLASSES: ReadonlyMap<string, ModuleClass> = new Map(
  (Object.entries(MODULE_GROUPS) as [ModuleClass, readonly string[]][]).flatMap(([cls, files]) =>
    files.map((f) => [f, cls] as const),
  ),
);
