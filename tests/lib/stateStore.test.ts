import { describe, it, expect, afterEach } from "vitest";
import { existsSync, rmSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { StateStore, resolveStatePath, STATE_VERSION } from "../../src/lib/stateStore.js";

const tmpFiles: string[] = [];
function tmpPath() {
  const dir = mkdtempSync(join(tmpdir(), "dexe-state-"));
  const p = join(dir, "state.json");
  tmpFiles.push(dir);
  return p;
}
afterEach(() => {
  for (const d of tmpFiles.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

const dao = (over: Partial<Parameters<StateStore["recordDao"]>[0]> = {}) => ({
  name: "Aurora",
  govPool: "0x1111111111111111111111111111111111111111",
  chainId: 97,
  token: "0x2222222222222222222222222222222222222222",
  txHash: "0xabc",
  deployedAt: "2026-07-04T00:00:00.000Z",
  ...over,
});

describe("resolveStatePath", () => {
  it("uses the override when given", () => {
    expect(resolveStatePath("/data/x.json")).toBe("/data/x.json");
  });
  it("defaults under the home dir", () => {
    const prev = process.env.DEXE_STATE_PATH;
    delete process.env.DEXE_STATE_PATH;
    expect(resolveStatePath()).toBe(join(homedir(), ".dexe-mcp", "state.json"));
    if (prev !== undefined) process.env.DEXE_STATE_PATH = prev;
  });
});

describe("StateStore", () => {
  it("returns empty state when the file is missing", () => {
    const s = new StateStore(tmpPath());
    const st = s.getState();
    expect(st.version).toBe(STATE_VERSION);
    expect(st.knownDaos).toEqual([]);
    expect(st.recentProposals).toEqual([]);
  });

  it("records a DAO and persists it to disk (atomic)", () => {
    const p = tmpPath();
    new StateStore(p).recordDao(dao());
    expect(existsSync(p)).toBe(true);
    // A fresh instance reads it back.
    const reread = new StateStore(p).getState();
    expect(reread.knownDaos).toHaveLength(1);
    expect(reread.knownDaos[0]!.name).toBe("Aurora");
    expect(reread.lastChainId).toBe(97);
    expect(existsSync(`${p}.tmp`)).toBe(false); // temp file renamed away
  });

  it("de-dupes DAOs by (govPool, chainId), newest first", () => {
    const s = new StateStore(tmpPath());
    s.recordDao(dao({ name: "Old" }));
    s.recordDao(dao({ govPool: "0x3333333333333333333333333333333333333333", name: "Other" }));
    s.recordDao(dao({ name: "New" })); // same govPool+chain as "Old" → replace + front
    const st = s.getState();
    expect(st.knownDaos).toHaveLength(2);
    expect(st.knownDaos[0]!.name).toBe("New");
    expect(st.knownDaos.filter((d) => d.name === "Old")).toHaveLength(0);
  });

  it("keeps the same govPool on different chains as distinct", () => {
    const s = new StateStore(tmpPath());
    s.recordDao(dao({ chainId: 97 }));
    s.recordDao(dao({ chainId: 56 }));
    expect(s.getState().knownDaos).toHaveLength(2);
  });

  it("records proposals most-recent-first", () => {
    const s = new StateStore(tmpPath());
    s.recordProposal({ govPool: "0xa", chainId: 97, title: "P1", createdAt: "t1" });
    s.recordProposal({ govPool: "0xa", chainId: 97, title: "P2", createdAt: "t2" });
    const st = s.getState();
    expect(st.recentProposals.map((p) => p.title)).toEqual(["P2", "P1"]);
    expect(st.lastChainId).toBe(97);
  });

  it("lowercases wallet-label keys", () => {
    const s = new StateStore(tmpPath());
    s.setWalletLabel("0xABCDEF0000000000000000000000000000000000", "treasury");
    expect(s.getState().walletLabels["0xabcdef0000000000000000000000000000000000"]).toBe("treasury");
  });

  it("degrades to empty state on a corrupt file (never throws)", () => {
    const p = tmpPath();
    writeFileSync(p, "{ not json", "utf8");
    const st = new StateStore(p).getState();
    expect(st.knownDaos).toEqual([]);
    expect(st.version).toBe(STATE_VERSION);
  });

  it("starts fresh on a version mismatch", () => {
    const p = tmpPath();
    writeFileSync(p, JSON.stringify({ version: 999, knownDaos: [dao()] }), "utf8");
    expect(new StateStore(p).getState().knownDaos).toEqual([]);
  });

  it("lastDao returns the most recent or null", () => {
    const s = new StateStore(tmpPath());
    expect(s.lastDao()).toBeNull();
    s.recordDao(dao({ name: "First" }));
    expect(s.lastDao()!.name).toBe("First");
  });

  it("persisted JSON is valid and carries the schema version", () => {
    const p = tmpPath();
    new StateStore(p).recordDao(dao());
    const raw = JSON.parse(readFileSync(p, "utf8"));
    expect(raw.version).toBe(STATE_VERSION);
    expect(raw.knownDaos[0].govPool).toBe(dao().govPool);
  });
});

describe("activeFlow (Phase B)", () => {
  it("set → reload from disk → read; startedAt survives step advances", () => {
    const p = tmpPath();
    const s1 = new StateStore(p);
    s1.setActiveFlow({ flow: "launch_token_economy", step: "leg_dao", chainId: 97 });
    const started = s1.getState().activeFlow!.startedAt;
    s1.setActiveFlow({ flow: "launch_token_economy", step: "leg_otc", chainId: 97, govPool: "0x1111111111111111111111111111111111111111" });
    const s2 = new StateStore(p); // fresh instance = read from disk
    const af = s2.getState().activeFlow!;
    expect(af.step).toBe("leg_otc");
    expect(af.startedAt).toBe(started);
    expect(af.govPool).toBe("0x1111111111111111111111111111111111111111");
  });

  it("switching to a different flow resets startedAt", () => {
    const p = tmpPath();
    const s = new StateStore(p);
    s.setActiveFlow({ flow: "create_dao", step: "preview", chainId: 97 });
    const first = s.getState().activeFlow!.startedAt;
    s.setActiveFlow({ flow: "otc_sale", step: "open", chainId: 97 });
    expect(s.getState().activeFlow!.flow).toBe("otc_sale");
    expect(s.getState().activeFlow!.startedAt >= first).toBe(true);
  });

  it("clearActiveFlow removes it and survives reload", () => {
    const p = tmpPath();
    const s = new StateStore(p);
    s.setActiveFlow({ flow: "create_dao", step: "deploy", chainId: 56 });
    s.clearActiveFlow();
    expect(new StateStore(p).getState().activeFlow).toBeUndefined();
  });

  it("legacy state.json without activeFlow reads fine; garbled activeFlow is dropped", () => {
    const p = tmpPath();
    writeFileSync(p, JSON.stringify({ version: STATE_VERSION, knownDaos: [], recentProposals: [], walletLabels: {} }));
    expect(new StateStore(p).getState().activeFlow).toBeUndefined();
    writeFileSync(p, JSON.stringify({ version: STATE_VERSION, knownDaos: [], recentProposals: [], walletLabels: {}, activeFlow: { flow: 42 } }));
    expect(new StateStore(p).getState().activeFlow).toBeUndefined();
  });
});
