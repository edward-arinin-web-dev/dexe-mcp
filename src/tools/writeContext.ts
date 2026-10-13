import type { WriteConfig } from "../config.js";
import type { HardhatRunner } from "../hardhat.js";
import type { ToolContext } from "@dexe-network/dexe-mcp/core";

/**
 * What write-edition tools get: the read `ToolContext` with the write config
 * (signing, uploads, WalletConnect, treasury guard, protocol checkout) and the
 * single-slot hardhat runner the dev tools share. Built once in `registerAll`;
 * read tools receive the same object as a plain `ToolContext`.
 */
export interface WriteToolContext extends ToolContext<WriteConfig> {
  readonly runner: HardhatRunner;
}
