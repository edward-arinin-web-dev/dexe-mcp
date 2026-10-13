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

> **Since 1.0.0 a hot key alone never signs.** With `DEXE_SIGNER_MODE` unset,
> a `DEXE_PRIVATE_KEY` (or keyring slot) in the environment is ignored — the
> mode is `walletconnect` — and `dexe_doctor` fails `signer.hotKeyIgnored` with
> the three ways out. 0.37 signed `unattended` on every chain in that setup.
> [MIGRATION.md](./MIGRATION.md) has the steps.

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
   `dexe_proposal_vote_and_execute`, `dexe_dao_create`, an OTC composite —
   or, for a signature, `dexe_auth_login` / `dexe_safe_propose_tx`; see
   [Messages and Safe transactions](#messages-and-safe-transactions-since-100)).
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
   and press **Approve and sign** (or decide in a terminal with
   [`npx dexe-mcp approve`](#approving-in-a-terminal-dexe-mcp-approve)). The key is decrypted for exactly that batch:
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

### Messages and Safe transactions (since 1.0.0)

Two signatures that are not transactions go through the same approval — same
page, same password, same lockout, single use:

| Tool | Approval kind | What is signed | Bound to |
|---|---|---|---|
| `dexe_auth_login` | `message` | the DeXe backend's login nonce, EIP-191 `personal_sign` | `keccak(chainId, from, keccak(message bytes))` |
| `dexe_safe_propose_tx` with `sign: true` or `dryRun: false` | `safeTx` | the Safe's EIP-712 `SafeTx` (an owner signature) | `keccak(chainId, from, EIP-712 digest)` |

Both return `awaiting_approval` until you approve, then you re-run the same
call (or approve while it waits). `dexe_auth_login` re-uses the nonce message
it already put up for approval, so the page you approved is the message that
is signed; if the backend's nonce expired meanwhile, the login fails and a
re-run asks again for a fresh one.

**What the page shows for a message** — derived from the bytes, never from the
AI: the exact text, in full (messages over 4 KB are refused, so nothing is
ever cut off), its size and hex, and the EIP-191 hash. Characters that could
hide or reorder text — control characters, zero-width and direction-changing
characters, look-alike spaces, the BOM — are shown as `⟨U+202E⟩` markers and
never dropped. Flags: DANGER for binary data, exactly 32 raw bytes (a hash in
disguise), hex text, EIP-712 JSON passed as a message, an encoded
transaction, hidden characters; warnings for addresses (your own is noted as
yours), amounts, approval / permit / transfer wording and non-ASCII letters.
The "For:" line ("Log in to the DeXe backend at https://api.dexe.io as 0x…")
is written by the server.

**What the page shows for a Safe transaction** — checked on-chain before the
page exists: the address holds code and answers like a Safe, version 1.3.0 or
later, **your keystore address is one of its owners** (otherwise nothing is
put up — a non-owner signature is worthless), and its implementation is a
canonical Safe 1.3.0 / 1.4.1 deployment (anything else is DANGER). Shown: the
threshold (a threshold of 1 is a warning — your signature alone lets anyone
execute it), the nonce against the Safe's next nonce, the `safeTxHash` to
compare with your co-owners, and what the Safe will do — the inner call
decoded with the same decoder, labels and handover checks as a transaction.
`DELEGATECALL` is DANGER, a call to the Safe itself is named
(`swapOwner(…)`, `changeThreshold(…)` …) and DANGER, a MultiSend is unpacked
into its sub-calls (each checked; an inner DELEGATECALL or self-call is
DANGER), a gas refund is a warning. The broadcast guards (B6 / B7 / B11 / B12,
and B13 for DELEGATECALL) run on the inner call and every MultiSend sub-call
first. With `dryRun: false` the Safe service endpoint and its API key are
checked before you are asked, so an approval is never spent on a POST that
cannot happen.

**Refused on this path, always** (no page): typed data other than a
canonical `SafeTx`; anything permit-shaped — ERC-2612 `Permit`, Uniswap
Permit2 (`PermitSingle`, `PermitBatch`, `PermitTransferFrom`, the Permit2
contract as the domain) or any struct with a spender plus an amount or
deadline — because a signed permit moves tokens with no transaction for you to
review; a typed-data domain whose `chainId` is not the approval's chain or
whose contract is not the reviewed Safe; empty messages and messages over
4 KB. At signing time the approved signer re-checks all of it: other bytes,
another digest, another domain chain or a second use revoke the approval and
drop the key.

`dexe_agents_fund` runs only in unattended mode. `signerKey` (the agent
keyring) does not apply: a keystore server has one key.

### Approving in a terminal: `dexe-mcp approve`

For SSH sessions, or if you would rather not type the password into a browser
an AI agent might be driving:

```bash
npx dexe-mcp approve              # every approval waiting in the running server(s)
npx dexe-mcp approve apr_x1Y2z3   # just that one
npx dexe-mcp approve --list       # print the reviews only (works without a terminal)
```

It prints the same review as the page — chain, signer, fingerprint, each call
decoded with labels and flags, the exact message, the verified Safe — then asks
`Approve (a), decline (d) or skip (s)?` and the keystore password with echo
off. The password goes to the server's one password check: the same global
lockout as the page (wrong guesses on the page and in the terminal add up),
the same single-use approval. Deciding **refuses without an interactive
terminal** — an AI agent's shell is a pipe, and an agent piping a password in
is exactly what this must not allow. On Windows, use Windows Terminal,
PowerShell or cmd (Git Bash's mintty is not a console Node can read a hidden
password from).

How it finds the server — owner-only, by design:

- The server opens the channel with its first approval and writes
  `~/.dexe-mcp/run/approve-<pid>.json` (directory `0700`, file `0600`,
  written atomically) holding its pid, keystore address, endpoint and a
  256-bit per-process secret. Every request must carry the secret.
- The endpoint is a unix socket in that directory (`0600`; the kernel refuses
  other users before a byte is exchanged) on macOS/Linux, and a named pipe
  with 128 random bits in its name on Windows (created as the first instance,
  so a pipe someone pre-created makes the server's bind fail instead of being
  shared; the default pipe ACL lets only you, SYSTEM and Administrators write
  to it).
- `dexe-mcp approve` trusts a rendezvous file only if the directory, the file
  and the socket are owned by you, grant nothing to group or others, and are
  not symlinks — a file planted by another local user would point at their
  socket and collect your password. Node cannot read Windows ACLs, so on
  Windows this rests on your profile folder's default permissions.
- A decision names the approval's binding hash, so it is always about the
  review the terminal displayed.
- Stale files: the server removes its file when it exits; a killed server's
  file is deleted by the next server or `dexe-mcp approve` once the pid is gone
  or the endpoint no longer answers.

**What the terminal channel does not change:** an agent that runs shell
commands as you can read the secret and talk to the channel (it gains nothing
the page did not already give it — it still needs the password, under the
same lockout), and it can also put a fake `dexe-mcp` first on your `PATH` or
replace the rendezvous file with its own look-alike server to collect the
password you type. **For agents with shell access, WalletConnect remains the
recommendation.**

A keystore whose KDF is weaker than scrypt N=2^17 (or uses pbkdf2) is
**refused** at startup and again at every unlock; `npx dexe-mcp key
change-password` (or `key import --json`) re-encrypts it at N=2^18.

### Headless machines and SSH

The page is served on `127.0.0.1` of the machine running the server. Over SSH,
run `npx dexe-mcp approve` in another SSH session on that machine (same user),
or forward the port (`ssh -L 53817:127.0.0.1:53817 host`, the port from the
link) and open the link locally — or use `walletconnect` on headless hosts.
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
payload, a backend that sends a disguised login message). **Covered.** Nothing
signs without the password typed on the page or in `dexe-mcp approve`.
The review decodes the calldata from the bytes and labels addresses from the
chain, so a misleading description cannot hide what is signed; a message is
shown in full with hidden characters made visible and hash / transaction /
typed-data / permit look-alikes flagged; a Safe is verified on-chain. An
approval is bound to exactly what is signed — the batch (`keccak(chainId,
from, ordered (to, value, keccak(data)))`), the message bytes, or the SafeTx
EIP-712 digest — and is single-use: an approval for one call cannot be spent
on another, and a changed call gets its own page. Permits are never signed
here. Declines cannot be worn down by retries (10-minute cooldown).

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
- **Limitation: the same AI can fake the terminal too.** `dexe-mcp approve`
  refuses to read a password from a pipe, and only trusts an owner-only
  rendezvous — which stops other local users and an agent that merely pipes
  text, not one that runs code as you: it can read the per-process secret,
  replace the rendezvous file with its own look-alike server, put a fake
  `dexe-mcp` on your `PATH`, or run the real one under a pseudo-terminal. The
  terminal channel is for owners who distrust an AI-driven *browser*; it is no
  defence against an AI-driven *shell*.
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
  a contract is called a GovPool — and its UserKeeper / settings / token /
  staking contract are labelled — only if `PoolRegistry.isGovPool()` confirms
  it. A contract that merely answers like a GovPool is flagged **"NOT a
  registered DeXe DAO"**; a DeXe protocol function (deposit, vote, delegate, …)
  sent to anything the registry does not vouch for is flagged **"NOT a
  registered DeXe contract"** and shown without a contract name.
  Token-sale / distribution contracts that name a confirmed pool themselves
  get a warning that the link is their own claim.
- Every way of handing something over is checked the same way — `approve`,
  `increaseAllowance`, `permit`, `setApprovalForAll`, `transfer`,
  `transferFrom`, `safeTransferFrom`, and `delegate` (the delegatee is shown) —
  at the top level, inside a `multicall` and inside proposal actions: a
  code-less spender or recipient is DANGER, an unknown contract a warning,
  an unlimited allowance or approval-for-all DANGER.
- When `DEXE_CONTRACTS_REGISTRY` points somewhere other than the built-in
  registry for chain 56 / 97, the page says so: "registered" is relative to it.

### Residual risks, stated plainly

- **The TTY check on `dexe-mcp key` can be bypassed** with a pseudo-terminal.
  That gains an agent nothing: it can only create or import keys it already
  holds, and none of them owns your funds or voting power. Your keystore's
  password never passes through it.
- **The TTY check on `dexe-mcp approve` can be bypassed the same way** — or
  skipped by speaking the channel protocol directly with the secret from the
  rendezvous file. Either way the agent still has to supply the password, and
  its guesses count toward the same global lockout as the page's.
- **`navigator.webdriver` is reported by the browser** and an agent that
  controls the browser (or crafts its own request) can lie about it. It only
  catches standard automation; the password is the real gate.
- **The decline cooldown is keyed to the exact batch.** A 1-wei variation is a
  new batch and gets a new page — it still needs your password, and the
  3-open / 6-per-minute limits bound how often you can be asked.
- **An agent can lock you out on purpose.** Wrong guesses on the page lock
  password entry for everyone — during a lockout even the correct password is
  refused (HTTP 429), for up to an hour as the lockout doubles. That is a
  deliberate trade-off: it costs you time, never funds. Restarting the server
  clears the counter (approvals live in memory only), which takes the MCP
  host, you, or a shell able to kill the process.
- **A decrypted key lives in this process** from your approval until the
  batch is sent or the signature produced (at most `DEXE_APPROVAL_USE_S`
  before that starts), and JavaScript cannot wipe a string. An agent with a
  shell can read process memory — use WalletConnect for such agents (see the
  threat model).
- **A message signature is only as safe as what it is for.** The page shows
  the exact text and flags disguised content, but a login message cannot be
  checked against the service that issued it: an approved login hands that
  service (the configured `DEXE_BACKEND_API_URL`, shown on the page) a session
  as you. Approve logins only to the backend you expect.
- **A Safe signature does not need to be broadcast to matter.** Once the
  threshold is met anyone can execute it, until the nonce is used. The page
  shows the threshold and warns at 1; compare the `safeTxHash` with your
  co-owners'.
- **An unknown Safe implementation is flagged, not refused.** Safes on newer
  or custom singletons exist; such a Safe is shown with DANGER and the decision
  is yours.

See also [SECURITY.md](./SECURITY.md) (guards, posture) and
[WALLETCONNECT.md](./WALLETCONNECT.md) (the default mode).
