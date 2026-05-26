# WalletConnect signer mode (C12)

> Status: **design + Phase A** (2026-05-26). Phase B (live relay session) is gated on
> an operator `DEXE_WALLETCONNECT_PROJECT_ID` + a phone wallet for end-to-end testing.

## Why

The existing signer (`DEXE_PRIVATE_KEY` → `dexe_tx_send`) is a **hot key**: the raw
private key sits in the MCP process env and signs every broadcast unattended. That is
the convenient-but-risky end of the spectrum; the `safe` mode (C13) is the
queue-and-co-sign end. WalletConnect sits in between: broadcast convenience *without*
a hot key — every transaction is approved on the operator's phone wallet, and the key
never leaves the device.

This adds a **fourth `signerMode`**: `readonly` | `eoa` | `safe` | `walletconnect`.

## SDK choice

`@walletconnect/universal-provider` (WalletConnect v2 / Reown). It is the dApp-side
primitive that works in Node with no browser:

- `UniversalProvider.init({ projectId, relayUrl })` — opens the relay websocket.
- `provider.on('display_uri', uri => …)` — the pairing URI to render as a QR / deep link.
- `provider.connect({ optionalNamespaces: { eip155: { methods, chains, events, rpcMap } } })`
  — returns once the wallet approves the session.
- `provider.request({ method: 'eth_sendTransaction', params: [tx] }, 'eip155:<chainId>')`
  — forwards the tx to the phone; resolves with the tx hash after the user approves.
- `provider.disconnect()` — ends the session.

We do **not** use `@reown/appkit` / `WalletConnectModal` — those are browser-DOM UIs.
The MCP server only needs the headless provider + the raw URI (the client renders the QR).

## Architecture in an MCP server

MCP tool calls are discrete request/response, but the relay session is long-lived and
must persist **in the MCP process** between calls. A module-level singleton
(`src/lib/walletconnect.ts`) holds the `UniversalProvider` instance + the current
session. Lifecycle is driven by explicit tools, not implicitly per-call:

| Tool | Action |
|------|--------|
| `dexe_wc_connect` | init provider (if needed), start `connect()`, return the pairing `uri` + an ASCII QR hint. Stores the pending-approval promise. Non-blocking — returns the URI immediately. |
| `dexe_wc_status` | report `{ connected, account, chains, expiry }`. In Phase A (no live relay) reports only the resolved config (projectId present? relay url?). |
| `dexe_wc_disconnect` | `provider.disconnect()`, clear singleton. |

`dexe_tx_send` (and the composite broadcast loop `sendOrCollect`) branch on
`signerMode === 'walletconnect'`: instead of `wallet.sendTransaction(tx)` they call
`provider.request('eth_sendTransaction', tx, 'eip155:'+chainId)`. The call **blocks
until the phone approves** — so a hard timeout (default 120 s, env-tunable) is
mandatory, returning a clear `{status:'timeout'}` instead of hanging the MCP request.

### Guard interaction

Broadcast guards B6 (allowlist) / B7 (value cap) / B10 (rate limit) still apply on the
WalletConnect path — they run on the `tx` *before* it is forwarded to the relay, same
as the EOA path. B9 (auto-sim) also applies in single-shot `dexe_tx_send`. The phone
approval is an *additional* human gate, not a replacement for the guards.

## Env vars

| Var | Required | Meaning |
|-----|----------|---------|
| `DEXE_WALLETCONNECT_PROJECT_ID` | yes (for WC mode) | Free project id from <https://cloud.reown.com>. Activates `signerMode: walletconnect` when set **and** `DEXE_PRIVATE_KEY` is **absent** (WC and hot-key are mutually exclusive — WC wins only when no key is present, else `eoa`). |
| `DEXE_WALLETCONNECT_RELAY_URL` | no | Override relay. Default `wss://relay.walletconnect.com`. |
| `DEXE_WALLETCONNECT_APPROVAL_TIMEOUT_MS` | no | Per-tx phone-approval timeout. Default `120000`. |

`signerMode` precedence (computed in `getConfig`): `safe` (if Safe env set) → `eoa`
(if `DEXE_PRIVATE_KEY` set) → `walletconnect` (if project id set) → `readonly`.

## Phased delivery

### Phase A — plumbing (no projectId/phone/dependency needed) — buildable now
- **No new dependency.** The `@walletconnect/universal-provider` import lands only in
  Phase B's `walletconnect.ts`; Phase A is pure config + a read-only report tool, so
  the supply-chain surface (dependency-review, A1–A5) is unchanged until Phase B.
- Parse the three env vars in `loadConfig` → new `DexeConfig` fields.
- Extend `getConfig` `signerMode` union + add a `walletConnect` report block
  (`projectIdConfigured`, `relayUrl`, `approvalTimeoutMs`).
- `dexe_wc_status` tool returning the resolved config (no relay connection).
- Docs (this file) + CHANGELOG + ENVIRONMENT.md + SECURITY.md threat-model note.
- `typecheck && build && test` green. **No live relay, no broadcast yet.**

### Phase B — live session (needs `DEXE_WALLETCONNECT_PROJECT_ID` + phone)
- Add `@walletconnect/universal-provider` dependency (the only new dep — lands here).
- `src/lib/walletconnect.ts` singleton: init / connect / request / disconnect.
- `dexe_wc_connect` + `dexe_wc_disconnect` tools; ASCII-QR rendering of the URI.
- Wire `eth_sendTransaction` branch into `dexe_tx_send` + `sendOrCollect`, with the
  approval timeout + guards B6/B7/B9/B10.
- End-to-end test on BSC testnet (chain 97) against a phone wallet.
- README tool-count bump (+1 to +3 tools, +1 group "WalletConnect").

After Phase B lands → cut `v0.6.0`.

## Open questions for the operator
1. Project id source — confirm `cloud.reown.com` (Reown, formerly WalletConnect Cloud).
2. Test wallet — which phone wallet for the testnet round-trip (MetaMask mobile, Rainbow, Trust…)?
3. Session persistence across MCP restarts — acceptable to require a re-scan after a
   server restart in v0.6.0 (in-memory session), or invest in disk-backed storage now?
