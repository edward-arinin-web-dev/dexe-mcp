import type { Gotcha, KnowledgeCorpus, Topic, TopicSection } from "../types.js";
import { READ_CORPUS } from "./index.js";

/**
 * ── The read corpus as the read SERVER tells it ────────────────────────────
 *
 * READ_CORPUS is written for the full server, which stores report snapshots
 * (`since: "last"`, `persist`), gates tools by DEXE_TOOLSETS profile, and is
 * driven from Claude Code (`/loop`, the dexe-report skill). The read server
 * (`dexe-mcp-read`) does none of that: it keeps nothing between calls and
 * registers every read tool. Telling its callers otherwise sends them to a
 * refusal. So the read server's guide and playbook are this variant — the same
 * topics and gotchas, with exactly the passages below rewritten; anything not
 * named here is shared word for word.
 *
 * `remote` also drops env-variable advice: a caller of a hosted server cannot
 * set the server's variables.
 *
 * Every edit names the passage it replaces and fails loudly when that passage
 * is gone, so a change to READ_CORPUS cannot silently leave a stale claim in
 * the read edition (tests/read/read-edition-knowledge.test.ts).
 */

interface TopicEdit {
  title?: string;
  /** [from, to] substring replacements in the summary. */
  summary?: Array<[string, string]>;
  /** Per section heading: a replacement section, or substring replacements in its text. */
  sections?: Record<string, TopicSection | Array<[string, string]>>;
}

const READ_SERVER_TOPIC_EDITS: Record<string, TopicEdit> = {
  read_dao_data: {
    summary: [[" — with bounds, chain coverage, and toolset gating.", " — with bounds and chain coverage."]],
    sections: {
      "Free-form contract reads": [[" (all three in the `dev` toolset)", ""]],
      "Toolset gating": {
        heading: "Every read tool is served",
        text:
          "This server registers every read tool these topics name — nothing needs switching on, and nothing " +
          "needs configuring before reading. dexe_context reports the chains and data sources it reads from.",
      },
      "Want a whole report, not one field?": [
        ["and can report only what changed since the previous run.", "and can report only what changed since a time or block you name."],
        [" for the reporting recipe, including scheduled/recurring runs.", " for the reporting recipe."],
      ],
    },
  },
  report_dao_activity: {
    title: "Report on a DAO — activity, members, who voted, statistics (one call)",
    summary: [
      [
        ", show only what moved via `since`, and run it on a schedule (/schedule cron, /loop interval).",
        ", and show only what moved since a time or block you pass as `since`.",
      ],
    ],
    sections: {
      "Only what changed: the `since` diff": {
        heading: "Only what changed: the `since` window",
        text:
          "A repeated report is only useful if it says what MOVED. Pass `since` — an ISO-8601 time " +
          "(\"2026-08-01T00:00:00Z\"), Unix seconds, or \"block:62000000\" — and the report fills in `changes` from the " +
          "indexer for that window: proposals created, members joined, delegation shifts, activity. This server keeps " +
          "nothing between calls, so there is no stored previous run to compare against: to cover the time since the " +
          "last report, pass that report's `generatedAt` (or \"block:<its blockNumber>\"). Without `since` every run is " +
          "a full snapshot and the user has to spot the deltas themselves.",
      },
      "Recurring runs (/schedule and /loop)": {
        heading: "Repeated reports",
        text:
          "Every call stands alone. For a periodic digest, keep the previous result's `generatedAt` and pass it as " +
          "`since` next time; the first run is a full report. Spell out govPool, chainId, `since` and the output " +
          "format in the request each time — nothing is remembered on this side.",
      },
      "Questions the report does not answer": {
        heading: "Questions the report does not answer",
        text:
          "For anything custom — a filter, a join, a historical slice, a leaderboard the report does not cut — go to " +
          "dexe_graph_query (see topic 'read_dao_data'). NEVER guess an entity or field name: read the MCP resource " +
          "dexe://graph-schema, or call dexe_graph_schema for live introspection. For 'what needs MY attention " +
          "across all my DAOs' use dexe_user_inbox rather than one report per DAO.",
      },
    },
  },
};

const READ_SERVER_GOTCHA_EDITS: Record<string, Array<[string, string]>> = {
  "multicall-signature-form": [[" (`dev` toolset)", ""]],
};

/** Remote only: env-variable advice a caller of a hosted server cannot follow. */
const REMOTE_GOTCHA_EDITS: Record<string, Array<[string, string]>> = {
  "subgraph-backend-mainnet-only": [
    [", and the env var to set.", "."],
    [
      " To index another chain yourself set DEXE_SUBGRAPH_<KIND>_URL_<chainId> (e.g. DEXE_SUBGRAPH_POOLS_URL_97).",
      "",
    ],
  ],
};

function replaceAll(where: string, text: string, edits: ReadonlyArray<[string, string]>): string {
  let out = text;
  for (const [from, to] of edits) {
    if (!out.includes(from)) throw new Error(`read-edition knowledge: "${from.slice(0, 60)}…" no longer appears in ${where}`);
    out = out.split(from).join(to);
  }
  return out;
}

function editTopic(t: Topic, edit: TopicEdit | undefined): Topic {
  if (!edit) return t;
  const sections = t.sections.map((s) => {
    const e = edit.sections?.[s.heading];
    if (!e) return s;
    if (Array.isArray(e)) return { heading: s.heading, text: replaceAll(`${t.id} / ${s.heading}`, s.text, e) };
    return e;
  });
  for (const heading of Object.keys(edit.sections ?? {})) {
    if (!t.sections.some((s) => s.heading === heading)) {
      throw new Error(`read-edition knowledge: topic ${t.id} has no section "${heading}"`);
    }
  }
  return {
    ...t,
    title: edit.title ?? t.title,
    summary: edit.summary ? replaceAll(`${t.id} summary`, t.summary, edit.summary) : t.summary,
    sections,
  };
}

function editGotchas(gotchas: readonly Gotcha[], edits: Record<string, Array<[string, string]>>): Gotcha[] {
  for (const id of Object.keys(edits)) {
    if (!gotchas.some((g) => g.id === id)) throw new Error(`read-edition knowledge: no gotcha "${id}"`);
  }
  return gotchas.map((g) => (edits[g.id] ? { ...g, text: replaceAll(`gotcha ${g.id}`, g.text, edits[g.id]!) } : g));
}

/** The read server's corpus: stdio (`remote: false`) or hosted (`remote: true`). */
export function readServerCorpus(opts: { remote: boolean }): KnowledgeCorpus {
  for (const id of Object.keys(READ_SERVER_TOPIC_EDITS)) {
    if (!READ_CORPUS.topics.some((t) => t.id === id)) throw new Error(`read-edition knowledge: no topic "${id}"`);
  }
  let gotchas = editGotchas(READ_CORPUS.gotchas, READ_SERVER_GOTCHA_EDITS);
  if (opts.remote) gotchas = editGotchas(gotchas, REMOTE_GOTCHA_EDITS);
  return {
    flows: READ_CORPUS.flows,
    topics: READ_CORPUS.topics.map((t) => editTopic(t, READ_SERVER_TOPIC_EDITS[t.id])),
    gotchas,
  };
}
