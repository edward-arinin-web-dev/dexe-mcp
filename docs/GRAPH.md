# The DeXe subgraphs — entity reference for `dexe_graph_query`

Also served in-band as the MCP resource `dexe://graph-schema`; usage rules +
source-picking guidance: `dexe_guide {flow:"read_dao_data"}`.

Three subgraphs index DeXe Protocol. `dexe_graph_query` runs any read-only
GraphQL document against them.

## Which chain am I querying?

**One endpoint indexes one chain.** The shipped zero-config endpoints (The Graph
decentralized gateway) index **BSC mainnet, chain 56** — that is the coverage
you get out of the box, not a property of the subgraphs themselves.

- Every subgraph-backed tool takes **`chainId`** (default: the MCP's default
  chain) and every response carries **`indexedChainId`** — the chain the rows
  actually came from. Read it; don't assume.
- Endpoints resolve per *(kind, chain)*: `DEXE_SUBGRAPH_<KIND>_URL_<chainId>`
  first, then the unsuffixed `DEXE_SUBGRAPH_<KIND>_URL` for the chain named by
  `DEXE_SUBGRAPH_CHAIN_ID` (default 56), then the baked chain-56 default.
- A chain with no endpoint **errors** — it is never served from another chain's
  index. The message names the var to set and the on-chain alternatives
  (`dexe_read_gov_state` / `dexe_proposal_list` / `dexe_read_multicall`), which
  need no subgraph. BSC testnet (97) has no published DeXe subgraph, so it lands
  here unless you point the vars at your own indexer.

Full env reference: [ENVIRONMENT.md § 8](./ENVIRONMENT.md#8-subgraph-configuration).

Rules of thumb:
- ALWAYS bound list fields with `first:` (gateway max 1000) and paginate with `skip:`.
- Entity IDs are `Bytes` — lowercased hex, often CONCATENATED (no separators):
  `VoterInPool.id` = voter+pool, `VoterInPoolPair.id` = pool+delegator+delegatee,
  pools `Proposal.id` = pool + uint32-LE(proposalId), interaction entity ids = txHash + interactionCount.
- Filter through relations with the `_` suffix: `where: { transaction_: { timestamp_gt: $t } }`.
- Amounts are wei-scale `BigInt` strings; `*USD` fields are BigDecimal strings.
- `transactions.type` / `interactionType` are numeric enums — label maps ship in
  `src/lib/interactionTypes.ts` (3 = DAO_POOL_CREATED, 4 = PROPOSAL_CREATED, 5 = VOTED,
  7 = EXECUTED, 14 = DEPOSITED, …; interactionType: 1 = VOTE_FOR, 2 = VOTE_AGAINST, 3 = VOTE_CANCEL).
- pools `Proposal` has NO creation timestamp — for time-windowed activity use the
  interactions subgraph (`daoProposalCreates` + `transaction_.timestamp_gt`).

Worked examples — each runs as
`dexe_graph_query { subgraph: "<named below>", chainId: 56, query: "…" }`; the
result reports `indexedChainId: 56` back:

```graphql
# Most active DAOs, last 30 days (subgraph: interactions)
query Active($since: BigInt!) {
  daoProposalCreates(first: 500, where: { transaction_: { timestamp_gt: $since } }) {
    pool { id }
    transaction { timestamp }
  }
}

# Biggest token-sale buys ever (subgraph: pools)
{ tokenSaleTierBuyHistories(first: 10, orderBy: paidAmount, orderDirection: desc) {
    buyer { id } paidAmount givenAmount tier { tierId } } }

# All validators of one DAO (subgraph: validators)
{ validatorInPools(first: 50, where: { pool: "0x…" }, orderBy: balance, orderDirection: desc) {
    validatorAddress balance } }
```

## `pools` subgraph — DAOs, proposals, voters, delegations, experts, token sales

### DPContract
```
id: Bytes!
daoPool: Bytes!
```

### DaoPool
```
id: Bytes!
name: String!
userKeeper: Bytes!
erc20Token: Bytes!
erc721Token: Bytes!
nftMultiplier: Bytes!
votersCount: BigInt!
creationTime: BigInt!
creationBlock: BigInt!
proposalCount: BigInt!
totalCurrentTokenDelegated: BigInt!
totalCurrentNFTDelegated: [BigInt!]!
totalCurrentTokenDelegatedTreasury: BigInt!
totalCurrentNFTDelegatedTreasury: [BigInt!]!
totalCurrentTokenDelegatees: BigInt!
totalCurrentNFTDelegatees: BigInt!
offchainResultsHash: String!
voters: [VoterInPool!]!
proposals: [Proposal!]!
settings: [ProposalSettings!]!
executors: [Executor!]!
```

### DelegationHistory
```
id: Bytes!
timestamp: BigInt!
delegator: Voter!
delegatee: Voter!
type: BigInt!
amount: BigInt!
nfts: [BigInt!]!
pool: DaoPool!
pair: VoterInPoolPair!
```

### Executor
```
id: Bytes!
executorAddress: Bytes!
settings: ProposalSettings!
pool: DaoPool!
```

### ExpertNft
```
id: Bytes!
tokenId: BigInt!
tags: [String!]!
```

### ExpertNftContract
```
id: Bytes!
daoPool: DaoPool!
```

### InteractionCount
```
id: Bytes!
count: BigInt!
```

### Proposal
```
id: Bytes!
proposalId: BigInt!
creator: Voter!
isFor: Boolean!
executor: Bytes!
executionTimestamp: BigInt!
executionHash: Bytes!
quorumReachedTimestamp: BigInt!
rewardToken: Bytes!
currentVotesFor: BigInt!
currentVotesAgainst: BigInt!
quorum: BigInt!
description: String!
votersVoted: BigInt!
voters: [Voter!]!
pool: DaoPool!
settings: ProposalSettings!
interactions: [ProposalInteraction!]!
```

### ProposalInteraction
```
id: Bytes!
hash: Bytes!
timestamp: BigInt!
interactionType: BigInt!
totalVote: BigInt!
voter: VoterInProposal!
proposal: Proposal!
```

### ProposalSettings
```
id: Bytes!
settingsId: BigInt!
executorDescription: String!
executors: [Executor!]!
pool: DaoPool!
```

### SettingsContract
```
id: Bytes!
daoPool: Bytes!
```

### TokenSaleContract
```
id: Bytes!
daoPool: Bytes!
tiers: [TokenSaleTier!]!
```

### TokenSaleTier
```
id: Bytes!
creationHash: Bytes!
saleToken: Bytes!
whitelistTypes: [BigInt!]!
data: [Bytes!]!
whitelist: [Bytes!]!
totalBuyersCount: BigInt!
buyers: [VoterInPool!]!
tokenSale: TokenSaleContract!
```

### TokenSaleTierBuyHistory
```
id: Bytes!
hash: Bytes!
timestamp: BigInt!
paidToken: Bytes!
givenAmount: BigInt!
receivedAmount: BigInt!
buyer: VoterInPool!
tier: TokenSaleTier!
```

### TreasuryDelegationHistory
```
id: Bytes!
timestamp: BigInt!
delegatee: VoterInPool!
type: BigInt!
amount: BigInt!
nfts: [BigInt!]!
pool: DaoPool!
```

### UserKeeperContract
```
id: Bytes!
daoPool: Bytes!
```

### Voter
```
id: Bytes!
expertNft: ExpertNft
totalProposalsCreated: BigInt!
totalMicropoolRewardUSD: BigInt!
totalClaimedUSD: BigInt!
totalDelegatedUSD: BigInt!
totalLockedFundsUSD: BigInt!
totalVotedProposals: BigInt!
totalVotes: BigInt!
currentVotesDelegated: BigInt!
currentVotesReceived: BigInt!
delegateesCount: BigInt!
delegatorsCount: BigInt!
pools: [VoterInPool!]!
createdProposals: [Proposal!]!
```

### VoterInPool
```
id: Bytes!
joinedTimestamp: BigInt!
expertNft: ExpertNft
receivedDelegation: BigInt!
receivedNFTDelegation: [BigInt!]!
receivedNFTDelegationCount: BigInt!
receivedTreasuryDelegation: BigInt!
receivedTreasuryNFTDelegation: [BigInt!]!
receivedTreasuryNFTDelegationCount: BigInt!
totalLockedUSD: BigInt!
totalClaimedUSD: BigInt!
totalPersonalVotingRewardUSD: BigInt!
totalMicropoolVotingRewardUSD: BigInt!
totalTreasuryVotingRewardUSD: BigInt!
engagedProposalsCount: BigInt!
currentDelegateesCount: BigInt!
currentDelegatorsCount: BigInt!
APR: BigInt!
_cusum: BigInt!
_lastUpdate: BigInt!
pool: DaoPool!
voter: Voter!
proposals: [VoterInProposal!]!
treasuryDelegationHistory: [TreasuryDelegationHistory!]!
```

### VoterInPoolPair
```
id: Bytes!
creationTimestamp: BigInt!
delegator: VoterInPool!
delegatee: VoterInPool!
delegatedVotes: BigInt!
delegatedAmount: BigInt!
delegatedUSD: BigInt!
delegatedNfts: [BigInt!]!
history: [DelegationHistory!]!
```

### VoterInProposal
```
id: Bytes!
isVoteFor: Boolean!
claimed: Boolean!
totalVote: BigInt!
staticRewardUSD: BigInt!
personalVotingRewardUSD: BigInt!
micropoolVotingRewardUSD: BigInt!
treasuryVotingRewardUSD: BigInt!
micropoolRewardUSD: BigInt!
claimedRewardUSD: BigInt!
pool: DaoPool!
proposal: Proposal!
voter: VoterInPool!
interactions: [ProposalInteraction!]!
```

## `interactions` subgraph — flat per-user/per-event feed — every on-chain touch as its own entity + a Transaction envelope with numeric type[]

### DaoPoolCreate
```
id: Bytes!
pool: Pool!
name: String!
transaction: Transaction!
```

### DaoPoolDelegate
```
id: Bytes!
pool: Pool!
amount: BigInt!
transaction: Transaction!
```

### DaoPoolExecute
```
id: Bytes!
pool: Pool!
proposalId: BigInt!
transaction: Transaction!
```

### DaoPoolMovedToValidators
```
id: Bytes!
pool: Pool!
proposalId: BigInt!
transaction: Transaction!
```

### DaoPoolOffchainResultsSaved
```
id: Bytes!
pool: Pool!
transaction: Transaction!
```

### DaoPoolProposalInteraction
```
id: Bytes!
pool: Pool!
totalVote: BigInt!
interactionType: BigInt!
transaction: Transaction!
```

### DaoPoolRewardClaim
```
id: Bytes!
pool: Pool!
proposalId: BigInt!
transaction: Transaction!
```

### DaoPoolTreasuryDelegate
```
id: Bytes!
pool: Pool!
amount: BigInt!
transaction: Transaction!
```

### DaoPoolVest
```
id: Bytes!
pool: Pool!
nfts: [BigInt!]!
amount: BigInt!
transaction: Transaction!
```

### DaoPoolVotingRewardClaim
```
id: Bytes!
pool: Pool!
proposalId: BigInt!
transaction: Transaction!
```

### DaoProposalCreate
```
id: Bytes!
pool: Pool!
proposalId: BigInt!
transaction: Transaction!
```

### DaoValidatorProposalCreate
```
id: Bytes!
pool: Pool!
proposalId: BigInt!
transaction: Transaction!
```

### DaoValidatorProposalExecute
```
id: Bytes!
pool: Pool!
proposalId: BigInt!
transaction: Transaction!
```

### DaoValidatorProposalVote
```
id: Bytes!
pool: Pool!
proposalId: BigInt!
isVoteFor: Boolean!
amount: BigInt!
transaction: Transaction!
```

### Pool
```
id: Bytes!
```

### Transaction
```
id: Bytes!
timestamp: BigInt!
block: BigInt!
type: [BigInt!]!
user: Bytes!
interactedWithPool: Pool!
interactionsCount: BigInt!
daoPoolCreate: [DaoPoolCreate!]!
daoPoolDelegate: [DaoPoolDelegate!]!
daoPoolProposalInteraction: [DaoPoolProposalInteraction!]!
daoProposalCreate: [DaoProposalCreate!]!
daoPoolExecute: [DaoPoolExecute!]!
daoPoolRewardClaim: [DaoPoolRewardClaim!]!
daoPoolVest: [DaoPoolVest!]!
daoPoolMovedToValidators: [DaoPoolMovedToValidators!]!
daoPoolOffchainResultsSaved: [DaoPoolOffchainResultsSaved!]!
daoValidatorProposalCreate: [DaoValidatorProposalCreate!]!
daoValidatorProposalVote: [DaoValidatorProposalVote!]!
daoValidatorProposalExecute: [DaoValidatorProposalExecute!]!
```

## `validators` subgraph — validator chamber: balances + internal proposals

### DaoPool
```
id: Bytes!
validators: [ValidatorInPool!]!
```

### InteractionCount
```
id: Bytes!
count: BigInt!
```

### Proposal
```
id: ID!
proposalId: BigInt!
isInternal: Boolean!
quorum: BigInt!
validatorsVoted: BigInt!
totalVoteFor: BigInt!
totalVoteAgainst: BigInt!
description: String!
creator: Bytes!
executor: Bytes!
voters: [ValidatorInProposal!]!
```

### ProposalInteraction
```
id: Bytes!
hash: Bytes!
timestamp: BigInt!
proposal: Proposal!
interactionType: BigInt!
amount: BigInt!
voter: ValidatorInProposal!
```

### ValidatorInPool
```
id: Bytes!
validatorAddress: Bytes!
balance: BigInt!
pool: DaoPool!
```

### ValidatorInProposal
```
id: Bytes!
pool: DaoPool!
proposal: Proposal!
validator: ValidatorInPool!
totalVoteFor: BigInt!
totalVoteAgainst: BigInt!
interactions: [ProposalInteraction!]!
```

### ValidatorsContract
```
id: Bytes!
pool: Bytes!
```

