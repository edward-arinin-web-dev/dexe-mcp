# E2E Compat Testing — Quick Start Guide

## What's ready

Everything is built and waiting for you to plug in the browser:

| Component | File | Status |
|---|---|---|
| TX interceptor | `tests/compat/interceptor.js` | Ready — hooks `window.ethereum.request`, blocks real tx, captures calldata |
| Form auto-filler | `tests/compat/form-filler.js` | Ready — fills all wizard steps via `data-testid` selectors |
| Calldata comparator | `tests/compat/comparator.ts` | Ready — hex diff + ABI decode + markdown report |
| Test fixtures | `tests/fixtures/*.json` | Ready — minimal-dao, full-dao, offchain-proposal, metadata |
| Orchestrator runbook | `tests/compat/orchestrator.md` | Ready — full step-by-step protocol |
| Skill | `.claude/skills/test-mcp-compat/SKILL.md` | Ready — Claude Code can read this to run the flow |

## What you need to do manually

### One-time setup

1. **Start the frontend**
   ```bash
   cd investing-dashboard
   npm run dev
   # Running at https://localhost:3000/
   ```

2. **Connect MetaMask** to BSC mainnet in the browser

3. **Start Claude Code** with both MCPs configured:
   - Chrome DevTools MCP (connected to the browser)
   - dexe-mcp (your MCP server)

4. **Set Pinata JWT** (if not already in your `.env`):
   ```bash
   export DEXE_PINATA_JWT="your-jwt-here"
   ```

### Running a test

You have two modes:

#### Option A: Tell Claude Code to run it

Open Claude Code and say:
```
Read the skill at .claude/skills/test-mcp-compat/SKILL.md, then run the
minimal-dao fixture from tests/fixtures/minimal-dao.json against the
frontend at localhost:3000. Use Chrome DevTools MCP to fill the form
and capture calldata, then call the dexe-mcp tool with the same params
and compare.
```

Claude Code will:
1. Inject the interceptor + form-filler scripts
2. Navigate to the DAO creation page
3. Fill each step from the fixture
4. Click submit → interceptor captures calldata
5. Call `dexe_dao_build_deploy` with the fixture's MCP args
6. Run the comparator → generate a report

#### Option B: Semi-automatic (you watch each step)

Tell Claude Code:
```
Run the compat test in semi-automatic mode. Pause after each wizard step
so I can verify the form looks correct before advancing.
```

### Reading reports

Reports land in `tests/reports/`. Each report shows:
- **Verdict**: PASS or FAIL
- **Hex diff**: byte offset of first divergence
- **Field diffs**: table of which ABI-decoded fields differ (path, frontend value, MCP value)
- **Full decoded calldata**: collapsed JSON of both sides (on FAIL)

### If a test fails

The report is designed for another Claude agent to consume:
```
Read the report at tests/reports/minimal-dao-*.md. The MCP's calldata
diverges from the frontend at the fields listed. Fix the MCP tool in
src/tools/daoDeploy.ts to match the frontend's encoding.
```

## Known gotchas

1. **IPFS CIDs will always differ** — the `executorDescription` and `descriptionURL` fields contain IPFS hashes from separate uploads. These are expected diffs, not bugs. The comparator flags them but you can ignore.

2. **The interceptor blocks MetaMask** — it returns a fake tx hash so no real transaction is sent. The frontend may show an error after the "tx" is "mined" since it's fake. That's fine — we only need the calldata.

3. **React input filling** — the form-filler uses the native value setter hack to trigger React's onChange. If a field doesn't fill correctly, check if the component uses a custom input wrapper that doesn't respond to standard events.

4. **Wizard navigation timing** — after calling `nextStep()`, wait 1-2 seconds before filling the next step. The page transition is animated.

5. **Token creation auto-wiring** — when the fixture uses `tokenType: "create"`, both frontend and MCP call `predictGovAddresses` on-chain. If the deployer address or DAO name differs, the predicted addresses diverge and everything downstream fails.

## Fixture template variables

Replace these before running:

| Variable | How to get it |
|---|---|
| `{{DEPLOYER_ADDRESS}}` | `window.ethereum.selectedAddress` or `await window.ethereum.request({method: 'eth_accounts'})` |
| `{{DESCRIPTION_URL}}` | Run `dexe_ipfs_upload_dao_metadata` with the fixture's metadata, use the returned CID |
| `{{DAO_ADDRESS}}` | Only for proposal fixtures — use an existing DAO address |
