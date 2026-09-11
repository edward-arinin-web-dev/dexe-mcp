# Safe{Wallet} multisig signing — `dexe_safe_*`

When a DAO's operator/treasury key lives in a [Gnosis Safe](https://docs.safe.global/)
rather than a single EOA, you don't want `dexe-mcp` to broadcast. You want it to
**queue** the transaction in the Safe Transaction Service so the Safe's owners
can co-sign and execute through the normal multisig flow.

That's what `dexe_safe_propose_tx` does: it takes the same `TxPayload`
(`to` / `value` / `data`) that every `dexe_*_build_*` tool emits, turns it into a
Safe transaction, and — when you tell it to — signs it and posts it to the queue.

> **Status:** build + dry-run paths are verified. Live POST validation is
> deferred until a test Safe is wired up — until then run with the default
> `dryRun: true` and inspect the emitted payload.

> **A dry run is UNSIGNED (since 0.34.0).** The POST is unauthenticated
> plumbing anyone can do; the owner **signature** is the privileged,
> irreversible act — it stays valid for that `(chainId, safe, payload, nonce)`
> until the nonce is consumed, and anyone holding the body can queue it. So
> `dryRun: true` returns the payload and the `safeTxHash` and creates no
> signature. Pass `sign: true` when you intend to POST the body yourself.

---

## The two tools

| Tool | Writes? | Purpose |
|------|---------|---------|
| `dexe_safe_info` | no | Read the live Safe (`nonce`, `threshold`, `owners`, version), check whether your signer is an owner, and see which service endpoint this chain resolves to. |
| `dexe_safe_propose_tx` | POST (opt-in) | Build → `safeTxHash` → assemble the create-multisig-transaction body. **Dry-run and UNSIGNED by default**; `dryRun: false` signs + POSTs; `sign: true` signs without POSTing. `operation: 1` is refused unless `allowDelegateCall: true`. |

Both mirror the `registerOtcTools(server, ctx, signer, wc)` wiring and accept an
optional `chainId` (defaults to the MCP's default chain).

---

## Env

```env
DEXE_PRIVATE_KEY=0x...                 # a Safe OWNER key (signs the safeTxHash)
DEXE_RPC_URL_MAINNET=https://bsc-dataseed.bnbchain.org   # to read the Safe nonce
# Optional / situational:
DEXE_SAFE_TX_SERVICE_URL=https://api.safe.global/tx-service/bnb/api/v2
DEXE_SAFE_API_KEY=...                  # Bearer token for api.safe.global (live POST)
DEXE_SAFE_DELEGATECALL=block           # forbid operation=1 outright, overriding allowDelegateCall
```

- With **no override**, `chainId` resolves to
  `https://api.safe.global/tx-service/<shortname>/api/v2`
  (`eth`, `bnb`, `matic`, `base`, `arb1`, `sep`, …).
- **BSC testnet (97) has no hosted service** — set `DEXE_SAFE_TX_SERVICE_URL`
  to a self-hosted instance to use it there.
- `dexe_get_config` shows `signerMode: "safe"` once both `DEXE_PRIVATE_KEY` and
  `DEXE_SAFE_TX_SERVICE_URL` are set.

---

## Flow: propose a treasury transfer to the Safe queue

1. Build the action with any builder, e.g. an ERC-20 transfer, and grab its
   `TxPayload` (`to`, `data`, `value`).
2. Hand that payload to `dexe_safe_propose_tx`:

```jsonc
// dexe_safe_propose_tx (dry-run, unsigned — the default)
{
  "safe": "0xcd2E72aEBe2A203b84f46DEEC948E6465dB51c75",
  "to":   "0xTokenContract...",
  "data": "0xa9059cbb...",   // transfer(to, amount)
  "value": "0",
  "chainId": 56
  // nonce omitted → read from the Safe on-chain
}
```

Response (truncated):

```jsonc
{
  "mode": "dryRun",
  "chainId": 56,
  "safe": "0xcd2E...1c75",
  "nonce": "7",
  "nonceSource": "onchain",
  "safeTxHash": "0x5d2c40...886a",
  "signedBy": null,
  "signaturePresent": false,
  "note": "UNSIGNED preview. Check `safeTxHash` against what your wallet shows, then re-run with dryRun:false to sign + POST, or sign:true to get the signed body without POSTing.",
  "endpoint": {
    "base": "https://api.safe.global/tx-service/bnb/api/v2",
    "hosted": true,
    "postUrl": "https://api.safe.global/tx-service/bnb/api/v2/safes/0xcd2E...1c75/multisig-transactions/"
  },
  "body": {
    "to": "0xTokenContract...",
    "value": "0",
    "data": "0xa9059cbb...",
    "operation": 0,
    "safeTxGas": "0", "baseGas": "0", "gasPrice": "0",
    "gasToken": "0x0000000000000000000000000000000000000000",
    "refundReceiver": "0x0000000000000000000000000000000000000000",
    "nonce": "7",
    "contractTransactionHash": "0x5d2c40...886a",
    "sender": "0xYourOwnerEOA",
    "signature": null,
    "origin": null
  }
}
```

3. Inspect it — check `safeTxHash` against what your wallet shows for the same
   payload. When you're ready (and have `DEXE_SAFE_API_KEY` for
   `api.safe.global`), re-run with `"dryRun": false` to sign + POST. The other
   owners then see the pending transaction in the Safe UI and add their
   confirmations.

   If you POST from your own tooling instead, re-run with `"sign": true`: you
   get the same body with a real `signature`. Treat that body as a credential —
   it is queue-ready for anyone who holds it.

---

## How the `safeTxHash` is computed

`dexe-mcp` signs the canonical Safe EIP-712 `SafeTx` struct:

- **domain** = `{ chainId, verifyingContract: <safe> }` (Safe ≥ 1.3.0)
- **types.SafeTx** = `to, value, data, operation, safeTxGas, baseGas, gasPrice,
  gasToken, refundReceiver, nonce` — field order is consensus-critical and
  matches `Safe.getTransactionHash(...)` on-chain.

The resulting hash is what owners sign and what the service indexes the
transaction under. The signature is recovered to the signer; if that address
isn't a Safe owner, the service returns `422`.

---

## Gotchas

- **Signer must be an owner.** Use `dexe_safe_info` → `signerIsOwner: true`
  before proposing. A non-owner signature is rejected with `422`.
- **Nonce collisions.** Omitting `nonce` reads the Safe's *current* nonce. If
  you're queuing several txs at once, pass explicit increasing `nonce` values —
  otherwise they all share the same nonce and only one can execute.
- **Guard B13: `operation: 1` (DELEGATECALL) is refused unless `allowDelegateCall: true`.**
  It executes the target's code inside the Safe's **own storage**, where slot 0
  is the singleton pointer and the owners list + threshold live — a wrong or
  hostile target takes the Safe permanently. Neither the destination allowlist
  (B6) nor the GovUserKeeper denylist (B12) can inspect a delegatecall's
  effects, which is why it needs its own key. Use it only for a vetted
  MultiSend or module call, and verify the target yourself. Operators can
  forbid it outright with `DEXE_SAFE_DELEGATECALL=block`, which overrides the
  per-call flag. Default is `0` (CALL).
  This is not the *only* way to rewrite the owner set — a plain CALL to the Safe
  itself carrying `swapOwner`/`changeThreshold` calldata does it too (that is the
  normal owner-management path). DELEGATECALL is the broader privilege, not a
  unique one, so read every payload you queue.
- **A dry run is unsigned by design.** `sign: true` produces a real owner
  signature; treat the returned body as a credential, not as a preview.
- **A dryRun payload from a composite references unpinned content.** When the
  `TxPayload` you are queueing came out of a `dexe_*` composite run with
  `dryRun: true`, its IPFS CIDs (proposal metadata, merkle whitelists) were
  computed locally and never pinned — the payload is byte-identical to the real
  one, but what it points at does not exist yet. Re-run that composite without
  `dryRun` and queue the resulting payload instead.
- **Gas refunds are not bounded by the value cap.** With `gasPrice > 0` and a
  non-zero `gasToken` / `refundReceiver`, the Safe pays an ERC-20 amount out on
  execution. `DEXE_SIGNER_MAX_VALUE_WEI` (B7) only inspects native `value`, so
  the tool surfaces a `warnings[]` entry instead.
- **Safe < 1.3.0** used a chain-less domain; `dexe_safe_*` targets modern
  (1.3.0 / 1.4.1) singletons.
- **`api.safe.global` requires an API key.** Without `DEXE_SAFE_API_KEY` a live
  POST is refused before any network call. Self-hosted services that don't
  require auth work without it.
