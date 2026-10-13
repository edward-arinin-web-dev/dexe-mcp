/**
 * The environment of the MCP server child the orchestrator spawns. Pure.
 *
 * Since 0.37.0 the server signs with hot keys only in
 * `DEXE_SIGNER_MODE=unattended`, and an explicit unattended mode signs only on
 * `DEXE_UNATTENDED_CHAINS`. The swarm IS an unattended fleet, on exactly one
 * chain per run — so it says both explicitly (since 1.0.0 a hot key with no
 * mode signs nothing). The fence is the run's own chain: a scenario that drifts to another
 * chain is refused by the server, not just by the allowlist guards here.
 */
export function mcpChildEnv(
  base: NodeJS.ProcessEnv,
  opts: { primary: string; chainId: number },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  env.DEXE_PRIVATE_KEY = opts.primary;
  // Scenario steps hit read/vote/dev tools that the slim default surface hides.
  env.DEXE_TOOLSETS = "full";
  env.DEXE_SIGNER_MODE = "unattended";
  env.DEXE_UNATTENDED_CHAINS = String(opts.chainId);
  return env;
}

/** The chain a swarm run targets: SWARM_CHAIN_ID, else DEXE_CHAIN_ID, else 56 — as `main()` resolves it. */
export function swarmChainId(env: NodeJS.ProcessEnv): number {
  return Number((env.SWARM_CHAIN_ID ?? env.DEXE_CHAIN_ID ?? "56").trim());
}
