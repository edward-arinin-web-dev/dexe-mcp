import { PinataClient } from "./ipfsPin.js";

/**
 * The DEXE_PINATA_JWT guard for every upload site — the write half of what was
 * src/lib/requireEnv.ts (the generic `requireEnv` / `hintFor` stay there).
 * Kept apart from ./ipfsPin.ts on purpose: `pinataForWrites` constructs the
 * client through an import, so a test that mocks ./ipfsPin.js's PinataClient
 * also replaces the one a composite gets here.
 */

/**
 * Consistent, actionable message for the one env var that reads can't default
 * around: the Pinata JWT needed to pin metadata to IPFS. Used by every upload
 * site (dao create, proposal create, direct IPFS uploads) so the guidance —
 * and the /dexe-setup pointer — is identical everywhere.
 */
export function pinataUploadHint(context: string): string {
  return (
    `DEXE_PINATA_JWT is required ${context}. Reads work without it, but pinning ` +
    `metadata to IPFS needs a Pinata JWT. Three steps to fix (~2 minutes):\n` +
    `1) Create a free API key at https://app.pinata.cloud → API Keys → New Key — ` +
    `grant it pinJSONToIPFS + pinFileToIPFS, copy the JWT (the long eyJ… string).\n` +
    `2) Add a line 'DEXE_PINATA_JWT=<jwt>' to the .env file at the dexe-mcp root — ` +
    `NEVER to .claude.json (the MCP env block silently shadows .env). No spaces around '=', file must end with a newline.\n` +
    `3) Restart Claude Code (quit + relaunch) — .env is read once at startup, so the key does nothing until restart.\n` +
    `Prefer a guided walkthrough? Run /dexe-setup. Verify afterwards with dexe_write_doctor.`
  );
}

/**
 * The Pinata client a composite needs — demanded at the moment of the first
 * real pin, never before it.
 *
 * Until 0.34.0 `dexe_dao_create` and `dexe_proposal_create` each opened with an
 * unconditional `if (!pinataJwt) return err(...)`. That fired ahead of SIMPLE
 * synthesis, the settings-slot guard, the safety proof, the quorum/treasury
 * gate and the review preview — so a zero-config user asking "is this DAO
 * config safe?" was told to go get an IPFS key instead of being told their
 * 49/51 split needs 100% turnout. A preview pins nothing, so it needs no key.
 *
 * Returns `{ ok: undefined }` under dryRun deliberately: the caller threads that
 * straight into `pinJsonOrPreview`, which ignores the client on the preview
 * branch. Fail-fast for real runs is unchanged.
 */
export function pinataForWrites(
  jwt: string | undefined,
  dryRun: boolean,
  context: string,
): { ok: PinataClient | undefined } | { error: string } {
  if (dryRun) return { ok: undefined };
  if (!jwt) return { error: pinataUploadHint(context) };
  return { ok: new PinataClient(jwt) };
}
