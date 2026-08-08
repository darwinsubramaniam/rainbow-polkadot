import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HISTORY_CAP, markLanded, remember, standings, type RunRecord } from "./history.ts";

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

  it("lets an attested run replace a higher local one", () => {
    // The disagreement case, and the reason score alone cannot decide the
    // merge: this device counted 900, the enclave signed 700, and 700 is the
    // only number the contract would ever take. Keeping 900 would store a score
    // no chain will accept, in a list that claims the enclave stands behind it.
    let list = remember([], run({ score: "900", attested: false }));
    list = remember(list, run({ score: "700", at: 2_000, agreed: false }));

    assert.equal(list.length, 1);
    assert.equal(list[0]?.score, "700");
    assert.notEqual(list[0]?.attested, false);
  });

  it("does not let a later local run displace the attested one", () => {
    // The same rule in the other direction: replaying a slot offline after it
    // was attested must not overwrite the signed number with a browser's own.
    let list = remember([], run({ score: "700" }));
    list = remember(list, run({ score: "900", at: 2_000, attested: false }));

    assert.equal(list[0]?.score, "700");
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

describe("standings", () => {
  const list: RunRecord[] = [
    run({ score: "300", k: 0, at: 1 }),
    run({ score: "1200", k: 1, at: 2 }),
    run({ score: "80", k: 2, at: 3 }),
    run({ player: OTHER, score: "99999", k: 3, at: 4 }),
  ];

  it("ranks the player's own runs, highest first", () => {
    assert.deepEqual(
      standings(list, PLAYER, null).map((r) => r.score),
      ["1200", "300", "80"],
    );
  });

  it("never shows another account's runs", () => {
    assert.deepEqual(
      standings(list, OTHER, null).map((r) => r.score),
      ["99999"],
    );
  });

  it("is empty with no account, rather than showing everyone", () => {
    assert.deepEqual(standings(list, null, 500n), []);
  });

  it("matches an address regardless of case", () => {
    assert.equal(standings(list, PLAYER.toUpperCase(), null).length, 3);
  });

  it("sorts u64 scores by value", () => {
    // "9" > "10" as strings, and a leaderboard that sorted that way would be
    // wrong in exactly the direction nobody checks.
    const big = [run({ score: "9", k: 0 }), run({ score: "10", k: 1 })];
    assert.deepEqual(
      standings(big, PLAYER, null).map((r) => r.score),
      ["10", "9"],
    );
  });

  it("breaks ties with the newer run", () => {
    const tied = [run({ score: "5", k: 0, at: 10 }), run({ score: "5", k: 1, at: 20 })];
    assert.deepEqual(
      standings(tied, PLAYER, null).map((r) => r.at),
      [20, 10],
    );
  });

  it("takes only the top n", () => {
    const many = Array.from({ length: 20 }, (_, i) => run({ score: String(i), k: i, at: i }));
    assert.equal(standings(many, PLAYER, null).length, 10);
    assert.equal(standings(many, PLAYER, null, 3)[0]?.score, "19");
  });

  it("adds the chain's best as a row of its own", () => {
    // The case that motivated merging at all: a score landed from another
    // device, or before this browser's history was cleared. Nothing local knows
    // about it, and the panel header already claims it.
    const rows = standings([run({ score: "300", k: 0 })], PLAYER, 1600n);
    assert.deepEqual(
      rows.map((r) => [r.source, r.score]),
      [
        ["chain", "1600"],
        ["enclave", "300"],
      ],
    );
  });

  it("does not list a landed run twice", () => {
    // The most common case of all: the best on-chain *is* the run this device
    // landed. One achievement, one row.
    const landed = [run({ score: "1600", k: 0, landed: true })];
    const rows = standings(landed, PLAYER, 1600n);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.source, "enclave");
    assert.equal(rows[0]?.landed, true);
  });

  it("still shows the chain row when a local run ties it but never landed", () => {
    // Same number, different facts: an unlanded local run is not evidence that
    // the chain's best came from here, and collapsing them would erase one.
    const rows = standings([run({ score: "1600", k: 0, landed: false })], PLAYER, 1600n);
    assert.deepEqual(
      rows.map((r) => r.source),
      ["chain", "enclave"],
    );
  });

  it("omits a zero best rather than showing a row for no score", () => {
    assert.deepEqual(standings([], PLAYER, 0n), []);
  });

  it("marks a run the enclave never saw as this device's own", () => {
    const rows = standings([run({ score: "300", attested: false })], PLAYER, null);
    assert.equal(rows[0]?.source, "device");
    // `agreed: false` on an unattested record means "no verdict", not
    // "mismatch" — a row tagged both would accuse the enclave of nothing.
    assert.equal(rows[0]?.disagreed, false);
  });

  it("reports a real disagreement, which only an attested run can have", () => {
    const rows = standings([run({ score: "300", agreed: false })], PLAYER, null);
    assert.equal(rows[0]?.source, "enclave");
    assert.equal(rows[0]?.disagreed, true);
  });
});
