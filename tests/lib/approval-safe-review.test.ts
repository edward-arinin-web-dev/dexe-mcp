import { describe, it, expect } from "vitest";
import { AbiCoder, getAddress, Interface, solidityPacked, Wallet, zeroPadValue } from "ethers";
import { buildSafeTxReview, unpackMultiSend } from "../../src/lib/approval/safeReview.js";
import { buildSafeTx, computeSafeTxHash } from "../../src/lib/ethersProvider.js";
import type { DexeConfig } from "../../src/config.js";

/**
 * 2c Phase B — before a SafeTx signature is put up for approval, the Safe is
 * verified on-chain (code, answers like a Safe, version ≥ 1.3.0, the keystore
 * IS an owner, canonical implementation) and the inner call is reviewed like a
 * transaction: DELEGATECALL, calls to the Safe itself, MultiSend sub-calls,
 * gas refunds and nonce gaps are called out; the broadcast guards refuse.
 */
const CHAIN = 97;
const SAFE = getAddress("0x5afe00000000000000000000000000000000cafe");
const OWNER = Wallet.createRandom().address;
const OTHER_OWNER = Wallet.createRandom().address;
const TARGET = getAddress("0x2222222222222222222222222222222222222222");
const CANONICAL_L2_141 = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const MULTISEND_141 = "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526";

const SAFE_IFACE = new Interface([
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function VERSION() view returns (string)",
  "function swapOwner(address prevOwner, address oldOwner, address newOwner)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function approveHash(bytes32 hashToApprove)",
  "function signMessage(bytes _data)",
]);
const coder = AbiCoder.defaultAbiCoder();

interface FakeSafe {
  code?: string;
  nonce?: bigint;
  threshold?: bigint;
  owners?: string[];
  version?: string;
  singleton?: string;
  answersLikeSafe?: boolean;
  /** Hash getTransactionHash() returns; default: the real EIP-712 hash of the fields. */
  txHash?: string;
}

function provider(s: FakeSafe = {}) {
  const cfg = {
    code: "0x6080",
    nonce: 7n,
    threshold: 2n,
    owners: [OWNER, OTHER_OWNER],
    version: "1.4.1",
    singleton: CANONICAL_L2_141,
    answersLikeSafe: true,
    ...s,
  };
  return {
    async getCode(addr: string) {
      if (addr.toLowerCase() === SAFE.toLowerCase()) return cfg.code;
      return "0x6000"; // every other address is "a contract"
    },
    async call(tx: { to?: string | null; data?: string | null }) {
      if (String(tx.to).toLowerCase() !== SAFE.toLowerCase() || !cfg.answersLikeSafe) return "0x";
      const sel = String(tx.data).slice(0, 10);
      const fn = SAFE_IFACE.getFunction(sel);
      if (!fn) return "0x";
      switch (fn.name) {
        case "nonce":
          return coder.encode(["uint256"], [cfg.nonce]);
        case "getThreshold":
          return coder.encode(["uint256"], [cfg.threshold]);
        case "getOwners":
          return coder.encode(["address[]"], [cfg.owners]);
        case "VERSION":
          return coder.encode(["string"], [cfg.version]);
        case "getTransactionHash": {
          const a = SAFE_IFACE.decodeFunctionData("getTransactionHash", String(tx.data));
          const t = buildSafeTx({
            to: String(a[0]),
            value: String(a[1]),
            data: String(a[2]),
            operation: Number(a[3]),
            safeTxGas: String(a[4]),
            baseGas: String(a[5]),
            gasPrice: String(a[6]),
            gasToken: String(a[7]),
            refundReceiver: String(a[8]),
            nonce: String(a[9]),
          });
          return coder.encode(["bytes32"], [cfg.txHash ?? computeSafeTxHash(CHAIN, SAFE, t)]);
        }
        default:
          return "0x";
      }
    },
    async getStorage(_addr: string, _slot: unknown) {
      return zeroPadValue(cfg.singleton, 32);
    },
  };
}

const innerProvider = { getCode: async () => "0x6000", call: async () => "0x" };
const config = { chains: new Map(), defaultChainId: CHAIN } as unknown as DexeConfig;

function review(fake: FakeSafe = {}, txOver: Partial<Parameters<typeof buildSafeTx>[0]> = {}, cfg: DexeConfig = config) {
  return buildSafeTxReview({
    chainId: CHAIN,
    from: OWNER,
    safe: SAFE,
    tx: buildSafeTx({ to: TARGET, value: "0", data: "0x", nonce: "7", ...txOver }),
    config: cfg,
    provider: provider(fake) as never,
    innerProvider: innerProvider as never,
  });
}

const texts = (r: Awaited<ReturnType<typeof review>>, level?: string) =>
  r.ok ? r.safe.risks.filter((x) => !level || x.level === level).map((x) => x.text).join("\n") : "";

describe("buildSafeTxReview — the Safe is verified before anything is put up for signing", () => {
  it("a canonical 1.4.1 Safe with the keystore as an owner passes, labelled", async () => {
    const r = await review();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.safe.singletonLabel).toBe("Safe 1.4.1 L2 (canonical)");
    expect(r.safe.threshold).toBe("2");
    expect(r.safe.ownerCount).toBe(2);
    expect(r.safe.nonce).toBe("7");
    expect(r.safe.currentNonce).toBe("7");
    expect(texts(r, "danger")).toBe("");
    expect(r.steps).toHaveLength(1);
  });

  it("refuses an address with no code, or one that does not answer like a Safe", async () => {
    const noCode = await review({ code: "0x" });
    expect(noCode.ok).toBe(false);
    expect(!noCode.ok && noCode.reason).toMatch(/no contract code/);
    const notSafe = await review({ answersLikeSafe: false });
    expect(!notSafe.ok && notSafe.reason).toMatch(/does not answer like a Safe/);
  });

  it("refuses when the keystore is not an owner (its signature would be worthless)", async () => {
    const r = await review({ owners: [OTHER_OWNER] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/is not an owner of the Safe/);
  });

  it("refuses a Safe older than 1.3.0 (its domain has no chain id)", async () => {
    const r = await review({ version: "1.2.0" });
    expect(!r.ok && r.reason).toMatch(/before 1\.3\.0/);
  });

  it("an unknown implementation is DANGER (a contract can answer like a Safe without being one)", async () => {
    const r = await review({ singleton: "0x1111111111111111111111111111111111111111" });
    expect(r.ok).toBe(true);
    expect(texts(r, "danger")).toMatch(/not a canonical Safe 1\.3\.0 \/ 1\.4\.1 deployment/);
  });

  it("DELEGATECALL is DANGER", async () => {
    const r = await review({}, { operation: 1 });
    expect(r.ok && r.safe.operation).toBe(1);
    expect(texts(r, "danger")).toMatch(/DELEGATECALL: the Safe runs the code at .* inside its OWN storage/);
  });

  it("a call to the Safe itself is decoded by name and is DANGER", async () => {
    const data = SAFE_IFACE.encodeFunctionData("swapOwner", [
      "0x0000000000000000000000000000000000000001",
      OTHER_OWNER,
      Wallet.createRandom().address,
    ]);
    const r = await review({}, { to: SAFE, data });
    expect(texts(r, "danger")).toMatch(/Calls the Safe itself: swapOwner\(/);
    expect(r.ok && r.steps[0]!.decoded?.signature).toMatch(/^swapOwner\(/);
    expect(r.ok && r.steps[0]!.toLabel).toBe("this Safe");
  });

  it("a MultiSend is unpacked: each sub-call shown, an inner DELEGATECALL / self-call flagged", async () => {
    const pack = (op: number, to: string, value: bigint, data: string) =>
      solidityPacked(["uint8", "address", "uint256", "uint256", "bytes"], [op, to, value, (data.length - 2) / 2, data]);
    const swap = SAFE_IFACE.encodeFunctionData("swapOwner", [
      "0x0000000000000000000000000000000000000001",
      OTHER_OWNER,
      Wallet.createRandom().address,
    ]);
    const approveElsewhere = SAFE_IFACE.encodeFunctionData("approveHash", [`0x${"22".repeat(32)}`]);
    const packed = `0x${[
      pack(0, TARGET, 0n, "0x"),
      pack(1, TARGET, 0n, "0x"),
      pack(0, SAFE, 0n, swap),
      pack(0, getAddress("0x5afe00000000000000000000000000000000beef"), 0n, approveElsewhere),
    ]
      .map((p) => p.slice(2))
      .join("")}`;
    expect(unpackMultiSend(packed)).toHaveLength(4);
    const data = new Interface(["function multiSend(bytes transactions)"]).encodeFunctionData("multiSend", [packed]);
    const r = await review({}, { to: MULTISEND_141, data, operation: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.steps[0]!.toLabel).toBe("Safe MultiSend 1.4.1 (canonical)");
    expect(r.safe.multiSend?.map((c) => c.operation)).toEqual([0, 1, 0, 0]);
    const d = texts(r, "danger");
    expect(d).toMatch(/MultiSend call 2: DELEGATECALL/);
    expect(d).toMatch(/MultiSend call 3: Calls the Safe itself: swapOwner\(/);
    expect(d).toMatch(/MultiSend call 4: approveHash\(.*ANOTHER Safe/);
    expect(r.safe.multiSend?.[3]?.decoded?.signature).toMatch(/^approveHash\(/);
  });

  it("a malformed MultiSend payload is DANGER, not silently shown as one call", () => {
    expect(unpackMultiSend("0x00" + "11".repeat(10))).toBeNull();
  });

  it("nonce gaps, threshold 1 and a gas refund are warned about", async () => {
    const ahead = await review({ nonce: 3n });
    expect(texts(ahead, "warn")).toMatch(/Nonce 7 is ahead of the Safe's next nonce 3: 4 other transaction/);
    const used = await review({ nonce: 9n });
    expect(texts(used, "warn")).toMatch(/Nonce 7 is already used/);
    const solo = await review({ threshold: 1n });
    expect(texts(solo, "warn")).toMatch(/threshold is 1/);
    const refund = await review({}, { gasPrice: "5", gasToken: TARGET, refundReceiver: OTHER_OWNER });
    expect(texts(refund, "danger")).toMatch(/pays a gas refund/);
  });

  it("review probe: gasPrice 1 gwei + baseGas 1e12 with NO token / receiver is a native refund to the executor (DANGER)", async () => {
    const r = await review({}, { gasPrice: "1000000000", baseGas: "1000000000000" });
    expect(r.ok).toBe(true);
    const d = texts(r, "danger");
    expect(d).toMatch(/in the native coin to whoever executes it \(tx\.origin\)/);
    expect(d).toMatch(/at least 1000000000000000000000 wei \(1,000 native coin\)/);
    // and every gas field is in the review for the page / terminal
    expect(r.ok && [r.safe.safeTxGas, r.safe.baseGas, r.safe.gasPrice]).toEqual(["0", "1000000000000", "1000000000"]);
  });

  it("refuses when the Safe's own getTransactionHash differs (it would not run what is shown)", async () => {
    const r = await review({ txHash: `0x${"ab".repeat(32)}` });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/hashes this transaction to 0xabab/);
    expect((await review()).ok && (await review()).ok).toBe(true);
    const ok = await review();
    expect(ok.ok && ok.safe.onChainSafeTxHash).toBe(
      computeSafeTxHash(CHAIN, SAFE, buildSafeTx({ to: TARGET, value: "0", data: "0x", nonce: "7" })),
    );
  });

  it("Safe functions are decoded on ANY target: approveHash on another Safe, a message signature via DELEGATECALL", async () => {
    const otherSafe = getAddress("0x5afe00000000000000000000000000000000beef");
    const approve = await review({}, { to: otherSafe, data: SAFE_IFACE.encodeFunctionData("approveHash", [`0x${"11".repeat(32)}`]) });
    expect(texts(approve, "danger")).toMatch(/approveHash\(0x1111.*on 0x5aFE.*ANOTHER Safe/i);
    const signLib = "0xd53cd0aB83D845Ac265BE939c57F53AD838012c9";
    const sign = await review({}, { to: signLib, operation: 1, data: SAFE_IFACE.encodeFunctionData("signMessage", ["0x1234"]) });
    expect(texts(sign, "danger")).toMatch(/DELEGATECALL signMessage\(0x1234\) via .*SIGNS A MESSAGE \(EIP-1271\)/);
    const swapElsewhere = await review({}, {
      to: otherSafe,
      data: SAFE_IFACE.encodeFunctionData("swapOwner", ["0x0000000000000000000000000000000000000001", OWNER, OTHER_OWNER]),
    });
    expect(texts(swapElsewhere, "danger")).toMatch(/swapOwner\(.*on 0x5aFE.*changes the owners/i);
  });

  it("the broadcast guards refuse the inner call (B6 allowlist) — no signature is requested", async () => {
    const strict = { ...config, signerAllowlist: ["0x3333333333333333333333333333333333333333"] } as unknown as DexeConfig;
    const r = await review({}, {}, strict);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.guard).toBe("B6");
  });
});
