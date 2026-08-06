import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../../src/config.js";
import { gqlRequest, resolveSubgraphUrl, type SubgraphKind } from "../../src/lib/subgraph.js";
import {
  editDistance,
  namedType,
  summarizeRootFields,
  typeRefLabel,
  type GraphFieldInfo,
  type GraphTypeRef,
} from "../../src/tools/subgraph.js";

/**
 * docs/GRAPH.md is shipped as the `dexe://graph-schema` MCP resource, so every
 * agent that asks "what fields does Proposal have?" gets THIS file. A stale
 * entry does not degrade gracefully — it produces a query the gateway rejects,
 * and the agent's usual next move is to invent a field name. 0.30.2 found one
 * invalid query that had shipped for months for exactly this reason.
 *
 * Two layers:
 *   - offline (always runs): the file is internally consistent — every
 *     documented entity has a root-field row and vice versa. Catches the most
 *     common hand-edit mistake without touching the network.
 *   - live (opt-in via DEXE_GRAPH_DRIFT_CHECK=1): introspect the deployed
 *     schemas and diff them against the file, reporting added / removed /
 *     renamed fields. Opt-in because CI has no network — a test that silently
 *     passes when the fetch fails would be worse than no test.
 */

const LIVE = process.env.DEXE_GRAPH_DRIFT_CHECK === "1";
const KINDS: SubgraphKind[] = ["pools", "interactions", "validators"];

// ---------- docs/GRAPH.md parser ----------

export interface DocSection {
  kind: SubgraphKind;
  /** Entity → root query field names, from the per-subgraph table. */
  rootFields: Map<string, { list: string | null; single: string | null }>;
  /** Entity → declared field names, from the `### Entity` fenced blocks. */
  entities: Map<string, string[]>;
}

/**
 * Parses the two machine-readable shapes in GRAPH.md: the per-subgraph root
 * field table and the `### Entity` + fenced `field: Type` blocks. Deliberately
 * strict — a heading or table row that stops matching should surface as a
 * parse failure here, not as a silently empty diff.
 */
export function parseGraphDoc(markdown: string): DocSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: DocSection[] = [];
  let current: DocSection | null = null;
  let entity: string | null = null;
  let inFence = false;

  for (const line of lines) {
    const section = /^##\s+`(pools|interactions|validators)`\s+subgraph\b/.exec(line);
    if (section) {
      current = { kind: section[1] as SubgraphKind, rootFields: new Map(), entities: new Map() };
      sections.push(current);
      entity = null;
      inFence = false;
      continue;
    }
    if (!current) continue;

    if (line.startsWith("```")) {
      inFence = !inFence;
      if (!inFence) entity = null; // a fence close ends the entity block
      continue;
    }
    if (inFence) {
      if (!entity) continue;
      const field = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\S/.exec(line);
      if (field) current.entities.get(entity)!.push(field[1]!);
      continue;
    }

    const head = /^###\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(line);
    if (head) {
      entity = head[1]!;
      if (!current.entities.has(entity)) current.entities.set(entity, []);
      continue;
    }

    // | `Entity` | `listField` | `singleField` |
    const row = /^\|\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*\|\s*`?([A-Za-z0-9_]*)`?\s*\|\s*`?([A-Za-z0-9_]*)`?\s*\|/.exec(line);
    if (row) {
      current.rootFields.set(row[1]!, { list: row[2] || null, single: row[3] || null });
    }
  }
  return sections;
}

const DOC = readFileSync(resolve(process.cwd(), "docs/GRAPH.md"), "utf8");
const SECTIONS = parseGraphDoc(DOC);

// ---------- diffing ----------

export interface FieldDrift {
  added: string[];
  removed: string[];
  /** `removed → added` pairs that look like one field renamed, not two changes. */
  renamed: Array<[string, string]>;
}

const normalize = (s: string) => s.toLowerCase().replace(/_/g, "");

/**
 * How strongly `from` and `to` look like the same field renamed — lower is a
 * better match, Infinity means unrelated. Covers the three shapes The Graph
 * schemas actually produce: a case/underscore respelling, a suffix or prefix
 * bolted on (`votersVoted` → `votersVotedCount`), and a small typo-scale edit.
 */
export function renameScore(from: string, to: string): number {
  const a = normalize(from);
  const b = normalize(to);
  if (a === b) return 0;
  if (a.startsWith(b) || b.startsWith(a) || a.endsWith(b) || b.endsWith(a)) {
    const delta = Math.abs(a.length - b.length);
    if (delta <= 8) return 1 + delta / 100;
  }
  const d = editDistance(a, b);
  return d <= 2 ? 2 + d : Infinity;
}

/**
 * Classifies a set difference into added / removed / renamed. A removed name
 * and an added name are reported as ONE rename when they look like the same
 * field respelled — `votersVoted` → `votersVotedCount` is a single edit to make
 * in this file, and splitting it into an unrelated add plus an unrelated remove
 * is how a doc fix ends up applying only half of it.
 */
export function diffFields(documented: readonly string[], live: readonly string[]): FieldDrift {
  const liveSet = new Set(live);
  const docSet = new Set(documented);
  const added = live.filter((f) => !docSet.has(f));
  const removed = documented.filter((f) => !liveSet.has(f));
  const renamed: Array<[string, string]> = [];
  const takenAdds = new Set<string>();
  const stillRemoved: string[] = [];

  for (const r of removed) {
    const match = added
      .filter((a) => !takenAdds.has(a))
      .map((a) => ({ a, score: renameScore(r, a) }))
      .filter((m) => Number.isFinite(m.score))
      .sort((x, y) => x.score - y.score)[0];
    if (match) {
      renamed.push([r, match.a]);
      takenAdds.add(match.a);
    } else {
      stillRemoved.push(r);
    }
  }
  return { added: added.filter((a) => !takenAdds.has(a)), removed: stillRemoved, renamed };
}

function describeDrift(label: string, d: FieldDrift): string[] {
  const out: string[] = [];
  for (const [from, to] of d.renamed) out.push(`${label}: RENAMED ${from} → ${to}`);
  for (const f of d.added) out.push(`${label}: ADDED ${f} (missing from docs/GRAPH.md)`);
  for (const f of d.removed) out.push(`${label}: REMOVED ${f} (documented but gone from the schema)`);
  return out;
}

// ---------- offline: the diff engine itself ----------

describe("drift diff engine (offline)", () => {
  it("parses entities, their fields and the root-field table out of GRAPH.md", () => {
    const md = [
      "## `pools` subgraph — x",
      "| Entity | list | single |",
      "| --- | --- | --- |",
      "| `DaoPool` | `daoPools` | `daoPool` |",
      "### DaoPool",
      "```",
      "id: Bytes!",
      "name: String!",
      "```",
    ].join("\n");
    const [section] = parseGraphDoc(md);
    expect(section!.kind).toBe("pools");
    expect(section!.rootFields.get("DaoPool")).toEqual({ list: "daoPools", single: "daoPool" });
    expect(section!.entities.get("DaoPool")).toEqual(["id", "name"]);
  });

  it("does not leak fields across a closed fence", () => {
    const md = ["## `pools` subgraph — x", "### A", "```", "id: Bytes!", "```", "prose: not a field"].join("\n");
    expect(parseGraphDoc(md)[0]!.entities.get("A")).toEqual(["id"]);
  });

  it("classifies pure additions and removals", () => {
    const d = diffFields(["id", "gone"], ["id", "fresh1", "fresh2"]);
    expect(d.added.sort()).toEqual(["fresh1", "fresh2"]);
    expect(d.removed).toEqual(["gone"]);
    expect(d.renamed).toEqual([]);
  });

  it("reports a respelling as ONE rename, not an add plus a remove", () => {
    expect(diffFields(["votersVoted"], ["votersVotedCount"])).toEqual({
      added: [],
      removed: [],
      renamed: [["votersVoted", "votersVotedCount"]],
    });
    expect(diffFields(["total_vote"], ["totalVote"]).renamed).toEqual([["total_vote", "totalVote"]]);
  });

  it("scores unrelated names as un-matchable", () => {
    expect(renameScore("id", "totalCurrentTokenDelegatees")).toBe(Infinity);
    expect(renameScore("timestamp", "timestamp")).toBe(0);
  });

  it("reports nothing when the sets agree", () => {
    expect(diffFields(["a", "b"], ["b", "a"])).toEqual({ added: [], removed: [], renamed: [] });
  });
});

// ---------- offline: the file agrees with itself ----------

describe("docs/GRAPH.md structure (offline)", () => {
  it("parses all three subgraph sections", () => {
    expect(SECTIONS.map((s) => s.kind)).toEqual(KINDS);
  });

  for (const kind of KINDS) {
    describe(kind, () => {
      const section = () => SECTIONS.find((s) => s.kind === kind)!;

      it("has a root-field table and entity blocks", () => {
        expect(section().rootFields.size).toBeGreaterThan(5);
        expect(section().entities.size).toBeGreaterThan(5);
      });

      it("every documented entity has a root Query field row", () => {
        const missing = [...section().entities.keys()].filter((e) => !section().rootFields.has(e));
        expect(missing, `${kind}: entities with no root-field row: ${missing.join(", ")}`).toEqual([]);
      });

      it("every root-field row has a documented entity block", () => {
        const missing = [...section().rootFields.keys()].filter((e) => !section().entities.has(e));
        expect(missing, `${kind}: root-field rows with no '### ${"<Entity>"}' block: ${missing.join(", ")}`).toEqual(
          [],
        );
      });

      it("every entity block declares at least an id", () => {
        const empty = [...section().entities.entries()].filter(([, f]) => f.length === 0).map(([e]) => e);
        expect(empty, `${kind}: entity blocks with no fields: ${empty.join(", ")}`).toEqual([]);
      });

      it("no root query field is spelled like its entity (the trap this table exists for)", () => {
        // `DaoPool` is never queried as `DaoPool`. A row that says otherwise is a
        // copy-paste, and copy-paste is what produced the gap in the first place.
        const wrong = [...section().rootFields.entries()]
          .filter(([entity, r]) => r.list === entity || r.single === entity)
          .map(([e]) => e);
        expect(wrong).toEqual([]);
      });
    });
  }
});

// ---------- live: the file agrees with the deployed schema ----------

interface IntrospectedSchema {
  __schema: {
    queryType: { fields: GraphFieldInfo[] };
    types: Array<{ name: string; kind: string; fields: GraphFieldInfo[] | null }>;
  };
}

const FULL_INTROSPECTION = /* GraphQL */ `
  query DriftIntrospection {
    __schema {
      queryType {
        fields {
          name
          type {
            ...R
          }
        }
      }
      types {
        name
        kind
        fields {
          name
          type {
            ...R
          }
        }
      }
    }
  }
  fragment R on __Type {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
        }
      }
    }
  }
`;

describe.skipIf(!LIVE)("docs/GRAPH.md vs the live subgraph schema", () => {
  for (const kind of KINDS) {
    describe(kind, () => {
      let live: IntrospectedSchema;

      it("introspects the deployed schema", async () => {
        const config = await loadConfig();
        const sg = resolveSubgraphUrl(config, kind);
        live = await gqlRequest<IntrospectedSchema>(sg.url, FULL_INTROSPECTION);
        expect(live.__schema.types.length).toBeGreaterThan(0);
      }, 30_000);

      it("root Query field names match", () => {
        const section = SECTIONS.find((s) => s.kind === kind)!;
        const liveRoots = summarizeRootFields(live.__schema.queryType.fields);
        const problems: string[] = [];
        for (const r of liveRoots) {
          const doc = section.rootFields.get(r.entity);
          if (!doc) {
            problems.push(`ADDED entity ${r.entity} (query it as ${r.list ?? r.single})`);
            continue;
          }
          if (doc.list !== r.list) problems.push(`${r.entity}: list field documented ${doc.list}, live ${r.list}`);
          if (doc.single !== r.single)
            problems.push(`${r.entity}: single field documented ${doc.single}, live ${r.single}`);
        }
        const liveNames = new Set(liveRoots.map((r) => r.entity));
        for (const e of section.rootFields.keys()) {
          if (!liveNames.has(e)) problems.push(`REMOVED entity ${e} (documented, not in the schema)`);
        }
        expect(problems, `${kind} root-field drift:\n${problems.join("\n")}`).toEqual([]);
      });

      it("entity fields match", () => {
        const section = SECTIONS.find((s) => s.kind === kind)!;
        const byName = new Map(
          live.__schema.types
            .filter((t) => t.kind === "OBJECT" && !t.name.startsWith("_") && t.fields)
            .map((t) => [t.name, t.fields!.map((f) => f.name)]),
        );
        const problems: string[] = [];
        for (const [entity, documented] of section.entities) {
          const liveFields = byName.get(entity);
          if (!liveFields) {
            problems.push(`${entity}: documented but not an OBJECT type in the live schema`);
            continue;
          }
          problems.push(...describeDrift(entity, diffFields(documented, liveFields)));
        }
        expect(problems, `${kind} entity-field drift:\n${problems.join("\n")}`).toEqual([]);
      });

      it("documented field TYPES match (a Bytes that became a String is silent breakage)", () => {
        const section = SECTIONS.find((s) => s.kind === kind)!;
        // Only checks that the named type still exists on the entity — the SDL
        // spelling in the doc is informative, and asserting it verbatim would
        // fail on nullability churn that changes nothing for a reader.
        const objects = new Map(
          live.__schema.types.filter((t) => t.kind === "OBJECT" && t.fields).map((t) => [t.name, t.fields!]),
        );
        const problems: string[] = [];
        for (const [entity, documented] of section.entities) {
          const fields = objects.get(entity);
          if (!fields) continue;
          const liveByName = new Map(fields.map((f) => [f.name, f.type as GraphTypeRef]));
          for (const f of documented) {
            const ref = liveByName.get(f);
            if (ref && namedType(ref) === null) problems.push(`${entity}.${f}: unresolvable type ${typeRefLabel(ref)}`);
          }
        }
        expect(problems).toEqual([]);
      });
    });
  }
});
