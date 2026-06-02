import { describe, expect, it } from "vitest";
import { maskUrl, redactUrlCredentials, safeErrorMessage } from "../../src/lib/redact.js";

/**
 * W36 guardrail. A credentialed RPC URL rode in ethers v6 `err.message` on any
 * non-2xx provider response and was emitted verbatim into `content[].text`,
 * leaking the operator's provider API key. `safeErrorMessage` prefers the
 * URL-free `shortMessage` and redacts as a backstop; `maskUrl` masks a URL for
 * deliberate display. These pin that no live key survives to a tool result.
 */

const SECRET = "abcd1234SECRETKEYxyz";

describe("redactUrlCredentials (W36)", () => {
  it("masks user:pass@ userinfo", () => {
    const out = redactUrlCredentials("dial https://alice:s3cr3t@rpc.example.org/path");
    expect(out).toContain("https://***@rpc.example.org/path");
    expect(out).not.toContain("s3cr3t");
    expect(out).not.toContain("alice");
  });

  it("masks Alchemy / Infura / QuickNode / Ankr key segments", () => {
    expect(redactUrlCredentials(`https://bsc-mainnet.g.alchemy.com/v2/${SECRET}`)).not.toContain(SECRET);
    expect(redactUrlCredentials(`https://mainnet.infura.io/v3/${SECRET}`)).not.toContain(SECRET);
    expect(redactUrlCredentials(`https://x.bsc.quiknode.pro/${SECRET}/`)).not.toContain(SECRET);
    expect(redactUrlCredentials(`https://rpc.ankr.com/bsc/${SECRET}`)).not.toContain(SECRET);
  });

  it("masks api-key style query params", () => {
    expect(redactUrlCredentials(`https://node.example.org/rpc?apikey=${SECRET}`)).not.toContain(SECRET);
    expect(redactUrlCredentials(`https://node.example.org/rpc?x=1&key=${SECRET}`)).not.toContain(SECRET);
  });

  it("leaves keyless public nodes untouched", () => {
    const url = "https://bsc-dataseed.bnbchain.org/";
    expect(redactUrlCredentials(`RPC ${url} timed out`)).toContain(url);
  });
});

describe("maskUrl (W36)", () => {
  it("keeps scheme+host but drops the key path", () => {
    expect(maskUrl(`https://bsc-mainnet.g.alchemy.com/v2/${SECRET}`)).toBe(
      "https://bsc-mainnet.g.alchemy.com/***",
    );
  });

  it("masks query strings", () => {
    expect(maskUrl(`https://node.example.org/rpc?apikey=${SECRET}`)).toBe(
      "https://node.example.org/***?***",
    );
  });

  it("does not add /*** for a keyless root URL", () => {
    expect(maskUrl("https://bsc-dataseed.bnbchain.org/")).toBe("https://bsc-dataseed.bnbchain.org");
  });

  it("drops userinfo from the host", () => {
    expect(maskUrl(`https://u:p@rpc.example.org/v2/${SECRET}`)).toBe("https://rpc.example.org/***");
  });
});

describe("safeErrorMessage (W36)", () => {
  it("prefers ethers shortMessage (URL-free) over the verbose message", () => {
    const err = Object.assign(new Error(`could not coalesce error (requestUrl="https://x.g.alchemy.com/v2/${SECRET}")`), {
      shortMessage: "server responded with status 401",
    });
    expect(safeErrorMessage(err)).toBe("server responded with status 401");
  });

  it("redacts the key when only the verbose message is present", () => {
    const err = new Error(`bad response (requestUrl=https://x.g.alchemy.com/v2/${SECRET}, status=401)`);
    const out = safeErrorMessage(err);
    expect(out).not.toContain(SECRET);
  });

  it("handles non-Error throwables", () => {
    expect(safeErrorMessage("plain string")).toBe("plain string");
    expect(safeErrorMessage(undefined)).toBe("undefined");
  });
});
