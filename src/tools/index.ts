import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WriteConfig } from "../config.js";
import { Artifacts } from "../artifacts.js";
import { HardhatRunner } from "../hardhat.js";
import { SelectorIndex } from "../lib/selectors.js";
import type { WriteToolContext } from "./writeContext.js";
import { registerBuildTools } from "./build.js";
import { registerIntrospectTools } from "./introspect.js";
import { registerGovTools } from "./gov.js";
import { registerDaoTools } from "./dao.js";
import { registerProposalTools } from "./proposal.js";
import { registerVoteTools } from "./vote.js";
import { registerReadTools } from "./read.js";
import { registerIpfsReadTools } from "./ipfsRead.js";
import { registerIpfsCidForJsonTool, registerIpfsUploadTools } from "./ipfsWrite.js";
import { registerProposalBuildTools } from "./proposalBuild.js";
import { registerProposalBuildMoreTools } from "./proposalBuildMore.js";
import { registerProposalBuildComplexTools } from "./proposalBuildComplex.js";
import { registerProposalBuildOffchainTools } from "./proposalBuildOffchain.js";
import { registerProposalBuildInternalTools } from "./proposalBuildInternal.js";
import { registerVoteBuildTools } from "./voteBuild.js";
import { registerDaoDeployTools } from "./daoDeploy.js";
import { registerSubgraphTools } from "./subgraph.js";
import { registerReportTools } from "./report.js";
import { registerTxTools } from "./txSend.js";
import { registerAgentTools } from "./agents.js";
import { registerGetConfigTool } from "./getConfig.js";
import { registerDoctorTool } from "./doctor.js";
import { writeDoctorChecks } from "../diag/writeChecks.js";
import { registerWalletConnectTools } from "./walletconnectStatus.js";
import { registerFlowTools } from "./flow.js";
import { registerDaoCreateTools } from "./daoCreate.js";
import { registerOperationalContextTools } from "./operationalContext.js";
import { registerGuideTools, registerKnowledgePrompts } from "./guide.js";
import { StateStore } from "../lib/stateStore.js";
import { registerMerkleTools } from "./merkle.js";
import { registerOtcSaleTools, registerOtcBuyerTools } from "./otc.js";
import { registerTokenSaleReadTools } from "./tokenSaleRead.js";
import { registerSafeTools } from "./safe.js";
import { registerSimulateTools } from "./simulate.js";
import { registerInboxTools } from "./inbox.js";
import { registerPredictTools } from "./predict.js";
import { registerRiskTools } from "./risk.js";
import { SignerManager } from "../lib/signer.js";
import { WalletConnectManager } from "../lib/walletconnect.js";
import { registerGovernorTools } from "../governor/index.js";
import { governorWriteTools } from "../governor/write.js";
import { applyToolGate } from "./gate.js";
import { applyToolAnnotations } from "./annotations.js";
import { installListToolsNormalizer } from "./schemaNormalize.js";

/**
 * Wire every dexe-mcp tool onto the given server instance. Builds the shared
 * WriteToolContext (artifacts cache, hardhat runner, selector index) once so all
 * tools share state.
 */
export function registerAll(server: McpServer, config: WriteConfig): void {
  // Phase 2: gate tool registration by the active DEXE_TOOLSETS profile. The
  // wrapped server drops any tool name not in the active allowlist; `full`
  // returns the server unchanged. Every register* call below sees the gate, so
  // no register file changes. Reassigning the param keeps it a one-line wrap.
  //
  // The annotation layer wraps OUTSIDE the gate on purpose: applyToolGate
  // returns the bare server on `full`, so anything inside it would annotate
  // nothing on the one profile that registers every tool.
  installListToolsNormalizer(server);
  server = applyToolAnnotations(applyToolGate(server, config));

  const artifacts = new Artifacts(config);
  const runner = new HardhatRunner(config);
  const selectors = new SelectorIndex(artifacts);
  const ctx: WriteToolContext = { config, artifacts, runner, selectors };

  registerBuildTools(server, ctx);
  registerIntrospectTools(server, ctx);
  registerGovTools(server, ctx);
  registerDaoTools(server, ctx);
  registerProposalTools(server, ctx);
  registerVoteTools(server, ctx);
  registerReadTools(server, ctx);
  // IPFS: uploads, then fetch / cid_info, then cid_for_json — the historical
  // tools/list order across the write and read halves.
  registerIpfsUploadTools(server, ctx);
  registerIpfsReadTools(server, ctx);
  registerIpfsCidForJsonTool(server);
  registerProposalBuildTools(server, ctx);
  registerProposalBuildMoreTools(server, ctx);
  registerProposalBuildComplexTools(server, ctx);
  registerProposalBuildInternalTools(server, ctx);
  registerVoteBuildTools(server, ctx);
  registerDaoDeployTools(server, ctx);
  registerReportTools(server, ctx);
  registerMerkleTools(server, ctx);
  registerPredictTools(server, ctx);
  registerRiskTools(server, ctx);

  const signer = new SignerManager(config);
  const wc = new WalletConnectManager(config);
  // Phase 3 — persistent operational state (known DAOs / recent proposals).
  const state = new StateStore(config.statePath);
  // The inbox falls back to the DAOs recorded here on chains with no subgraph;
  // the OTC list defaults `tokenSaleProposal` from the same record.
  registerInboxTools(server, ctx, state);
  registerSubgraphTools(server, ctx, state);
  registerTxTools(server, config, signer, wc);
  registerAgentTools(server, config, signer);
  registerGetConfigTool(server, config, signer);
  // Diagnostics — call dexe_doctor first when env-related failures show up.
  registerDoctorTool(server, config, writeDoctorChecks);
  registerWalletConnectTools(server, config, signer, wc);
  registerProposalBuildOffchainTools(server, ctx, signer, wc);
  registerFlowTools(server, ctx, signer, wc, state);
  registerDaoCreateTools(server, ctx, signer, wc, state);
  registerOperationalContextTools(server, config, signer, state);
  // Knowledge layer — dexe_guide serves flow plans/interviews/gotchas (Phase A);
  // per-flow MCP prompts for hosts that support them (Phase B).
  registerGuideTools(server, config, state);
  registerKnowledgePrompts(server);
  // OTC: open sale, then the read-only position view (dexe_otc_buyer_status,
  // kept out of otc.ts), then buy / claim all — the historical tools/list order.
  registerOtcSaleTools(server, ctx, signer, wc, state);
  registerTokenSaleReadTools(server, ctx);
  registerOtcBuyerTools(server, ctx, signer, wc);
  registerSafeTools(server, ctx, signer);
  registerSimulateTools(server, ctx, signer);

  // External OpenZeppelin Governor surface (research/06-execution-plan.md).
  // Independent namespace; no DeXe Protocol dependency. The read half
  // registers and slots the write half (governor/write.ts) in at its
  // historical positions.
  registerGovernorTools(server, config, governorWriteTools);
}
