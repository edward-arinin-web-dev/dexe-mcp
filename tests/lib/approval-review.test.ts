import { describe, it, expect, vi } from "vitest";
import { AbiCoder, Interface } from "ethers";
import { buildReview } from "../../src/lib/approval/review.js";
import { CONTRACTS_REGISTRY_BY_CHAIN } from "@dexe-network/dexe-mcp/core";
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
/** A contract that does NOT answer getHelperContracts() (the re-review bypass). */
const SILENT = "0x00000000000000000000000000000000000000a7";
/** A plain contract with code (an unknown spender). */
const OTHER = "0x00000000000000000000000000000000000000a8";

const REG = new Interface(["function getContract(string name) view returns (address)"]);
const PR = new Interface(["function isGovPool(address) view returns (bool)"]);
const GP = new Interface([
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
  "function deposit(uint256 amount, uint256[] nftIds)",
  "function delegate(address delegatee, uint256 amount, uint256[] nftIds)",
  "function multicall(bytes[] data)",
  "function createProposalAndVote(string _descriptionURL, tuple(address executor, uint256 value, bytes data)[] actionsOnFor, tuple(address executor, uint256 value, bytes data)[] actionsOnAgainst, uint256 voteAmount, uint256[] voteNftIds)",
]);
const UK = new Interface(["function tokenAddress() view returns (address)"]);
const ERC20 = new Interface([
  "function approve(address spender, uint256 amount)",
  "function transfer(address to, uint256 amount)",
  "function symbol() view returns (string)",
  "function increaseAllowance(address spender, uint256 addedValue)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function setApprovalForAll(address operator, bool approved)",
]);
const coder = AbiCoder.defaultAbiCoder();

function provider(opts: { registered: boolean; userKeeper: string }) {
  const code: Record<string, string> = {
    [REGISTRY.toLowerCase()]: "0x6000",
    [POOL_REGISTRY]: "0x6000",
    [POOL]: "0x6000",
    [KEEPER]: "0x6000",
    [TOKEN]: "0x6000",
    [SILENT]: "0x6000",
    [OTHER]: "0x6000",
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

describe("approval review — protocol calls and every token handover (re-review)", () => {
  const P = provider({ registered: true, userKeeper: KEEPER });
  const run = (steps: Array<{ to: string; data: string; value?: string }>, cfg: DexeConfig = CFG) =>
    buildReview(
      steps.map((x) => ({ value: "0", ...x })),
      { chainId: CHAIN, from: FROM, config: cfg, simulateFirst: false, provider: P },
    ).then((r) => {
      if (!r.ok) throw new Error(`review refused: ${r.reason}`);
      return r.steps;
    });
  const dangers = (st: { risks: Array<{ level: string; text: string }> }) => st.risks.filter((x) => x.level === "danger").map((x) => x.text);

  it("a GovPool function sent to a contract that does not even claim to be a pool is DANGER, shown without the 'GovPool.' prefix", async () => {
    const [st] = await run([{ to: SILENT, data: GP.encodeFunctionData("deposit", [5n, []]), value: "1000000000000000000" }]);
    expect(dangers(st!).some((t) => /NOT a registered DeXe contract/.test(t))).toBe(true);
    expect(st!.decoded?.contract).toBeNull();
    expect(st!.decoded?.signature).toMatch(/^deposit\(/);
  });

  it("the same call on the registry-confirmed pool keeps its name and carries no DANGER", async () => {
    const [st] = await run([{ to: POOL, data: GP.encodeFunctionData("deposit", [5n, []]) }]);
    expect(dangers(st!)).toEqual([]);
    expect(st!.decoded?.contract).toBe("GovPool");
  });

  it("increaseAllowance / transferFrom / setApprovalForAll to a code-less address are DANGER", async () => {
    const steps = await run([
      { to: TOKEN, data: ERC20.encodeFunctionData("increaseAllowance", [ATTACKER, 5n]) },
      { to: TOKEN, data: ERC20.encodeFunctionData("transferFrom", [FROM, ATTACKER, 5n]) },
      { to: TOKEN, data: ERC20.encodeFunctionData("setApprovalForAll", [ATTACKER, true]) },
    ]);
    expect(dangers(steps[0]!).some((t) => /NO contract code/.test(t))).toBe(true);
    expect(dangers(steps[1]!).some((t) => /tokens go to/.test(t))).toBe(true);
    expect(dangers(steps[2]!).some((t) => /ALL tokens of the collection/.test(t))).toBe(true);
    expect(dangers(steps[2]!).some((t) => /NO contract code/.test(t))).toBe(true);
  });

  it("an unknown contract spender is a warning, an unlimited allowance a DANGER", async () => {
    const [st] = await run([{ to: TOKEN, data: ERC20.encodeFunctionData("increaseAllowance", [OTHER, 2n ** 256n - 1n]) }]);
    expect(st!.risks.some((x) => x.level === "warn" && /not a contract the DeXe registry vouches for/.test(x.text))).toBe(true);
    expect(dangers(st!).some((t) => /UNLIMITED/.test(t))).toBe(true);
  });

  it("delegation: the delegatee is shown; an EOA delegatee is normal on a confirmed pool, DANGER on an unconfirmed one", async () => {
    const ok = await run([{ to: POOL, data: GP.encodeFunctionData("delegate", [ATTACKER, 7n, []]) }]);
    expect(dangers(ok[0]!)).toEqual([]);
    expect(ok[0]!.risks.some((x) => x.level === "info" && x.text.toLowerCase().includes(ATTACKER))).toBe(true);
    const bad = await run([{ to: SILENT, data: GP.encodeFunctionData("delegate", [ATTACKER, 7n, []]) }]);
    expect(dangers(bad[0]!).some((t) => /NOT a registered DeXe contract/.test(t))).toBe(true);
  });

  it("an approval nested in a multicall or a proposal action gets the same spender check", async () => {
    const approveEoa = ERC20.encodeFunctionData("approve", [ATTACKER, 5n]);
    const [mc] = await run([{ to: POOL, data: GP.encodeFunctionData("multicall", [[approveEoa]]) }]);
    expect(dangers(mc!).some((t) => /^inner call 1: .*NO contract code/.test(t))).toBe(true);
    const create = GP.encodeFunctionData("createProposalAndVote", ["ipfs://x", [[TOKEN, 0n, approveEoa]], [], 1n, []]);
    const [pa] = await run([{ to: POOL, data: create }]);
    expect(dangers(pa!).some((t) => /^proposal action #1: .*NO contract code/.test(t))).toBe(true);
    // A protocol call in an action on an unvouched executor is DANGER too.
    const create2 = GP.encodeFunctionData("createProposalAndVote", ["ipfs://y", [[SILENT, 0n, GP.encodeFunctionData("deposit", [1n, []])]], [], 1n, []]);
    const [pb] = await run([{ to: POOL, data: create2 }]);
    expect(dangers(pb!).some((t) => /^proposal action #1: .*NOT a registered DeXe contract/.test(t))).toBe(true);
  });

  it("notes a custom DEXE_CONTRACTS_REGISTRY on the page", async () => {
    const custom = { ...CFG, registryOverride: "0x00000000000000000000000000000000000000ff" } as unknown as DexeConfig;
    const [st] = await run([{ to: TOKEN, data: ERC20.encodeFunctionData("approve", [KEEPER, 1n]) }], custom);
    expect(st!.risks.some((x) => x.level === "warn" && /custom DeXe ContractsRegistry/.test(x.text))).toBe(true);
    const [plain] = await run([{ to: TOKEN, data: ERC20.encodeFunctionData("approve", [KEEPER, 1n]) }]);
    expect(plain!.risks.some((x) => /custom DeXe ContractsRegistry/.test(x.text))).toBe(false);
  });
});
