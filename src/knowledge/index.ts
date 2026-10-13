import {
  createKnowledge,
  createToolLocator,
  defaultToolNames,
  READ_CORPUS,
  type Flow,
  type Gotcha,
  type Knowledge,
  type KnowledgeCorpus,
  type Topic,
} from "@dexe-network/dexe-mcp/core";
import { WRITE_CORPUS, AGENT_PROTOCOL } from "./write/index.js";
import { TOOLSETS, WRITE_EDITION_TOOLSETS, defaultProfileToolNames } from "../tools/gate.js";
import { READ_SERVER_LABEL, READ_TOOLS } from "../editions.js";
import type { ToolLocator } from "./write/nextSteps.js";
import { markReadTools } from "../tools/readServerMarks.js";

/**
 * The knowledge of the SINGLE server this repo ships: the write journeys next
 * to the read topics, one id namespace, one gotcha corpus (the write corpus's,
 * which already carries the read gotchas in their historical order). Its
 * `dexe_guide` (registered only with DEXE_WRITE_STANDALONE=1), PLAYBOOK
 * regions, skill recipes and `dexe-flow-*` prompts are all rendered from this.
 *
 * A composition root, like src/tools/index.ts: it wires both editions'
 * knowledge together. Neither edition imports it — the read guide takes a
 * `Knowledge` as a parameter (the read edition's tools/guide.ts).
 *
 * The named exports below keep the pre-split API (`flowIndex()`,
 * `flowDetail(id)`, `FLOWS`, `GOTCHA_BY_ID`, …) bound to this corpus.
 */
export const SINGLE_SERVER_CORPUS: KnowledgeCorpus = {
  ...WRITE_CORPUS,
  topics: READ_CORPUS.topics,
};

/**
 * Every tool is local to this server: the default profile needs nothing, a
 * gated tool names its set(s).
 */
export const SINGLE_SERVER_KNOWLEDGE: Knowledge = createKnowledge(
  SINGLE_SERVER_CORPUS,
  createToolLocator({ toolsets: TOOLSETS, defaultTools: defaultProfileToolNames() }),
);

/**
 * `dexe_write_guide` on the write-only server (the default): the eight write
 * journeys alone. A step that calls a READ tool — dexe_proposal_state,
 * dexe_dao_predict_addresses, dexe_read_staking_info, dexe_read_token_sales,
 * dexe_dao_report — is located `providedBy` the read server, because this
 * server does not register it; a write tool outside the default profile names
 * its set, as everywhere else.
 */
export const WRITE_ONLY_LOCATOR: ToolLocator = createToolLocator({
  toolsets: WRITE_EDITION_TOOLSETS.sets,
  defaultTools: defaultToolNames(WRITE_EDITION_TOOLSETS),
  elsewhere: { tools: new Set(READ_TOOLS), providedBy: READ_SERVER_LABEL },
});

/**
 * The write corpus as the write-only server serves it: the read gotchas it
 * cites come from the read package worded for a server that has the read
 * tools, so every read tool they name is marked `(read server)` here.
 */
export const WRITE_ONLY_CORPUS: KnowledgeCorpus = {
  ...WRITE_CORPUS,
  gotchas: WRITE_CORPUS.gotchas.map((g) => ({ ...g, text: markReadTools(g.text) })),
};

export const WRITE_ONLY_GUIDE_KNOWLEDGE: Knowledge = createKnowledge(WRITE_ONLY_CORPUS, WRITE_ONLY_LOCATOR);

/**
 * `dexe_write_guide` on the standalone server (DEXE_WRITE_STANDALONE=1): the
 * same journeys, every tool local — located exactly as `dexe_guide` locates
 * them.
 */
export const STANDALONE_LOCATOR: ToolLocator = createToolLocator({
  toolsets: TOOLSETS,
  defaultTools: defaultProfileToolNames(),
});

export const STANDALONE_GUIDE_KNOWLEDGE: Knowledge = createKnowledge(WRITE_CORPUS, STANDALONE_LOCATOR);

/** Where this server's tools live, per mode — for the guide and the composites' `next` pointers. */
export function writeToolLocator(config: { writeStandalone?: boolean }): ToolLocator {
  return config.writeStandalone ? STANDALONE_LOCATOR : WRITE_ONLY_LOCATOR;
}

/** The knowledge `dexe_write_guide` serves on this server. */
export function writeGuideKnowledge(config: { writeStandalone?: boolean }): Knowledge {
  return config.writeStandalone ? STANDALONE_GUIDE_KNOWLEDGE : WRITE_ONLY_GUIDE_KNOWLEDGE;
}

const K = SINGLE_SERVER_KNOWLEDGE;

export const flowIndex = K.flowIndex;
export const topicIndex = K.topicIndex;
export const flowDetail = K.flowDetail;
export const topicDetail = K.topicDetail;
export const matchIntent = K.matchIntent;
export const bestMatch = K.bestMatch;

export const FLOWS: readonly Flow[] = SINGLE_SERVER_CORPUS.flows;
export const FLOW_BY_ID: ReadonlyMap<string, Flow> = K.flowById;
export const TOPICS: readonly Topic[] = SINGLE_SERVER_CORPUS.topics;
export const TOPIC_BY_ID: ReadonlyMap<string, Topic> = K.topicById;
export const GOTCHAS: readonly Gotcha[] = SINGLE_SERVER_CORPUS.gotchas;
export const GOTCHA_BY_ID: ReadonlyMap<string, Gotcha> = K.gotchaById;
export { AGENT_PROTOCOL };
export type {
  FlowDetail,
  FlowIndexEntry,
  FlowStepDetail,
  IntentMatch,
  ResolvedGotcha,
  TopicDetail,
  TopicIndexEntry,
  TopicToolRef,
} from "@dexe-network/dexe-mcp/core";
