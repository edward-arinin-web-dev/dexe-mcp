# dexe-mcp Playbook — intent → exact call

The one-page map from "what the user wants" to "the tool call that does it".
Written for AI assistants: every common journey is ONE composite call — do not
hand-sequence approve/deposit/create calldata, and do not read this repo's
source to figure out parameters. Also served as the MCP resource `dexe://playbook`.

**Ground rules**

- Amounts: digits-only string = RAW smallest units (wei); string with a decimal
  point (`"12.5"`) = human units, scaled by the token's REAL decimals (read
  on-chain — never assumed 18). Both forms work everywhere an amount is accepted.
- Durations/delays: SECONDS (`86400` = 1 day). Quorum/percent params on
  composites: plain percent numbers (`51`). Raw protocol units only in ADVANCED
  structs (quorum 25-dec ×1e25, sale rates ×1e25, multipliers ×1e25).
- Chains: 56 = BSC mainnet, 97 = BSC testnet. Validate on 97 first; every read
  tool takes an optional `chainId`.
- No signer configured? Every write returns ordered unsigned `TxPayload`s + a
  WalletConnect QR — scan, approve on the phone, re-run. Nothing is lost.
- Partial failure? Composites return `mode:"failed"` with `failure.landedSteps`
  (txs that DID land), the actionable error, and `resume` guidance. Fix the
  cause and re-run the SAME call — completed steps (approve/deposit) are
  detected on-chain and skipped.

## Intent → call

| User says | Call | Minimal params |
|---|---|---|
| "Who am I / what's set up / which DAOs do I have?" | `dexe_context` | `{}` |
| "Something's failing / set this up" | `dexe_doctor` → `/dexe-setup` | `{}` |
| "Create a DAO" | `dexe_dao_create` | `{daoName, symbol, totalSupply:"1000000", chainId:97}` — preview first; add `confirm:true` when the user already approved |
| "Show DAO info / treasury / settings" | `dexe_dao_info` / `dexe_read_treasury` / `dexe_read_settings` | `{govPool}` (+ `chainId`) |
| "Create a proposal to …" (ANY type) | `dexe_proposal_create` | `{govPool, title, proposalType, params:{…}}` (see type table) |
| "Send/transfer treasury tokens to X" | `dexe_proposal_create` | `proposalType:"token_transfer"`, `params:{token, recipient, amount:"1000.0"}` |
| "Change voting settings/quorum/duration" | `dexe_proposal_create` | `proposalType:"change_voting_settings"`, `params:{govSettings, settings:[…], settingsIds:["1"]}` |
| "Add/remove an expert" | `dexe_proposal_create` | `proposalType:"add_expert"/"remove_expert"`, `params:{expertNftContract, scope, nominatedUser}` |
| "Delegate treasury to an expert" | `dexe_proposal_create` | `proposalType:"delegate_to_expert"`, `params:{expert, amount}` |
| "Vote on / pass / execute proposal N" | `dexe_proposal_vote_and_execute` | `{govPool, proposalId}` — auto-deposits, auto-executes |
| "What state is proposal N in?" | `dexe_proposal_state` / `dexe_proposal_list` | `{govPool, proposalId}` |
| "Run an OTC / token sale" | `dexe_otc_dao_open_sale` | `{govPool, tokenSaleProposal, tiers:[…]}` then vote_and_execute |
| "Buy from the sale / claim my tokens" | `dexe_otc_buyer_buy` / `dexe_otc_buyer_claim_all` | `{tokenSaleProposal, tierId, tokenToBuyWith, amount}` |
| "What sales does this DAO have?" | `dexe_otc_list_sales_for_dao` / `dexe_otc_buyer_status` | `{govPool}` / `{tokenSaleProposal, tierIds, user}` |
| "Update the DAO profile/avatar" | `dexe_proposal_create` | `proposalType:"modify_dao_profile"`, pass only the fields to change; avatar via LOCAL `newAvatarPath` |
| "Send this transaction" | `dexe_tx_send` | the TxPayload fields; check with `dexe_tx_status` |
| "Vote on Uniswap/Compound/OP governance" | `dexe_gov_*` surface | needs `DEXE_TOOLSETS=…,governor` |

## proposalType reference (`dexe_proposal_create`)

Pass type-specific inputs in `params`. Wired types (all 33 catalog entries):

**Treasury / tokens**
- `token_transfer` `{token, recipient, amount, isNative?}` — treasury → recipient.
- `withdraw_treasury` `{receiver, token?, amount?, nftAddress?, nftIds?}` — ERC20 and/or NFTs.
- `apply_to_dao` `{token, receiver, amount, treasuryBalance?}` — grant; mints shortfall when treasury is short.
- `token_distribution` `{distributionProposal, proposalId, token, amount, isNative?}` — pro-rata airdrop to voters.

**Governance config**
- `change_voting_settings` `{govSettings, settings:[fullSettingsStruct], settingsIds?}` — edit (with ids) or add.
- `new_proposal_type` / `enable_staking` `{govSettings, settings, executors, newSettingId}` — newSettingId = current settings length (`dexe_read_settings`).
- `change_math_model` `{newVotePower}` — swap LINEAR/POLYNOMIAL/custom power contract.
- `manage_validators` / `validators_allocation` `{govValidators, changes:[{user, balance}]}` — balance 0 removes.

**Experts / delegation**
- `add_expert` / `remove_expert` `{expertNftContract, scope:"local"|"global", nominatedUser, uri?}`
  (aliases: `add_local_expert`, `add_global_expert`, `remove_local_expert`, `remove_global_expert` — no scope needed).
- `delegate_to_expert` / `revoke_from_expert` `{expert, amount, nftIds?}` (aliases `delegate_tokens_to_expert` / `revoke_tokens_from_expert`).

**Token sale / staking**
- `token_sale` `{tokenSaleProposal, tiers:[tierSpec], latestTierId?}` — prefer `dexe_otc_dao_open_sale` for the full journey.
- `token_sale_whitelist` `{tokenSaleProposal, requests:[{tierId, users, uri?}]}` — extend a live tier's whitelist.
- `token_sale_recover` `{tokenSaleProposal, tierIds}` — recover unsold tokens.
- `create_staking_tier` `{stakingProposal, rewardToken, rewardAmount, startedAt, deadline, stakingMetadataUrl, isNative?}`.

**Token controls**
- `blacklist` `{erc20Gov, addAddresses?, removeAddresses?}`.
- `reward_multiplier` `{mode:"set_address"|"mint"|"change_token"|"set_token_uri", …}` — multiplier ×1e25 (1.5x = 1.5e25), rewardPeriod seconds.

**Profile / raw**
- `modify_dao_profile` — top-level fields (`newDaoName`, `newDaoDescription`, `newWebsiteUrl`, `newSocialLinks`, `newAvatarPath`), NOT in `params`. Partial updates merge with current metadata.
- `custom` — your own `actionsOnFor:[{executor, value?, data}]`.
- `custom_abi` `{target, signature, method, args?, value?}` — one encoded call.

**Internal (validators-only — auto-routed to GovValidators, no deposit)**
- `change_validator_balances` `{changes:[{user, balance}]}`
- `change_validator_settings` `{duration, executionDelay, quorum}` (quorum 10^27 scale)
- `monthly_withdraw` `{withdrawals:[{token, amount}], destination}`
- `offchain_internal_proposal` `{}`
Only a CURRENT validator can create these; validators vote with their own balances.

**Off-chain (backend — rejected with instructions)**
`offchain_single_option` / `offchain_multi_option` / `offchain_for_against` live on
api.dexe.io, not on-chain: build with `dexe_proposal_build_offchain_*`, authenticate
via `dexe_auth_request_nonce` → wallet-sign → `dexe_auth_login_request`, then send the
returned HTTP request with the Bearer token. Mainnet DAOs only.

## Error → remedy

| Error contains | What it means | Do this |
|---|---|---|
| `DEXE_PINATA_JWT is required` | Uploads need a Pinata key | Free key at app.pinata.cloud (pinJSONToIPFS + pinFileToIPFS) → `.env` → RESTART Claude Code. `/dexe-setup` walks through it |
| `insufficient funds for gas` | Signer has no BNB | Fund it; testnet 97: https://www.bnbchain.org/en/testnet-faucet |
| `not mined within …s` | Tx stuck/slow | `dexe_tx_status {txHash}`; re-run only if `not_found`. Never blind-resend |
| `REVERTED on-chain (status 0)` | Mined but failed; state unchanged | Read the revert reason; common: wrong proposal state, tokens locked, blacklisted recipient. Fix, re-run same call |
| `No voting power available` | 0 tokens deposited AND in wallet | Acquire the DAO's gov token; `vote_and_execute` auto-deposits wallet tokens by default |
| `voting is only possible in "Voting"` | Proposal past/pre voting | The error names the remedy per state (execute / wait / new proposal) |
| `is not a registered DeXe GovPool` | Wrong/fake govPool address | Re-check the address with `dexe_dao_registry_lookup` |
| `rate-limit / 429 / SERVER_ERROR` | Public RPC flaked (already retried) | Re-run; set own RPC in `.env` (`DEXE_RPC_URL_MAINNET/_TESTNET`, comma-list = auto-failover) |
| `tokens locked` after an execute | Voted tokens stay locked per proposal | `dexe_vote_build_withdraw` between proposals, then proceed |
| tool not found (`dexe_…`) | Toolset gated off | `dexe_context` lists hidden sets; set `DEXE_TOOLSETS` in `.env` + restart |

## Toolsets (DEXE_TOOLSETS, default `core,proposals`)

| Set | Unlocks |
|---|---|
| core (default) | context, doctor, dao_create, dao_info, treasury/settings reads, tx_send/status, WalletConnect, all OTC composites, IPFS uploads |
| proposals (default) | proposal_create (all types), every proposal_build_*, vote_and_execute, proposal_state/list, vote power reads |
| read | subgraph reads (members, delegation map, validator list), proposal_forecast, risk_assess, user_inbox |
| vote | delegate/undelegate, claim_rewards, staking, NFT multiplier, cancel_vote, validator votes |
| governor | dexe_gov_* for external OZ/Compound Governor DAOs |
| dev | compile + ABI introspection, dao_build_deploy (raw), simulate/decode, merkle, safe |

`DEXE_TOOLSETS=full` loads everything. Change requires a Claude Code restart.

## Signer bootstrap (first write)

1. **WalletConnect (recommended)** — zero config: any write (or `dexe_wc_connect`)
   prints a QR; scan with a mobile wallet (MetaMask/Trust/SafePal), approve each tx
   on the phone. Keys never touch this machine.
2. **Hot key (NOT SAFE — throwaway wallets only)** — `DEXE_PRIVATE_KEY=0x…` in `.env`
   + restart. Plaintext on disk; never a treasury or personal key.
3. **Gas**: the signer needs BNB on the target chain. Testnet 97 faucet:
   https://www.bnbchain.org/en/testnet-faucet (alt: https://faucet.quicknode.com/binance-smart-chain/bnb-testnet).
   Mainnet fees are cents (~0.1 gwei), not Ethereum-scale.

## The golden path (fresh investor, testnet rehearsal → mainnet)

```
dexe_dao_create {daoName:"…", symbol:"…", totalSupply:"1000000", chainId:97}   → preview
dexe_dao_create {…same…, confirm:true}                                          → deployed (predictedGovPool)
dexe_proposal_create {govPool, title:"…", proposalType:"token_transfer",
                      params:{token, recipient, amount:"100.0"}}                → proposal #1 (auto-votes your power)
dexe_proposal_vote_and_execute {govPool, proposalId:1}                          → executed
dexe_otc_dao_open_sale {govPool, tokenSaleProposal, tiers:[…]}                  → sale proposal → vote_and_execute → live
dexe_otc_buyer_buy {tokenSaleProposal, tierId:"1", tokenToBuyWith, amount:"50.0"}
```
Repeat on `chainId:56` when green. DAOs deployed by `dexe_dao_create` already have the
TokenSale + Distribution executors wired — OTC works immediately after deploy.
