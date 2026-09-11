import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSolcDiagnostics } from "../../src/tools/build.js";

/**
 * D8-5 — `dexe_compile` returned structurally-present diagnostics whose
 * `message` was ALWAYS `""` and whose `file`/`line` were ALWAYS undefined: the
 * old single regex put a lazy `(.*?)` in front of an optional locator group, and
 * the engine satisfies that pair with the minimal expansion (empty message,
 * locator skipped). A model calling the tool after a failed compile got N
 * severity-only stubs and had to fall back to `stdoutTail`.
 *
 * The fixture is real hardhat + solc 0.8.20 output. It is normalized to LF here
 * and re-run as CRLF, because `core.autocrlf=true` flips checked-in fixtures on
 * this project's primary platform and a CRLF-only mis-attribution bug would
 * otherwise be green on CI and red on the author's machine.
 */

const raw = readFileSync(resolve(import.meta.dirname, "..", "fixtures", "solc-output.txt"), "utf8");
const LF = raw.replace(/\r\n/g, "\n");
const CRLF = LF.replace(/\n/g, "\r\n");

describe.each([
  ["LF", LF],
  ["CRLF", CRLF],
])("parseSolcDiagnostics (%s input)", (_label, text) => {
  const diags = parseSolcDiagnostics(text);

  it("counts one error and three warnings", () => {
    expect(diags.filter((d) => d.severity === "error")).toHaveLength(1);
    expect(diags.filter((d) => d.severity === "warning")).toHaveLength(3);
  });

  /** The direct regression test: every diagnostic used to carry an empty message. */
  it("every diagnostic carries a non-empty message", () => {
    expect(diags.length).toBeGreaterThan(0);
    for (const d of diags) expect(d.message.length).toBeGreaterThan(0);
  });

  it("attributes the SPDX warning to its own file and line", () => {
    const spdx = diags.find((d) => /SPDX license identifier/.test(d.message))!;
    expect(spdx.severity).toBe("warning");
    expect(spdx.file).toBe("contracts/gov/GovPool.sol");
    expect(spdx.line).toBe(1);
  });

  it("extracts the parenthesized warning code", () => {
    const unused = diags.find((d) => d.code === "2072")!;
    expect(unused.message).toBe("Unused local variable.");
    expect(unused.file).toBe("contracts/gov/GovPool.sol");
    expect(unused.line).toBe(412);
  });

  it("attributes the error to its own file and line", () => {
    const error = diags.find((d) => d.severity === "error")!;
    expect(error.message).toContain("Expected ';'");
    expect(error.file).toBe("contracts/Broken.sol");
    expect(error.line).toBe(12);
  });

  /**
   * The CRLF mis-attribution guard: this warning has NO locator of its own, and
   * the next diagnostic in the log does. A blank-line splitter that does not
   * match `\r\n\r\n` swallows the rest of the log and borrows the NEXT
   * diagnostic's file:line — a confidently wrong pointer, worse than none.
   */
  it("a locator-less diagnostic borrows nobody else's file:line", () => {
    const fallback = diags.find((d) => /payable fallback/.test(d.message))!;
    expect(fallback.file).toBeUndefined();
    expect(fallback.line).toBeUndefined();
    expect(fallback.message.length).toBeGreaterThan(0);
  });

  it("hardhat's HH600 summary line is not a diagnostic", () => {
    expect(diags.some((d) => /HH600/.test(d.message))).toBe(false);
  });
});

describe("parseSolcDiagnostics edge cases", () => {
  it("parses ANSI-colorized output identically", () => {
    const plain = parseSolcDiagnostics("Warning (2072): Unused local variable.\n --> a/B.sol:7:9:\n");
    const colored = parseSolcDiagnostics(
      "[33mWarning (2072):[0m Unused local variable.\n --> a/B.sol:7:9:\n",
    );
    expect(colored).toEqual(plain);
    expect(colored[0]!.message).toBe("Unused local variable.");
    expect(colored[0]!.file).toBe("a/B.sol");
  });

  it("a bare `Error:` still counts, with an empty message", () => {
    const d = parseSolcDiagnostics("Error:\n");
    expect(d).toHaveLength(1);
    expect(d[0]!.severity).toBe("error");
  });

  it("two adjacent headers with no blank line keep their own locators", () => {
    const d = parseSolcDiagnostics(
      "Warning: first thing\nError: second thing\n --> x/Y.sol:3:1:\n",
    );
    expect(d).toHaveLength(2);
    expect(d[0]!.file).toBeUndefined();
    expect(d[1]!.file).toBe("x/Y.sol");
    expect(d[1]!.line).toBe(3);
  });

  it("empty input yields no diagnostics", () => {
    expect(parseSolcDiagnostics("")).toEqual([]);
  });
});
