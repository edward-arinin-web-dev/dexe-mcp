/**
 * Child process for tests/lib/stateStore-concurrency.test.ts. Two of these run
 * at once against ONE state.json — the exact shape of two Claude Code windows
 * sharing ~/.dexe-mcp/state.json.
 *
 * Run as:
 *   node --import tsx tests/fixtures/state-writer-child.ts <path> <label> <count> <startAtEpochMs>
 *
 * Not named *.test.ts on purpose — vitest must not collect it.
 */
import { StateStore } from "../../src/lib/stateStore.js";

const [statePath, label, countRaw, startAtRaw] = process.argv.slice(2);
if (!statePath || !label) throw new Error("usage: state-writer-child <path> <label> [count] [startAt]");
const count = Number(countRaw ?? "20");
const startAt = Number(startAtRaw ?? "0");

const store = new StateStore(statePath);
// Read once at startup, exactly as dexe_context does. Pre-0.30.4 this snapshot
// was reused for every later write, so the other session's DAOs were erased.
store.getState();

// Barrier: node + tsx startup varies by hundreds of ms between the two
// children, which is enough for them to run one after the other and never
// contend at all. Spinning to a shared wall-clock deadline makes the write
// loops actually overlap, which is the whole point of the test.
while (Date.now() < startAt) {
  /* spin */
}

for (let i = 0; i < count; i++) {
  store.recordDao({
    name: `${label}-${i}`,
    // 40 hex chars: two label chars + a zero-padded index.
    govPool: `0x${label.repeat(2)}${String(i).padStart(38, "0")}`,
    chainId: 97,
    deployedAt: new Date().toISOString(),
  });
}

process.stdout.write(`DONE ${label}\n`);
