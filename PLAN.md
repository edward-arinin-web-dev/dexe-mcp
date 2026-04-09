# Plan: `dexe-mcp` — MCP Server for DeXe Protocol Dev Tooling

## Context

DeXe Protocol (`D:\dev\DeXe-Protocol`) is a governance DAO protocol: 129 Solidity contracts (OpenZeppelin v4.9.2, Solidity 0.8.20, Hardhat 2.20.1), organized around `GovPool`, `GovSettings`, `GovUserKeeper`, `GovValidators`, proposal contracts (`DistributionProposal`, `StakingProposal`, `TokenSaleProposal`), voting-power libs (`LinearPower`, `PolynomialPower`), and a `ContractsRegistry` service locator.

Day-to-day dev work on this repo currently means jumping between `npm run compile`, `hardhat test --grep`, reading TypeChain output, and hand-decoding proposal calldata against ABIs. We want an MCP server Claude Code can drive directly so an agent can compile, introspect contracts, and answer governance-domain questions (decode a proposal, read on-chain gov state, simulate a vote on a fork) without the human babysitting each shell command.

**Decisions already made (from user):**
- TypeScript / Node, `@modelcontextprotocol/sdk` v1.x, stdio transport
- Separate repo (`dexe-mcp`) — not nested inside DeXe-Protocol
- Scope: **build/test**, **contract introspection**, **governance domain**. Explicitly **out of scope**: deployment/migration tooling
- Consumer: Claude Code (stdio)

The server points at a DeXe-Protocol checkout via `DEXE_PROTOCOL_PATH`; it reads Hardhat artifacts off disk and shells out to `npm run <script>` in that directory. On-chain / fork interactions go through an injected RPC URL.

## Repository Layout

```
dexe-mcp/
├── package.json              # "bin": { "dexe-mcp": "dist/index.js" }
├── tsconfig.json
├── README.md                 # how to wire into Claude Code .mcp.json
├── .mcp.example.json         # copy-paste snippet for users
├── src/
│   ├── index.ts              # McpServer + StdioServerTransport entrypoint
│   ├── config.ts             # env: DEXE_PROTOCOL_PATH, RPC_URL, FORK_BLOCK
│   ├── artifacts.ts          # load hardhat artifacts + build-info + storage layout
│   ├── hardhat.ts            # spawn `npm run …` in DEXE_PROTOCOL_PATH, stream + cap output
│   ├── rpc.ts                # ethers v6 Provider factory
│   ├── fork.ts               # on-demand `hardhat node --fork` child process mgmt
│   ├── lib/
│   │   ├── selectors.ts      # 4byte index built from all compiled ABIs
│   │   ├── decoders.ts       # proposal-executor decoders (Distribution/Staking/TokenSale)
│   │   └── govAddresses.ts   # resolve GovPool ecosystem via ContractsRegistry
│   └── tools/
│       ├── index.ts          # registerAll(server)
│       ├── build.ts          # compile / test / coverage / lint
│       ├── introspect.ts     # abi / selectors / storage / natspec / source
│       └── gov.ts            # decode_calldata / decode_proposal / read_gov_state / simulate_vote
└── test/
    └── tools.test.ts         # vitest; uses a tiny fixture hardhat project
```

## Dependencies

- `@modelcontextprotocol/sdk` (v1.x) — `McpServer`, `StdioServerTransport`, `registerTool`
- `zod` — input/output schemas (Standard Schema, per current MCP SDK docs)
- `ethers` v6 — ABI parsing, `Interface.parseTransaction`, providers, impersonation
- `execa` — child_process wrapper for hardhat shell-outs (timeout + stdout capping)
- `p-limit` — guard concurrent hardhat invocations
- Dev: `typescript`, `tsx`, `vitest`, `@types/node`

## Tool Catalog

All tools use `registerTool(name, {title, description, inputSchema, outputSchema}, handler)` with Zod schemas and return both `content` (text) and `structuredContent` (machine-readable).

### Build / test (wraps `npm run …` in `DEXE_PROTOCOL_PATH`)

| Tool | Input | Behavior |
|---|---|---|
| `dexe_compile` | `{ force?: boolean }` | Runs `npm run compile`. Parses solc errors/warnings; returns counts + first N diagnostics with file/line. |
| `dexe_test` | `{ grep?: string, file?: string, bail?: boolean }` | Runs `npx hardhat test` (with `--grep` / file arg). Parses mocha output; returns pass/fail counts and up to 20 failures with stack traces. |
| `dexe_coverage` | `{ grep?: string }` | Runs `npm run coverage`. Returns per-contract line/branch % summary parsed from `coverage/coverage-summary.json`. |
| `dexe_lint` | `{ fix?: boolean }` | Runs `npm run lint-fix` (or dry-run). Returns changed-file list. |

All build/test tools cap stdout at ~200 lines and write full logs to a tmp file, surfacing the path in `structuredContent.logFile`.

### Contract introspection (reads artifacts, no network)

`artifacts.ts` loads `${DEXE_PROTOCOL_PATH}/artifacts/contracts/**/*.json` and the matching `build-info/*.json` for storage layout + metadata.

| Tool | Input | Behavior |
|---|---|---|
| `dexe_list_contracts` | `{ filter?: string, kind?: "contract"\|"interface"\|"library" }` | Enumerates compiled contracts, returning `{name, path, kind}`. |
| `dexe_get_abi` | `{ contract: string }` | Returns ABI JSON for named contract. |
| `dexe_get_selectors` | `{ contract: string }` | Returns list of `{signature, selector, type: "function"\|"event"\|"error"}` using `ethers.Interface.getFunction().selector`. |
| `dexe_find_selector` | `{ selector: "0xXXXXXXXX" }` | Reverse-lookup against the prebuilt index in `lib/selectors.ts`; returns all matching signatures + contracts. |
| `dexe_get_storage_layout` | `{ contract: string }` | Extracts storage layout from build-info `output.contracts[file][name].storageLayout`. |
| `dexe_get_natspec` | `{ contract: string, member?: string }` | Returns `devdoc`/`userdoc` from artifact metadata, optionally scoped to one function. |
| `dexe_get_source` | `{ contract: string, symbol?: string }` | Returns source path; if `symbol`, returns a slice around its definition using AST from build-info. |

### Governance domain (the reason this MCP exists)

| Tool | Input | Behavior |
|---|---|---|
| `dexe_decode_calldata` | `{ data: "0x...", contract?: string }` | Tries to decode calldata. Without `contract`, iterates all loaded ABIs by selector match. Returns decoded function + args (recursively decoding nested proposal executor calldata for `GovPool.createProposal` / `execute`). |
| `dexe_decode_proposal` | `{ govPool: address, proposalId: number }` | Calls `GovPool.getProposals` via RPC, decodes every action's `data` against the matching executor (`DistributionProposal`, `TokenSaleProposal`, `StakingProposal`, or generic) using `lib/decoders.ts`. |
| `dexe_read_gov_state` | `{ govPool: address, fields?: string[] }` | Aggregate read: `GovSettings` params, `GovUserKeeper` totals, `GovValidators` set, active proposal count. Resolved via `ContractsRegistry` (`lib/govAddresses.ts`). |
| `dexe_simulate_vote` | `{ govPool: address, proposalId: number, voter: address, voteAmount: string, support: boolean }` | Starts/reuses a `hardhat node --fork $RPC_URL` child (managed by `fork.ts`), impersonates `voter`, calls `GovPool.vote`, returns the new proposal state + gas used. Fork is torn down on server shutdown. |
| `dexe_list_gov_contract_types` | `{}` | Static catalog: names, roles, ABI pointers for the governance subsystem. Cheap orientation tool for agents new to the repo. |

## Key Implementation Notes

- **Single source of truth for artifacts.** `artifacts.ts` memoizes a `Map<contractName, {abi, bytecode, buildInfoPath}>` built once per `DEXE_PROTOCOL_PATH` mtime. Invalidated after `dexe_compile` completes.
- **Selector index.** Built lazily on first introspection call by walking the artifact map and calling `new ethers.Interface(abi)` on each. Stored as `Map<selector, Array<{contract, signature}>>` — supports collisions.
- **Proposal decoding is the crown jewel.** `lib/decoders.ts` must handle `GovPool`'s `ProposalAction[]` shape (`executor`, `value`, `data`), dispatching by `executor` address class to the proposal-specific ABIs. Fall back to generic ABI decode when executor is unknown. Unit-test this against real calldata captured from mainnet proposals.
- **Fork lifecycle.** `fork.ts` owns at most one `hardhat node` child process. Tools that need fork state (`simulate_vote`) start it lazily; `server.onclose` kills it. No persistent state between tool calls beyond the running fork.
- **Shell-out safety.** All child_process calls use `execa` with `cwd: DEXE_PROTOCOL_PATH`, fixed arg arrays (no shell interpolation), 10-minute timeout, and `maxBuffer` protection.
- **Config.** `config.ts` reads `DEXE_PROTOCOL_PATH` (required), `DEXE_RPC_URL` (optional; needed for gov state / simulate), `DEXE_FORK_BLOCK` (optional). Fails fast on startup with a clear error if `DEXE_PROTOCOL_PATH` is missing or not a Hardhat project (no `hardhat.config.js`).
- **Logging.** Per MCP convention, **all logs to stderr** (stdout is the protocol channel). Use `console.error` or a thin `pino` stderr stream.

## Verification

1. **Unit tests** (`vitest`): each tool handler tested against a tiny fixture Hardhat project committed under `test/fixtures/`. Covers ABI loading, selector index, calldata decoding (including nested proposal executors), stdout parsing for compile/test.
2. **Smoke against the real repo.** With `DEXE_PROTOCOL_PATH=D:\dev\DeXe-Protocol` set, run the server under the official MCP Inspector: `npx @modelcontextprotocol/inspector node dist/index.js`. Manually exercise:
   - `dexe_compile` → expect clean build
   - `dexe_test { grep: "GovPool" }` → expect real pass/fail summary
   - `dexe_list_contracts { filter: "Gov" }` → expect `GovPool`, `GovSettings`, etc.
   - `dexe_get_abi { contract: "GovPool" }`
   - `dexe_find_selector { selector: "<known GovPool selector>" }`
   - `dexe_decode_calldata` against a captured real-world proposal createProposal calldata
3. **End-to-end in Claude Code.** Add to `.mcp.json`:
   ```json
   {
     "mcpServers": {
       "dexe": {
         "command": "node",
         "args": ["D:/dev/dexe-mcp/dist/index.js"],
         "env": { "DEXE_PROTOCOL_PATH": "D:/dev/DeXe-Protocol" }
       }
     }
   }
   ```
   Restart Claude Code, confirm tools appear, ask it "compile the protocol and summarize any warnings" and "decode proposal 42 on GovPool 0x…".
4. **Fork simulation test** (optional, needs RPC): set `DEXE_RPC_URL` to an Ethereum archive node, run `dexe_simulate_vote` against a real active proposal, verify no orphaned `hardhat node` processes after server shutdown.

## Out of Scope (explicit, per user)

- Deployment / migration tooling (`hardhat-migrate` wrappers, network configs under `deploy/config/configs/`, verification) — deliberately excluded.
- TypeChain codegen orchestration, Go bindings, markup doc generation.
- Remote / HTTP transport, auth, multi-tenant hosting.
