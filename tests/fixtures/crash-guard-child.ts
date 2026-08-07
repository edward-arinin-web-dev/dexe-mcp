/**
 * Child process for tests/process-guards.test.ts.
 *
 * Run as:  node --import tsx tests/fixtures/crash-guard-child.ts
 *
 * Proves the one thing a fake emitter cannot: that **Node itself** keeps
 * running after an unhandled rejection and an uncaught exception once
 * installProcessGuards() is in place. Without the guards Node exits on either,
 * which an MCP host renders as "server disconnected" with no reason attached.
 *
 * Not named *.test.ts on purpose — vitest must not collect it.
 */
import { installProcessGuards } from "../../src/index.js";

installProcessGuards();
// Second call must be a no-op: guards are process-global, so double-installing
// would print every crash report twice.
installProcessGuards();

// The exact shape ethers v6 produces on a non-2xx provider response: the full
// credentialed RPC URL appended to the message. The report must not echo it.
void Promise.reject(new Error("server response 401 (url=https://bsc.example.com/v2/LEAKED_KEY_123)"));

setTimeout(() => {
  throw new Error("uncaught exception on a later tick");
}, 20);

setTimeout(() => {
  // Reached only because neither failure above killed the process.
  process.stdout.write("STILL_ALIVE\n");
  process.exit(0);
}, 400);
