# Security Policy

## Supported Versions

Only the latest published version on npm receives security updates. Pin to the latest minor (`^0.5`) in your MCP client config.

## Release provenance

Every npm release from `v0.5.9` onwards is published via `.github/workflows/release.yml` with `npm publish --provenance`. The signed attestation links the tarball to the exact git commit and GitHub Actions run that produced it. Verify in three ways:

- The npmjs.com page for the package shows a "Provenance" badge with the source repo and workflow run.
- `npm view dexe-mcp dist.signatures` returns Sigstore signatures.
- `npm audit signatures` against an installed copy fails if the registry tarball was tampered with.

If you ever install a `dexe-mcp` version that lacks a provenance attestation (and is not a pre-`v0.5.9` historical release), treat it as suspect and report.

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
