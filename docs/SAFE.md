# Safe{Wallet} multisig signing — `dexe_safe_*`

When a DAO's operator/treasury key lives in a [Gnosis Safe](https://docs.safe.global/)
rather than a single EOA, you don't want `dexe-mcp` to broadcast. You want it to
**queue** the transaction in the Safe Transaction Service so the Safe's owners
can co-sign and execute through the normal multisig flow.

That's what `dexe_safe_propose_tx` does: it takes the same `TxPayload`
(`to` / `value` / `data`) that every `dexe_*_build_*` tool emits, turns it into a
signed Safe transaction, and posts it to the queue.

> **Status:** build + dry-run paths are verified. Live POST validation is
> deferred until a test Safe is wired up — until then run with the default
> `dryRun: true` and inspect the emitted payload.

---

## The two tools

| Tool | Writes? | Purpose |
|------|---------|---------|
| `dexe_safe_info` | no | Read the live Safe (`nonce`, `threshold`, `owners`, version), check whether your signer is an owner, and see which service endpoint this chain resolves to. |
| `dexe_safe_propose_tx` | POST (opt-in) | Build → sign (`safeTxHash`) → assemble the create-multisig-transaction body. **Dry-run by default**; `dryRun: false` POSTs to the service. |

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
// dexe_safe_propose_tx (dry-run — the default)
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
  "signedBy": "0xYourOwnerEOA",
  "signaturePresent": true,
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
    "signature": "0x...",
    "origin": null
  }
}
```

3. Inspect it. When you're ready (and have `DEXE_SAFE_API_KEY` for
   `api.safe.global`), re-run with `"dryRun": false` to POST. The other owners
   then see the pending transaction in the Safe UI and add their confirmations.

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
- **`operation: 1` (DELEGATECALL)** runs the target's code in the Safe's
  context. Only use it for trusted libraries (e.g. MultiSend). Default is `0`
  (CALL).
- **Safe < 1.3.0** used a chain-less domain; `dexe_safe_*` targets modern
  (1.3.0 / 1.4.1) singletons.
- **`api.safe.global` requires an API key.** Without `DEXE_SAFE_API_KEY` a live
  POST is refused before any network call. Self-hosted services that don't
  require auth work without it.
