# Future work

Deliberately deferred out of v0.2.0. Kept here so we don't re-litigate during planning.

## Signer-aware send mode

Every v0.2.0 write tool returns calldata (`TxPayload`). Actually *sending* the tx — reading a `PRIVATE_KEY` or opening a local keystore and submitting via ethers `Wallet.sendTransaction` — is deferred. Reason: scope + security posture. We don't want private keys anywhere near the MCP process by default. If re-opened, expose as an opt-in mode gated on an explicit `DEXE_SIGNING_MODE=enabled` env var with loud warnings in tool output.

## `dexe_simulate_vote` + Hardhat fork management

Spawn a managed `hardhat node --fork $DEXE_RPC_URL` child process owned by the MCP, impersonate a voter, submit the `vote` calldata against the fork, and report success/revert with gas used. Would live in `src/fork.ts`.

## Additional IPFS pinning providers

v0.2.0 ships Pinata only. Reasonable candidates if we need a second:
- **Lighthouse.storage** — one-time payment, permanent Filecoin storage. Best long-term fit for DAO metadata that must never disappear. User has flagged interest.
- **Storacha / web3.storage** — UCAN-based, Filecoin-backed, free tier.
- **Filebase** — S3-compatible, Filecoin-backed.

Design: extend `src/lib/ipfs.ts` with an `IpfsUploader` interface, factor Pinata into an adapter, add new adapters behind `DEXE_IPFS_PROVIDER`.

## Additional subgraphs

We wire `DEXE_SUBGRAPH_INTERACTIONS_URL` (voter lists) and reserved slots for pools/validators subgraphs. Fleshing out list/search tools that use those other subgraphs is deferred — driven by user demand.

## `dexe_get_storage_layout`

The current `DeXe-Protocol/hardhat.config.js` does not include `storageLayout` in `outputSelection`, so build-info files don't contain the data this tool would read.

**To enable:** add `storageLayout` to `outputSelection` in DeXe-Protocol's hardhat config:

```js
solidity: {
  compilers: [{
    version: "0.8.20",
    settings: {
      outputSelection: {
        "*": {
          "*": ["storageLayout", /* ...existing */]
        }
      }
    }
  }]
}
```

Then the tool becomes a short handler reading `output.contracts[file][name].storageLayout` from the matching build-info JSON.

## Fixture tests for write builders

Phase 3 and 4 wrappers were verified against the DeXe frontend encodings but don't yet have byte-for-byte golden-file tests. For every `*_build_*` tool, capture the hex calldata from the frontend on identical inputs and snapshot it.

## Other ideas surfaced during design

- **TypeChain integration** — the protocol already emits ethers-v5 TypeChain bindings. We intentionally parse ABI JSON directly (dexe-mcp uses ethers v6). Revisit if/when DeXe-Protocol moves to ethers v6.
- **Custom `hardhat-migrate` wrappers** — out of scope per user decision (deployment tooling excluded from the dev-tool surface).
- **Gas reporter parsing** — the `hardhat-gas-reporter` plugin is already wired in the protocol; `dexe_test` could optionally parse its output for per-function gas numbers.
- **Foundry fallback** — the repo is pure Hardhat today. Skip unless a Foundry config is added upstream.
