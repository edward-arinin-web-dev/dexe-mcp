import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadGovernorConfigs } from "../../src/governor/loader.js";
import { isBravo } from "../../src/governor/adapter.js";

/**
 * Always-on, no network: docs/GOVERNOR.md must describe the fixtures that
 * actually ship.
 *
 * `package.json` "files" includes `docs`, so the Tier-1 table is published to
 * npm — a stale address there is a shipped artifact, not an internal note. The
 * live drift check is env-gated and cannot cover this; this one costs nothing
 * and runs on every `npm test`.
 *
 * Modelled on tests/docs/doc-count-consistency.test.ts.
 */

const ROOT = resolve(__dirname, "..", "..");
const GOVERNOR_MD = readFileSync(resolve(ROOT, "docs", "GOVERNOR.md"), "utf8");
const LAUNCH_MD = readFileSync(resolve(ROOT, "docs", "GOVERNOR_LAUNCH.md"), "utf8");
const configs = [...loadGovernorConfigs().values()];

/** Rows of the "Supported DAOs (Tier-1)" table, keyed by lowercased DAO name. */
function tierOneRows(): Map<string, string[]> {
  const section = GOVERNOR_MD.split("## Supported DAOs (Tier-1)")[1] ?? "";
  const body = section.split("\n### ")[0] ?? "";
  const rows = new Map<string, string[]>();
  for (const line of body.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 5) continue;
    const name = cells[0]!.replace(/\*/g, "").trim().toLowerCase();
    if (!name || name === "dao" || /^-+$/.test(name)) continue;
    rows.set(name, cells);
  }
  return rows;
}

describe("docs/GOVERNOR.md Tier-1 table matches src/governor/configs/", () => {
  const rows = tierOneRows();

  it("parses one row per shipped fixture", () => {
    expect([...rows.keys()].sort()).toEqual(configs.map((c) => c.id).sort());
  });

  it.each(configs.map((c) => [c.id] as const))("%s row carries the live values", (id) => {
    const cfg = configs.find((c) => c.id === id)!;
    const cells = rows.get(id)!;
    const [, chain, governor, token, family, executor] = cells;
    expect(chain).toContain(String(cfg.chainId));
    expect(governor!.toLowerCase()).toContain(cfg.governorAddress.toLowerCase());
    expect(token).toContain(cfg.votingToken.symbol);
    expect(token).toContain(cfg.votingToken.type);
    expect(family!.toLowerCase().replace(/[\s-]/g, "")).toContain(
      isBravo(cfg) ? "bravov3" : cfg.governorVersion.replace("-", ""),
    );
    if (cfg.timelock) {
      expect(executor!.toLowerCase(), `${id}: docs must print the timelock`).toContain(
        cfg.timelock.address.toLowerCase(),
      );
    }
  });

  it("never reprints an address that is no longer shipped", () => {
    const live = new Set(
      configs
        .flatMap((c) => [c.governorAddress, c.votingToken.address, c.timelock?.address])
        .filter((a): a is string => Boolean(a))
        .map((a) => a.toLowerCase()),
    );
    // A retired governor MAY be named — the migration section has to name it —
    // but only where the config still declares it.
    for (const cfg of configs) {
      if (cfg.legacyGovernor) live.add(cfg.legacyGovernor.address.toLowerCase());
    }
    const printed = new Set(
      (GOVERNOR_MD.match(/0x[a-fA-F0-9]{40}/g) ?? []).map((a) => a.toLowerCase()),
    );
    // Placeholders in worked examples are not fixtures.
    const PLACEHOLDERS = new Set([
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
      "0xce52b7cc490523b3e81c3076d5ae5cca9a3e2d6f", // OP ProposalTypesConfigurator
      "0x501eb63a2120418c581b3bd31cf190b0a0616752", // CompoundGovernor impl
    ]);
    for (const addr of printed) {
      if (PLACEHOLDERS.has(addr)) continue;
      expect(live.has(addr), `docs/GOVERNOR.md prints ${addr}, which no fixture declares`).toBe(true);
    }
  });

  it("does not carry the dead Uniswap timelock", () => {
    // No contract has ever been deployed at this address; it also fails EIP-55.
    expect(GOVERNOR_MD.toLowerCase()).not.toContain("0x1a9c8182c09f50355cea8fff4b7e1649a535498a");
    expect(LAUNCH_MD.toLowerCase()).not.toContain("0x1a9c8182c09f50355cea8fff4b7e1649a535498a");
  });
});

describe("governor docs prescribe the RPC vars the server actually parses", () => {
  it("never tells the reader to set DEXE_RPC_URL_OPTIMISM as a remedy", () => {
    // src/config.ts parses DEXE_RPC_URL_<chainId> only; this name matches nothing.
    for (const [name, md] of [
      ["GOVERNOR.md", GOVERNOR_MD],
      ["GOVERNOR_LAUNCH.md", LAUNCH_MD],
    ] as const) {
      for (const line of md.split("\n")) {
        if (!line.includes("DEXE_RPC_URL_OPTIMISM")) continue;
        expect(
          /never|not a|no longer|was never/i.test(line),
          `${name}: "${line.trim()}" prescribes DEXE_RPC_URL_OPTIMISM, which src/config.ts ignores`,
        ).toBe(true);
      }
    }
  });

  it("never prescribes a BSC var for an Ethereum/Optimism governor read", () => {
    for (const [name, md] of [
      ["GOVERNOR.md", GOVERNOR_MD],
      ["GOVERNOR_LAUNCH.md", LAUNCH_MD],
    ] as const) {
      for (const line of md.split("\n")) {
        // A bare `$env:DEXE_RPC_URL_MAINNET="..."` in a runbook is the bug;
        // prose explaining that it means BSC 56 is the fix.
        if (!/^\s*\$env:DEXE_RPC_URL_(MAINNET|OPTIMISM)/.test(line)) continue;
        expect.fail(`${name}: runbook line sets a non-per-chain RPC var → ${line.trim()}`);
      }
    }
  });

  it("documents the chains the fixtures live on", () => {
    for (const chainId of new Set(configs.map((c) => c.chainId))) {
      expect(GOVERNOR_MD).toContain(`DEXE_RPC_URL_${chainId}`);
    }
  });
});
