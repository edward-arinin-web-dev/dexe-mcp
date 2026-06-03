# Security

## Reporting

Report suspected vulnerabilities privately to the maintainer rather than opening
a public issue. Include a reproduction (a tool call + observed vs expected
output, or a transaction hash) where possible.

## Posture

`dexe-mcp` is primarily a **calldata builder**: by default (no
`DEXE_PRIVATE_KEY`) every write tool returns an unsigned `TxPayload` for an
external signer/wallet — nothing is broadcast. Broadcasting requires an
explicitly-configured hot key, and is gated by opt-in guards:

| Guard | Env | Effect |
|---|---|---|
| B6 destination allowlist | `DEXE_SIGNER_ALLOWLIST` | refuse sends to non-allowlisted `to` (also on the Safe propose path) |
| B7 value cap | `DEXE_SIGNER_MAX_VALUE_WEI` | refuse sends above the cap (also on the Safe propose path) |
| B9 pre-broadcast sim | (always, single sends) | `eth_call` preflight; abort on revert |
| B10 rate limit | `DEXE_SIGNER_MAX_BROADCASTS_PER_MIN` | per-process sliding window |

Never write `DEXE_PRIVATE_KEY` to `.env` without intent; prefer calldata mode or
WalletConnect / Safe.

## 0.9.0 — red-team audit remediation

`0.9.0` closes the MCP-fixable findings from the `0.7.2` red-team audit (the most
severe finding was guarded in `0.8.3`). Each fix shipped with a locking
regression test. Highlights:

- **Numeric safety** — amount/id strings validated before `BigInt()`; OTC and
  flow approvals are exact-amount (never `MAX_UINT256`); `apply_to_dao` and tier
  vesting encode correctly.
- **Disclosure** — RPC provider API keys redacted from tool output/errors;
  `get_config` masks the keyed RPC URL; the Graph key only goes to
  `*.thegraph.com`.
- **Untrusted data** — on-chain / IPFS strings are sanitized (control-char
  escape, NFKC, non-ASCII flag) before rendering; the decoder recursively
  unwraps nested calls and flags privileged selectors; IPFS fetches are
  content-hash-verified (raw/json codecs).
- **Signer/flow** — broadcasts serialized per chain; composite flow verifies
  `govPool` against the canonical `PoolRegistry`.
- **Infra** — protocol bootstrap uses `--ignore-scripts` and a pinnable
  `DEXE_PROTOCOL_REF`; markdown conversion is length-capped
  (`DEXE_MAX_DESCRIPTION_LEN`).

Full per-finding detail is in `CHANGELOG.md` (`0.9.0`).

## Governance-safety advisories

Some proposal/DAO configurations are governance-safety risks that depend on the
DAO's own settings rather than the MCP (e.g. low quorum for treasury-moving
proposals, zero execution delay, an over-long validator phase). The relevant
builders emit a non-blocking advisory in their preview so an operator/agent can
verify the configuration before proceeding. These are configured at the DAO level.

## Security-relevant env vars

| Var | Purpose |
|---|---|
| `DEXE_SIGNER_ALLOWLIST` / `DEXE_SIGNER_MAX_VALUE_WEI` / `DEXE_SIGNER_MAX_BROADCASTS_PER_MIN` | broadcast guards (B6/B7/B10) |
| `DEXE_PROTOCOL_REF` | pin the DeXe-Protocol clone to a branch/tag (supply-chain) |
| `DEXE_MAX_DESCRIPTION_LEN` | cap markdown-conversion input length (default 16384; lower for shared/untrusted hosts) |
