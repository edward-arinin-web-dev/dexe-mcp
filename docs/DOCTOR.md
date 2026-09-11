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
2. **From a shell:** `npx dexe-mcp doctor [--strict] [--probe-pin]`. Exits with status:
   - `0` — no check failed. **Warnings only is still `0`** — that is the
     normal result for a zero-config install (see below).
   - `1` — warnings present AND `--strict` (or `DEXE_DOCTOR_STRICT=1`)
   - `2` — at least one failure, **or an unknown flag** (an unrecognized
     option is reported and exits `2` rather than being silently ignored,
     so `--Strict` or `--strict=true` in CI cannot go green by accident)
3. **Via the `/dexe-setup` skill:** the skill calls `dexe_doctor` for
   you, then parses the report into questions.

A healthy zero-config install ends at roughly `10 pass / 3 warn / 0 fail`,
exit `0`. The three warnings — `env.file`, `chain.publicRpcFallback` and
`env.sharedDefaults` — cannot be cleared without configuring things the
product explicitly says you do not need, so they are the expected healthy
state, not a to-do list. Pass `--strict` in CI if you want warnings to be
non-zero there.

`--probe-pin` additionally verifies that your Pinata account can actually
pin. It is the only check that WRITES anything — see
[Pinata pin capability](#pinata-pin-capability--pinatapinquota-opt-in-writes).

The MCP tool and the CLI share `src/diag/checks.ts` — they always agree.

---

## Status legend

| Status | Meaning |
|--------|---------|
| `pass` | Check succeeded. |
| `warn` | Non-fatal **advisory**. Examples: a network check timed out (≥ 3s), an optional var is unset, a default is shared. Doctor does not flag warnings as failures, and neither does its exit code. |
| `fail` | Real problem. Each fail carries a `remediation` field that is paste-ready — copy it into a chat with the user and they'll know what to do. |

The MCP tool reports the same thing: `summary.advisoryOnly` is `true` when
nothing failed but warnings exist, and the text headline then reads
`OK, no failures` instead of `WARN`. `summary.status` keeps its original
`pass | warn | fail` mapping for backward compatibility.

A network probe that **times out** downgrades to `warn`, never `fail`: a
flaky corporate VPN or an offline laptop should not produce all-red output
and obscure the real misconfigurations. A probe that gets a **definitive
negative answer** (wrong chain id, NXDOMAIN with no HTTPS answer, HTTP 401)
still fails, because that is actionable.

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

- `pass` — Pinata accepted the JWT. Note that authentication passing does
  NOT prove the account can pin; a plan-usage block returns HTTP 403 on
  every upload while this row stays green. The row's `remediation` says so
  and points at `--probe-pin`.
- `fail` — HTTP 401/403, or a network error. Remediation: regenerate the
  JWT at <https://app.pinata.cloud/developers/api-keys> with the
  `pinning` scope.
- `warn` — timed out.

### Pinata pin capability — `pinata.pinQuota` (opt-in, WRITES)

**Off by default, and emits no row at all when off.** Enable it with
`npx dexe-mcp doctor --probe-pin` or `dexe_doctor { "probePin": true }`.
Only runs when `DEXE_PINATA_JWT` is set.

It pins ~40 bytes of deterministic JSON named `dexe-mcp-doctor-probe` and
immediately unpins it. This is the only doctor check that writes anything
anywhere — everything else is a read. A pinning-only JWT cannot unpin, in
which case the probe says so and the tiny pin stays in your account until
you delete it at app.pinata.cloud.

Reach for it when `pinata.jwt` is green but an IPFS upload fails with
HTTP 403.

- `pass` — the account can pin. The message names the write and whether
  the cleanup succeeded.
- `fail` — HTTP 4xx on the pin, typically the free-plan usage limit.
  Every IPFS-write flow (proposal creation, DAO deploy metadata, avatar
  uploads) is down until this passes.
- `warn` — timed out or unreachable.

### IPFS gateway reachability — `ipfs.gateway.dns`

Only runs when `DEXE_IPFS_GATEWAY` is set. A scheme-less value
(`DEXE_IPFS_GATEWAY=gateway.pinata.cloud`) is accepted, exactly as the read
path accepts it.

Two stages, because the question is "can this process reach the gateway?",
not "does the configured recursive nameserver answer an A query over
UDP/53?":

1. `dns.lookup` (getaddrinfo) — the resolution path `fetch` and every real
   read already use.
2. Only if stage 1 failed: an HTTPS `HEAD` against the gateway. Anything
   that answers was obviously resolvable.

- `pass` — stage 1 resolved, or stage 2 got an HTTP response. In the
  second case the message names your system resolver, because a local
  stub (Windows DoH client, VPN split-DNS, pi-hole/NextDNS/AdGuard) that
  refuses direct queries is the usual cause and affects nothing else.
- `warn` — the resolver refused or timed out AND the gateway did not
  answer over HTTPS. No action needed unless IPFS reads actually fail.
- `fail` — the host genuinely does not resolve (NXDOMAIN) and does not
  answer over HTTPS. Most common cause: a typo in the subdomain. Pinata
  dedicated gateways follow `https://<subdomain>.mypinata.cloud`. Reads
  keep working meanwhile via the fallback gateways.

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
  "summary": {
    "status": "warn",
    "advisoryOnly": true,
    "passed": 19,
    "warnings": 1,
    "failures": 0
  },
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
      "status": "pass",
      "message": "gateway.pinata.cloud is reachable over HTTPS (HTTP 401); the direct DNS query was refused by the system resolver (127.0.0.1) — that does not affect IPFS reads."
    },
    {
      "id": "chain.publicRpcFallback",
      "category": "rpc",
      "status": "warn",
      "message": "No RPC configured — using public BSC fallback",
      "remediation": "Set DEXE_RPC_URL_MAINNET to your own endpoint for reliability."
    }
  ],
  "remediationSummary": [
    "chain.publicRpcFallback: Set DEXE_RPC_URL_MAINNET to your own endpoint..."
  ],
  "startupTime": "2026-05-30T14:11:36.000Z",
  "uptimeSec": 7
}
```

`summary.advisoryOnly` is `true` here: nothing failed, so the CLI exits `0`
and the text headline reads `OK, no failures`. `summary.status` stays
`"warn"` for backward compatibility — branch on `failures === 0` (or
`advisoryOnly`), never on `status === "pass"`.

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

## Related: `dexe_compile` diagnostics

Not a doctor check, but the same "tell me what actually broke" contract:
`dexe_compile` parses solc's output and returns real `diagnostics[]` — each
row carries `severity` (`error` | `warning`), the solc `code` where present,
the `message`, and the `file` + `line` it points at — alongside `errorCount`,
`warningCount` and the path to the full log. Read the diagnostics, not the
`stdoutTail`.

---

## Adding a new check

Edit `src/diag/checks.ts`. Each check is an `async function` returning
`CheckResult | null` (return `null` to skip when the relevant env is
unset). Add it to the `Promise.all([...])` block in `runAllChecks`. Add
a row to this document. Write a test in `tests/diag/checks.test.ts` that
mocks `fetch` and asserts the new check's pass/fail/warn behavior.

Two rules a new check must obey:

- **A check that performs any write must be opt-in, and must say so in its
  own message.** `dexe_doctor` tells the calling model it performs no
  writes; that promise has to stay true by default.
- **Never emit a synthetic `pass` for something you did not verify.** Both
  tallies count by status, so a "not probed — assumed fine" row inflates
  `summary.passed` with a verification that never happened. Skip the row
  (return `null`) and put the pointer on a row that did run. And do not
  invent a fourth status: `CheckStatus` is `pass | warn | fail`, and both
  renderers count anything else as a failure.
