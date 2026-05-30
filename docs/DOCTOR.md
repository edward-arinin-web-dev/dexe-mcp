# `dexe_doctor` — diagnostic reference

The `dexe_doctor` tool (and its CLI twin `npx dexe-mcp doctor`) is the
canonical "what is wrong with my setup?" diagnostic. It walks every
recognized `DEXE_*` env var, reaches out to every configured external
dependency, and returns a structured pass/warn/fail report.

This document lists every check, what it verifies, what each outcome
means, and how to fix the failure cases.

---

## Invoking

Three equivalent entry points:

1. **From inside Claude Code:** call the `dexe_doctor` MCP tool. No
   arguments.
2. **From a shell:** `npx dexe-mcp doctor`. Exits with status:
   - `0` — every check passed
   - `1` — warnings only, no failures
   - `2` — at least one failure
3. **Via the `/dexe-setup` skill:** the skill calls `dexe_doctor` for
   you, then parses the report into questions.

The MCP tool and the CLI share `src/diag/checks.ts` — they always agree.

---

## Status legend

| Status | Meaning |
|--------|---------|
| `pass` | Check succeeded. |
| `warn` | Non-fatal. Examples: a network check timed out (≥ 3s), an optional var is unset. Doctor does not flag warnings as failures. |
| `fail` | Real problem. Each fail carries a `remediation` field that is paste-ready — copy it into a chat with the user and they'll know what to do. |

Network checks have a 3-second hard timeout that downgrades to `warn`,
never `fail`. The reason: a flaky corporate VPN or an offline laptop
should not produce all-red output and obscure the real misconfigurations
the doctor would otherwise have caught.

---

## The checks

### Env presence / validation — `env.<KEY>`

One result per recognized `DEXE_*` key that is set. Walks every entry in
[`ENV_SPEC`](../src/env/schema.ts) and runs its zod schema.

- `pass` — value is set and matches the schema. Secrets are masked
  (`set (redacted)`).
- `fail` — value present but invalid. The `remediation` cites
  `ENV_SPEC[key].doc` so the fix is obvious.

Optional vars that are unset produce no result (would be noise).

### RPC reachability — `rpc.reachable.<chainId>`

For every chain configured in `config.chains`, doctor POSTs
`eth_chainId` and verifies the response matches the configured chain.

- `pass` — reached the RPC, got the expected chain id.
- `warn` — RPC timed out after 3s. Usually a transient network issue.
- `fail` — RPC unreachable or returned the wrong chain. Doctor names
  the alternative source `https://chainlist.org` in the remediation.

### Pinata JWT — `pinata.jwt`

Only runs when `DEXE_PINATA_JWT` is set. Calls
`GET https://api.pinata.cloud/data/testAuthentication` with the JWT as a
bearer token.

- `pass` — Pinata accepted the JWT.
- `fail` — HTTP 401/403, or a network error. Remediation: regenerate the
  JWT at <https://app.pinata.cloud/developers/api-keys> with the
  `pinning` scope.
- `warn` — timed out.

### IPFS gateway DNS — `ipfs.gateway.dns`

Only runs when `DEXE_IPFS_GATEWAY` is set. Resolves the hostname via
`node:dns`.

- `pass` — DNS resolved.
- `fail` — DNS failed. Most common cause: a typo in the subdomain.
  Pinata dedicated gateways follow `https://<subdomain>.mypinata.cloud`.

### Subgraph reachability — `subgraph.<id>.reachable`

For every configured `DEXE_SUBGRAPH_*_URL`, doctor POSTs
`{ __typename }` (with `DEXE_GRAPH_API_KEY` as bearer auth when set).

- `pass` — gateway responded with HTTP 2xx.
- `fail` — HTTP 4xx (usually 401 = missing/invalid `DEXE_GRAPH_API_KEY`,
  or 404 = wrong subgraph id).
- `warn` — timed out.

### Backend reachability — `backend.reachable`

Only runs when `DEXE_BACKEND_API_URL` is set. Plain GET on the root.

- `pass` — reached.
- `fail` — unreachable.
- `warn` — timed out.

### Signer broadcast guards — `signer.allowlist` / `signer.maxValue` / `signer.rate`

Only run when the respective env vars are set. Parses each value to
verify the guard would activate correctly.

- `pass` — value parses cleanly. Doctor reports the parsed value
  (`3 addr(s) allowed`, `cap=1000000000000000000 wei`, `10/min`).
- `fail` — value does not parse (e.g. malformed address, non-integer
  wei).

### Chain consistency — `chain.consistency` / `chain.signerNeedsRpc`

- `chain.consistency` (`pass`) — `DEXE_DEFAULT_CHAIN_ID` appears in the
  configured chain set. The check exists so the doctor's report tells the
  user the chain shape.
- `chain.signerNeedsRpc` (`fail`) — `DEXE_PRIVATE_KEY` is set but no RPC
  is configured. Broadcasts would fail at runtime; doctor catches it at
  setup time.

---

## Tool output shape

`dexe_doctor` returns both a human-readable `text` block and a
`structuredContent` JSON object:

```json
{
  "summary": { "status": "warn", "passed": 19, "warnings": 0, "failures": 1 },
  "checks": [
    {
      "id": "env.DEXE_RPC_URL_MAINNET",
      "category": "rpc",
      "status": "pass",
      "message": "set"
    },
    {
      "id": "ipfs.gateway.dns",
      "category": "ipfs",
      "status": "fail",
      "message": "DNS lookup for dexe-network.mypinata.cloud failed: ENOTFOUND",
      "remediation": "Check the hostname in DEXE_IPFS_GATEWAY. Pinata dedicated gateways follow https://<subdomain>.mypinata.cloud."
    }
  ],
  "remediationSummary": [
    "ipfs.gateway.dns: Check the hostname in DEXE_IPFS_GATEWAY..."
  ],
  "startupTime": "2026-05-30T14:11:36.000Z",
  "uptimeSec": 7
}
```

The `startupTime` field is load-bearing — when a user edits `.env` and
re-runs the doctor without restarting Claude Code, the `startupTime`
stays the same and tells the assistant that the new values were NOT
loaded.

---

## When the doctor is silent

If `dexe_doctor` reports `summary: { passed: 0, warnings: 0, failures: 0 }`,
the MCP server is running but no env vars are configured at all. Either
the `.env` file is missing or the MCP host is launching the binary with
an empty environment. Run `npx dexe-mcp doctor` from a shell with the
project directory as `cwd` to confirm whether `.env` is being read.

If `dexe_doctor` returns at all, the schema is loading correctly. If the
tool is not even registered, the build is broken — re-run `npm run build`
and check the MCP host's logs for startup errors.

---

## Adding a new check

Edit `src/diag/checks.ts`. Each check is an `async function` returning
`CheckResult | null` (return `null` to skip when the relevant env is
unset). Add it to the `Promise.all([...])` block in `runAllChecks`. Add
a row to this document. Write a test in `tests/diag/checks.test.ts` that
mocks `fetch` and asserts the new check's pass/fail/warn behavior.
