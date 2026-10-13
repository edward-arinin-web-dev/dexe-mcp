import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkOrigin } from "../../src/lib/approval/origin.js";

/**
 * The keystore approval page's Origin check is this repo's own code, not the
 * read package's: what admits a signing approval must not change with a
 * read-edition release. tests/lib/approval-flow.test.ts drives it through the
 * server (no Origin, a foreign one and `null` all get 403).
 */

describe("checkOrigin (approval page)", () => {
  it("allows a missing Origin as `absent`, accepts the allowed origin in any case, rejects foreign or null", () => {
    const allow = ["http://127.0.0.1:43123"];
    expect(checkOrigin(undefined, allow)).toBe("absent");
    expect(checkOrigin("   ", allow)).toBe("absent");
    expect(checkOrigin("http://127.0.0.1:43123", allow)).toBe("allowed");
    expect(checkOrigin("HTTP://127.0.0.1:43123/", allow)).toBe("allowed");
    expect(checkOrigin("http://127.0.0.1:43124", allow)).toBe("rejected");
    expect(checkOrigin("http://localhost:43123", allow)).toBe("rejected");
    expect(checkOrigin("https://evil.example", allow)).toBe("rejected");
    expect(checkOrigin("null", allow)).toBe("rejected");
    expect(checkOrigin("not a url", allow)).toBe("rejected");
    expect(checkOrigin("https://evil.example", [])).toBe("rejected");
    expect(checkOrigin("https://evil.example", null)).toBe("allowed");
  });

  it("the approval server requires `allowed` — an absent Origin is refused there", () => {
    const src = readFileSync(resolve(__dirname, "..", "..", "src", "lib", "approval", "server.ts"), "utf8");
    expect(src).toContain('import { checkOrigin } from "./origin.js";');
    expect(src).toMatch(/checkOrigin\(req\.headers\.origin, \[this\.origin\]\) !== "allowed"/);
  });
});
