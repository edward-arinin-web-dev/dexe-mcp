import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerProposalBuildOffchainTools } from "../../src/tools/proposalBuildOffchain.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { SignerManager } from "../../src/lib/signer.js";
import type { WalletConnectManager } from "../../src/lib/walletconnect.js";

/**
 * First unit coverage for the off-chain (DeXe backend) builders. docs/TEST_BACKLOG.md
 * ordered exactly this — "add unit test that snapshots the body and asserts `type`
 * against registered constants" — after bug B shipped a unix timestamp as the
 * proposal `type` (400 "proposal type was not found"), and bug C shipped quorum
 * percentages 100x too large. Both are body-shape defects no on-chain test can
 * catch, and the file had zero tests until now.
 *
 * These tools NEVER send HTTP (except the dexe_auth_login composite): they return
 * the request for the caller to dispatch. So the request object IS the product,
 * and asserting its shape is asserting behavior.
 */

const BASE = "https://backend.example";
const POOL = "0xcae32fa6e6d1c223ed1047caa58f7fc0b2d65b41";
const ADDR = "0x1111111111111111111111111111111111111111";

interface OffchainRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

const signerStub = (address: string, sig: string) =>
  ({
    hasSigner: () => true,
    getAddress: () => address,
    signMessage: async (_m: string) => sig,
  }) as unknown as SignerManager;

const wcStub = (connected: boolean) =>
  ({
    isConnected: () => connected,
    account: () => (connected ? ADDR : undefined),
    signMessage: async (_m: string) => "0xwc",
  }) as unknown as WalletConnectManager;

async function callTool(
  name: string,
  args: Record<string, unknown>,
  opts: { signer?: SignerManager; wc?: WalletConnectManager } = {},
): Promise<ToolResult> {
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerProposalBuildOffchainTools(
    server,
    { config: {} } as unknown as ToolContext,
    opts.signer,
    opts.wc,
  );
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

const req = (r: ToolResult) => r.structuredContent!.request as OffchainRequest;
/** JSON:API `data.attributes` of the emitted request body. */
const attrs = (r: ToolResult) =>
  (req(r).body as { data: { type: string; attributes: Record<string, unknown> } }).data.attributes;
const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

const PROPOSAL_ARGS = {
  poolAddress: POOL,
  chainId: 56,
  title: "Fund the grants program",
  description: "**bold** plan",
  voteOptions: ["Alpha", "Beta"],
  votingDurationSeconds: "86400",
};

const originalBase = process.env.DEXE_BACKEND_API_URL;

beforeEach(() => {
  process.env.DEXE_BACKEND_API_URL = BASE;
});

afterEach(() => {
  if (originalBase === undefined) delete process.env.DEXE_BACKEND_API_URL;
  else process.env.DEXE_BACKEND_API_URL = originalBase;
});

// ---------- auth ----------

describe("dexe_auth_request_nonce", () => {
  it("emits the nonce POST with the JSON:API auth_nonce_request body", async () => {
    const r = await callTool("dexe_auth_request_nonce", { address: ADDR });
    expect(r.isError).toBeFalsy();
    expect(req(r).method).toBe("POST");
    expect(req(r).url).toBe(`${BASE}/integrations/nonce-auth-svc/nonce`);
    expect(req(r).headers["Content-Type"]).toBe("application/json");
    // Step 1 of 2 — there is no token yet, so it must NOT ask for one.
    expect(r.structuredContent!.authRequired).toBe(false);
    expect(req(r).headers.Authorization).toBeUndefined();
    expect(req(r).body).toEqual({
      data: { type: "auth_nonce_request", attributes: { address: ADDR } },
    });
  });

  it("rejects a malformed address instead of emitting a request", async () => {
    const r = await callTool("dexe_auth_request_nonce", { address: "0xnope" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Invalid address/);
  });
});

describe("dexe_auth_login_request", () => {
  it("emits the login POST with the auth_pair body", async () => {
    const r = await callTool("dexe_auth_login_request", { address: ADDR, signedMessage: "0xdead" });
    expect(req(r).url).toBe(`${BASE}/integrations/nonce-auth-svc/login`);
    expect(req(r).body).toEqual({
      data: {
        type: "login_request",
        attributes: { auth_pair: { address: ADDR, signed_message: "0xdead" } },
      },
    });
  });
});

describe("dexe_auth_login (composite)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("fetches the nonce, signs it, logs in, and returns the Bearer token", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/nonce")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { attributes: { message: "sign-me" } } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            relationships: {
              access_token: { data: { id: "access-123" } },
              refresh_token: { data: { id: "refresh-456" } },
            },
          },
          included: [{ type: "access_jwt", attributes: { expires_in: 99 } }],
        }),
      };
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const r = await callTool(
      "dexe_auth_login",
      {},
      { signer: signerStub(ADDR, "0xsigned"), wc: wcStub(false) },
    );
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      accessToken: "access-123",
      refreshToken: "refresh-456",
      address: ADDR,
      expiresIn: 99,
      signerMode: "eoa",
    });
    // The signature — not the private key — is what leaves the server.
    const loginBody = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body));
    expect(loginBody.data.attributes.auth_pair.signed_message).toBe("0xsigned");
  });

  it("without any signer it points at the manual nonce → sign → login path", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const r = await callTool(
      "dexe_auth_login",
      {},
      {
        signer: { hasSigner: () => false } as unknown as SignerManager,
        wc: wcStub(false),
      },
    );
    expect(r.isError).toBeFalsy();
    expect(String(r.structuredContent!.note)).toMatch(/dexe_auth_request_nonce/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------- proposal builders ----------

describe("dexe_proposal_build_offchain_single_option", () => {
  it("emits a one_of proposal against the proposals endpoint, auth required", async () => {
    const r = await callTool("dexe_proposal_build_offchain_single_option", PROPOSAL_ARGS);
    expect(r.isError).toBeFalsy();
    expect(req(r).method).toBe("POST");
    expect(req(r).url).toBe(`${BASE}/integrations/voting/proposals`);
    expect(r.structuredContent!.authRequired).toBe(true);
    expect(req(r).headers.Authorization).toBe("Bearer <ACCESS_TOKEN>");
    const a = attrs(r);
    expect(a.pool_address).toBe(POOL);
    expect(a.vote_options).toEqual(["Alpha", "Beta"]);
    expect((a.custom_parameters as { voting_type: string }).voting_type).toBe("one_of");
  });

  it("bug B: `type` is the registered template name in BOTH places, never a timestamp", async () => {
    const a = attrs(await callTool("dexe_proposal_build_offchain_single_option", PROPOSAL_ARGS));
    expect(a.type).toBe("default_single_option_type");
    expect((a.custom_parameters as { type: string }).type).toBe("default_single_option_type");
    expect(String(a.type)).not.toMatch(/^\d+$/);
  });

  it("bug C: quorum percents cross the boundary as fractions (50 → 0.5)", async () => {
    const a = attrs(
      await callTool("dexe_proposal_build_offchain_single_option", {
        ...PROPOSAL_ARGS,
        generalClosingPercent: 50,
        anticipatoryClosingPercent: 25,
        againstPercent: 10,
      }),
    );
    expect((a.custom_parameters as { quorum: unknown }).quorum).toEqual({
      one_of_quorum: {
        general_closing_percent: 0.5,
        anticipatory_closing_percent: 0.25,
        against_percent: 0.1,
      },
    });
  });

  it("chainId is honored verbatim — it is what files the proposal against a pool", async () => {
    const mainnet = attrs(await callTool("dexe_proposal_build_offchain_single_option", PROPOSAL_ARGS));
    const testnet = attrs(
      await callTool("dexe_proposal_build_offchain_single_option", { ...PROPOSAL_ARGS, chainId: 97 }),
    );
    expect(mainnet.chain_id).toBe(56);
    expect(testnet.chain_id).toBe(97);
  });

  it("description is Markdown converted to Slate and JSON-stringified", async () => {
    const a = attrs(await callTool("dexe_proposal_build_offchain_single_option", PROPOSAL_ARGS));
    const slate = JSON.parse(String(a.description)) as Array<{ type: string }>;
    expect(Array.isArray(slate)).toBe(true);
    expect(slate[0]!.type).toBe("paragraph");
    expect(JSON.stringify(slate)).toContain('"bold":true');
  });

  it("rejects a malformed poolAddress instead of emitting a request", async () => {
    const r = await callTool("dexe_proposal_build_offchain_single_option", {
      ...PROPOSAL_ARGS,
      poolAddress: "0xnope",
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Invalid poolAddress/);
  });
});

describe("dexe_proposal_build_offchain_multi_option", () => {
  it("emits multiple_of with the plural default type (not 'multi')", async () => {
    const a = attrs(await callTool("dexe_proposal_build_offchain_multi_option", PROPOSAL_ARGS));
    expect(a.type).toBe("default_multiple_option_type");
    expect((a.custom_parameters as { voting_type: string }).voting_type).toBe("multiple_of");
    expect(a.chain_id).toBe(56);
  });

  it("bug C: boundary/against percents are fractions too", async () => {
    const a = attrs(
      await callTool("dexe_proposal_build_offchain_multi_option", {
        ...PROPOSAL_ARGS,
        boundaryPercent: 60,
        againstPercent: 20,
      }),
    );
    expect((a.custom_parameters as { quorum: unknown }).quorum).toEqual({
      multiple_of_quorum: { boundary_percent: 0.6, against_percent: 0.2 },
    });
  });
});

describe("dexe_proposal_build_offchain_for_against", () => {
  it("F22: refuses and names the supported builder instead of emitting a doomed request", async () => {
    const r = await callTool("dexe_proposal_build_offchain_for_against", PROPOSAL_ARGS);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/NOT supported/);
    expect(text(r)).toMatch(/dexe_proposal_build_offchain_single_option/);
    expect(r.structuredContent).toBeUndefined();
  });
});

describe("dexe_proposal_build_offchain_settings", () => {
  const SETTINGS_ARGS = {
    poolAddress: POOL,
    chainId: 56,
    title: "New template",
    description: "why",
    votingDurationSeconds: "3600",
    quorum: { one_of_quorum: { general_closing_percent: 0.5 } },
  };

  it("create_proposal_type: attributes.type mirrors the mode, chain_id is honored", async () => {
    const r = await callTool("dexe_proposal_build_offchain_settings", {
      ...SETTINGS_ARGS,
      mode: "create_proposal_type",
      chainId: 97,
    });
    expect(r.isError).toBeFalsy();
    expect(req(r).url).toBe(`${BASE}/integrations/voting/proposals`);
    expect(r.structuredContent!.authRequired).toBe(true);
    const a = attrs(r);
    expect(a.type).toBe("create_proposal_type");
    expect((a.custom_parameters as { type: string }).type).toBe("create_proposal_type");
    expect(a.chain_id).toBe(97);
  });

  it("edit_proposal_type passes the quorum object through untouched", async () => {
    const a = attrs(
      await callTool("dexe_proposal_build_offchain_settings", {
        ...SETTINGS_ARGS,
        mode: "edit_proposal_type",
      }),
    );
    expect(a.type).toBe("edit_proposal_type");
    // Already fractions here — the caller supplies the backend's own shape, so
    // (unlike the option builders) there is no /100 boundary conversion.
    expect((a.custom_parameters as { quorum: unknown }).quorum).toEqual(SETTINGS_ARGS.quorum);
  });

  it("rejects a for_against votingType with the F22 guidance", async () => {
    const r = await callTool("dexe_proposal_build_offchain_settings", {
      ...SETTINGS_ARGS,
      mode: "create_proposal_type",
      votingType: "for_against",
    });
    expect(r.isError).toBe(true);
  });
});

// ---------- votes ----------

describe("dexe_offchain_build_vote", () => {
  it("emits the vote POST with the selected options", async () => {
    const r = await callTool("dexe_offchain_build_vote", {
      proposalId: 58,
      voterAddress: ADDR,
      options: ["Alpha"],
    });
    expect(req(r).method).toBe("POST");
    expect(req(r).url).toBe(`${BASE}/integrations/voting/vote`);
    expect(r.structuredContent!.authRequired).toBe(true);
    expect(req(r).body).toEqual({
      data: {
        type: "votes",
        attributes: { proposal_id: 58, voter_address: ADDR, options: ["Alpha"] },
      },
    });
  });

  it("rejects a malformed voterAddress", async () => {
    const r = await callTool("dexe_offchain_build_vote", {
      proposalId: 1,
      voterAddress: "0xnope",
      options: ["Alpha"],
    });
    expect(r.isError).toBe(true);
  });
});

describe("dexe_offchain_build_cancel_vote", () => {
  it("emits a DELETE keyed by proposalId + voter, with no body", async () => {
    const r = await callTool("dexe_offchain_build_cancel_vote", {
      proposalId: 58,
      voterAddress: ADDR,
    });
    expect(req(r).method).toBe("DELETE");
    expect(req(r).url).toBe(`${BASE}/integrations/voting/vote/58/${ADDR}`);
    expect(req(r).body).toBeNull();
    expect(r.structuredContent!.authRequired).toBe(true);
  });
});

// ---------- base URL resolution ----------

describe("backend base URL", () => {
  it("strips a trailing slash so the path never doubles up", async () => {
    process.env.DEXE_BACKEND_API_URL = `${BASE}/`;
    const r = await callTool("dexe_offchain_build_vote", {
      proposalId: 1,
      voterAddress: ADDR,
      options: ["Alpha"],
    });
    expect(req(r).url).toBe(`${BASE}/integrations/voting/vote`);
  });

  it("falls back to the baked default when the env var is unset", async () => {
    delete process.env.DEXE_BACKEND_API_URL;
    const r = await callTool("dexe_offchain_build_vote", {
      proposalId: 1,
      voterAddress: ADDR,
      options: ["Alpha"],
    });
    expect(req(r).url).toBe("https://api.dexe.io/integrations/voting/vote");
  });
});
