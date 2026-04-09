# Changelog

## 0.1.2

### Fixed
- **Server no longer hangs / fails on first launch.** The heavy `git clone` + `npm install` bootstrap is now lazy — it runs only when a build tool (`dexe_compile`, `dexe_test`, `dexe_coverage`, `dexe_lint`) is first invoked, not inside MCP `initialize()`. Previously the MCP handshake would block for minutes or time out, and crash outright on hosts where `npm` / `git` were not on the spawned process's PATH.
- **PATH-independent spawning of `npm` and `hardhat`.** The runner now invokes `node <npm-cli.js>` and `node <protocol>/node_modules/hardhat/internal/cli/cli.js` directly via `process.execPath`, so it works on Windows installs where `npm.cmd` / `npx.cmd` aren't on the MCP client's spawn PATH (common with nvm-windows and with stripped `node.exe`-only installs).
- **Actionable error messages** when `git` is not installed, when `DEXE_PROTOCOL_PATH` points at a non-Hardhat directory, or when the user-managed checkout is missing `node_modules`.
- Concurrent build-tool calls now coalesce into a single bootstrap instead of racing `git clone` / `npm install`.

### Changed
- `loadConfig()` no longer hard-fails when the DeXe-Protocol checkout is missing or incomplete at startup — it logs a soft warning to stderr and defers preparation to the first build-tool invocation.
- `src/bootstrap.ts` split into `resolveProtocolPath()` (cheap, startup-safe) and `ensureBuildReady()` (lazy, idempotent).
- New `src/runtime.ts` with portable `npmCommand()` / `hardhatCommand()` / `hasGit()` helpers.

### Docs
- README now has an OS-specific install matrix (Mac/Linux vs. Windows) and a "dev / local checkout" recipe. Troubleshooting section updated for the new lazy-bootstrap behavior and the `process.execPath` npm resolution.

## 0.1.1

### Added
- `dexe_get_methods` introspection tool — returns per-contract methods partitioned into `read` (view/pure) and `write` (nonpayable/payable). Each entry includes `name`, canonical `signature`, 4-byte `selector`, `stateMutability`, and structured `inputs`/`outputs` with `internalType` preserved (so tuple-typed args like `IGovPool.ProposalView[]` survive intact). Designed for generating TypeScript interfaces or ethers wrappers without re-parsing raw ABIs. Supports `kind` filter (`read`/`write`/`all`) and optional `includeEvents`/`includeErrors`.

Tool count: 14 → 15.

## 0.1.0

Initial public release (Phase A): build/test, contract introspection, read-only governance tools. 14 tools.
