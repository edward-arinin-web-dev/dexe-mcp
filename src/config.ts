import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveProtocolPath, isBuildReady } from "./bootstrap.js";

export interface DexeConfig {
  /** Absolute, normalized path to the DeXe-Protocol checkout (may not exist yet). */
  protocolPath: string;
  /** Optional JSON-RPC endpoint for on-chain gov tools. */
  rpcUrl?: string;
  /** Optional fork block pin (Phase B). */
  forkBlock?: number;
}

/**
 * Reads environment and returns a frozen config. **Fast and side-effect-free**
 * — safe to await during MCP `initialize`. Does not clone, install, or shell
 * out. The protocol checkout may not exist yet; `ensureBuildReady` handles
 * that lazily from inside build/test tools.
 */
export async function loadConfig(): Promise<DexeConfig> {
  const protocolPath = resolve(resolveProtocolPath());

  // Soft warning only — don't block startup. The lazy bootstrap will either
  // create the checkout (auto-managed path) or surface a clear error when a
  // build tool is actually invoked (DEXE_PROTOCOL_PATH override).
  if (!existsSync(protocolPath)) {
    process.stderr.write(
      `[dexe-mcp] DeXe-Protocol checkout not found at ${protocolPath} — will be prepared on first dexe_compile call.\n`,
    );
  } else if (!isBuildReady(protocolPath)) {
    process.stderr.write(
      `[dexe-mcp] DeXe-Protocol checkout at ${protocolPath} is incomplete (missing node_modules or hardhat.config) — will be prepared on first dexe_compile call.\n`,
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
