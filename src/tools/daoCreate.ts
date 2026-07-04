import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { RpcProvider } from "../rpc.js";
import { SignerManager } from "../lib/signer.js";
import { PinataClient } from "../lib/ipfs.js";
import { markdownToSlate } from "../lib/markdownToSlate.js";
import { resolveChain } from "../config.js";
import { sendOrCollect } from "./flow.js";
import { buildDeployGovPool, DeployParamsSchema } from "./daoDeploy.js";
import type { StateStore } from "../lib/stateStore.js";
import {
  checkDeployCap,
  checkUserKeeperAsset,
  checkTreasuryRemainder,
  checkLinearInitData,
  assertPreflight,
} from "../lib/preflight.js";

/**
 * `dexe_dao_create` — the one-call DAO deploy composite (Phase 1b). Wraps:
 *   avatar CID → DAO IPFS metadata → deploy config (buildDeployGovPool,
 *   reusing the exact predicted-address wiring / settings auto-expand /
 *   executorDescription upload) → sendOrCollect (dryRun / no-signer payloads /
 *   broadcast). Deploy gotchas (cap>minted, LINEAR initData, non-zero
 *   userKeeper asset, mainnet treasury remainder) are pre-flighted with
 *   actionable errors.
 *
 * Validated on BSC testnet (chain 97) only — mainnet deployGovPool is broken
 * upstream (require(false)).
 */

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}
function ok(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// Params minus the two fields the composite derives itself.
const DaoCreateDeployParams = DeployParamsSchema.omit({ descriptionURL: true, name: true });

export function registerDaoCreateTools(
  server: McpServer,
  ctx: ToolContext,
  signer: SignerManager,
  state?: StateStore,
): void {
  const rpc = new RpcProvider(ctx.config);

  server.tool(
    "dexe_dao_create",
    "Create (deploy) a new DeXe DAO in ONE call. Uploads DAO profile metadata to IPFS, builds the " +
      "PoolFactory.deployGovPool tx (predicted-address wiring, 1→5 settings auto-expand, executorDescription " +
      "IPFS upload all handled), pre-flights the known deploy reverts (cap>minted, LINEAR initData, non-zero " +
      "userKeeper asset, mainnet treasury remainder), then signs+broadcasts when DEXE_PRIVATE_KEY is set " +
      "(else returns the TxPayload). Validate on BSC testnet (chain 97) — mainnet deployGovPool is broken upstream. " +
      "`deployer` defaults to the configured signer. Pass avatarCID from dexe_ipfs_upload_avatar / dexe_dao_generate_avatar.",
    {
      chainId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Target chain id. Defaults to the MCP's default chain. Use 97 (BSC testnet) to validate."),
      poolFactory: z.string().optional().describe("PoolFactory override; defaults to ContractsRegistry lookup"),
      deployer: z
        .string()
        .optional()
        .describe("tx.origin that sends the deploy (needed for address prediction). Defaults to the signer address."),
      daoName: z.string().min(1).describe("DAO name (also the deployGovPool pool name)"),
      daoDescription: z.string().default("").describe("DAO description (markdown; uploaded to IPFS as slate)"),
      websiteUrl: z.string().default(""),
      socialLinks: z.array(z.tuple([z.string(), z.string()])).default([]).describe("[[network, url], ...]"),
      avatarCID: z.string().default("").describe("IPFS CID of an already-pinned JPEG avatar (dexe_ipfs_upload_avatar)"),
      avatarFileName: z.string().default("avatar.jpeg"),
      params: DaoCreateDeployParams,
      dryRun: z.boolean().default(false).describe("If true, return the deploy TxPayload even when DEXE_PRIVATE_KEY is set."),
    },
    async (input) => {
      if (!ctx.config.pinataJwt) return err("DEXE_PINATA_JWT required for DAO creation (IPFS metadata upload).");

      const deployer = input.deployer ?? (signer.hasSigner() ? signer.getAddress() : undefined);
      if (!deployer) return err("Provide 'deployer' address or set DEXE_PRIVATE_KEY.");

      const chain = resolveChain(ctx.config, input.chainId);
      const chainId = chain.chainId;
      const pinata = new PinataClient(ctx.config.pinataJwt);

      // ---------- deploy preflight (fail fast, before the RPC-heavy predict) ----------
      const isTokenCreation = input.params.tokenParams.name.length > 0;
      try {
        assertPreflight([
          checkDeployCap(input.params.tokenParams.cap, input.params.tokenParams.mintedTotal, isTokenCreation),
          checkUserKeeperAsset(
            input.params.userKeeperParams.tokenAddress,
            input.params.userKeeperParams.nftAddress,
            isTokenCreation,
          ),
          checkTreasuryRemainder(
            input.params.tokenParams.mintedTotal,
            input.params.tokenParams.amounts,
            chainId,
            isTokenCreation,
          ),
          // LINEAR initData is auto-encoded by the deploy builder; this only trips
          // if a caller hand-passes a wrong CUSTOM/LINEAR override.
          checkLinearInitData(input.params.votePowerParams.voteType, input.params.votePowerParams.initData),
        ]);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
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
        documents: [],
      };
      if (input.avatarCID) {
        daoMeta.avatarCID = input.avatarCID;
        daoMeta.avatarFileName = input.avatarFileName;
        daoMeta.avatarUrl = `https://${input.avatarCID}.ipfs.dweb.link/${input.avatarFileName}`;
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
          params: { ...input.params, descriptionURL, name: input.daoName },
        },
        ctx,
        rpc,
      );
      if (!res.ok) return err(res.error);

      // ---------- send or collect ----------
      let result;
      try {
        result = await sendOrCollect(signer, [res.payload], { dryRun: input.dryRun, chainId });
      } catch (e) {
        return err(`Deploy broadcast failed: ${e instanceof Error ? e.message : String(e)}`);
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

      return ok({
        mode: result.mode,
        daoName: input.daoName,
        chainId,
        deployer,
        descriptionURL,
        predictedGovPool: res.predictedGovPool ?? null,
        predicted: res.predicted,
        note: res.note,
        steps: result.steps,
        ...(result.enableWrites ? { enableWrites: result.enableWrites } : {}),
      });
    },
  );
}
