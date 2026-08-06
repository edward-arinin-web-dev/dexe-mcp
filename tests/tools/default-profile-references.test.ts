import { describe, it, expect, beforeAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOOLSETS } from "../../src/tools/gate.js";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";

/**
 * ── No dangling tool references in the default profile ─────────────────────
 *
 * A tool description is the only documentation the model reads before it acts.
 * When one names a sibling tool ("recover with dexe_graph_schema", "read it
 * on-chain with dexe_read_multicall"), that name is a promise the session can
 * keep — unless the named tool is gated behind DEXE_TOOLSETS, in which case the
 * model spends a turn on a confident 404 and then improvises.
 *
 * v0.31.0 moved the default-profile boundary (default went `core,proposals` →
 * `core`; the reporting reads moved in, the ~30 single-purpose
 * `dexe_proposal_build_*` tools moved out). That invalidated hand-written text
 * all over the server — the live case was `dexe_graph_query` (in core) telling
 * a zero-config session to recover a bad field name by calling
 * `dexe_graph_schema` (then in `read` only), which is the single most common
 * subgraph failure and its single most common recovery.
 *
 * The boundary WILL move again, and hand-auditing it will not survive the next
 * release. So this test walks the profile a real zero-config session gets,
 * extracts every `dexe_*` token from every description / inputSchema /
 * outputSchema, and requires each one to be either:
 *
 *   a) present in the default profile, or
 *   b) annotated `(needs DEXE_TOOLSETS=core,<set>)` right after the name —
 *      the convention the knowledge layer already uses — with a set list that
 *      really does contain that tool.
 *
 * A shared trailing annotation covers a run of names separated only by list
 * punctuation ("dexe_a / dexe_b (needs DEXE_TOOLSETS=core,read)"), because that
 * is how the prose actually reads.
 */

async function listTools(toolsetsEnv: string | undefined) {
  if (toolsetsEnv === undefined) delete process.env.DEXE_TOOLSETS;
  else process.env.DEXE_TOOLSETS = toolsetsEnv;
  const config = await loadConfig();
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerAll(server, config);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const res = await client.listTools();
  await client.close();
  await server.close();
  return res.tools;
}

/** Every string reachable in `v` (values and object keys), depth-first. */
function collectStrings(v: unknown, out: string[]): void {
  if (typeof v === "string") {
    out.push(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, out);
    return;
  }
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      collectStrings(x, out);
    }
  }
}

/**
 * `dexe_…` in lowercase only. Env vars (`DEXE_TOOLSETS`), the package name
 * (`dexe-mcp`) and resource URIs (`dexe://graph-schema`) are deliberately not
 * matched — none of them is a tool call.
 */
const TOOL_TOKEN = /dexe_[a-z0-9_]+\*?/g;

/**
 * Fragments that may sit between a name and a trailing shared annotation, so
 * "`dexe_a` or `dexe_b` (needs DEXE_TOOLSETS=core,proposals)" annotates both.
 * Backticks and quotes are in here because that is how the descriptions in this
 * repo actually spell tool names.
 */
const LIST_GAP =
  /^(?:\s+|[,/;+&|`'"]|\.\.\.|…|—|-|\*|\)|\(|\band\b|\bor\b|\bplus\b|\balso\b|dexe_[a-z0-9_]+\*?)/;
const ANNOTATION = /^\s*\(needs DEXE_TOOLSETS=([a-z,]+)\)/;

/**
 * ── Quarantine ─────────────────────────────────────────────────────────────
 *
 * Dangling references this guard found in files outside the change that
 * introduced it. Each carries the exact one-line fix. THIS LIST MAY ONLY
 * SHRINK: an entry that stops dangling fails the test (below) so a fixed item
 * cannot sit here forever, and anything NOT listed fails immediately. Keyed by
 * the referenced name — `signerParam` and the avatar descriptions are shared,
 * so one entry covers every tool that inherits the text.
 */
const QUARANTINE: ReadonlyArray<{ ref: string; source: string; fix: string }> = [
  {
    ref: "dexe_agents_list",
    source: "src/lib/params.ts — signerParam.describe(), inherited by every composite",
    fix: "…= DEXE_AGENT_PK_* key (see dexe_agents_list (needs DEXE_TOOLSETS=core,vote)).",
  },
  {
    ref: "dexe_ipfs_upload_dao_metadata",
    source: "src/tools/ipfs.ts — dexe_ipfs_upload_avatar + dexe_dao_generate_avatar descriptions",
    fix: "…`dexe_ipfs_upload_dao_metadata` or `dexe_proposal_build_modify_dao_profile` (needs DEXE_TOOLSETS=core,proposals).",
  },
  {
    ref: "dexe_proposal_build_modify_dao_profile",
    source: "src/tools/ipfs.ts — same two descriptions",
    fix: "covered by the same trailing (needs DEXE_TOOLSETS=core,proposals) annotation",
  },
];
const QUARANTINED = new Set(QUARANTINE.map((q) => q.ref));

/**
 * The toolsets named by the annotation attached to the token ending at `from`,
 * or null when there is none. Scans forward over list punctuation and further
 * tool names so one annotation can cover a run of them.
 */
function annotationAfter(text: string, from: number): string[] | null {
  let rest = text.slice(from, from + 300);
  for (let hop = 0; hop < 16; hop += 1) {
    const hit = ANNOTATION.exec(rest);
    if (hit) return hit[1]!.split(",").filter(Boolean);
    const gap = LIST_GAP.exec(rest);
    if (!gap) return null;
    rest = rest.slice(gap[0].length);
  }
  return null;
}

interface Dangler {
  tool: string;
  ref: string;
  reason: string;
  fix: string;
  quote: string;
}

describe("annotation matcher", () => {
  // The guard is only as good as this matcher: too loose and it green-lights
  // dangling names, too tight and it forces annotations into unreadable prose.
  const after = (s: string, name: string) => annotationAfter(s, s.indexOf(name) + name.length);

  it("reads an annotation attached directly to the name", () => {
    expect(after("use dexe_read_multicall (needs DEXE_TOOLSETS=core,read) for raw calls", "dexe_read_multicall"))
      .toEqual(["core", "read"]);
  });

  it("lets one trailing annotation cover a backticked list", () => {
    const s = "feed `dexe_ipfs_upload_dao_metadata` or `dexe_proposal_build_modify_dao_profile` (needs DEXE_TOOLSETS=core,proposals).";
    expect(after(s, "dexe_ipfs_upload_dao_metadata")).toEqual(["core", "proposals"]);
    expect(after(s, "dexe_proposal_build_modify_dao_profile")).toEqual(["core", "proposals"]);
  });

  it("does NOT jump a sentence boundary to claim an unrelated annotation", () => {
    // The failure mode that would make this guard vacuous.
    const s = "read it with dexe_read_gov_state. Separately, dexe_sim_calldata (needs DEXE_TOOLSETS=core,dev) simulates.";
    expect(after(s, "dexe_read_gov_state")).toBeNull();
  });

  it("returns null when there is no annotation at all", () => {
    expect(after("alternatives: dexe_read_gov_state / dexe_read_multicall — pick one", "dexe_read_multicall"))
      .toBeNull();
  });
});

describe("default profile names no tool it does not have", () => {
  let defaultTools: Awaited<ReturnType<typeof listTools>>;
  let defaultNames: Set<string>;
  let fullNames: Set<string>;

  beforeAll(async () => {
    const full = await listTools("full");
    fullNames = new Set(full.map((t) => t.name));
    defaultTools = await listTools(undefined);
    defaultNames = new Set(defaultTools.map((t) => t.name));
  });

  /** Every dangling reference in the default profile, quarantined or not. */
  function findDanglers(): Dangler[] {
    const danglers: Dangler[] = [];

    for (const tool of defaultTools) {
      const { name, ...rest } = tool;
      const strings: string[] = [];
      collectStrings(rest, strings);

      for (const text of strings) {
        TOOL_TOKEN.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = TOOL_TOKEN.exec(text)) !== null) {
          const raw = m[0];
          const glob = raw.endsWith("*") || raw.endsWith("_");
          const ref = raw.replace(/[*_]+$/, "");
          if (ref === name) continue;

          // A glob ("dexe_read_token_sale_*") is satisfied by any default tool
          // under the prefix — the reader is being pointed at a family, not a
          // call. Only a family with NO default member is a dangling promise.
          const satisfied = glob
            ? [...defaultNames].some((n) => n.startsWith(ref))
            : defaultNames.has(ref);
          if (satisfied) continue;

          const sets = annotationAfter(text, m.index + raw.length);
          const quote = text.slice(Math.max(0, m.index - 70), m.index + raw.length + 90).trim();

          if (!sets) {
            const home = Object.entries(TOOLSETS)
              .filter(([, names]) => names.has(ref))
              .map(([s]) => s);
            const exists = glob
              ? [...fullNames].some((n) => n.startsWith(ref))
              : fullNames.has(ref);
            danglers.push({
              tool: name,
              ref: raw,
              reason: exists
                ? `not in the default profile (lives in: ${home.join(", ") || "?"})`
                : "is not a registered tool at all",
              fix: exists
                ? `either add ${ref} to CORE in src/tools/gate.ts, or write "${ref} (needs DEXE_TOOLSETS=core,${home[0] ?? "read"})"`
                : `remove or correct the name — nothing registers ${raw}`,
              quote,
            });
            continue;
          }

          // The annotation must be true: the sets it names have to contain the
          // tool, or the user follows it and still gets a 404.
          const unlocked = new Set<string>();
          for (const s of sets) for (const n of TOOLSETS[s] ?? []) unlocked.add(n);
          const ok = glob ? [...unlocked].some((n) => n.startsWith(ref)) : unlocked.has(ref);
          if (!ok) {
            const home = Object.entries(TOOLSETS)
              .filter(([, names]) => names.has(ref))
              .map(([s]) => s);
            danglers.push({
              tool: name,
              ref: raw,
              reason: `annotated DEXE_TOOLSETS=${sets.join(",")}, but that profile does not contain it`,
              fix: home.length
                ? `use "(needs DEXE_TOOLSETS=core,${home[0]})"`
                : `${ref} is in no toolset — add it to one in src/tools/gate.ts`,
              quote,
            });
          }
        }
      }
    }

    return danglers;
  }

  const report = (ds: Dangler[]) =>
    ds
      .map(
        (d) =>
          `\n  ${d.tool} names ${d.ref} — ${d.reason}.\n` +
          `    fix: ${d.fix}\n` +
          `    at: …${d.quote}…`,
      )
      .join("\n");

  it("resolves every dexe_* reference in a default description/schema", () => {
    const fresh = findDanglers().filter((d) => !QUARANTINED.has(d.ref.replace(/[*_]+$/, "")));
    expect(
      fresh,
      `${fresh.length} dangling tool reference(s) in the DEFAULT profile. A default-profile ` +
        `description that names a tool the session does not have sends the model to a confident ` +
        `404 — worse than saying nothing. Fix the text, or move the tool into CORE ` +
        `(src/tools/gate.ts). Do NOT add to QUARANTINE unless the owning file is off-limits ` +
        `to you:${report(fresh)}\n`,
    ).toEqual([]);
  });

  it("keeps the quarantine honest — every entry must still be dangling", () => {
    // Forces the list to shrink. Once someone annotates the text in
    // src/lib/params.ts / src/tools/ipfs.ts, this fails until the entry is
    // deleted, so a fixed item cannot masquerade as permanent debt.
    const stillDangling = new Set(findDanglers().map((d) => d.ref.replace(/[*_]+$/, "")));
    const stale = QUARANTINE.filter((q) => !stillDangling.has(q.ref));
    expect(
      stale,
      `QUARANTINE is stale — these no longer dangle. Delete them from ` +
        `tests/tools/default-profile-references.test.ts so the list keeps shrinking:` +
        stale.map((q) => `\n  ${q.ref} (${q.source})`).join(""),
    ).toEqual([]);
  });

  it("quarantines nothing that could have been fixed in gate.ts alone", () => {
    // Every quarantined ref must genuinely live in another toolset — i.e. the
    // fix is text in its owning file, not "add it to CORE". Anything that is
    // simply unregistered is a typo and must never be quarantined.
    for (const q of QUARANTINE) {
      const home = Object.entries(TOOLSETS)
        .filter(([, names]) => names.has(q.ref))
        .map(([s]) => s);
      expect(home.length, `${q.ref} is in no toolset — that is a typo, not debt`).toBeGreaterThan(0);
      expect(fullNames.has(q.ref), `${q.ref} is not a registered tool`).toBe(true);
      expect(q.fix.length, `${q.ref} needs a concrete fix string`).toBeGreaterThan(20);
    }
  });

  it("keeps the graph_query → graph_schema recovery path inside the default profile", () => {
    // The specific regression that motivated this file. dexe_graph_query is in
    // core and its documented recovery from "Type 'X' has no field 'Y'" — the
    // most common subgraph failure — is dexe_graph_schema. Both, or neither.
    expect(defaultNames.has("dexe_graph_query")).toBe(true);
    expect(defaultNames.has("dexe_graph_schema")).toBe(true);
  });

  it("annotates the on-chain fallbacks the default profile lacks", () => {
    // chainNote() is appended to three core subgraph tools. It used to offer
    // dexe_read_gov_state / dexe_read_multicall unqualified.
    const daoList = defaultTools.find((t) => t.name === "dexe_read_dao_list");
    expect(daoList, "dexe_read_dao_list must be default-visible").toBeDefined();
    const desc = daoList!.description ?? "";
    expect(desc).toContain("dexe_read_multicall (needs DEXE_TOOLSETS=core,read)");
    expect(desc).toContain("dexe_read_gov_state (needs DEXE_TOOLSETS=core,dev)");
  });
});
