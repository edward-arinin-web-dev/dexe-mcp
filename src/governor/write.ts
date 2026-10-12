import type { GovernorWriteTools } from "./index.js";
import { registerGovernorBuildTools } from "./tools/build.js";
import { registerGovernorSimulateWriteTools } from "./tools/simulateWrite.js";
import { registerGovernorExtraWriteTools } from "./tools/extrasWrite.js";

/**
 * The write half of the external Governor surface: the `dexe_gov_build_*`
 * calldata builders, the `execute()` dry-run, and the calldata / hash helpers.
 * Passed to `registerGovernorTools` (./index.ts), which slots each part in
 * where the single server has always listed it and shares one RpcProvider.
 */
export const governorWriteTools: GovernorWriteTools = {
  afterLookups(server, rpc) {
    registerGovernorBuildTools(server);
    registerGovernorSimulateWriteTools(server, rpc);
  },
  afterAnalysis(server, rpc) {
    registerGovernorExtraWriteTools(server, rpc);
  },
};
