import { z } from "zod";
import { Interface, isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { RpcProvider } from "../rpc.js";
import { multicall } from "../lib/multicall.js";
import {
  gqlRequest,
  resolveSubgraphUrl,
  subgraphChains,
  type ResolvedSubgraph,
  type SubgraphKind,
} from "../lib/subgraph.js";
import { SUBGRAPH_KINDS, subgraphEnvVar } from "../config.js";
import { unixToUtc } from "../lib/time.js";
import { GET_TIER_VIEWS_FRAGMENT } from "./otc.js";
import { chainIdParam } from "../lib/params.js";
import { transactionTypeLabels } from "../lib/interactionTypes.js";
import { safeErrorMessage } from "../lib/redact.js";
import { renderUntrusted, untrustedResult } from "../lib/sanitize.js";
import { toActionableError } from "../lib/errors.js";

/**
 * Subgraph-backed read tools. Each tool queries one of the three DeXe
 * subgraphs (pools, validators, interactions) and returns structured data
 * for AI agent decision-making.
 *
 * A subgraph endpoint indexes exactly ONE chain, so every tool here takes
 * `chainId` and resolves its endpoint through `resolveSubgraphUrl`. A chain
 * with no endpoint is an error, never a silent substitution: serving BSC
 * mainnet rows to someone working on testnet looks like a successful read, and
 * an agent will act on it. Every response also carries `indexedChainId` — the
 * chain the rows actually came from — so the payload states its own provenance
 * even if resolution is ever wrong again.
 *
 * Endpoints come from `DEXE_SUBGRAPH_<KIND>_URL_<chainId>`, falling back to the
 * unsuffixed `DEXE_SUBGRAPH_<KIND>_URL` / baked defaults for the chain named by
 * `DEXE_SUBGRAPH_CHAIN_ID` (BSC mainnet, 56).
 */

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/**
 * The endpoint for `kind` on `chainId`, or the resolver's message as a plain
 * string. That message is already written as user-facing remediation (it names
 * the chain, the chains that DO have this subgraph, the on-chain alternatives,
 * and the exact env var to set), so callers surface it verbatim through
 * `errorResult` instead of letting a throw escape as a stack trace.
 */
function resolveEndpoint(
  ctx: ToolContext,
  kind: SubgraphKind,
  chainId?: number,
): ResolvedSubgraph | string {
  try {
    return resolveSubgraphUrl(ctx.config, kind, chainId);
  } catch (err) {
    return safeErrorMessage(err);
  }
}

/**
 * The chain paragraph appended to each tool description, built at registration
 * from the endpoints this install actually has. A hardcoded "BSC mainnet only"
 * sentence goes stale the moment someone sets DEXE_SUBGRAPH_POOLS_URL_97.
 *
 * The on-chain alternatives are listed default-visible ones FIRST, and the
 * gated ones carry `(needs DEXE_TOOLSETS=…)`. Three of the tools that append
 * this note (dao_list / dao_members / delegation_map) are in the default
 * profile, so an unqualified "read it on-chain with dexe_read_multicall" told a
 * zero-config session to call a tool it does not have.
 */
function chainNote(ctx: ToolContext, kind: SubgraphKind): string {
  const indexed = subgraphChains(ctx.config, kind);
  const where = indexed.length
    ? `chains with a ${kind} endpoint here: ${indexed.join(", ")}`
    : `NO chain has a ${kind} endpoint here`;
  return (
    ` Chain-explicit: pass \`chainId\` (${where}; default ${ctx.config.defaultChainId}); ` +
    `the response reports \`indexedChainId\` = the chain the rows came from. A chain with no endpoint ` +
    `returns an error naming ${subgraphEnvVar(kind)}_<chainId> plus the on-chain alternatives ` +
    `(dexe_proposal_list / dexe_read_settings / dexe_dao_info; also dexe_read_gov_state ` +
    `(needs DEXE_TOOLSETS=core,dev) and dexe_read_multicall (needs DEXE_TOOLSETS=core,read)) — ` +
    `it never answers from another chain.`
  );
}

// ---------- queries ----------

const DAO_LIST_QUERY = /* GraphQL */ `
  query getGovPoolsList($offset: Int!, $limit: Int!, $queryString: String!) {
    daoPools(
      skip: $offset
      first: $limit
      where: { name_contains_nocase: $queryString }
      orderBy: votersCount
      orderDirection: desc
    ) {
      id
      name
      erc20Token
      erc721Token
      votersCount
      proposalCount
      totalCurrentTokenDelegated
      totalCurrentTokenDelegatees
      creationTime
      creationBlock
    }
  }
`;

const DAO_MEMBERS_QUERY = /* GraphQL */ `
  query getVotersInPool($poolId: String!, $offset: Int!, $limit: Int!) {
    voterInPools(skip: $offset, first: $limit, where: { pool: $poolId }) {
      id
      APR
      currentDelegateesCount
      currentDelegatorsCount
      engagedProposalsCount
      joinedTimestamp
      receivedDelegation
      receivedNFTDelegation
      receivedTreasuryDelegation
      totalClaimedUSD
      totalLockedUSD
      totalPersonalVotingRewardUSD
      totalMicropoolVotingRewardUSD
      totalTreasuryVotingRewardUSD
      expertNft {
        id
        tokenId
      }
      voter {
        id
        totalProposalsCreated
        totalVotedProposals
        totalVotes
        currentVotesReceived
        currentVotesDelegated
        totalClaimedUSD
      }
    }
  }
`;

const DELEGATION_MAP_QUERY = /* GraphQL */ `
  query getDefaultDelegationsFromPool($offset: Int!, $limit: Int!, $delegatorIn: [String!]) {
    voterInPoolPairs(
      skip: $offset
      first: $limit
      where: { delegator_: { voter_in: $delegatorIn } }
    ) {
      id
      creationTimestamp
      delegatedAmount
      delegatedNfts
      delegatedUSD
      delegatedVotes
      delegatee {
        expertNft {
          id
        }
        voter {
          id
        }
        totalClaimedUSD
      }
      delegator {
        voter {
          id
        }
        pool {
          id
          erc20Token
        }
      }
    }
  }
`;

const DELEGATION_INCOMING_QUERY = /* GraphQL */ `
  query getPoolIncomingDelegations($offset: Int!, $limit: Int!, $voterIn: [String!]) {
    voterInPoolPairs(
      skip: $offset
      first: $limit
      where: { delegatee_: { voter_in: $voterIn } }
    ) {
      id
      delegatedAmount
      delegatedNfts
      delegatedUSD
      delegatedVotes
      delegator {
        voter {
          id
        }
      }
      delegatee {
        voter {
          id
        }
      }
    }
  }
`;

const VALIDATORS_QUERY = /* GraphQL */ `
  query getDaoPoolValidators($offset: Int!, $limit: Int!, $address: String!) {
    validatorInPools(
      skip: $offset
      first: $limit
      orderBy: balance
      orderDirection: desc
      where: { pool: $address }
    ) {
      id
      balance
      validatorAddress
    }
  }
`;

const USER_ACTIVITY_QUERY = /* GraphQL */ `
  query getUserTransactions($offset: Int!, $limit: Int!, $address: Bytes!) {
    transactions(
      skip: $offset
      first: $limit
      where: { user: $address }
      orderBy: timestamp
      orderDirection: desc
    ) {
      id
      type
      user
      timestamp
      interactionsCount
    }
  }
`;

const EXPERTS_QUERY = /* GraphQL */ `
  query getLocalExpertsByPool($offset: Int!, $limit: Int!, $daoAddress: Bytes!) {
    voterInPools(
      skip: $offset
      first: $limit
      where: { pool_: { id: $daoAddress }, expertNft_: { id_not: null } }
    ) {
      id
      receivedTreasuryDelegation
      receivedDelegation
      voter {
        id
      }
      expertNft {
        id
        tokenId
      }
      pool {
        id
      }
    }
  }
`;

// ---------- register ----------

export function registerSubgraphTools(server: McpServer, ctx: ToolContext): void {
  registerDaoList(server, ctx);
  registerDaoMembers(server, ctx);
  registerDelegationMap(server, ctx);
  registerValidatorList(server, ctx);
  registerUserActivity(server, ctx);
  registerDaoExperts(server, ctx);
  registerOtcListSalesForDao(server, ctx);
  registerGraphQuery(server, ctx);
  registerGraphSchema(server, ctx);
}

// ---------- dexe_graph_query ----------

/**
 * graph_query picks its subgraph per call, so it advertises coverage for all
 * three kinds rather than the single-kind note the other tools use.
 */
function graphQueryChainNote(ctx: ToolContext): string {
  const per = SUBGRAPH_KINDS.map(
    (k) => `${k}: ${subgraphChains(ctx.config, k).join("/") || "none"}`,
  ).join(", ");
  return (
    `Chain-explicit: pass \`chainId\` (endpoints here — ${per}; default ${ctx.config.defaultChainId}); ` +
    "the response reports `indexedChainId`. A chain with no endpoint for the chosen subgraph errors " +
    "(naming DEXE_SUBGRAPH_<KIND>_URL_<chainId>) instead of serving another chain's rows."
  );
}

/** Response cap — beyond this the caller should paginate, not stream megabytes into a conversation. */
const GRAPH_QUERY_MAX_RESPONSE_CHARS = 120_000;

/**
 * The operation keyword of every TOP-LEVEL definition in `doc`, in source
 * order. The `{ … }` shorthand reports as `query`.
 *
 * A scanner rather than a regex because the thing being guarded is a whole
 * document, not its first token. `fragment F on Proposal { … } query { …F }` is
 * ordinary GraphQL that the pre-0.31.0 first-token test rejected outright, and
 * a regex loose enough to admit it would also match the word `mutation`
 * wherever it appeared — as a field name, inside a string, in a comment.
 * Brace/paren/bracket depth is tracked so only genuine definition heads are
 * read: variable definitions, arguments and nested selection sets are skipped.
 */
export function topLevelDefinitions(doc: string): string[] {
  const out: string[] = [];
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  // True while the scanner is positioned where a definition head may start.
  let expectKeyword = true;
  const topLevel = () => brace === 0 && paren === 0 && bracket === 0;

  let i = 0;
  while (i < doc.length) {
    const c = doc[i]!;
    if (c === "#") {
      while (i < doc.length && doc[i] !== "\n") i++;
      continue;
    }
    if (doc.startsWith('"""', i)) {
      const end = doc.indexOf('"""', i + 3);
      i = end === -1 ? doc.length : end + 3;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < doc.length && doc[i] !== '"') i += doc[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "(") { paren++; i++; continue; }
    if (c === ")") { paren = Math.max(0, paren - 1); i++; continue; }
    if (c === "[") { bracket++; i++; continue; }
    if (c === "]") { bracket = Math.max(0, bracket - 1); i++; continue; }
    if (c === "{") {
      if (topLevel() && expectKeyword) {
        out.push("query"); // anonymous shorthand
        expectKeyword = false;
      }
      brace++;
      i++;
      continue;
    }
    if (c === "}") {
      brace = Math.max(0, brace - 1);
      // Only a brace that closes at the true top level ends a definition — a
      // `{…}` default value inside a variable definition does not.
      if (topLevel()) expectKeyword = true;
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < doc.length && /[A-Za-z0-9_]/.test(doc[j]!)) j++;
      if (topLevel() && expectKeyword) {
        out.push(doc.slice(i, j).toLowerCase());
        expectKeyword = false;
      }
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Read-only guard. The Graph gateway has no mutations, but rejecting the write
 * keywords here fails a bad document with a clear message instead of a gateway
 * error — and, since 0.31.0, WITHOUT rejecting fragment-first documents, which
 * are legal GraphQL an agent has every reason to send.
 */
export function graphQueryGuard(query: string): string | null {
  const defs = topLevelDefinitions(query);
  if (defs.length === 0) return "Empty query.";

  if (defs.some((d) => d === "mutation" || d === "subscription")) {
    return "Only read queries are supported (subgraphs have no mutations/subscriptions).";
  }
  const alien = defs.find((d) => d !== "query" && d !== "fragment");
  if (alien) {
    return `Query must start with 'query', '{' or 'fragment' — got '${alien}'. This is GraphQL, not SQL.`;
  }
  if (!defs.includes("query")) {
    return (
      "Document defines only fragment(s) and no operation — the gateway has nothing to execute. " +
      "Add a `query { … }` that spreads them."
    );
  }
  return null;
}

function registerGraphQuery(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_graph_query",
    {
      title: "Free-form GraphQL query against a DeXe subgraph",
      // This tool is in the DEFAULT profile as of 0.31.0, so every character
      // here is paid on every session's tools/list. The entity catalogue that
      // used to live in this string is one dexe_graph_schema call away and also
      // ships as dexe://graph-schema — what stays is only what a caller cannot
      // recover after the fact: the traps that make a query silently wrong.
      description:
        "Read-only GraphQL against a DeXe subgraph — 'pools' (DAOs, proposals, voters, delegations, experts, token sales), " +
        "'interactions' (per-user tx/event feed), 'validators' (validator chamber). " +
        "Bound every list with `first:` (max 1000), page with `skip:`; oversized responses are rejected. " +
        "NEVER guess a name: dexe_graph_schema returns the live root fields, an entity's fields, its `<Entity>_filter` " +
        "where-keys and `<Entity>_orderBy` values; static copy = dexe://graph-schema. " +
        "Root fields are NOT entity names (DaoPool → `daoPools`, ProposalSettings → `proposalSettings_collection`). " +
        "pools Proposal has NO `creationTime` — order by `votersVoted`/`quorumReachedTimestamp`/`executionTimestamp`, " +
        "or use DaoPool.creationTime. Example: subgraph='pools', query='{ proposals(first: 20, orderBy: votersVoted, " +
        "orderDirection: desc) { proposalId votersVoted pool { id name } } }'. " +
        graphQueryChainNote(ctx),
      inputSchema: {
        subgraph: z.enum(["pools", "interactions", "validators"]).describe("Which DeXe subgraph to query"),
        query: z.string().min(1).max(10_000).describe("GraphQL query document (read-only)"),
        variables: z.record(z.unknown()).optional().describe("GraphQL variables referenced by the query"),
        chainId: chainIdParam,
      },
    },
    async ({ subgraph, query, variables, chainId }) => {
      const guardError = graphQueryGuard(query);
      if (guardError) return errorResult(guardError);
      const sg = resolveEndpoint(ctx, subgraph, chainId);
      if (typeof sg === "string") return errorResult(sg);
      try {
        const data = await gqlRequest<Record<string, unknown>>(sg.url, query, variables as Record<string, unknown> | undefined);
        const json = JSON.stringify(data);
        if (json.length > GRAPH_QUERY_MAX_RESPONSE_CHARS) {
          return errorResult(
            `Response too large (${json.length} chars > ${GRAPH_QUERY_MAX_RESPONSE_CHARS}). ` +
              `Narrow the selection set or paginate with first/skip.`,
          );
        }
        // Row shape is whatever the caller selected, so the summary reports only
        // key + arity — both server-derived. Every string INSIDE the rows is
        // written by whoever deployed the DAO / created the proposal, so `data`
        // goes out deep-sanitized and announced.
        const topLevel = Object.entries(data)
          .map(([k, v]) => `${renderUntrusted(k, 60)}: ${Array.isArray(v) ? `${v.length} row(s)` : typeof v}`)
          .join(", ");
        return untrustedResult({
          summary: `graph_query(${subgraph}, chain ${sg.chainId}) → ${topLevel}`,
          label: `subgraph rows (${subgraph}, chain ${sg.chainId})`,
          structured: { subgraph, indexedChainId: sg.chainId, data },
        });
      } catch (err) {
        return errorResult(withSchemaRecoveryHint(toActionableError(err, "dexe_graph_query").message, subgraph));
      }
    },
  );
}

/**
 * Schema rejections are the one subgraph failure the caller can fix without a
 * human, and the one they most often "fix" by inventing a plausible field name
 * instead. Name the introspection call in the error itself so the recovery step
 * arrives with the failure rather than having to be remembered.
 */
export function withSchemaRecoveryHint(message: string, subgraph: string): string {
  // The Graph's wording for the whole family: unknown field, unknown type,
  // unknown argument, unknown enum value in `orderBy`.
  if (!/has no field|Unknown (field|type|argument|directive|enum)|Cannot query field|no field named/i.test(message)) {
    return message;
  }
  return (
    `${message}\n\n[recover] Do NOT guess the name. Call dexe_graph_schema { subgraph: "${subgraph}" } for the ` +
    `root query field map, or { subgraph: "${subgraph}", entity: "<Entity>" } for one type's fields ` +
    `("<Entity>_filter" for valid \`where:\` keys, "<Entity>_orderBy" for valid \`orderBy:\` values).`
  );
}

// ---------- dexe_graph_schema (introspection) ----------

/**
 * A GraphQL type reference as introspection returns it: a chain of LIST /
 * NON_NULL wrappers ending in a named type.
 */
export interface GraphTypeRef {
  kind: string;
  name: string | null;
  ofType?: GraphTypeRef | null;
}

export interface GraphFieldInfo {
  name: string;
  type: GraphTypeRef;
  args?: Array<{ name: string }>;
}

/** SDL spelling of a type reference — `[Proposal!]!`, `BigInt!`, `String`. */
export function typeRefLabel(ref: GraphTypeRef | null | undefined): string {
  if (!ref) return "?";
  if (ref.kind === "NON_NULL") return `${typeRefLabel(ref.ofType)}!`;
  if (ref.kind === "LIST") return `[${typeRefLabel(ref.ofType)}]`;
  return ref.name ?? "?";
}

/** The named type a reference ultimately points at, unwrapping LIST/NON_NULL. */
export function namedType(ref: GraphTypeRef | null | undefined): string | null {
  if (!ref) return null;
  return ref.name ?? namedType(ref.ofType);
}

/** True when any wrapper in the chain is a LIST — i.e. the collection field. */
function isListRef(ref: GraphTypeRef | null | undefined): boolean {
  if (!ref) return false;
  return ref.kind === "LIST" || isListRef(ref.ofType);
}

export interface RootFieldPair {
  entity: string;
  /** `daoPool(id: …)` — one row by id. Null if the schema has no singular. */
  single: string | null;
  /** `daoPools(where:, first:, skip:, orderBy:)`. Null if there is no list form. */
  list: string | null;
}

/**
 * Root Query fields grouped by the entity they return.
 *
 * This is the mapping an agent cannot guess and cannot derive: The Graph
 * pluralizes entity names with its own rules, and where the rule breaks it
 * appends `_collection` instead (`ProposalSettings` → `proposalSettings_collection`,
 * `DaoPoolMovedToValidators` → `daoPoolMovedToValidators_collection`) or lowercases
 * the whole thing (`DPContract` → `dpcontracts`). Documenting the ENTITY name,
 * as docs/GRAPH.md did before 0.31.0, leaves that gap wide open.
 *
 * Introspection meta fields (`_meta`, `_logs`) are dropped — they are schema
 * plumbing, not DeXe data.
 */
export function summarizeRootFields(fields: readonly GraphFieldInfo[]): RootFieldPair[] {
  const byEntity = new Map<string, RootFieldPair>();
  for (const f of fields) {
    const entity = namedType(f.type);
    if (!entity || entity.startsWith("_")) continue;
    const pair = byEntity.get(entity) ?? { entity, single: null, list: null };
    if (isListRef(f.type)) pair.list = f.name;
    else pair.single = f.name;
    byEntity.set(entity, pair);
  }
  return [...byEntity.values()].sort((a, b) => a.entity.localeCompare(b.entity));
}

/** Levenshtein distance, capped — only used to rank "did you mean" candidates. */
export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

/**
 * Candidate type names for a miss, best first. Ordered by how the miss actually
 * happens in practice: wrong case (`daoPool` for `DaoPool`), the root field name
 * instead of the entity (`daoPools`), then near-spellings.
 */
export function suggestEntities(wanted: string, known: readonly string[], max = 5): string[] {
  const w = wanted.toLowerCase().replace(/s$/, "");
  const scored = known
    .map((name) => {
      const n = name.toLowerCase();
      let score: number;
      if (n === wanted.toLowerCase()) score = 0;
      else if (n.replace(/s$/, "") === w) score = 1;
      else if (n.startsWith(w) || w.startsWith(n)) score = 2;
      else if (n.includes(w) || w.includes(n)) score = 3;
      else score = 4 + editDistance(n, wanted.toLowerCase());
      return { name, score };
    })
    .filter((s) => s.score <= 7)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.slice(0, max).map((s) => s.name);
}

/**
 * One round trip answers both questions: the root Query field map (always) and
 * the requested type (when asked). Fetching the root map even on the type path
 * is what makes a MISS self-service — the suggestion list and the "query it as
 * `daoPools`" line both come from it, with no second call on the error path.
 */
export const GRAPH_SCHEMA_QUERY = /* GraphQL */ `
  query DexeGraphSchema($name: String!, $withType: Boolean!) {
    __schema {
      queryType {
        fields {
          name
          type {
            ...TypeRef
          }
        }
      }
    }
    __type(name: $name) @include(if: $withType) {
      name
      kind
      fields {
        name
        type {
          ...TypeRef
        }
        args {
          name
        }
      }
      inputFields {
        name
        type {
          ...TypeRef
        }
      }
      enumValues {
        name
      }
    }
  }

  fragment TypeRef on __Type {
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

interface GraphSchemaPayload {
  __schema: { queryType: { fields: GraphFieldInfo[] } };
  __type?: {
    name: string;
    kind: string;
    fields: GraphFieldInfo[] | null;
    inputFields: GraphFieldInfo[] | null;
    enumValues: Array<{ name: string }> | null;
  } | null;
}

function registerGraphSchema(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_graph_schema",
    {
      title: "Introspect a DeXe subgraph schema (entities, fields, root query names)",
      description:
        "Live GraphQL introspection of a DeXe subgraph — the recovery path when dexe_graph_query returns " +
        "\"Type 'X' has no field 'Y'\" or you do not know what to type. NEVER guess a field name; call this instead. " +
        "Omit `entity` for the ROOT QUERY FIELD MAP: every entity plus the exact field name to query it by. " +
        "Those names are not derivable from the entity — DaoPool is `daoPools`, ProposalSettings is " +
        "`proposalSettings_collection`, DPContract is `dpcontracts`. " +
        "Pass `entity` (e.g. 'Proposal') for that type's fields with their GraphQL types; an unknown name returns " +
        "ranked 'did you mean' candidates rather than an error you cannot act on. " +
        "Filter and sort vocabularies are types too: ask for '<Entity>_filter' (every `where:` key, e.g. " +
        "`name_contains_nocase`, `timestamp_gt`) or '<Entity>_orderBy'. " +
        "Static entity reference (may lag the deployed schema): MCP resource dexe://graph-schema. " +
        graphQueryChainNote(ctx),
      inputSchema: {
        subgraph: z.enum(["pools", "interactions", "validators"]).describe("Which DeXe subgraph to introspect"),
        entity: z
          .string()
          .min(1)
          .max(120)
          .optional()
          .describe(
            "Type name to expand, e.g. 'Proposal', 'VoterInPool', 'DaoPool_filter', 'Proposal_orderBy'. Omit for the root query field map.",
          ),
        chainId: chainIdParam,
      },
    },
    async ({ subgraph, entity, chainId }) => {
      const sg = resolveEndpoint(ctx, subgraph, chainId);
      if (typeof sg === "string") return errorResult(sg);
      try {
        const data = await gqlRequest<GraphSchemaPayload>(sg.url, GRAPH_SCHEMA_QUERY, {
          name: entity ?? "",
          withType: entity !== undefined,
        });
        const rootFields = summarizeRootFields(data.__schema.queryType.fields);
        const where = `${subgraph}, chain ${sg.chainId}`;

        // Every name below is read off the wire. The endpoint is operator-
        // configured rather than permissionless, so this is a weaker channel
        // than a DAO name — but it is still remote text pasted into prose, and
        // the fence costs one line.
        if (!entity) {
          const lines = rootFields.map(
            (r) => `${r.entity}: query as ${r.list ?? "(no list field)"}${r.single ? ` / ${r.single}(id:)` : ""}`,
          );
          return untrustedResult({
            summary:
              `graph_schema(${where}) → ${rootFields.length} queryable entities. ` +
              `Expand one with dexe_graph_schema { subgraph: "${subgraph}", entity: "<Entity>" }; ` +
              `its where-keys live in "<Entity>_filter", its orderBy values in "<Entity>_orderBy".`,
            label: `entity names reported by the ${subgraph} endpoint`,
            body: lines.join("\n"),
            structured: { subgraph, indexedChainId: sg.chainId, rootFields },
            maxBodyChars: 12_000,
          });
        }

        const t = data.__type;
        if (!t) {
          const candidates = suggestEntities(entity, rootFields.map((r) => r.entity));
          return errorResult(
            `No type named '${renderUntrusted(entity, 120)}' in the ${subgraph} subgraph (chain ${sg.chainId}). ` +
              (candidates.length
                ? `Did you mean: ${candidates.map((c) => renderUntrusted(c, 120)).join(", ")}? `
                : "") +
              `Entity names are PascalCase — 'daoPools' is the root query FIELD, 'DaoPool' is the type. ` +
              `Call dexe_graph_schema { subgraph: "${subgraph}" } with no entity for the full map.`,
          );
        }

        // `fields` is populated for OBJECT/INTERFACE, `inputFields` for
        // INPUT_OBJECT (the `_filter` types), `enumValues` for `_orderBy`.
        const fields = (t.fields ?? t.inputFields ?? []).map((f) => ({
          name: f.name,
          type: typeRefLabel(f.type),
          ...(f.args?.length ? { args: f.args.map((a) => a.name) } : {}),
        }));
        const enumValues = t.enumValues?.map((e) => e.name) ?? [];
        const roots = rootFields.filter((r) => r.entity === t.name);

        const header = roots.length
          ? `Query it as ${roots.map((r) => [r.list, r.single].filter(Boolean).join(" / ")).join(", ")}.`
          : `Not a root query field — reachable only through a parent selection or as a where/orderBy vocabulary.`;
        const body = fields.length
          ? fields.map((f) => `  ${f.name}: ${f.type}`).join("\n")
          : enumValues.map((e) => `  ${e}`).join("\n");

        return untrustedResult({
          summary:
            `graph_schema(${where}) → ${renderUntrusted(t.name, 120)} (${renderUntrusted(t.kind, 40)}), ` +
            `${fields.length || enumValues.length} member(s). ${renderUntrusted(header, 400)}`,
          label: `field names reported by the ${subgraph} endpoint`,
          body,
          structured: {
            subgraph,
            indexedChainId: sg.chainId,
            entity: t.name,
            kind: t.kind,
            fields,
            enumValues,
            rootFields: roots,
          },
          maxBodyChars: 12_000,
        });
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_graph_schema").message);
      }
    },
  );
}

// ---------- tools ----------

function registerDaoList(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_read_dao_list",
    {
      title: "Discover and list DAOs (subgraph)",
      description:
        "Paginated DAO discovery via the pools subgraph. Search by name (case-insensitive), ordered by voter count descending." +
        chainNote(ctx, "pools"),
      inputSchema: {
        query: z.string().default("").describe("Name search (case-insensitive, empty = all)"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
        chainId: chainIdParam,
      },
    },
    async ({ query = "", offset = 0, limit = 20, chainId }) => {
      const sg = resolveEndpoint(ctx, "pools", chainId);
      if (typeof sg === "string") return errorResult(sg);
      try {
        const data = await gqlRequest<{ daoPools: unknown[] }>(sg.url, DAO_LIST_QUERY, {
          offset,
          limit,
          queryString: query,
        });
        const pools = data.daoPools;
        // `name` here is chosen by whoever deployed the DAO — deploying one is
        // permissionless, so this list is the cheapest injection channel in the
        // whole server at an agent that may be holding a signer.
        return untrustedResult({
          summary: `Found ${pools.length} DAO(s) on chain ${sg.chainId} (offset=${offset}, limit=${limit}, query="${renderUntrusted(query, 80)}")`,
          label: `DAO rows (names are attacker-chosen; chain ${sg.chainId})`,
          structured: { query, offset, limit, indexedChainId: sg.chainId, daoPools: pools },
        });
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_read_dao_list").message);
      }
    },
  );
}

function registerDaoMembers(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_read_dao_members",
    {
      title: "List DAO members with voting power (subgraph)",
      description:
        "Paginated member list for a DAO — includes voting power, delegation counts, rewards, expert status." +
        chainNote(ctx, "pools"),
      inputSchema: {
        govPool: z.string().describe("GovPool address (lowercased for subgraph)"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
        chainId: chainIdParam,
      },
    },
    async ({ govPool, offset = 0, limit = 20, chainId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      const sg = resolveEndpoint(ctx, "pools", chainId);
      if (typeof sg === "string") return errorResult(sg);
      try {
        const data = await gqlRequest<{ voterInPools: unknown[] }>(sg.url, DAO_MEMBERS_QUERY, {
          poolId: govPool.toLowerCase(),
          offset,
          limit,
        });
        const members = data.voterInPools;
        return untrustedResult({
          summary: `${members.length} member(s) in ${govPool} on chain ${sg.chainId} (offset=${offset}, limit=${limit})`,
          label: `member rows (chain ${sg.chainId})`,
          structured: { govPool, offset, limit, indexedChainId: sg.chainId, members },
        });
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_read_dao_members").message);
      }
    },
  );
}

/**
 * The delegation queries filter on `delegator_.voter_in` / `delegatee_.voter_in`,
 * which match VOTER WALLET addresses — NOT VoterInPool composite ids. A composite
 * id reaches the store's Bytes parser and fails with "Odd number of digits".
 * Accept both shapes and extract the wallet: 'govPool-voter' → part after the
 * dash; 80-hex 'voter+pool' (the real VoterInPool id) → first 40 hex chars.
 */
export function toVoterAddress(input: string): string {
  let s = input.trim().toLowerCase();
  const dash = s.lastIndexOf("-");
  if (dash >= 0) s = s.slice(dash + 1);
  const hex = s.startsWith("0x") ? s.slice(2) : s;
  return `0x${hex.length > 40 ? hex.slice(0, 40) : hex}`;
}

function registerDelegationMap(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_read_delegation_map",
    {
      title: "Delegation relationships — outgoing or incoming (subgraph)",
      description:
        "Query delegation pairs from the pools subgraph. Use direction='outgoing' to see who a user delegated to, or 'incoming' to see who delegated to them." +
        chainNote(ctx, "pools"),
      inputSchema: {
        addresses: z
          .array(z.string())
          .min(1)
          .describe(
            "Voter WALLET addresses (plain 0x…40-hex). Composite VoterInPool ids ('govPool-voter' or 80-hex 'voter+pool' concatenations) are also accepted — the voter part is extracted automatically.",
          ),
        direction: z.enum(["outgoing", "incoming"]).default("outgoing").describe("outgoing = who I delegated to; incoming = who delegated to me"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
        chainId: chainIdParam,
      },
    },
    async ({ addresses, direction = "outgoing", offset = 0, limit = 50, chainId }) => {
      // Pre-0.30.2 this only WARNED on a chain mismatch, because one env var
      // held one URL and there was nothing to switch to. Now the endpoint is
      // per chain, so the mismatch is resolved rather than narrated.
      const sg = resolveEndpoint(ctx, "pools", chainId);
      if (typeof sg === "string") return errorResult(sg);
      const lc = addresses.map(toVoterAddress);
      const bad = lc.filter((a) => !/^0x[0-9a-f]{40}$/.test(a));
      if (bad.length) {
        return errorResult(
          `Not a voter wallet address (expected 0x + 40 hex, or a 'govPool-voter' / 80-hex composite id): ${bad.join(", ")}`,
        );
      }
      try {
        const query = direction === "outgoing" ? DELEGATION_MAP_QUERY : DELEGATION_INCOMING_QUERY;
        const variables =
          direction === "outgoing"
            ? { offset, limit, delegatorIn: lc }
            : { offset, limit, voterIn: lc };
        const data = await gqlRequest<{ voterInPoolPairs: unknown[] }>(sg.url, query, variables);
        const pairs = data.voterInPoolPairs;
        return untrustedResult({
          summary: `${pairs.length} ${direction} delegation(s) for ${addresses.length} address(es) on chain ${sg.chainId}`,
          label: `delegation rows (chain ${sg.chainId})`,
          structured: {
            addresses,
            direction,
            offset,
            limit,
            indexedChainId: sg.chainId,
            delegations: pairs,
          },
        });
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_read_delegation_map").message);
      }
    },
  );
}

function registerValidatorList(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_read_validator_list",
    {
      title: "List validators in a DAO (subgraph)",
      description:
        "Paginated validator list ordered by balance descending." + chainNote(ctx, "validators"),
      inputSchema: {
        govPool: z.string().describe("GovPool address"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
        chainId: chainIdParam,
      },
    },
    async ({ govPool, offset = 0, limit = 50, chainId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      const sg = resolveEndpoint(ctx, "validators", chainId);
      if (typeof sg === "string") return errorResult(sg);
      try {
        const data = await gqlRequest<{ validatorInPools: unknown[] }>(sg.url, VALIDATORS_QUERY, {
          offset,
          limit,
          address: govPool.toLowerCase(),
        });
        const validators = data.validatorInPools;
        return untrustedResult({
          summary: `${validators.length} validator(s) in ${govPool} on chain ${sg.chainId} (offset=${offset}, limit=${limit})`,
          label: `validator rows (chain ${sg.chainId})`,
          structured: { govPool, offset, limit, indexedChainId: sg.chainId, validators },
        });
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_read_validator_list").message);
      }
    },
  );
}

function registerUserActivity(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_read_user_activity",
    {
      title: "User transaction history across DAOs (subgraph)",
      description:
        "Paginated transaction history for a user — proposals created, votes cast, delegations, claims. Ordered by timestamp descending." +
        chainNote(ctx, "interactions"),
      inputSchema: {
        user: z.string().describe("User wallet address"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
        chainId: chainIdParam,
      },
    },
    async ({ user, offset = 0, limit = 50, chainId }) => {
      if (!isAddress(user)) return errorResult(`Invalid user: ${user}`);
      const sg = resolveEndpoint(ctx, "interactions", chainId);
      if (typeof sg === "string") return errorResult(sg);
      try {
        const data = await gqlRequest<{ transactions: Array<Record<string, unknown>> }>(sg.url, USER_ACTIVITY_QUERY, {
          offset,
          limit,
          address: user.toLowerCase(),
        });
        const txs = data.transactions.map((tx) => ({
          ...tx,
          typeLabels: transactionTypeLabels(Array.isArray(tx.type) ? tx.type : [tx.type]),
        }));
        return untrustedResult({
          summary: `${txs.length} transaction(s) for ${user} on chain ${sg.chainId} (offset=${offset}, limit=${limit})`,
          label: `transaction rows (chain ${sg.chainId})`,
          structured: { user, offset, limit, indexedChainId: sg.chainId, transactions: txs },
        });
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_read_user_activity").message);
      }
    },
  );
}

function registerDaoExperts(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_read_dao_experts",
    {
      title: "List local experts in a DAO (subgraph)",
      description:
        "Paginated list of local experts (holders of DAO-specific expert NFTs) with their delegation info." +
        chainNote(ctx, "pools"),
      inputSchema: {
        govPool: z.string().describe("GovPool address"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
        chainId: chainIdParam,
      },
    },
    async ({ govPool, offset = 0, limit = 50, chainId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      const sg = resolveEndpoint(ctx, "pools", chainId);
      if (typeof sg === "string") return errorResult(sg);
      try {
        const data = await gqlRequest<{ voterInPools: unknown[] }>(sg.url, EXPERTS_QUERY, {
          offset,
          limit,
          daoAddress: govPool.toLowerCase(),
        });
        const experts = data.voterInPools;
        return untrustedResult({
          summary: `${experts.length} expert(s) in ${govPool} on chain ${sg.chainId} (offset=${offset}, limit=${limit})`,
          label: `expert rows (chain ${sg.chainId})`,
          structured: { govPool, offset, limit, indexedChainId: sg.chainId, experts },
        });
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_read_dao_experts").message);
      }
    },
  );
}

// ---------- OTC discovery ----------

// Nested TierView decode — single source of truth in src/tools/otc.ts
// (mirrors ITokenSaleProposal.TierView; the old flat shape decoded garbage).
const TOKEN_SALE_DISCOVERY_ABI = new Interface([
  "function latestTierId() view returns (uint256)",
  GET_TIER_VIEWS_FRAGMENT,
]);

const GOV_POOL_HELPERS_DISCOVERY_ABI = new Interface([
  // Some deployments expose the TokenSaleProposal address via a custom getter;
  // we don't rely on it. Caller passes the address directly when known. Keep
  // the placeholder ABI for forward-compat.
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
]);

function registerOtcListSalesForDao(server: McpServer, ctx: ToolContext): void {
  const rpc = new RpcProvider(ctx.config);

  server.registerTool(
    "dexe_otc_list_sales_for_dao",
    {
      title: "List OTC sale tiers for a DAO",
      description:
        "Reads `latestTierId()` then `getTierViews(0, latestTierId)` on the DAO's TokenSaleProposal helper. Returns tier list with `totalSold` and status (`upcoming` / `active` / `ended` / `off`) computed against current block timestamp and the tier's on-chain isOff flag. Pure on-chain read — no subgraph involved, so it works on any chain with an RPC. `chainId` selects the chain (defaults to the MCP's default chain) and the response echoes the resolved `chainId`. " +
        "When `tokenSaleProposal` is omitted the tool returns an error pointing at the helper-discovery follow-up; supply it explicitly until per-DAO helper discovery lands.",
      inputSchema: {
        govPool: z.string().describe("GovPool address"),
        tokenSaleProposal: z
          .string()
          .describe("TokenSaleProposal helper address. Look up via dexe_dao_predict_addresses or DAO deploy receipt."),
        chainId: chainIdParam,
      },
    },
    async ({ govPool, tokenSaleProposal, chainId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (!isAddress(tokenSaleProposal))
        return errorResult(`Invalid tokenSaleProposal: ${tokenSaleProposal}`);

      try {
        const pr = rpc.tryProvider(chainId);
        if ("error" in pr) return errorResult(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
        // Echoed on every return: this read is on-chain, so the answer belongs
        // to the chain the provider resolved to, not to any subgraph index.
        const readChainId = rpc.resolveChainId(chainId);

        // Validate the GovPool actually exists (helper read is the cheapest
        // smoke test — reverts cleanly on EOA/empty address).
        const [helpersR] = await multicall(provider, [
          {
            target: govPool,
            iface: GOV_POOL_HELPERS_DISCOVERY_ABI,
            method: "getHelperContracts",
            args: [],
            allowFailure: true,
          },
        ]);
        if (!helpersR?.success) {
          return errorResult(
            `${govPool} does not look like a GovPool (getHelperContracts reverted): ${helpersR?.error ?? "unknown"}`,
          );
        }

        // Read latestTierId, then page with offset=0 limit=latestTierId.
        const [latestR] = await multicall(provider, [
          {
            target: tokenSaleProposal,
            iface: TOKEN_SALE_DISCOVERY_ABI,
            method: "latestTierId",
            args: [],
            allowFailure: true,
          },
        ]);
        if (!latestR?.success) {
          return errorResult(
            `${tokenSaleProposal} does not look like a TokenSaleProposal (latestTierId reverted): ${latestR?.error ?? "unknown"}`,
          );
        }
        const latestTierId = Number(latestR.value as bigint);
        if (latestTierId === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${tokenSaleProposal}: zero tiers (latestTierId=0) on chain ${readChainId}. DAO has not opened a sale yet.`,
              },
            ],
            structuredContent: {
              govPool,
              tokenSaleProposal,
              chainId: readChainId,
              tiers: [],
            },
          };
        }

        const [tiersR] = await multicall(provider, [
          {
            target: tokenSaleProposal,
            iface: TOKEN_SALE_DISCOVERY_ABI,
            method: "getTierViews",
            args: [0n, BigInt(latestTierId)],
            allowFailure: true,
          },
        ]);
        if (!tiersR?.success) {
          return errorResult(`getTierViews(0, ${latestTierId}) reverted: ${tiersR?.error ?? "unknown"}`);
        }

        const block = await provider.getBlock("latest");
        const nowSec = BigInt(block?.timestamp ?? Math.floor(Date.now() / 1000));

        const rawTiers = tiersR.value as unknown as Array<{
          tierInitParams: {
            metadata: { name: string; description: string };
            totalTokenProvided: bigint;
            saleStartTime: bigint;
            saleEndTime: bigint;
            saleTokenAddress: string;
            purchaseTokenAddresses: string[];
          };
          tierInfo: { isOff: boolean; totalSold: bigint; uri: string };
        }>;

        const tiers = rawTiers.map((t, i) => {
          const tierId = String(i + 1);
          const p = t.tierInitParams;
          let status: "upcoming" | "active" | "ended" | "off";
          if (t.tierInfo.isOff) status = "off";
          else if (nowSec < p.saleStartTime) status = "upcoming";
          else if (nowSec <= p.saleEndTime) status = "active";
          else status = "ended";

          return {
            tierId,
            name: p.metadata.name,
            saleStartTime: p.saleStartTime.toString(),
            saleEndTime: p.saleEndTime.toString(),
            saleStartTimeUTC: unixToUtc(p.saleStartTime),
            saleEndTimeUTC: unixToUtc(p.saleEndTime),
            saleToken: p.saleTokenAddress,
            purchaseTokens: [...p.purchaseTokenAddresses],
            totalProvided: p.totalTokenProvided.toString(),
            totalSold: t.tierInfo.totalSold.toString() as string | null,
            status,
          };
        });

        const counts = {
          upcoming: tiers.filter((t) => t.status === "upcoming").length,
          active: tiers.filter((t) => t.status === "active").length,
          ended: tiers.filter((t) => t.status === "ended").length,
          off: tiers.filter((t) => t.status === "off").length,
        };

        // Tier `name` is on-chain metadata written by the DAO that opened the
        // sale — free text, same class as a DAO name.
        return untrustedResult({
          summary: `${tokenSaleProposal}: ${tiers.length} tier(s) on chain ${readChainId} — ${counts.active} active, ${counts.upcoming} upcoming, ${counts.ended} ended, ${counts.off} off (block ts ${nowSec}).`,
          label: `tier rows (names are DAO-authored; chain ${readChainId})`,
          structured: {
            govPool,
            tokenSaleProposal,
            chainId: readChainId,
            tiers,
            counts,
          },
        });
      } catch (e) {
        return errorResult(
          toActionableError(e, "dexe_otc_list_sales_for_dao").message,
        );
      }
    },
  );
}
