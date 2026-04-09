import type { DexeConfig } from "../config.js";
import type { Artifacts } from "../artifacts.js";
import type { HardhatRunner } from "../hardhat.js";
import type { SelectorIndex } from "../lib/selectors.js";

/**
 * Shared dependency bag passed to every tool register() function. Built once
 * in `registerAll` and handed out by reference so all tools share artifact
 * caches, selector indices, and the single-slot hardhat runner.
 */
export interface ToolContext {
  readonly config: DexeConfig;
  readonly artifacts: Artifacts;
  readonly runner: HardhatRunner;
  readonly selectors: SelectorIndex;
}
