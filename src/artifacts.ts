import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, sep, posix } from "node:path";
import type { DexeConfig } from "./config.js";

/**
 * Minimal artifact record loaded from a Hardhat artifact JSON.
 *
 * We intentionally don't pull the full Hardhat Artifact type off the bundle —
 * keeps the dependency footprint small and works across Hardhat versions.
 */
export interface ArtifactRecord {
  contractName: string;
  sourceName: string;
  abi: readonly unknown[];
  bytecode: string;
  deployedBytecode: string;
  /** Absolute path to the artifact JSON on disk. */
  artifactPath: string;
  /** Inferred kind. "library" detection is best-effort; interfaces are reliable (bytecode === "0x"). */
  kind: "contract" | "interface" | "library";
}

/** Structured error thrown when introspection tools run before `dexe_compile`. */
export class ArtifactsMissingError extends Error {
  constructor(public readonly artifactsDir: string) {
    super(
      `Hardhat artifacts not found at ${artifactsDir}. Run dexe_compile first to populate them.`,
    );
    this.name = "ArtifactsMissingError";
  }
}

interface LoadedIndex {
  readonly mtimeMs: number;
  readonly byContractName: Map<string, ArtifactRecord[]>;
  readonly all: ArtifactRecord[];
}

export class Artifacts {
  private cache: LoadedIndex | null = null;

  constructor(private readonly config: DexeConfig) {}

  /** Directory holding contract artifacts (not build-info). */
  get contractsDir(): string {
    return join(this.config.protocolPath, "artifacts", "contracts");
  }

  /** Directory holding build-info JSON (used for natspec + AST). */
  get buildInfoDir(): string {
    return join(this.config.protocolPath, "artifacts", "build-info");
  }

  /**
   * Throws `ArtifactsMissingError` if `artifacts/contracts/` does not exist.
   * Introspection tools call this before touching the cache.
   */
  requireArtifactsExist(): void {
    if (!existsSync(this.contractsDir)) {
      throw new ArtifactsMissingError(this.contractsDir);
    }
  }

  /** Discard the in-memory index — called after `dexe_compile` succeeds. */
  invalidate(): void {
    this.cache = null;
    this.buildInfoCache.clear();
  }

  /** Load (and memoize) all contract artifacts on disk. */
  private load(): LoadedIndex {
    this.requireArtifactsExist();

    const st = statSync(this.contractsDir);
    if (this.cache && this.cache.mtimeMs === st.mtimeMs) {
      return this.cache;
    }

    const all: ArtifactRecord[] = [];
    const byName = new Map<string, ArtifactRecord[]>();

    for (const file of walk(this.contractsDir)) {
      if (!file.endsWith(".json")) continue;
      if (file.endsWith(".dbg.json")) continue;

      let parsed: {
        contractName?: string;
        sourceName?: string;
        abi?: unknown[];
        bytecode?: string;
        deployedBytecode?: string;
      };
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        continue; // skip malformed JSON
      }

      if (!parsed.contractName || !parsed.sourceName || !Array.isArray(parsed.abi)) continue;

      const bytecode = parsed.bytecode ?? "0x";
      const record: ArtifactRecord = {
        contractName: parsed.contractName,
        sourceName: parsed.sourceName,
        abi: parsed.abi,
        bytecode,
        deployedBytecode: parsed.deployedBytecode ?? "0x",
        artifactPath: file,
        kind: inferKind(parsed.sourceName, bytecode),
      };

      all.push(record);
      const list = byName.get(record.contractName);
      if (list) list.push(record);
      else byName.set(record.contractName, [record]);
    }

    this.cache = { mtimeMs: st.mtimeMs, all, byContractName: byName };
    return this.cache;
  }

  /** Enumerate all loaded artifacts, with optional filters. */
  list(opts: { filter?: string; kind?: ArtifactRecord["kind"] } = {}): ArtifactRecord[] {
    const { all } = this.load();
    const f = opts.filter?.toLowerCase();
    return all.filter((r) => {
      if (opts.kind && r.kind !== opts.kind) return false;
      if (f && !r.contractName.toLowerCase().includes(f)) return false;
      return true;
    });
  }

  /**
   * Look up an artifact by contract name. Returns the first match; if there
   * are collisions (same contract name under different source paths), returns
   * all of them so callers can disambiguate.
   */
  get(contractName: string): ArtifactRecord[] {
    return this.load().byContractName.get(contractName) ?? [];
  }

  /** Convenience: get exactly one artifact or throw. */
  getOne(contractName: string): ArtifactRecord {
    const list = this.get(contractName);
    if (list.length === 0) {
      throw new Error(
        `Unknown contract: ${contractName}. Call dexe_list_contracts to see what's available.`,
      );
    }
    if (list.length > 1) {
      const paths = list.map((r) => r.sourceName).join(", ");
      throw new Error(
        `Ambiguous contract name: ${contractName} exists in multiple sources (${paths}). ` +
          `Pass a fully-qualified name like "${list[0]!.sourceName}:${contractName}" (not yet supported — open an issue).`,
      );
    }
    return list[0]!;
  }

  // ---------- build-info ----------

  private readonly buildInfoCache = new Map<string, BuildInfoFile>();

  /**
   * Load the build-info file that holds the compiler output for a given
   * artifact. Hardhat writes one build-info per compile per solc invocation;
   * the artifact's `.dbg.json` points at the right one.
   */
  loadBuildInfoFor(record: ArtifactRecord): BuildInfoContract | null {
    const dbgPath = record.artifactPath.replace(/\.json$/, ".dbg.json");
    if (!existsSync(dbgPath)) return null;

    let dbg: { buildInfo?: string };
    try {
      dbg = JSON.parse(readFileSync(dbgPath, "utf8"));
    } catch {
      return null;
    }
    if (!dbg.buildInfo) return null;

    // dbg.buildInfo is a relative path from the .dbg.json's directory.
    const biPath = join(dbgPath, "..", dbg.buildInfo);
    return this.loadBuildInfoFile(biPath, record.sourceName, record.contractName);
  }

  private loadBuildInfoFile(
    absPath: string,
    sourceName: string,
    contractName: string,
  ): BuildInfoContract | null {
    let file = this.buildInfoCache.get(absPath);
    if (!file) {
      if (!existsSync(absPath)) return null;
      try {
        file = JSON.parse(readFileSync(absPath, "utf8")) as BuildInfoFile;
      } catch {
        return null;
      }
      this.buildInfoCache.set(absPath, file);
    }
    const src = file.output?.contracts?.[sourceName];
    if (!src) return null;
    return src[contractName] ?? null;
  }
}

// ---------- types for build-info slices we care about ----------

interface BuildInfoFile {
  output?: {
    contracts?: Record<string, Record<string, BuildInfoContract>>;
    sources?: Record<string, { ast?: unknown; id?: number }>;
  };
}

export interface BuildInfoContract {
  abi?: unknown[];
  metadata?: string;
  devdoc?: unknown;
  userdoc?: unknown;
}

// ---------- helpers ----------

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function inferKind(sourceName: string, bytecode: string): ArtifactRecord["kind"] {
  // Reliable: interfaces have no deployable bytecode.
  if (bytecode === "0x" || bytecode === "") return "interface";
  // Best-effort heuristic for libraries. True library detection needs AST.
  const normalized = sourceName.split(sep).join(posix.sep);
  if (/\/libs?\//i.test(normalized)) return "library";
  return "contract";
}
