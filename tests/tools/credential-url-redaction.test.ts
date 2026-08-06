import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerIpfsTools } from "../../src/tools/ipfs.js";
import { registerSafeTools } from "../../src/tools/safe.js";
import type { ToolContext } from "../../src/tools/context.js";
import { SignerManager } from "../../src/lib/signer.js";
import type { DexeConfig } from "../../src/config.js";

/**
 * W36, second surface: the IPFS and Safe tools.
 *
 * The original W36 finding was about ethers appending a keyed RPC URL to
 * `err.message`. The same leak exists on two endpoints the operator configures
 * by URL — `DEXE_IPFS_GATEWAY` / `DEXE_IPFS_GATEWAYS_FALLBACK` and
 * `DEXE_SAFE_TX_SERVICE_URL` — because a URL can carry its credential inline
 * (`https://user:key@host/…`, or a token in the query) regardless of whether
 * the service ALSO accepts a Bearer header.
 *
 * And it is not a hypothetical: `fetch()` refuses a credentialed URL outright
 * with
 *
 *   TypeError: Request cannot be constructed from a URL that includes
 *   credentials: https://user:KEY@host/path
 *
 * — the whole URL, key included, inside `err.message`. `fetchIpfs` then folds
 * that into its per-gateway error list alongside the gateway string itself, so
 * a tool that echoes the raw message publishes the key twice, into the model
 * context and the transcript.
 *
 * These tests use that real undici behaviour rather than a hand-built Error, so
 * they fail against the pre-fix tree for the real reason. No socket is opened:
 * the refusal happens while constructing the Request, before DNS.
 *
 * tests/lib/no-raw-error-echo.test.ts is the static half of this guard (the
 * ternary must not come back); this is the behavioural half (the sink must
 * actually scrub).
 */

const GW_USER = "gwuser";
const GW_SECRET = "s3cr3t-gateway-key";
const CREDENTIALED_GATEWAY = `https://${GW_USER}:${GW_SECRET}@gateway.invalid`;

const SAFE_USER = "safeuser";
const SAFE_SECRET = "s3cr3t-safe-service-key";
const CREDENTIALED_SAFE_SERVICE = `https://${SAFE_USER}:${SAFE_SECRET}@safe-service.invalid/api/v2`;

const PIN_SECRET = "s3cr3t-pinata-key";

/** Any well-formed CID — nothing is ever fetched. */
const SOME_CID = "QmSLwX3b5hpMK57vtaReB35EKog2xxMRskmLicK92L8EAD";

/** Throwaway key, never funded. Signing here is local (EIP-712), never broadcast. */
const PK = "0x0000000000000000000000000000000000000000000000000000000000000001";

const SAFE_ADDR = "0x1111111111111111111111111111111111111111";
const TO_ADDR = "0x2222222222222222222222222222222222222222";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * Capture handlers off both registration shapes in use:
 * `registerTool(name, def, handler)` (ipfs.ts) and
 * `tool(name, description, schema, handler)` (safe.ts).
 */
function captureTools(): { tools: Map<string, ToolHandler>; server: McpServer } {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _def: unknown, handler: ToolHandler) => tools.set(name, handler),
    tool: (name: string, ...rest: unknown[]) => tools.set(name, rest[rest.length - 1] as ToolHandler),
  } as unknown as McpServer;
  return { tools, server };
}

function cfg(partial: Partial<DexeConfig>): DexeConfig {
  return {
    agentKeys: {},
    chains: new Map([[97, { chainId: 97, rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"] }]]),
    defaultChainId: 97,
    ...partial,
  } as unknown as DexeConfig;
}

/** The text an MCP client (and the model) actually sees. */
function textOf(res: ToolResult): string {
  return res.content.map((c) => c.text).join("\n");
}

const ENV_KEYS = [
  "DEXE_IPFS_GATEWAY",
  "DEXE_IPFS_GATEWAYS_FALLBACK",
  "DEXE_IPFS_DISABLE_PUBLIC_FALLBACK",
  "DEXE_PINATA_GATEWAY_TOKEN",
  "DEXE_SAFE_TX_SERVICE_URL",
  "DEXE_SAFE_API_KEY",
] as const;

describe("credentialed endpoint URLs never reach the tool result", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  // ---------- IPFS ----------

  describe("IPFS gateway key (DEXE_IPFS_GATEWAY with inline credentials)", () => {
    function ipfsTools(): Map<string, ToolHandler> {
      // Gateways are resolved at registration time, so the env must be set first.
      process.env.DEXE_IPFS_GATEWAY = CREDENTIALED_GATEWAY;
      const { tools, server } = captureTools();
      registerIpfsTools(server, { config: { pinataJwt: "test-jwt" } } as unknown as ToolContext);
      return tools;
    }

    it("dexe_ipfs_fetch: gateway credentials are stripped, the host is kept", async () => {
      const res = await ipfsTools().get("dexe_ipfs_fetch")!({ cid: SOME_CID, timeoutMs: 500 });

      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).not.toContain(GW_SECRET);
      expect(text).not.toContain(GW_USER);
      // Redacted, not swallowed: the operator still has to be able to tell WHICH
      // endpoint failed, otherwise the fix for a leak becomes a new mystery.
      expect(text).toContain("gateway.invalid");
      expect(text).toContain("dexe_ipfs_fetch failed");
    });

    it("dexe_ipfs_update_dao_metadata: same gateway, same scrub", async () => {
      const res = await ipfsTools().get("dexe_ipfs_update_dao_metadata")!({
        currentDescriptionURL: SOME_CID,
        overrides: { daoName: "Riverbend Assembly" },
        timeoutMs: 500,
      });

      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).not.toContain(GW_SECRET);
      expect(text).not.toContain(GW_USER);
      expect(text).toContain("dexe_ipfs_update_dao_metadata failed");
    });

    it("dexe_ipfs_cid_info: the gateway list it prints carries no credentials", async () => {
      const res = await ipfsTools().get("dexe_ipfs_cid_info")!({ cid: SOME_CID });

      expect(res.isError).toBeFalsy();
      const urls = res.structuredContent?.gatewayUrls as string[];
      expect(urls.join("\n")).not.toContain(GW_SECRET);
      expect(textOf(res)).not.toContain(GW_SECRET);
      // Userinfo only: the CID path is the reason the field exists.
      expect(urls[0]).toBe(`https://gateway.invalid/ipfs/${SOME_CID}`);
    });

    it("dexe_ipfs_upload_dao_metadata: the avatar-probe warning is scrubbed too", async () => {
      // checkAvatarCidBytes builds its own per-gateway error list and returns it
      // as a plain string, so it never passes through the tool's catch-all sink
      // — and the warning rides out on the SUCCESS path, where nothing else
      // looks at it.
      const tools = ipfsTools();
      // Pinata and the DeXe cache-warm are canned; the gateway probe is handed
      // to the REAL fetch, which is what refuses the credentialed URL and
      // produces the leaky string this test is about.
      const realFetch = globalThis.fetch;
      vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("api.pinata.cloud") || url.includes("api.dexe.io")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ IpfsHash: SOME_CID, PinSize: 571, Timestamp: "2026-08-06T00:00:00.000Z" }),
              { status: 200 },
            ),
          );
        }
        return realFetch(input as string, init);
      });

      const res = await tools.get("dexe_ipfs_upload_dao_metadata")!({
        daoName: "Riverbend Assembly",
        description: "",
        websiteUrl: "",
        avatarCID: SOME_CID,
        avatarFileName: "avatar.jpeg",
      });

      const text = textOf(res);
      expect(res.isError).toBeFalsy();
      expect(text).toContain("⚠"); // the probe warning really is on this path
      expect(text).toContain("gateway.invalid");
      expect(text).not.toContain(GW_SECRET);
      expect(text).not.toContain(GW_USER);
    });

    it("a stalled gateway keeps the IPFS remedy — it is not blamed on the RPC", async () => {
      // The shared remedy table has no IPFS-gateway entry, so "timed out after
      // …" would fall through to `rpc-timeout` and tell the agent to set
      // DEXE_RPC_URL_* / check dexe_tx_status. Wrong knob, wrong tool.
      process.env.DEXE_IPFS_GATEWAY = "https://gateway.invalid";
      const { tools, server } = captureTools();
      registerIpfsTools(server, { config: { pinataJwt: "test-jwt" } } as unknown as ToolContext);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("timed out after 500ms");
        }),
      );

      const text = textOf(await tools.get("dexe_ipfs_fetch")!({ cid: SOME_CID, timeoutMs: 500 }));
      expect(text).toContain("dexe_ipfs_fetch failed"); // went through the sink at all
      expect(text).toContain("IPFS fetch failed");
      expect(text).not.toContain("DEXE_RPC_URL_MAINNET");
      expect(text).not.toContain("dexe_tx_status");
    });
  });

  describe("Pinata upload failures", () => {
    it("carry the actionable remedy and redact any URL in the service response", async () => {
      const { tools, server } = captureTools();
      registerIpfsTools(server, { config: { pinataJwt: "test-jwt" } } as unknown as ToolContext);
      // Pinata echoes the request back in some error bodies; that body lands in
      // the thrown message verbatim.
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                error: "unauthorized",
                endpoint: `https://pinuser:${PIN_SECRET}@api.pinata.cloud/pinning/pinJSONToIPFS`,
              }),
              { status: 401 },
            ),
        ),
      );

      const res = await tools.get("dexe_ipfs_upload_proposal_metadata")!({
        title: "Fund the winter grant round",
        description: "plain text",
      });

      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).not.toContain(PIN_SECRET);
      expect(text).toContain("dexe_ipfs_upload_proposal_metadata failed");
      // The `pinata-failed` remedy, i.e. the tool says what to do next.
      expect(text).toContain("app.pinata.cloud");
    });
  });

  // ---------- Safe ----------

  describe("Safe Transaction Service key (DEXE_SAFE_TX_SERVICE_URL with inline credentials)", () => {
    function safeTools(privateKey?: string): Map<string, ToolHandler> {
      const config = cfg({ privateKey });
      const { tools, server } = captureTools();
      registerSafeTools(server, { config } as unknown as ToolContext, new SignerManager(config));
      return tools;
    }

    /** Zod defaults are applied by the MCP SDK, which this harness bypasses. */
    const proposeArgs = (over: Record<string, unknown>) => ({
      safe: SAFE_ADDR,
      to: TO_ADDR,
      data: "0x",
      value: "0",
      operation: 0,
      chainId: 97,
      nonce: "0",
      safeTxGas: "0",
      baseGas: "0",
      gasPrice: "0",
      ...over,
    });

    it("dexe_safe_propose_tx: a failed live POST does not echo the service key", async () => {
      process.env.DEXE_SAFE_TX_SERVICE_URL = CREDENTIALED_SAFE_SERVICE;

      const res = await safeTools(PK).get("dexe_safe_propose_tx")!(proposeArgs({ dryRun: false }));

      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).not.toContain(SAFE_SECRET);
      expect(text).not.toContain(SAFE_USER);
      expect(text).toContain("safe-service.invalid");
      expect(text).toContain("dexe_safe_propose_tx failed");
    });

    it("dexe_safe_propose_tx: the dryRun endpoint it prints carries no credentials", async () => {
      process.env.DEXE_SAFE_TX_SERVICE_URL = CREDENTIALED_SAFE_SERVICE;

      const res = await safeTools(PK).get("dexe_safe_propose_tx")!(proposeArgs({ dryRun: true }));

      expect(res.isError).toBeFalsy();
      const payload = JSON.parse(textOf(res)) as {
        endpoint: { base: string; postUrl: string };
      };
      expect(payload.endpoint.base).not.toContain(SAFE_SECRET);
      expect(payload.endpoint.postUrl).not.toContain(SAFE_SECRET);
      // Only the userinfo is dropped: host + path still answer "where would this
      // POST go?", which is the reason the field is shown at all.
      expect(payload.endpoint.base).toBe("https://safe-service.invalid/api/v2");
      expect(payload.endpoint.postUrl).toContain("/multisig-transactions/");
    });

    it("dexe_safe_info: an unresolvable chain reports the endpoint error without leaking", async () => {
      process.env.DEXE_SAFE_TX_SERVICE_URL = CREDENTIALED_SAFE_SERVICE;

      // chainId 999 has no RPC configured → the outer catch, i.e. the classified
      // sink, rather than the endpoint sub-catch.
      const res = await safeTools().get("dexe_safe_info")!({ safe: SAFE_ADDR, chainId: 999 });

      const text = textOf(res);
      expect(text).not.toContain(SAFE_SECRET);
      expect(text).not.toContain(SAFE_USER);
      // Step-labelled, so the agent knows which call produced it.
      expect(text).toContain("dexe_safe_info failed");
    });
  });
});
