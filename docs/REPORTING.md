# DAO reporting — one call, on a schedule

Everything you would want to know about a DAO — who is in it, who delegated to
whom, what is in the treasury, which proposals passed, who actually voted, what
needs attention today — is **one `dexe_dao_report` call**. It replaces the 12-18
reads this used to take (plus one per proposal for turnout), returns typed
`structuredContent`, and can diff itself against its own previous run, which is
what makes it usable from `/schedule` or `/loop`.

Zero config: `dexe_dao_report` is in the **default** toolset profile, and the
reads behind it need no API key and no RPC of your own.

## The call

```jsonc
// full point-in-time report
{ "govPool": "0x2546f00…935916", "chainId": 56 }
```

| Param | Default | What it does |
|---|---|---|
| `govPool` | — | DAO address. Required. |
| `chainId` | server default | 56 = BSC mainnet (fully indexed), 97 = BSC testnet (on-chain sections only). |
| `since` | — | Diff anchor. `"last"`, ISO-8601, Unix seconds, or `"block:62000000"`. |
| `sections` | all 11 | Narrow the work, e.g. `["proposals","turnout","deadlines"]`. |
| `user` | — | Adds *your* unvoted proposals + claimable rewards to `deadlines`. |
| `proposalLimit` | `30` | Newest proposals walked for state, outcome and turnout. |
| `memberLimit` | `50` | Member/delegation rows (newest joiners first). |
| `persist` | `true` | Store this run's snapshot so a later `since: "last"` has a baseline. |

Sections: `identity`, `settings`, `treasury`, `membership`, `delegation`,
`experts`, `validators`, `proposals`, `turnout`, `activity`, `deadlines`.

The text rendering leads with **NEEDS ATTENTION** (live deadlines, sorted by
time remaining) and **CHANGES SINCE …**, because those are the two things a
reader has to act on. The structured payload carries the rest.

## Only what changed: `since`

```jsonc
{ "govPool": "0x2546f00…935916", "chainId": 56, "since": "last" }
```

`since: "last"` diffs against this DAO's previous run — no timestamp
bookkeeping on your side. `changes` then carries `newProposals`,
`proposalStateChanges`, `membersJoined`, `membersCountDelta`,
`delegationChanges`, `delegationTotalDelta`, `treasuryDeltas`, plus `notes`.

> **First-run gotcha.** `since: "last"` **errors** when no snapshot exists yet
> ("this is the first run, or it ran with `persist: false`"). Run once *without*
> `since` to lay the baseline down, then use `"last"` from then on. Any
> scheduled prompt must say this, or its first execution reports an error
> instead of a report.

Other anchors: `"2026-08-01T00:00:00Z"`, `"1785000000"`, `"block:62000000"`.
`changes.baseline` says how much the diff could actually see — `snapshot`
(complete), `timestampOnly` (only what the indexer can date, e.g. the very
first `since` run), `none`.

## Which chains have coverage

| Section | Source | BSC mainnet (56) | Any other chain |
|---|---|---|---|
| `identity`, `settings`, `proposals`, `validators`, `deadlines` | on-chain RPC | yes | yes |
| `treasury` | backend, RPC fallback | yes | yes (RPC fallback) |
| `membership`, `delegation`, `turnout`, `activity`, `experts` | subgraph | yes | **no** |

The DeXe subgraphs and the DeXe backend index **BSC mainnet (56) only**.

A report on an unindexed chain is **not** an error and **not** a report full of
zeroes: each section degrades on its own, comes back `available: false` with a
`reason` and a `followUp` naming the tool to use instead, and is listed in
`unavailable[]`. **Say which sections you got.** A scheduled run that quietly
drops half the report is how a DAO gets declared healthy while nobody is voting.

To index another chain yourself, set `DEXE_SUBGRAPH_POOLS_URL_<chainId>` (plus
the `_INTERACTIONS_` / `_VALIDATORS_` variants) and restart — see
`docs/ENVIRONMENT.md`.

## Recurring: `/loop` (local, this session)

Runs in the session you are in, at a wall-clock interval, with your local MCP
server and your local `.env`.

Daily digest:

```
/loop 24h Call dexe_dao_report {govPool:"0x2546f00…935916", chainId:56, since:"last"}. If it errors because there is no baseline, call it again without `since`. Post a 5-line digest: live deadlines, new proposals, state changes, member/delegation moves, treasury deltas. If nothing changed, say "no change" in one line. Name any section that came back unavailable.
```

Hourly watch for proposals that need *your* vote:

```
/loop 1h Call dexe_dao_report {govPool:"0x2546f00…935916", chainId:56, user:"0xYourWallet", sections:["deadlines","proposals"]}. Only speak up if deadlines contains an item I have not voted on or something is executable — otherwise reply exactly "clear". Include the proposal id and the time remaining.
```

Notes:
- `/loop 5m …` down to minutes is accepted here (unlike `/schedule`), but a DAO
  report every 5 minutes is mostly RPC noise — hourly is the practical floor.
- The loop stops when the session ends. For something that survives a reboot,
  use `/schedule`.

## Recurring: `/schedule` (cloud routine, cron)

`/schedule` creates a **cloud** routine: a fresh sandbox per run, cron in
**UTC**, **minimum interval 1 hour**. It has **no access to your machine** — not
your files, not your `.env`, not your local MCP server. Attach the dexe MCP
server to the routine (with its own env) or the prompt has no tools to call.

Weekday 9am Kyiv digest (= `0 6 * * 1-5` in UTC):

```
/schedule Every weekday at 9am Kyiv, run a DeXe DAO digest.

Prompt for the routine:
Call dexe_dao_report {govPool:"0x2546f00…935916", chainId:56, since:"last"}.
If it errors because no baseline is stored, call it again without `since` — the sandbox is fresh, so this is expected on the first run.
Report, in this order: (1) live deadlines with time remaining, (2) new proposals and any state changes, (3) membership/delegation/treasury deltas, (4) any section listed in `unavailable[]`, with its reason.
If `changes` is empty, reply with a single line: "<DAO name>: no change since <sinceIso>".
```

Hourly governance watch:

```
/schedule Every hour, watch my DAO for anything that needs a vote or an execute.

Prompt for the routine:
Call dexe_dao_report {govPool:"0x2546f00…935916", chainId:56, user:"0xYourWallet", sections:["deadlines","proposals"]}.
Only report when `deadlines.items` has a live entry of kind votingEnds, executable or validatorVotingEnds, or when `deadlines.personal` shows an unvoted proposal. Otherwise reply "clear".
Never broadcast a transaction — this is a read-only watch.
```

Cloud gotchas, in the order they bite:

1. **Fresh sandbox = no snapshot.** `since: "last"` has no baseline on the first
   cloud run (and after any environment reset). Always include the fallback
   sentence above.
2. **Self-contained prompt.** The routine starts with zero context: spell out
   `govPool`, `chainId`, the sections, and the output format. "Report on my DAO"
   resolves to nothing there.
3. **Cron is UTC**, minimum interval 1 hour. `*/30 * * * *` is rejected.
4. **Attach the MCP server**, or the routine cannot call `dexe_dao_report` at
   all. Manage routines at <https://claude.ai/code/routines>.
5. **Keep it read-only.** Say so in the prompt. A scheduled agent should never
   be the thing that signs.

## Going deeper

`dexe_dao_report` answers the standing questions. For anything custom — a
filter, a join, a historical slice, a leaderboard the report does not cut — use
`dexe_graph_query` (also default-visible), and **never guess a field name**.
The root query field names are not derivable from the entity names: `DaoPool` is
queried as `daoPools`, `ProposalSettings` as `proposalSettings_collection`. Read
`docs/GRAPH.md` — served in-band as the MCP resource `dexe://graph-schema`, no
toolset required — or call `dexe_graph_schema` for live introspection
(`read` toolset: `DEXE_TOOLSETS=core,read`).

For "what needs my attention across **all** my DAOs" use `dexe_user_inbox`
(`read` toolset) rather than one report per DAO.

In-session guidance: `dexe_guide {flow:"report_dao_activity"}` for the reporting
recipe, `dexe_guide {flow:"read_dao_data"}` for the whole read surface.
