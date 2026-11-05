import { createRequire } from "node:module";
import { createVM, type VM } from "@ethereumjs/vm";
import { createBlock } from "@ethereumjs/block";
import { Common, Hardfork, Mainnet } from "@ethereumjs/common";
import { Account, Address, bytesToHex, createAddressFromString, hexToBytes } from "@ethereumjs/util";
import { Interface, type InterfaceAbi } from "ethers";

/**
 * A tiny in-process EVM for contract unit tests (ethereumjs, no network, no
 * node binary). Deploy with `deploy`, call with `call` / `send`, move the clock
 * with `warp`. Every call reports gas used and the decoded revert reason, which
 * is what the fast-lane tests assert on.
 */

const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun });

export interface CallResult {
  ok: boolean;
  /** Revert reason (Error(string)), the raw error name, or undefined on success. */
  error?: string;
  returnData: string;
  gasUsed: bigint;
  createdAddress?: string;
}

export class Evm {
  private vm!: VM;
  private timestamp = 1_700_000_000n;
  private blockNumber = 1n;

  static async create(): Promise<Evm> {
    const e = new Evm();
    e.vm = await createVM({ common });
    return e;
  }

  /** Give `addr` a native balance so it can be a caller. */
  async fund(addr: string, wei = 10n ** 20n): Promise<void> {
    const a = createAddressFromString(addr);
    const acct = (await this.vm.stateManager.getAccount(a)) ?? new Account();
    acct.balance = wei;
    await this.vm.stateManager.putAccount(a, acct);
  }

  /** Advance the chain clock by `seconds`. */
  warp(seconds: number | bigint): void {
    this.timestamp += BigInt(seconds);
    this.blockNumber += 1n;
  }

  get now(): bigint {
    return this.timestamp;
  }

  private block() {
    return createBlock(
      { header: { timestamp: this.timestamp, number: this.blockNumber, gasLimit: 30_000_000n } },
      { common },
    );
  }

  private async run(opts: {
    from: string;
    to?: string;
    data: string;
    value?: bigint;
    gasLimit?: bigint;
  }): Promise<CallResult> {
    // runCall alone never resets the EIP-2929 warm sets (runTx does), so
    // without this every slot touched by an earlier call would read as warm and
    // the gas figures would be optimistic.
    await this.vm.evm.journal.cleanup();
    const res = await this.vm.evm.runCall({
      caller: createAddressFromString(opts.from),
      to: opts.to ? createAddressFromString(opts.to) : undefined,
      data: hexToBytes(opts.data as `0x${string}`),
      value: opts.value ?? 0n,
      gasLimit: opts.gasLimit ?? 10_000_000n,
      block: this.block(),
    });
    const ex = res.execResult;
    const returnData = bytesToHex(ex.returnValue);
    const out: CallResult = {
      ok: !ex.exceptionError,
      returnData,
      gasUsed: ex.executionGasUsed,
    };
    if (ex.exceptionError) out.error = decodeRevert(returnData, ex.exceptionError.error);
    if (res.createdAddress) out.createdAddress = res.createdAddress.toString();
    return out;
  }

  /** Deploy creation bytecode (+ ABI-encoded constructor args). Throws on failure. */
  async deploy(from: string, bytecode: string, abi: InterfaceAbi, args: unknown[] = []): Promise<string> {
    const iface = new Interface(abi);
    const encoded = iface.deploy.inputs.length ? iface.encodeDeploy(args).slice(2) : "";
    const r = await this.run({ from, data: bytecode + encoded });
    if (!r.ok || !r.createdAddress) throw new Error(`deploy failed: ${r.error}`);
    return r.createdAddress;
  }

  /** Same as `deploy` but returns the failure instead of throwing. */
  async tryDeploy(from: string, bytecode: string, abi: InterfaceAbi, args: unknown[] = []): Promise<CallResult> {
    const iface = new Interface(abi);
    const encoded = iface.deploy.inputs.length ? iface.encodeDeploy(args).slice(2) : "";
    return this.run({ from, data: bytecode + encoded });
  }

  /** Send raw calldata. */
  async sendRaw(from: string, to: string, data: string, opts: { value?: bigint; gasLimit?: bigint } = {}) {
    return this.run({ from, to, data, ...opts });
  }

  /** Encode + send a function call; state changes persist. */
  async send(
    from: string,
    to: string,
    abi: InterfaceAbi,
    fn: string,
    args: unknown[] = [],
    opts: { value?: bigint; gasLimit?: bigint } = {},
  ): Promise<CallResult> {
    const iface = new Interface(abi);
    return this.run({ from, to, data: iface.encodeFunctionData(fn, args), ...opts });
  }

  /** Encode + call; returns decoded results. Throws on revert. */
  async call(from: string, to: string, abi: InterfaceAbi, fn: string, args: unknown[] = []): Promise<unknown[]> {
    const iface = new Interface(abi);
    const r = await this.run({ from, to, data: iface.encodeFunctionData(fn, args) });
    if (!r.ok) throw new Error(`call ${fn} reverted: ${r.error}`);
    return [...iface.decodeFunctionResult(fn, r.returnData)];
  }

  async getCode(addr: string): Promise<string> {
    return bytesToHex(await this.vm.stateManager.getCode(createAddressFromString(addr)));
  }
}

const ERROR_STRING_SELECTOR = "0x08c379a0";

export function decodeRevert(returnData: string, fallback: string): string {
  if (returnData.startsWith(ERROR_STRING_SELECTOR)) {
    try {
      const iface = new Interface(["function Error(string)"]);
      const [msg] = iface.decodeFunctionData("Error", returnData);
      return String(msg);
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

/** Compiles one Solidity source with the pinned solc-js (used for test mocks only). */
export function compileSol(source: string, contractName: string): { abi: InterfaceAbi; bytecode: string } {
  const require = createRequire(import.meta.url);
  const solc = require("solc") as { compile: (input: string) => string };
  const input = {
    language: "Solidity",
    sources: { "Mock.sol": { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input))) as {
    errors?: Array<{ severity: string; formattedMessage: string }>;
    contracts: Record<string, Record<string, { abi: InterfaceAbi; evm: { bytecode: { object: string } } }>>;
  };
  const errors = (out.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts["Mock.sol"]![contractName]!;
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
}

export { Address };
