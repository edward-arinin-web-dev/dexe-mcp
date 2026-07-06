import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DexeConfig } from "../config.js";
import { Artifacts } from "../artifacts.js";
import { HardhatRunner } from "../hardhat.js";
import { SelectorIndex } from "../lib/selectors.js";
import type { ToolContext } from "./context.js";
import { registerBuildTools } from "./build.js";
import { registerIntrospectTools } from "./introspect.js";
import { registerGovTools } from "./gov.js";
import { registerDaoTools } from "./dao.js";
import { registerProposalTools } from "./proposal.js";
import { registerVoteTools } from "./vote.js";
import { registerReadTools } from "./read.js";
import { registerIpfsTools } from "./ipfs.js";
import { registerProposalBuildTools } from "./proposalBuild.js";
import { registerProposalBuildMoreTools } from "./proposalBuildMore.js";
import { registerProposalBuildComplexTools } from "./proposalBuildComplex.js";
import { registerProposalBuildOffchainTools } from "./proposalBuildOffchain.js";
import { registerProposalBuildInternalTools } from "./proposalBuildInternal.js";
import { registerVoteBuildTools } from "./voteBuild.js";
import { registerDaoDeployTools } from "./daoDeploy.js";
import { registerSubgraphTools } from "./subgraph.js";
import { registerTxTools } from "./txSend.js";
import { registerGetConfigTool } from "./getConfig.js";
import { registerDoctorTool } from "./doctor.js";
import { registerWalletConnectTools } from "./walletconnectStatus.js";
import { registerFlowTools } from "./flow.js";
import { registerDaoCreateTools } from "./daoCreate.js";
import { registerOperationalContextTools } from "./operationalContext.js";
import { StateStore } from "../lib/stateStore.js";
import { registerMerkleTools } from "./merkle.js";
import { registerOtcTools } from "./otc.js";
import { registerSafeTools } from "./safe.js";
import { registerSimulateTools } from "./simulate.js";
import { registerInboxTools } from "./inbox.js";
import { registerPredictTools } from "./predict.js";
import { registerRiskTools } from "./risk.js";
import { SignerManager } from "../lib/signer.js";
import { WalletConnectManager } from "../lib/walletconnect.js";
import { registerGovernorTools } from "../governor/index.js";
import { applyToolGate } from "./gate.js";

/**
 * Wire every dexe-mcp tool onto the given server instance. Builds the shared
 * ToolContext (artifacts cache, hardhat runner, selector index) once so all
 * tools share state.
 */
export function registerAll(server: McpServer, config: DexeConfig): void {
  // Phase 2: gate tool registration by the active DEXE_TOOLSETS profile. The
  // wrapped server drops any tool name not in the active allowlist; `full`
  // returns the server unchanged. Every register* call below sees the gate, so
  // no register file changes. Reassigning the param keeps it a one-line wrap.
  server = applyToolGate(server, config);

  const artifacts = new Artifacts(config);
  const runner = new HardhatRunner(config);
  const selectors = new SelectorIndex(artifacts);
  const ctx: ToolContext = { config, artifacts, runner, selectors };

  registerBuildTools(server, ctx);
  registerIntrospectTools(server, ctx);
  registerGovTools(server, ctx);
  registerDaoTools(server, ctx);
  registerProposalTools(server, ctx);
  registerVoteTools(server, ctx);
  registerReadTools(server, ctx);
  registerIpfsTools(server, ctx);
  registerProposalBuildTools(server, ctx);
  registerProposalBuildMoreTools(server, ctx);
  registerProposalBuildComplexTools(server, ctx);
  registerProposalBuildOffchainTools(server, ctx);
  registerProposalBuildInternalTools(server, ctx);
  registerVoteBuildTools(server, ctx);
  registerDaoDeployTools(server, ctx);
  registerSubgraphTools(server, ctx);
  registerMerkleTools(server, ctx);
  registerInboxTools(server, ctx);
  registerPredictTools(server, ctx);
  registerRiskTools(server, ctx);

  const signer = new SignerManager(config);
  const wc = new WalletConnectManager(config);
  // Phase 3 — persistent operational state (known DAOs / recent proposals).
  const state = new StateStore(config.statePath);
  registerTxTools(server, config, signer, wc);
  registerGetConfigTool(server, config, signer);
  // Diagnostics — call dexe_doctor first when env-related failures show up.
  registerDoctorTool(server, config);
  registerWalletConnectTools(server, config, signer, wc);
  registerFlowTools(server, ctx, signer, wc, state);
  registerDaoCreateTools(server, ctx, signer, wc, state);
  registerOperationalContextTools(server, config, signer, state);
  registerOtcTools(server, ctx, signer, wc);
  registerSafeTools(server, ctx, signer);
  registerSimulateTools(server, ctx, signer);

  // External OpenZeppelin Governor surface (research/06-execution-plan.md).
  // Independent namespace; no DeXe Protocol dependency.
  registerGovernorTools(server, config);
}
