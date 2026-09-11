import { describe, expect, it, beforeEach, vi } from "vitest";
import { PinataClient, pinataCidForJson } from "../../src/lib/ipfs.js";
import { resolveMerkleUris } from "../../src/tools/otc.js";
import type { TierSpec } from "../../src/tools/proposalBuildComplex.js";

/**
 * ── A preview must not publish the DAO's allowlist ──────────────────────────
 *
 * `resolveMerkleUris` uploads a MerkleWhitelist tier's address list so buyers
 * can derive proofs on app.dexe.io. Its call site gated on `buildOnly` and
 * never on `dryRun`, so `dexe_otc_dao_open_sale({dryRun:true})` permanently
 * published a list of private addresses to a public content-addressed network
 * — before the balance/threshold guards downstream had even run.
 *
 * The merkle ROOT is derived from `users` locally (proposalBuildComplex), so
 * the on-chain gate is unaffected either way; only the informational `uri`
 * differs — and since 0.34.0 not even that, because the local CID is the CID a
 * real pin returns.
 */

const USER_A = "0x9572f3Bc1111111111111111111111111111aaaa";
const USER_B = "0x425f1072222222222222222222222222222222bb";

function merkleTier(name = "Founding circle"): TierSpec {
  return {
    name,
    participation: [{ type: "MerkleWhitelist", users: [USER_A, USER_B] }],
  } as unknown as TierSpec;
}

let pinJson: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  pinJson = vi
    .spyOn(PinataClient.prototype, "pinJson")
    .mockRejectedValue(new Error("test: a dryRun must never touch the network"));
});

describe("resolveMerkleUris", () => {
  it("dryRun pins nothing and returns the CID a real pin would produce", async () => {
    const r = await resolveMerkleUris([merkleTier()], "test-jwt", { dryRun: true });
    expect(pinJson).not.toHaveBeenCalled();
    expect(r.uploaded).toHaveLength(1);
    expect(r.uploaded[0]!.pinned).toBe(false);
    // Pins the lowercasing too — the uploaded list is lowercased while the
    // merkle root uses checksummed addresses, and the two must not drift.
    const expected = await pinataCidForJson({ list: [USER_A.toLowerCase(), USER_B.toLowerCase()] });
    expect(r.uploaded[0]!.uri).toBe(`ipfs://${expected.cid}`);
    expect((r.tiers[0]!.participation ?? [])[0]!.uri).toBe(`ipfs://${expected.cid}`);
    const warned = r.warnings.join(" ");
    expect(warned).toContain("NOT pinned (dryRun)");
    expect(warned).toContain("Do not broadcast");
  });

  it("a real run pins exactly once per merkle tier", async () => {
    pinJson.mockReset();
    pinJson.mockResolvedValue({ cid: "QmFAKE", size: 1, pinnedAt: "x" });
    const r = await resolveMerkleUris([merkleTier()], "test-jwt", { dryRun: false });
    expect(pinJson).toHaveBeenCalledTimes(1);
    expect(r.uploaded[0]).toEqual({ tierName: "Founding circle", uri: "ipfs://QmFAKE", pinned: true });
    expect(r.warnings).toHaveLength(0);
  });

  it("no JWT + real run keeps the existing warning and passes the tier through untouched", async () => {
    const tier = merkleTier();
    const r = await resolveMerkleUris([tier], undefined, { dryRun: false });
    expect(pinJson).not.toHaveBeenCalled();
    expect(r.uploaded).toHaveLength(0);
    expect(r.warnings[0]).toContain("DEXE_PINATA_JWT unset");
    // Identity, not `uri === ''` — the empty string only materializes later,
    // in proposalBuildComplex's `spec.uri ?? ""`.
    expect(r.tiers[0]).toBe(tier);
  });

  it("no JWT + dryRun warns that the REAL run will emit an EMPTY uri", async () => {
    // The preview must not fabricate a uri here: without a key the real run
    // leaves it empty, so a plausible-looking CID would be a lie.
    const r = await resolveMerkleUris([merkleTier()], undefined, { dryRun: true });
    expect(r.uploaded).toHaveLength(0);
    expect(r.warnings[0]).toContain("will leave this MerkleWhitelist uri EMPTY");
  });

  it("never touches a tier that already has a uri or has no users", async () => {
    const withUri = {
      name: "Preset",
      participation: [{ type: "MerkleWhitelist", users: [USER_A], uri: "ipfs://QmPreset" }],
    } as unknown as TierSpec;
    const noUsers = {
      name: "Rootless",
      participation: [{ type: "MerkleWhitelist", users: [] }],
    } as unknown as TierSpec;
    const input = [withUri, noUsers];
    const r = await resolveMerkleUris(input, "test-jwt", { dryRun: false });
    expect(pinJson).not.toHaveBeenCalled();
    expect(r.tiers).toEqual(input);
    expect(r.uploaded).toHaveLength(0);
  });
});
