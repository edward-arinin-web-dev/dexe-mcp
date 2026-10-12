# Signing: how dexe-mcp signs, and who confirms it

Every write tool can return an unsigned payload for your own wallet. When you
want the server itself to send transactions, `DEXE_SIGNER_MODE` decides how it
signs — and whether a human confirms each transaction.

| Mode | Signs with | A human confirms | Use it for |
|---|---|---|---|
| `walletconnect` *(default)* | your phone wallet, over WalletConnect | yes — on the phone, per transaction | people, and any agent that can run shell commands or drive a browser |
| `keystore` | an encrypted key on this machine | yes — the keystore password on a local web page, per batch | people who want a local key without a plaintext file |
| `readonly` | nothing | — | build calldata only; sign elsewhere (Safe, hardware wallet) |
| `unattended` | hot keys (`DEXE_PRIVATE_KEY`, the agent keyring) | **no** | bots, CI, the swarm harness — testnet by default |

`dexe_write_context` reports the active mode (`signer.mode`), whether a human
confirms (`signer.humanConfirmation`), and any approvals waiting on you.
`npx dexe-mcp doctor` checks the setup.

> **0.37 transition.** If `DEXE_SIGNER_MODE` is unset and a hot key is present,
> the server still signs `unattended` (today's behaviour, every configured
> chain) and prints a deprecation warning. The next major removes that implicit
> default: set the mode explicitly now. [MIGRATION.md](./MIGRATION.md) has the
> steps.

## Keystore mode

An encrypted key (Web3 Secret Storage v3 — the format MetaMask, geth and ethers
use; scrypt N=2^18, r=8, p=1) in `~/.dexe-mcp/keystore/`. The password is never
stored, never in `.env`, never a tool argument: you type it on a page served by
your own server on `127.0.0.1`, once per batch.

### Set it up

Run these yourself, in a terminal — not through the AI (the commands refuse to
run without an interactive terminal, by design):

```bash
npx dexe-mcp key create            # new key; prints its address
# or
npx dexe-mcp key import            # paste an existing private key (hidden input)
npx dexe-mcp key import --from-env # move DEXE_PRIVATE_KEY from your .env into the keystore
                                   #   and delete the plaintext line
npx dexe-mcp key import --json ./UTC--…json   # re-encrypt a MetaMask/geth keystore file
```

Then in `~/.dexe-mcp/.env` (or your project `.env`):

```bash
DEXE_SIGNER_MODE=keystore
# only if the keystore directory holds several keys:
# DEXE_KEYSTORE_ADDRESS=0xYourAddress
```

Restart Claude Code, fund the address, and run `npx dexe-mcp doctor` — the
`signer.mode` row should read `keystore — 0x… signs after the owner approves
each batch`.

Back up the keystore file **and** remember the password: losing either loses
the key. There is no command that prints the private key.

### What happens on a write

1. The AI calls a write tool (`dexe_tx_send`, `dexe_proposal_create`,
   `dexe_proposal_vote_and_execute`, `dexe_dao_create`, an OTC composite).
2. The server builds the whole ordered batch (for a proposal: approve →
   deposit → create-and-vote), checks it, and opens
   `http://127.0.0.1:<port>/a/<token>` in your browser.
3. The page shows the network, the sending address, a **fingerprint**
   (`K7F-2QD`), and each transaction decoded from the bytes that will be
   signed — contract labels come from the chain (the DeXe registry, the DAO's
   own helper contracts, "no contract code" for plain addresses), not from the
   AI. Risk flags call out unlimited approvals, native value, unrecognized
   spenders, governance-changing proposal actions, mainnet. The tool's own
   description of a step is shown only as an escaped "tool's note (not
   verified)".
4. You compare the fingerprint with the one in the chat, type the password,
   and press **Approve and sign**. The key is decrypted for exactly that batch:
   it signs those transactions, in that order, once each — anything else is
   refused and the approval is revoked. The gas limit is never taken from the
   AI (you did not approve one): it is estimated by the server and refused
   above a 30M-gas cap. The page shows the transaction hashes as they land.

The tool call waits up to `DEXE_APPROVAL_WAIT_MS` (default 2 minutes; it sends
MCP progress notifications while it waits). If you approve in time it returns
the receipts. If not, it returns:

```json
{
  "mode": "awaiting_approval",
  "status": "pending",
  "approval": {
    "approvalId": "apr_x1Y2z3…",
    "url": "http://127.0.0.1:53817/a/…",
    "fingerprint": "K7F-2QD",
    "expiresAt": "2026-10-12T21:15:00.000Z",
    "chainId": 97,
    "from": "0x…",
    "steps": ["1. ERC20.approve → ERC20 token \"KRT\" …", "2. GovPool.deposit → GovPool 0xb0Ca…2145", "3. GovPool.createProposalAndVote → …"]
  },
  "next": "… approve on the page, then re-run this same call …"
}
```

Approve on the page, then ask the AI to **re-run the same call**: the approved
batch is signed without asking again. `dexe_tx_approval_status
{"approvalId": "apr_…", "waitMs": 60000}` reports `pending` / `approved` /
`executing` / `consumed` / `declined` / `expired` / `revoked` and the landed
hashes. It is read-only: no tool can approve or decline anything.

- **Decline** → the tool reports `declined` ("Owner declined; nothing
  signed. Do not retry unless the user asks."). The same batch is refused,
  without a new page, for 10 minutes.
- **Wrong passwords** are counted across **all** approvals, not per page:
  five within an hour lock password entry everywhere for a minute, then 2,
  4, … up to an hour — doubling for the life of the server; a correct password
  does not reset it. Five on one approval also decline that approval.
- **At most 3 approvals wait at once**, and at most 6 are created per minute.
  Beyond that a write returns `mode: "approval_refused"` (nothing signed, no
  new page) until you approve or decline the open ones.
- **Expiry** → an approval link lives `DEXE_APPROVAL_TTL_S` (default 15
  minutes). Once you approve, the decrypted key is held only
  `DEXE_APPROVAL_USE_S` (default 2 minutes) for the call to start sending — a
  blocking call takes it at once; on the re-run path, re-run within that
  window or approve again. The server keeps approvals in memory only; a
  restart forgets them.
- **A step fails mid-batch** → the approval is revoked and the key dropped.
  Re-running the call re-reads the chain, skips what landed, and asks for a new
  approval for the rest; the new page lists what already landed.
- **One approval per batch.** `dexe_proposal_vote_and_execute` may need more
  than one (the vote, then the validator round, then the execute are separate
  batches).

### Not available in keystore mode yet

Message and typed-data signatures — the off-chain login (`dexe_auth_login`)
and Safe transaction signatures (`dexe_safe_propose_tx` with signing) — are
refused with a pointer to WalletConnect (`dexe_wc_connect`); a connected
WalletConnect session is used for `dexe_auth_login`. `dexe_agents_fund` runs
only in unattended mode. `signerKey` (the agent keyring) does not apply: a
keystore server has one key.

A keystore whose KDF is weaker than scrypt N=2^17 (or uses pbkdf2) is
**refused** at startup and again at every unlock; `npx dexe-mcp key
change-password` (or `key import --json`) re-encrypts it at N=2^18.

### Headless machines and SSH

The page is served on `127.0.0.1` of the machine running the server. Over SSH,
forward the port (`ssh -L 53817:127.0.0.1:53817 host`, the port from the link)
and open the link locally — or use `walletconnect` on headless hosts.
`DEXE_APPROVAL_OPEN_BROWSER=0` only prints the link (stderr and the tool
result) instead of opening a browser.

### Settings

| Variable | Default | Meaning |
|---|---|---|
| `DEXE_SIGNER_MODE` | `walletconnect` | `keystore` turns this on. |
| `DEXE_KEYSTORE_PATH` | `~/.dexe-mcp/keystore` | Directory, or one keystore file. |
| `DEXE_KEYSTORE_ADDRESS` | — | Which key, when the directory holds several. |
| `DEXE_APPROVAL_WAIT_MS` | `120000` | How long a call blocks for you (max 600000; `0` returns at once). |
| `DEXE_APPROVAL_TTL_S` | `900` | Approval lifetime (60–3600). |
| `DEXE_APPROVAL_USE_S` | `120` | How long an approved batch may wait to be sent before its key is dropped (10 – TTL). |
| `DEXE_APPROVAL_OPEN_BROWSER` | `1` | `0` prints the link instead of opening it. |

### `dexe-mcp key` reference

| Command | TTY needed | Does |
|---|---|---|
| `key create` | yes | New random key, encrypted with a password you choose. |
| `key import` | yes | Paste a private key (hidden). |
| `key import --from-env` | yes | Take `DEXE_PRIVATE_KEY` from the loaded `.env`, encrypt it, remove the plaintext line, set `DEXE_SIGNER_MODE=keystore`. |
| `key import --json <file>` | yes | Re-encrypt an existing keystore v3 file under the production parameters. |
| `key list` | no | Keystores in the directory; `*` marks the one the server uses. |
| `key export-address` | no | Prints the selected address. |
| `key change-password` | yes | Re-encrypt under a new password. |
| `key remove` | yes | Delete a keystore file after you type its full address. |

Files are written atomically, `0600` in a `0700` directory on macOS/Linux. On
Windows they inherit your profile folder's permissions (you and
administrators).

## Unattended mode (bots, CI)

```bash
DEXE_SIGNER_MODE=unattended
DEXE_PRIVATE_KEY=0x…            # or the keyring: DEXE_AGENT_PK_1..16
DEXE_UNATTENDED_CHAINS=97       # the default; signing on any other chain is refused
```

Nobody confirms anything: the AI can send whatever the broadcast guards allow.
Keep it on testnet. To allow mainnet, list `56` deliberately
(`DEXE_UNATTENDED_CHAINS=97,56`) **and** cap it with `DEXE_SIGNER_ALLOWLIST` and
`DEXE_SIGNER_MAX_VALUE_WEI` — `dexe-mcp doctor` warns when a mainnet is allowed
without both. `DEXE_KEYSTORE_PASSWORD_FILE` lets unattended mode sign with the
keystore instead of a plaintext key (the password then sits in that file —
it is for CI secrets, and keystore mode never reads it). Every response that
broadcast with a hot key carries a `safety` note saying so.

## Threat model

What keystore mode protects against, and what it does not. WalletConnect
moves the signature to a separate device and covers more; hot keys cover
nothing.

**T1 — prompt injection** (text in a proposal, an IPFS document, a token
symbol, a malicious MCP server next to this one, a crafted `dexe_tx_send`
payload). **Covered.** Nothing signs without the password typed on the page.
The page decodes the calldata from the bytes and labels addresses from the
chain, so a misleading description cannot hide what is signed. An approval is
bound to its exact batch (`keccak(chainId, from, ordered (to, value,
keccak(data)))`) and is single-use: an approval for one call cannot be spent
on another, and a changed call gets its own page. Declines cannot be worn down
by retries (10-minute cooldown).

**T2 — the AI itself working around the gate.**
- There is no tool, parameter or environment variable that approves, skips or
  disables an approval (a test greps the source for any such switch).
- Re-running or replaying a call does not reuse a spent approval.
- Editing `.env` to `unattended` with a hot key only enables a key the AI made
  itself — no funds, no voting power — unless you fund it.
- **Limitation: an AI that can drive your browser can read the password as you
  type it**, or click Approve on a pre-filled field. The page refuses the
  password when the browser reports automation (`navigator.webdriver`), but
  that only catches standard automation. Do not let a browser password manager
  save the keystore password.
- **Limitation: an AI that can run shell commands can fake the page** — start
  its own server, send you a look-alike link, and capture what you type — or
  read this process's memory while a decrypted key is held (from approval
  until the batch is sent, at most `DEXE_APPROVAL_USE_S` before sending starts; JavaScript cannot
  wipe a string).
- **So: for agents with shell or browser access, use WalletConnect.** The
  signature then happens on a separate device the agent cannot reach.

**T3 — malware on this machine** (keyloggers, a compromised browser): out of
scope. A keylogger takes the password; malware with file access takes the
keystore file. Keep the password strong (12+ characters) so a stolen file is
expensive to brute-force.

### The loopback page, specifically

- Bound to `127.0.0.1` only, on a random port, started on the first approval.
- `Host` must be exactly `127.0.0.1:<port>` (DNS-rebinding pages are refused).
- Each approval has its own unguessable path token and CSRF token; POSTs must
  be same-origin, JSON, under 4 KB, and carry the CSRF token.
- Every response is `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY`; the HTML has a nonce-only Content-Security-Policy
  and loads nothing from the network.
- Password attempts run one at a time (scrypt is ~0.5–1 s each). The lockout
  is global (five wrong passwords across any approvals → 1 min, doubling to
  1 h) and is checked again inside the queue, so guesses queued before a
  lockout never run after it. At most 3 approvals wait at once, 6 per minute.
- Labels come from the chain and are only trusted through the DeXe registry:
  a contract is called a GovPool — and its UserKeeper / settings / token are
  labelled — only if `PoolRegistry.isGovPool()` confirms it. A contract that
  merely answers like a GovPool is flagged **"NOT a registered DeXe DAO"**, and
  an approval or token transfer to an address with no contract code is
  flagged as DANGER.

### Residual risks, stated plainly

- **The TTY check on `dexe-mcp key` can be bypassed** with a pseudo-terminal.
  That gains an agent nothing: it can only create or import keys it already
  holds, and none of them owns your funds or voting power. Your keystore's
  password never passes through it.
- **`navigator.webdriver` is reported by the browser** and an agent that
  controls the browser (or crafts its own request) can lie about it. It only
  catches standard automation; the password is the real gate.
- **The decline cooldown is keyed to the exact batch.** A 1-wei variation is a
  new batch and gets a new page — it still needs your password, and the
  3-open / 6-per-minute limits bound how often you can be asked.
- **A decrypted key lives in this process** from your approval until the
  batch is sent (at most `DEXE_APPROVAL_USE_S` before sending starts), and
  JavaScript cannot wipe a string. An agent with a shell can read process
  memory — use WalletConnect for such agents (see the threat model).

See also [SECURITY.md](./SECURITY.md) (guards, posture) and
[WALLETCONNECT.md](./WALLETCONNECT.md) (the default mode).
