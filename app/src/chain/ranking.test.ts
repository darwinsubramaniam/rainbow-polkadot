import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TOP, rank, rankOf, type Row } from "./ranking.ts";

/**
 * The contract deliberately returns the board unsorted, so this is where a
 * leaderboard becomes a ranking. A wrong comparator here shows a plausible board
 * that is simply in the wrong order — nothing errors, so nothing would catch it
 * but a test.
 */

const row = (player: string, score: bigint | number): Row => ({ player, score: BigInt(score) });

describe("rank", () => {
  it("orders highest first", () => {
    const ranked = rank([row("0xa", 10), row("0xb", 900), row("0xc", 50)]);
    assert.deepEqual(
      ranked.map((r) => r.player),
      ["0xb", "0xc", "0xa"],
    );
  });

  it("keeps first-score order among equal scores", () => {
    // The rows arrive in the order players first scored, so a stable sort makes
    // "who got there first" the tie-break rather than leaving it to the engine.
    const ranked = rank([row("0xfirst", 100), row("0xsecond", 100), row("0xthird", 100)]);
    assert.deepEqual(
      ranked.map((r) => r.player),
      ["0xfirst", "0xsecond", "0xthird"],
    );
  });

  it("orders u64 scores that overflow a double", () => {
    // Number(a - b) would return 0 for these: they differ by 1 at a magnitude
    // where doubles cannot represent the gap.
    const a = 2n ** 63n;
    const ranked = rank([row("0xlow", a), row("0xhigh", a + 1n)]);
    assert.deepEqual(
      ranked.map((r) => r.player),
      ["0xhigh", "0xlow"],
    );
  });

  it("keeps ten rows by default", () => {
    const rows = Array.from({ length: 25 }, (_, i) => row(`0x${i}`, i));
    assert.equal(rank(rows).length, TOP);
    assert.equal(rank(rows)[0]?.player, "0x24");
    assert.equal(rank(rows, 3).length, 3);
  });

  it("does not mutate the snapshot it was handed", () => {
    const rows = [row("0xa", 1), row("0xb", 2)];
    const order = rows.map((r) => r.player);
    rank(rows);
    assert.deepEqual(
      rows.map((r) => r.player),
      order,
    );
  });

  it("handles an empty board", () => {
    assert.deepEqual(rank([]), []);
  });
});

describe("rankOf", () => {
  const ranked = rank([row("0xAaa", 10), row("0xbbb", 900)]);

  it("finds a player's position", () => {
    assert.equal(rankOf(ranked, "0xbbb"), 0);
    assert.equal(rankOf(ranked, "0xAaa"), 1);
  });

  it("matches an address regardless of case", () => {
    // The contract returns checksummed addresses; the app derives its own from
    // ss58ToH160. Comparing them raw would fail to highlight the player's row.
    assert.equal(rankOf(ranked, "0xAAA"), 1);
  });

  it("is null for a player who is not listed", () => {
    assert.equal(rankOf(ranked, "0xzzz"), null);
    assert.equal(rankOf(ranked, null), null);
  });
});
