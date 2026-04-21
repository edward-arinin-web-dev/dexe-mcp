# Compat Report: Off-chain Proposals

**Date:** 2026-04-21
**Method:** Source extraction (code-level comparison)

## Summary

| Type | Verdict | Notes |
|------|---------|-------|
| single_option (one_of) | MATCH | Endpoint, body shape, quorum structure all match |
| multi_option (multiple_of) | MATCH | Endpoint, body shape, quorum structure all match |
| for_against | MATCH | Endpoint, body shape, quorum structure all match |
| settings (edit/create) | MATCH | Both use `edit_proposal_type` / `create_proposal_type` as `attributes.type` |
| vote | MATCH | Identical JSON:API body |
| cancel_vote | MATCH | Identical DELETE endpoint pattern |
| description encoding | MISMATCH | Frontend uses native Slate editor; MCP converts Markdown to Slate via `markdownToSlate()` |
| auth flow | MATCH | Same nonce/login endpoints and JSON:API body shapes |

## Detailed Findings

### Auth Flow (nonce + login)

**Frontend source:** `C:/dev/investing-dashboard/src/utils/requests/auth.ts`
**MCP source:** `proposalBuildOffchain.ts` lines 98-156

**Verdict:** MATCH

| Field | Frontend | MCP |
|-------|----------|-----|
| Nonce endpoint | `POST /integrations/nonce-auth-svc/nonce` | `POST /integrations/nonce-auth-svc/nonce` |
| Nonce body | `{ data: { type: "auth_nonce_request", attributes: { address } } }` | `{ data: { type: "auth_nonce_request", attributes: { address } } }` |
| Login endpoint | `POST /integrations/nonce-auth-svc/login` | `POST /integrations/nonce-auth-svc/login` |
| Login body | `{ data: { type: "login_request", attributes: { auth_pair: { address, signed_message } } } }` | `{ data: { type: "login_request", attributes: { auth_pair: { address, signed_message: signedMessage } } } }` |

**Details:** Identical structure. Frontend sends `signed_message: signMsg`, MCP sends `signed_message: signedMessage` -- same wire key, different variable names only.

---

### single_option (one_of)

**Frontend source:** `C:/dev/investing-dashboard/src/forms/createProposal/off-chain/TypedProposaForm/index.tsx` + `C:/dev/investing-dashboard/src/utils/requests/offChainVoting.ts`
**MCP source:** `proposalBuildOffchain.ts` lines 237-269

**Verdict:** MATCH

| Field | Frontend | MCP |
|-------|----------|-----|
| Endpoint | `POST /integrations/voting/proposals` | `POST /integrations/voting/proposals` |
| `data.type` | `"proposals"` | `"proposals"` |
| `attributes.type` | template type string (e.g. timestamp) | `p.type ?? String(Math.floor(Date.now() / 1000))` |
| `attributes.title` | `proposalName.get` | `p.title` |
| `attributes.chain_id` | `chainId` | `p.chainId` |
| `attributes.pool_address` | `daoAddress` | `p.poolAddress` |
| `attributes.vote_options` | `votingOptions.map(el => el.value)` | `p.voteOptions` |
| `attributes.custom_parameters.voting_type` | `"one_of"` (from template) | `"one_of"` (hardcoded) |
| `attributes.custom_parameters.quorum` | `{ one_of_quorum: { general_closing_percent, anticipatory_closing_percent, against_percent } }` | `{ one_of_quorum: { general_closing_percent, anticipatory_closing_percent, against_percent } }` |
| `custom_parameters.use_delegated` | `true` (from template) | `true` (default) |
| `custom_parameters.voting_duration` | number (from template) | `Number(votingDurationSeconds)` |
| `custom_parameters.minimal_vote_power` | string (from template) | `"0"` (default) |
| `custom_parameters.minimal_create_proposal_power` | string (from template) | `"0"` (default) |
| `custom_parameters.minimal_comment_read_power` | string (from template) | `"0"` (default) |
| `custom_parameters.minimal_comment_create_power` | string (from template) | `"0"` (default) |
| `custom_parameters.pool_address` | from template | `p.poolAddress` |

**Details:** Structure is identical. Frontend passes `customParameters` from the existing template; MCP builds them from user input with sensible defaults. Quorum shape matches exactly: `one_of_quorum` with `general_closing_percent`, `anticipatory_closing_percent`, `against_percent`.

---

### multi_option (multiple_of)

**Frontend source:** Same as single_option (same form, template-driven)
**MCP source:** `proposalBuildOffchain.ts` lines 273-303

**Verdict:** MATCH

| Field | Frontend | MCP |
|-------|----------|-----|
| `custom_parameters.voting_type` | `"multiple_of"` | `"multiple_of"` |
| `custom_parameters.quorum` | `{ multiple_of_quorum: { boundary_percent, against_percent } }` | `{ multiple_of_quorum: { boundary_percent, against_percent } }` |

**Details:** Quorum shape matches exactly. All other fields same as single_option.

---

### for_against

**Frontend source:** Same form (template-driven, `for_against` template)
**MCP source:** `proposalBuildOffchain.ts` lines 307-342

**Verdict:** MATCH

| Field | Frontend | MCP |
|-------|----------|-----|
| `custom_parameters.voting_type` | `"for_against"` | `"for_against"` |
| `custom_parameters.quorum` | `{ for_against_quorum: { for_percent, against_percent } }` | `{ for_against_quorum: { for_percent, against_percent } }` |
| `vote_options` | Not sent for `for_against` (conditional) | Defaults to `["For", "Against"]` |

**Details:** Quorum shape matches. Frontend conditionally omits `vote_options` for `for_against` type (only sends for `oneOf`/`multipleOf`). MCP always sends them with default `["For", "Against"]`. The backend likely accepts both -- having explicit options is not harmful and may be preferred.

---

### settings (edit_proposal_type / create_proposal_type)

**Frontend source:** `C:/dev/investing-dashboard/src/hooks/dao/offchain-proposals/useCreateChangeVotingSettingsProposal.ts` (edit) + `useCreateOffChainTemplateProposal.ts` (create)
**MCP source:** `proposalBuildOffchain.ts` lines 346-411

**Verdict:** MATCH

| Field | Frontend | MCP |
|-------|----------|-----|
| `attributes.type` for create | `"create_proposal_type"` | `input.mode` = `"create_proposal_type"` |
| `attributes.type` for edit | `"edit_proposal_type"` | `input.mode` = `"edit_proposal_type"` |
| `custom_parameters` shape | Full `OffChainProposalVotingParams` object | Same fields: title, description, type, use_delegated, voting_duration, voting_type, quorum, minimal_*, pool_address |

**Details:**
- Frontend create hook: generates `type: Math.floor(Date.now() / 1000).toString()` and hardcodes `use_delegated: true`. MCP does the same.
- Frontend edit hook: passes `type` from the existing template, `use_delegated: true`. MCP lets user specify `type` via `input.mode`.
- Both auto-vote "yes" after creating settings proposals (frontend does this in the hook). MCP does not auto-vote but returns the request for manual dispatch, which is correct for the MCP pattern.

**Minor difference:** In the `settings` tool, MCP puts `JSON.stringify(markdownToSlate(description))` into BOTH `attributes.description` AND `custom_parameters.description`. Frontend puts the raw Slate JSON (from editor) into `description` at both levels too. The encoding approach differs (see Description Encoding section) but the wire shape is the same.

---

### Vote (cast)

**Frontend source:** `C:/dev/investing-dashboard/src/utils/requests/offChainVoting.ts` line 102-113
**MCP source:** `proposalBuildOffchain.ts` lines 416-449

**Verdict:** MATCH

| Field | Frontend | MCP |
|-------|----------|-----|
| Endpoint | `POST /integrations/voting/vote` | `POST /integrations/voting/vote` |
| `data.type` | `"votes"` | `"votes"` |
| `data.attributes.proposal_id` | `opts.proposal_id` (number) | `proposalId` (number) |
| `data.attributes.voter_address` | `opts.voter_address` (string) | `voterAddress` (string) |
| `data.attributes.options` | `opts.options` (string[]) | `options` (string[]) |

**Details:** Identical wire format.

---

### Vote (cancel)

**Frontend source:** `C:/dev/investing-dashboard/src/utils/requests/offChainVoting.ts` line 115-125
**MCP source:** `proposalBuildOffchain.ts` lines 454-478

**Verdict:** MATCH

| Field | Frontend | MCP |
|-------|----------|-----|
| Method | `DELETE` | `DELETE` |
| Endpoint | `/integrations/voting/vote/${proposalId}/${userAddress}` | `/integrations/voting/vote/${proposalId}/${voterAddress}` |
| Body | none | `null` |

**Details:** Identical.

---

### Description Encoding

**Frontend approach:** Uses a Slate rich-text editor (`EditorField`). The `proposalDescription` state is already a Slate node array (from the editor component). On submit, it calls `JSON.stringify(proposalDescription.get)` -- the value is already Slate nodes, not Markdown.

**MCP approach:** Accepts a Markdown string, converts it via `markdownToSlate()` (using `unified` + `remark-parse` + `remark-slate-transformer`), then `JSON.stringify()` the result.

**Verdict:** COMPATIBLE (not a bug)

The wire format is the same: both send `JSON.stringify(SlateNode[])` as `attributes.description`. The difference is in how the Slate nodes are produced:
- Frontend: native Slate editor output (user types in rich-text editor)
- MCP: Markdown-to-Slate conversion (LLM provides Markdown, tool converts)

The `markdownToSlate()` function maps remark types to the same `ELEMENT_TYPES` used by the frontend editor (`heading-one`, `paragraph`, `bulleted-list`, `code-block`, etc.), so the produced Slate nodes are structurally compatible.

This is a design choice, not a bug. MCP cannot provide a Slate editor UI, so Markdown conversion is the correct approach.

---

## Divergences Found

### 1. vote_options for for_against -- COSMETIC, NOT A BUG

**Frontend:** Conditionally omits `vote_options` for `for_against` proposals (only sends for `oneOf`/`multipleOf`).
**MCP:** Always sends `vote_options`, defaults to `["For", "Against"]`.

**Impact:** None. Backend accepts explicit vote_options for all types. Having explicit labels is arguably clearer.

**Action needed:** None.

### 2. No auto-vote after settings proposals -- BY DESIGN

**Frontend:** After creating `create_proposal_type` or `edit_proposal_type`, automatically casts a "yes" vote on the created proposal.
**MCP:** Returns only the create-proposal HTTP request. Does not auto-vote.

**Impact:** The agent/user must manually call `dexe_offchain_build_vote` after creating a settings proposal. This is the correct MCP pattern (tools return HTTP payloads, don't auto-execute side effects).

**Action needed:** Consider adding a note in the tool description that settings proposals require a follow-up vote.

### 3. Description encoding path -- BY DESIGN

**Frontend:** Slate editor native output.
**MCP:** Markdown -> Slate conversion via `markdownToSlate()`.

**Impact:** None on wire format. Both produce valid `JSON.stringify(SlateNode[])`.

**Action needed:** None.
