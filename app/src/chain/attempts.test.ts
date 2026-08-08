import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EPOCH_SECONDS,
  MAX_ATTEMPTS,
  localEpoch,
  reconcileSpent,
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

describe("a record written by an earlier build", () => {
  /*
   * `abandonAttempt` and the `abandoned` flag used to be tested here.
   *
   * They existed because a submit that did not beat the player's own best
   * reverted and consumed nothing, so a player who could not improve was pinned
   * to one seed for the rest of the epoch. The contract now records every
   * attested run and consumes the session on the first submission, so there is
   * nothing to be stuck on and nothing to abandon.
   *
   * What survives is compatibility: a record persisted by an older build can
   * still carry `abandoned: true`, and must not confuse the rule.
   */
  it("is read as unspent even when it carries an old `abandoned` flag", () => {
    // Which is what it always was on-chain: abandoning never consumed anything,
    // so the honest reading of such a slot is that it is still the player's.
    const stale = { ...held({ k: 3, seed: "77" }), abandoned: true } as SessionRecord;
    assert.deepEqual(nextAttempt(stale, PLAYER, EPOCH), {
      mode: "replay",
      k: 3,
      seed: "77",
      epoch: EPOCH,
    });
  });

  it("still advances once that slot is genuinely spent", () => {
    const stale = { ...held({ k: 3, spent: true }), abandoned: true } as SessionRecord;
    assert.deepEqual(nextAttempt(stale, PLAYER, EPOCH), { mode: "mint", k: 4 });
  });
});

const held0 = held;

describe("reconcileSpent", () => {
  it("marks a slot spent when the chain says it is", () => {
    // The case that stranded a real player: a submit landed out of band — from
    // another device, or from the rescue script after the host hung — so the
    // contract had burned the slot while this browser still offered a replay of
    // it, and every submission reverted `SessionAlreadyUsed`.
    const held = { ...held0({ k: 0, seed: "77" }) };
    assert.equal(held.spent, false);

    const after = reconcileSpent(held, true);
    assert.equal(after.spent, true);
    assert.deepEqual(nextAttempt(after, PLAYER, EPOCH), { mode: "mint", k: 1 });
  });

  it("leaves an unspent slot alone rather than un-spending it", () => {
    // One-directional on purpose. A read racing a transaction still in the pool
    // reports "not spent", and believing it would hand back a seed the player
    // has in fact already used.
    const landed = held0({ spent: true });
    assert.equal(reconcileSpent(landed, false), landed);
  });

  it("is a no-op when local and chain already agree", () => {
    const landed = held0({ spent: true });
    assert.equal(reconcileSpent(landed, true), landed);
    const open = held0();
    assert.equal(reconcileSpent(open, false), open);
  });

  it("does not mutate the record it is handed", () => {
    const record = held0();
    reconcileSpent(record, true);
    assert.equal(record.spent, false);
  });
});
