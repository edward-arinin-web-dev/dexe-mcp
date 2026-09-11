import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { validateStepExpectations } from "../../scripts/swarm/expect.js";
import { DAO_TEMPLATE_KEYS } from "./lib/templates.js";

/**
 * Static guards over tests/swarm/scenarios/*.json. Until 0.34.0 nothing read
 * these files except the orchestrator at run time, so a typo'd key, a dangling
 * alias or a dead fixture address only surfaced 40 minutes into a gas-spending
 * sweep — if at all.
 */

const DIR = resolve("tests/swarm/scenarios");
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
  .sort();

interface Step {
  step?: number;
  agent?: string;
  tool?: string;
  args?: Record<string, unknown>;
  broadcast?: boolean;
  serverSign?: boolean;
  captureAs?: string;
  [k: string]: unknown;
}
interface Spec {
  id: string;
  dao?: string;
  agents?: Array<{ alias: string; role: string; wallet: string }>;
  steps?: Step[];
  successCriteria?: unknown[];
}

const specs: Array<{ file: string; spec: Spec }> = FILES.map((file) => ({
  file,
  spec: JSON.parse(readFileSync(join(DIR, file), "utf8")) as Spec,
}));

/** Addresses of the dead 2026-04/05 fixtures and their helpers. A DAO-allowlist
 *  swap does not touch a hardcoded helper, which is how 10 scenarios kept
 *  pointing at pools the current chain-97 protocol no longer knows. */
const DEAD_FIXTURE_ADDRESSES = [
  "0x081f4b5c88325fbda757f31b86a15cd3a7deaefe", // Polaris govPool (isGovPool == false)
  "0xf5f07490fc53945455803636dc59b1eec967861f", // second dead fixture govPool
  "0x9e74ad4f2afe44073f4e07d8eafe4d92387ffce6", // dead TokenSaleProposal helper
  "0x7e4c209f19bef4a71fb2fcb8ec0c5b6f5f5df5de", // dead nftMultiplier
  "0x7cf4f13c0e5787ee79d6caff768160a4cc85ad6d", // dead expertNft
  "0x897cbcfc733f6572f09398fe51d2f89c88ed0d0b", // dead expertNft (other fixture)
  "0x0cda7e428c9fda74fcb94d3517e837c2f001d642", // dead DistributionProposal helper
];

/** Arg keys that name a per-DAO contract. These MUST be templates: a literal
 *  here is exactly the rot D13-6 found. */
const DAO_COUPLED_KEYS = new Set([
  "govPool",
  "dao",
  "tokenSaleProposal",
  "distributionProposal",
  "expertNftContract",
  "nftMultiplierContract",
  "newMultiplierAddress",
  "userKeeper",
  "settings",
  "validators",
  "votePower",
]);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TEMPLATE_RE = /\{\{([^}]+)\}\}/g;
const TIME_KEY_RE = /Time$|^deadline$|^startedAt$/;

/** Walk every string VALUE in a JSON subtree. Never scan the raw file text —
 *  a substring sweep hits the address-shaped windows inside long calldata
 *  (S12, S36, S47 all carry 40-hex runs that are arguments, not addresses). */
function walkStrings(
  node: unknown,
  visit: (value: string, key: string, path: string) => void,
  key = "",
  path = "",
): void {
  if (typeof node === "string") {
    visit(node, key, path);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkStrings(v, visit, key, `${path}[${i}]`));
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      walkStrings(v, visit, k, path ? `${path}.${k}` : k);
    }
  }
}

describe("scenario corpus — structure", () => {
  it("has scenario files to check", () => {
    expect(FILES.length).toBeGreaterThan(60);
  });

  it("every file's id matches its filename", () => {
    for (const { file, spec } of specs) {
      expect(spec.id, file).toBe(basename(file, ".json"));
    }
  });

  it("every steps[].agent is declared in agents[]", () => {
    for (const { file, spec } of specs) {
      const aliases = new Set((spec.agents ?? []).map((a) => a.alias));
      for (const step of spec.steps ?? []) {
        expect(aliases.has(String(step.agent)), `${file} step ${step.step} agent ${step.agent}`).toBe(true);
      }
    }
  });

  it("every step passes the load-time validator the orchestrator runs", () => {
    for (const { file, spec } of specs) {
      expect(validateStepExpectations(spec), file).toEqual([]);
    }
  });
});

describe("scenario corpus — templates resolve", () => {
  const TOP_LEVEL = new Set([
    "dao",
    "firstAllowlistedToken",
    "firstAllowlistedDao",
    "secondAllowlistedDao",
  ]);
  const AGENT_RE = /^agent:([A-Za-z]):address$/;
  const NOW_RE = /^now(?:[+-]\d+)?$/;

  it("every {{…}} in args and expect values is something expand() can resolve", () => {
    for (const { file, spec } of specs) {
      const aliases = new Set((spec.agents ?? []).map((a) => a.alias));
      const captures = new Set<string>();
      for (const step of spec.steps ?? []) {
        const scan = (node: unknown) =>
          walkStrings(node, (value) => {
            for (const m of value.matchAll(TEMPLATE_RE)) {
              const t = m[1]!.trim();
              const where = `${file} step ${step.step}: {{${t}}}`;
              if (TOP_LEVEL.has(t)) continue;
              if (NOW_RE.test(t)) continue;
              if (t.startsWith("dao.")) {
                expect((DAO_TEMPLATE_KEYS as readonly string[]).includes(t.slice(4)), where).toBe(true);
                continue;
              }
              const am = AGENT_RE.exec(t);
              if (am) {
                expect(aliases.has(am[1]!), `${where} — alias not declared in agents[]`).toBe(true);
                continue;
              }
              // Otherwise it must be a capture from THIS or an earlier step.
              const head = t.split(".")[0]!;
              const visible = new Set(captures);
              if (step.captureAs) visible.add(step.captureAs);
              expect(visible.has(head), `${where} — no earlier captureAs named '${head}'`).toBe(true);
            }
          });
        scan(step.args);
        scan((step as { expect?: unknown }).expect);
        if (step.captureAs) captures.add(step.captureAs);
      }
    }
  });
});

describe("scenario corpus — no dead fixture literals", () => {
  it("no scenario carries an address from the dead 2026-04/05 fixtures", () => {
    for (const { file, spec } of specs) {
      walkStrings(spec, (value, key, path) => {
        const hit = DEAD_FIXTURE_ADDRESSES.find((d) => value.toLowerCase() === d);
        expect(
          hit,
          `${file} ${path || key} is the dead fixture address ${value}. Use a {{dao.*}} / ` +
            `{{firstAllowlistedDao}} / {{firstAllowlistedToken}} template — a literal survives a DAO-allowlist ` +
            `swap and silently keeps pointing at a de-registered pool.`,
        ).toBeUndefined();
      });
    }
  });

  it("every DAO-coupled arg is a template, never a hardcoded address", () => {
    for (const { file, spec } of specs) {
      for (const step of spec.steps ?? []) {
        walkStrings(step.args, (value, key, path) => {
          if (!DAO_COUPLED_KEYS.has(key)) return;
          expect(
            ADDRESS_RE.test(value),
            `${file} step ${step.step} args.${path} is a hardcoded address (${value}). ` +
              `Use a {{dao.*}} / {{firstAllowlistedDao}} template — literals break the moment the DAO ` +
              `allowlist changes.`,
          ).toBe(false);
        });
      }
    }
  });
});

describe("scenario corpus — no stale absolute timestamps", () => {
  it("no time-shaped arg is a hardcoded 10-digit epoch", () => {
    for (const { file, spec } of specs) {
      for (const step of spec.steps ?? []) {
        walkStrings(step.args, (value, key, path) => {
          if (!TIME_KEY_RE.test(key)) return;
          expect(
            /^\d{10}$/.test(value),
            `${file} step ${step.step} args.${path} = "${value}" is an absolute epoch. ` +
              `Use {{now+<seconds>}} / {{now-<seconds>}} — a fixed timestamp rots into the past and the ` +
              `OTC builders then refuse the whole scenario.`,
          ).toBe(false);
        });
      }
    }
  });
});

describe("scenario corpus — value-moving tools are pinned safe", () => {
  it("no dexe_agents_fund step carries confirm:true, and every one sets dryRun:true", () => {
    for (const { file, spec } of specs) {
      for (const step of spec.steps ?? []) {
        if (step.tool !== "dexe_agents_fund") continue;
        const args = (step.args ?? {}) as Record<string, unknown>;
        expect(args.confirm, `${file} step ${step.step}: dexe_agents_fund must never confirm in a scenario`).not.toBe(
          true,
        );
        expect(
          args.dryRun,
          `${file} step ${step.step}: dexe_agents_fund must set dryRun:true. Safety cannot rest on the ` +
            `ABSENCE of confirm — dryRun never broadcasts, even with confirm.`,
        ).toBe(true);
      }
    }
  });
});

describe("scenario corpus — the 0.30–0.33 write paths are covered", () => {
  const toolsUsed = new Set(specs.flatMap(({ spec }) => (spec.steps ?? []).map((s) => String(s.tool))));

  it.each([
    ["dexe_proposal_vote_and_execute", "the vote leg's already-voted skip + HARM WARNING"],
    ["dexe_tx_send", "the B11/B12 broadcast guards on the server's own send path"],
    ["dexe_agents_list", "keyring enumeration"],
    ["dexe_agents_fund", "the 0.32.0 funding cap + daily budget"],
    ["dexe_agents_ledger", "per-agent attribution"],
  ])("%s is exercised (%s)", (tool) => {
    expect(toolsUsed.has(tool)).toBe(true);
  });

  it("at least one scenario routes a step through the server's signer (serverSign)", () => {
    const serverSigned = specs.flatMap(({ spec }) => (spec.steps ?? []).filter((s) => s.serverSign));
    expect(serverSigned.length).toBeGreaterThan(0);
  });

  it("SIMPLE-mode dao_create is covered, not only the ADVANCED params form", () => {
    const simple = specs.some(({ spec }) =>
      (spec.steps ?? []).some(
        (s) => s.tool === "dexe_dao_create" && s.args && "symbol" in s.args && !("params" in s.args),
      ),
    );
    expect(simple, "no scenario calls dexe_dao_create in SIMPLE mode (symbol + totalSupply)").toBe(true);
  });
});
