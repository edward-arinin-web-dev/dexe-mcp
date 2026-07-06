#!/usr/bin/env node
/**
 * dexe-mcp first-run onboarding nudge (SessionStart hook).
 *
 * Fires ONCE, ever: the first time a fresh Claude session starts with the
 * plugin installed, it injects a short note that reads work zero-config and
 * points the user at /dexe-setup for writes / DAO creation. A marker file in
 * the state dir (~/.dexe-mcp/.onboarded, or dirname(DEXE_STATE_PATH)) gates it
 * so it never nudges again — no per-session noise.
 *
 * Best-effort by design: any error exits 0 silently. A SessionStart hook must
 * never block or slow the session.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => (data += c));
      process.stdin.on("end", () => resolve(data));
      // Fallback: if the host provides no stdin, don't hang.
      setTimeout(() => resolve(data), 50);
    } catch {
      resolve("");
    }
  });
}

const NUDGE =
  "<dexe-mcp-onboarding>\n" +
  "dexe-mcp is installed and READS work with zero setup — DAO info, treasury, holders, " +
  "proposals, and subgraph + IPFS reads all run on shared public defaults. No keys needed to explore.\n" +
  "To ENABLE WRITES (vote / execute), connect a wallet with dexe_wc_connect (approve on your phone). " +
  "To CREATE DAOs or proposals you also need a free Pinata JWT (DEXE_PINATA_JWT) for IPFS metadata.\n" +
  "Run /dexe-setup for a guided walkthrough, or dexe_doctor to check config. " +
  "Tip: call dexe_context first to see the current signer / chain / env state.\n" +
  "</dexe-mcp-onboarding>";

async function main() {
  let source = "startup";
  try {
    const raw = await readStdin();
    if (raw) source = JSON.parse(raw).source ?? "startup";
  } catch {
    /* default to startup */
  }

  // Only nudge on a genuinely fresh startup — not resume / compact / clear.
  if (source !== "startup") process.exit(0);

  const stateEnv = process.env.DEXE_STATE_PATH && process.env.DEXE_STATE_PATH.trim();
  const baseDir = stateEnv ? dirname(stateEnv) : join(homedir(), ".dexe-mcp");
  const marker = join(baseDir, ".onboarded");

  try {
    if (existsSync(marker)) process.exit(0); // already nudged once
  } catch {
    /* fall through and nudge */
  }

  // Record the nudge so it fires only once, ever.
  try {
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(marker, new Date().toISOString() + "\n", "utf8");
  } catch {
    /* best effort — still nudge this one time */
  }

  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: NUDGE },
    }),
  );
  process.exit(0);
}

main().catch(() => process.exit(0));
