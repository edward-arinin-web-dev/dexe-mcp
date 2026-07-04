# Shipped skills

`dexe-mcp` ships Claude Code **skills** — short, exact tool-sequence recipes that
reach the model so it drives the MCP correctly instead of re-deriving each flow
from scratch every session. They are the primary channel for the recurring
"how do I actually do X" knowledge (approve→deposit→create sequencing, metadata
shape, the deploy revert-guards, ProposalState ordering, treasury/blacklist
edge cases).

They live in [`dexe-plugin/skills/`](../dexe-plugin/skills) and ship in the
published npm package. They install into a Claude Code skills directory
automatically with the plugin, or on demand via the CLI.

## The skills

| Skill | Covers |
|-------|--------|
| `dexe-create-dao` | One-call `dexe_dao_create`: param recipe, decimal conventions, the four deploy gotchas (cap>minted, LINEAR initData, non-zero userKeeper asset, mainnet treasury remainder), testnet-first rule. |
| `dexe-create-proposal` | `dexe_proposal_create` for every wired `proposalType` + `params` recipe; the metadata / ABI-guessing / approve-target / blacklist failure modes. |
| `dexe-vote-execute` | `dexe_proposal_vote_and_execute`: deposit-first, canonical ProposalState ordering, "withdraw between proposals" lock trap. |
| `dexe-otc` | The five `dexe_otc_*` composites; PRECISION-1e25 rate, native-BNB sentinel, claim-timing gotchas. Full reference: [`OTC.md`](./OTC.md). |
| `dexe-setup` | Env onboarding via `dexe_doctor` (edits `.env`, never `.claude.json`). |

## Installing

**With the Claude Code plugin (automatic).** `/plugin install dexe@dexe-mcp`
discovers and loads all five skills — no copy step, no env questions. Plugin
skills are namespaced, e.g. `dexe:dexe-create-dao`.

**Standalone CLI** — copy the skills with no setup interview (for other MCP
clients, or a manual top-up):

```bash
npx dexe-mcp skills            # into ./.claude/skills (this project)
npx dexe-mcp skills --global   # into ~/.claude/skills (all projects)
```

**Via the onboarding wizard.** `npx dexe-mcp init` now opens with a choice —
pick **"just the Claude skills"** (or run `npx dexe-mcp init --skills-only`) to
copy the skills and skip the `.env` interview entirely; pick **both** to do
skills + env.

All paths are idempotent: unchanged skills are skipped, changed ones are
overwritten with an `(updated)` note, so upgrading the package and re-running
keeps the installed recipes current. Each skill is a folder with a single
`SKILL.md`; Claude Code auto-discovers them from the skills directory.

## Why skills, not MCP prompts/resources

The recipe knowledge is model-facing guidance, not tool I/O. Skills are the
supported, discoverable channel for that in Claude Code and travel with the npm
package. MCP prompts/resources may be added later, but skills remain the primary
recipe channel.
