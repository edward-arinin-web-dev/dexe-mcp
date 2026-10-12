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
  "artifacts.ts",
  "resources.ts",
  "rpc.ts",
  "cli/doctor.ts",
  "cli/skills.ts",
  "env/loader.ts",
  "env/parse.ts",
  "governor/adapter.ts",
  "governor/loader.ts",
  "governor/rpc.ts",
  "governor/tally.ts",
  "governor/tools/read.ts",
  "knowledge/topics.ts",
  "knowledge/types.ts",
  "lib/abi/tokenSale.ts",
  "lib/addresses.ts",
  // A pure digits-only validator. Builders use it, but so does the read tool
  // dexe_otc_buyer_status (tier ids), so it is shared code, not write code.
  "lib/amount.ts",
  "lib/controllingVoters.ts",
  "lib/dangerousSelectors.ts",
  "lib/decoders.ts",
  "lib/govAddresses.ts",
  "lib/govEnums.ts",
  "lib/governanceHits.ts",
  "lib/govProposalView.ts",
  "lib/interactionTypes.ts",
  "lib/merkleTree.ts",
  "lib/multicall.ts",
  "lib/page.ts",
  "lib/redact.ts",
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
  "tools/dao.ts",
  "tools/doctor.ts",
  "tools/gov.ts",
  "tools/inbox.ts",
  "tools/predict.ts",
  "tools/proposal.ts",
  "tools/read.ts",
  "tools/report.ts",
  "tools/risk.ts",
  "tools/subgraph.ts",
  "tools/tokenSaleRead.ts",
  "tools/vote.ts",
];

const WRITE = [
  "bootstrap.ts",
  "hardhat.ts",
  "governor/encoder.ts",
  "governor/tools/build.ts",
  "knowledge/flows.ts",
  "knowledge/nextSteps.ts",
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
  "lib/ipfsPreview.ts",
  "lib/markdownToSlate.ts",
  "lib/preflight.ts",
  "lib/proposalBuilders.ts",
  "lib/proposalCatalog.ts",
  // build-time advisories; the advisory core and F15 are lib/upstreamAdvisories.ts
  "lib/protocolAdvisories.ts",
  "lib/qr.ts",
  "lib/resumeContract.ts",
  "lib/signer.ts",
  "lib/txWait.ts",
  "lib/walletconnect.ts",
  "tools/agents.ts",
  "tools/build.ts",
  "tools/buildResult.ts",
  "tools/daoCreate.ts",
  "tools/daoDeploy.ts",
  "tools/flow.ts",
  "tools/introspect.ts",
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
];

const MIXED = [
  // read config + write config (keys, WalletConnect, guards) in one loader
  "config.ts",
  // lists both editions' tools; each edition will carry its own list
  "editions.ts",
  "instructions.ts",
  // debug/diagnostic helpers (read) + npm/hardhat/git resolvers (dev)
  "runtime.ts",
  // read wizard (RPC, subgraph, gateway) + write wizard (key, Pinata, WC)
  "cli/init.ts",
  "diag/checks.ts",
  "env/schema.ts",
  "governor/index.ts",
  "governor/tools/extras.ts",
  "governor/tools/simulate.ts",
  "knowledge/gotchas.ts",
  "knowledge/index.ts",
  "knowledge/render.ts",
  "lib/errors.ts",
  "lib/ipfs.ts",
  "lib/params.ts",
  "lib/quorumRisk.ts",
  "lib/requireEnv.ts",
  "tools/annotations.ts",
  "tools/context.ts",
  "tools/gate.ts",
  "tools/getConfig.ts",
  "tools/guide.ts",
  "tools/ipfs.ts",
  "tools/operationalContext.ts",
];

const ROOT = [
  // CLI dispatch + stdio server start
  "index.ts",
  // registerAll(): every register function of both editions
  "tools/index.ts",
];

function classes(): ReadonlyMap<string, ModuleClass> {
  const m = new Map<string, ModuleClass>();
  const add = (files: readonly string[], cls: ModuleClass) => {
    for (const f of files) {
      if (m.has(f)) throw new Error(`tests/boundary/modules.ts: ${f} is classified twice`);
      m.set(f, cls);
    }
  };
  add(READ, "read");
  add(WRITE, "write");
  add(MIXED, "mixed");
  add(ROOT, "root");
  return m;
}

export const MODULE_CLASSES: ReadonlyMap<string, ModuleClass> = classes();
