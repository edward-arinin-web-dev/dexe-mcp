# Security Policy

## Supported Versions

Only the latest published version on npm receives security updates. Pin to the latest minor (`^0.34`) in your MCP client config — note that npm caret ranges on a `0.x` package do not cross minors, so `^0.34` means `>=0.34.0 <0.35.0`; re-pin on every minor bump to keep receiving security updates.

## Automated security checks

The repo runs four GitHub Actions security workflows continuously:

- **CI** (`ci.yml`) — typecheck and build on every push to `main` and every pull request, against Node 20, 22 and 24, plus a `verify-lockfile` integrity job. `npm test` runs the full `vitest` suite and `npm run test:compat` runs the frontend↔MCP calldata byte-diff, both on every push and every pull request; a failing test blocks the merge. A knowledge-layer drift guard (`npm run gen:knowledge:check`) runs in the same job. Read-only `GITHUB_TOKEN` scope.
- **Scheduled audit** (`audit.yml`) — `npm audit --omit=dev` runs daily against the production tree, so a dependency floor that rots while the repo sits untouched is caught without a push.
- **Dependency Review** (`dependency-review.yml`) — every PR is checked against the GitHub Advisory Database. Fails the PR check if any added/updated dependency carries a `high` or `critical` CVE, or if it introduces a forbidden license (GPL/AGPL).
- **OSSF Scorecard** (`scorecard.yml`) — weekly + on push to `main`. Audits branch protection, signed releases, pinned dependencies, token permissions, and a dozen other supply-chain checks. Results uploaded to GitHub code-scanning (SARIF) and published as a public score at `https://api.securityscorecards.dev/projects/github.com/edward-arinin-web-dev/dexe-mcp/badge`.
- **CodeQL** (`codeql.yml`) — GitHub-native SAST with the `security-extended` query suite. Runs on every PR/main push and weekly. Scans for prototype pollution, command injection, ReDoS, unsafe deserialization, path traversal, and other CWE patterns. Findings land in the repo's Security tab.

## Release provenance

Every npm release from `v0.5.9` onwards is published via `.github/workflows/release.yml` with `npm publish --provenance`. The signed attestation links the tarball to the exact git commit and GitHub Actions run that produced it. Verify in three ways:

- The npmjs.com page for the package shows a "Provenance" badge with the source repo and workflow run.
- `npm view dexe-mcp dist.signatures` returns Sigstore signatures.
- `npm audit signatures` against an installed copy fails if the registry tarball was tampered with.

If you ever install a `dexe-mcp` version that lacks a provenance attestation (and is not a pre-`v0.5.9` historical release), treat it as suspect and report.

## Signed release tags

Every release tag is GPG-signed by the maintainer, and `release.yml` runs `git verify-tag "$GITHUB_REF_NAME"` **before** the publish step — an unsigned tag, an invalid signature, or a tag signed by an unknown key aborts the release, so a pushed tag can never publish to npm without a valid maintainer signature.

To verify a tag yourself after cloning the repo:

```bash
# Import the maintainer's public key once (key id published alongside releases).
gpg --recv-keys <MAINTAINER_KEY_ID>

# Verify a specific tag — exits non-zero if unsigned or signed by an unknown key.
git verify-tag v0.5.9
# Equivalent shorthand:
git tag -v v0.5.9
```

A clean `gpg: Good signature from "<maintainer>"` line is the only acceptable result. `error: ... no signature found` (unsigned) or `Can't check signature: No public key` (unknown signer) means do not trust the tag.

## Reporting a Vulnerability

If you find a vulnerability in `dexe-mcp` — whether in the calldata builders, the optional signer (`DEXE_PRIVATE_KEY`), IPFS upload paths, or the Hardhat bridge — please **do not** open a public GitHub issue.

Email: **edward.arinin@gmail.com**

Include:

- A description of the issue and its impact (what an attacker can do, under what conditions).
- A minimal reproduction: the tool call, env vars (redacted), and the resulting behavior.
- Affected version (`dexe-mcp --version` or check `package.json`).
- Suggested mitigation, if you have one.

You should expect an acknowledgement within 72 hours. A coordinated-disclosure timeline will be agreed before any public advisory is filed.

## Scope

In scope:

- Calldata-builder tools (`dexe_proposal_build_*`, `dexe_vote_build_*`, `dexe_dao_build_deploy`) that produce calldata that does not match the intended action.
- Signer mode (`dexe_tx_send`, auto-broadcast in `dexe_proposal_create` / `dexe_proposal_vote_and_execute`) leaking or misusing the configured private key.
- IPFS upload paths that exfiltrate non-public data or accept unsafe input.
- Hardhat bridge (`dexe_compile`, `dexe_test`, etc.) executing unintended shell commands.
- Dependency vulnerabilities reachable through `dexe-mcp`'s exposed tool surface.

Out of scope:

- Vulnerabilities in the on-chain DeXe Protocol contracts (report at <https://github.com/dexe-network>).
- Issues that require the operator to set obviously unsafe env values (e.g. `DEXE_PRIVATE_KEY=<a key the attacker already controls>`).
- General npm-registry / npm-cli / Node.js issues unrelated to this package.

## Threat Model

`dexe-mcp` runs **locally** alongside an MCP client (Claude Desktop, Claude Code, etc.). It does not bind a network port and does not expose itself to the public internet. The interesting attack surfaces are:

1. The operator's private key in signer mode — never logged, never sent off-host, only used by `ethers.Wallet` to sign payloads the operator has already approved at the agent level.
2. Calldata correctness — every `_build_*` tool emits a `TxPayload` the operator can decode (`dexe_decode_calldata`, `dexe_decode_proposal`) and sign-verify before broadcasting.
3. IPFS pinning credentials — keep `PINATA_JWT` scoped to a project-specific key.

If you believe any of the above is broken, please report per the process above.

## Signer broadcast guards

When signer mode is enabled (`DEXE_PRIVATE_KEY`), `dexe_tx_send` runs six guards before broadcasting (`src/lib/broadcastGuards.ts`) — three always on, three opt-in behind an env var — plus one on the Safe path. They narrow the blast radius of a compromised or runaway MCP host: the host can still *call* the tool, but cannot send to arbitrary destinations, drain arbitrary value, pay gas for reverting txs, loop unbounded, broadcast to the wrong chain, or slip a denylisted selector through a multicall. A failed guard returns `{ status: "rejected", guard, reason }` with **no gas spent**.

| Guard | Env var | What it blocks |
|-------|---------|----------------|
| **B6** destination allowlist | `DEXE_SIGNER_ALLOWLIST` | Broadcasts to any `to` not on the comma-separated list. |
| **B7** value cap | `DEXE_SIGNER_MAX_VALUE_WEI` | Broadcasts whose `value` (wei) exceeds the cap. |
| **B9** auto-simulation | _(always on in signer mode)_ | Doomed txs — `eth_call` preflight aborts with the decoded revert reason before gas is spent. |
| **B10** rate limit | `DEXE_SIGNER_MAX_BROADCASTS_PER_MIN` | More than N broadcasts in a rolling 60s window. |
| **B11** wrong-chain broadcast | _(always on in signer mode)_ | Broadcasts whose payload `chainId` differs from the send chain, or whose `to` has no contract code on the send chain. |
| **B12** GovUserKeeper denylist | _(always on in signer mode)_ | Calldata carrying a denylisted `GovUserKeeper` selector, whether leading or embedded in a multicall. |
| **B13** Safe DELEGATECALL | `DEXE_SAFE_DELEGATECALL=block` | `dexe_safe_propose_tx` with `operation: 1` unless the caller passes `allowDelegateCall: true`; `block` refuses it outright. A DELEGATECALL runs arbitrary code against the Safe's own storage — it is the one call that can rewrite the owner set. |

These are defense-in-depth, **not** a substitute for keeping the key off-host. For prod governance/treasury actions, prefer calldata mode + Safe Multisig / Ledger. See `docs/ENVIRONMENT.md` §4 for the recommended config block.

## WalletConnect signer mode (C12)

`signerMode: walletconnect` (activated by `DEXE_WALLETCONNECT_PROJECT_ID` when **no** `DEXE_PRIVATE_KEY` is set) removes the hot key from the threat model entirely: the signing key never leaves the operator's phone wallet, and **every** transaction is gated by an explicit per-tx approval on that device. The MCP process holds only a relay session, never key material. The broadcast guards above still run on the `tx` *before* it is forwarded to the relay — the phone approval is an **additional** human gate, not a replacement. A hard approval timeout (`DEXE_WALLETCONNECT_APPROVAL_TIMEOUT_MS`, default 120 s) bounds how long a request can block. The live relay session shipped in **v0.7.0** and QR pairing in **v0.18.0**: `dexe_wc_connect` opens the session and renders a scannable QR, `dexe_wc_status` reports it, `dexe_wc_disconnect` tears it down, and `dexe_tx_send` plus the composite flows auto-print the QR when a write needs a wallet. This adds one runtime dependency, `@walletconnect/universal-provider` (WalletConnect v2 / Reown); it is **lazily imported** inside `src/lib/walletconnect.ts`, so `readonly` / `eoa` / `safe` sessions never load it, and it is covered by the dependency-review and `npm audit --omit=dev` gates above. See `docs/WALLETCONNECT.md`.
