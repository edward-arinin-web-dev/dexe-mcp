# Strategic Decision: dexe-mcp Expansion

Synthesis of `01-mcp-ecosystem.md`, `02-governor-dao-map.md`, `03-pain-points.md`, `04-funding-landscape.md`.

---

## Strategic Options Matrix

| # | Option | Demand signal | Build effort | Strategic fit (1-5) | Top risk | Source refs |
|---|--------|---------------|--------------|---------------------|----------|-------------|
| 1 | **Governor MCP generalization** (OZ Governor + Compound Bravo adapter alongside DeXe) | $8.2B treasury TAM across 30 DAOs; 11 vanilla-OZ DAOs ($3.7B) work via config only; pains P1 (22) + P10 (11); zero MCP competitor builds Governor proposals | M — 3-4 wks for 45-tool v0.1 | **5** | Tally already owns the UI; need API consumer (Tally SDK / analytics) to pull adoption | 01§4.1, 01§6.1, 02§Catalog, 02§Phase 1, 03§P1+P10 |
| 2 | **Pre-vote proposal simulator** (Tenderly-fork + invariant assertions on calldata) | P6 (15) + P7 (12) = 27 pain mentions; Beanstalk $182M exploit precedent; OZ GHSA-93hq-5wgc-jc82 (silent calldata trim); no MCP does this today | M — 2-3 wks | **4** | Tenderly fork API rate-limit + cost; assertion DSL takes design iteration | 01§4.2, 03§P6+P7, 03§MCP opportunity #3 |
| 3 | **Agent-runtime integration pack** (drop-in dexe-mcp module for Ritual / Theoriq / Olas Pearl) | $4B+ flowed into agent infra 18mo; 60% funding probability for "DAO agent governance"; Olas/Theoriq/Ritual all need governance capability they lack | S — 1-2 wks (adapters + positioning) | **4** | Positioning play, not product; revenue depends on partner uptake | 04§Thesis 1, 04§Takeaway 3, 04§Recommendations |
| 4 | **IPFS multi-pin durability MCP** (Pinata + Filebase + health monitor) | P4 14 mentions; 9,645 Snapshot projects depend on IPFS w/ no SLA; dexe-mcp already has Pinata plumbing | S — 1 wk | **3** | Narrow scope; commodity quickly; hard to monetize standalone | 01§4.3, 03§P4, 03§MCP opp #4 |
| 5 | **Safe ↔ Governor execution bridge** (Snapshot result → Safe queue → on-chain execute) | P5 (16) + P8 (13) = 29 mentions; Snapshot non-binding well-known gap; oSnap/Snapshot X exist but no MCP | M — 3 wks | **3** | Needs Safe Transaction Service auth + Snapshot API; coordination problem more than tech problem | 03§P5+P8, 03§MCP opp #5, 04§Gnosis row |
| 6 | **Delegate scorecard MCP** (voting history, abstention, alignment vs forum) | P3 18 mentions; arXiv 2510.05830 doc'd misalignment | M-L — 4+ wks (indexer + analytics) | **2** | Pulls dexe-mcp into pure-analytics lane; Boardroom/Tally overlap; no execution moat | 03§P3, 01§Tally gap |
| 7 | **Cross-chain governance relay** (LayerZero/Connext-aware proposal builder) | P9 11 mentions; Arbitrum L2→L1 triple-wrap; emerging | L — 6+ wks | **2** | Heavy infra, low pain frequency, no funding signal | 02§Customizations §6, 03§P9 |

**Fit rubric:** (a) reuses 128 existing tools, (b) shippable solo <1mo, (c) compounds dexe-mcp identity vs fragmenting it.

**Confidence per option:**
- Opt 1: **H** — three independent reports converge (01 ranks #1 white space; 02 sizes $8.2B + ships 45-tool plan; 03 maps P1/P10 directly to it)
- Opt 2: **H** — pain frequency + $182M exploit precedent + zero competitor + reuses swarm sim
- Opt 3: **M** — funding evidence strong, but partner uptake unproven; positioning, not product
- Opt 4: **M** — clear pain, easy build, but commodity ceiling
- Opt 5: **M** — clear pain, but coordination-layer, hard to test solo
- Opt 6: **L** — pulls away from identity; Tally/Boardroom already own UX
- Opt 7: **L** — low frequency + huge scope

---

## Top 3 Options Deep Dive

### Option 1 — Governor MCP generalization

**Why this specifically:**
- 02§Catalog: 30 DAOs, $8.2B treasury; Tier 1 vanilla OZ (Uniswap, Compound, Optimism, Gitcoin, Idle, Inverse, PoolTogether, Rocket Pool, Across, Mean, Threshold) = 11 DAOs / $3.7B / **config file only**, no per-DAO code
- 02§Generalization: dexe-mcp's ProposalState enum is **identical** to OZ Governor; IPFS metadata, vote tally, Timelock plumbing, EIP-712 signing all transfer 80-100%
- 01§Coverage matrix: dexe-mcp is the only MCP that builds proposals; OpenZeppelin MCP = templates only, Tally = read-only, Lido = single-protocol
- 03§P1 (22 mentions): proposers stuck on ABI/IPFS encoding — LLM scaffolding is the wedge

**1-week pilot:**
Ship `dexe_gov_get_proposal`, `dexe_gov_get_voting_power`, `dexe_gov_build_vote_cast`, `dexe_gov_build_propose` against Uniswap mainnet Governor (`0x408ED635…`). One config-driven adapter + 4 tools. Demo: agent reads UNI proposal #X, builds a `castVote` calldata, signs offline.

**Kill criterion:**
After 30d, if no external user (Tally / Boardroom / Karpatkey / analytics shop / independent dev) has installed `dexe@gov` and run a tool against a non-DeXe DAO, kill. Also kill if Tier-1 Governor proposal building exposes a per-DAO quirk that wasn't in 02's matrix and breaks the config-only premise.

**First action if pursued:**
`git checkout -b governor-adapter` → new file `src/governor/adapter.ts` with Uniswap config + ABI-driven `propose`/`castVote`/`state` reads. Tag tools with `dexe_gov_*` prefix.

---

### Option 2 — Pre-vote proposal simulator

**Why this specifically:**
- 03§P6 (15) + P7 (12): "flawed payload becomes live exploit" + GHSA-93hq-5wgc-jc82 calldata trim + Beanstalk $182M
- 01§4.2: "no MCP simulates multi-sig + timelock + execution flows across DAOs" — dexe-mcp swarm (S00-S25) is closest
- 02§Tooling gap: Tally/Boardroom/Snapshot all lack execution path validation
- Reuses dexe-mcp's existing swarm scenario infrastructure + dexe_sim_calldata

**1-week pilot:**
Ship `dexe_gov_simulate_proposal(governor, proposalId, rpcFork)` — forks BSC/ETH at current block, runs `execute()` against Tenderly fork, returns (success, revertReason, treasuryDelta, roleChanges). Test against one live Compound proposal.

**Kill criterion:**
If Tenderly free-tier rate-limits below 100 sims/day, switch to local Hardhat fork or kill. If output JSON can't catch the GHSA-93hq calldata-trim case without per-Governor heuristics, scope is wider than estimated — kill.

**First action if pursued:**
Audit `src/tools/sim/*.ts` for what's reusable; write `gov_simulate.test.ts` against a known-good Compound proposal as fixture.

---

### Option 3 — Agent-runtime integration pack

**Why this specifically:**
- 04§Thesis 1: $4B+ into agent infra (Ritual $25M, Theoriq $10.4M, Olas $13.8M, General Tensor $5M)
- 04§Whitespace #1: "DAO agent governance" funding probability 60%; zero player has raised >$5M; clear vacuum
- 04§Takeaway 3: real acquirers/partners are agent-infra teams, not Aragon/Snapshot
- 01§Conclusion: dexe-mcp is uniquely positioned (only end-to-end lifecycle MCP)

**1-week pilot:**
Write `examples/olas-pearl-integration.md` + working ElizaOS plugin (`@elizaos/plugin-dexe-gov`) that wraps 5 dexe-mcp tools. Post in Olas Discord + Theoriq forum. Measure: replies + clone count.

**Kill criterion:**
After 30d, if no agent-infra team has opened a GitHub issue, PR, or DM expressing partnership interest, this is positioning fluff — kill. Also kill if the actual demand from agent-infra is for *DeFi-execution* tools (Almanak/Giza territory), not governance.

**First action if pursued:**
Email Ritual ecosystem lead + Olas DevRel; share dexe-mcp README + offer 30-min demo.

---

## Recommendation

**Option 1 — Governor MCP generalization.** Confidence **H**.

**Why this beats Option 2:** simulator is a *feature*, not a product surface. It can — and should — ship as part of Governor MCP later (the `dexe_gov_simulate_*` group). Shipping it standalone first means building a marketing surface around a single tool, which has weaker adoption gravity than a 45-tool Governor toolkit.

**Why this beats Option 3:** partnership pitches without a generalized product are weak. "We support DeXe Protocol" reads as vertical-vendor to Ritual/Theoriq/Olas. "We are the Governor MCP" reads as horizontal infra. Option 1 *enables* Option 3 — invert the order.

**Key evidence converging:**
- 01 ranks Governor generalization as the #1 white space ("highest-ROI expansion vector")
- 02 already produced a 45-tool spec, config schema, and 3-4 week timeline
- 03 P1+P10 pains map directly to the Build group tools
- 04 confirms positioning shift from "DAO governance tool" → "agent-native execution layer" requires generalization

**First concrete action this week:**
Branch `governor-adapter`. Land Uniswap-only PoC: 4 tools (`dexe_gov_get_proposal`, `dexe_gov_get_voting_power`, `dexe_gov_build_propose`, `dexe_gov_build_vote_cast`) + config schema from 02§Code Artifact. Commit message: `feat(gov): scaffold Governor adapter — Uniswap Tier-1 PoC`.

**30-day metric:**
Tier-1 coverage shipped for 3 Governor DAOs (Uniswap + Compound + Optimism), AND ≥1 external user has executed a non-DeXe Governor tool against mainnet. If hit → continue to Phase 2 (Aave dual-executor + Arbitrum types). If miss → execute kill criterion.

**Kill criterion (repeated for clarity):**
30 days from first commit on `governor-adapter`: zero external tool invocations against a non-DeXe Governor by anyone outside the DeXe team → revert positioning, fall back to deepening DeXe-specific surface.

---

## Source provenance

- 01 = `research/01-mcp-ecosystem.md`
- 02 = `research/02-governor-dao-map.md`
- 03 = `research/03-pain-points.md`
- 04 = `research/04-funding-landscape.md`
