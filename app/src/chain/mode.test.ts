import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GUEST_PLAYER, resolveMode, type Mode, type ModeInput, type Tier } from "./mode.ts";

/**
 * The tier ladder decides what a run is allowed to do, and one wrong answer
 * here is not a cosmetic bug: a guest permitted to open a session against the
 * deployed enclave burns a real attempt for a run nobody can submit, and a
 * simulated run permitted to submit spends a transaction on a signature the
 * contract is guaranteed to reject.
 *
 * The point of `resolveMode` being pure and total is that those outcomes can
 * be ruled out by enumeration rather than by reading `Play` and hoping. So
 * this file enumerates: every input combination, and the invariants that must
 * hold across all of them.
 *
 * That enumeration is possible because `resolveMode` touches nothing outside
 * its arguments — no storage, no clock — so there is no browser to stand up.
 */

const WALLET = "0x1111111111111111111111111111111111111111";

const input = (over: Partial<ModeInput> = {}): ModeInput => ({
  walletPlayer: WALLET,
  simulatorOn: false,
  hasHost: true,
  ...over,
});

/** Every combination of the three decisive inputs, which is the whole domain. */
const everyInput = (): ModeInput[] =>
  [null, WALLET].flatMap((walletPlayer) =>
    [false, true].flatMap((simulatorOn) =>
      [false, true].map((hasHost) => input({ walletPlayer, simulatorOn, hasHost })),
    ),
  );

const H160 = /^0x[0-9a-fA-F]{40}$/;

describe("the tier ladder", () => {
  it("puts a player with no wallet in guest, whatever else is set", () => {
    for (const simulatorOn of [false, true]) {
      for (const hasHost of [false, true]) {
        const mode = resolveMode(input({ walletPlayer: null, simulatorOn, hasHost }));
        assert.equal(mode.tier, "guest", `simulatorOn=${simulatorOn} hasHost=${hasHost}`);
      }
    }
  });

  it("puts a connected player in practice or live according to the switch", () => {
    assert.equal(resolveMode(input({ simulatorOn: true })).tier, "practice");
    assert.equal(resolveMode(input({ simulatorOn: false })).tier, "live");
  });

  it("reaches every tier, so the cases below are not vacuous", () => {
    const reached = new Set<Tier>(everyInput().map((i) => resolveMode(i).tier));
    assert.deepEqual([...reached].sort(), ["guest", "live", "practice"]);
  });
});

describe("what each tier may do", () => {
  it("never lets a guest submit", () => {
    for (const i of everyInput().filter((i) => i.walletPlayer === null)) {
      assert.equal(resolveMode(i).canSubmit, false);
    }
  });

  it("never lets a simulated enclave submit", () => {
    for (const i of everyInput().filter((i) => resolveMode(i).enclave === "simulated")) {
      assert.equal(resolveMode(i).canSubmit, false);
    }
  });

  it("lets live submit only when a host is there to submit through", () => {
    assert.equal(resolveMode(input({ hasHost: true })).canSubmit, true);
    assert.equal(resolveMode(input({ hasHost: false })).canSubmit, false);
  });

  it("is the only tier that can submit at all", () => {
    for (const i of everyInput()) {
      const mode = resolveMode(i);
      if (mode.canSubmit) assert.equal(mode.tier, "live");
    }
  });
});

describe("invariants that hold across every combination", () => {
  const all = (): Mode[] => everyInput().map(resolveMode);

  it("always yields an address the enclave will accept", () => {
    // `mock.ts`'s `check()` and the deployed verifier both apply this pattern
    // before doing any work, because the address is hashed into `sessionId`.
    for (const mode of all()) assert.match(mode.player, H160);
  });

  it("pins a guest to the in-tab enclave, so no real attempt is ever spent", () => {
    for (const mode of all().filter((m) => m.isGuest)) {
      assert.equal(mode.enclave, "simulated");
      assert.equal(mode.probesProcessor, false);
    }
  });

  it("gives every guest the same placeholder, never a per-browser address", () => {
    // The constant is the point: a generated address is indistinguishable from
    // a wallet in the UI, and a guest holds no key for anything.
    const guests = all().filter((m) => m.isGuest);
    assert.ok(guests.length > 0);
    for (const mode of guests) assert.equal(mode.player, GUEST_PLAYER);
    // Decodes to "guest", so it reads as a placeholder on inspection.
    assert.equal(Buffer.from(GUEST_PLAYER.slice(2, 12), "hex").toString(), "guest");
  });

  it("never hands a guest an address a real account could also have", () => {
    for (const mode of all().filter((m) => !m.isGuest)) {
      assert.notEqual(mode.player, GUEST_PLAYER);
    }
  });

  it("claims an on-chain record only for a real account", () => {
    for (const mode of all()) assert.equal(mode.hasOnChainRecord, !mode.isGuest);
  });

  it("gives every tier its own storage slot", () => {
    const slots = new Map<Tier, string>();
    for (const mode of all()) {
      const seen = slots.get(mode.tier);
      // Same tier must always mean the same slot, or a session could be
      // written to one place and looked for in another.
      if (seen !== undefined) assert.equal(mode.slot, seen);
      slots.set(mode.tier, mode.slot);
    }
    assert.equal(new Set(slots.values()).size, slots.size, "two tiers share a slot");
  });

  it("explains itself exactly when it refuses", () => {
    // A refusal with no reason surfaces in the log as a bare "stopping before
    // submit", which is the failure this pairing exists to prevent.
    for (const mode of all()) {
      assert.equal(mode.canSubmit, mode.blockedReason === null);
      assert.notEqual(mode.summary, "");
    }
  });
});
