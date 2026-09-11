import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Contract, JsonRpcProvider, ZeroAddress, getAddress } from "ethers";
import { loadGovernorConfigs } from "../../src/governor/loader.js";
import { governorContract, isBravo, readQuorum } from "../../src/governor/adapter.js";

/**
 * Fixture-vs-chain drift check — the only thing in this repo that ever re-reads
 * a Governor fixture off-chain.
 *
 * Everything else is offline-shape-only, which is how a dead Compound governor,
 * a Uniswap timelock with no bytecode, a 2.5x-stale proposalThreshold and a
 * missing Optimism timelock all shipped green through ~1,960 passing tests.
 * Fixtures are static snapshots of MUTABLE on-chain state; upgradeable governors
 * guarantee they rot.
 *
 * SKIPPED BY DEFAULT: default `npm test`, a fresh clone and an offline machine
 * contribute zero network calls. Enable it with a per-chain RPC — the canonical
 * `DEXE_RPC_URL_<chainId>` family (src/config.ts registers any of them):
 *
 *   $env:DEXE_RPC_URL_1  = "https://eth.drpc.org"
 *   $env:DEXE_RPC_URL_10 = "https://optimism.drpc.org"
 *   npx vitest run tests/governor/fixtures-live.test.ts
 *
 * Use an ARCHIVE endpoint: `quorum(snapshotBlock)` and `getPastVotes` are
 * historical reads, and the free publicnode hosts answer them with HTTP 403
 * "Archive requests require a personal token".
 *
 * NOT `DEXE_RPC_URL_MAINNET` — in this project that name means BSC chain 56
 * (src/env/schema.ts), so pointing it at an Ethereum governor reads a
 * nonexistent contract.
 *
 * Run it before any release that touches src/governor/configs/.
 */

const rpcFor = (chainId: number): string | undefined =>
  process.env[`DEXE_RPC_URL_${chainId}`]?.trim() || undefined;

const LIVE = process.env.GOVERNOR_LIVE === "1" || Boolean(rpcFor(1) || rpcFor(10));

/** Bravo governors expose `uni()`/`comp()`, not `token()`; OP exposes `token()`. */
const PROBE_ABI = [
  "function name() view returns (string)",
  "function timelock() view returns (address)",
  "function proposalSnapshot(uint256) view returns (uint256)",
  "function quorumVotes() view returns (uint256)",
] as const;

/** Compound-style Timelock. OZ TimelockController is role-based and has no admin(). */
const TIMELOCK_ABI = ["function admin() view returns (address)"] as const;

const TOKEN_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function getPriorVotes(address,uint256) view returns (uint96)",
  "function getPastVotes(address,uint256) view returns (uint256)",
] as const;

type Probe<T> = { ok: true; value: T } | { ok: false };

/**
 * Distinguishes "this contract has no such function" from "the RPC failed".
 *
 * A bare `.catch(() => null)` reads a rate limit, a timeout or a 502 as
 * "function absent" and turns the outage into a PASS — precisely on the class
 * of drift this file exists to catch. Transport failures rethrow and go red.
 */
async function probe<T>(fn: () => Promise<T>): Promise<Probe<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code === "CALL_EXCEPTION" || code === "BAD_DATA") return { ok: false };
    throw e;
  }
}

for (const cfg of loadGovernorConfigs().values()) {
  const url = rpcFor(cfg.chainId);
  describe.skipIf(!LIVE || !url)(`fixture vs chain — ${cfg.id} (chain ${cfg.chainId})`, () => {
    let provider: JsonRpcProvider;
    let gov: Contract;

    // A skipped suite still runs its factory, so construction must happen here.
    beforeAll(() => {
      provider = new JsonRpcProvider(url!, cfg.chainId, { staticNetwork: true });
      gov = governorContract(provider, cfg);
    });
    afterAll(async () => {
      await provider?.destroy();
    });

    it("governor address holds a live contract", async () => {
      expect(
        await provider.getCode(cfg.governorAddress),
        `src/governor/configs/${cfg.id}.json governorAddress has no bytecode on chain ${cfg.chainId}`,
      ).not.toBe("0x");
      const name = await probe(() =>
        new Contract(cfg.governorAddress, PROBE_ABI as unknown as string[], provider).name(),
      );
      expect(name.ok).toBe(true);
    }, 60_000);

    it("governorVersion matches the deployed ABI family", async () => {
      // No proposal id and no eth_getLogs needed: the two families are
      // separated by which of these two getters exists. This is the assertion
      // that catches a fixture repointed at a governor of the other family.
      const c = new Contract(cfg.governorAddress, PROBE_ABI as unknown as string[], provider);
      const hasQuorumVotes = await probe(() => c.getFunction("quorumVotes").staticCall());
      const hasSnapshot = await probe(() => c.getFunction("proposalSnapshot").staticCall(0n));
      if (isBravo(cfg)) {
        expect(hasQuorumVotes.ok, `${cfg.id} is bravo-v3 but the contract has no quorumVotes()`).toBe(true);
        expect(hasSnapshot.ok, `${cfg.id} is bravo-v3 but the contract HAS proposalSnapshot()`).toBe(false);
      } else {
        expect(hasSnapshot.ok, `${cfg.id} is ${cfg.governorVersion} but has no proposalSnapshot()`).toBe(true);
        expect(hasQuorumVotes.ok, `${cfg.id} is ${cfg.governorVersion} but HAS quorumVotes()`).toBe(false);
      }
    }, 60_000);

    it("timelock matches the fixture and still holds code", async () => {
      const c = new Contract(cfg.governorAddress, PROBE_ABI as unknown as string[], provider);
      const live = await probe<string>(() => c.getFunction("timelock").staticCall());
      if (cfg.timelock) {
        expect(live.ok, `${cfg.id} declares a timelock but the governor has no timelock()`).toBe(true);
        const addr = (live as { ok: true; value: string }).value;
        expect(
          getAddress(addr),
          `src/governor/configs/${cfg.id}.json timelock is stale — on-chain timelock() is ${addr}; ` +
            "update the JSON and the docs/GOVERNOR.md table in the same commit",
        ).toBe(getAddress(cfg.timelock.address));
        expect(await provider.getCode(addr)).not.toBe("0x");

        // The link must be MUTUAL. A Compound-style Timelock names exactly one
        // admin, and that is the contract that can actually execute. This is
        // the assertion that would have caught the Compound migration: the
        // retired GovernorBravo still answers name()/params/quorumVotes() and
        // still points at the right Timelock, so every other check here passes
        // — but the Timelock's admin() had already moved to the new governor.
        // OZ TimelockController is role-based and has no admin(), so an absent
        // getter is not a failure.
        const admin = await probe<string>(() =>
          new Contract(addr, TIMELOCK_ABI as unknown as string[], provider).admin(),
        );
        if (admin.ok) {
          expect(
            getAddress(admin.value),
            `${cfg.id}: the timelock's admin is ${admin.value}, not the configured governor ` +
              `${cfg.governorAddress} — this governor cannot execute. It has most likely been ` +
              "superseded; re-read the DAO's current governor and repoint the fixture.",
          ).toBe(getAddress(cfg.governorAddress));
        }
      } else {
        expect(!live.ok || (live as { ok: true; value: string }).value === ZeroAddress).toBe(true);
      }
    }, 60_000);

    it("votingDelay / votingPeriod / proposalThreshold match the fixture", async () => {
      expect(Number(await gov.getFunction("votingDelay").staticCall())).toBe(cfg.votingParams.votingDelay);
      expect(Number(await gov.getFunction("votingPeriod").staticCall())).toBe(cfg.votingParams.votingPeriod);
      if (cfg.votingParams.proposalThreshold !== undefined) {
        // "0" is a legitimate value (Optimism) — compare against undefined, not truthiness.
        expect((await gov.getFunction("proposalThreshold").staticCall()).toString()).toBe(
          cfg.votingParams.proposalThreshold,
        );
      }
    }, 60_000);

    it("voting token matches the fixture, including its votes interface", async () => {
      const t = new Contract(cfg.votingToken.address, TOKEN_ABI as unknown as string[], provider);
      expect(await provider.getCode(cfg.votingToken.address)).not.toBe("0x");
      expect(await t.symbol()).toBe(cfg.votingToken.symbol);
      expect(Number(await t.decimals())).toBe(cfg.votingToken.decimals);
      // `votingToken.type` statically selects getPriorVotes vs getPastVotes in
      // readVotingPower — there is no runtime fallback, so a flipped type
      // silently misreads every voter's power.
      const block = (await provider.getBlockNumber()) - 10;
      const comp = await probe(() => t.getFunction("getPriorVotes").staticCall(ZeroAddress, block));
      const oz = await probe(() => t.getFunction("getPastVotes").staticCall(ZeroAddress, block));
      if (cfg.votingToken.type === "ERC20VotesComp") {
        expect(comp.ok).toBe(true);
        expect(oz.ok).toBe(false);
      } else {
        expect(oz.ok).toBe(true);
        expect(comp.ok).toBe(false);
      }
    }, 60_000);

    it("quorum resolves non-zero through the configured source", async () => {
      const block = (await provider.getBlockNumber()) - 10;
      const { quorum, method } = await readQuorum(gov, cfg, block);
      expect(quorum, `${cfg.id}: quorum resolved to 0 via ${method}`).toBeGreaterThan(0n);
      const expected = isBravo(cfg)
        ? "quorumVotes()"
        : cfg.quorumSource === "votable-supply"
          ? "votableSupply(blockNumber)*ratio"
          : "quorum(blockNumber)";
      expect(method).toBe(expected);
    }, 60_000);

    it("legacyGovernor, when declared, is a real contract that is NOT the current one", async () => {
      if (!cfg.legacyGovernor) return;
      expect(cfg.legacyGovernor.address.toLowerCase()).not.toBe(cfg.governorAddress.toLowerCase());
      expect(await provider.getCode(cfg.legacyGovernor.address)).not.toBe("0x");
    }, 60_000);
  });
}
