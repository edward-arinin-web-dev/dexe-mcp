import { describe, it, expect, vi } from "vitest";
import { AbiCoder, Interface } from "ethers";
import { buildReview } from "../../src/lib/approval/review.js";
import { CONTRACTS_REGISTRY_BY_CHAIN } from "../../src/lib/addresses.js";
import type { DexeConfig } from "../../src/config.js";

/**
 * Security review fix 2: the approval page may only call something a
 * "GovPool" — and label its UserKeeper — when the DeXe PoolRegistry confirms
 * it. A fake pool answering getHelperContracts() with an attacker EOA as
 * "UserKeeper" must not make approve(token, attacker) look legitimate.
 */
vi.mock("../../src/lib/simulate.js", async (orig) => {
  const mod = (await orig()) as Record<string, unknown>;
  return { ...mod, simulateCalldata: async () => ({ success: true }) };
});

const CHAIN = 97;
const REGISTRY = CONTRACTS_REGISTRY_BY_CHAIN[CHAIN]!;
const POOL_REGISTRY = "0x00000000000000000000000000000000000000a1";
const POOL = "0x00000000000000000000000000000000000000b2";
const KEEPER = "0x00000000000000000000000000000000000000c3";
const TOKEN = "0x00000000000000000000000000000000000000d4";
const ATTACKER = "0x00000000000000000000000000000000000000e5";
const FROM = "0x00000000000000000000000000000000000000f6";

const REG = new Interface(["function getContract(string name) view returns (address)"]);
const PR = new Interface(["function isGovPool(address) view returns (bool)"]);
const GP = new Interface([
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
  "function deposit(uint256 amount, uint256[] nftIds)",
]);
const UK = new Interface(["function tokenAddress() view returns (address)"]);
const ERC20 = new Interface([
  "function approve(address spender, uint256 amount)",
  "function transfer(address to, uint256 amount)",
  "function symbol() view returns (string)",
]);
const coder = AbiCoder.defaultAbiCoder();

function provider(opts: { registered: boolean; userKeeper: string }) {
  const code: Record<string, string> = {
    [REGISTRY.toLowerCase()]: "0x6000",
    [POOL_REGISTRY]: "0x6000",
    [POOL]: "0x6000",
    [KEEPER]: "0x6000",
    [TOKEN]: "0x6000",
    // ATTACKER: no code (an EOA)
  };
  return {
    async getCode(a: string) {
      return code[a.toLowerCase()] ?? "0x";
    },
    async call(tx: { to?: string | null; data?: string | null }) {
      const to = String(tx.to).toLowerCase();
      const sel = String(tx.data).slice(0, 10);
      if (to === REGISTRY.toLowerCase() && sel === REG.getFunction("getContract")!.selector) {
        const [name] = REG.decodeFunctionData("getContract", tx.data!);
        return coder.encode(["address"], [name === "POOL_REGISTRY" ? POOL_REGISTRY : "0x" + "00".repeat(20)]);
      }
      if (to === POOL_REGISTRY && sel === PR.getFunction("isGovPool")!.selector) {
        return coder.encode(["bool"], [opts.registered]);
      }
      if (to === POOL && sel === GP.getFunction("getHelperContracts")!.selector) {
        return coder.encode(
          ["address", "address", "address", "address", "address"],
          ["0x" + "11".repeat(20), opts.userKeeper, "0x" + "22".repeat(20), POOL_REGISTRY, "0x" + "33".repeat(20)],
        );
      }
      if (to === KEEPER && sel === UK.getFunction("tokenAddress")!.selector) return coder.encode(["address"], [TOKEN]);
      if (to === TOKEN && sel === ERC20.getFunction("symbol")!.selector) return coder.encode(["string"], ["KRT"]);
      throw Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" });
    },
  };
}

const CFG = { chains: new Map(), defaultChainId: CHAIN, treasuryGuard: "off" } as unknown as DexeConfig;

function batch(spender: string) {
  return [
    { to: TOKEN, data: ERC20.encodeFunctionData("approve", [spender, 5n]), value: "0", description: "approve" },
    { to: POOL, data: GP.encodeFunctionData("deposit", [5n, []]), value: "0", description: "deposit" },
  ];
}

describe("approval review — labels need the DeXe registry", () => {
  it("a fake pool's self-reported UserKeeper (an EOA) is never labelled; both steps carry DANGER", async () => {
    const r = await buildReview(batch(ATTACKER), {
      chainId: CHAIN,
      from: FROM,
      config: CFG,
      simulateFirst: false,
      provider: provider({ registered: false, userKeeper: ATTACKER }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [approve, deposit] = r.steps;
    const approveText = approve!.risks.map((x) => `${x.level}:${x.text}`).join("\n");
    expect(approveText).not.toMatch(/UserKeeper/);
    expect(approve!.risks.some((x) => x.level === "danger" && /NO contract code/.test(x.text))).toBe(true);
    expect(deposit!.toLabel).toMatch(/NOT a registered DeXe DAO/);
    expect(deposit!.risks.some((x) => x.level === "danger" && /isGovPool = false/.test(x.text))).toBe(true);
    // The token's own symbol is shown as self-reported, never as a verified label.
    expect(approve!.toLabel).toMatch(/self-reported/);
  });

  it("a fake pool pointing its 'UserKeeper' at a contract still gets no helper label", async () => {
    const r = await buildReview(batch(KEEPER), {
      chainId: CHAIN,
      from: FROM,
      config: CFG,
      simulateFirst: false,
      provider: provider({ registered: false, userKeeper: KEEPER }),
    });
    if (!r.ok) throw new Error("review refused");
    expect(r.steps[0]!.risks.some((x) => /approval spender: UserKeeper/.test(x.text))).toBe(false);
    expect(r.steps[0]!.risks.some((x) => x.level === "warn" && /not a contract the DeXe registry vouches for/.test(x.text))).toBe(true);
  });

  it("a registry-confirmed pool labels itself, its UserKeeper and its governance token", async () => {
    const r = await buildReview(batch(KEEPER), {
      chainId: CHAIN,
      from: FROM,
      config: CFG,
      simulateFirst: false,
      provider: provider({ registered: true, userKeeper: KEEPER }),
    });
    if (!r.ok) throw new Error("review refused");
    const [approve, deposit] = r.steps;
    expect(deposit!.toLabel).toMatch(/registered DeXe DAO/);
    expect(deposit!.risks.some((x) => x.level === "danger")).toBe(false);
    expect(approve!.toLabel).toMatch(/governance token of GovPool/);
    expect(approve!.risks.some((x) => x.level === "info" && /approval spender: UserKeeper of GovPool/.test(x.text))).toBe(true);
    expect(approve!.risks.some((x) => x.level === "danger")).toBe(false);
  });

  it("a token transfer to an address with no code is flagged DANGER", async () => {
    const r = await buildReview(
      [{ to: TOKEN, data: ERC20.encodeFunctionData("transfer", [ATTACKER, 1n]), value: "0" }],
      { chainId: CHAIN, from: FROM, config: CFG, simulateFirst: false, provider: provider({ registered: true, userKeeper: KEEPER }) },
    );
    if (!r.ok) throw new Error("review refused");
    expect(r.steps[0]!.risks.some((x) => x.level === "danger" && /tokens go to/.test(x.text))).toBe(true);
  });
});
