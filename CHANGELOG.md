# Changelog

## 0.1.5

### Fixed
- **`'npx' is not recognized`** from inside `npm run compile` (and other npm scripts that internally call `npx hardhat …`) on stripped-Node Windows installs. v0.1.4 got `npm` itself spawning cleanly, but DeXe-Protocol's `compile` script is literally `npx hardhat compile --force`, and when npm spawned that child, `cmd.exe` couldn't find `npx.cmd` on PATH — the stripped `C:\Program Files\nodejs\` has `node.exe` only. Root cause: we weren't propagating the resolved Node's shim directory into the child's `PATH`.
- New `deriveNodeBinDir()` + `envWithNodeBinDir()` helpers in `src/runtime.ts` derive the directory containing `npm.cmd`/`npx.cmd` (Windows) or `bin/npm`/`bin/npx` (Unix) from the resolved `npm-cli.js` path, and prepend it to `PATH` on every child spawn (`bootstrap` npm install, `runNpmScript`, `runHardhat`). Child shells launched by npm scripts can now resolve `npx` / `npm` / any locally-installed binary as expected.
- `npmCommand()` now returns a `binDir` field alongside `command` / `prefixArgs` / `needsShell`. Bootstrap logs the prepended directory on first run so it's visible which Node install is contributing the shims.

## 0.1.4

### Fixed
- **`spawn EINVAL` during first-run `npm install`** on Windows hosts where `process.execPath` points at a Node install that does not bundle npm (e.g. a bare `node.exe` dropped under `C:\Program Files\nodejs\` without the rest of the toolchain). Two root causes addressed:
  1. `resolveNpmCli()` now searches a broader set of locations for a usable `npm-cli.js` — including `%APPDATA%\nvm\v*\node_modules\npm\bin\npm-cli.js` (nvm-windows), `%APPDATA%\npm\node_modules\npm\bin\npm-cli.js` (per-user npm prefix), `C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js` (stock Windows installer), `~/.nvm/versions/node/v*/lib/node_modules/npm/bin/npm-cli.js` (nvm Unix), and Homebrew paths. Because `npm-cli.js` is plain JavaScript, *any* modern `node` can execute any of these, so the MCP process's own Node is free to "borrow" npm from a completely different Node install.
  2. When no `npm-cli.js` is found anywhere and we fall back to spawning `npm.cmd` directly, `execFile` / `execa` now pass `{ shell: true }` — without it, Node refuses to spawn `.cmd` / `.bat` files (CVE-2024-27980 mitigation) and throws `spawn EINVAL`.
- Progress logging on first bootstrap now prints the resolved `npm-cli.js` path (or "shell-resolved" fallback), so "which npm is about to run" is visible in stderr.

## 0.1.3

### Docs
- **Windows install section rewritten** to lead with the absolute-path recipe (`node <abs path to dist/index.js>`) instead of `cmd /c dexe-mcp`. End-to-end testing against Claude Code on Windows showed the `cmd /c` wrapper, while standalone functional, did not reliably complete the MCP handshake when spawned by Claude Code — the absolute-path recipe has zero shim resolution and is known-working.
- **New prereq step**: verify `npm --version` actually runs in your shell *before* attempting `npm install -g dexe-mcp`. Users with a stripped `node.exe`-only install (common on Windows) will hit a silent `npm i -g` no-op otherwise, with no visible error.
- Added a "Verify the install" section showing how to smoke-test `dexe-mcp` over stdio without involving Claude Code, so users can distinguish "MCP server broken" from "client registration broken".

No code changes — 0.1.3 is a docs-only patch on top of 0.1.2's behavior.

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
