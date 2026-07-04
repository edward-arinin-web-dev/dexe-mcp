---
name: dexe-create-dao
description: |
  Deploy a new DeXe DAO with the one-call `dexe_dao_create` composite. Covers the
  exact param recipe, the decimal conventions, and the four deploy gotchas that
  silently revert (cap>minted, LINEAR initData, non-zero userKeeper asset, mainnet
  treasury remainder). Use when the user says "create/deploy a DAO".
---

# dexe-create-dao

Deploy a DeXe governance DAO in **one tool call** — `dexe_dao_create` handles
avatar → DAO IPFS metadata → `PoolFactory.deployGovPool` (predicted-address
wiring, 1→5 settings auto-expand, executorDescription upload) → broadcast.

## Golden rule: testnet first

**Validate on BSC testnet (chain 97).** Mainnet `deployGovPool` is broken
upstream (`require(false)`). Never spend mainnet BNB on a deploy without the
user explicitly asking. Pass `chainId: 97`.

## Recipe

0. **Orient:** call `dexe_context` first — it shows the signer, active chain,
   env readiness, and DAOs you already deployed (so you don't re-create one).
1. **Confirm chain + signer:** `dexe_get_config` (or the `dexe_context` output).
   Ensure the active/target chain is 97 and `DEXE_PINATA_JWT` is set (required
   for metadata upload).
2. **(Optional) avatar:** `dexe_dao_generate_avatar` or `dexe_ipfs_upload_avatar`
   → take the returned `cid` as `avatarCID`. Must be a **real JPEG**, not SVG
   bytes named `.jpeg` (the frontend gateway rejects the mismatch).
3. **Create:** call `dexe_dao_create` once. `deployer` defaults to the signer.

```jsonc
dexe_dao_create({
  chainId: 97,
  daoName: "Aurora Collective",
  daoDescription: "A community treasury DAO.",   // markdown → slate, uploaded for you
  websiteUrl: "https://aurora.example",
  socialLinks: [["twitter", "https://x.com/aurora"]],
  avatarCID: "bafy…",                             // optional
  params: {
    settingsParams: {
      proposalSettings: [{                        // pass ONE → auto-expands to 5
        earlyCompletion: true,
        delegatedVotingAllowed: false,            // INVERTED: false = delegation ALLOWED
        validatorsVote: false,
        duration: "86400",                        // seconds (1 day)
        durationValidators: "86400",
        executionDelay: "0",
        quorum: "500000000000000000000000000",    // 25-dec wei = 50%
        quorumValidators: "500000000000000000000000000",
        minVotesForVoting: "1000000000000000000", // 18-dec wei = 1 token
        minVotesForCreating: "1000000000000000000",
        rewardsInfo: { rewardToken: "0x0000000000000000000000000000000000000000",
                       creationReward: "0", executionReward: "0", voteRewardsCoefficient: "0" },
        executorDescription: ""                   // auto-uploaded to IPFS
      }]
    },
    userKeeperParams: { tokenAddress: "0x0000000000000000000000000000000000000000",
                        nftAddress: "0x0000000000000000000000000000000000000000",
                        individualPower: "0", nftsTotalSupply: "0" },
    tokenParams: {                                // non-empty name => create a gov token
      name: "Aurora", symbol: "AUR",
      users: ["0xYourAddr"],
      cap: "0",                                   // 0 = uncapped (or > mintedTotal)
      mintedTotal: "1000000000000000000000",      // 1000 tokens (18-dec)
      amounts: ["1000000000000000000000"]         // MUST sum to mintedTotal on mainnet
    },
    votePowerParams: { voteType: "LINEAR_VOTES" }  // initData auto-encoded — do NOT pass it
  }
})
```

## Deploy gotchas (the tool pre-flights these — heed the errors)

1. **cap > mintedTotal** — or `cap = 0` (uncapped). `cap == mintedTotal` reverts
   ERC20Gov init silently (bug #28).
2. **LINEAR initData** — the tool auto-encodes `__LinearPower_init()`
   (`0x892aea1f`). Never pass `initData` for LINEAR/POLYNOMIAL; only CUSTOM_VOTES
   takes a manual `initData`.
3. **Non-zero governance asset** — if not creating a token (`tokenParams.name`
   empty), set `userKeeperParams.tokenAddress` or `.nftAddress`.
4. **Treasury remainder (mainnet)** — `mintedTotal` must equal `sum(amounts)`;
   a remainder reverts on chain 56 (bug #32). Distribute the whole mint.

## Decimal conventions (must match the frontend)

- `quorum`, `quorumValidators`, `voteRewardsCoefficient`: **25-dec** wei (50% = `5e26`).
- `minVotes*`, `cap`, `mintedTotal`, `amounts`, `individualPower`, rewards: **18-dec** wei.
- `duration*`, `executionDelay`: plain **seconds** as string.
- `delegatedVotingAllowed` is **inverted**: `true` DISABLES delegation.

## After deploy

The result includes `predictedGovPool` — that is the DAO's GovPool address once
the tx confirms. Use it for `dexe_proposal_create` / `dexe_proposal_vote_and_execute`.

Related: [[dexe-create-proposal]], [[dexe-vote-execute]].
