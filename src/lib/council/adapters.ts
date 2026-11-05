import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelSpec } from "./config.js";

/**
 * Model adapters for the council. One method: prompt in, raw text out. The
 * runner parses the text with `parseDecision`, which FAILS CLOSED — anything
 * that is not a clean `{"vote":"for"|"against","reason":"…"}` is an AGAINST.
 *
 * No adapter gives the model tools: the council asks for a judgment, and the
 * vote itself is cast by the runner through dexe_proposal_vote_and_execute.
 */

export interface CouncilPrompt {
  system: string;
  user: string;
}

export interface ModelAdapter {
  readonly label: string;
  complete(prompt: CouncilPrompt): Promise<string>;
}

export interface Decision {
  vote: "for" | "against";
  reason: string;
  /** False when the output was not a valid decision and the vote defaulted to AGAINST. */
  parsed: boolean;
}

const MAX_REASON = 600;

/**
 * Parse a model reply. Accepts the JSON object alone, inside a ```json fence,
 * or with prose around it. Any other shape → AGAINST.
 */
export function parseDecision(raw: string): Decision {
  const fail = (why: string): Decision => ({ vote: "against", reason: `fail-closed: ${why}`, parsed: false });
  if (typeof raw !== "string" || raw.trim().length === 0) return fail("empty model output");
  const candidates: string[] = [];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]!);
  candidates.push(raw.trim());
  // every balanced-looking {...} that mentions "vote"
  for (const m of raw.matchAll(/\{[^{}]*"vote"[^{}]*\}/g)) candidates.push(m[0]);
  const votes = new Set<string>();
  let found: { vote: string; reason: string } | null = null;
  for (const c of candidates) {
    let obj: unknown;
    try {
      obj = JSON.parse(c);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    const o = obj as Record<string, unknown>;
    if (typeof o.vote !== "string") continue;
    const v = o.vote.trim().toLowerCase();
    votes.add(v);
    found ??= { vote: v, reason: typeof o.reason === "string" ? o.reason : "" };
  }
  if (!found) return fail("no JSON object with a \"vote\" field");
  // Two different votes in one reply (e.g. a quoted example plus the answer) is ambiguous.
  if (votes.size > 1) return fail("conflicting votes in one reply");
  if (found.vote !== "for" && found.vote !== "against") return fail(`vote must be "for" or "against"`);
  const reason = found.reason.replace(/[\u0000-\u001F\u007F]+/g, " ").trim().slice(0, MAX_REASON);
  if (!reason) return fail("vote without a reason");
  return { vote: found.vote, reason, parsed: true };
}

// ---------------------------------------------------------------------------
// claude-cli — spawns `claude -p` with no tools and no session persistence
// ---------------------------------------------------------------------------

export interface SpawnLike {
  (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"]; shell?: boolean; windowsHide?: boolean }): import("node:child_process").ChildProcessWithoutNullStreams;
}

export function claudeCliAdapter(spec: ModelSpec, deps: { spawn?: SpawnLike; bin?: string } = {}): ModelAdapter {
  const bin = deps.bin ?? process.env.DEXE_COUNCIL_CLAUDE_BIN ?? "claude";
  const doSpawn = (deps.spawn ?? (spawn as unknown as SpawnLike));
  const timeoutMs = spec.timeoutMs ?? 240_000;
  return {
    label: `claude-cli:${spec.model}`,
    complete: ({ system, user }) =>
      new Promise((resolveP, rejectP) => {
        // An empty scratch cwd: the model runs with no tools, but a cwd with a
        // CLAUDE.md would still be read into its context.
        const cwd = mkdtempSync(join(tmpdir(), "dexe-council-"));
        const args = [
          "-p",
          "--model", spec.model,
          "--system-prompt", system,
          "--tools", "",
          "--no-session-persistence",
          "--output-format", "text",
        ];
        // Keys stay in this process: the child gets no DEXE_* / AGENT_PK_* variables.
        const env: NodeJS.ProcessEnv = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (/^(DEXE_|AGENT_PK|SWARM_)/.test(k) || /PRIVATE_KEY|MNEMONIC|PINATA/.test(k)) continue;
          env[k] = v;
        }
        env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
        // shell:false always — the system prompt is an argv entry, and a shell
        // would re-parse its quotes and newlines. On Windows point
        // DEXE_COUNCIL_CLAUDE_BIN at claude.exe if `claude` resolves to a .cmd shim.
        const child = doSpawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
          child.kill();
          rejectP(new Error(`claude -p timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
        child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
        child.on("error", (e) => {
          clearTimeout(timer);
          rejectP(new Error(`cannot start ${bin}: ${e.message}`));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          try {
            rmSync(cwd, { recursive: true, force: true });
          } catch {
            /* a leftover empty temp dir is harmless */
          }
          if (code !== 0) rejectP(new Error(`claude -p exited ${code}: ${err.trim().slice(0, 300)}`));
          else resolveP(out);
        });
        child.stdin.end(user);
      }),
  };
}

// ---------------------------------------------------------------------------
// HTTP adapters
// ---------------------------------------------------------------------------

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

function apiKey(spec: ModelSpec, required: boolean): string | undefined {
  if (!spec.apiKeyEnv) {
    if (required) throw new Error(`${spec.adapter}: apiKeyEnv is not set`);
    return undefined;
  }
  const v = process.env[spec.apiKeyEnv]?.trim();
  if (!v && required) throw new Error(`${spec.adapter}: env var ${spec.apiKeyEnv} is empty`);
  return v || undefined;
}

async function postJson(fetchFn: FetchLike, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<unknown> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as unknown;
}

/** Anthropic Messages API over plain fetch. A refusal returns "" → the runner fails closed. */
export function anthropicAdapter(spec: ModelSpec, deps: { fetch?: FetchLike } = {}): ModelAdapter {
  const fetchFn = deps.fetch ?? (fetch as unknown as FetchLike);
  const base = (spec.baseURL ?? "https://api.anthropic.com").replace(/\/+$/, "");
  return {
    label: `anthropic:${spec.model}`,
    async complete({ system, user }) {
      const key = apiKey(spec, true)!;
      const json = (await postJson(
        fetchFn,
        `${base}/v1/messages`,
        { "x-api-key": key, "anthropic-version": "2023-06-01" },
        { model: spec.model, max_tokens: 2048, system, messages: [{ role: "user", content: user }] },
        spec.timeoutMs ?? 240_000,
      )) as { stop_reason?: string; content?: { type: string; text?: string }[] };
      if (json.stop_reason === "refusal") return "";
      return (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    },
  };
}

/** Any /chat/completions endpoint: OpenAI, OpenRouter, Ollama (`http://localhost:11434/v1`, no key). */
export function openAiCompatibleAdapter(spec: ModelSpec, deps: { fetch?: FetchLike } = {}): ModelAdapter {
  const fetchFn = deps.fetch ?? (fetch as unknown as FetchLike);
  const base = (spec.baseURL ?? "").replace(/\/+$/, "");
  return {
    label: `openai-compatible:${spec.model}`,
    async complete({ system, user }) {
      const key = apiKey(spec, false);
      const json = (await postJson(
        fetchFn,
        `${base}/chat/completions`,
        key ? { authorization: `Bearer ${key}` } : {},
        { model: spec.model, messages: [{ role: "system", content: system }, { role: "user", content: user }] },
        spec.timeoutMs ?? 240_000,
      )) as { choices?: { message?: { content?: string | null } }[] };
      return json.choices?.[0]?.message?.content ?? "";
    },
  };
}

export function makeAdapter(spec: ModelSpec): ModelAdapter {
  switch (spec.adapter) {
    case "claude-cli":
      return claudeCliAdapter(spec);
    case "anthropic":
      return anthropicAdapter(spec);
    case "openai-compatible":
      return openAiCompatibleAdapter(spec);
  }
}
