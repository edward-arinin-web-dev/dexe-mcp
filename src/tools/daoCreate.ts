import { z } from "zod";
import { parseUnits, formatUnits, ZeroAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { RpcProvider } from "../rpc.js";
import { SignerManager } from "../lib/signer.js";
import type { WalletConnectManager } from "../lib/walletconnect.js";
import { PinataClient, toCidV1 } from "../lib/ipfs.js";
import { markdownToSlate } from "../lib/markdownToSlate.js";
import { resolveChain } from "../config.js";
import { pinataUploadHint } from "../lib/requireEnv.js";
import { attachPairingQr, sendOrCollect, flowFailureResult } from "./flow.js";
import { buildDeployGovPool, DeployParamsSchema, type DeployParams } from "./daoDeploy.js";
import type { StateStore } from "../lib/stateStore.js";
import {
  checkDeployCap,
  checkUserKeeperAsset,
  checkTreasuryRemainder,
  checkLinearInitData,
  checkCustomVotePower,
  checkQuorumReachable,
  checkMinVotesVsDistribution,
  checkSettingsBounds,
  assertPreflight,
} from "../lib/preflight.js";
import { simulateDeployGovPool } from "../lib/deploySim.js";
import { mapDeployRevert } from "../lib/deployRevertMap.js";
import { quorumPctFromRaw } from "../lib/quorumRisk.js";
import { checkAvatarCidBytes } from "../lib/imageSniff.js";
import { buildAvatarUrl, pinAvatarFromInput } from "../lib/avatarUpload.js";
import { resolveGateways } from "./ipfs.js";

/**
 * `dexe_dao_create` — the one-call DAO deploy composite. Two ways to call it:
 *
 *   1. SIMPLE (recommended): pass a few high-level fields (`symbol`,
 *      `totalSupply`, optional `treasuryPercent`/`quorumPercent`/`voteModel`)
 *      and the tool synthesizes a coherent, frontend-equivalent config —
 *      LINEAR power, treasury as an implicit remainder, a reachable quorum. It
 *      does NOT invent distribution/quorum silently: it returns a `preview` of
 *      the resolved config + a safety proof, and only broadcasts on a second
 *      call with `confirm: true` (mainnet always requires the confirm).
 *
 *   2. ADVANCED: pass a full `params` deploy struct (as `dexe_dao_build_deploy`).
 *
 * Either way the deploy goes through `buildDeployGovPool`, whose governance
 * coherence guards (unreachable quorum, min-votes > every holder, treasury in
 * the voter list, out-of-range settings) block any config the frontend blocks.
 *
 * Mainnet (chain 56) is a supported target (the frontend ships there daily);
 * it just requires `confirm: true` because it spends real BNB.
 */

const ZERO = ZeroAddress;
const PCT_25DEC = 10n ** 25n; // 1% in quorum units (100% = 1e27)
const ONE_TOKEN = 10n ** 18n;

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}
function ok(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// Params minus the two fields the composite derives itself.
const DaoCreateDeployParams = DeployParamsSchema.omit({ descriptionURL: true, name: true });
type DaoCreateParams = Omit<DeployParams, "descriptionURL" | "name">;

/** Default polynomial curve coefficients (25-decimal), matching the frontend. */
const POLY_COEFFS = {
  coefficient1: (108n * 10n ** 23n).toString(), // 1.08e25
  coefficient2: (92n * 10n ** 23n).toString(), // 0.92e25
  coefficient3: (97n * 10n ** 23n).toString(), // 0.97e25
};

export interface SimpleConfig {
  daoName: string;
  symbol: string;
  totalSupply: string; // whole tokens
  treasuryPercent: number;
  quorumPercent: number;
  voteModel: "LINEAR" | "POLYNOMIAL";
  durationSeconds: number;
  executionDelaySeconds: number;
  minVotesTokens: string; // whole tokens; applies to both voting and creating
  earlyCompletion: boolean;
}

/**
 * Synthesize a full, coherent deploy config from a few high-level fields — the
 * frontend-equivalent shape: new gov token, treasury as an IMPLICIT remainder
 * (never a recipient), deployer holds the distributed portion, LINEAR power.
 */
export function synthesizeParams(c: SimpleConfig, deployer: string): DaoCreateParams {
  const supplyWei = parseUnits(c.totalSupply, 18);
  const treasuryWei = (supplyWei * BigInt(Math.round(c.treasuryPercent * 100))) / 10000n;
  const distributable = supplyWei - treasuryWei;
  const quorumRaw = (BigInt(Math.round(c.quorumPercent * 1_000_000)) * PCT_25DEC) / 1_000_000n;
  // min-votes: the default (1 token) is clamped to the distributed amount so it
  // can never exceed the largest (only) recipient's balance; an explicit value
  // passes through — the builder's min-votes guard rejects it with remediation
  // if no holder could ever vote or create.
  const requestedMinVotes = parseUnits(c.minVotesTokens, 18);
  const minVotes =
    requestedMinVotes === ONE_TOKEN && distributable < ONE_TOKEN ? distributable : requestedMinVotes;
  const dur = String(c.durationSeconds);
  const isPoly = c.voteModel === "POLYNOMIAL";
  return {
    settingsParams: {
      proposalSettings: [
        {
          earlyCompletion: c.earlyCompletion,
          delegatedVotingAllowed: false, // contract semantics: false = delegation ALLOWED (frontend default)
          validatorsVote: true,
          duration: dur,
          durationValidators: dur,
          executionDelay: String(c.executionDelaySeconds),
          quorum: quorumRaw.toString(),
          quorumValidators: quorumRaw.toString(),
          minVotesForVoting: minVotes.toString(),
          minVotesForCreating: minVotes.toString(),
          rewardsInfo: {
            rewardToken: ZERO,
            creationReward: "0",
            executionReward: "0",
            voteRewardsCoefficient: "0",
          },
          executorDescription: "",
        },
      ],
      additionalProposalExecutors: [],
    },
    userKeeperParams: { tokenAddress: ZERO, nftAddress: ZERO, individualPower: "0", nftsTotalSupply: "0" },
    tokenParams: {
      name: c.daoName,
      symbol: c.symbol,
      users: [deployer],
      // Fixed supply: cap == mintedTotal. cap MUST be > 0 (ERC20Capped rejects 0)
      // and ≥ mintedTotal — verified live on mainnet.
      cap: supplyWei.toString(),
      mintedTotal: supplyWei.toString(),
      amounts: [distributable.toString()],
    },
    votePowerParams: {
      voteType: isPoly ? "POLYNOMIAL_VOTES" : "LINEAR_VOTES",
      presetAddress: ZERO,
      ...(isPoly ? { polynomialCoefficients: POLY_COEFFS } : {}),
    },
    verifier: ZERO,
    onlyBABTHolders: false,
  };
}

/**
 * Compute a human-readable safety proof for a resolved deploy config: the
 * votable share, the quorum, whether the quorum is reachable (the hard rule),
 * and whether it clears the ≥50% treasury-safety floor (advisory). `feasible`
 * is false only when the quorum is unreachable — the same rule the builder
 * enforces, surfaced early so the preview can explain it.
 */
export function computeSafetyProof(p: DaoCreateParams): {
  isTokenCreation: boolean;
  supply: string;
  votable: string;
  votablePct: number;
  quorumPct: number;
  reachable: boolean;
  reachablePct: number;
  floorOk: boolean;
  feasible: boolean;
  message?: string;
} {
  const isTokenCreation = p.tokenParams.name.length > 0;
  const supply = BigInt(p.tokenParams.mintedTotal || "0");
  const votable = p.tokenParams.amounts.reduce((a, b) => a + BigInt(b || "0"), 0n);
  const quorumRaw = p.settingsParams.proposalSettings[0]?.quorum ?? "0";
  const quorumPct = quorumPctFromRaw(quorumRaw);
  const voteType = p.votePowerParams.voteType;
  const reach = checkQuorumReachable({
    voteType,
    quorumRaw,
    mintedTotal: supply.toString(),
    votable: votable.toString(),
    isTokenCreation,
  });
  const votablePct = supply > 0n ? Number((votable * 10000n) / supply) / 100 : 0;
  const reachablePct =
    voteType === "LINEAR_VOTES" ? votablePct : supply > 0n ? Number((votable * 10000n) / supply) / 100 : 0;
  return {
    isTokenCreation,
    supply: supply.toString(),
    votable: votable.toString(),
    votablePct,
    quorumPct,
    reachable: reach.ok,
    reachablePct,
    floorOk: !Number.isNaN(quorumPct) && quorumPct >= 50,
    feasible: reach.ok,
    ...(reach.ok ? {} : { message: reach.remediation }),
  };
}

export function registerDaoCreateTools(
  server: McpServer,
  ctx: ToolContext,
  signer: SignerManager,
  wc: WalletConnectManager,
  state?: StateStore,
): void {
  const rpc = new RpcProvider(ctx.config);

  server.tool(
    "dexe_dao_create",
    "Create (deploy) a new DeXe DAO in ONE call. SIMPLE mode (recommended): pass `symbol` + `totalSupply` " +
      "(+ optional `treasuryPercent`/`quorumPercent`/`voteModel`/`minVotesTokens`/`earlyCompletion`) and the tool synthesizes a coherent, " +
      "frontend-equivalent config (LINEAR power, treasury as an implicit remainder, a reachable quorum). It " +
      "returns a `preview` of the resolved config + a safety proof and only broadcasts on a second call with " +
      "`confirm: true`. ADVANCED mode: pass a full `params` deploy struct. Either way the deploy runs governance " +
      "coherence guards (unreachable quorum, min-votes above every holder, treasury in the voter list, out-of-range " +
      "settings, validator/CUSTOM vote-power coherence, name collision) that block any config the frontend blocks, " +
      "a calldata round-trip self-check, and — right before signing — an eth_call SIMULATION of the exact calldata " +
      "from the deployer: a provable revert is refused with a classified cause + fix BEFORE any gas is spent " +
      "(apply the fix verbatim and re-run); an RPC outage only downgrades to a warning. On success the result " +
      "includes readiness (govPool code verified) and nextSteps for the first proposal. Mainnet (chain 56) is " +
      "supported (the frontend ships there daily) but requires `confirm: true` since it spends real BNB; testnet (97) " +
      "is the recommended place to validate. `deployer` defaults to the configured signer. Pass avatarCID from " +
      "dexe_ipfs_upload_avatar / dexe_dao_generate_avatar.",
    {
      chainId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Target chain id. Defaults to the MCP's default chain. Use 97 (BSC testnet) to validate; 56 = BSC mainnet (real funds)."),
      poolFactory: z.string().optional().describe("PoolFactory override; defaults to ContractsRegistry lookup"),
      deployer: z
        .string()
        .optional()
        .describe("tx.origin that sends the deploy (needed for address prediction). Defaults to the signer address."),
      daoName: z.string().min(1).describe("DAO name (also the deployGovPool pool name)"),
      daoDescription: z.string().default("").describe("DAO description (markdown; uploaded to IPFS as slate)"),
      websiteUrl: z.string().default(""),
      socialLinks: z.array(z.tuple([z.string(), z.string()])).default([]).describe("[[network, url], ...]"),
      documents: z
        .array(z.object({ name: z.string(), url: z.string() }))
        .default([])
        .describe('External documents shown on the DAO profile, e.g. [{ name: "Whitepaper", url: "https://..." }]'),
      avatarCID: z.string().default("").describe("IPFS CID of an already-pinned JPEG avatar (dexe_ipfs_upload_avatar)"),
      avatarFileName: z.string().default("avatar.jpeg"),
      avatarPath: z.string().default("").describe(
        "Local image path for the DAO avatar (JPEG/PNG/WebP/GIF, max 10 MB) — the server uploads + validates it. " +
        "Preferred over avatarCID; replaces the separate upload call.",
      ),
      // ---- SIMPLE mode fields (used when `params` is omitted) ----
      symbol: z.string().optional().describe("SIMPLE mode: gov token symbol (e.g. 'GENA'). Required when `params` is omitted."),
      totalSupply: z
        .string()
        .optional()
        .describe("SIMPLE mode: total token supply in WHOLE tokens (e.g. '1000000'). Required when `params` is omitted."),
      treasuryPercent: z
        .number()
        .min(0)
        .max(100)
        .default(49)
        .describe("SIMPLE mode: % of supply held by the DAO treasury (implicit remainder — cannot vote). Default 49."),
      quorumPercent: z
        .number()
        .min(0)
        .max(100)
        .default(51)
        .describe("SIMPLE mode: quorum %. Default 51. Must be ≥50 (security) and ≤ the votable %, i.e. ≤ 100−treasuryPercent."),
      voteModel: z
        .enum(["LINEAR", "POLYNOMIAL"])
        .default("LINEAR")
        .describe("SIMPLE mode: vote-power model. LINEAR = 1 token = 1 vote (default). POLYNOMIAL = meritocratic curve."),
      durationSeconds: z.number().int().positive().default(86400).describe("SIMPLE mode: voting duration. Default 86400 (1 day)."),
      executionDelaySeconds: z.number().int().min(0).default(0).describe("SIMPLE mode: delay before execution. Default 0."),
      minVotesTokens: z
        .string()
        .default("1")
        .describe(
          "SIMPLE mode: minimum token balance to vote AND to create proposals, in WHOLE tokens (e.g. '100'). " +
            "Default '1'. Must be ≤ the largest single holder's allocation or the deploy is blocked.",
        ),
      earlyCompletion: z
        .boolean()
        .default(true)
        .describe("SIMPLE mode: end voting as soon as the quorum is reached. Default true."),
      params: DaoCreateDeployParams.optional().describe(
        "ADVANCED mode: full deployGovPool params. Omit to use SIMPLE mode (symbol + totalSupply).",
      ),
      confirm: z
        .boolean()
        .default(false)
        .describe(
          "Set true to actually broadcast. Without it, SIMPLE mode and any mainnet deploy return a review-only preview. " +
            "ONE-CALL PATH: when the user has already explicitly approved deploying (they said 'deploy it' / confirmed the " +
            "parameters), pass confirm:true on the FIRST call — no preview round-trip needed.",
        ),
      dryRun: z.boolean().default(false).describe("If true, return the deploy TxPayload even when DEXE_PRIVATE_KEY is set."),
    },
    async (input) => {
      if (!ctx.config.pinataJwt) return err(pinataUploadHint("to create a DAO"));

      const deployer = input.deployer ?? (signer.hasSigner() ? signer.getAddress() : undefined);
      if (!deployer) return err("Provide 'deployer' address or set DEXE_PRIVATE_KEY.");

      const chain = resolveChain(ctx.config, input.chainId);
      const chainId = chain.chainId;
      const isMainnet = chainId === 56 || chainId === 1;
      const pinata = new PinataClient(ctx.config.pinataJwt);

      // ---------- resolve the deploy config: SIMPLE synthesis vs ADVANCED params ----------
      const synthesized = !input.params;
      let deployParams: DaoCreateParams;
      if (input.params) {
        deployParams = input.params;
      } else {
        if (!input.symbol || !input.totalSupply) {
          return err(
            "SIMPLE mode needs `symbol` and `totalSupply` (whole tokens), or pass a full `params` struct (ADVANCED mode). " +
              "Example: { daoName, symbol: 'GENA', totalSupply: '1000000' } → deployer gets 51%, treasury 49% (implicit), " +
              "quorum 51%, LINEAR power.",
          );
        }
        try {
          deployParams = synthesizeParams(
            {
              daoName: input.daoName,
              symbol: input.symbol,
              totalSupply: input.totalSupply,
              treasuryPercent: input.treasuryPercent,
              quorumPercent: input.quorumPercent,
              voteModel: input.voteModel,
              durationSeconds: input.durationSeconds,
              executionDelaySeconds: input.executionDelaySeconds,
              minVotesTokens: input.minVotesTokens,
              earlyCompletion: input.earlyCompletion,
            },
            deployer,
          );
        } catch (e) {
          return err(`Could not synthesize DAO config: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // ---------- fast preflight (predict-independent, fail before RPC/IPFS) ----------
      // F2: this list must include every confirm-stage check that needs no
      // prediction/RPC — preview and confirm must fail IDENTICALLY on the
      // first call, or the preview's "config looks coherent" claim is wrong.
      const isTokenCreation = deployParams.tokenParams.name.length > 0;
      const base0 = deployParams.settingsParams.proposalSettings[0];
      try {
        assertPreflight([
          checkDeployCap(deployParams.tokenParams.cap, deployParams.tokenParams.mintedTotal, isTokenCreation),
          checkUserKeeperAsset(
            deployParams.userKeeperParams.tokenAddress,
            deployParams.userKeeperParams.nftAddress,
            isTokenCreation,
          ),
          checkTreasuryRemainder(deployParams.tokenParams.mintedTotal, deployParams.tokenParams.amounts, isTokenCreation),
          checkLinearInitData(deployParams.votePowerParams.voteType, deployParams.votePowerParams.initData),
          checkCustomVotePower(
            deployParams.votePowerParams.voteType,
            deployParams.votePowerParams.initData,
            deployParams.votePowerParams.presetAddress,
          ),
          ...(base0
            ? [
                checkMinVotesVsDistribution(
                  base0.minVotesForVoting,
                  base0.minVotesForCreating,
                  deployParams.tokenParams.amounts,
                  isTokenCreation,
                ),
                checkSettingsBounds({
                  quorum: base0.quorum,
                  quorumValidators: base0.quorumValidators,
                  duration: base0.duration,
                  durationValidators: base0.durationValidators,
                }),
              ]
            : []),
        ]);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }

      // ---------- safety proof (reachability is the hard rule) ----------
      const proof = computeSafetyProof(deployParams);
      if (!proof.feasible) {
        return err(
          `This DAO would be governance-dead: ${proof.message} ` +
            (synthesized
              ? `Adjust so quorumPercent ≤ ${Math.floor(100 - input.treasuryPercent)} (100 − treasuryPercent) while staying ≥50.`
              : ""),
        );
      }

      // ---------- confirm gate: preview before broadcasting ----------
      const willBroadcast = !input.dryRun && signer.hasSigner();
      const needsConfirm = willBroadcast && !input.confirm && (synthesized || isMainnet);
      if (needsConfirm) {
        const t = deployParams.tokenParams;
        const supplyTokens = formatUnits(t.mintedTotal || "0", 18);
        const treasuryWei = BigInt(t.mintedTotal || "0") - t.amounts.reduce((a, b) => a + BigInt(b || "0"), 0n);
        const warnings: string[] = [];
        if (!proof.floorOk) {
          warnings.push(
            `⚠️ quorum ${proof.quorumPct}% is below the 50% treasury-safety floor — a low quorum lets a small group ` +
              "pass proposals (incl. draining treasury). 51%+ recommended. [advisory]",
          );
        }
        if (isMainnet) warnings.push("⚠️ MAINNET (chain " + chainId + ") — this will spend real BNB.");
        return ok({
          mode: "preview",
          action: "review-then-confirm",
          chainId,
          mainnet: isMainnet,
          daoName: input.daoName,
          resolvedConfig: {
            voteModel: deployParams.votePowerParams.voteType === "POLYNOMIAL_VOTES" ? "POLYNOMIAL" : "LINEAR",
            symbol: t.symbol,
            totalSupply: supplyTokens,
            distribution: {
              recipients: t.users.map((u, i) => ({
                address: u,
                tokens: formatUnits(t.amounts[i] ?? "0", 18),
                percent: proof.supply !== "0" ? Number((BigInt(t.amounts[i] ?? "0") * 10000n) / BigInt(proof.supply)) / 100 : 0,
              })),
              treasury: {
                tokens: formatUnits(treasuryWei.toString(), 18),
                percent: 100 - proof.votablePct,
                note: "implicit remainder held by the DAO — cannot vote",
              },
            },
            quorumPercent: proof.quorumPct,
            durationSeconds: Number(deployParams.settingsParams.proposalSettings[0]?.duration ?? "0"),
            executionDelaySeconds: Number(deployParams.settingsParams.proposalSettings[0]?.executionDelay ?? "0"),
          },
          safetyProof: {
            votablePercent: proof.votablePct,
            quorumPercent: proof.quorumPct,
            quorumReachable: proof.reachable,
            maxReachableQuorumPercent: proof.reachablePct,
            treasuryFloorOk: proof.floorOk,
          },
          ...(warnings.length ? { warnings } : {}),
          next:
            `Config looks coherent. Re-call dexe_dao_create with the SAME arguments plus confirm:true to broadcast` +
            (isMainnet ? " on MAINNET (spends real BNB). To validate first, set chainId:97 (testnet)." : "."),
        });
      }

      // ---------- build + upload DAO profile metadata ----------
      let descriptionRef = "";
      if (input.daoDescription && input.daoDescription.length > 0) {
        const descSlate = markdownToSlate(input.daoDescription);
        const descRes = await pinata.pinJson(descSlate, { name: `dao-desc:${input.daoName.slice(0, 30)}` });
        descriptionRef = `ipfs://${descRes.cid}`;
      }
      const daoMeta: Record<string, unknown> = {
        daoName: input.daoName,
        websiteUrl: input.websiteUrl,
        description: descriptionRef,
        socialLinks: input.socialLinks,
        documents: input.documents,
      };
      if (input.avatarPath && input.avatarCID) {
        return err("Pass either `avatarCID` or `avatarPath`, not both.");
      }
      if (input.avatarPath) {
        // One-call path: read + validate (magic bytes) + pin server-side.
        try {
          const pinned = await pinAvatarFromInput({ filePath: input.avatarPath, pinata });
          daoMeta.avatarCID = pinned.avatarCID;
          daoMeta.avatarFileName = pinned.avatarFileName;
          daoMeta.avatarUrl = pinned.avatarUrl;
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      } else if (input.avatarCID) {
        // avatarCID arrives by reference — the upload tools validate their own
        // bytes, but nothing forces the caller to have used them. Best-effort
        // fetch + sniff; hard-block only on confirmed non-raster bytes (an SVG
        // here becomes a permanently broken avatar on app.dexe.io).
        const avatarCidV1 = toCidV1(input.avatarCID);
        const avatarCheck = await checkAvatarCidBytes(avatarCidV1, input.avatarFileName, resolveGateways(ctx));
        if (!avatarCheck.ok) {
          return err(avatarCheck.error ?? "avatarCID failed raster validation");
        }
        daoMeta.avatarCID = avatarCidV1;
        daoMeta.avatarFileName = input.avatarFileName;
        daoMeta.avatarUrl = buildAvatarUrl(avatarCidV1, input.avatarFileName);
      }
      let descriptionURL: string;
      try {
        const daoMetaRes = await pinata.pinJson(daoMeta, { name: `dao-meta:${input.daoName.slice(0, 30)}` });
        descriptionURL = `ipfs://${daoMetaRes.cid}`;
      } catch (e) {
        return err(`Failed to upload DAO metadata to IPFS: ${e instanceof Error ? e.message : String(e)}`);
      }

      // ---------- build the deploy tx (shared with dexe_dao_build_deploy) ----------
      const res = await buildDeployGovPool(
        {
          chainId: input.chainId,
          poolFactory: input.poolFactory,
          deployer,
          params: { ...deployParams, descriptionURL, name: input.daoName },
        },
        ctx,
        rpc,
      );
      if (!res.ok) return err(res.error);

      // ---------- pre-sign simulation (the one on-chain check) ----------
      // The deploy is a single independent payload, so eth_call against live
      // state proves the exact calldata would not revert BEFORE the wallet
      // signs. Genuine revert → refuse (fail-closed). RPC transport failure →
      // proceed with a warning (fail-open) — an infra hiccup must not wedge a
      // valid deploy. sendOrCollect's blanket B9 skip stays (composites are
      // dependent sequences; this deploy is not).
      let simSummary = "";
      if (willBroadcast) {
        const verdict = await simulateDeployGovPool({
          to: res.payload.to,
          data: res.payload.data,
          deployer,
          chainId,
          config: ctx.config,
        });
        if (verdict.status === "reverted") {
          return err(`Deploy refused — ${verdict.summary}`);
        }
        simSummary = verdict.summary;
      }

      // ---------- send or collect ----------
      let result;
      try {
        result = await sendOrCollect(signer, [res.payload], { dryRun: input.dryRun, chainId, wc });
      } catch (e) {
        return err(`Deploy broadcast failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (result.mode === "failed") {
        // R3/R7: a mined-but-reverted (or timed-out) deploy must not read as
        // success — and must never be recorded as a known DAO. Layer the deploy
        // revert knowledge base over the raw failure so the caller gets
        // cause + fix, not just an ethers dump.
        const kb = mapDeployRevert(result.failure?.error);
        return flowFailureResult(result, {
          daoName: input.daoName,
          chainId,
          predictedGovPool: res.predictedGovPool ?? null,
          ...(kb.known ? { knownCause: { slug: kb.slug, cause: kb.cause, fix: kb.fix } } : {}),
        });
      }

      // Phase 3: record the deployed DAO so dexe_context surfaces it next
      // session. Best-effort — never fail the deploy on a state-write error.
      if (result.mode === "executed" && state && res.predictedGovPool) {
        try {
          const txHash = [...result.steps].reverse().find((s) => s.txHash)?.txHash;
          state.recordDao({
            name: input.daoName,
            govPool: res.predictedGovPool,
            chainId,
            token: res.predicted.govToken,
            txHash,
            deployedAt: new Date().toISOString(),
          });
        } catch {
          /* ignore */
        }
      }

      // ---------- post-deploy readiness probe (best-effort) ----------
      // Confirm the pool actually exists at the predicted address, and hand
      // the caller the safe first-proposal path (bug #35: fresh pools reject
      // the multicall(deposit,create) pattern — dexe_proposal_create already
      // sends approve→deposit→createProposalAndVote as separate txs).
      let readiness: { govPoolLive: boolean } | undefined;
      let nextSteps: string | undefined;
      if (result.mode === "executed" && res.predictedGovPool) {
        try {
          const pr = rpc.tryProvider(chainId);
          if (!("error" in pr)) {
            const code = await pr.ok.getCode(res.predictedGovPool);
            readiness = { govPoolLive: code !== "0x" };
          }
        } catch {
          /* best-effort — never fail a landed deploy on a read error */
        }
        nextSteps =
          `DAO is live at ${res.predictedGovPool}. First proposal: use dexe_proposal_create — it runs ` +
          "approve→deposit→createProposalAndVote as separate transactions (fresh pools reject the bundled " +
          "multicall pattern). If the first create reverts 'low creating power', re-run the same call — " +
          "the flow resumes from the deposit.";
      }

      return attachPairingQr(ok({
        mode: result.mode,
        daoName: input.daoName,
        chainId,
        deployer,
        descriptionURL,
        predictedGovPool: res.predictedGovPool ?? null,
        predicted: res.predicted,
        note: simSummary ? `${res.note}\n${simSummary}` : res.note,
        steps: result.steps,
        ...(readiness ? { readiness } : {}),
        ...(nextSteps ? { nextSteps } : {}),
        ...(result.enableWrites ? { enableWrites: result.enableWrites } : {}),
        ...(result.pairing ? { pairing: result.pairing } : {}),
      }), result.pairingContent);
    },
  );
}
