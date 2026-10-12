import { describe, expect, it } from "vitest";
import { loadReadConfig } from "../../src/configRead.js";
import { READ_CORPUS } from "../../src/knowledge/read/index.js";
import { readServerCorpus } from "../../src/knowledge/read/edition.js";
import { renderGotchasSection, renderTopicsSection } from "../../src/knowledge/render.js";
import { createReadServer } from "../../src/read/server.js";
import { connectInMemory } from "../helpers/readEdition.js";

/**
 * Security review of #103, item 2: the read server keeps nothing between calls
 * and has no toolset profiles, so its guide, playbook and resources must not
 * tell a caller to use `since: "last"`, `persist`, `/loop` / `/schedule`, the
 * dexe-report skill, or a DEXE_TOOLSETS profile — the server would refuse or
 * ignore each. A remote server's text names no server variable either.
 * (The full server keeps READ_CORPUS as written: it does store runs.)
 */

/** Claims the read server's behaviour contradicts. */
const CONTRADICTS_READ_SERVER: readonly RegExp[] = [
  /since:\s*\\?"last\\?"/,
  /\bpersist\b/,
  /\/loop\b/,
  /\/schedule\b/,
  /dexe-report/,
  /DEXE_TOOLSETS/,
  /\btoolset\b/i,
  /'read' set/,
  /`dev` toolset/,
  /default profile/,
];
/** Remote only: advice to configure the server. */
const ENV_ADVICE: readonly RegExp[] = [/\bDEXE_[A-Z0-9_]+/, /\brestart\b/, /\.env\b/];

function offending(text: string, patterns: readonly RegExp[]): string[] {
  return patterns.filter((re) => re.test(text)).map((re) => `${re}: …${text.slice(Math.max(0, text.search(re) - 50), text.search(re) + 40)}…`);
}

/** Everything the read server says about itself: guide (menu + every topic + an intent), resources. */
async function publishedText(remote: boolean): Promise<string> {
  const config = await loadReadConfig();
  const s = await connectInMemory(createReadServer(config, { remote, version: "0" }));
  try {
    const parts: string[] = [];
    const guide = async (args: Record<string, unknown>) =>
      parts.push(JSON.stringify(await s.client.callTool({ name: "dexe_guide", arguments: args })));
    await guide({});
    await guide({ intent: "weekly report on my DAO, only what changed" });
    for (const t of READ_CORPUS.topics) await guide({ flow: t.id });
    for (const r of (await s.client.listResources()).resources) {
      parts.push(JSON.stringify(await s.client.readResource({ uri: r.uri })));
    }
    return parts.join("\n");
  } finally {
    await s.close();
  }
}

describe("the read server's knowledge matches what the read server does", () => {
  it.each([false, true])("remote=%s: guide, playbook and resources make no claim the server refuses", async (remote) => {
    const text = await publishedText(remote);
    expect(text.length).toBeGreaterThan(20_000);
    // GRAPH.md is a schema reference shipped as-is; the claims live in the guide and playbook.
    expect(offending(text, CONTRADICTS_READ_SERVER)).toEqual([]);
    if (remote) {
      const ours = text.replace(/"uri":"dexe:\/\/graph-schema".*?(?="uri":"dexe:\/\/|$)/s, "");
      expect(offending(ours, ENV_ADVICE)).toEqual([]);
    }
  });

  it("the report topic tells the caller how to anchor `since` without stored runs", () => {
    const topic = readServerCorpus({ remote: false }).topics.find((t) => t.id === "report_dao_activity")!;
    const text = JSON.stringify(topic);
    expect(text).toMatch(/generatedAt/);
    expect(text).toMatch(/block:/);
  });

  it("the full server's corpus is untouched (it does store runs)", () => {
    const full = renderTopicsSection(READ_CORPUS) + renderGotchasSection(READ_CORPUS);
    expect(full).toMatch(/since: \\?"last\\?"|since: "last"/);
    expect(full).toMatch(/DEXE_TOOLSETS/);
  });

  it("every edit still finds its passage (the variant fails loudly on drift)", () => {
    expect(() => readServerCorpus({ remote: false })).not.toThrow();
    expect(() => readServerCorpus({ remote: true })).not.toThrow();
  });
});
