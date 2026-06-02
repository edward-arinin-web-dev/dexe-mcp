import { describe, expect, it } from "vitest";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import * as json from "multiformats/codecs/json";
import { sha256 } from "multiformats/hashes/sha2";
import { cidForJson, verifyCidBytes } from "../../src/lib/ipfs.js";
import { isTrustedGraphHost } from "../../src/lib/subgraph.js";

/**
 * W20: dexe_ipfs_fetch returned gateway bytes without checking they hash to the
 * requested CID — a hostile/MitM gateway could substitute content under a real
 * descriptionURL CID. verifyCidBytes re-hashes the bytes (raw/json codecs).
 * W21/L-6: the Graph API key was sent as a Bearer to ANY configured subgraph
 * URL; isTrustedGraphHost gates it to The Graph's own hosts.
 */

describe("verifyCidBytes (W20)", () => {
  const bytes = new TextEncoder().encode("hello dexe");

  it("verifies a raw-codec CID over its own bytes", async () => {
    const cid = CID.create(1, raw.code, await sha256.digest(bytes));
    expect(await verifyCidBytes(cid, bytes)).toBe("verified");
  });

  it("flags tampered bytes as a mismatch (MitM gateway)", async () => {
    const cid = CID.create(1, raw.code, await sha256.digest(bytes));
    expect(await verifyCidBytes(cid, new TextEncoder().encode("HELLO EVIL"))).toBe("mismatch");
  });

  it("verifies a json-codec CID produced by cidForJson", async () => {
    const value = { proposal: "x", n: 1 };
    const cid = CID.parse(await cidForJson(value));
    expect(await verifyCidBytes(cid, json.encode(value))).toBe("verified");
    // a different JSON payload under the same CID is a mismatch
    expect(await verifyCidBytes(cid, json.encode({ proposal: "evil", n: 2 }))).toBe("mismatch");
  });

  it("returns unverifiable for dag-pb (CIDv0) — needs DAG reconstruction", async () => {
    const cidV0 = CID.create(0, 0x70, await sha256.digest(bytes));
    expect(await verifyCidBytes(cidV0, bytes)).toBe("unverifiable");
  });
});

describe("isTrustedGraphHost (W21 / L-6)", () => {
  it("trusts The Graph gateway and Studio hosts", () => {
    expect(isTrustedGraphHost("https://gateway.thegraph.com/api/abc/subgraphs/id/X")).toBe(true);
    expect(isTrustedGraphHost("https://api.studio.thegraph.com/query/1/x/v1")).toBe(true);
  });

  it("refuses arbitrary / hostile endpoints (no key leak)", () => {
    expect(isTrustedGraphHost("https://evil.example.com/api/abc/subgraphs/id/X")).toBe(false);
    expect(isTrustedGraphHost("not a url")).toBe(false);
  });

  it("is not fooled by a thegraph.com substring or look-alike domain", () => {
    expect(isTrustedGraphHost("https://evil.com/thegraph.com/x")).toBe(false);
    expect(isTrustedGraphHost("https://thegraph.com.evil.com/x")).toBe(false);
  });
});
