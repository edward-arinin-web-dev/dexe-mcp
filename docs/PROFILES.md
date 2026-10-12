# Profiles: how many tools you load, and what they tell your client

Two things decide what your MCP client sees from dexe-mcp:

1. **`DEXE_TOOLSETS`** — which of the seven named sets register at startup.
2. **Tool annotations** — the machine-readable hints that tell the client which
   of those tools only read, and which sign and broadcast.

This page is the reference for both. `docs/TOOLS.md` lists the tools
themselves; this one is about the shape of the surface.

## The seven sets

| Set | Tools | What it is |
| --- | ---: | --- |
| `core` | 45 | The default. Composites, orientation, the zero-config reporting reads. |
| `proposals` | 42 | Every single-purpose `dexe_proposal_build_*`, the off-chain/auth surface, the IPFS writes. |
| `read` | 36 | The full analytics surface — per-DAO, per-user, per-sale reads. |
| `vote` | 30 | Delegation, staking, NFT multiplier, claims, validator votes. |
| `agents` | 3 | Multi-agent wallet pool. |
| `governor` | 18 | External OpenZeppelin / Compound Bravo governors. |
| `dev` | 23 | Hardhat + ABI introspection against a local DeXe-Protocol checkout. |

`DEXE_TOOLSETS=full` is the union: **169 tools**. The sets overlap, so a
combination is a union and not a sum.

Measured sizes (real `McpServer` + `InMemoryTransport` `tools/list`, 0.36.0).
The numbers are for the tools. Every profile listed here also carries the two
**deprecated aliases** of the token-sale reads renamed in 0.36.0
(`dexe_otc_buyer_status`, `dexe_otc_list_sales_for_dao` — see
[MIGRATION.md](./MIGRATION.md)): **+2 `tools/list` entries and +2,448 bytes**
on top of each row, until the aliases are removed in a future major.

| `DEXE_TOOLSETS` | Tools | `tools/list` bytes |
| --- | ---: | ---: |
| *(unset — `core`)* | 45 | 95,284 (~93 KB) |
| `core,agents` | 48 | 99,536 |
| `core,read` | 64 | 123,425 |
| `core,vote` | 69 | 140,917 |
| `core,proposals` | 84 | 190,398 (~186 KB) |
| `core,read,vote` | 88 | 169,058 |
| `core,proposals,read,vote` | 127 | 264,172 |
| `core,proposals,read,vote,agents` | 128 | 265,550 |
| `core,proposals,read,vote,agents,governor` | 146 | 284,397 |
| `full` | 169 | 325,635 (~318 KB) |

The default profile is held under a hard 96,000-byte ceiling by
`tests/tools/gate.test.ts`. That is a budget, not a debt line: anything that
pushes past it should demote something rather than raise the number. 0.34.0
raised it once, from 95,000, for the ~2.5 KB that MCP tool annotations
(`readOnlyHint` and friends) and the 21 previously missing titles cost —
bytes the spec asks for, not description bloat. The description-style pass then
won the headroom back, which is why the default measured 86,742 B against a
96,000 B line at 0.34.0; it is 95,284 B at 0.36.0, which added
`dexe_write_context` to `core` and spells all four MCP hints on every read
tool. The two deprecated aliases are budgeted separately (under 3,000 B) so
they cannot crowd out tools. Every tool that was in `core` in 0.33 is still in `core`.

## If your client caps enabled tools per request

**VS Code / GitHub Copilot Chat rejects a chat request carrying more than
128 enabled tools per request** — counting its own built-ins and every other
MCP server you have connected, not just this one. `full` (169) is over that on its own, so a
Copilot user who follows an escalation hint to `full` breaks every request
instead of gaining tools. Claude Code and Claude Desktop have no such cap.

dexe-mcp prints a note on stderr at startup whenever the listed count — tools
plus the two deprecated aliases — exceeds that cap, so the mistake is visible
in the server log rather than only as an opaque client-side error.

Recommended combinations when your client has the cap — pick the smallest one
that covers what you are doing. The counts in brackets are what `tools/list`
carries, aliases included:

- **`core`** (45 tools, 47 listed — the default) — create a DAO,
  create/vote/execute proposals, run an OTC sale, query the subgraph, pull a
  DAO report. This is the whole product for most sessions; there is no reason
  to escalate until a tool is actually missing.
- **`core,read`** (64, 66 listed) — adds the full analytics surface:
  validators, experts, staking, distributions, per-user activity, token-sale
  tiers.
- **`core,proposals`** (84, 86 listed) — adds every single-purpose proposal
  builder plus the off-chain voting and IPFS-write tools. Use it when you want
  the raw unsigned calldata instead of the `dexe_proposal_create` composite.
- **`core,read,vote`** (88, 90 listed) — the largest "do everything on DeXe"
  profile with ~38 entries of headroom left for the host's own built-ins and
  other servers.

`core,proposals,read,vote` (127 tools, **129 listed** since the 0.36.0
aliases), `full` (169) and `core,proposals,read,vote,agents,governor` (146) are
over the cap. Use them on Claude Code / Claude Desktop only.

No profile is ever removed or renamed: any `DEXE_TOOLSETS` value that worked
before still works. Restart the client after editing `.env` —
`process.loadEnvFile()` runs once at startup.

## Annotations: what each tool tells your client

Every registered tool declares MCP `annotations`. This matters because the
spec's defaults are pessimistic: with no annotations, `readOnlyHint` defaults
to false, `destructiveHint` to true and `openWorldHint` to true — so a
conformant client has to treat `dexe_read_treasury` as exactly as dangerous as
`dexe_tx_send`, and may prompt for confirmation on every read.

Classification lives in one table per edition — the read tools in
`src/tools/annotations.ts`, the write tools in `src/tools/annotationsWrite.ts`
(which also merges both for the single server) — and is applied by a single
wrapper at registration. It is **exhaustive**: a tool that is not
classified ships with no annotations at all (so the conservative spec default
still applies) and fails `tests/tools/annotations.test.ts` by name.

The 54 tools of the read edition (`READ_TOOLS` in `src/editions.ts`) spell all
four hints as explicit booleans — `readOnlyHint: true`,
`destructiveHint: false`, `idempotentHint: true`, and `openWorldHint` (true for
public chain / subgraph / backend / IPFS data, false for the five that compute
locally) — because connector directories review them that way. Every other
read emits only the spec-meaningful field: `destructiveHint` and
`idempotentHint` are defined as meaningful only when `readOnlyHint` is false,
so a builder carries one key and not four (`tools/list` bytes are budgeted).

The five classes:

- **Read** — `readOnlyHint: true`. Reads chain, subgraph, backend or IPFS and
  returns. Every `dexe_read_*`, every `dexe_gov_get_*`, the simulators, and
  every `*_build_*` calldata builder: a builder returns an unsigned payload and
  never sends it, though several do read the chain while building.
- **Local read** — `readOnlyHint: true, openWorldHint: false`. Pure compute
  over local artifacts, the bundled knowledge corpus, or the arguments:
  `dexe_guide`, `dexe_proposal_catalog`, `dexe_get_config`, the ABI
  introspection tools, the decoders, the hashers, `dexe_merkle_build` /
  `_proof`, `dexe_ipfs_cid_for_json` / `_cid_info`, and the two auth request
  builders. **`dexe_graph_schema` is not here** — it runs live introspection
  against the subgraph over the network, so it is a plain **Read**
  (`openWorldHint` stays true). It ships in `core` because it is the documented
  recovery path for a bad field name in `dexe_graph_query`.
- **Broadcast** — `readOnlyHint: false, destructiveHint: true`. Signs and
  sends, or queues a transaction other people execute. Exactly nine:
  `dexe_tx_send`, `dexe_dao_create`, `dexe_proposal_create`,
  `dexe_proposal_vote_and_execute`, `dexe_otc_dao_open_sale`,
  `dexe_otc_buyer_buy`, `dexe_otc_buyer_claim_all`, `dexe_agents_fund`, and
  `dexe_safe_propose_tx` — the last one signs the `safeTxHash` and posts a
  multisig transaction the owners then execute, which is `dexe_tx_send` with a
  delay rather than a session operation.
- **Remote write** — `readOnlyHint: false, destructiveHint: false`. Mutates
  something outside this machine but destroys nothing: the five IPFS pins,
  `dexe_dao_generate_avatar`, `dexe_auth_login`, and the WalletConnect
  session pair. An IPFS pin is content-addressed, so re-running it converges
  instead of clobbering — a destructive prompt there is the same overstatement
  as prompting on a read.
- **Local exec** — `readOnlyHint: false, destructiveHint: false,
  openWorldHint: false`. Runs hardhat under `DEXE_PROTOCOL_PATH` and writes
  artifacts: `dexe_compile`, `dexe_test`, `dexe_coverage`, `dexe_lint`.

Annotations are **hints, not access control**. The real broadcast guards are
the env-level ones in `docs/SECURITY.md`, plus each composite's own
`dryRun` / `confirm` preview. Nothing here decides whether a transaction is
allowed; it decides what your client is able to tell you before you approve one.

Every tool also publishes a `title` — the short human-readable label a client
shows in its approval dialog. Twenty-one tools (including every flagship
composite) had none until 0.34.0 because they predate the `registerTool` API;
they now get one from the same central map, so no approval dialog shows a raw
`dexe_snake_case` name.
