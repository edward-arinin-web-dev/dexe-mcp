# Transaction simulator

Preflight any DeXe-protocol calldata against live chain state before broadcasting.
Catches reverts, balance/allowance issues, and gas spikes without spending real
money. Backed by `eth_call` + `estimateGas` only — no external simulation deps,
no account abstraction layer, no bundler.

## Tools at a glance

| Tool | When to use |
|------|-------------|
| `dexe_sim_calldata` | Generic preflight. Any `to` + `data` + optional `value`/`from`/`blockTag`. Use this when you've built calldata via any builder tool and want to confirm it executes before signing. |
| `dexe_sim_proposal` | Specifically for `GovPool.execute(proposalId)`. Reads the proposal state first; refuses to simulate unless the state is `SucceededFor` (idx 4). Use this before calling `dexe_vote_build_execute` to verify the underlying actions don't revert (e.g. an `addToWhitelist` against a tier that no longer exists). |
| `dexe_sim_buy` | Specifically for `TokenSaleProposal.buy(...)`. Reports whether the caller's allowance is below `amount` (`willNeedApprove: true`) so the integrator knows an `approve` must precede the buy. |

All three are read-only — they call the node, never broadcast. Safe to run from
any agent on any wallet, including ones with no balance.

## Response shapes

All sim tools return a common core:

```jsonc
{
  "success": true,                  // false if call reverted
  "revertReason": "ERC20: ...",     // present iff success == false
  "returnData": "0x...",            // raw eth_call return; on revert, raw revert payload (Error(string) / Panic(uint256))
  "gasEstimate": "123456",          // present iff success == true; from estimateGas
  "from": "0x..."                   // resolved caller (signer, explicit override, or 0x0)
}
```

`dexe_sim_proposal` adds:

```jsonc
{
  "proposalState": "SucceededFor",
  "proposalStateIndex": 4
}
```

`dexe_sim_buy` adds:

```jsonc
{
  "native": true,                   // payment token is the 0x0 sentinel
  "willNeedApprove": false          // ERC20 path only; allowance < amount → integrator must prepend approve
}
```

## Revert decoding

The sim core decodes:

- `Error(string)` (selector `0x08c379a0`) → human revert reason ("ERC20: insufficient allowance")
- `Panic(uint256)` (selector `0x4e487b71`) → `Panic(0x...)` with the panic code (0x11 = arithmetic overflow, 0x12 = div-by-zero, 0x21 = invalid enum, 0x32 = OOB)
- Anything else → falls back to ethers' `shortMessage`/`reason`

Custom-error reverts pass through as raw `returnData` — decode them client-side
against the contract's ABI if you need a typed reason.

## Integration: `simulateFirst` on `dexe_otc_buyer_buy`

Pass `simulateFirst: true` to make the buyer composite eth_call-simulate the
`buy()` calldata against live state before sending the broadcast. If the sim
reverts, the tool aborts with the revert reason instead of broadcasting. The
sim runs after the approve calldata is built so the buy()-against-zero-allowance
case isn't a false negative — but the underlying tier rules (sale window, cap,
participation gate) are still checked.

```ts
await call("dexe_otc_buyer_buy", {
  tokenSaleProposal: "0x...",
  tierId: "1",
  tokenToBuyWith: "0x0000000000000000000000000000000000000000",
  amount: "100000000000000000",
  simulateFirst: true,
});
```

`simulateFirst` is ignored when `dryRun: true` (dryRun already short-circuits
to payload return without broadcasting).

## When the sim lies

`eth_call` runs against pending state of the latest mined block — it doesn't
account for:

- transactions that haven't yet been mined (race conditions)
- reorg risk on flaky networks
- L2 state divergence (sequencer vs verifier)
- nonce conflicts (a sim caller with a pending tx may see its own pending
  state on some nodes)

Treat the sim as a high-confidence go/no-go signal, not a guarantee. A green
sim followed by an immediate broadcast is the safest pattern.

## Block tag override

Pass `blockTag: "12345678"` (number or hex string) on `dexe_sim_calldata` to
simulate against a historical block. Useful for diagnosing "why did my tx fail
in block N" without re-running the full transaction. Most public BSC nodes
serve historical state for the last ~128 blocks; archive providers (Erigon,
Geth-archive) go further back.
