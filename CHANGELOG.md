# Changelog

## Unreleased

### Supply-chain hardening

- **npm provenance enabled.** New `.github/workflows/release.yml` triggered by `v*.*.*` tag push: runs typecheck + build + tests, verifies tag matches `package.json` version, then `npm publish --provenance --access public`. OIDC-signed attestation links every future tarball to the exact git commit and workflow run. Visible as a "Provenance" badge on npmjs.com. `publishConfig.provenance: true` is now baked into `package.json` so even manual `npm publish` (in an OIDC-enabled env) attaches an attestation. Requires repo secret `NPM_TOKEN`. Closes security-hardening roadmap A1.
- **OSSF Scorecard analysis.** New `.github/workflows/scorecard.yml` runs weekly (Sundays 04:00 UTC) and on push to `main`. Audits branch protection, token permissions, dependency hygiene, signed releases, and 15+ other checks. Publishes SARIF to GitHub code-scanning and a public score via OIDC to `api.securityscorecards.dev`. Badge usable at `https://api.securityscorecards.dev/projects/github.com/edward-arinin-web-dev/dexe-mcp/badge`.
- **Dependency Review on PRs.** New `.github/workflows/dependency-review.yml` runs on every PR touching deps. Fails the check on `high`-or-`critical` CVEs from GitHub Advisory Database, denies copyleft licenses (GPL/AGPL), and posts a PR comment when issues found. Blocks unsafe dep updates before merge.
- **`ci.yml` least-privilege.** Tightened top-level + job `permissions: contents: read` per Scorecard Token-Permissions check. Added `npm test` to PR/main pipeline (previously typecheck+build only). Closes security-hardening roadmap A4.
- **CodeQL static analysis.** New `.github/workflows/codeql.yml` runs the `security-extended` query suite against the `javascript-typescript` source on every PR/main push and weekly (Sundays 05:00 UTC). Catches prototype pollution, command injection, ReDoS, unsafe deserialization, path traversal, and other CWE patterns. Findings upload to GitHub code-scanning. Closes security-hardening roadmap A5.
- **CVE sweep after Dependabot activation.** Three new moderate CVEs surfaced when Dependency Graph was enabled on the repo. Resolved in this PR:
  - `esbuild >=0.25.0` added to `overrides` (GHSA-67mh-4wv8-2f99 — dev server SSRF; transitive through vite/vitest/tsx).
  - `ws >=8.20.1` added to `overrides` (GHSA-58qx-3vcg-4xpx — uninitialized memory disclosure; transitive through ethers).
  - `vitest` bumped from `^2.1.0` to `^3.0.0` in devDependencies — pulls in vite ≥6.4.2 which patches the path-traversal CVE (GHSA-4w7w-66w2-5vf9).
  - `npm audit` now reports **0 vulnerabilities** (both prod and dev).
- **`npm test` no-test-files tolerance.** Added `--passWithNoTests` to the `test` script so the CI/release pipeline doesn't fail on branches that don't yet have tests under their tree (e.g. this one — tests live on `governor-adapter`).
- **Lockfile integrity job.** New `verify-lockfile` job in `ci.yml` installs strictly from the committed `package-lock.json` via `npm ci` (which aborts if `package.json` and the lockfile are out of sync and never rewrites the lockfile), asserts the lockfile was not mutated (`git diff --exit-code package-lock.json`), and validates the full resolved tree with `npm ls --all`. Any drift — stale lockfile, hand-edit, or inconsistent override/peer resolution — fails the build before merge. Closes security-hardening roadmap A3.
- **Signed-tag enforcement on release.** `release.yml` now imports the maintainer's public key (repo secret `MAINTAINER_GPG_PUBLIC_KEY`) and runs `git verify-tag "$GITHUB_REF_NAME"` **before** the publish step. An unsigned tag, an invalid signature, or a tag from an unknown key aborts the release, so nothing reaches npm without a valid maintainer signature. Checkout switched to `fetch-depth: 0` + `fetch-tags: true` so the annotated tag object and its signature are available. Documented `git verify-tag` / `git tag -v` for consumers in `SECURITY.md` and `README.md`. Closes security-hardening roadmap A2. (GPG key generation is a separate maintainer step.)

## 0.5.8

DAO avatar pipeline — root-cause fix + three new composites.

### Avatar bug fixes (frontend rendering)

- **`dexe_ipfs_upload_file` now returns a CID v1 base32 string** (`bafy…`) as the primary `cid` field, with the original Pinata response preserved as `cidV0`. The DeXe frontend stores avatar URLs as `https://<cid>.ipfs.4everland.io/<file>`, and that subdomain gateway only resolves v1 — so the pre-0.5.8 server produced dead links every time an agent uploaded an avatar.
- **Image filenames are normalized to `.jpeg` for any `image/*` content type** (configurable via `normalizeImageExt: false`). Matches what `useCreateDAO` does in the frontend and what `parseAvatarFromIpfsResponse` expects when reading the profile back.
- **`dexe_ipfs_upload_dao_metadata` auto-converts any incoming `avatarCID` to v1 base32** before composing `avatarUrl`. Callers that previously passed in a v0 `Qm…` (which silently produced a dead link) now get a working URL.

### New tools (+3, total 126 → 129)

- **`dexe_ipfs_upload_avatar`** — one-shot composite. Takes base64 image bytes, normalizes the filename to `.jpeg`, pins, converts the CID to v1, and returns the exact `{avatarCID, avatarFileName, avatarUrl}` triple that `dexe_ipfs_upload_dao_metadata` and `dexe_ipfs_update_dao_metadata` accept. Removes a three-step manual chain.
- **`dexe_dao_generate_avatar`** — generates a deterministic placeholder. Initials of the DAO name over a hash-coloured gradient, emitted as plain SVG (no `<foreignObject>`, no JS) and pinned through Pinata. Same input always produces the same colours, so re-deploys keep the brand. No external image-generation provider involved.
- **`dexe_ipfs_update_dao_metadata`** — smart "modify DAO profile" helper. Fetches the current DAO descriptionURL JSON, applies only the fields you pass in `overrides` (avatar / name / website / description / socialLinks / documents), re-pins the merged result, and returns the new CID ready to feed into `dexe_proposal_build_modify_dao_profile.newDescriptionURL`. Eliminates the previous footgun where re-uploading metadata meant manually re-specifying every unchanged field — any forgotten field silently disappeared from the profile.

### Recommended modify-profile flow

```text
1. dexe_ipfs_upload_avatar        → {avatarCID, avatarFileName, avatarUrl}
   (or dexe_dao_generate_avatar)
2. dexe_ipfs_update_dao_metadata  → newDescriptionURL
3. dexe_proposal_build_modify_dao_profile → TxPayload
4. dexe_proposal_create           → broadcast
```

### Supply-chain hygiene

- **Closes 4 transitive `npm audit` findings** under `@modelcontextprotocol/sdk@1.29.0`:
  - `fast-uri` <=3.1.0 (high) — path-traversal + host-confusion (GHSA-q3j6-qgpj-74h6, GHSA-v39h-62p7-jpjc)
  - `hono` <4.12.18 (moderate) — six advisories, incl. JSX HTML/CSS injection, JWT validation, cache-key leakage
  - `ip-address` <=10.1.0 (moderate) — XSS in `Address6` HTML-emitting methods (GHSA-v2v4-37r5-5v8g)
  - `express-rate-limit` (moderate)
- Resolved via `package.json` `overrides`. `@modelcontextprotocol/sdk` pin bumped from `^1.0.0` → `^1.29.0`. No public-API change.
- **`SECURITY.md`** added — vuln-disclosure policy, scoped threat model, contact email. Now ships in the tarball alongside `LICENSE`.
- **`.github/FUNDING.yml`** added (GitHub sponsors link).

`npm audit --omit=dev` now reports **0 vulnerabilities**.

## 0.5.7

Last broadcast sweep: **57 / 57 green** on Polaris (BSC testnet 97), 2026-05-12.

### Swarm coverage — 41 → 57 scenarios

- New broadcast-lifecycle scenarios for the three v0.5.6 builder rewrites: `S52-withdraw-treasury-execute`, `S53-apply-to-dao-execute`, `S54-reward-multiplier-execute`. Each runs the wrapper builder → `dexe_proposal_create` custom flow on the swarm fixture DAO and asserts the proposal lands in Voting / SucceededFor / ExecutedFor. Validates the Bug #29 / #30 / #31 fixes end-to-end against on-chain state, not just calldata shape.
- New broadcast scenarios for the most-used proposal types: `S55-token-transfer-execute`, `S56-blacklist-execute`, `S57-add-expert-execute`. Same build → create → state pattern.
- Refreshed `S18-withdraw-treasury-build` to pass the now-required `token` argument; refreshed `S31-reward-multiplier-build` to use Polaris's `nftMultiplier` (replacing retired Glacier address) and PRECISION-scaled multipliers (`1.5x => 1.5e25`) per v0.5.6's stricter validator.
- Replaced retired Glacier fixture with fresh **Polaris** testnet DAO (LINEAR, 50% quorum, deployed 2026-05-12). Sentinel (validator chamber) unchanged. README updated.

### Swarm tooling

- **`scripts/swarm/preflight.ts` now counts deposited tokens alongside the wallet balance.** A wallet with funds locked behind in-flight proposals had `ERC20.balanceOf=0` even though its governance power was intact in UserKeeper; the old check aborted nightly runs on a non-issue. Each token row now also reads `UserKeeper.tokenBalance(user, Personal)` from the parallel DAO and adds the deposited surplus to the threshold check. Falls back to wallet-only when the helper call reverts.
- **`scripts/swarm/nightly.sh` sanitizes the SUMMARY_LINE before posting to public targets.** The orchestrator's machine-greppable summary line ends with the absolute report path, which leaks the operator's filesystem layout when the repo is public. Local stdout still gets the full line; webhook + GitHub-issue posts get a stripped variant (runId + N/M + mode + chainTag, no path).

### Multi-chain config (chain-mixup guard)

- New optional env vars `DEXE_RPC_URL_TESTNET` + `DEXE_RPC_URL_MAINNET` + `DEXE_DEFAULT_CHAIN_ID`. Configure one or both; the MCP can now route reads and broadcasts to whichever chain a tool call requests, without an MCP restart.
- Write/composite tools accept an optional `chainId` arg: `dexe_tx_send`, `dexe_tx_status`, `dexe_dao_build_deploy`, `dexe_proposal_create`, `dexe_proposal_vote_and_execute`, `dexe_otc_dao_open_sale`, `dexe_otc_buyer_buy`, `dexe_otc_buyer_claim_all`. Omitting the arg uses the default chain. Requesting a chain with no configured RPC fails fast with a clear error before any tx is built or signed.
- Legacy `DEXE_RPC_URL` + `DEXE_CHAIN_ID` still works and stacks with the new vars — the legacy entry registers as one more chain in the pool. When `DEXE_CHAIN_ID` is omitted, the chain id is best-effort inferred from the URL hostname.
- New `dexe_get_config` diagnostic tool: returns the resolved chain set, the default chain, signer status, and IPFS/subgraph configuration. Call it at session start to orient before any write.
- Provider and signer are now per-chain caches (`RpcProvider`, `SignerManager`) so multi-chain usage doesn't churn through new connections.

## 0.5.6

Three Stage A mainnet bug fixes — all surfaced on `DexeClientDemo`
(BSC `0xCAe3…5B41`) and tracked as bugs #29 / #30 / #31.

### Fixed

- **Bug #30 — `dexe_proposal_build_withdraw_treasury` emitted wrong
  selector.** Builder targeted `GovPool.withdraw(address,uint256,uint256[])`
  (selector `0xfb8c5ef0`), which is the user-deposit-withdraw function on
  GovPool, not a treasury transfer. `proposal_create` rejected it with
  `Gov: invalid internal data`. Rewritten to emit one external
  `ERC20.transfer(receiver, amount)` action per token and/or one
  `ERC721.transferFrom(govPool, receiver, tokenId)` action per NFT —
  treasury sits in the GovPool address as a regular ERC20/721 balance, so
  withdrawal is just a plain external token call. New schema: drop the
  single `(amount, nftIds)` shape; supply `token`+`amount` and/or
  `nftAddress`+`nftIds`. At least one must be non-empty.

- **Bug #29 — `apply_to_dao` / `token_transfer` / `withdraw_treasury` had
  no blacklist precheck.** `ERC20Gov.transfer` reverts on a blacklisted
  recipient, and a proposal that passes voting then fails `execute()` sits
  in `SucceededFor` permanently with no recovery. When `DEXE_RPC_URL` is
  set, the three builders now `isBlacklisted(receiver)` against the token
  before encoding and refuse to build with a clear error if the recipient
  is blacklisted. When the token isn't ERC20Gov (call reverts) or RPC is
  absent, the precheck soft-skips with a note in the result detail —
  build always proceeds. New helper: `src/lib/blacklist.ts`.

- **Bug #31 — `dexe_proposal_build_reward_multiplier` mint/change_token
  reverted silently.** `ERC721_MULTIPLIER_ABI` declared `duration` as
  `uint256`, but `ERC721Multiplier.mint(address,uint256,uint64,string)`
  uses `uint64`. ethers derives the selector from the canonical signature,
  so the wrong-typed arg produced a different selector → no-match →
  silent revert with no returndata when GovPool.execute called into the
  multiplier (the contract has no `MAX_MULTIPLIER` check, so the original
  scale-mismatch hypothesis was wrong). Fixed the ABI to `uint64
  duration`. Builder now also rejects `multiplier=0`, multiplier values
  below `PRECISION/100` (likely forgot the 1e25 scale), `duration > 2^64
  − 1`, and `duration=0` for mint. Tool description spells out
  `PRECISION = 1e25` and `duration = seconds (uint64)`.

## 0.5.5

Doc + RPC hygiene. Two issues surfaced after publishing 0.5.4:

### Fixed

- **Internal RPC URL leaked into examples.** Three files referenced
  `https://mbsc1.dexe.io/rpc`, an internal DeXe endpoint not intended for
  public traffic. Replaced with the canonical public BSC RPC
  `https://bsc-dataseed.binance.org` in:
  - `docs/ENVIRONMENT.md` (3 occurrences — quick-start block, env table
    example, BSC mainnet chain config)
  - `tests/swarm/README.md` (`SWARM_RPC_URL_MAINNET` example)
  - `tests/compat/FORM-GUIDE.md` (network-capture hint)
  - `.env.example` (2 occurrences — `DEXE_RPC_URL` core block,
    `SWARM_RPC_URL_MAINNET` swarm block)
  - `scripts/swarm/test-mainnet-deploy.mjs` + `test-offchain-mainnet.mjs`
    (now read `process.env.DEXE_RPC_URL` first, fall back to public BSC RPC)
  Existing installs that copy-pasted the snippet still work — both URLs
  serve BSC mainnet — but the public one carries no internal-infra hint.
- **README links broken on npmjs.com.** Relative links like
  `./docs/TOOLS.md` work on GitHub but npm does NOT resolve them against the
  repo URL — npm renders the README at the package home and a relative link
  resolves to a non-existent path on `npmjs.com`. Converted all in-README
  links to absolute GitHub URLs:
  `./docs/X.md` → `https://github.com/edward-arinin-web-dev/dexe-mcp/blob/main/docs/X.md`
  Same pattern applied to the swarm-runbook + LICENSE links.

### Scope of exposure

Verified via `npm pack --dry-run`: the internal URL was **never shipped in
any npm tarball**. `package.json`'s `files` array only includes `dist/`,
`README.md`, `CHANGELOG.md`, `FUTURE.md`, and `.mcp.example.json` — all of
which used the public BSC RPC. The leak was confined to GitHub-only
artifacts (`docs/`, `tests/`, gitignored `.env.example` + swarm probe
scripts). No npm-deprecation needed.

### Notes

- Git history retains the original URL — full history rewrite via
  `git filter-repo` was considered and declined: rewrites every commit SHA,
  breaks PR refs and external clones, and the URL is an endpoint, not a
  credential. Forward-fix is sufficient.

## 0.5.4

Off-chain backend + DAO deploy hardening. Two latent bugs surfaced during
mainnet client-demo lifecycle on `0xCAe32Fa6e6D1C223Ed1047caA58F7fC0b2D65B41`
(BSC) — both fixed at the boundary so callers don't have to know.

### Fixed

- **`dexe_dao_build_deploy`** (`src/tools/daoDeploy.ts`) — pre-flight reject
  when `tokenParams.cap == mintedTotal` while creating a new gov token.
  ERC20Gov init reverted silently inside `_initGovPool` with the generic
  `Address: low-level delegate call failed`, hiding the real cause behind a
  10M-gas wasted tx. The validator now throws a clear message:
  `cap must be strictly greater than mintedTotal; pass cap=0 for uncapped, or
  cap > mintedTotal`. Tool description updated.
- **`dexe_proposal_build_offchain_single_option` / `_multi_option` /
  `_for_against`** (`src/tools/proposalBuildOffchain.ts`) — backend rejected
  every off-chain proposal with HTTP 400 `proposal type was not found` because
  the builders sent `attributes.type = String(Math.floor(Date.now()/1000))`
  (unix timestamp) instead of a registered template name. Constants now wired
  per voting type:
  - `default_single_option_type` for `voting_type=one_of`
  - `default_multi_option_type` for `voting_type=multiple_of`
  - `default_for_against_type` for `voting_type=for_against`
- **Off-chain quorum percentages** — same three builders. The backend stores
  `*_percent` as fractions (`0.5` = 50%), but the inputs accept whole-number
  percentages (`50` = 50%) for ergonomic parity with the frontend form.
  Boundary now divides by 100 once, via a new `pctToFraction` helper.

### Verified

- Smoke-tested all three off-chain builders: `outer.type` and
  `custom_parameters.type` carry the correct constants; quorum fractions match
  backend examples (live proposal #58 created end-to-end against
  `https://api.dexe.io`).
- DAO deploy: `cap == mintedTotal` rejected pre-flight with the new message;
  `cap > mintedTotal` and `cap == 0` (uncapped) pass the check.
- `tsc` clean, no project-test regressions.

## 0.5.3

`getProposals` ABI fix for the post-upgrade GovPool layout. On-chain
`GovPool.getProposals(offset, limit)` now returns a single `ProposalView[]`
array — not the legacy 5-tuple `(Proposal[], ValidatorProposal[], uint8[],
uint256[], uint256[])`. Every multicall-backed reader was decoding against
the old shape and surfacing as `getProposals reverted` on every live mainnet
DAO (DeXe Protocol, BOXY, Carib, HackenDAO, …). Verified live decode on 4
DAOs after the patch.

### Fixed

- `dexe_proposal_list` (`src/tools/proposal.ts`) — ABI string + decoder
  rewritten for the `ProposalView[]` shape. `requiredQuorum` now read
  per-view instead of from a parallel array.
- `dexe_user_inbox` (`src/tools/inbox.ts`) — same ABI swap; voting-state
  scan now indexes `views[i].proposal.core` / `views[i].proposalState`.
- `dexe_proposal_forecast` (`src/tools/predict.ts`) — same ABI swap;
  history mapping reads `views[i].proposal.core.{executed,votesFor,
  votesAgainst}`.
- `dexe_decode_proposal` (`src/tools/gov.ts`) — already correct (uses the
  artifact ABI loaded by `dexe_compile`), no change.

### Notes

- Validators' `ProposalCore` differs from gov `ProposalCore`:
  `(bool executed, uint56 snapshotId, uint64 voteEnd, uint64 executeAfter,
  uint128 quorum, uint256 votesFor, uint256 votesAgainst)`. Don't reuse the
  gov fragment when decoding `ExternalProposal`.

## 0.5.2

Subgraph auth fix. The Graph decentralized gateway now rejects requests
without `Authorization: Bearer <api-key>` — every subgraph-backed tool
(`dexe_read_dao_list`, `dexe_proposal_voters`, `dexe_user_inbox`, etc.) was
silently failing with HTTP 401 / "missing authorization header".

### Fixed

- `gqlRequest` (`src/lib/subgraph.ts`) now sends a Bearer token derived from
  (in priority order): explicit `apiKey` arg → `DEXE_GRAPH_API_KEY` env →
  auto-extracted from URL path (`/api/<key>/subgraphs/...`). Backward-compatible
  with the legacy URL shape — no env or call-site changes required for users
  whose key is already embedded in `DEXE_SUBGRAPH_*_URL`.
- HTTP error path now includes the gateway's response body (truncated to 200
  chars) so 401/403 reasons surface in the thrown message.

### Added

- New optional env var `DEXE_GRAPH_API_KEY` for the Bearer-only URL shape
  (`https://gateway.thegraph.com/api/subgraphs/id/<id>`). Documented in
  `.env.example`.
- Exported helper `extractGraphApiKey(endpoint)` for reuse.

## 0.5.1

OTC tier rate-scaling guardrails. Production incident on 2026-05-04: a sale
proposal shipped with `exchangeRates: ["1e17"]` for "0.10 USDT/HELIO" — the
on-chain formula is `saleAmount = purchaseAmount * PRECISION / rate` with
`PRECISION = 10^25` (see `contracts/core/Globals.sol`), so the tier promised
buyers `10^7` more sale tokens than the tier could provide. Buys reverted
with `TSP: insufficient sale token amount` and the tiers had to be
recovered via `offTiers + recover`.

### Added

- New optional tier field `purchaseRatios: string[]` — human decimal ratios
  (`"0.10"` = 0.10 purchase tokens per 1 sale token), auto-scaled with
  `parseUnits(r, 25)`. Mutually exclusive with `exchangeRates`.
- Exported `PRECISION_DECIMALS = 25` constant from `proposalBuildComplex`.

### Changed

- `tierSchema.exchangeRates` is now optional. The schema enforces via
  `.refine()` that exactly one of `exchangeRates` (raw 25-precision wei)
  or `purchaseRatios` (decimals) is provided.
- `buildTierTuple` normalizes both shapes into raw 25-precision
  `bigint[]` before encoding.

### Validation

- Raw `exchangeRates[i] < 10^18` now throws with a hint citing
  `PRECISION = 10^25` — catches the unscaled-ratio mistake at build time
  instead of on-chain. Existing fixtures (rates ≥ 1e18) remain
  byte-identical (verified via `npm run test:compat`).

## 0.5.0

Transaction simulator gate, multi-DAO inbox + forecast + OTC discovery, and
frontend byte-diff harness. Adds preflight tools (catch reverts before
broadcast), the read-side "what needs my attention" loop (inbox +
forecast), OTC tier discovery, and a fixture-driven calldata-equivalence
test against the production DeXe frontend. **125 tools** total
(119 → 125).

### Added

**Simulator tools (3)**
- `dexe_sim_calldata` — generic preflight. Returns `{ success, revertReason?, returnData?, gasEstimate? }`. Decodes `Error(string)` (selector `0x08c379a0`) and `Panic(uint256)` revert payloads. Optional `from`/`value`/`blockTag` overrides.
- `dexe_sim_proposal` — preflight `GovPool.execute(proposalId)`. Reads proposal state first; refuses to sim unless `SucceededFor` (idx 4). Surfaces `proposalState` + `proposalStateIndex` for diagnostics.
- `dexe_sim_buy` — preflight `TokenSaleProposal.buy(...)`. Native path (paymentToken = `0x0`) sets `value=amount`. ERC20 path also reads current allowance and reports `willNeedApprove: true` when allowance < amount.

**Integration**
- `dexe_otc_buyer_buy` — new `simulateFirst?: boolean` flag. When true, runs `dexe_sim_calldata` on the encoded `buy()` payload before the broadcast/return path; aborts with the revert reason on failure. Ignored when `dryRun: true`.

**Frontend ↔ MCP byte-diff harness**
- `tests/compat/diff-otc.mjs` — fixture-driven runner. For each `tests/compat/fixtures/otc-frontend-*.json` it calls `buildTokenSaleMultiActions(input)` from compiled `dist/`, byte-compares every `actions[i].data` against the fixture, and on mismatch prints an ABI-decoded field-level diff via `Interface.parseTransaction`. Exit 0 = all green, 1 = at least one diverged. Wired as `npm run test:compat`.
- `tests/compat/gen-otc-fixtures.mjs` — fixture generator. Runs an *independent* synthesizer that mirrors the frontend hook's pipeline (lines 33-130 of `useGovPoolCreateTokenSaleProposal.ts`) **and** the MCP helper, asserts byte-identical calldata, then writes the fixture using the helper's output. Refuses to write on synth/helper divergence. Re-run after any helper refactor or frontend ABI bump.
- Three fixtures covering the canonical OTC shapes:
  - `otc-frontend-1tier-open.json` — single open tier (no participation gating).
  - `otc-frontend-2tier-merkle.json` — open + `MerkleWhitelist` (auto-derived root, no `addToWhitelist`).
  - `otc-frontend-2tier-plain-whitelist.json` — open + plain `Whitelist` (auto-appended `addToWhitelist` action).
- `tests/compat/CAPTURE.md` — runbook documenting both capture methods (synthesizer + live WalletConnect intercept) and the form-field → TierSpec field map for re-capture.

**Docs + scenarios**
- `docs/SIMULATOR.md` — explains the three sim tools, response shapes, revert decoding, integration with `dexe_otc_buyer_buy`, and the limits of `eth_call`-based simulation (pending state, reorg risk, L2 divergence).
- `S47-sim-calldata-balance` — exercises `dexe_sim_calldata` calling `balanceOf` on the active chain's first allowlisted token; verifies `success: true` and a 32-byte return.
- `S48-sim-buy-no-tier` — exercises `dexe_sim_buy` against Glacier's TokenSaleProposal on BSC testnet with `tierId=999`; verifies `success: false` + revert reason set.

**Subgraph trio — read-side "what needs my attention" tools (3)**
- `dexe_user_inbox` — multi-DAO attention aggregator. Per DAO, surfaces
  `unvotedProposal` items (Voting state + zero personal vote), `claimableRewards`
  (non-zero pending rewards across the scanned window), and `lockedDeposit`
  (UserKeeper.tokenBalance > 0). Mainnet auto-discovers DAOs via the pools
  subgraph (`voterInPools` for the user, limit 50). Testnet requires explicit
  `daos[]` since chain 97 has no subgraph. Read-only. See `docs/INBOX.md`.
- `dexe_proposal_forecast` — predictive pass-rate. Reads latest 10 proposals via
  `getProposals(0, 10)` + their final states, computes historical pass-rate +
  average For-vote weight, and returns `{ quorum, historicalPassRate, risks,
  recommendation }`. `recommendation` is `likelyPass` / `borderline` /
  `likelyFail` based on `hitProbability = clamp(projectedFor / required, 0, 1)`.
  Mainnet only by default; pass `forceRpcOnly: true` to run on testnet.
- `dexe_otc_list_sales_for_dao` — OTC tier discovery. Reads `latestTierId()`
  then `getTierViews(0, latestTierId)` on a DAO's TokenSaleProposal helper.
  Returns tiers tagged with `status` (`upcoming` / `active` / `ended`)
  computed against `block.timestamp`, plus aggregate counts. Works on both
  chain 56 and chain 97 — no subgraph required. `totalSold` returns `null`
  in v1 (not exposed via `getTierViews`).

**Tests**
- `S50-otc-list-for-dao.json` — chain 97, validates tier-list shape on
  Glacier (zero tiers expected).
- `S51-inbox-with-supplied-daos.json` — chain 97/56, exercises
  `dexe_user_inbox` with explicit `daos[]`.

### Notes

- Compat fixtures are **synthesized** for v1: the synthesizer encodes via the same canonical `TokenSaleProposal` ABI signature both the frontend artifact and `TOKEN_SALE_PROPOSAL_ABI` regenerate from (post-Bug #25 fix). Live WalletConnect-intercept re-cert is documented in `CAPTURE.md` and remains the ground-truth check after frontend major bumps.
- All three fixtures round-trip cleanly through `Interface.decodeFunctionData`.

### Follow-ups (v0.5.1+)

- `dexe_otc_list_active_sales` — cross-DAO global live-sale list. Requires a subgraph entity that doesn't exist yet.
- Per-DAO TokenSaleProposal helper auto-discovery from registry / deploy receipt so callers don't need to thread the address.
- State-override allowance for ERC20 sim path (currently flags `willNeedApprove`).

## 0.4.0

OTC DAO support. Adds the calldata builders, merkle utilities, and four
composite tools needed to launch and operate an over-the-counter token sale
end-to-end through one MCP surface. **119 tools** total. Lifecycle proven
on BSC testnet (deploy → open_sale → vote → execute → buy → claim →
balance delta verified).

### Added

**Phase A — calldata builders (4 tools)**
- `dexe_proposal_build_token_sale_multi` — N-tier sale envelope. Sums and dedupes ERC20 approves per sale token, auto-derives merkle roots for `MerkleWhitelist` tiers when only `users[]` is supplied, auto-appends `addToWhitelist` for plain `Whitelist` tiers.
- `dexe_proposal_build_token_sale_whitelist` — standalone external proposal that calls `addToWhitelist([{tierId, users[], uri}, …])` on a live tier.
- `dexe_proposal_build_token_sale` — kept as back-compat shim forwarding `[tier]` to `_multi`. Gains optional `participation` field.
- `dexe_merkle_build` / `dexe_merkle_proof` — OZ `StandardMerkleTree`-compatible: sorted-pair commutative keccak, double-hash leaf `keccak256(keccak256(abi.encode(...)))`. Default leaf shape `["address"]`; advanced shapes via `entries` + `leafEncoding`.

**Phase B — composite tools (4 tools)**
- `dexe_otc_dao_open_sale` — orchestrates `_multi` + `runProposalCreate` (balance/threshold check, approve, deposit, IPFS metadata, `createProposalAndVote`). `buildOnly: true` short-circuits the proposal flow and just returns the envelope. `dryRun: true` returns ordered TxPayloads even when `DEXE_PRIVATE_KEY` is set.
- `dexe_otc_buyer_status` — read-only aggregator. Multicalls `getTierViews` + `getUserViews(user, tierIds, proofs)`, surfaces participation requirements + pre-computed `claimable` (`canClaim && !isClaimed ? claimTotalAmount : 0`) and `vestingWithdrawable` (`amountToWithdraw`). Optional per-tier `whitelists[]` triggers merkle-tree build + proof + verify check for the user.
- `dexe_otc_buyer_buy` — preflights ERC20 balance + allowance (skipped on native sentinel `ZeroAddress`), prepends `approve(spender=TokenSaleProposal, MAX_UINT256)` when needed, builds `buy(tierId, paymentToken, amount, proof)`. Auto-derives the merkle proof when `whitelistUsers[]` is supplied without a precomputed `proof`. Native path sets `value=amount`.
- `dexe_otc_buyer_claim_all` — picks tiers with `canClaim && !isClaimed` → `claim`, tiers with `amountToWithdraw > 0` → `vestingWithdraw`. Skips silently when nothing pending (`mode='noop'`).

**Refactors**
- `proposalBuildComplex.ts` — extracted `buildTokenSaleMultiActions(input)` pure helper; `tierSchema`, `TierSpec`, `buildTierTuple`, `buildSaleApprovals`, `TOKEN_SALE_PROPOSAL_ABI` now exported. The `dexe_proposal_build_token_sale_multi` registrar is a thin shim around the helper.
- `flow.ts` — extracted `runProposalCreate(input, deps)` + `sendOrCollect` exported. `dexe_proposal_create` gains a `dryRun` flag. `sendOrCollect` distinguishes `mode='dryRun'` (caller-requested) from `mode='payloads'` (no signer); the swarm orchestrator's `mcpFallbackDispatcher` only auto-broadcasts on `'payloads'`.

**Docs + scripts**
- `docs/OTC.md` — project-owner + buyer flows with paste-ready examples. Documents every gotcha that bit during integration: PRECISION 1e25 (not 1e18) on `exchangeRates`; `canClaim` requires `block.timestamp >= saleEndTime + claimLockDuration` so buyers must wait for the sale window to close even with `claimLockDuration: 0`; `maxAllocationPerUser == 0` means unlimited (not zero); newly-passed proposals briefly land in `Locked` (idx 6) before `SucceededFor` (idx 4); treasury must be seeded with sale token (mint via `tokenParams.users[]` + predicted `govPool` address).
- `scripts/lifecycle-otc.mjs` — runnable end-to-end proof on BSC testnet (chain 97). Single command. Deploys a fresh DAO, opens a 1-tier sale, votes+executes, buys, claims, verifies balance delta.

**Swarm scenarios**
- `S41-otc-multi-merkle-build` — 2 tiers Open + MerkleWhitelist, auto-derived root.
- `S42-otc-multi-whitelist-build` — 2 tiers Open + plain Whitelist, auto-appended `addToWhitelist`.
- `S43-otc-whitelist-extend-build` — standalone `_whitelist` proposal extending an existing tier.
- `S44-otc-open-sale-build` — `buildOnly` envelope sanity.
- `S45-otc-buyer-buy-native-build` — `dryRun` + native sentinel.
- `S46-otc-buyer-buy-merkle-build` — `dryRun` + auto-merkle proof.

### Fixed

- **Bug #25** — `TOKEN_SALE_PROPOSAL_ABI` had two field-order transpositions vs the contract: `TierInitParams` swapped `saleTokenAddress` <-> `claimLockDuration`, and `VestingSettings` was declared `(cliff, step, duration, percentage)` instead of canonical `(percentage, duration, cliff, step)`. Selector matched (`0x6a6effda`) but calldata was silently misdecoded — every prior single-tier sale proposal built via dexe-mcp landed with vesting + claim-lock fields scrambled.
- **Bug #26** — `getUserViews` ABI in `read.ts` (and copied into `otc.ts`) declared `UserView` as a flat 7-field struct (`canParticipate, isWhitelisted, purchasedAmount, owedAmount, lockedAmount, claimableAmount, vestingWithdrawAmount`). Actual contract returns `tuple(bool canParticipate, PurchaseView purchaseView, VestingUserView vestingUserView)` with nested structs. Both files now match the contract; affected callers (`dexe_read_token_sale_user`, `dexe_otc_buyer_status`, `dexe_otc_buyer_claim_all`) updated to read fields via the correct paths.
- **Bug #27** — `getUserViews` is a 3-arg function (`address user, uint256[] tierIds, bytes32[][] proofs`); ABI was missing the third parameter, causing every call to revert with `require(false)` at the abicoder layer. Fixed in both `read.ts` and `otc.ts`; non-merkle tiers pass `tierIds.map(() => [])`.
- **`flow.ts` `vote_and_execute` Locked state.** When `open_sale`'s `createProposalAndVote` clears quorum + earlyCompletion, the proposal lands directly in state 6 (`Locked`) before transitioning to `SucceededFor`. The skip-vote-and-execute branch only matched 4/5; now also matches 6.
- **`otc.ts` multicall double-unwrap.** Single-return-value functions are already unwrapped by `src/lib/multicall.ts`; the OTC composites were treating the result as one extra layer deep and indexing `[0]`. Fixed.

### Lifecycle proof

Live run on BSC testnet (chain 97) on 2026-05-01:
- govPool: `0x028C447c72A6Fd1955f0937bb3C5926E8EAC297c`
- deploy tx: `0x3e17ff4e46a6840bf4945e15a9c3af620be276b7de0e1efe807e08ec8a097dbe`
- execute proposal 1: `0x17b677e3fb0b078ca670d3a16c3a776cc36dac97e4497446b19d6490633873df`
- buyer balance: `400000.0` → `399999.0` (buy) → `400000.0` (claim) — delta verified

---

## 0.3.0

End-to-end testnet validation. Every proposal-builder tool is now exercised by an automated swarm scenario on BSC testnet, and the harness itself ships in-repo so external integrators can run it. **111 tools** total, **41 swarm scenarios**, full sweep green.

### Added

**Swarm test harness (`tests/swarm/` + `scripts/swarm/`)**
- `scripts/swarm/orchestrator.ts` — scenario loader + dispatcher. Inline ethers dispatchers for the no-IPFS toolset (vote_user_power, read_delegation_map, build_undelegate, build_withdraw, build_withdraw_all, build_erc20_approve, build_deposit, build_delegate, build_vote). Generic MCP-stdio fallback (`mcpFallbackDispatcher`) routes anything else through the dexe-mcp child server, so adding a scenario for a new tool is JSON-only — no code changes.
- Loop expansion (`spec.loop.over` × `appliesToSteps`), template engine (`{{dao}}`, `{{firstAllowlistedToken}}`, `{{firstAllowlistedDao}}`, `{{secondAllowlistedDao}}`, `{{dao.<helper>}}`, `{{agent:X:address}}`, `{{capture.path}}`, `{{capture.0.field}}`), `skipIf` evaluator with limited expressions, deferred-cascade for chained captures, wallet semaphore for parallel-safe broadcasts, per-scenario `prefund` hook that tops up agents from `AGENT_FUNDER_PK` before each scenario runs.
- `scripts/swarm/preflight.ts` + `scripts/swarm/fund-pool.ts` — wallet-readiness check + token allowlist–enforced top-up. Hard-refuses to send to any non-pool address or any token not on the allowlist.
- `scripts/swarm/nightly.sh` — Phase 5 cron runner. Pulls main, runs preflight + full sweep, tails the run report, posts the one-line summary to `SWARM_SUMMARY_WEBHOOK` and/or `SWARM_SUMMARY_ISSUE` (gh CLI), runs a triage stub on failure (with `SWARM_FIXER=1` opt-in for auto-fix), and rotates run-report dirs older than 30 days while keeping the latest 50.
- `scripts/swarm/orchestrator.ts` emits a single greppable summary line after `writeReport`: `SWARM <runId> <pass>/<total> <mode> <chainTag> <reportPath>` — consumed by nightly.sh and any external poster.
- `scripts/swarm/one-shot-execute.mjs` — closes a proposal lifecycle once it reaches `SucceededFor`. Polls + caps `wait()` at 90 s to avoid sandbox hangs.
- 41 scenario JSONs covering: reset, delegation chain, validator pass / veto / full lifecycle, expert / participation / staking / validator / catalog / cross-DAO / multi-proposal-state read snapshots, cancel-vote, decode-and-introspect, build-only sanity for every external + internal proposal type from `dexe_proposal_catalog`.
- Role prompts: `proposer`, `voter`, `delegator`, `reporter`, `triage`, `validator`, `expert`, `fixer`, plus `_shared.md` and the dao-personas fixture. Fixer prompt encodes the CLAUDE.md auto-fix loop verbatim — branch `swarm-fix/<YYYY-MM-DD>`, never push to main, diff scope hard-bounded to `src/tools/`, `src/lib/`, `tests/swarm/`.

**Composite + signing tools**
- `dexe_proposal_create` — full prerequisite handling: balance check, ERC20 approve, deposit, IPFS metadata upload, `createProposalAndVote`. When `DEXE_PRIVATE_KEY` is set the tool signs and broadcasts; otherwise returns the ordered `TxPayload` list. Supports `proposalType: 'modify_dao_profile' | 'custom'`.
- `dexe_proposal_vote_and_execute` — vote-then-execute composite with `autoExecute` + `depositFirst` flags.
- `dexe_tx_send` + `dexe_tx_status` — opt-in signer surface that uses the configured `DEXE_PRIVATE_KEY` when present. Calls remain calldata-by-default; users opt in by setting the env var.
- `dexe_dao_build_deploy` predicted-address auto-wiring: `govToken` flowed into `userKeeperParams.tokenAddress` and `distributionProposal` + `govTokenSale` into `additionalProposalExecutors` automatically. LINEAR / POLYNOMIAL `votePower` initData auto-encoded.

**Reads + introspection**
- `dexe_read_dao_list`, `_dao_members`, `_dao_experts`, `_user_activity`, `_distribution_status`, `_token_sale_tiers`, `_token_sale_user`, `_staking_info`, `_validator_list`, `_privacy_policy_status`, `_delegation_map` — fill out the DAO read surface.
- `dexe_get_methods` returns structured per-function metadata (4-byte selectors, mutability, full structured inputs/outputs with `internalType` preserved for tuples).
- `dexe_proposal_voters` switched to the `pools` subgraph and the proposalInteractions composite ID format (poolAddr + uint32LE(proposalId), no separator).
- `dexe_decode_proposal` understands every external + internal proposal action shape.

### Fixed

- **Proposal metadata format**: builders now emit `proposalName` / `proposalDescription` (not `name` / `description`), wrap diffs inside `changes: { proposedChanges, currentChanges }`, set `isMeta: false`, and round-trip identical to the frontend reference. 17 builders touched.
- **Approve target for deposits** is `UserKeeper`, not `GovPool`. Both flow tools (`proposal_create`, `vote_and_execute`) now approve the right address.
- **Personal voting power** = `tokenBalance.balance − ownedBalance` (deposited only). Without this, `withdraw` on freshly-funded agents reverts `GovUK: can't withdraw this`.
- **VotePower initData** uses `__LinearPower_init()` selector `0x892aea1f` (not empty `0x`) so newly-deployed DAOs initialize their LINEAR vote-power proxy correctly.
- **`STATE_NAMES` enum order** corrected (Defeated / Locked positions were swapped).
- **Custom-proposal IPFS metadata** now includes `category`, `isMeta`, `proposedChanges`, `currentChanges`.
- **Subgraph migration**: Studio URLs deprecated; switched to The Graph decentralized network with API key. Per-chain endpoints documented.
- **IPFS gateway path normalization**: dedicated gateways configured with a trailing `/ipfs` (e.g. `https://<sub>.mypinata.cloud/ipfs`) no longer produce `/ipfs/ipfs/<cid>` 404s.

### Changed

- README updated: tool count `83 → 111`, new "Swarm test harness" section.
- `process.loadEnvFile()` is invoked from `index.ts` so the MCP server loads `.env` itself; users no longer have to plumb env-var changes through their MCP client config (which often doesn't reload).
- Repo now ships `.claude/skills/swarm-test/SKILL.md` for users running Claude Code; lets them invoke the swarm with `/swarm-test`.

### Notes

- **Validated network**: BSC testnet (chain 97). Two fixture DAOs deployed for the harness — Glacier (50% quorum, no validators) and Sentinel (5% quorum, 2 validators with 1k SVT each).
- **Mainnet status**: a separate run pass is staged (Stage B per `tests/swarm/README.md`) but blocked on a previously-observed `PoolFactory.deployGovPool` revert. Re-validate when the protocol team confirms a fix.
- **Off-chain backend tools** require `DEXE_BACKEND_API_URL` and only run on chains where DeXe operates a backend. The corresponding swarm scenarios declare `requiresChain: [56]` so they auto-skip on testnet.

## 0.2.0

The big one — dexe-mcp expands from 15 dev-tooling tools to **83 tools** covering the full DeXe DAO lifecycle. AI agents can now create DAOs, build any of the 33 proposal types the DeXe frontend exposes, upload metadata to IPFS, stake/delegate/vote/execute/claim — all end-to-end.

### Added

**Foundations + reads (13 tools)** — `dexe_dao_info`, `dexe_dao_predict_addresses`, `dexe_dao_registry_lookup`, `dexe_proposal_state`, `dexe_proposal_list`, `dexe_proposal_voters`, `dexe_vote_user_power`, `dexe_vote_get_votes`, `dexe_read_multicall`, `dexe_read_treasury`, `dexe_read_validators`, `dexe_read_settings`, `dexe_read_expert_status`. Backed by an `AddressBook` that resolves contracts via `ContractsRegistry`, a Multicall3 batch helper, a canonical `TxPayload` shape, enum mirrors for `ProposalState` / `VoteType`, and a minimal subgraph GraphQL client.

**IPFS (6 tools)** — `dexe_ipfs_upload_proposal_metadata`, `_upload_dao_metadata`, `_upload_file`, `_fetch`, `_cid_info`, `_cid_for_json`. Backed by a Pinata client and local CID computation via `multiformats`. Public gateways (dweb.link, ipfs.io, cf-ipfs, 4everland) are unreliable and NOT defaulted. Users must set `DEXE_IPFS_GATEWAY` to a dedicated gateway (the one Pinata provides alongside the JWT is recommended). Public gateways are opt-in via `DEXE_IPFS_GATEWAYS_FALLBACK` (comma-separated, tried sequentially — no parallel races).

**Proposals — all 33 types (35 tools)**
- `dexe_proposal_catalog` — enumerate every proposal type the DeXe UI exposes (24 external, 4 internal, 5 off-chain), with metadata shape, gating, and linked MCP builder.
- Primitives: `dexe_proposal_build_external` (+ `createProposalAndVote`), `dexe_proposal_build_internal`, `dexe_proposal_build_custom_abi`, `dexe_proposal_build_offchain`.
- External wrappers (each returns `{ metadata, actions: Action[] }`): `token_transfer`, `token_distribution`, `token_sale`, `token_sale_recover`, `change_voting_settings`, `manage_validators`, `add_expert`, `remove_expert`, `withdraw_treasury`, `delegate_to_expert`, `revoke_from_expert`, `create_staking_tier`, `change_math_model`, `modify_dao_profile`, `blacklist`, `reward_multiplier`, `apply_to_dao`, `new_proposal_type` (also covers *Enable Staking*).
- Internal validator wrappers (each returns `{ metadata, proposalType, data }`): `change_validator_balances` (type 0), `change_validator_settings` (type 1), `monthly_withdraw` (type 2), `offchain_internal_proposal` (type 3).
- Off-chain backend proposals: `offchain_single_option`, `offchain_multi_option`, `offchain_for_against`, `offchain_settings`. Plus `dexe_auth_request_nonce` + `dexe_auth_login_request` for the 2-step Bearer flow, and `dexe_offchain_build_vote` / `dexe_offchain_build_cancel_vote`.
- **Write model is calldata-only.** No signer, no private keys. Every write tool emits a signable payload the agent's wallet submits.

**Vote / stake / execute / claim writes (14 tools)** — `erc20_approve`, `deposit` (payable for native-staking DAOs), `withdraw`, `delegate`, `undelegate`, `vote`, `cancel_vote`, `validator_vote`, `validator_cancel_vote`, `move_to_validators`, `execute`, `claim_rewards`, `claim_micropool_rewards`, plus `multicall` to batch any of the above into one atomic tx. Arg-order gotchas captured in code comments (e.g. `GovPool.vote(pid, isFor, amount, nftIds)` vs `GovValidators.voteInternalProposal(pid, amount, isFor)`).

**DAO deploy (1 tool)** — `dexe_dao_build_deploy` encodes `PoolFactory.deployGovPool(GovPoolDeployParams)` with the full nested struct (settings / validators / userKeeper / token / votePower / verifier / BABT flag / descriptionURL / name). Auto-resolves PoolFactory via `ContractsRegistry` if omitted. When `deployer` + RPC are available, also returns the predicted GovPool address so agents can wire follow-up txs before the DAO exists. Encodes against the compiled `PoolFactory.json` artifact when present (strict parity); falls back to a hand-rolled tuple signature derived from `IPoolFactory.sol` otherwise.

### Changed

- `src/config.ts` adds `DEXE_CHAIN_ID` (default 56), `DEXE_CONTRACTS_REGISTRY` override, `DEXE_PINATA_JWT`, three subgraph URL overrides, `DEXE_BACKEND_API_URL`.
- `package.json` description rewritten to reflect full DAO-ops scope. New dep: `multiformats` (Protocol Labs, for local CID computation).
- `README.md` reorganized around the eight tool groups; added the full env-var matrix.

### Notes

- **No breaking changes.** All v0.1.x tools remain. The write contract is new-world: `TxPayload` for single-tx builders, `Action[]` for proposal wrappers — never a singular `action` field.
- **Deferred to future work** (`FUTURE.md`): Hardhat-fork simulation (`dexe_simulate_vote`), signer-aware send mode, additional IPFS pinning providers (Storacha, Lighthouse), and alternate subgraphs.

## 0.1.5

### Fixed
- **`'npx' is not recognized`** from inside `npm run compile` (and other npm scripts that internally call `npx hardhat …`) on stripped-Node Windows installs. v0.1.4 got `npm` itself spawning cleanly, but DeXe-Protocol's `compile` script is literally `npx hardhat compile --force`, and when npm spawned that child, `cmd.exe` couldn't find `npx.cmd` on PATH — the stripped `C:\Program Files\nodejs\` has `node.exe` only. Root cause: we weren't propagating the resolved Node's shim directory into the child's `PATH`.
- New `deriveNodeBinDir()` + `envWithNodeBinDir()` helpers in `src/runtime.ts` derive the directory containing `npm.cmd`/`npx.cmd` (Windows) or `bin/npm`/`bin/npx` (Unix) from the resolved `npm-cli.js` path, and prepend it to `PATH` on every child spawn (`bootstrap` npm install, `runNpmScript`, `runHardhat`). Child shells launched by npm scripts can now resolve `npx` / `npm` / any locally-installed binary as expected.
- `npmCommand()` now returns a `binDir` field alongside `command` / `prefixArgs` / `needsShell`. Bootstrap logs the prepended directory on first run so it's visible which Node install is contributing the shims.

## 0.1.4

### Fixed
- **`spawn EINVAL` during first-run `npm install`** on Windows hosts where `process.execPath` points at a Node install that does not bundle npm (e.g. a bare `node.exe` dropped under `C:\Program Files\nodejs\` without the rest of the toolchain). Two root causes addressed:
  1. `resolveNpmCli()` now searches a broader set of locations for a usable `npm-cli.js` — including `%APPDATA%\nvm\v*\node_modules\npm\bin\npm-cli.js` (nvm-windows), `%APPDATA%\npm\node_modules\npm\bin\npm-cli.js` (per-user npm prefix), `C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js` (stock Windows installer), `~/.nvm/versions/node/v*/lib/node_modules/npm/bin/npm-cli.js` (nvm Unix), and Homebrew paths. Because `npm-cli.js` is plain JavaScript, *any* modern `node` can execute any of these, so the MCP process's own Node is free to "borrow" npm from a completely different Node install.
  2. When no `npm-cli.js` is found anywhere and we fall back to spawning `npm.cmd` directly, `execFile` / `execa` now pass `{ shell: true }` — without it, Node refuses to spawn `.cmd` / `.bat` files (CVE-2024-27980 mitigation) and throws `spawn EINVAL`.
- Progress logging on first bootstrap now prints the resolved `npm-cli.js` path (or "shell-resolved" fallback), so "which npm is about to run" is visible in stderr.

## 0.1.3

### Docs
- **Windows install section rewritten** to lead with the absolute-path recipe (`node <abs path to dist/index.js>`) instead of `cmd /c dexe-mcp`. End-to-end testing against Claude Code on Windows showed the `cmd /c` wrapper, while standalone functional, did not reliably complete the MCP handshake when spawned by Claude Code — the absolute-path recipe has zero shim resolution and is known-working.
- **New prereq step**: verify `npm --version` actually runs in your shell *before* attempting `npm install -g dexe-mcp`. Users with a stripped `node.exe`-only install (common on Windows) will hit a silent `npm i -g` no-op otherwise, with no visible error.
- Added a "Verify the install" section showing how to smoke-test `dexe-mcp` over stdio without involving Claude Code, so users can distinguish "MCP server broken" from "client registration broken".

No code changes — 0.1.3 is a docs-only patch on top of 0.1.2's behavior.

## 0.1.2

### Fixed
- **Server no longer hangs / fails on first launch.** The heavy `git clone` + `npm install` bootstrap is now lazy — it runs only when a build tool (`dexe_compile`, `dexe_test`, `dexe_coverage`, `dexe_lint`) is first invoked, not inside MCP `initialize()`. Previously the MCP handshake would block for minutes or time out, and crash outright on hosts where `npm` / `git` were not on the spawned process's PATH.
- **PATH-independent spawning of `npm` and `hardhat`.** The runner now invokes `node <npm-cli.js>` and `node <protocol>/node_modules/hardhat/internal/cli/cli.js` directly via `process.execPath`, so it works on Windows installs where `npm.cmd` / `npx.cmd` aren't on the MCP client's spawn PATH (common with nvm-windows and with stripped `node.exe`-only installs).
- **Actionable error messages** when `git` is not installed, when `DEXE_PROTOCOL_PATH` points at a non-Hardhat directory, or when the user-managed checkout is missing `node_modules`.
- Concurrent build-tool calls now coalesce into a single bootstrap instead of racing `git clone` / `npm install`.

### Changed
- `loadConfig()` no longer hard-fails when the DeXe-Protocol checkout is missing or incomplete at startup — it logs a soft warning to stderr and defers preparation to the first build-tool invocation.
- `src/bootstrap.ts` split into `resolveProtocolPath()` (cheap, startup-safe) and `ensureBuildReady()` (lazy, idempotent).
- New `src/runtime.ts` with portable `npmCommand()` / `hardhatCommand()` / `hasGit()` helpers.

### Docs
- README now has an OS-specific install matrix (Mac/Linux vs. Windows) and a "dev / local checkout" recipe. Troubleshooting section updated for the new lazy-bootstrap behavior and the `process.execPath` npm resolution.

## 0.1.1

### Added
- `dexe_get_methods` introspection tool — returns per-contract methods partitioned into `read` (view/pure) and `write` (nonpayable/payable). Each entry includes `name`, canonical `signature`, 4-byte `selector`, `stateMutability`, and structured `inputs`/`outputs` with `internalType` preserved (so tuple-typed args like `IGovPool.ProposalView[]` survive intact). Designed for generating TypeScript interfaces or ethers wrappers without re-parsing raw ABIs. Supports `kind` filter (`read`/`write`/`all`) and optional `includeEvents`/`includeErrors`.

Tool count: 14 → 15.

## 0.1.0

Initial public release (Phase A): build/test, contract introspection, read-only governance tools. 14 tools.
