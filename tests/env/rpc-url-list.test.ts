import { describe, it, expect } from "vitest";
import { parseEnv } from "../../src/env/parse.js";

describe("RPC URL comma-list schema (R1)", () => {
  const base = { ...process.env };

  it("accepts a single URL", () => {
    const { issues } = parseEnv({ ...base, DEXE_RPC_URL_MAINNET: "https://a.example" });
    expect(issues.filter((i) => i.key === "DEXE_RPC_URL_MAINNET")).toHaveLength(0);
  });

  it("accepts a comma-separated fallback list", () => {
    const { issues } = parseEnv({
      ...base,
      DEXE_RPC_URL_TESTNET: "https://a.example, https://b.example,https://c.example",
    });
    expect(issues.filter((i) => i.key === "DEXE_RPC_URL_TESTNET")).toHaveLength(0);
  });

  it("rejects a list containing a non-URL entry", () => {
    const { issues } = parseEnv({
      ...base,
      DEXE_RPC_URL_MAINNET: "https://a.example,not-a-url",
    });
    const hit = issues.find((i) => i.key === "DEXE_RPC_URL_MAINNET");
    expect(hit?.severity).toBe("error");
    expect(hit?.message).toMatch(/comma-separated list of URLs/);
  });

  it("validates the new vars (DEXE_TX_WAIT_TIMEOUT_MS / DEXE_MAX_DESCRIPTION_LEN)", () => {
    const bad = parseEnv({ ...base, DEXE_TX_WAIT_TIMEOUT_MS: "3m" });
    expect(bad.issues.find((i) => i.key === "DEXE_TX_WAIT_TIMEOUT_MS")?.severity).toBe("error");
    const good = parseEnv({ ...base, DEXE_TX_WAIT_TIMEOUT_MS: "180000", DEXE_MAX_DESCRIPTION_LEN: "20000" });
    expect(good.issues.filter((i) => i.key === "DEXE_TX_WAIT_TIMEOUT_MS")).toHaveLength(0);
    expect(good.issues.filter((i) => i.key === "DEXE_MAX_DESCRIPTION_LEN")).toHaveLength(0);
  });
});
