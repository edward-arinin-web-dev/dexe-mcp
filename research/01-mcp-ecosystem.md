# MCP Ecosystem Survey: DeFi, DAO, and EVM Governance Coverage

**Scope:** Mapping 15 active MCP servers across DeFi/DAO/Web3 to identify overlaps with dexe-mcp and white-space opportunities.

**Methodology:** Web searches of Smithery.ai, Glama.ai, GitHub, and official docs. Tool counts verified from repos where public. Survey completed May 2026.

---

## 1. Direct Overlaps: Governance & DAO Tooling

### OpenZeppelin Contracts MCP (codewithdpk)
- **Coverage:** Smart contract code generation (ERC20, ERC721, governance, access control, DeFi templates)
- **Tools:** ~15 contract-generation tools (not verified from source)
- **Gap vs dexe-mcp:** Read-only template fetching; no deployment, voting, treasury, or proposal lifecycle
- **Audience:** Smart contract developers seeking audited boilerplate
- **Source:** [OpenZeppelin MCP | Glama](https://glama.ai/mcp/servers/@codewithdpk/openzippelin-mcp), [GitHub](https://github.com/OpenZeppelin/openzeppelin-mcp)

### Tally DAO Governance MCP
- **Coverage:** Read governance proposals, vote state, execution tracking from major DAOs (Snapshot-powered)
- **Tools:** Proposal aggregation + voting interface (count not published)
- **Gap vs dexe-mcp:** Aggregator-only; no proposal building, signing, or custom DAO support. Snapshot focus excludes on-chain Compound/Governor-based DAOs
- **Audience:** DAO analysts and governance participants
- **Source:** [Tally MCP Deep Dive](https://skywork.ai/skypage/en/tally-mcp-server-dao-governance/1981945161515593728)

### Lido MCP Server (the-wunmi)
- **Coverage:** ETH staking, stETH wrapping, governance voting, withdrawals on L1/L2
- **Tools:** ~12 tools (staking, voting, position tracking)
- **Unique:** Safety-first with dry_run on all writes. Supports Lido DAO governance + token swaps via Uniswap
- **Gap vs dexe-mcp:** Single-protocol binding (Lido only). No treasury, proposal building, or cross-DAO templates
- **Audience:** Lido stakers and DAO participants
- **Source:** [Lido MCP | Glama](https://glama.ai/mcp/servers/the-wunmi/lido-mcp-server)

### DAO Proposals MCP (kukapay)
- **Coverage:** Aggregates live governance proposals from major DAOs in real time
- **Tools:** Proposal search, analysis, voting interface
- **Gap vs dexe-mcp:** Read-only analytics; no deployment, building, or custom DAO chains
- **Source:** [GitHub](https://github.com/kukapay/dao-proposals-mcp)

---

## 2. Adjacent: DeFi & Chain Operations (Not DAO-Specific)

### GOAT On-Chain Agent MCP
- **Coverage:** 200+ on-chain actions spanning DeFi (Uniswap, Jupiter, Orca), NFT (OpenSea, MagicEden), prediction markets, analytics
- **Chains:** Ethereum, Solana, Base, Aptos, Sui, Starknet
- **Unique:** Modular plugin architecture. 100k+ npm downloads. Works with AI SDK, Langchain, Eliza
- **Gap vs dexe-mcp:** No DAO governance, proposal building, or treasury ops. EVM swaps/pools only (no custom governance)
- **Stars:** 398
- **Source:** [GOAT SDK | GitHub](https://github.com/goat-sdk/goat)

### Hive Intelligence Crypto MCP
- **Coverage:** 351 tools across 14 analytics categories: market data (83), on-chain DEX/pools (44), portfolio/wallet (38), token analysis, DeFi protocol metrics, NFT, security, social sentiment
- **Data sources:** CoinGecko, LunarCrash, DefiLlama, GeckoTerminal, Codex, DeBank, GoPlus, GoldRush, CCXT, Finnhub, FRED
- **Gap vs dexe-mcp:** Pure analytics; no transaction building, signing, or DAO ops
- **Audience:** Traders, analysts
- **Source:** [Hive Intelligence | GitHub](https://github.com/hive-intel/hive-crypto-mcp), [hiveintelligence.xyz](https://hiveintelligence.xyz/)

### Dexter MCP (Dexter-DAO)
- **Coverage:** 60+ Solana DeFi tools (wallets, analytics, trading, onchain, codex, Hyperliquid)
- **Transport:** OAuth2/OIDC with SSE streaming
- **Unique:** Production platform (mcp.dexter.cash + open.dexter.cash). Tiered access (guest/member/pro/dev)
- **Gap vs dexe-mcp:** Solana-only; no EVM. No governance, proposals, or DAO treasury
- **Source:** [GitHub](https://github.com/Dexter-DAO/dexter-mcp)

### EVM MCP Server (mcpdotdirect)
- **Coverage:** General EVM chain operations (balance reads, gas estimation, contract ABIs)
- **Chains:** Ethereum and EVM-compatible
- **Gap vs dexe-mcp:** Read-only chain inspection; no governance or complex transactions
- **Source:** [Smithery](https://smithery.ai/servers/@mcpdotdirect/evm-mcp-server)

### Uniswap Trader + Uniswap PoolSpy MCPs (kukapay)
- **Coverage:** Token swap execution, pool discovery, liquidity analytics across 9 blockchains
- **Chains:** Ethereum, Optimism, Polygon, Arbitrum, Celo, BNB Chain, Avalanche, Base
- **Gap vs dexe-mcp:** DEX operations only; no governance or DAO-specific logic
- **Source:** [Uniswap Trader | GitHub](https://github.com/kukapay/uniswap-trader-mcp)

### Web3 MCP (strangelove-ventures)
- **Coverage:** Multi-chain RPC operations (Solana, Ethereum, Cardano, etc.) with per-chain environment controls
- **Unique:** Configurable tool registry via .env; private keys never exposed
- **Gap vs dexe-mcp:** Low-level chain access; no DAO, governance, or protocol-specific tools
- **Source:** [GitHub](https://github.com/strangelove-ventures/web3-mcp)

### OTC / Token Sale MCPs
- **Gala Launchpad MCP:** 241 tools for pool management, token creation, DEX operations
- **PumpSwap MCP:** Solana token swaps
- **Gap vs dexe-mcp:** Vertical launchers, not generalized DAO proposal builders
- **Source:** [Gala | npm](https://www.npmjs.com/package/@gala-chain/launchpad-mcp-server)

---

## 3. Adjacent: Data & Indexing (Not Action-Oriented)

### The Graph Subgraph MCP (kukapay + GraphOps)
- **Coverage:** Access to 15,000+ subgraphs; GraphQL schema inspection; data query execution
- **Tools:** Schema lookup, query executor, subgraph search, deployment stats
- **Unique:** Official Graph Foundation support
- **Gap vs dexe-mcp:** Read-only analytics. dexe-mcp already integrates subgraph querying for proposal/vote reads
- **Source:** [The Graph Docs](https://thegraph.com/docs/en/ai-suite/subgraph-mcp/introduction/), [GitHub](https://github.com/kukapay/thegraph-mcp)

### DefiLlama API MCP (Kryptoskatt, nic0xflamel)
- **Coverage:** DeFi protocol TVL, yield, liquidations, bridge analytics
- **Tools:** Dynamically generated from DefiLlama OpenAPI
- **Gap vs dexe-mcp:** Dashboard metrics only; no transaction building or DAO ops
- **Source:** [Smithery](https://smithery.ai/servers/Kryptoskatt/mcp-server)

### Etherscan MCP Servers (xiaok, ThirdGuard)
- **Coverage:** Account balances, transaction history, token transfers, contract ABIs
- **Chains:** Ethereum and supported EVM chains
- **Gap vs dexe-mcp:** Block explorer read-only; no transaction building
- **Source:** [Smithery](https://smithery.ai/server/@xiaok/etherscan-mcp-server)

### Nodit MCP (NoditLabs)
- **Coverage:** Normalized multi-chain blockchain data access
- **Gap vs dexe-mcp:** Generic chain reads; no governance or DAO-specific logic
- **Source:** [Smithery](https://smithery.ai/server/@noditlabs/nodit-mcp-server)

---

## 4. White Space: Notably Absent

1. **Proposal Builder for Solidity Governance**
   - No MCP builds parameterized proposals for OpenZeppelin Governor, Compound Bravo, or other standard GovernanceToken patterns
   - dexe-mcp is **singular** in supporting 33 proposal types (24 custom DeXe + 9 standard governance ops)
   - **Opportunity:** Generalize dexe-mcp's proposal builder as a reusable Governor/Bravo toolkit

2. **Multi-DAO Treasury & Timelock Simulation**
   - Lido covers staking only; no general treasury ops
   - No MCP simulates multi-sig + timelock + execution flows across DAOs
   - dexe-mcp's simulator (S00–S25) is likely the only end-to-end proposal→execution validation in the ecosystem

3. **IPFS Metadata + Governance Integration**
   - DefiLlama, Hive, and others read IPFS; none **build and upload** proposal metadata
   - dexe-mcp's IPFS gateway + metadata builders (15+ tools) have no parallel

4. **Voting Power Calculations & Delegation**
   - No MCP handles ERC20Votes voting power inference with delegation state, checkpoints, and participation tracking
   - dexe-mcp's delegation tools + power caching are unmatched

5. **Off-Chain Governance Backend Integration**
   - dexe-mcp's integration with dexe.io backend API (quorum per voting_type, privacy policy) has no analog
   - Snapshot (Tally) is read-only; no write-back to custom backend systems

6. **OTC / Token Sale Lifecycle (Beyond Swap)**
   - Gala Launchpad is vertical-only
   - No MCP models vesting, buyer claims, price tiers, and tax in a reusable framework
   - dexe-mcp's OTC Phase A/B (4 composite tools, S41–S46) is novel

7. **Cross-Chain Governance Orchestration**
   - strangelove-ventures web3-mcp supports multiple chains but no governance intent
   - No MCP chains governance actions across Ethereum, BSC, Polygon, etc.

---

## 5. Coverage Matrix

| Feature | dexe-mcp | OpenZeppelin | Tally | Lido | GOAT | Hive | Etherscan | Subgraph |
|---------|----------|--------------|-------|------|------|------|-----------|----------|
| **Proposal Building** | ✓✓✓ (33 types) | ✓ (templates) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **Voting** | ✓ (voting power, delegation) | ✗ | ✓ (read) | ✓ (Lido only) | ✗ | ✗ | ✗ | ✗ |
| **TX Building & Signing** | ✓ | ✗ | ✗ | ✓ (dry_run) | ✓ (swaps/NFTs) | ✗ | ✗ | ✗ |
| **Treasury Ops** | ✓ (withdraw, apply) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **IPFS Metadata** | ✓ (upload + metadata builders) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ (read) |
| **Subgraph Integration** | ✓ | ✗ | ✓ (Snapshot) | ✗ | ✗ | ✗ | ✗ | ✓ |
| **Simulation/Validation** | ✓ (swarm harness) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **Multi-Chain** | ✓ (BSC/ETH) | ✗ | ✗ | ✓ (L1/L2) | ✓ (6+) | ✓ | ✓ | ✓ |
| **Analytics/Data** | ✓ (minimal) | ✗ | ✓ | ✓ | ✓ | ✓✓✓ (351) | ✓ | ✓ |

---

## 6. Competitive Positioning & Recommended Expansion

### dexe-mcp's Unique Strengths
1. **Proposal type breadth:** 33 types vs. zero in competitors
2. **End-to-end lifecycle:** Deploy → propose → vote → execute → treasury (unmatched)
3. **IPFS + metadata builders:** Novel integration
4. **Swarm simulation harness:** Only ecosystem-wide proposal validator
5. **OTC/vesting models:** Rare in MCP landscape

### Recommended White-Space Expansions

1. **Generalize to OpenZeppelin Governor + Compound Bravo**
   - Adapt dexe-mcp's proposal builder to support standard Solidity governance
   - Would capture Ethereum DAOs currently underserved by Tally (read-only) and OpenZeppelin (templates only)
   - Effort: Medium (parameterize proposal types, abstract away DeXe-specific logic)

2. **Subgraph-Agnostic Voting Power Cache**
   - Build a standalone MCP exposing checkpoint reads, delegation state, voting power inference
   - Works with any ERC20Votes-compatible contract + any subgraph
   - Fills gap between Etherscan (raw data) and dexe-mcp (DeXe-specific)
   - Effort: Low–Medium

3. **Treasury + Timelock Simulator**
   - Generalize dexe-mcp's swarm scenarios to multi-sig + Timelock + Governor workflows
   - Enable CI/CD for governance security audits
   - Effort: Medium–High

4. **IPFS Metadata Microservice**
   - Export dexe-mcp's IPFS builder tooling as a standalone MCP
   - Support proposal metadata, DAO metadata, vote rationale archiving
   - Effort: Low

5. **Cross-Chain Governance Intent Relay**
   - Extend web3-mcp with governance-aware tooling for Connext/LayerZero/IBC chains
   - Position for Ethereum, BSC, Polygon, Cosmos ecosystems (unreached today)
   - Effort: High

---

## 7. Notable Gaps & Overlaps in the Ecosystem

| Gap | Why It Matters | dexe-mcp Status |
|-----|----------------|-----------------|
| No reusable Governor proposal builder | Governor-style DAOs (Compound, Uniswap, Aave) have no AI-native proposal toolkit | **Covers 9 standard ops; can generalize** |
| Snapshot dominates, on-chain ignored | Tally aggregates Snapshot; missing on-chain voting on Governor/Bravo | **Covers both; stronger on-chain** |
| IPFS uploading is piecemeal | DefiLlama, Hive read IPFS; none build + upload metadata atomically | **Unique strength** |
| Voting power is a black box | Etherscan shows balances; no MCP explains delegation + checkpoints + quorum | **Can export as standalone MCP** |
| Simulation is missing | No MCP validates proposals end-to-end before broadcasting | **Swarm harness is unique** |
| OTC is swap-only | Gala, PumpSwap do immediate swaps; no vesting, claims, or tiered pricing | **Phase A/B is novel** |

---

## Conclusion

The MCP ecosystem is **rich in analytics and DEX operations** (GOAT, Hive, Uniswap) but **barren in governance tooling**. dexe-mcp is the **only ecosystem player** combining proposal building (33 types), voting, treasury, simulation, and IPFS in one surface. 

**Expansion into OpenZeppelin Governor / Compound Bravo governance** (while reusing dexe-mcp's core architecture) would capture the Ethereum DAO ecosystem currently underserved by Tally (read-only, Snapshot-biased) and OpenZeppelin (templates, no execution). This represents the highest-ROI expansion vector.

**Date:** May 2026  
**Sources:** Smithery.ai, Glama.ai, GitHub API, official docs (see inline citations)
