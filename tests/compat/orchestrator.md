# E2E Compatibility Test Orchestrator

This document is the **runbook** for Claude Code (or a human operator) to execute
the full E2E compat test flow. It is NOT a script — it's a step-by-step protocol
because the flow requires Chrome DevTools MCP interaction which can't be fully automated
in a headless script.

## Prerequisites

1. Frontend running locally at `https://localhost:3000/`
2. MetaMask (or any injected wallet) connected to BSC mainnet with a funded account
3. Claude Code running with Chrome DevTools MCP connected to the browser
4. `dexe-mcp` built and available (either `npm start` or via Claude Code's MCP config)
5. `DEXE_PINATA_JWT` set in environment (for IPFS uploads in the MCP)

## Flow per Test Fixture

### Phase 1: Inject Scripts

```
Via Chrome DevTools MCP → javascript_tool:

1. Read and inject tests/compat/interceptor.js
2. Read and inject tests/compat/form-filler.js
3. Verify: window.__DEXE_COMPAT_INTERCEPTOR__ exists
4. Verify: window.__DEXE_FORM_FILLER__ exists
```

### Phase 2: Navigate to DAO Creation

```
Via Chrome DevTools MCP → navigate:
  URL: https://localhost:3000/create-fund-dao/basic-settings

Wait for the form to load (check for data-testid="Create DAO (Basic DAO Settings)/DAO name input")
```

### Phase 3: Fill Form (per fixture)

Load the fixture JSON (e.g., `tests/fixtures/minimal-dao.json`).
Replace `{{DEPLOYER_ADDRESS}}` with the connected wallet address.

```
Via Chrome DevTools MCP → javascript_tool:

// Step 1: Basic Settings
window.__DEXE_FORM_FILLER__.fillBasicSettings(fixture.formValues.basicSettings);

// Navigate to next step
window.__DEXE_FORM_FILLER__.nextStep();
// Wait 1-2 seconds for page transition

// Step 2: Governance
window.__DEXE_FORM_FILLER__.fillGovernance(fixture.formValues.governance);
window.__DEXE_FORM_FILLER__.nextStep();

// Step 3: Create Token (if governance.tokenType === 'create')
if (fixture.formValues.createToken) {
  window.__DEXE_FORM_FILLER__.fillCreateToken(fixture.formValues.createToken);
  window.__DEXE_FORM_FILLER__.nextStep();
}

// Step 4: Voting Parameters
window.__DEXE_FORM_FILLER__.fillVotingParameters(fixture.formValues.votingParameters);
window.__DEXE_FORM_FILLER__.nextStep();

// Step 5: Validators
window.__DEXE_FORM_FILLER__.fillValidators(fixture.formValues.validators);
window.__DEXE_FORM_FILLER__.nextStep();

// Now on Summary page
```

### Phase 4: Capture Frontend Calldata

```
Via Chrome DevTools MCP → javascript_tool:

// Reset captures
window.__DEXE_COMPAT_INTERCEPTOR__.captured = [];
window.__DEXE_COMPAT_INTERCEPTOR__.listening = true;

// Click "Create DAO"
window.__DEXE_FORM_FILLER__.submitDao();

// Wait 2-5 seconds for the transaction to be intercepted
// (the interceptor blocks it and returns a fake hash)

// Read captured calldata
JSON.stringify(window.__DEXE_COMPAT_INTERCEPTOR__.captured);
```

Save the captured `data` field — this is the frontend's calldata.

### Phase 5: Generate MCP Calldata

Call the MCP tool with the fixture's `mcpToolCall` args:

```
Use MCP tool: dexe_dao_build_deploy
Args: fixture.mcpToolCall.args (with {{DEPLOYER_ADDRESS}} replaced)
```

Extract the `payload.data` field from the response.

### Phase 6: Compare

```bash
npx tsx tests/compat/comparator.ts "<frontend_hex>" "<mcp_hex>" "<fixture_id>"
```

Or programmatically:
```typescript
import { compare, toMarkdown } from './tests/compat/comparator.ts';
const report = compare(frontendHex, mcpHex, fixtureId);
fs.writeFileSync(`tests/reports/${fixtureId}-${Date.now()}.md`, toMarkdown(report));
```

### Phase 7: Report

If FAIL:
- The markdown report shows byte-level diff location and field-level differences
- An agent can read the report and attempt to fix the MCP tool
- Re-run the test after the fix

If PASS:
- Log success, move to next fixture

## Fixture Template Variables

| Variable | Source |
|---|---|
| `{{DEPLOYER_ADDRESS}}` | Connected wallet address (from `window.ethereum.selectedAddress` or `eth_accounts`) |
| `{{DESCRIPTION_URL}}` | IPFS CID from running `dexe_ipfs_upload_dao_metadata` first |
| `{{DAO_ADDRESS}}` | Address of an existing DAO (for proposal tests) |

## Handling Edge Cases

### IPFS-dependent fields
The `descriptionURL` and `executorDescription` fields contain IPFS CIDs which will
always differ between frontend and MCP runs (different upload timestamps, different
Pinata accounts). The comparator should **exclude** these fields from the diff or
normalize them.

To handle this: before comparing, zero out all `executorDescription` and `descriptionURL`
fields in both calldata hex strings. The comparator's `deepDiff` will flag them, but
they can be filtered in post-processing.

### Predicted addresses
The MCP calls `predictGovAddresses` on-chain to auto-wire `tokenAddress` and
`additionalProposalExecutors`. The frontend does the same via its own hook.
These should match IF both use the same deployer address and DAO name.

### Token creation auto-wiring
When creating a new token, both frontend and MCP should set
`userKeeperParams.tokenAddress` to the predicted governance token address.
A mismatch here means the prediction logic differs.

## Semi-Automatic Mode

For semi-automatic execution where Ed watches and approves each step:

1. Claude Code fills one step → pauses → Ed confirms in chat
2. Claude Code advances to next step → pauses → Ed confirms
3. On submit: Claude Code shows the captured calldata → Ed confirms comparison
4. Claude Code runs comparison → shows report → Ed decides next action

To switch to fully automatic: Claude Code runs all steps without pausing,
only stopping on FAIL to report.
