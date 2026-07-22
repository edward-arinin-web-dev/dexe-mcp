# WalletConnect signer mode (C12)

> Status: **Phase B shipped** (2026-05-26) — live relay session implemented and
> unit-tested; targets `v0.7.0`. The final gate before tag/publish is one live
> round-trip against a real phone wallet (`DEXE_WALLETCONNECT_PROJECT_ID` is set).
>
> **v0.18.0 UX update:** WalletConnect is now the clearly-primary signer.
> `dexe_wc_connect` renders a **scannable QR** (terminal ASCII + `image/png`
> block) instead of a raw URI; `dexe_tx_send` and the composite flows
> **auto-print that QR** when a write needs a wallet and no session exists; and
> hot keys are flagged `⚠️ NOT SAFE` on every write. `dexe_wc_connect` now pairs
> even when `DEXE_PRIVATE_KEY` is set (the key just keeps signing precedence until
> unset). See `src/lib/qr.ts`.

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
| `dexe_wc_connect` | init provider (if needed), start `connect()`, render the pairing URI as a **QR** (ASCII + `image/png`, via `src/lib/qr.ts`). Non-blocking — returns the QR as soon as the relay emits the URI; the session-approval handshake completes in the background. Poll `dexe_wc_status` until `connected`. |
| `dexe_wc_status` | report `{ connected, connecting, account, chainId, topic, peerName, expiry, lastError }` plus the resolved config. |
| `dexe_wc_disconnect` | `provider.disconnect()`, clear session state. Safe no-op when not connected. |

`dexe_tx_send` branches on the active dispatch path: when there is **no hot key** and
WalletConnect is configured, instead of `wallet.sendTransaction(tx)` it calls
`provider.request('eth_sendTransaction', tx, 'eip155:'+chainId)`. The call **blocks
until the phone approves** — so a hard timeout (default 120 s, env-tunable) is
mandatory; on timeout it returns `{status:'rejected', reason:'…timed out…'}` instead
of hanging the MCP request. The wallet signs **and broadcasts**, so the response carries
the tx hash; `waitConfirmations` is honoured via a read-only RPC provider.

> **Scope note (v0.7.0, updated v0.20.1):** only `dexe_tx_send` / `dexe_tx_status`
> *broadcast* through WalletConnect. The composite flows (`sendOrCollect` in `flow.ts` /
> OTC) still emit ordered `TxPayload`s for you to feed to `dexe_tx_send` (per-step phone
> approval of a multi-step dependent sequence is impractical to auto-drive) — but they
> **auto-attach the pairing QR as real MCP content blocks** (ASCII + `image/png`, same
> rendering as `dexe_wc_connect`, since v0.20.1; v0.18.0 only embedded it in the JSON
> `pairing` field, which clients could not render) so you can connect with a single scan,
> then broadcast each payload. Routing full multi-step sequences through WC is still
> deferred.

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

### Phase B — live session — SHIPPED 2026-05-26
- ✅ `@walletconnect/universal-provider` dependency added (lazily imported in
  `src/lib/walletconnect.ts`, so non-WC deployments pay no startup cost).
- ✅ `WalletConnectManager` (`src/lib/walletconnect.ts`): init / connect / request /
  disconnect, CAIP-10 account parsing, per-tx approval timeout.
- ✅ `dexe_wc_connect` + `dexe_wc_disconnect` tools; `dexe_wc_status` now reports live
  session state. (v0.18.0: `dexe_wc_connect` now renders the QR server-side — ASCII +
  PNG — rather than returning the URI raw.)
- ✅ `eth_sendTransaction` branch wired into `dexe_tx_send`; `dexe_tx_status` reworked to
  a read-only provider so it works keyless. Guards B6/B7/B9/B10 still run on the WC path.
- ✅ Unit tests (`tests/walletconnect.test.ts`): config gating, CAIP-10 parsing, no-session
  guards. typecheck / build / test green (160 tools / 19 groups).
- ⬜ **Remaining gate:** one live round-trip against a phone wallet on BSC testnet (chain
  97) before tagging — human action.

After the live test passes → cut `v0.7.0`.

## Open questions for the operator
1. Project id source — confirm `cloud.reown.com` (Reown, formerly WalletConnect Cloud).
2. Test wallet — which phone wallet for the testnet round-trip (MetaMask mobile, Rainbow, Trust…)?
3. Session persistence across MCP restarts — acceptable to require a re-scan after a
   server restart in v0.6.0 (in-memory session), or invest in disk-backed storage now?
