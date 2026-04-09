# Handoff — ship `dexe-mcp` v0.1.0 to GitHub + npm

Pick up from here. Everything below is the full state and the exact steps left to finish.

## What this project is

`dexe-mcp` is an MCP (Model Context Protocol) server for Claude Code that wraps the DeXe Protocol (`D:\dev\DeXe-Protocol`, a Hardhat/Solidity governance-DAO repo). It gives Claude three tool groups over stdio: build/test, contract introspection (from Hardhat artifacts), governance-domain (decode proposal calldata, read gov state).

Phase A (14 tools) is **implemented, typechecked, built, and stdio smoke-tested**. Phase B (`dexe_simulate_vote` + hardhat fork management) is explicitly deferred to v0.2.0.

## Current on-disk state

Repo at `D:\dev\dexe-mcp` is **not yet a git repo** and is **not yet published to npm**. Files present:

```
.gitignore              # needs *.stackdump, .vscode/, *.tgz, .idea/ added
.mcp.example.json       # CURRENTLY HARDCODES D:/dev/dexe-mcp/dist/index.js — must be genericized to npx
FUTURE.md               # deferrals doc, keep as-is
PLAN.md                 # prior architectural spec, keep in repo as contributor reference
README.md               # written assuming a local clone — needs full rewrite for end users
bash.exe.stackdump      # STRAY FILE, delete before first commit
dist/                   # gitignored, compiled output (tsc)
node_modules/           # gitignored
package-lock.json       # keep, commit
package.json            # MISSING publishing fields (license/repo/bugs/keywords/author/homepage/publishConfig/prepublishOnly)
scripts/smoke.mjs       # stdio smoke-test helper, keep
src/                    # Phase A source, complete, DO NOT MODIFY
tsconfig.json
```

No `LICENSE`, no `.github/workflows/`, no `.git/`.

`npm run typecheck` and `npm run build` are clean. The stdio smoke test (init → tools/list → dexe_list_contracts) returns `TOOLS_COUNT=14` and the fail-fast "artifacts missing" path works.

## Decisions already locked (do not re-litigate)

- **Distribution:** npm + GitHub. Package name **`dexe-mcp`** — confirmed available via `npm view dexe-mcp` (404).
- **GitHub repo:** `https://github.com/edward-arinin-web-dev/dexe-mcp` — user already created the empty repo.
- **License:** MIT, `Copyright (c) 2026 Edward Arinin`.
- **Phase B is out of scope for v0.1.0.** No `dexe_simulate_vote`, no `src/fork.ts`.
- **No vitest unit tests for v0.1.0.** Stdio smoke test is the only verification. Add tests in a later PR.
- **CI:** GitHub Actions, matrix Node 20 + 22, steps = checkout → setup-node → npm ci → typecheck → build. No test step.

## Environment gotchas on this machine

- **Default Node lacks npm.** `/c/Program Files/nodejs/` has `node.exe` but no `npm.cmd`. Use the nvm-installed version directly:
  - `NODE=/c/Users/edwar/AppData/Roaming/nvm/v22.13.1/node.exe`
  - `NPM=/c/Users/edwar/AppData/Roaming/nvm/v22.13.1/npm.cmd`
- **`gh` CLI is not installed.** Use plain `git` + the browser, or install it with `winget install GitHub.cli` first.
- **`npm whoami` returns `ENEEDAUTH`.** User must run `npm login` interactively before `npm publish`. You (LLM) cannot automate this.
- **Git config present:** `Edward Arinin <edward.arinin@gmail.com>`. Git credentials for `github.com/edward-arinin-web-dev` may or may not be cached — first `git push` may prompt.
- **Git Bash vs Windows paths:** `/tmp/...` in Git Bash is NOT the same as what Windows-native Node sees (it resolves to `D:\tmp\...`). Put scratch scripts inside the project dir, not `/tmp`.

## Reference: prior plan file

Full authoritative plan: `C:\Users\edwar\.claude\plans\kind-rolling-pelican.md` on the user's machine. The steps below mirror it 1:1.

---

## Remaining work — execute in order

### 1. Pre-commit hygiene

Delete the stackdump and broaden `.gitignore`:

```bash
rm "D:/dev/dexe-mcp/bash.exe.stackdump"
```

Append to `D:\dev\dexe-mcp\.gitignore`:

```
*.stackdump
.vscode/
.idea/
*.tgz
```

### 2. Enrich `package.json`

Edit `D:\dev\dexe-mcp\package.json` to add the following fields (merge into existing object; don't overwrite scripts/deps that already exist):

```json
{
  "license": "MIT",
  "author": "Edward Arinin <edward.arinin@gmail.com>",
  "homepage": "https://github.com/edward-arinin-web-dev/dexe-mcp#readme",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/edward-arinin-web-dev/dexe-mcp.git"
  },
  "bugs": {
    "url": "https://github.com/edward-arinin-web-dev/dexe-mcp/issues"
  },
  "keywords": [
    "mcp",
    "model-context-protocol",
    "claude",
    "claude-code",
    "hardhat",
    "solidity",
    "ethereum",
    "dexe",
    "dao",
    "governance",
    "smart-contracts",
    "dev-tools"
  ],
  "publishConfig": { "access": "public" }
}
```

Also in `package.json`:

- Add to `scripts`: `"prepublishOnly": "npm run typecheck && npm run build"`
- Change `"engines"`: `"node": ">=20.0.0"` (currently `>=18.17.0`; Node 18 is EOL)
- Verify `"files"` already = `["dist","README.md","FUTURE.md","PLAN.md",".mcp.example.json"]` — it does; leave alone.
- Verify `"bin"` = `{ "dexe-mcp": "dist/index.js" }` — it does; leave alone. (`src/index.ts` already has `#!/usr/bin/env node`.)

### 3. Rewrite `.mcp.example.json`

Replace the entire file with:

```json
{
  "mcpServers": {
    "dexe": {
      "command": "npx",
      "args": ["-y", "dexe-mcp"],
      "env": {
        "DEXE_PROTOCOL_PATH": "/absolute/path/to/your/DeXe-Protocol/checkout",
        "DEXE_RPC_URL": "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY"
      }
    }
  }
}
```

### 4. Create `LICENSE`

New file `D:\dev\dexe-mcp\LICENSE`. Standard MIT text:

```
MIT License

Copyright (c) 2026 Edward Arinin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 5. Rewrite `README.md` for end users

Full rewrite targeting a **first-time installer** who has never seen this repo. Keep it under ~150 lines. Required sections in order:

1. **H1 title + one-paragraph description** — "MCP server for Claude Code that wraps the DeXe Protocol Hardhat codebase with build/test, contract introspection, and governance-domain tools." Include an npm version badge: `![npm](https://img.shields.io/npm/v/dexe-mcp.svg)`.
2. **Prerequisites** — Node ≥20, a local DeXe-Protocol checkout (`git clone https://github.com/dexe-network/DeXe-Protocol.git`), optional `DEXE_RPC_URL` for on-chain gov tools.
3. **Install** — paste the `.mcp.example.json` snippet and tell the user where Claude Code's `.mcp.json` lives (project-level `.mcp.json` or per-user settings). Mention that `npx -y dexe-mcp` auto-downloads the package on first use.
4. **First run** — "Before introspection tools work, run `dexe_compile` once per session to populate `DeXe-Protocol/artifacts/`. You'll get a clear 'artifacts not found' error otherwise."
5. **Tool catalog** — a three-section list (Build/test, Introspection, Governance) with one line per tool, matching the 14 tools in `src/tools/` (`dexe_compile`, `dexe_test`, `dexe_coverage`, `dexe_lint`, `dexe_list_contracts`, `dexe_get_abi`, `dexe_get_selectors`, `dexe_find_selector`, `dexe_get_natspec`, `dexe_get_source`, `dexe_decode_calldata`, `dexe_decode_proposal`, `dexe_read_gov_state`, `dexe_list_gov_contract_types`).
6. **Environment variables table** — `DEXE_PROTOCOL_PATH` (required), `DEXE_RPC_URL` (optional, needed for `dexe_decode_proposal` and `dexe_read_gov_state`), `DEXE_FORK_BLOCK` (optional, Phase B).
7. **Troubleshooting** — two subsections: "`DEXE_PROTOCOL_PATH is not set`" and "`Hardhat artifacts not found — run dexe_compile first`".
8. **Contributing** — `git clone` → `npm install` → `npm run build` → `npm run typecheck` → `npm run dev` (watch mode).
9. **Roadmap** — link `FUTURE.md`, mention Phase B `dexe_simulate_vote`.
10. **License** — "MIT. See [LICENSE](./LICENSE)."

No other badges, no emojis, no "⭐ Star if you like it" sections.

### 6. Add GitHub Actions CI

New file `D:\dev\dexe-mcp\.github\workflows\ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node: ["20", "22"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: "npm"
      - run: npm ci
      - run: npm run typecheck
      - run: npm run build
```

No test step — there are no tests in v0.1.0. Do not add one.

### 7. Verify locally before committing

```bash
cd /d/dev/dexe-mcp
NPM=/c/Users/edwar/AppData/Roaming/nvm/v22.13.1/npm.cmd
"$NPM" run typecheck
"$NPM" run build
```

Both must exit 0. If not, fix before proceeding.

### 8. Git init + first commit + push

```bash
cd /d/dev/dexe-mcp
git init -b main

# Stage files BY NAME — don't use `git add .` or `-A` (keeps node_modules/dist/stackdump out even if .gitignore is wrong)
git add src scripts .github package.json package-lock.json tsconfig.json \
        .gitignore .mcp.example.json README.md LICENSE FUTURE.md PLAN.md HANDOFF.md

git status   # verify no node_modules, no dist, no bash.exe.stackdump

git commit -m "$(cat <<'EOF'
feat: initial release — dexe-mcp v0.1.0 (Phase A)

MCP server for Claude Code wrapping the DeXe Protocol Hardhat
codebase. 14 tools across three groups:

Build/test: dexe_compile, dexe_test, dexe_coverage, dexe_lint
Introspection: dexe_list_contracts, dexe_get_abi, dexe_get_selectors,
  dexe_find_selector, dexe_get_natspec, dexe_get_source
Governance: dexe_decode_calldata, dexe_decode_proposal,
  dexe_read_gov_state, dexe_list_gov_contract_types

See PLAN.md for full architecture. Phase B (dexe_simulate_vote +
hardhat fork management) deferred to v0.2.0.
EOF
)"

git remote add origin https://github.com/edward-arinin-web-dev/dexe-mcp.git
git push -u origin main
```

**If `git push` fails on auth:** stop and hand back to the user with: "GitHub credentials aren't cached. Either run `gh auth login` after installing `gh` (`winget install GitHub.cli`), or generate a classic PAT with `repo` scope at https://github.com/settings/tokens and paste it into the git credential prompt."

Then tag:

```bash
git tag v0.1.0
git push --tags
```

### 9. npm publish (REQUIRES USER)

**You cannot do this yourself.** The machine is not logged into npm.

Hand back to the user with exactly this message:

> Everything pre-publish is done and pushed to GitHub. To publish to npm:
> 1. Run `npm login` in a terminal (interactive browser OAuth).
> 2. Run `cd D:/dev/dexe-mcp && npm publish`.
> 3. Tell me when it's done and I'll verify.

After the user confirms, verify:

```bash
NPM=/c/Users/edwar/AppData/Roaming/nvm/v22.13.1/npm.cmd
"$NPM" view dexe-mcp version    # expect: 0.1.0
```

### 10. End-to-end verification of the published package

In a **fresh throwaway directory** (so `npx` actually fetches from the registry, not a cached local):

```bash
mkdir /tmp/dexe-mcp-verify && cd /tmp/dexe-mcp-verify
# Use project dir for the smoke script since /tmp doesn't map 1:1 for Windows Node
NODE=/c/Users/edwar/AppData/Roaming/nvm/v22.13.1/node.exe
DEXE_PROTOCOL_PATH=D:/dev/DeXe-Protocol npx -y dexe-mcp < /dev/null &
# Alternative: reuse D:/dev/dexe-mcp/scripts/smoke.mjs by swapping
#   spawn(node, ["dist/index.js"], ...) → spawn("npx", ["-y", "dexe-mcp"], ...)
```

Expected: the server prints `[dexe-mcp] connected on stdio. DEXE_PROTOCOL_PATH=...` to stderr, then blocks waiting for MCP protocol input. Send `initialize` → `notifications/initialized` → `tools/list` and expect 14 tools back (same names as the local smoke test).

Then wire it into Claude Code's `.mcp.json` (using the `npx -y dexe-mcp` form, **not** the local dist path), restart Claude Code, confirm the 14 `dexe_*` tools appear in the tools list. Ask the agent "compile DeXe and list Gov* contracts" end-to-end.

Confirm GitHub Actions CI on the initial commit is green at `https://github.com/edward-arinin-web-dev/dexe-mcp/actions`.

---

## Success criteria

- [ ] `git push` + `v0.1.0` tag visible at `https://github.com/edward-arinin-web-dev/dexe-mcp`
- [ ] GitHub Actions CI green on `main`
- [ ] `npm view dexe-mcp version` returns `0.1.0`
- [ ] `npx -y dexe-mcp` boots in a fresh dir and stdio smoke test returns `TOOLS_COUNT=14`
- [ ] Claude Code picks up the `npx`-based `.mcp.json` entry after restart
- [ ] README renders cleanly on GitHub, LICENSE is visible

## What NOT to do

- Do not modify anything in `src/**`. Phase A is done and tested.
- Do not add vitest tests. Out of scope for v0.1.0.
- Do not start Phase B (`src/fork.ts` / `dexe_simulate_vote`). Out of scope.
- Do not publish to a scoped name (`@something/dexe-mcp`). `dexe-mcp` is available.
- Do not force-push to `main` after the initial commit.
- Do not run `git add .` or `git add -A` — stage by name to keep junk out.
- Do not skip `npm login`. You cannot publish without it.
