import { describe, expect, it } from "vitest";
import { Interface } from "ethers";
import { CalldataDecoder } from "../../src/lib/decoders.js";
import type { Artifacts } from "../../src/artifacts.js";
import type { SelectorIndex } from "../../src/lib/selectors.js";

/**
 * C-1 / decode-no-recursion guardrail. dexe_decode_* used to render only the
 * top-level wrapper, so a `multicall([withdrawTokens(...)])` showed as just
 * "GovPool.multicall(bytes[])" and a reviewer never saw the hidden privileged
 * call. The decoder now recursively unwraps nested calldata and flags
 * C-2-class privileged selectors. Built on minimal ABI mocks (no compiled
 * artifacts needed).
 */

const ABIS: Record<string, string[]> = {
  GovPool: [
    "function multicall(bytes[] data) returns (bytes[])",
    "function editDescriptionURL(string url)",
  ],
  GovUserKeeper: ["function withdrawTokens(address payer, address receiver, uint256 amount)"],
};

const selToContract = new Map<string, string>();
for (const [name, abi] of Object.entries(ABIS)) {
  new Interface(abi).forEachFunction((f) => selToContract.set(f.selector.toLowerCase(), name));
}

const selectors = {
  find(selector: string) {
    const c = selToContract.get(selector.toLowerCase());
    return c ? [{ kind: "function", contract: c, signature: "", selector }] : [];
  },
} as unknown as SelectorIndex;

const artifacts = {
  get(name: string) {
    return ABIS[name]
      ? [{ contractName: name, sourceName: `contracts/${name}.sol`, abi: ABIS[name] }]
      : [];
  },
} as unknown as Artifacts;

const decoder = new CalldataDecoder(artifacts, selectors);

const V = "0x1111111111111111111111111111111111111111";
const A = "0x2222222222222222222222222222222222222222";

describe("recursive decoder (C-1 / decode-no-recursion)", () => {
  it("unwraps a multicall and reveals the hidden inner call", () => {
    const keeper = new Interface(ABIS.GovUserKeeper!);
    const inner = keeper.encodeFunctionData("withdrawTokens", [V, A, 10n ** 18n]);
    const gov = new Interface(["function multicall(bytes[] data) returns (bytes[])"]);
    const outer = gov.encodeFunctionData("multicall", [[inner]]);

    const { primary } = decoder.decodeCalldata(outer);
    expect(primary?.signature).toContain("multicall");
    expect(primary?.nested?.length).toBe(1);
    expect(primary?.nested?.[0]?.signature).toContain("withdrawTokens");
  });

  it("flags the hidden withdrawTokens as a PRIVILEGED (C-2-class) selector", () => {
    const keeper = new Interface(ABIS.GovUserKeeper!);
    const inner = keeper.encodeFunctionData("withdrawTokens", [V, A, 1n]);
    const gov = new Interface(["function multicall(bytes[] data) returns (bytes[])"]);
    const outer = gov.encodeFunctionData("multicall", [[inner]]);

    const nested = decoder.decodeCalldata(outer).primary?.nested?.[0];
    expect(nested?.privileged).toBe(true);
  });

  it("recurses through two multicall layers", () => {
    const keeper = new Interface(ABIS.GovUserKeeper!);
    const gov = new Interface(["function multicall(bytes[] data) returns (bytes[])"]);
    const inner = keeper.encodeFunctionData("withdrawTokens", [V, A, 1n]);
    const mid = gov.encodeFunctionData("multicall", [[inner]]);
    const outer = gov.encodeFunctionData("multicall", [[mid]]);

    const top = decoder.decodeCalldata(outer).primary;
    expect(top?.nested?.[0]?.signature).toContain("multicall");
    expect(top?.nested?.[0]?.nested?.[0]?.signature).toContain("withdrawTokens");
  });

  it("does not spuriously recurse a plain string/address arg", () => {
    const gov = new Interface(ABIS.GovPool!);
    const data = gov.encodeFunctionData("editDescriptionURL", ["PWNED-hidden"]);
    const { primary } = decoder.decodeCalldata(data);
    expect(primary?.signature).toContain("editDescriptionURL");
    expect(primary?.nested).toBeUndefined();
    expect(primary?.privileged).toBe(false);
  });
});
