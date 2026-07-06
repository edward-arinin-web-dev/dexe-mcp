import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * `npx dexe-mcp init` — zero-config onboarding wizard.
 *
 * Walks the user through a minimal `.env` (network, RPCs, Pinata, subgraph
 * key, signer mode), validates the Pinata JWT against the live endpoint
 * before writing, and prints a paste-ready `.claude.json` snippet. Never
 * auto-edits the user's MCP host config — that is too risky to do
 * automatically (other servers, other env keys, comments to preserve).
 *
 * Uses only the Node 20 standard library (`node:readline/promises`,
 * `node:fs`, native `fetch`) — no new dependency.
 */

const TESTNET_DEFAULT_RPC = "https://data-seed-prebsc-1-s1.bnbchain.org:8545";
const MAINNET_DEFAULT_RPC = "https://bsc-dataseed.bnbchain.org";

export async function run(): Promise<void> {
  if (!input.isTTY) {
    process.stderr.write(
      "[dexe-mcp init] stdin is not a TTY. Pipe-driven init is not supported (too risky for secrets). " +
        "Fill in .env manually instead — see .env.example.\n",
    );
    process.exit(2);
  }

  const rl = createInterface({ input, output });
  try {
    output.write(line("dexe-mcp init — onboarding wizard"));
    output.write(line("─".repeat(64)));
    output.write(line("Reads already work with ZERO config (RPC, subgraphs, backend,"));
    output.write(line("IPFS reads, WalletConnect). This only overrides a default or"));
    output.write(line("enables writes. Answers are stored in plaintext; use WalletConnect"));
    output.write(line("or readonly mode if that worries you."));
    output.write("\n");

    const repoRoot = findRepoRoot();

    // ---- Top-level intent -----------------------------------------------
    // Don't drag a user who only wants the Claude skills through the whole env
    // interview (a real onboarding complaint). `--skills-only` skips the prompt.
    const skillsOnly = process.argv.includes("--skills-only");
    const mode = skillsOnly
      ? "s"
      : await pickOne(
          rl,
          "What do you want to set up?",
          [
            ["b", "both — install the Claude skills + configure .env (recommended)"],
            ["s", "just the Claude skills — no env, no keys"],
            ["f", "full setup — configure .env only"],
          ],
          "b",
        );
    if (mode === "s") {
      await maybeInstallSkills(rl, repoRoot);
      output.write(line(""));
      output.write(line("Done. Restart Claude Code if it was already running."));
      return;
    }

    // ---- Network selection ----------------------------------------------
    const network = await pickOne(
      rl,
      "Which network(s)?",
      [
        ["t", "testnet — BSC chain 97 (free faucet BNB, recommended for first run)"],
        ["m", "mainnet — BSC chain 56 (real funds)"],
        ["b", "both"],
      ],
      "t",
    );

    let rpcTestnet: string | undefined;
    let rpcMainnet: string | undefined;
    if (network === "t" || network === "b") {
      rpcTestnet = (await ask(rl, "Testnet RPC URL", TESTNET_DEFAULT_RPC)).trim();
    }
    if (network === "m" || network === "b") {
      rpcMainnet = (await ask(rl, "Mainnet RPC URL", MAINNET_DEFAULT_RPC)).trim();
    }
    const defaultChainId = network === "m" ? "56" : "97";

    // ---- Pinata JWT (optional) -----------------------------------------
    output.write(line("Pinata JWT enables IPFS uploads (proposal metadata, DAO avatars)."));
    output.write(line("Reads work without it via a public gateway. Press Enter to skip."));
    const pinataJwt = (await ask(rl, "Pinata JWT", "")).trim();
    if (pinataJwt) {
      const ok = await validatePinataJwt(pinataJwt);
      if (!ok) {
        const proceed = await yn(
          rl,
          "Pinata says that JWT is invalid (or the network is unreachable). Save anyway?",
          false,
        );
        if (!proceed) {
          output.write(line("Aborted — re-run init when you have a valid JWT."));
          process.exit(2);
        }
      } else {
        output.write(line("  → Pinata JWT validated."));
      }
    }
    const ipfsGateway = pinataJwt
      ? (await ask(rl, "IPFS gateway URL", "https://gateway.pinata.cloud")).trim()
      : "";

    // ---- Subgraph (optional) -------------------------------------------
    output.write(line("Subgraph reads work by default via a shared DeXe Graph key."));
    output.write(line("Set your own only for heavy use (blank keeps the default)."));
    const graphKey = (await ask(rl, "Graph API key (blank = use shared default)", "")).trim();

    // ---- Signer mode ---------------------------------------------------
    output.write(line(""));
    output.write(line("Signer mode:"));
    output.write(line("  readonly   — no broadcast; tools return unsigned calldata (safest)"));
    output.write(line("  walletconnect — broadcast via phone wallet; key never enters this process"));
    output.write(line("  privkey    — hot key in .env; convenient for CI and bots, NOT recommended"));
    const signerMode = await pickOne(
      rl,
      "Pick a signer mode",
      [
        ["r", "readonly (recommended)"],
        ["w", "walletconnect"],
        ["p", "privkey (warning: plaintext in .env)"],
      ],
      "r",
    );

    let privateKey: string | undefined;
    let wcProjectId: string | undefined;
    if (signerMode === "p") {
      output.write(line(""));
      output.write(line("⚠  Plaintext private keys in .env are a security risk."));
      output.write(line("   Anyone who reads the file can drain that wallet."));
      output.write(line("   Prefer WalletConnect (re-run init and pick `w`) when possible."));
      const confirm = await yn(rl, "Continue with privkey mode?", false);
      if (!confirm) {
        output.write(line("Aborted — re-run init and pick readonly or walletconnect."));
        process.exit(2);
      }
      const pk = (await ask(rl, "Private key (0x… 64 hex)", "")).trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
        output.write(line("That does not look like a 64-hex key — aborting."));
        process.exit(2);
      }
      const addr = await deriveAddress(pk);
      output.write(line(`  → Derived address: ${addr}`));
      const ok = await yn(rl, "Is that the wallet you intended?", true);
      if (!ok) {
        output.write(line("Aborted — re-run init."));
        process.exit(2);
      }
      privateKey = pk;
    } else if (signerMode === "w") {
      wcProjectId = (await ask(rl, "WalletConnect project id (cloud.reown.com)", "")).trim();
    }

    // ---- Build the env block + write .env ------------------------------
    const updates: Record<string, string> = {};
    if (rpcTestnet) updates.DEXE_RPC_URL_TESTNET = rpcTestnet;
    if (rpcMainnet) updates.DEXE_RPC_URL_MAINNET = rpcMainnet;
    updates.DEXE_DEFAULT_CHAIN_ID = defaultChainId;
    if (pinataJwt) updates.DEXE_PINATA_JWT = pinataJwt;
    if (ipfsGateway) updates.DEXE_IPFS_GATEWAY = ipfsGateway;
    if (graphKey) updates.DEXE_GRAPH_API_KEY = graphKey;
    if (privateKey) updates.DEXE_PRIVATE_KEY = privateKey;
    if (wcProjectId) updates.DEXE_WALLETCONNECT_PROJECT_ID = wcProjectId;

    const envPath = resolve(repoRoot, ".env");

    // Read the file once up-front (or treat ENOENT as "no existing .env") so
    // the later write isn't a check-then-act TOCTOU: every decision below
    // operates on this captured snapshot, not on a re-stat of the path.
    let existingEnv: string | null = null;
    try {
      existingEnv = readFileSync(envPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    let action: "write" | "merge" = "write";
    if (existingEnv !== null) {
      const choice = await pickOne(
        rl,
        `Existing .env at ${envPath}. Overwrite or merge?`,
        [
          ["m", "merge — replace known keys, keep everything else (recommended)"],
          ["o", "overwrite — wipe and start fresh"],
          ["a", "abort — keep .env unchanged, exit"],
        ],
        "m",
      );
      if (choice === "a") {
        output.write(line("Aborted — .env unchanged."));
        process.exit(0);
      }
      action = choice === "o" ? "write" : "merge";
    }

    const content =
      action === "write" || existingEnv === null
        ? renderFreshEnv(updates)
        : mergeEnv(existingEnv, updates);
    writeFileSync(envPath, content, "utf8");

    output.write(line(`✔ Wrote ${envPath} (${Object.keys(updates).length} key${Object.keys(updates).length === 1 ? "" : "s"} set).`));
    output.write(line(""));

    // ---- Offer to install the shipped skills (skipped in env-only mode) --
    if (mode === "b") {
      await maybeInstallSkills(rl, repoRoot);
    }

    // ---- Print .claude.json snippet ------------------------------------
    output.write(line("Paste this into your ~/.claude.json under `mcpServers`:"));
    output.write(line(""));
    output.write(jsonSnippet(repoRoot));
    output.write(line(""));
    output.write(line(`Next: run \`npx dexe-mcp doctor\` to verify, then restart Claude Code.`));
  } finally {
    rl.close();
  }
}

// ─── skill installer ─────────────────────────────────────────────────────

/**
 * Offer to copy the package's `skills/` (dexe-create-dao, dexe-create-proposal,
 * dexe-vote-execute, dexe-otc, dexe-setup) into a Claude Code skills dir so the
 * exact tool-sequence recipes reach the model. Idempotent: unchanged skills are
 * skipped, changed ones are overwritten with an "(updated)" note.
 */
async function maybeInstallSkills(
  rl: ReturnType<typeof createInterface>,
  repoRoot: string,
): Promise<void> {
  const skillsSrc = resolve(repoRoot, "dexe-plugin", "skills");
  if (!existsSync(skillsSrc)) return; // not packaged (dev without build) — skip silently

  output.write(line(""));
  const want = await yn(
    rl,
    "Install dexe-mcp Claude Code skills (create-dao / create-proposal / vote-execute / otc / setup)?",
    true,
  );
  if (!want) return;

  const scope = await pickOne(
    rl,
    "Where should the skills go?",
    [
      ["p", "project — ./.claude/skills (this repo only, recommended)"],
      ["g", "global  — ~/.claude/skills (all your projects)"],
    ],
    "p",
  );
  const targetRoot =
    scope === "g" ? resolve(homedir(), ".claude", "skills") : resolve(process.cwd(), ".claude", "skills");

  const summary = installSkills(skillsSrc, targetRoot);
  output.write(line(`✔ Skills → ${targetRoot}`));
  for (const s of summary) output.write(line(`    ${s}`));
}

/**
 * Copy every skill folder (containing a SKILL.md) from `srcRoot` into
 * `targetRoot`. Returns a per-skill status line. Pure fs — no prompts — so it is
 * unit-testable and reusable.
 */
export function installSkills(srcRoot: string, targetRoot: string): string[] {
  const out: string[] = [];
  mkdirSync(targetRoot, { recursive: true });
  for (const entry of readdirSync(srcRoot)) {
    const srcDir = join(srcRoot, entry);
    if (!statSync(srcDir).isDirectory()) continue;
    const srcSkill = join(srcDir, "SKILL.md");
    if (!existsSync(srcSkill)) continue;
    const destDir = join(targetRoot, entry);
    const destSkill = join(destDir, "SKILL.md");
    const next = readFileSync(srcSkill, "utf8");
    let status: string;
    if (!existsSync(destSkill)) {
      status = "installed";
    } else {
      const prev = readFileSync(destSkill, "utf8");
      status = prev === next ? "unchanged" : "updated";
    }
    if (status !== "unchanged") {
      mkdirSync(destDir, { recursive: true });
      copyFileSync(srcSkill, destSkill);
    }
    out.push(`${entry} (${status})`);
  }
  return out;
}

// ─── prompt helpers ──────────────────────────────────────────────────────

async function ask(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  fallback: string,
): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : "";
  const a = await rl.question(`${prompt}${suffix}: `);
  return a.length === 0 ? fallback : a;
}

async function yn(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  defaultYes: boolean,
): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const a = (await rl.question(`${prompt} ${suffix}: `)).trim().toLowerCase();
  if (!a) return defaultYes;
  return a === "y" || a === "yes";
}

async function pickOne(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  options: ReadonlyArray<readonly [string, string]>,
  defaultKey: string,
): Promise<string> {
  output.write(line(prompt));
  for (const [key, label] of options) {
    const tag = key === defaultKey ? `[${key}*]` : `[${key} ]`;
    output.write(line(`  ${tag} ${label}`));
  }
  const valid = new Set(options.map(o => o[0]));
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const a = (await rl.question(`Choice (default ${defaultKey}): `)).trim().toLowerCase();
    if (!a) return defaultKey;
    if (valid.has(a)) return a;
    output.write(line(`  → please answer one of ${[...valid].join(" / ")}`));
  }
}

// ─── env file rendering ──────────────────────────────────────────────────

function renderFreshEnv(updates: Record<string, string>): string {
  const lines = [
    "# dexe-mcp — generated by `npx dexe-mcp init`",
    "# Loaded via process.loadEnvFile() at MCP startup.",
    "# Run `npx dexe-mcp doctor` after any edit to verify.",
    "",
  ];
  for (const [k, v] of Object.entries(updates)) {
    lines.push(`${k}=${v}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Merge new values into an existing .env in place: known keys are replaced,
 * unknown keys + comments + blank lines preserved verbatim. Detects CRLF vs
 * LF and matches the file's existing line endings.
 */
function mergeEnv(existing: string, updates: Record<string, string>): string {
  const eol = /\r\n/.test(existing) ? "\r\n" : "\n";
  const lines = existing.split(/\r?\n/);
  const seen = new Set<string>();

  const out: string[] = [];
  for (const line_ of lines) {
    const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line_);
    if (m && Object.prototype.hasOwnProperty.call(updates, m[2]!)) {
      const key = m[2]!;
      out.push(`${m[1] ?? ""}${key}=${updates[key]!}`);
      seen.add(key);
      continue;
    }
    out.push(line_);
  }
  // Append any keys that did not already exist.
  const appended: string[] = [];
  for (const [k, v] of Object.entries(updates)) {
    if (seen.has(k)) continue;
    appended.push(`${k}=${v}`);
  }
  if (appended.length > 0) {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    out.push("# added by `npx dexe-mcp init`");
    out.push(...appended);
  }
  // Ensure trailing newline (Node's loadEnvFile drops the last line otherwise).
  if (out.length > 0 && out[out.length - 1] !== "") out.push("");
  return out.join(eol);
}

// ─── Pinata + ethers helpers ─────────────────────────────────────────────

async function validatePinataJwt(jwt: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch("https://api.pinata.cloud/data/testAuthentication", {
      method: "GET",
      headers: { Authorization: `Bearer ${jwt}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return r.status >= 200 && r.status < 300;
  } catch {
    return false;
  }
}

async function deriveAddress(pk: string): Promise<string> {
  const { Wallet } = await import("ethers");
  return new Wallet(pk).address;
}

// ─── path + snippet helpers ──────────────────────────────────────────────

export function findRepoRoot(): string {
  // `dist/index.js` → `..` is repo root. Walk up if running from src/cli/.
  const here = dirname(fileURLToPath(import.meta.url));
  // Two known layouts: dist/cli/init.js → up 2; dist/index.js's import → up 1 from dist.
  // Easiest: walk up until we find package.json.
  let cur = here;
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(cur, "package.json"))) return cur;
    cur = resolve(cur, "..");
  }
  return process.cwd();
}

function jsonSnippet(repoRoot: string): string {
  const distPath = resolve(repoRoot, "dist", "index.js");
  // Use JSON.stringify to handle Windows backslashes cleanly.
  const safe = JSON.stringify(distPath);
  return [
    "{",
    `  "mcpServers": {`,
    `    "dexe": {`,
    `      "command": "node",`,
    `      "args": [${safe}]`,
    `    }`,
    `  }`,
    `}`,
    "",
  ].join("\n");
}

function line(s: string): string {
  return s + "\n";
}
