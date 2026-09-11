# internal/

Maintainer records. **Nothing in this directory ships.**

`package.json` `files` is an allowlist (`dist`, `docs`, `dexe-plugin/skills`,
`README.md`, `CHANGELOG.md`, `FUTURE.md`, `SECURITY.md`, `LICENSE`,
`.mcp.example.json`, `.env.example`) and `internal/` is not on it, so these
files stay in git — with their history — and stay out of the npm tarball.

Anything under `docs/` is the opposite: it reaches every npm consumer.
`tests/docs/pack-contents.test.ts` pins the exact contents of `docs/` against a
`PUBLIC_DOCS` allowlist, so a new maintainer record dropped into `docs/` fails
the suite instead of shipping quietly.

Current contents:

| File | What it is |
|---|---|
| `TEST_BACKLOG.md` | Known coverage gaps and the tests owed for them. |
| `PARITY-AUDIT-2026-07-23.md` | Full-surface calldata parity audit against the frontend. |
| `SECURITY_CLIENT_UA.md` | Point-in-time security dossier prepared for one client at 0.5.8 (Ukrainian). Not maintained; the canonical policy is `SECURITY.md` at the repo root. |

If a client needs a current dossier, generate a fresh one from `SECURITY.md` +
`package.json` rather than editing the file here.
