import type { ReadConfig } from "../configRead.js";
import type { Artifacts } from "../artifacts.js";
import type { SelectorIndex } from "../lib/selectors.js";

/**
 * Shared dependency bag passed to every tool register() function. Built once
 * in `registerAll` and handed out by reference so all tools share artifact
 * caches and selector indices.
 *
 * Read tools take `ToolContext` (read config). Write tools take
 * `WriteToolContext` (./writeContext.ts): the write config plus the
 * single-slot hardhat runner the dev tools share.
 */
export interface ToolContext<C extends ReadConfig = ReadConfig> {
  readonly config: C;
  readonly artifacts: Artifacts;
  readonly selectors: SelectorIndex;
}
