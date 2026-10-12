// Preload for tests/read/module-graph.test.ts:
//   node --import <this file> dist/read/bin.js
// Appends the URL of every ES module the process loads to $DEXE_TEST_LOAD_LOG,
// one per line. The hooks run on Node's loader thread (module.register, Node
// >= 20.6), so the log is written from there.
import { register } from "node:module";

const out = process.env.DEXE_TEST_LOAD_LOG;
if (out) register(new URL("./record-loads-hooks.mjs", import.meta.url), { data: { out } });
