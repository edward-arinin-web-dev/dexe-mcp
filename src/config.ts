import { existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { ensureProtocolCheckout } from "./bootstrap.js";

export interface DexeConfig {
  /** Absolute, normalized path to the DeXe-Protocol checkout. */
  protocolPath: string;
  /** Optional JSON-RPC endpoint for on-chain gov tools. */
  rpcUrl?: string;
  /** Optional fork block pin (Phase B). */
  forkBlock?: number;
}

/**
 * Validates environment and returns a frozen config.
 *
 * If `DEXE_PROTOCOL_PATH` is set, uses it directly (power-user override).
 * Otherwise, auto-clones DeXe-Protocol into a platform cache directory.
 *
 * Exported primarily for the MCP entrypoint; tests can construct their own
 * config objects directly.
 */
export async function loadConfig(): Promise<DexeConfig> {
  const raw = await ensureProtocolCheckout();
  const protocolPath = resolve(raw);

  if (!existsSync(protocolPath) || !statSync(protocolPath).isDirectory()) {
    fatal(`DeXe-Protocol path does not exist or is not a directory: ${protocolPath}`);
  }

  const hardhatConfig = join(protocolPath, "hardhat.config.js");
  const hardhatConfigTs = join(protocolPath, "hardhat.config.ts");
  if (!existsSync(hardhatConfig) && !existsSync(hardhatConfigTs)) {
    fatal(
      `DeXe-Protocol path is not a Hardhat project — no hardhat.config.{js,ts} found at ${protocolPath}`,
    );
  }

  const rpcUrl = process.env.DEXE_RPC_URL?.trim() || undefined;

  let forkBlock: number | undefined;
  if (process.env.DEXE_FORK_BLOCK) {
    const n = Number(process.env.DEXE_FORK_BLOCK);
    if (!Number.isFinite(n) || n < 0) {
      fatal(`DEXE_FORK_BLOCK must be a non-negative integer, got: ${process.env.DEXE_FORK_BLOCK}`);
    }
    forkBlock = n;
  }

  return Object.freeze({ protocolPath, rpcUrl, forkBlock });
}

function fatal(msg: string): never {
  // stderr only — stdout is the MCP protocol channel.
  process.stderr.write(`[dexe-mcp] fatal: ${msg}\n`);
  process.exit(1);
}
