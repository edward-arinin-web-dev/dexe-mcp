# Profiles: how many tools you load, and what they tell your client

Three things decide what your MCP client sees from dexe-mcp:

1. **Which servers run** — since 1.0.0, `dexe-mcp` (this package) registers
   the **write** tools and the DeXe read server `dexe-mcp-read`
   (npm `@dexe-network/dexe-mcp`) serves the 54 **read** tools next to it. The
   Claude Code plugin starts both. `DEXE_WRITE_STANDALONE=1` makes `dexe-mcp`
   register the read tools too, for running it alone.
2. **`DEXE_TOOLSETS`** — which of the seven named sets `dexe-mcp` registers at
   startup. The read server has no profiles: it always loads its 54 tools.
3. **Tool annotations** — the machine-readable hints that tell the client which
   of those tools only read, and which sign and broadcast.

This page is the reference for all three. `docs/TOOLS.md` lists the tools
themselves; this one is about the shape of the surface.

## The seven sets, on both surfaces

The sets are defined once (`src/tools/gate.ts`); the write-only server narrows
each to the tools it has, so every set name — and every `DEXE_TOOLSETS` value
that worked before 1.0 — still works on it.

| Set | Write-only (default) | Standalone | What it is |
| --- | ---: | ---: | --- |
| `core` | 25 | 48 | The default. Composites, signing, WalletConnect, uploads, the write orientation trio (`dexe_write_context`, `dexe_write_guide`, `dexe_write_doctor`); standalone also orientation (`dexe_context`, `dexe_guide`, `dexe_doctor`, `dexe_get_config`) and the zero-config reporting reads. |
| `proposals` | 42 | 42 | Every single-purpose `dexe_proposal_build_*`, the off-chain/auth surface, the IPFS writes. |
| `read` | 1 | 36 | Standalone: the full analytics surface — per-DAO, per-user, per-sale reads. Write-only: `dexe_ipfs_cid_for_json` alone (the reads are the read server's). |
| `vote` | 28 | 30 | Delegation, staking, NFT multiplier, claims, validator votes (standalone also `dexe_vote_user_power` / `dexe_vote_get_votes`). |
| `agents` | 3 | 3 | Multi-agent wallet pool. |
| `governor` | 10 | 18 | External OpenZeppelin / Compound Bravo governors (write-only: the builders, dry-runs, hashing, decoding; standalone also the eight reads). |
| `dev` | 19 | 23 | Hardhat + ABI introspection against a local DeXe-Protocol checkout (standalone also the four decode / gov-state reads). |

`DEXE_TOOLSETS=full` is the union: **118 tools** write-only, **172 tools**
standalone. The sets overlap, so a combination is a union and not a sum.

Measured sizes (real `McpServer` + `InMemoryTransport` `tools/list`, 1.0.0,
tools only). The standalone server also lists the two **deprecated aliases** of
the token-sale reads renamed in 0.36.0 (`dexe_otc_buyer_status`,
`dexe_otc_list_sales_for_dao` — see [MIGRATION.md](./MIGRATION.md)): **+2
`tools/list` entries and ~2.3 KB** on top of each standalone row, until the
aliases are removed in a future major. The write-only server lists no alias —
their targets are read tools.

| `DEXE_TOOLSETS` | Write-only tools | bytes | Standalone tools | bytes |
| --- | ---: | ---: | ---: | ---: |
| *(unset — `core`)* | 25 | 54,876 (~54 KB) | 48 | 95,077 (~93 KB) |
| `core,agents` | 28 | 58,972 | 51 | 99,173 |
| `core,read` | 26 | 55,784 | 67 | 121,762 |
| `core,vote` | 48 | 96,607 | 72 | 138,432 |
| `core,proposals` | 64 | 146,128 | 87 | 186,189 (~182 KB) |
| `core,read,vote` | 49 | 97,515 | 91 | 165,117 |
| `core,proposals,read,vote` | 88 | 188,767 | 130 | 256,229 |
| `core,proposals,read,vote,agents` | 89 | 190,093 | 131 | 257,555 |
| `core,proposals,read,vote,agents,governor` | 99 | 201,168 | 149 | 275,466 |
| `full` | 118 | 233,813 (~228 KB) | 172 | 314,394 (~307 KB) |

The read server adds its own 54 tools beside a write-only server, whatever
`DEXE_TOOLSETS` says.

The standalone default profile is held under a hard 96,000-byte ceiling by
`tests/tools/gate.test.ts`. That is a budget, not a debt line: anything that
pushes past it should demote something rather than raise the number. 0.34.0
raised it once, from 95,000, for the ~2.5 KB that MCP tool annotations
(`readOnlyHint` and friends) and the 21 previously missing titles cost —
bytes the spec asks for, not description bloat. The description-style pass then
won the headroom back, which is why the default measured 86,742 B against a
96,000 B line at 0.34.0; it was 95,284 B at 0.36.0, which added
`dexe_write_context` to `core` and spells all four MCP hints on every read
tool, 95,987 B at 0.37.0, which added the read-only
`dexe_tx_approval_status` (the keystore-mode follow-up to `dexe_tx_send`), and
is 95,077 B at 1.0.0 — `dexe_write_guide` and `dexe_write_doctor` joined `core`,
and the read package's SDK v2 schemas dropped the root `$schema` key. The two
deprecated aliases are budgeted separately (under 3,000 B) so they cannot
crowd out tools. Every tool that was in `core` in 0.33 is still in `core` —
on the write-only server, every write tool that was.

## If your client caps enabled tools per request

**VS Code / GitHub Copilot Chat rejects a chat request carrying more than
128 enabled tools per request** — counting its own built-ins and every other
MCP server you have connected, not just this one. Claude Code and Claude
Desktop have no such cap.

With the default two servers, the count is the write server's profile **plus
the read server's 54**:

- **`core`** (25 + 54 = 79 — the default) — create a DAO,
  create/vote/execute proposals, run an OTC sale, query the subgraph, pull a
  DAO report. This is the whole product for most sessions; there is no reason
  to escalate until a tool is actually missing.
- **`core,vote`** (48 + 54 = 102) — adds delegation, staking, claims and the
  validator votes.
- **`core,proposals`** (64 + 54 = 118) — adds every single-purpose proposal
  builder plus the off-chain voting and IPFS-write tools. Use it when you want
  the raw unsigned calldata instead of the `dexe_proposal_create` composite.

`core,proposals,vote` and anything larger, and `full` (118 + 54 = 172), are
over the cap together with the read server. Use them on Claude Code / Claude
Desktop only.

Standalone (`DEXE_WRITE_STANDALONE=1`, no read server), the counts are the
standalone column above, plus the two aliases: `core` (48, 50 listed),
`core,read` (67, 69), `core,proposals` (87, 89), `core,read,vote` (91, 93) fit;
`core,proposals,read,vote` (130, **132 listed**), `full` (172, 174 listed) and
`core,proposals,read,vote,agents,governor` (149) do not.

dexe-mcp prints a note on stderr at startup whenever its own listed count —
tools plus, standalone, the two deprecated aliases — exceeds that cap, so the
mistake is visible in the server log rather than only as an opaque client-side
error. It cannot see the read server's tools: add 54 yourself.

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
