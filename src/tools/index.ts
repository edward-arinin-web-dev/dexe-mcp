import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WriteConfig } from "../config.js";
import {
  applyReadResultGuard,
  applyToolAnnotations,
  Artifacts,
  installListToolsNormalizer,
  registerDaoTools,
  registerDoctorTool,
  registerGetConfigTool,
  registerGovernorTools,
  registerGovTools,
  registerGuideTool,
  registerInboxTools,
  registerIpfsReadTools,
  registerOperationalContextTools,
  registerPredictTools,
  registerProposalTools,
  registerReadTools,
  registerReportTools,
  registerRiskTools,
  registerSubgraphTools,
  registerTokenSaleReadTools,
  registerVoteTools,
  SelectorIndex,
  StateStore,
  type ReportSnapshotStore,
} from "@dexe-network/dexe-mcp/core";
import { HardhatRunner } from "../hardhat.js";
import type { WriteToolContext } from "./writeContext.js";
import { registerBuildTools } from "./build.js";
import { registerIntrospectTools } from "./introspect.js";
import { registerIpfsCidForJsonTool, registerIpfsUploadTools } from "./ipfsWrite.js";
import { registerProposalBuildTools } from "./proposalBuild.js";
import { registerProposalBuildMoreTools } from "./proposalBuildMore.js";
import { registerProposalBuildComplexTools } from "./proposalBuildComplex.js";
import { registerProposalBuildOffchainTools } from "./proposalBuildOffchain.js";
import { registerProposalBuildInternalTools } from "./proposalBuildInternal.js";
import { registerVoteBuildTools } from "./voteBuild.js";
import { registerDaoDeployTools } from "./daoDeploy.js";
import { FileReportStore, reportStorePath } from "../lib/reportStoreFile.js";
import { registerTxTools } from "./txSend.js";
import { registerAgentTools } from "./agents.js";
import { WRITE_DOCTOR_TEXT, writeDoctorChecks } from "../diag/writeChecks.js";
import { registerWalletConnectTools } from "./walletconnectStatus.js";
import { registerFlowTools } from "./flow.js";
import { registerDaoCreateTools } from "./daoCreate.js";
import { registerWriteContextTool } from "./operationalContextWrite.js";
import { FLOW_GUIDE_TEXT, activeFlowContext, registerKnowledgePrompts, registerWriteGuideTool } from "./guideWrite.js";
import { SINGLE_SERVER_KNOWLEDGE, writeGuideKnowledge, writeToolLocator } from "../knowledge/index.js";
import { useNextStepLocator } from "../knowledge/write/nextSteps.js";
import { registerWriteDoctorTool } from "../diag/writeDoctor.js";
import { useWriteFailureWording } from "../lib/writeErrors.js";
import { installReadServerMarks } from "./readServerMarks.js";
import { registerMerkleTools } from "./merkle.js";
import { registerOtcSaleTools, registerOtcBuyerTools } from "./otc.js";
import { withVestingWithdrawAdvisory } from "./tokenSaleF15.js";
import { registerSafeTools } from "./safe.js";
import { registerSimulateTools } from "./simulate.js";
import { SignerManager } from "../lib/signer.js";
import { WalletConnectManager } from "../lib/walletconnect.js";
import { governorWriteTools } from "../governor/write.js";
import { applyToolGate, serverToolsets, SINGLE_SERVER_TOOLSETS } from "./gate.js";
import { SINGLE_SERVER_ANNOTATIONS, WRITE_ANNOTATIONS } from "./annotationsWrite.js";
import { applyToolAliases } from "./aliases.js";
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
 * Wire this server's tools onto the given server instance. Builds the shared
 * WriteToolContext (artifacts cache, hardhat runner, selector index) once so all
 * tools share state.
 *
 * Two surfaces (1.0.0, decisions D1/D2):
 *
 *   write-only (default)  WRITE_TOOLS — the composites, builders, signing,
 *                         uploads, dev toolchain, and the write orientation
 *                         trio dexe_write_context / dexe_write_guide /
 *                         dexe_write_doctor. The DeXe read server running next
 *                         to it (dexe-mcp-read) serves the reads; write text
 *                         marks every read tool it names `(read server)`.
 *   standalone            `DEXE_WRITE_STANDALONE=1`: also every READ tool —
 *                         the pre-1.0 single server (dexe_context, dexe_guide
 *                         over flows + topics, dexe_doctor over both editions'
 *                         checks, …) plus the write trio, for a user who runs
 *                         no read server.
 *
 * The mode picks the toolset table (src/tools/gate.ts), the annotation table
 * (src/tools/annotationsWrite.ts), the failure wording (src/lib/writeErrors.ts)
 * and where the guide and the composites' `next` pointers locate a tool. Each
 * read register function is handed these as parameters; none of them imports
 * this server's tables.
 */
export function registerAll(server: McpServer, config: WriteConfig, opts: RegisterAllOptions = {}): void {
  const standalone = config.writeStandalone === true;
  // Process-wide, like the failure table they sit next to: what a remedy or a
  // `next` pointer says depends on whether this server has the read tools.
  useWriteFailureWording(config);
  useNextStepLocator(writeToolLocator(config));

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
  // Write-only: every read tool a published description names is marked
  // `(read server)` — this server does not register it (./readServerMarks.ts).
  if (!standalone) installReadServerMarks(server);
  server = applyReadResultGuard(
    applyApprovalScope(
      applyToolAnnotations(
        applyToolAliases(applyToolGate(server, config), server),
        standalone ? SINGLE_SERVER_ANNOTATIONS : WRITE_ANNOTATIONS,
      ),
      new Set(WRITE_TOOLS),
    ),
    config,
  );

  const artifacts = new Artifacts(config);
  const runner = new HardhatRunner(config);
  const selectors = new SelectorIndex(artifacts);
  const ctx: WriteToolContext = { config, artifacts, runner, selectors };

  // Registration order is the historical tools/list order; on the write-only
  // server each read register call is skipped (`standalone &&`), which drops
  // exactly the read tools from it. The gate restricts registrations to
  // WRITE_TOOLS there as well, so a register function that carries both halves
  // (the governor surface) cannot leak a read tool, not even at `full`.
  registerBuildTools(server, ctx);
  registerIntrospectTools(server, ctx);
  if (standalone) {
    registerGovTools(server, ctx, { localCompileHint: LOCAL_COMPILE_DECODE_HINT });
    registerDaoTools(server, ctx);
    registerProposalTools(server, ctx);
    registerVoteTools(server, ctx);
    registerReadTools(server, ctx);
  }
  // IPFS: uploads, then fetch / cid_info, then cid_for_json — the historical
  // tools/list order across the write and read halves.
  registerIpfsUploadTools(server, ctx);
  if (standalone) registerIpfsReadTools(server, ctx);
  registerIpfsCidForJsonTool(server);
  registerProposalBuildTools(server, ctx);
  registerProposalBuildMoreTools(server, ctx);
  registerProposalBuildComplexTools(server, ctx);
  registerProposalBuildInternalTools(server, ctx);
  registerVoteBuildTools(server, ctx);
  registerDaoDeployTools(server, ctx);
  if (standalone) {
    registerReportTools(server, ctx, {
      store:
        opts.reportStore === undefined
          ? new FileReportStore(reportStorePath(config))
          : (opts.reportStore ?? undefined),
      toolsets: SINGLE_SERVER_TOOLSETS,
    });
  }
  registerMerkleTools(server, ctx);
  if (standalone) {
    registerPredictTools(server, ctx);
    registerRiskTools(server, ctx);
  }

  const signer = new SignerManager(config);
  const wc = new WalletConnectManager(config);
  // Phase 3 — persistent operational state (known DAOs / recent proposals).
  const state = new StateStore(config.statePath);
  // The inbox falls back to the DAOs recorded here on chains with no subgraph;
  // the OTC list defaults `tokenSaleProposal` from the same record.
  if (standalone) {
    registerInboxTools(server, ctx, state);
    registerSubgraphTools(server, ctx, state);
  }
  registerTxTools(server, config, signer, wc);
  registerAgentTools(server, config, signer);
  if (standalone) {
    registerGetConfigTool(server, ctx);
    // Diagnostics — dexe_doctor runs the read checks with the write ones added.
    registerDoctorTool(server, config, writeDoctorChecks, {
      toolsets: SINGLE_SERVER_TOOLSETS,
      text: WRITE_DOCTOR_TEXT,
    });
  }
  registerWalletConnectTools(server, config, signer, wc);
  registerProposalBuildOffchainTools(server, ctx, signer, wc);
  registerFlowTools(server, ctx, signer, wc, state);
  registerDaoCreateTools(server, ctx, signer, wc, state);
  // Orientation, split by edition: dexe_context (chains, env, toolsets, known
  // DAOs — the read server's, here only standalone) and dexe_write_context
  // (signer, keyring, upload/WC/Safe posture, recorded DAOs, the interrupted
  // flow). The read tool names no write tool itself — this root hands it the
  // toolset catalog and the pointer at the write half.
  if (standalone) {
    registerOperationalContextTools(server, config, state, {
      toolsets: SINGLE_SERVER_TOOLSETS,
      hintSuffix:
        "Signer, agent keyring, Pinata/WalletConnect/Safe posture and an unfinished flow: dexe_write_context.",
    });
  }
  registerWriteContextTool(server, config, signer, state);
  // Knowledge layer — dexe_write_guide serves the write flows in both modes;
  // the standalone server also has dexe_guide, which serves them next to the
  // read topics (Phase A). Both follow an interrupted write journey across
  // sessions; per-flow MCP prompts for hosts that support them (Phase B).
  registerWriteGuideTool(server, config, state, writeGuideKnowledge(config));
  if (standalone) {
    registerGuideTool(server, config, state, {
      knowledge: SINGLE_SERVER_KNOWLEDGE,
      text: FLOW_GUIDE_TEXT,
      extraContext: activeFlowContext,
    });
  }
  registerKnowledgePrompts(server);
  // The write checks: signer, keystore, approval page, Pinata, WalletConnect,
  // this process's .env. In both modes; standalone's dexe_doctor runs them too.
  registerWriteDoctorTool(server, config, { toolsets: serverToolsets(config) });
  // OTC: open sale, then the read-only position view (dexe_read_token_sale_position,
  // the read edition's — standalone only), then buy / claim all — the
  // historical tools/list order. This server attaches F15 (the stranded vested
  // leg) to the position view's vested tiers, alias included (./tokenSaleF15.ts).
  registerOtcSaleTools(server, ctx, signer, wc, state);
  if (standalone) registerTokenSaleReadTools(withVestingWithdrawAdvisory(server), ctx);
  registerOtcBuyerTools(server, ctx, signer, wc);
  registerSafeTools(server, ctx, signer);
  registerSimulateTools(server, ctx, signer);

  // External OpenZeppelin Governor surface (research/06-execution-plan.md).
  // Independent namespace; no DeXe Protocol dependency. The read half
  // registers and slots the write half (governor/write.ts) in at its
  // historical positions; on the write-only server the gate drops the read half.
  registerGovernorTools(server, config, governorWriteTools);
}
