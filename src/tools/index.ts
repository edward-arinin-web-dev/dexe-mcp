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
import { registerReportTools, type ReportSnapshotStore } from "./report.js";
import { FileReportStore, reportStorePath } from "../lib/reportStoreFile.js";
import { registerTxTools } from "./txSend.js";
import { registerAgentTools } from "./agents.js";
import { registerGetConfigTool } from "./getConfig.js";
import { registerDoctorTool } from "./doctor.js";
import { WRITE_DOCTOR_TEXT, writeDoctorChecks } from "../diag/writeChecks.js";
import { registerWalletConnectTools } from "./walletconnectStatus.js";
import { registerFlowTools } from "./flow.js";
import { registerDaoCreateTools } from "./daoCreate.js";
import { registerOperationalContextTools } from "./operationalContext.js";
import { registerWriteContextTool } from "./operationalContextWrite.js";
import { registerGuideTool } from "./guide.js";
import { FLOW_GUIDE_TEXT, activeFlowContext, registerKnowledgePrompts } from "./guideWrite.js";
import { SINGLE_SERVER_KNOWLEDGE } from "../knowledge/index.js";
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
import { applyToolGate, SINGLE_SERVER_TOOLSETS } from "./gate.js";
import { applyToolAnnotations } from "./annotations.js";
import { SINGLE_SERVER_ANNOTATIONS } from "./annotationsWrite.js";
import { applyReadResultGuard } from "./readGuard.js";
import { applyToolAliases } from "./aliases.js";
import { installListToolsNormalizer } from "./schemaNormalize.js";
import { applyApprovalScope } from "../lib/approval/scope.js";
import { WRITE_TOOLS } from "../editions.js";

/** The decode tools' pointer at the dev tool that also searches a local compile's events and errors. */
export const LOCAL_COMPILE_DECODE_HINT = "Try dexe_find_selector to search the local compile's events and errors too.";

export interface RegisterAllOptions {
  /**
   * Where `dexe_dao_report` keeps run snapshots. Default: `reports.json` beside
   * `state.json`. `null`: nothing is kept (the remote read server).
   */
  reportStore?: ReportSnapshotStore | null;
}

/**
 * Wire every dexe-mcp tool onto the given server instance. Builds the shared
 * WriteToolContext (artifacts cache, hardhat runner, selector index) once so all
 * tools share state.
 *
 * The single server: its toolset table (src/tools/gate.ts), its annotation
 * table (src/tools/annotationsWrite.ts), the write doctor checks and the file
 * report store. Each read register function is handed these as parameters; none
 * of them imports the single server's tables.
 */
export function registerAll(server: McpServer, config: WriteConfig, opts: RegisterAllOptions = {}): void {
  // Phase 2: gate tool registration by the active DEXE_TOOLSETS profile. The
  // wrapped server drops any tool name not in the active allowlist; `full`
  // returns the server unchanged. Every register* call below sees the gate, so
  // no register file changes. Reassigning the param keeps it a one-line wrap.
  //
  // The annotation layer wraps OUTSIDE the gate on purpose: applyToolGate
  // returns the bare server on `full`, so anything inside it would annotate
  // nothing on the one profile that registers every tool.
  //
  // The read-result guard wraps outermost: every read-edition handler runs
  // with the request's cancellation signal, and its result is scrubbed of
  // configured endpoints/keys and capped in size (src/tools/readGuard.ts).
  //
  // The alias layer (deprecated tool names, src/tools/aliases.ts) sits between
  // the annotations and the gate: it copies a target's finished config and
  // guarded handler, and registers the old name only when the gate let the
  // target through.
  // The approval scope wraps every WRITE tool: it hands the keystore signing
  // path the tool name + request (progress, cancellation) and renders an
  // ApprovalHaltError as `awaiting_approval` / `declined` (src/lib/approval/scope.ts).
  installListToolsNormalizer(server);
  server = applyReadResultGuard(
    applyApprovalScope(
      applyToolAnnotations(applyToolAliases(applyToolGate(server, config), server), SINGLE_SERVER_ANNOTATIONS),
      new Set(WRITE_TOOLS),
    ),
    config,
  );

  const artifacts = new Artifacts(config);
  const runner = new HardhatRunner(config);
  const selectors = new SelectorIndex(artifacts);
  const ctx: WriteToolContext = { config, artifacts, runner, selectors };

  registerBuildTools(server, ctx);
  registerIntrospectTools(server, ctx);
  registerGovTools(server, ctx, { localCompileHint: LOCAL_COMPILE_DECODE_HINT });
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
  registerReportTools(server, ctx, {
    store:
      opts.reportStore === undefined
        ? new FileReportStore(reportStorePath(config))
        : (opts.reportStore ?? undefined),
    toolsets: SINGLE_SERVER_TOOLSETS,
  });
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
  registerGetConfigTool(server, ctx);
  // Diagnostics — call dexe_doctor first when env-related failures show up.
  registerDoctorTool(server, config, writeDoctorChecks, {
    toolsets: SINGLE_SERVER_TOOLSETS,
    text: WRITE_DOCTOR_TEXT,
  });
  registerWalletConnectTools(server, config, signer, wc);
  registerProposalBuildOffchainTools(server, ctx, signer, wc);
  registerFlowTools(server, ctx, signer, wc, state);
  registerDaoCreateTools(server, ctx, signer, wc, state);
  // Orientation, split by edition: dexe_context (chains, env, toolsets, known
  // DAOs) and dexe_write_context (signer, keyring, upload/WC/Safe posture, the
  // interrupted flow). The read tool names no write tool itself — this root
  // hands it the toolset catalog and the pointer at the write half.
  registerOperationalContextTools(server, config, state, {
    toolsets: SINGLE_SERVER_TOOLSETS,
    hintSuffix:
      "Signer, agent keyring, Pinata/WalletConnect/Safe posture and an unfinished flow: dexe_write_context.",
  });
  registerWriteContextTool(server, config, signer, state);
  // Knowledge layer — dexe_guide serves the write flows next to the read
  // topics (Phase A) and follows an interrupted write journey across sessions;
  // per-flow MCP prompts for hosts that support them (Phase B).
  registerGuideTool(server, config, state, {
    knowledge: SINGLE_SERVER_KNOWLEDGE,
    text: FLOW_GUIDE_TEXT,
    extraContext: activeFlowContext,
  });
  registerKnowledgePrompts(server);
  // OTC: open sale, then the read-only position view (dexe_read_token_sale_position,
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
