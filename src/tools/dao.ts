import { z } from "zod";
import { Contract, Interface, isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { RpcProvider } from "../rpc.js";
import { AddressBook, CONTRACT_NAMES } from "../lib/addresses.js";
import { multicall, type Call } from "../lib/multicall.js";

const POOL_FACTORY_ABI = [
  "function predictGovAddresses(address deployer, string poolName) view returns (tuple(address govPool, address govTokenSale, address govToken, address distributionProposal, address expertNft, address nftMultiplier))",
] as const;

const POOL_REGISTRY_ABI = [
  "function isGovPool(address potentialPool) view returns (bool)",
] as const;

const GOV_POOL_ABI = [
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
  "function getNftContracts() view returns (address nftMultiplier, address expertNft, address dexeExpertNft, address babt)",
  "function descriptionURL() view returns (string)",
  "function name() view returns (string)",
] as const;

const GOV_VALIDATORS_ABI = [
  "function validatorsCount() view returns (uint256)",
] as const;

export function registerDaoTools(server: McpServer, ctx: ToolContext): void {
  const rpc = new RpcProvider(ctx.config);

  function requireBook(): AddressBook {
    const provider = rpc.requireProvider();
    return new AddressBook({
      provider,
      chainId: ctx.config.chainId,
      registryOverride: ctx.config.registryOverride,
    });
  }

  registerPredictAddresses(server, ctx, requireBook);
  registerRegistryLookup(server, ctx, requireBook);
  registerDaoInfo(server, ctx, rpc, requireBook);
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// ---------- dexe_dao_predict_addresses ----------

function registerPredictAddresses(
  server: McpServer,
  ctx: ToolContext,
  requireBook: () => AddressBook,
): void {
  server.registerTool(
    "dexe_dao_predict_addresses",
    {
      title: "Predict addresses for a future DAO deployment",
      description:
        "Calls `PoolFactory.predictGovAddresses(deployer, poolName)` and returns the six CREATE2-predicted addresses (govPool, govTokenSale, govToken, distributionProposal, expertNft, nftMultiplier). Useful for wiring configs before a DAO is actually deployed.",
      inputSchema: {
        deployer: z.string().describe("Address that will send the deployGovPool tx (tx.origin)"),
        poolName: z.string().describe("Unique pool name — part of the CREATE2 salt"),
      },
      outputSchema: {
        govPool: z.string(),
        govTokenSale: z.string(),
        govToken: z.string(),
        distributionProposal: z.string(),
        expertNft: z.string(),
        nftMultiplier: z.string(),
      },
    },
    async ({ deployer, poolName }) => {
      if (!isAddress(deployer)) return errorResult(`Invalid deployer address: ${deployer}`);
      if (!poolName || poolName.length === 0) return errorResult("poolName must be non-empty");

      try {
        const book = requireBook();
        const factoryAddr = await book.resolve(CONTRACT_NAMES.POOL_FACTORY);
        const factory = new Contract(factoryAddr, POOL_FACTORY_ABI, book.provider);
        const res = await factory.getFunction("predictGovAddresses").staticCall(deployer, poolName);
        const structured = {
          govPool: res.govPool as string,
          govTokenSale: res.govTokenSale as string,
          govToken: res.govToken as string,
          distributionProposal: res.distributionProposal as string,
          expertNft: res.expertNft as string,
          nftMultiplier: res.nftMultiplier as string,
        };
        const text =
          `Predicted addresses for pool "${poolName}" deployed by ${deployer}:\n` +
          `  govPool              : ${structured.govPool}\n` +
          `  govTokenSale         : ${structured.govTokenSale}\n` +
          `  govToken             : ${structured.govToken}\n` +
          `  distributionProposal : ${structured.distributionProposal}\n` +
          `  expertNft            : ${structured.expertNft}\n` +
          `  nftMultiplier        : ${structured.nftMultiplier}`;
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(
          `Failed to predict addresses: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}

// ---------- dexe_dao_registry_lookup ----------

function registerRegistryLookup(
  server: McpServer,
  ctx: ToolContext,
  requireBook: () => AddressBook,
): void {
  server.registerTool(
    "dexe_dao_registry_lookup",
    {
      title: "Check whether an address is a DeXe GovPool",
      description:
        "Calls `PoolRegistry.isGovPool(address)` on the configured chain. Returns true if the address is a registered DeXe DAO GovPool.",
      inputSchema: {
        address: z.string().describe("Candidate GovPool address"),
      },
      outputSchema: {
        address: z.string(),
        isGovPool: z.boolean(),
        poolRegistry: z.string(),
        chainId: z.number(),
      },
    },
    async ({ address }) => {
      if (!isAddress(address)) return errorResult(`Invalid address: ${address}`);
      try {
        const book = requireBook();
        const registryAddr = await book.resolve(CONTRACT_NAMES.POOL_REGISTRY);
        const reg = new Contract(registryAddr, POOL_REGISTRY_ABI, book.provider);
        const isGov: boolean = await reg.getFunction("isGovPool").staticCall(address);
        const structured = {
          address,
          isGovPool: isGov,
          poolRegistry: registryAddr,
          chainId: ctx.config.chainId,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `${address} ${isGov ? "IS" : "is NOT"} a GovPool on chainId=${ctx.config.chainId} (PoolRegistry=${registryAddr}).`,
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(
          `Registry lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}

// ---------- dexe_dao_info ----------

function registerDaoInfo(
  server: McpServer,
  ctx: ToolContext,
  rpc: RpcProvider,
  requireBook: () => AddressBook,
): void {
  server.registerTool(
    "dexe_dao_info",
    {
      title: "DAO overview — helpers, NFT contracts, validator count",
      description:
        "Given a GovPool address, batch-reads helper addresses (settings/userKeeper/validators/poolRegistry/votePower), NFT contract addresses, description URL, and live validator count. One multicall RPC round-trip.",
      inputSchema: {
        govPool: z.string().describe("GovPool contract address"),
      },
      outputSchema: {
        govPool: z.string(),
        descriptionURL: z.string().nullable(),
        helpers: z.object({
          settings: z.string(),
          userKeeper: z.string(),
          validators: z.string(),
          poolRegistry: z.string(),
          votePower: z.string(),
        }),
        nftContracts: z.object({
          nftMultiplier: z.string(),
          expertNft: z.string(),
          dexeExpertNft: z.string(),
          babt: z.string(),
        }),
        validatorsCount: z.string().nullable(),
      },
    },
    async ({ govPool }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid GovPool address: ${govPool}`);
      try {
        const provider = rpc.requireProvider();
        const gpIface = new Interface(GOV_POOL_ABI as unknown as string[]);
        const vIface = new Interface(GOV_VALIDATORS_ABI as unknown as string[]);

        // Stage 1: helpers + nft contracts + descriptionURL
        const stage1: Call[] = [
          { target: govPool, iface: gpIface, method: "getHelperContracts", args: [], allowFailure: true },
          { target: govPool, iface: gpIface, method: "getNftContracts", args: [], allowFailure: true },
          { target: govPool, iface: gpIface, method: "descriptionURL", args: [], allowFailure: true },
        ];
        const [helpersR, nftR, descR] = await multicall(provider, stage1);

        if (!helpersR?.success || !nftR?.success) {
          return errorResult(
            `GovPool ${govPool} did not return helpers or NFT contracts — is it a valid GovPool? (registry lookup first via dexe_dao_registry_lookup)`,
          );
        }

        const hv = helpersR.value as unknown as {
          settings: string;
          userKeeper: string;
          validators: string;
          poolRegistry: string;
          votePower: string;
        };
        const nv = nftR.value as unknown as {
          nftMultiplier: string;
          expertNft: string;
          dexeExpertNft: string;
          babt: string;
        };
        const helpers = {
          settings: hv.settings,
          userKeeper: hv.userKeeper,
          validators: hv.validators,
          poolRegistry: hv.poolRegistry,
          votePower: hv.votePower,
        };
        const nftContracts = {
          nftMultiplier: nv.nftMultiplier,
          expertNft: nv.expertNft,
          dexeExpertNft: nv.dexeExpertNft,
          babt: nv.babt,
        };

        // Stage 2: validator count on the validators contract
        let validatorsCount: string | null = null;
        if (helpers.validators && isAddress(helpers.validators)) {
          const [vcR] = await multicall(provider, [
            {
              target: helpers.validators,
              iface: vIface,
              method: "validatorsCount",
              args: [],
              allowFailure: true,
            },
          ]);
          if (vcR?.success && vcR.value != null) {
            validatorsCount = (vcR.value as bigint).toString();
          }
        }

        const descriptionURL =
          descR?.success && typeof descR.value === "string" ? (descR.value as string) : null;

        // Use requireBook so we fail clearly if chain support is missing — even
        // though dao_info doesn't otherwise need the registry.
        requireBook();

        const structured = {
          govPool,
          descriptionURL,
          helpers,
          nftContracts,
          validatorsCount,
        };
        const text =
          `GovPool ${govPool}\n` +
          `  descriptionURL: ${descriptionURL ?? "(none)"}\n` +
          `  validators: ${validatorsCount ?? "?"}\n\n` +
          `Helpers:\n` +
          `  settings     : ${helpers.settings}\n` +
          `  userKeeper   : ${helpers.userKeeper}\n` +
          `  validators   : ${helpers.validators}\n` +
          `  poolRegistry : ${helpers.poolRegistry}\n` +
          `  votePower    : ${helpers.votePower}\n\n` +
          `NFT contracts:\n` +
          `  nftMultiplier : ${nftContracts.nftMultiplier}\n` +
          `  expertNft     : ${nftContracts.expertNft}\n` +
          `  dexeExpertNft : ${nftContracts.dexeExpertNft}\n` +
          `  babt          : ${nftContracts.babt}`;
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(
          `dao_info failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}
