import type { KnowledgeCorpus } from "../types.js";
import { READ_TOPICS } from "./topics.js";
import { READ_GOTCHAS } from "./gotchas.js";

/**
 * The READ edition's knowledge: reference topics for reading DeXe data and the
 * gotchas they cite. No step journeys — every flow is a write journey and lives
 * in ../write/. Bind it with `createKnowledge(READ_CORPUS, locator)`.
 */
export const READ_CORPUS: KnowledgeCorpus = {
  flows: [],
  topics: READ_TOPICS,
  gotchas: READ_GOTCHAS,
};

export { READ_TOPICS, READ_GOTCHAS };
export { READ_GOTCHA_BY_ID } from "./gotchas.js";
