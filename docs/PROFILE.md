# Modify DAO Profile — round-trip contract

How a `modify_dao_profile` proposal renders on `app.dexe.io` and the
exact metadata shapes MCP must produce.

## Data flow at runtime

1. User calls `dexe_proposal_create` with `proposalType:
   "modify_dao_profile"` (or `proposalType: "custom"` + an
   `editDescriptionURL` action and `category:
   "daoProfileModification"`).
2. MCP uploads:
   - **Inner description** (Slate JSON of the markdown body) → IPFS,
     CIDv0 — referenced from the outer metadata as
     `"description": "ipfs://<cid>"`.
   - **Outer DAO metadata** → IPFS, CIDv0. This is the new
     `descriptionURL`. Shape (frontend-canonical):
     ```json
     {
       "daoName": "DexeClientDemo",
       "websiteUrl": "https://dexe.network",
       "description": "ipfs://<innerCid>",
       "socialLinks": [["twitter", "https://x.com/…"], …],
       "documents": [{"name":"Whitepaper","url":"…"}],
       "avatarUrl": "https://<avatarCid>.ipfs.dweb.link/avatar.jpeg",
       "avatarCID": "<avatarCid>",
       "avatarFileName": "avatar.jpeg"
     }
     ```
   - **Proposal metadata** → IPFS. Becomes the proposal's
     `descriptionURL` on-chain. Shape:
     ```json
     {
       "proposalName": "…",
       "proposalDescription": "<Slate JSON string>",
       "category": "daoProfileModification",
       "isMeta": false,
       "changes": {
         "proposedChanges": {"descriptionUrl": "ipfs://<newOuterCid>"},
         "currentChanges":  {"descriptionUrl": "ipfs://<oldDescriptionURL>"}
       }
     }
     ```
3. On-chain action: `GovPool.editDescriptionURL(string)` with the new
   outer CID `ipfs://…`. Selector `0x0dbf1c47`.
4. After execute, frontend reads `GovPool.descriptionURL()` and fetches
   the outer JSON from `ipfs-cache.dexe.io/<descCidV1>.json` (R2 cache
   keyed by the v1 form of the descriptionURL CID).
5. The avatar `<img>` resolves to
   `https://ipfs-cache.dexe.io/<descCidV1>.jpeg`. Populated by the Go
   `ipfs-cache` service (`internal/service/core/cacher/pool.go ::
   cacheAvatar`) which does `loader.Download(avatarCid, avatarFileName)`
   — i.e. fetches `<gateway>/ipfs/<avatarCid>/<avatarFileName>`.

## Hard requirements

These are load-bearing — break any one and the frontend silently
degrades (jazzicon avatar / blank diff table).

- **`avatarCID` must be a UnixFS directory.** MCP's `pinFile` already
  defaults to `wrapWithDirectory: true` so this Just Works.
  `dexe_ipfs_upload_avatar` and `dexe_dao_generate_avatar` both produce
  directory CIDs. If a future change disables wrap-with-directory,
  `loader.Download(avatarCid, "avatar.jpeg")` 404s and the R2 jpeg key
  never gets written.
- **`avatarFileName` is part of the IPFS path** — it must match the
  filename the wrapped directory was pinned with. Default `avatar.jpeg`.
- **Proposal metadata `category` must be `"daoProfileModification"`**.
  The frontend (`useGovPoolProposalProfileModel.ts`) switches on this
  literal to route to the profile-diff UI. Any other string → generic
  proposal UI, no diff.
- **`isMeta` must be `false`** for modify_dao_profile. The diff
  component decodes `actionsOnFor[last].data` as a `createProposal`
  wrapper when `isMeta=true`; modify_dao_profile is a single
  `editDescriptionURL` action, so the decode throws → empty diff. The
  `dexe_proposal_create` custom path forces this to `false` for the
  daoProfileModification category regardless of what the caller passes
  via `proposalMetadataExtra`.
- **`changes.currentChanges.descriptionUrl`** (camelCase, lowercase `u`)
  must be the on-chain `descriptionURL()` value *before* the proposal
  executes. The diff UI uses it to fetch the OLD metadata via
  `useGovPoolDescription`. Missing or wrong-cased → diff loads only the
  NEW side, comparison silently shows every field as "changed".
- **`changes.proposedChanges.descriptionUrl`** is decorative for the
  proposal-detail page (the new URL is decoded from the on-chain
  action's calldata, not read from metadata), but keep it in sync —
  other tooling may read it.

## Partial updates

`dexe_proposal_create` (modify_dao_profile path) fetches the existing
metadata from IPFS and merges the caller's inputs on top. Pass only the
field(s) you want to change:

```ts
dexe_proposal_create({
  proposalType: "modify_dao_profile",
  govPool: "0xCAe3…",
  chainId: 56,
  title: "Rotate avatar",
  newAvatarCID: "<dir cid from dexe_dao_generate_avatar>",
  newAvatarFileName: "avatar.jpeg",
})
```

Unspecified fields (`daoName`, `websiteUrl`, `description`,
`socialLinks`, `documents`) are preserved. If the current metadata is
unreachable (gateway timeout), the build proceeds with empty defaults
for those fields — verify the result before broadcasting if the
gateway is flaky.

## Troubleshooting

- Avatar shows jazzicon (`<svg>` instead of `<img>`):
  1. Hit `https://ipfs-cache.dexe.io/<descCidV1>.jpeg` directly. If
     404, the Go `ipfs-cache` service hasn't cached the avatar yet.
     Frontend triggers caching via
     `POST /integrations/ipfs-cache-svc/public/pools`; if that returns
     500, the cacher's `loader.Download(avatarCid, avatarFileName)`
     failed — most likely the avatar CID isn't a directory pin.
  2. Confirm directory pin: fetch
     `https://<avatarCID>.ipfs.dweb.link/<avatarFileName>` — must return
     image bytes, not a JSON dir listing or 404.
- Avatar loads (HTTP 200) but renders as a **broken image icon** (no
  jazzicon fallback — the frontend only falls back when the GET fails):
  the bytes aren't a raster. `curl -s <url> | head -c 3 | xxd` must show
  `ff d8 ff` (JPEG). If you see `<?xml`/`<svg`, the avatar was pinned as
  SVG under a `.jpeg` name — `dexe_dao_generate_avatar` did exactly this
  before v0.20.0 (the ipfs-cache service re-serves avatar bytes with a
  hardcoded `image/jpeg` content-type, and browsers never content-sniff
  SVG). Regenerate with v0.20.0+ and rotate via a modify_dao_profile
  proposal; since v0.20.0 all avatar upload paths reject non-raster
  bytes by magic-byte check.
- Proposal-detail page shows no "Proposed changes" diff:
  - Check the uploaded proposal metadata has `isMeta: false` and
    `category: "daoProfileModification"` (lowercase `o` in
    `Modification`, camelCase).
- DAO header still shows the old `daoName` even after execute:
  - Subgraph caches the initial-deploy name. The about-page body and
    avatar do update; the header name lags until the subgraph reindexes.
    This is a subgraph quirk, not a metadata issue.
