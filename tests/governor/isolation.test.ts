import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * AC #11: no `dexe_gov_*` tool depends on any DeXe Protocol contract being
 * deployed on the target chain. Enforced statically — every file under
 * src/governor/ must not import:
 *   - any DeXe Protocol address constant (../lib/govAddresses, ../lib/addresses)
 *   - DeXe-specific tool helpers (../tools/proposal*, ../tools/dao*, etc.)
 *   - DeXe selector / catalog modules
 *
 * Bare ethers + zod + MCP SDK + ../rpc + ../config are allowed.
 */

const GOV_ROOT = join(process.cwd(), "src", "governor");

const FORBIDDEN_PATTERNS = [
  /\.\.\/lib\/govAddresses/,
  /\.\.\/lib\/addresses/,
  /\.\.\/lib\/proposalCatalog/,
  /\.\.\/lib\/blacklist/,
  /\.\.\/lib\/govEnums/,
  /\.\.\/lib\/selectors/,
  /\.\.\/lib\/subgraph/,
  /\.\.\/tools\/proposal/,
  /\.\.\/tools\/dao/,
  /\.\.\/tools\/gov\.js/,
  /\.\.\/tools\/vote/,
  /\.\.\/tools\/read\.js/,
  /\.\.\/tools\/inbox/,
  /\.\.\/tools\/otc/,
  /\.\.\/tools\/predict/,
  /\.\.\/tools\/simulate/,
  /\.\.\/tools\/daoDeploy/,
  /\.\.\/tools\/flow/,
  /\.\.\/tools\/merkle/,
  /\.\.\/lib\/merkleTree/,
  /\.\.\/lib\/markdownToSlate/,
  /\.\.\/hardhat/,
  /\.\.\/artifacts/,
  /DeXe-Protocol/i,
  /investing-dashboard/i,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (extname(full) === ".ts") {
      out.push(full);
    }
  }
  return out;
}

describe("governor module — DeXe Protocol isolation", () => {
  const files = walk(GOV_ROOT);

  it("collects governor TS files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file.replace(process.cwd(), "")} imports only allowed modules`, () => {
      const src = readFileSync(file, "utf8");
      for (const re of FORBIDDEN_PATTERNS) {
        expect(src, `forbidden import matching ${re} in ${file}`).not.toMatch(re);
      }
    });
  }
});
