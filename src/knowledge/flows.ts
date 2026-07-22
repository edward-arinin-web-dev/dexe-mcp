import type { Flow } from "./types.js";

/**
 * The flow corpus — ordered multi-step journeys through DeXe governance.
 * Each flow is what `dexe_guide` serves as the "detail tier": the interview
 * (questions + risk notes), the exact tool sequence, and the relevant gotchas.
 *
 * Placeholders: `{{name}}` binds to an interview param of that name, or to a
 * prior-step output declared in `bindsFrom` ("stepId.outputField").
 */
export const FLOWS: readonly Flow[] = [
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: "create_dao",
    title: "Create (deploy) a DAO",
    triggers: [
      "create a dao",
      "deploy a dao",
      "new dao",
      "create a token",
      "launch a token",
      "start a dao",
      "governance token",
    ],
    summary:
      "Deploy a new DeXe governance DAO with its gov token in one composite call (preview → confirm → broadcast).",
    chainNotes: {
      56: "MAINNET — the deploy spends real BNB (cents, ~0.1 gwei). Confirm the user accepts mainnet before broadcasting.",
      97: "Testnet rehearsal: free faucet BNB (https://www.bnbchain.org/en/testnet-faucet). Staking, subgraph reads and off-chain proposals do NOT exist on 97.",
    },
    interview: [
      {
        name: "daoName",
        ask: "What should the DAO be called? (public, permanent; also the on-chain pool name)",
        kind: "string",
        required: true,
        constraint: "Non-empty; this deployer must not have used the same name on this chain before.",
      },
      {
        name: "symbol",
        ask: "Gov token symbol? (e.g. 'GENA')",
        kind: "string",
        required: true,
      },
      {
        name: "totalSupply",
        ask: "Total token supply, in whole tokens? (e.g. '1000000')",
        kind: "amount",
        required: true,
        constraint: "> 0. Cap is set equal to minted supply (fixed supply) unless ADVANCED params say otherwise.",
      },
      {
        name: "treasuryPercent",
        ask: "What % of supply should the DAO treasury hold? (the rest goes to your deployer wallet as votable supply)",
        kind: "percent",
        required: false,
        default: "49",
        riskIfUnusual:
          "Treasury tokens CANNOT vote. Treasury > 49% shrinks votable supply below quorum reach — the deploy is " +
          "refused as governance-dead. Treasury 0% means proposals have nothing to spend.",
      },
      {
        name: "quorumPercent",
        ask: "Quorum % required to pass proposals?",
        kind: "percent",
        required: false,
        default: "51",
        riskIfUnusual:
          "Below 50% a small holder group can drain the treasury (blocked-risky without confirmRisky). Above " +
          "100−treasuryPercent the quorum is unreachable and the DAO is dead — the tool refuses.",
        constraint: "50 ≤ quorum ≤ 100 − treasuryPercent",
      },
      {
        name: "durationSeconds",
        ask: "Voting duration per proposal, in seconds? (86400 = 1 day)",
        kind: "duration",
        required: false,
        default: "86400",
        riskIfUnusual: "Very short durations can end voting before holders react; very long ones stall governance.",
      },
      {
        name: "chainId",
        ask: "Which chain — 97 (BSC testnet rehearsal, free) or 56 (BSC mainnet, real BNB)?",
        kind: "string",
        required: false,
        default: "97",
      },
      {
        name: "daoDescription",
        ask: "One-paragraph DAO description for the public profile? (markdown ok; optional)",
        kind: "string",
        required: false,
      },
    ],
    steps: [
      {
        id: "preview",
        tool: "dexe_dao_create",
        purpose: "Preview the resolved config + safety proof (quorum reachability, treasury floor). No broadcast.",
        paramsTemplate: {
          daoName: "{{daoName}}",
          symbol: "{{symbol}}",
          totalSupply: "{{totalSupply}}",
          treasuryPercent: "{{treasuryPercent}}",
          quorumPercent: "{{quorumPercent}}",
          durationSeconds: "{{durationSeconds}}",
          chainId: "{{chainId}}",
          daoDescription: "{{daoDescription}}",
        },
        gotchaIds: ["quorum-reachable", "quorum-floor", "cap-rule", "name-taken"],
        reportOnSuccess:
          "Show the user the preview's resolvedConfig + safetyProof and any warnings; get an explicit go-ahead.",
        next: [{ when: "user confirms the previewed config", stepId: "deploy", why: "broadcast the same config" }],
      },
      {
        id: "deploy",
        tool: "dexe_dao_create",
        purpose: "Broadcast the deploy (same arguments + confirm:true). Signs via hot key or WalletConnect QR.",
        paramsTemplate: { "…same as preview…": "", confirm: "true" },
        gotchaIds: ["treasury-remainder", "five-settings-ids", "votepower-init", "min-votes-coherence"],
        reportOnSuccess:
          "DAO is live. Tell the user: govPool address, tx hash, and the profile link " +
          "https://app.dexe.io/dao/{{govPool}} (mainnet UI). Your deployer wallet now holds the votable supply; " +
          "the treasury holds the remainder.",
        bindsFrom: { govPool: "deploy.predictedGovPool" },
        next: [{ when: "the user wants a first proposal", stepId: "preview", why: "see flow create_proposal" }],
      },
    ],
    gotchaIds: ["amount-conventions", "testnet-first", "reward-commission", "delegated-voting-inverted"],
  },

  // ──────────────────────────────────────────────────────────────────────────
  {
    id: "create_proposal",
    title: "Create a governance proposal (any type)",
    triggers: [
      "create a proposal",
      "make a proposal",
      "transfer treasury",
      "send tokens from the dao",
      "change voting settings",
      "add an expert",
      "blacklist",
      "propose",
    ],
    summary:
      "Create ANY of the 33 catalog proposal types with one dexe_proposal_create call — it handles approve → deposit → create + IPFS metadata.",
    interview: [
      {
        name: "govPool",
        ask: "Which DAO (govPool address)? If we just created one this session, confirm reusing it.",
        kind: "address",
        required: true,
      },
      {
        name: "proposalType",
        ask: "What should the proposal DO? (map the user's intent to a proposalType via dexe_proposal_catalog — e.g. token_transfer, change_voting_settings, add_expert)",
        kind: "string",
        required: true,
      },
      {
        name: "title",
        ask: "Proposal title (public)?",
        kind: "string",
        required: true,
      },
      {
        name: "description",
        ask: "Short proposal description for voters? (optional but recommended)",
        kind: "string",
        required: false,
      },
    ],
    steps: [
      {
        id: "pick_type",
        tool: "dexe_proposal_catalog",
        purpose:
          "Only when unsure which proposalType matches the intent: list all 33 types with their target + effect. " +
          "The per-type params shapes are in dexe_proposal_create's description and docs/PLAYBOOK.md.",
        paramsTemplate: {},
        optionalWhen: "the proposalType is already obvious from the user's request",
        reportOnSuccess: "Confirm the chosen type + params with the user before creating.",
        next: [{ when: "type + params confirmed", stepId: "create", why: "run the composite" }],
      },
      {
        id: "create",
        tool: "dexe_proposal_create",
        purpose: "Approve → deposit → createProposalAndVote in one call, with correct IPFS metadata.",
        paramsTemplate: {
          govPool: "{{govPool}}",
          title: "{{title}}",
          proposalType: "{{proposalType}}",
          params: "{ …type-specific, see dexe_proposal_create description… }",
        },
        gotchaIds: [
          "deposit-sequence",
          "approve-userkeeper",
          "low-creating-power-race",
          "spherex-create-pattern",
          "blacklist-execute-trap",
        ],
        bindsFrom: { proposalId: "create.proposalId" },
        reportOnSuccess:
          "Proposal #{{proposalId}} created (your voting power auto-voted FOR). Link: " +
          "https://app.dexe.io/dao/{{govPool}} → Proposals. Next: other members vote; when quorum is reached, " +
          "execute via flow vote_execute.",
        next: [{ when: "quorum reached or user asks to pass it", stepId: "create", why: "see flow vote_execute" }],
      },
    ],
    gotchaIds: ["amount-conventions", "spherex-addsettings", "settings-ids-semantics", "vp-locked"],
  },

  // ──────────────────────────────────────────────────────────────────────────
  {
    id: "vote_execute",
    title: "Vote on / pass / execute a proposal",
    triggers: [
      "vote on proposal",
      "execute proposal",
      "pass the proposal",
      "vote for",
      "vote against",
      "finish the proposal",
      "validator vote",
    ],
    summary:
      "Vote and execute in one dexe_proposal_vote_and_execute call — auto-deposits when power is short and auto-drives the validator round.",
    interview: [
      { name: "govPool", ask: "Which DAO (govPool address)?", kind: "address", required: true },
      { name: "proposalId", ask: "Which proposal id?", kind: "string", required: true },
      {
        name: "support",
        ask: "Vote FOR or AGAINST?",
        kind: "boolean",
        required: false,
        default: "for",
      },
    ],
    steps: [
      {
        id: "check_state",
        tool: "dexe_proposal_state",
        purpose: "Read the current ProposalState first — the valid action depends on it.",
        paramsTemplate: { govPool: "{{govPool}}", proposalId: "{{proposalId}}" },
        gotchaIds: ["state-enum"],
        reportOnSuccess: "Tell the user the state in words (Voting / awaiting validators / ready to execute / …).",
        next: [{ when: "state is Voting or Succeeded*", stepId: "vote_execute", why: "drive it to executed" }],
      },
      {
        id: "vote_execute",
        tool: "dexe_proposal_vote_and_execute",
        purpose:
          "Vote with full available power (auto-deposit if needed), then — when quorum passes — move to validators, " +
          "drive the validator round (if the signer is a validator), and execute.",
        paramsTemplate: { govPool: "{{govPool}}", proposalId: "{{proposalId}}" },
        gotchaIds: ["validator-leg", "spherex-vote-multicall", "validator-cancel-blocked"],
        reportOnSuccess:
          "Report the final state (ExecutedFor = done; ValidatorVoting = waiting on other validators; Voting = " +
          "quorum not yet reached — say how much power is still missing). Link: https://app.dexe.io/dao/{{govPool}}.",
      },
      {
        id: "unlock",
        tool: "dexe_vote_build_withdraw",
        purpose: "After execution, withdraw the voted tokens so they're free for the next proposal.",
        paramsTemplate: { govPool: "{{govPool}}" },
        optionalWhen: "the user will create/vote more proposals right away — otherwise skippable",
        gotchaIds: ["vp-locked"],
        reportOnSuccess: "Tokens unlocked and back in the wallet.",
      },
    ],
    gotchaIds: ["delegation-one-level"],
  },

  // ──────────────────────────────────────────────────────────────────────────
  {
    id: "token_distribution",
    title: "Airdrop to voters (pro-rata distribution)",
    triggers: [
      "airdrop",
      "distribute to voters",
      "token distribution",
      "reward voters",
      "pro-rata distribution",
    ],
    summary:
      "A distribution proposal splits a token amount pro-rata among whoever VOTES on it — this is NOT a payout to a fixed address list.",
    interview: [
      { name: "govPool", ask: "Which DAO (govPool address)?", kind: "address", required: true },
      {
        name: "token",
        ask: "Which token to distribute (address), and is it native BNB?",
        kind: "address",
        required: true,
      },
      {
        name: "amount",
        ask: "Total amount to distribute among voters?",
        kind: "amount",
        required: true,
        riskIfUnusual: "The whole amount leaves the treasury at execute; shares depend on final vote weights.",
      },
    ],
    steps: [
      {
        id: "confirm_intent",
        tool: "dexe_proposal_catalog",
        purpose:
          "SANITY GATE: confirm the user wants a pro-rata airdrop to VOTERS. If they named specific recipient " +
          "addresses, STOP — use token_transfer proposals (or deploy-time distribution) instead.",
        paramsTemplate: {},
        optionalWhen: "the user explicitly said 'pro-rata to voters'",
        gotchaIds: ["distribution-vs-transfer"],
        reportOnSuccess: "Intent confirmed: pro-rata to voters.",
        next: [{ when: "confirmed", stepId: "predict", why: "need the DistributionProposal executor address" }],
      },
      {
        id: "predict",
        tool: "dexe_dao_predict_addresses",
        purpose: "Fetch the DAO's DistributionProposal executor address.",
        paramsTemplate: { daoName: "…the DAO's name…", chainId: "…" },
        bindsFrom: { distributionProposal: "predict.distributionProposal" },
        reportOnSuccess: "Got the distribution executor.",
        next: [{ when: "always", stepId: "create", why: "create the distribution proposal" }],
      },
      {
        id: "create",
        tool: "dexe_proposal_create",
        purpose: "Create the distribution proposal (proposalId self-computes to latest+1).",
        paramsTemplate: {
          govPool: "{{govPool}}",
          title: "…",
          proposalType: "token_distribution",
          params: "{ distributionProposal: {{distributionProposal}}, token: {{token}}, amount: {{amount}} }",
        },
        gotchaIds: ["distribution-full-duration"],
        reportOnSuccess:
          "Distribution proposal live. IMPORTANT: voting runs the FULL duration (no early completion) — execute " +
          "only after voteEnd. Voters claim their share afterwards via dexe_vote_build_distribution_claim.",
      },
    ],
    gotchaIds: ["distribution-vs-transfer", "amount-conventions"],
  },

  // ──────────────────────────────────────────────────────────────────────────
  {
    id: "otc_sale",
    title: "Open an OTC / token sale",
    triggers: [
      "otc",
      "token sale",
      "sell dao tokens",
      "open a sale",
      "fundraise",
      "buy from the sale",
      "claim purchased tokens",
    ],
    summary:
      "Open a multi-tier token sale (proposal → vote → execute → live), then buyers check status / buy / claim via the dexe_otc_* composites.",
    interview: [
      { name: "govPool", ask: "Which DAO (govPool address)?", kind: "address", required: true },
      {
        name: "saleTokenAmount",
        ask: "How many DAO tokens to sell in this tier?",
        kind: "amount",
        required: true,
        riskIfUnusual: "This amount moves from the treasury into the sale at execute.",
      },
      {
        name: "price",
        ask: "Price per DAO token, and in which purchase token (address, or native BNB)?",
        kind: "string",
        required: true,
        riskIfUnusual:
          "Rates are stored ×1e25 on-chain — always pass human units and let the composite scale; a mis-scaled " +
          "hand-made rate can sell the allocation for pennies.",
      },
      {
        name: "saleWindow",
        ask: "Sale start and end times? (ask in the user's words — e.g. 'starts tomorrow, runs 7 days' — then compute Unix seconds from the CURRENT time; never guess the date)",
        kind: "duration",
        required: true,
        riskIfUnusual:
          "The window must be in the future at EXECUTE time (add voting-period headroom). A past window creates a " +
          "dead tier — every buy reverts.",
      },
      {
        name: "vesting",
        ask: "Vesting? (RECOMMEND 0 on newly deployed DAOs — vested funds are currently unrecoverable there)",
        kind: "percent",
        required: false,
        default: "0",
        riskIfUnusual:
          "vestingWithdraw is blocked by SphereX on fresh pools — a non-zero vestingPercentage strands the vested " +
          "portion (confirmed protocol bug).",
      },
      {
        name: "whitelist",
        ask: "Open to everyone, or a whitelist of addresses?",
        kind: "addressList",
        required: false,
      },
    ],
    steps: [
      {
        id: "open",
        tool: "dexe_otc_dao_open_sale",
        purpose: "Build + create the TokenSaleProposal tiers proposal (auto-uploads merkle whitelist JSON if given).",
        paramsTemplate: {
          govPool: "{{govPool}}",
          tiers: "[ …from interview: saleTokenAmount, price, saleWindow, vesting 0, whitelist… ]",
        },
        gotchaIds: ["timestamps-future", "otc-native-sentinel", "otc-rate-precision", "otc-vesting-broken", "otc-whitelist-merkle"],
        bindsFrom: { proposalId: "open.proposalId", tokenSaleProposal: "open.tokenSaleProposal" },
        reportOnSuccess: "Sale proposal #{{proposalId}} created — now it must pass governance.",
        next: [{ when: "always", stepId: "pass", why: "the sale goes live only after execute" }],
      },
      {
        id: "pass",
        tool: "dexe_proposal_vote_and_execute",
        purpose: "Vote + execute the sale proposal — the tier goes live at execute.",
        paramsTemplate: { govPool: "{{govPool}}", proposalId: "{{proposalId}}" },
        reportOnSuccess: "Sale is LIVE. Link buyers to https://app.dexe.io/dao/{{govPool}}.",
        next: [{ when: "a buyer wants in", stepId: "verify", why: "show live tier state" }],
      },
      {
        id: "verify",
        tool: "dexe_otc_list_sales_for_dao",
        purpose: "Confirm the tier is live and show its parameters (times are UTC).",
        paramsTemplate: { govPool: "{{govPool}}" },
        reportOnSuccess:
          "Report tier id, price, remaining allocation, saleStartTimeUTC/saleEndTimeUTC. Buyers proceed with " +
          "dexe_otc_buyer_status → dexe_otc_buyer_buy → (after sale end) dexe_otc_buyer_claim_all.",
      },
    ],
    gotchaIds: ["amount-conventions"],
  },

  // ──────────────────────────────────────────────────────────────────────────
  {
    id: "staking_setup",
    title: "Set up staking (reward tier)",
    triggers: [
      "staking",
      "stake",
      "staking tier",
      "staking rewards",
      "let holders stake",
    ],
    summary:
      "Create a staking reward tier: resolve/deploy the StakingProposal contract, pass a create_staking_tier proposal, then holders stake and claim.",
    chainNotes: {
      97: "STAKING DOES NOT EXIST ON TESTNET (97) — every testnet GovUserKeeper predates it and " +
        "stakingProposalAddress() reverts. Do NOT attempt staking transactions on 97; run this flow on mainnet " +
        "(chain 56) and tell the user why.",
    },
    interview: [
      { name: "govPool", ask: "Which DAO (govPool address)?", kind: "address", required: true },
      {
        name: "rewardToken",
        ask: "Which token funds the staking rewards (address, or native BNB)?",
        kind: "address",
        required: true,
      },
      {
        name: "rewardAmount",
        ask: "Total reward pool for this tier?",
        kind: "amount",
        required: true,
        riskIfUnusual: "The reward amount must actually be available — an unfunded tier pays nothing.",
      },
      {
        name: "window",
        ask: "Staking start (startedAt) and deadline? (ask in the user's words, then compute Unix seconds from the CURRENT time; never guess the date)",
        kind: "duration",
        required: true,
        riskIfUnusual:
          "A deadline in the past is SILENTLY rejected on-chain: the execute succeeds but NO tier is created and " +
          "the reward returns to the treasury. Deadline must be in the future at EXECUTE time (add voting-period headroom).",
      },
    ],
    steps: [
      {
        id: "create_tier",
        tool: "dexe_proposal_create",
        purpose:
          "Create the staking tier proposal. Omit stakingProposal — the composite resolves it via " +
          "GovUserKeeper.stakingProposalAddress(); if the contract isn't deployed yet the error returns the EXACT " +
          "dexe_tx_send payload for the one-off permissionless deployStakingProposal() transaction (it is NOT a " +
          "governance proposal — never wrap it in custom/custom_abi). Send it, then re-run this SAME call.",
        paramsTemplate: {
          govPool: "{{govPool}}",
          title: "…",
          proposalType: "create_staking_tier",
          params:
            "{ rewardToken: {{rewardToken}}, rewardAmount: {{rewardAmount}}, startedAt: …, deadline: …, stakingMetadataUrl: … }",
        },
        gotchaIds: ["timestamps-future", "staking-resolver", "spherex-addsettings"],
        bindsFrom: { proposalId: "create_tier.proposalId" },
        reportOnSuccess: "Staking tier proposal #{{proposalId}} created.",
        next: [{ when: "always", stepId: "pass", why: "the tier exists only after execute" }],
      },
      {
        id: "pass",
        tool: "dexe_proposal_vote_and_execute",
        purpose: "Vote + execute — the staking tier goes live.",
        paramsTemplate: { govPool: "{{govPool}}", proposalId: "{{proposalId}}" },
        reportOnSuccess: "Staking tier LIVE at https://app.dexe.io/dao/{{govPool}}.",
        next: [{ when: "always", stepId: "verify", why: "confirm the tier on-chain" }],
      },
      {
        id: "verify",
        tool: "dexe_read_staking_info",
        purpose: "Read the live tier back (reward pool, window) and show it to the user.",
        paramsTemplate: { govPool: "{{govPool}}" },
        reportOnSuccess:
          "Tier confirmed. Holders stake via dexe_vote_build_staking_stake, claim via " +
          "dexe_vote_build_staking_claim / _claim_all, reclaim principal via dexe_vote_build_staking_reclaim " +
          "(vote toolset; enable with DEXE_TOOLSETS if hidden).",
      },
    ],
    gotchaIds: ["staking-not-on-testnet", "amount-conventions"],
  },

  // ──────────────────────────────────────────────────────────────────────────
  {
    id: "launch_token_economy",
    title: "Launch a full token economy (DAO → distribute → OTC → staking)",
    triggers: [
      "launch a token economy",
      "create a token and distribute",
      "token with otc and staking",
      "full launch",
      "create token distribute otc staking",
      "tokenomics launch",
    ],
    summary:
      "The end-to-end journey: deploy a DAO + token, put tokens in specific hands, open an OTC sale, set up staking. Composed of the create_dao, create_proposal, otc_sale and staking_setup flows.",
    chainNotes: {
      97: "Rehearse the DAO + distribution + OTC legs on 97. The STAKING leg cannot run on testnet (no " +
        "StakingProposal there) — plan it for mainnet (56) and say so explicitly.",
      56: "Full run spends real BNB (cents per tx). Get explicit user confirmation before the first mainnet broadcast.",
    },
    interview: [
      {
        name: "distributionList",
        ask: "Which addresses should receive tokens, and what share of supply (e.g. 20%) split how?",
        kind: "addressList",
        required: true,
        riskIfUnusual:
          "A fixed address list is served by token_transfer proposals from the treasury (one per recipient) — " +
          "NOT by proposalType token_distribution (that's a pro-rata airdrop to voters). Size treasuryPercent to " +
          "cover the list share plus ongoing treasury needs.",
      },
      {
        name: "chainId",
        ask: "Rehearse on testnet 97 first (recommended), or go straight to mainnet 56?",
        kind: "string",
        required: false,
        default: "97",
      },
    ],
    steps: [
      {
        id: "leg_dao",
        tool: "dexe_guide",
        purpose:
          "LEG 1 — deploy the DAO. Fetch flow 'create_dao' and run its interview + steps. Set treasuryPercent so " +
          "the treasury covers the distribution list share (e.g. list needs 20% → treasury ≥ 20% + reserve, and " +
          "quorumPercent ≤ 100 − treasuryPercent must still hold ≥ 50).",
        paramsTemplate: { flow: "create_dao" },
        gotchaIds: ["treasury-remainder", "quorum-reachable"],
        bindsFrom: { govPool: "leg_dao.govPool" },
        reportOnSuccess: "DAO live at https://app.dexe.io/dao/{{govPool}} — proceed to distribution.",
        next: [{ when: "DAO deployed", stepId: "leg_distribute", why: "put tokens in the named hands" }],
      },
      {
        id: "leg_distribute",
        tool: "dexe_proposal_create",
        purpose:
          "LEG 2 — distribute to the address list: ONE token_transfer proposal PER recipient " +
          "(proposalType:'token_transfer', params:{token: govToken, recipient, amount}). Each auto-votes your " +
          "power; execute each via dexe_proposal_vote_and_execute. Withdraw (unlock) tokens between proposals.",
        paramsTemplate: {
          govPool: "{{govPool}}",
          proposalType: "token_transfer",
          params: "{ token: …govToken…, recipient: …next from list…, amount: … }",
        },
        gotchaIds: ["distribution-vs-transfer", "vp-locked", "low-creating-power-race", "blacklist-execute-trap"],
        reportOnSuccess:
          "Recipient paid — repeat for the rest of the list, then verify balances with dexe_read_token_holders.",
        next: [{ when: "all recipients funded", stepId: "leg_otc", why: "open the sale" }],
      },
      {
        id: "leg_otc",
        tool: "dexe_guide",
        purpose: "LEG 3 — open the OTC sale. Fetch flow 'otc_sale' and run its interview + steps.",
        paramsTemplate: { flow: "otc_sale" },
        reportOnSuccess: "Sale live — proceed to staking.",
        next: [{ when: "sale live", stepId: "leg_staking", why: "final leg" }],
      },
      {
        id: "leg_staking",
        tool: "dexe_guide",
        purpose:
          "LEG 4 — set up staking. Fetch flow 'staking_setup'. On chain 97 this leg MUST be deferred to mainnet — " +
          "relay the chain note instead of attempting it.",
        paramsTemplate: { flow: "staking_setup" },
        gotchaIds: ["staking-not-on-testnet"],
        reportOnSuccess:
          "Token economy complete: DAO + funded recipients + live OTC + staking. Summarize all addresses, " +
          "proposal ids and links for the user.",
      },
    ],
    gotchaIds: ["testnet-first", "amount-conventions"],
    subFlows: ["create_dao", "otc_sale", "staking_setup"],
  },
] as const;

/** id → Flow map (validated unique in tests/knowledge/integrity.test.ts). */
export const FLOW_BY_ID: ReadonlyMap<string, Flow> = new Map(FLOWS.map((f) => [f.id, f]));
