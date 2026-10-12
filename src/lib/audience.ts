/**
 * ── Who reads this process's messages ──────────────────────────────────────
 *
 * A local server's user owns it: "set DEXE_RPC_URL_MAINNET in .env and
 * restart" is the fix, and they can apply it. A hosted server's caller owns
 * nothing on it — the same sentence is noise at best, and names the
 * operator's settings at worst. Messages that end in an env remedy ask
 * `remoteAudience()` and, for a remote caller, say what is not available on
 * this server instead.
 *
 * Process-wide and one-way: the read edition's HTTP entry (src/http/cli.ts)
 * calls `setRemoteAudience()` once, in a process that serves nothing else.
 * Every other process — the stdio servers, the CLI — keeps the local wording.
 */

let remote = false;

export function setRemoteAudience(): void {
  remote = true;
}

export function remoteAudience(): boolean {
  return remote;
}

/** Tests only: back to local wording. */
export function resetAudienceForTests(): void {
  remote = false;
}
