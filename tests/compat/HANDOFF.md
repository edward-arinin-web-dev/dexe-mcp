# E2E Compat Test — Handoff / Resume Context

## What happened (2026-04-21)

Ran first E2E compat test: **DAO creation (minimal-dao fixture)**

### Result: NEAR-PASS

13 word diffs in 4708-byte calldata:
- **12 diffs = expected IPFS CID differences** (separate uploads → different hashes)
- **1 real bug = `descriptionURL` encoding**

### The Bug

**File:** `src/tools/daoDeploy.ts`  
**Issue:** MCP encodes `descriptionURL` WITH `ipfs://` prefix in calldata. Frontend strips the prefix before ABI encoding.

- Frontend calldata: `QmfS7gDUZR9orSCgTGT4SZxgJfLTe4rqKMHdb6kAw37zRS` (46 bytes)
- MCP calldata: `ipfs://QmfS7gDUZR9orSCgTGT4SZxgJfLTe4rqKMHdb6kAw37zRS` (53 bytes)

**Fix:** In `daoDeploy.ts`, strip `ipfs://` prefix from `descriptionURL` before passing to ABI encoder.

### Test Parameters Used

| Field | Value |
|---|---|
| DAO Name | CompatTestDAO |
| Token | DEXE `0x6E88056E8376Ae7709496Ba64d37fa2f8015ce3e` (BSC) |
| Voting model | Linear |
| Duration | 1 Day (86400s) |
| Execution delay | 0 Seconds |
| Quorum | 50% |
| Vote in proposals | 100 |
| Create proposals | 500 |
| Delegation | on |
| Early completion | on |
| Validators | off |
| Deployer | `0xCa543e570e4A1F6DA7cf9C4C7211692Bc105a00A` |
| Factory | `0x85f86ef7e72e86bdeab5f65e2b76a2c551f22109` |

### Artifacts

| File | Contents |
|---|---|
| `tests/reports/frontend-calldata.hex` | Frontend calldata (9418 chars) |
| `tests/reports/mcp-calldata-full.json` | MCP calldata JSON |
| `tests/reports/rpc-3670-request.json` | Raw frontend eth_estimateGas |
| `tests/reports/pinata-*-request.json` | IPFS upload payloads (4 uploads) |
| `tests/reports/pinata-*-response.json` | IPFS CIDs returned |
| `tests/reports/compare2.mjs` | Node comparison script |
| `tests/compat/FORM-GUIDE.md` | Form-filling reference for Chrome DevTools MCP |

### IPFS Upload Mapping (Frontend)

1. `QmS58BXBahpG9D8QUWncC3qR6138ZcVBLw4vHHK3ZqaDTD` — proposal settings (earlyCompletion=true, delegatedVotingAllowed=false)
2. `QmZ2QjJhKCvZpnhSHJ4qhcoGKktQzVtJMiJm6EdtjvHe1f` — proposal settings (earlyCompletion=false, delegatedVotingAllowed=false)
3. `QmetNhZyy9mFXnGEVYSbjgjh83HQYTWDYBqB4qNUhanFjr` — empty Slate description
4. `QmfS7gDUZR9orSCgTGT4SZxgJfLTe4rqKMHdb6kAw37zRS` — DAO metadata (name, website, description link, socials)

### Frontend Observations

- Frontend auto-expands 1 user setting to 5 proposal settings (default, internal, validators, DP, tokenSale)
- `delegatedVotingAllowed` is contract-inverted: UI "delegation on" = false in calldata (ALLOWS delegation)
- Proposal setting #4 (DPSettings/index 3) forces `earlyCompletion: false`, `delegatedVotingAllowed: false`
- `executorDescription` per proposal setting = IPFS CID of that setting's JSON
- Validators section auto-fills: name="Validator Token", symbol="VT"
- WalletConnect doesn't inject `window.ethereum` — capture calldata from `eth_estimateGas` network request

## Next Steps

1. **Fix `descriptionURL` bug** in `src/tools/daoDeploy.ts`
2. **Re-run DAO creation test** to verify fix → should be PASS (only IPFS CID diffs)
3. **Proposal tests** — use `tests/fixtures/offchain-proposal.json` fixture next
4. Read `tests/compat/FORM-GUIDE.md` for form-filling reference
5. Read `tests/compat/orchestrator.md` for full flow protocol

## Browser Setup

- Chrome DevTools MCP (built-in) — launches own Chrome, no extensions
- Wallet connected via WalletConnect QR scan (not MetaMask)
- Frontend at `https://localhost:3000/`
- wagmi v1.1 stores wallet state in localStorage
