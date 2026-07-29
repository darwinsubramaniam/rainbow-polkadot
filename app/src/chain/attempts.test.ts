import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EPOCH_SECONDS,
  MAX_ATTEMPTS,
  localEpoch,
  minutesToReset,
  nextAttempt,
  type SessionRecord,
} from "./attempts.ts";

/**
 * The attempt rule is the anti-grinding cap made into a UI, and it is the one
 * piece of client logic that can silently waste a player's hourly budget or
 * ask the chain for a slot that reverts. It is a pure function precisely so it
 * can be pinned down here.
 *
 * Run with `npm test` — Node's own runner, no framework: the app ships against
 * a byte quota and a test dependency tree would be the largest thing in the
 * repo that never reaches a user.
 */

const PLAYER = "0xplayer";
const OTHER = "0xother";
const EPOCH = 480_000;

const held = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  player: PLAYER,
  epoch: EPOCH,
  k: 0,
  seed: "77",
  spent: false,
  ...over,
});

describe("nextAttempt", () => {
  it("opens the first slot when nothing is held", () => {
    assert.deepEqual(nextAttempt(null, PLAYER, EPOCH), { mode: "mint", k: 0 });
  });

  it("replays a held session rather than spending a new slot", () => {
    assert.deepEqual(nextAttempt(held({ k: 3, seed: "42" }), PLAYER, EPOCH), {
      mode: "replay",
      k: 3,
      seed: "42",
      epoch: EPOCH,
    });
  });

  it("advances only once the held session was consumed on-chain", () => {
    assert.deepEqual(nextAttempt(held({ k: 3, spent: true }), PLAYER, EPOCH), { mode: "mint", k: 4 });
  });

  it("still replays the last slot while it is unspent", () => {
    assert.deepEqual(nextAttempt(held({ k: MAX_ATTEMPTS - 1, seed: "9" }), PLAYER, EPOCH), {
      mode: "replay",
      k: MAX_ATTEMPTS - 1,
      seed: "9",
      epoch: EPOCH,
    });
  });

  it("reports exhaustion rather than asking for a slot the contract rejects", () => {
    // k === MAX_ATTEMPTS would revert with SessionIndexOutOfRange.
    assert.deepEqual(nextAttempt(held({ k: MAX_ATTEMPTS - 1, spent: true }), PLAYER, EPOCH), {
      mode: "exhausted",
    });
  });

  it("gives the budget back when the epoch rolls", () => {
    const spentOut = held({ k: MAX_ATTEMPTS - 1, spent: true });
    assert.deepEqual(nextAttempt(spentOut, PLAYER, EPOCH), { mode: "exhausted" });
    assert.deepEqual(nextAttempt(spentOut, PLAYER, EPOCH + 1), { mode: "mint", k: 0 });
  });

  it("does not carry an unspent session across an epoch boundary", () => {
    // The session id hashes the epoch in, so last hour's seed is not claimable.
    assert.deepEqual(nextAttempt(held({ k: 4 }), PLAYER, EPOCH + 9), { mode: "mint", k: 0 });
  });

  it("ignores another account's record", () => {
    // Sessions are keyed by player; one account cannot spend another's budget.
    assert.deepEqual(nextAttempt(held({ k: MAX_ATTEMPTS - 1, spent: true }), OTHER, EPOCH), {
      mode: "mint",
      k: 0,
    });
  });

  it("ignores a record when no account is connected yet", () => {
    assert.deepEqual(nextAttempt(held({ k: 5, spent: true }), null, EPOCH), { mode: "mint", k: 0 });
  });

  it(`yields exactly ${MAX_ATTEMPTS} slots per epoch, and never a further one`, () => {
    let record: SessionRecord | null = null;
    let minted = 0;

    // Well past the cap: a rule that kept counting would show up as a loop that
    // never reports exhaustion.
    for (let i = 0; i < MAX_ATTEMPTS * 4; i++) {
      const next = nextAttempt(record, PLAYER, EPOCH);
      if (next.mode === "exhausted") break;
      assert.equal(next.mode, "mint");
      assert.equal(next.k, minted, "slots are handed out in order, none skipped");
      minted++;
      // Simulate a submit the chain accepted.
      record = { player: PLAYER, epoch: EPOCH, k: next.k, seed: "s", spent: true };
    }

    assert.equal(minted, MAX_ATTEMPTS);
    assert.deepEqual(nextAttempt(record, PLAYER, EPOCH), { mode: "exhausted" });
  });
});

describe("clock helpers", () => {
  // A round timestamp sitting exactly on an hour boundary.
  const TOP_OF_HOUR = 1_800_000_000_000 - (1_800_000_000_000 % (EPOCH_SECONDS * 1000));

  it("counts epochs as whole hours since the unix epoch", () => {
    assert.equal(localEpoch(TOP_OF_HOUR), TOP_OF_HOUR / 1000 / EPOCH_SECONDS);
  });

  it("advances one epoch per hour", () => {
    assert.equal(localEpoch(TOP_OF_HOUR + EPOCH_SECONDS * 1000), localEpoch(TOP_OF_HOUR) + 1);
  });

  it("stays in the same epoch a millisecond before the boundary", () => {
    assert.equal(localEpoch(TOP_OF_HOUR + EPOCH_SECONDS * 1000 - 1), localEpoch(TOP_OF_HOUR));
  });

  it("reports a full hour at the top of one", () => {
    assert.equal(minutesToReset(TOP_OF_HOUR), 60);
  });

  it("rounds up, so the message never reads 0 min", () => {
    assert.equal(minutesToReset(TOP_OF_HOUR + 59.5 * 60_000), 1);
    assert.equal(minutesToReset(TOP_OF_HOUR + 59.99 * 60_000), 1);
  });
});
