import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { getAddress, isAddress, Wallet } from "ethers";
import {
  KEYSTORE_MIN_PASSWORD,
  decryptKeystore,
  encryptPrivateKey,
  isWrongPasswordError,
  keystoreFileName,
  listKeystores,
  parseKeystoreMeta,
  resolveKeystoreLocation,
  selectKeystore,
  writeKeystoreFile,
} from "../lib/keystore.js";
import { safeErrorMessage } from "../lib/redact.js";

/**
 * `dexe-mcp key` — manage the encrypted keystore the `keystore` signer mode
 * signs with.
 *
 *   create            new random key, encrypted with a password you choose
 *   import            a private key you paste (hidden), or --from-env, or --json <file>
 *   list              keystores in the keystore directory
 *   export-address    the selected keystore's address (for scripts)
 *   change-password   re-encrypt under a new password
 *   remove            delete a keystore file (after typing its address)
 *
 * Every command that touches a secret REFUSES without an interactive terminal:
 * an AI agent's shell (Claude Code's Bash tool, a CI runner) is not a TTY, so
 * it cannot type a password into this — and the password is the one thing the
 * keystore mode relies on the agent not having. There is deliberately no
 * `export-private-key`.
 */

const SECRET_COMMANDS = new Set(["create", "import", "change-password", "remove"]);
const COMMANDS = ["create", "import", "list", "export-address", "change-password", "remove"] as const;

export function keyUsage(): string {
  return [
    "dexe-mcp key <command>",
    "",
    "  create                         new random key, encrypted with a password you choose",
    "  import                         paste a private key (hidden input)",
    "  import --from-env              take DEXE_PRIVATE_KEY from your .env, then remove the plaintext line",
    "  import --json <file>           re-encrypt an existing keystore v3 file (MetaMask / geth / ethers)",
    "  list                           keystores in the keystore directory",
    "  export-address                 print the selected keystore's address",
    "  change-password                re-encrypt the selected keystore under a new password",
    "  remove                         delete the selected keystore file (asks you to type its address)",
    "",
    "  --address <0x…>                pick a keystore when the directory holds several",
    "",
    "Directory: DEXE_KEYSTORE_PATH, default ~/.dexe-mcp/keystore. Commands that handle a password or key",
    "need an interactive terminal — run them yourself, not through an AI agent.",
    "",
  ].join("\n");
}

/** Remove `KEY=value` lines from .env text (keeps everything else, line endings preserved). */
export function stripEnvKey(content: string, key: string): { content: string; removed: number } {
  const eol = /\r\n/.test(content) ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  const kept = lines.filter((l) => !re.test(l));
  return { content: kept.join(eol), removed: lines.length - kept.length };
}

/** Set `KEY=value` in .env text: replace an existing assignment or append one (trailing newline kept). */
export function upsertEnvKey(content: string, key: string, value: string): string {
  const eol = /\r\n/.test(content) ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const re = new RegExp(`^\\s*${key}\\s*=`);
  let found = false;
  const out = lines.map((l) => {
    if (re.test(l)) {
      found = true;
      return `${key}=${value}`;
    }
    return l;
  });
  if (!found) {
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    out.push(`${key}=${value}`, "");
  } else if (out[out.length - 1] !== "") {
    out.push("");
  }
  return out.join(eol);
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && typeof process.stdin.setRawMode === "function");
}

/**
 * Read a line without echoing it. Raw mode, byte by byte: Enter ends it,
 * Backspace edits, Ctrl-C / Ctrl-D abort, escape sequences (arrow keys) are
 * dropped instead of leaking "[A" into the secret.
 */
export function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(question);
  return new Promise((resolveLine, reject) => {
    let buf = "";
    let esc = 0;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (esc > 0) {
          // ESC [ <params> <final>: skip until a final byte in @..~
          if (esc === 1 && ch !== "[") esc = 0;
          else if (esc === 1) esc = 2;
          else if (ch >= "@" && ch <= "~") esc = 0;
          continue;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolveLine(buf);
          return;
        }
        if (ch === "\u0003" || (ch === "\u0004" && buf === "")) {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("aborted"));
          return;
        }
        if (ch === "\u001b") {
          esc = 1;
          continue;
        }
        if (ch === "\u007f" || ch === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        if (ch < " ") continue;
        buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
  const a = (await ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"}: `)).toLowerCase();
  if (!a) return defaultYes;
  return a === "y" || a === "yes";
}

async function newPassword(): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const a = await promptHidden(`New keystore password (min ${KEYSTORE_MIN_PASSWORD} characters): `);
    if (a.length < KEYSTORE_MIN_PASSWORD) {
      process.stdout.write(`  → too short. Use at least ${KEYSTORE_MIN_PASSWORD} characters (a passphrase of several words is best).\n`);
      continue;
    }
    const b = await promptHidden("Repeat the password: ");
    if (a !== b) {
      process.stdout.write("  → the two entries differ. Try again.\n");
      continue;
    }
    if (a.length < 12) process.stdout.write("  (accepted — but 12+ characters is much harder to brute-force if the file leaks)\n");
    return a;
  }
  throw new Error("no password set");
}

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function nextSteps(address: string, dir: string): void {
  out("");
  out("Next:");
  out("  1. Back up this file AND remember the password — losing either loses the key. Nothing can export the raw key.");
  out(`  2. Fund ${address} (gas + any tokens it should vote or pay with).`);
  out("  3. In your .env set:   DEXE_SIGNER_MODE=keystore");
  if (listKeystores(dir).filter((e) => e.meta).length > 1) out(`                         DEXE_KEYSTORE_ADDRESS=${address}`);
  out("  4. Restart Claude Code. Each write then opens a local approval page that asks for this password.");
  out("     Never type the password into the chat.");
}

interface KeyRunOptions {
  /** The .env files the server loads, in order (from src/index.ts). Used by --from-env. */
  envFiles?: readonly string[];
}

/** Entry point. Returns the exit code (the caller exits). */
export async function run(argv: readonly string[], opts: KeyRunOptions = {}): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(keyUsage());
    return cmd ? 0 : 2;
  }
  if (!(COMMANDS as readonly string[]).includes(cmd)) {
    process.stderr.write(`[dexe-mcp key] unknown command '${cmd}'.\n\n${keyUsage()}`);
    return 2;
  }
  if (SECRET_COMMANDS.has(cmd) && !isInteractive()) {
    process.stderr.write(
      `[dexe-mcp key] '${cmd}' handles a password or private key and needs an interactive terminal. ` +
        "stdin/stdout is not a TTY here — an AI agent's shell or a CI pipe cannot type it, by design. " +
        "Run the command yourself in a terminal.\n",
    );
    return 2;
  }

  const loc = resolveKeystoreLocation(process.env.DEXE_KEYSTORE_PATH);
  const wantAddress = flag(argv, "--address") ?? process.env.DEXE_KEYSTORE_ADDRESS;
  if (wantAddress && !isAddress(wantAddress)) {
    process.stderr.write(`[dexe-mcp key] --address is not an address: ${wantAddress}\n`);
    return 2;
  }

  try {
    switch (cmd) {
      case "list": {
        const entries = listKeystores(loc.dir);
        const sel = selectKeystore({ path: process.env.DEXE_KEYSTORE_PATH, address: wantAddress });
        out(`Keystore directory: ${loc.dir}`);
        if (entries.length === 0) {
          out("  (none) — create one with `dexe-mcp key create`");
          return 0;
        }
        for (const e of entries) {
          if (!e.meta) {
            out(`  ✗ ${basename(e.file)} — not a keystore (${e.error})`);
            continue;
          }
          const mark = "file" in sel && sel.file === e.file ? "*" : " ";
          out(`  ${mark} ${e.meta.address}  ${e.meta.kdf}${e.meta.n ? ` N=2^${Math.log2(e.meta.n)}` : ""}  ${basename(e.file)}`);
        }
        if ("error" in sel) out(`  (no keystore selected: ${sel.error})`);
        else out("  * = the keystore the server signs with");
        return 0;
      }

      case "export-address": {
        const sel = selectKeystore({ path: process.env.DEXE_KEYSTORE_PATH, address: wantAddress });
        if ("error" in sel) {
          process.stderr.write(`[dexe-mcp key] ${sel.error}\n`);
          return 1;
        }
        out(sel.address);
        return 0;
      }

      case "create": {
        out(`dexe-mcp key create — a new key in ${loc.file ?? loc.dir}`);
        const password = await newPassword();
        out("Encrypting (scrypt N=2^18 — about a second)…");
        const wallet = Wallet.createRandom();
        const json = await encryptPrivateKey(wallet.privateKey, password);
        const file = writeKeystoreFile(loc.dir, json, loc.file ? basename(loc.file) : undefined);
        out(`✔ Created ${wallet.address}`);
        out(`  ${file}`);
        nextSteps(wallet.address, loc.dir);
        return 0;
      }

      case "import": {
        const fromEnv = argv.includes("--from-env");
        const jsonPath = flag(argv, "--json");
        let privateKey: string;
        if (jsonPath) {
          const raw = readFileSync(jsonPath, "utf8");
          const meta = parseKeystoreMeta(raw);
          out(`Importing keystore for ${meta.address} from ${jsonPath}`);
          const oldPw = await promptHidden("Its current password: ");
          try {
            privateKey = (await decryptKeystore(raw, oldPw)).privateKey;
          } catch (e) {
            process.stderr.write(isWrongPasswordError(e) ? "Wrong password.\n" : `${safeErrorMessage(e)}\n`);
            return 1;
          }
          out("Choose the password for the re-encrypted copy (scrypt N=2^18).");
        } else if (fromEnv) {
          const v = process.env.DEXE_PRIVATE_KEY?.trim();
          if (!v) {
            process.stderr.write("[dexe-mcp key] DEXE_PRIVATE_KEY is not set in the loaded .env / environment.\n");
            return 1;
          }
          privateKey = v;
        } else {
          const v = await promptHidden("Private key (0x + 64 hex, hidden): ");
          privateKey = v.trim();
        }
        if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) {
          process.stderr.write("[dexe-mcp key] that is not a 64-hex private key.\n");
          return 1;
        }
        if (!privateKey.startsWith("0x")) privateKey = `0x${privateKey}`;
        let address: string;
        try {
          address = new Wallet(privateKey).address;
        } catch (e) {
          process.stderr.write(`[dexe-mcp key] not a usable key: ${safeErrorMessage(e)}\n`);
          return 1;
        }
        out(`Address: ${address}`);
        if (!(await confirm("Is that the wallet you mean to import?", true))) return 1;
        const dup = listKeystores(loc.dir).find((e) => e.meta?.address === address);
        if (dup) {
          process.stderr.write(`[dexe-mcp key] ${loc.dir} already holds a keystore for ${address} (${basename(dup.file)}).\n`);
          return 1;
        }
        const password = await newPassword();
        out("Encrypting (scrypt N=2^18 — about a second)…");
        const json = await encryptPrivateKey(privateKey, password);
        const file = writeKeystoreFile(loc.dir, json, loc.file ? basename(loc.file) : keystoreFileName(address));
        out(`✔ Imported ${address}`);
        out(`  ${file}`);
        if (fromEnv) await stripFromEnvFiles(opts.envFiles ?? [], privateKey);
        nextSteps(address, loc.dir);
        return 0;
      }

      case "change-password": {
        const sel = selectKeystore({ path: process.env.DEXE_KEYSTORE_PATH, address: wantAddress });
        if ("error" in sel) {
          process.stderr.write(`[dexe-mcp key] ${sel.error}\n`);
          return 1;
        }
        out(`Changing the password of ${sel.address} (${sel.file})`);
        const raw = readFileSync(sel.file, "utf8");
        const oldPw = await promptHidden("Current password: ");
        let pk: string;
        try {
          pk = (await decryptKeystore(raw, oldPw, sel.address)).privateKey;
        } catch (e) {
          process.stderr.write(isWrongPasswordError(e) ? "Wrong password.\n" : `${safeErrorMessage(e)}\n`);
          return 1;
        }
        const password = await newPassword();
        out("Re-encrypting…");
        const json = await encryptPrivateKey(pk, password);
        writeKeystoreFile(dirname(sel.file), json, basename(sel.file));
        out(`✔ Password changed for ${sel.address}.`);
        return 0;
      }

      case "remove": {
        const sel = selectKeystore({ path: process.env.DEXE_KEYSTORE_PATH, address: wantAddress });
        if ("error" in sel) {
          process.stderr.write(`[dexe-mcp key] ${sel.error}\n`);
          return 1;
        }
        out(`This deletes ${sel.file}`);
        out(`holding ${sel.address}. Without a backup of the file (and its password), that wallet is lost for good.`);
        const typed = await ask("Type the full address to confirm: ");
        if (!isAddress(typed) || getAddress(typed) !== sel.address) {
          out("Not confirmed — nothing deleted.");
          return 1;
        }
        unlinkSync(sel.file);
        out(`✔ Removed ${basename(sel.file)}.`);
        return 0;
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message === "aborted") {
      out("Aborted — nothing changed.");
      return 1;
    }
    process.stderr.write(`[dexe-mcp key] ${safeErrorMessage(e)}\n`);
    return 1;
  }
  return 2;
}

/**
 * After `import --from-env`: remove the plaintext DEXE_PRIVATE_KEY line from
 * whichever loaded .env holds THIS key, and switch that file to keystore mode
 * (with the user's OK). A key that came from the MCP host's env block cannot
 * be edited from here; say where to delete it.
 */
async function stripFromEnvFiles(files: readonly string[], privateKey: string): Promise<void> {
  const norm = privateKey.toLowerCase().replace(/^0x/, "");
  const holders = files.filter((f) => {
    if (!existsSync(f)) return false;
    try {
      return readFileSync(f, "utf8")
        .split(/\r?\n/)
        .some((l) => {
          const m = /^\s*(?:export\s+)?DEXE_PRIVATE_KEY\s*=\s*["']?(0x)?([0-9a-fA-F]{64})["']?\s*$/.exec(l);
          return !!m && m[2]!.toLowerCase() === norm;
        });
    } catch {
      return false;
    }
  });
  if (holders.length === 0) {
    out("");
    out("DEXE_PRIVATE_KEY did not come from a .env file this server reads — it is probably set in your MCP host");
    out("config (e.g. the `env` block in .claude.json). Delete it there yourself, then set DEXE_SIGNER_MODE=keystore.");
    return;
  }
  for (const f of holders) {
    out("");
    if (!(await confirm(`Remove the plaintext DEXE_PRIVATE_KEY line from ${f} and set DEXE_SIGNER_MODE=keystore there?`, true))) {
      out(`  Left ${f} unchanged — the hot key is still on disk there. Remove it yourself.`);
      continue;
    }
    const before = readFileSync(f, "utf8");
    const stripped = stripEnvKey(before, "DEXE_PRIVATE_KEY");
    writeFileSync(f, upsertEnvKey(stripped.content, "DEXE_SIGNER_MODE", "keystore"), "utf8");
    out(`  ✔ ${f}: removed ${stripped.removed} line(s), DEXE_SIGNER_MODE=keystore set.`);
  }
  out("  Old copies may survive in backups, shell history or editor swap files — the key itself is unchanged, so");
  out("  if it ever sat anywhere shared, move the funds to a fresh `dexe-mcp key create` address.");
}
