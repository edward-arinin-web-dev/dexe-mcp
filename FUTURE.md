# Future work

Tracking features deliberately deferred out of the Phase A / B roadmap.

## `dexe_get_storage_layout` (dropped from v1)

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

## `dexe_simulate_vote` (Phase B)

Needs a managed `hardhat node --fork $DEXE_RPC_URL` child process owned by the MCP. See `src/fork.ts` (not yet created) per the execution plan at `C:\Users\edwar\.claude\plans\kind-rolling-pelican.md`.

## Other ideas surfaced during design

- **TypeChain integration** — the protocol already emits ethers-v5 TypeChain bindings. We intentionally parse ABI JSON directly (dexe-mcp uses ethers v6). Revisit if/when DeXe-Protocol moves to ethers v6.
- **Custom `hardhat-migrate` wrappers** — out of scope per user decision (deployment tooling excluded).
- **Gas reporter parsing** — the `hardhat-gas-reporter` plugin is already wired in the protocol; `dexe_test` could optionally parse its output for per-function gas numbers.
- **Foundry fallback** — the repo is pure Hardhat today. Skip unless a Foundry config is added upstream.
