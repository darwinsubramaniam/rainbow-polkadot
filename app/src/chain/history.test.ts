import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HISTORY_CAP, markLanded, personalBest, remember, type RunRecord } from "./history.ts";

/**
 * The personal board is the one list in the app the chain cannot correct. If it
 * double-counts a session or leaks another account's runs, nothing downstream
 * will notice — so the rules live in pure functions and are pinned here.
 */

const PLAYER = "0xplayer";
const OTHER = "0xother";

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  player: PLAYER,
  score: "100",
  ticks: 900,
  epoch: 480_000,
  k: 0,
  at: 1_000,
  agreed: true,
  landed: false,
  ...over,
});

describe("remember", () => {
  it("puts the newest run first", () => {
    const list = remember(remember([], run({ score: "100", k: 0 })), run({ score: "50", k: 1 }));
    assert.deepEqual(
      list.map((r) => r.score),
      ["50", "100"],
    );
  });

  it("keeps one row per session slot, at that slot's highest score", () => {
    // A replayed session is a different run of the same level, but only one of
    // them can ever land — so the slot gets one row.
    let list = remember([], run({ score: "100" }));
    list = remember(list, run({ score: "180", at: 2_000 }));
    list = remember(list, run({ score: "40", at: 3_000 }));

    assert.equal(list.length, 1);
    assert.equal(list[0]?.score, "180");
  });

  it("does not merge different slots, epochs or players", () => {
    let list = remember([], run({ k: 0 }));
    list = remember(list, run({ k: 1 }));
    list = remember(list, run({ epoch: 480_001, k: 0 }));
    list = remember(list, run({ player: OTHER, k: 0 }));
    assert.equal(list.length, 4);
  });

  it("keeps a slot landed once it has landed", () => {
    let list = remember([], run({ score: "500", landed: true }));
    list = remember(list, run({ score: "20", at: 2_000 }));
    assert.equal(list.length, 1);
    assert.equal(list[0]?.landed, true, "a lower replay must not un-land the slot");
    assert.equal(list[0]?.score, "500");
  });

  it("compares scores numerically, not as strings", () => {
    // "9" > "10" lexicographically, which would keep the wrong run.
    const list = remember(remember([], run({ score: "9" })), run({ score: "10", at: 2_000 }));
    assert.equal(list[0]?.score, "10");
  });

  it("caps the list and drops the oldest", () => {
    let list: RunRecord[] = [];
    for (let i = 0; i < HISTORY_CAP + 5; i++) {
      list = remember(list, run({ k: i % 12, epoch: 480_000 + i, at: i, score: String(i) }));
    }
    assert.equal(list.length, HISTORY_CAP);
    assert.equal(list[0]?.score, String(HISTORY_CAP + 4), "newest survives");
  });

  it("does not mutate the list it was given", () => {
    const before = [run()];
    const copy = [...before];
    remember(before, run({ k: 1 }));
    assert.deepEqual(before, copy);
  });
});

describe("markLanded", () => {
  it("marks only the named slot", () => {
    let list = remember([], run({ k: 0 }));
    list = remember(list, run({ k: 1 }));
    const marked = markLanded(list, { player: PLAYER, epoch: 480_000, k: 1 });

    assert.equal(marked.find((r) => r.k === 1)?.landed, true);
    assert.equal(marked.find((r) => r.k === 0)?.landed, false);
  });

  it("ignores a slot it does not hold", () => {
    const list = remember([], run());
    assert.deepEqual(markLanded(list, { player: OTHER, epoch: 1, k: 9 }), list);
  });
});

describe("personalBest", () => {
  const list: RunRecord[] = [
    run({ score: "300", k: 0, at: 1 }),
    run({ score: "1200", k: 1, at: 2 }),
    run({ score: "80", k: 2, at: 3 }),
    run({ player: OTHER, score: "99999", k: 3, at: 4 }),
  ];

  it("ranks the player's own runs, highest first", () => {
    assert.deepEqual(
      personalBest(list, PLAYER).map((r) => r.score),
      ["1200", "300", "80"],
    );
  });

  it("never shows another account's runs", () => {
    assert.deepEqual(
      personalBest(list, OTHER).map((r) => r.score),
      ["99999"],
    );
  });

  it("is empty with no account, rather than showing everyone", () => {
    assert.deepEqual(personalBest(list, null), []);
  });

  it("matches an address regardless of case", () => {
    assert.equal(personalBest(list, PLAYER.toUpperCase()).length, 3);
  });

  it("sorts u64 scores by value", () => {
    const big = [run({ score: "9", k: 0 }), run({ score: "10", k: 1 })];
    assert.deepEqual(
      personalBest(big, PLAYER).map((r) => r.score),
      ["10", "9"],
    );
  });

  it("breaks ties with the newer run", () => {
    const tied = [run({ score: "5", k: 0, at: 10 }), run({ score: "5", k: 1, at: 20 })];
    assert.deepEqual(
      personalBest(tied, PLAYER).map((r) => r.k),
      [1, 0],
    );
  });

  it("takes only the top n", () => {
    const many = Array.from({ length: 20 }, (_, i) => run({ score: String(i), k: i, at: i }));
    assert.equal(personalBest(many, PLAYER).length, 10);
    assert.equal(personalBest(many, PLAYER, 3)[0]?.score, "19");
  });
});
