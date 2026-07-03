# Shipped skills

`dexe-mcp` ships Claude Code **skills** — short, exact tool-sequence recipes that
reach the model so it drives the MCP correctly instead of re-deriving each flow
from scratch every session. They are the primary channel for the recurring
"how do I actually do X" knowledge (approve→deposit→create sequencing, metadata
shape, the deploy revert-guards, ProposalState ordering, treasury/blacklist
edge cases).

They live in [`skills/`](../skills) in the published package and install into a
Claude Code skills directory.

## The skills

| Skill | Covers |
|-------|--------|
| `dexe-create-dao` | One-call `dexe_dao_create`: param recipe, decimal conventions, the four deploy gotchas (cap>minted, LINEAR initData, non-zero userKeeper asset, mainnet treasury remainder), testnet-first rule. |
| `dexe-create-proposal` | `dexe_proposal_create` for every wired `proposalType` + `params` recipe; the metadata / ABI-guessing / approve-target / blacklist failure modes. |
| `dexe-vote-execute` | `dexe_proposal_vote_and_execute`: deposit-first, canonical ProposalState ordering, "withdraw between proposals" lock trap. |
| `dexe-otc` | The five `dexe_otc_*` composites; PRECISION-1e25 rate, native-BNB sentinel, claim-timing gotchas. Full reference: [`OTC.md`](./OTC.md). |
| `dexe-setup` | Env onboarding via `dexe_doctor` (edits `.env`, never `.claude.json`). |

## Installing

Run the onboarding wizard — it offers to copy the skills after writing `.env`:

```bash
npx dexe-mcp init
```

You choose **project** (`./.claude/skills`) or **global** (`~/.claude/skills`).
Re-running is idempotent: unchanged skills are skipped, changed ones are
overwritten with an `(updated)` note, so upgrading the package and re-running
init keeps the installed recipes current.

Skills can also be copied by hand — each is a folder with a single `SKILL.md`.
Claude Code auto-discovers them from the skills directory.

## Why skills, not MCP prompts/resources

The recipe knowledge is model-facing guidance, not tool I/O. Skills are the
supported, discoverable channel for that in Claude Code and travel with the npm
package. MCP prompts/resources may be added later, but skills remain the primary
recipe channel.
