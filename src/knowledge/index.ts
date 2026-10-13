import {
  createKnowledge,
  createToolLocator,
  READ_CORPUS,
  type Flow,
  type Gotcha,
  type Knowledge,
  type KnowledgeCorpus,
  type Topic,
} from "@dexe-network/dexe-mcp/core";
import { WRITE_CORPUS, AGENT_PROTOCOL } from "./write/index.js";
import { TOOLSETS, defaultProfileToolNames } from "../tools/gate.js";

/**
 * The knowledge of the SINGLE server this repo ships: the write journeys next
 * to the read topics, one id namespace, one gotcha corpus (the write corpus's,
 * which already carries the read gotchas in their historical order). Its
 * `dexe_guide`, PLAYBOOK regions, skill recipes and `dexe-flow-*` prompts are
 * all rendered from this.
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
