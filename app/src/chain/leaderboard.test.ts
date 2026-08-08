import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { isContractRevert, revertMessage, revertName } from "./revert.ts";

/**
 * The error entries are the only thing standing between a revert and a player
 * reading four bytes of hex.
 *
 * They are also the easiest thing in the repo to forget: adding an error to the
 * contract costs one line of Solidity and breaks nothing here — the app keeps
 * building, keeps submitting, and only the failure path gets quietly worse. So
 * the contract source is the fixture, and drift is a test failure rather than a
 * surprise at the end of somebody's run.
 *
 * What changed is which side is under test. This used to check a hand-written
 * `LEADERBOARD_ERRORS` table, and the table is gone — `cdm.json` carries the
 * ABI now. That does not retire the test, it retargets it: an installed manifest
 * is a *snapshot*, so `cdm i` not being re-run after a contract change fails in
 * precisely the way the hand-written table used to. The manifest is read as a
 * fixture rather than imported so this file stays runnable under Node's type
 * stripping without import attributes.
 */

const SOLIDITY = new URL("../../../contracts/src/Leaderboard.sol", import.meta.url);
const MANIFEST = new URL("../../cdm.json", import.meta.url);

const LEADERBOARD = "@dw3labs/rainbow-leaderboard";

/** Error names in the installed ABI, whatever their arity. */
const abiErrors = (): string[] => {
  const cdm = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const entry = cdm.contracts?.[LEADERBOARD];
  assert.ok(entry, `cdm.json has no ${LEADERBOARD} — run \`cdm i -n devnet ${LEADERBOARD}\``);
  return entry.abi
    .filter((e: { type: string }) => e.type === "error")
    .map((e: { name: string }) => e.name);
};

const declaredErrors = (): string[] => {
  const source = readFileSync(SOLIDITY, "utf8");
  // Only the no-argument form, which is every error this contract declares. An
  // error that grew arguments would stop matching here, and should: its ABI
  // entry needs the inputs too, and a silent pass would hide that.
  return [...source.matchAll(/^\s*error\s+(\w+)\(\);/gm)].map((m) => m[1]!);
};

const selector = (signature: string): string =>
  "0x" + bytesToHex(keccak_256(new TextEncoder().encode(signature))).slice(0, 8);

describe("the leaderboard error ABI", () => {
  it("declares every error the contract can revert with", () => {
    const inAbi = abiErrors();
    const inSolidity = declaredErrors();

    // Guards the fixture itself: a moved or renamed contract would otherwise
    // make this test vacuously pass with two empty lists.
    assert.ok(inSolidity.length >= 9, `parsed too few errors from ${SOLIDITY.pathname}`);

    // A superset, not an equality, and that is the improvement. The manifest is
    // compiled from the artifact, so it also carries the errors the contract
    // *inherits* — `OwnableUnauthorizedAccount`, `InvalidShortString` and two
    // more that OpenZeppelin declares and `Leaderboard.sol` therefore does not.
    // The hand-written table this replaced had none of them, and the equality it
    // asserted was the reason: it could only ever be as complete as the regex
    // below, which reads one file.
    const missing = inSolidity.filter((name) => !inAbi.includes(name));
    assert.deepEqual(missing, [], `cdm.json is stale — re-run \`cdm i\`. Missing: ${missing}`);
  });

  it("no longer claims NotAnImprovement, which the contract no longer declares", () => {
    // `0xdafa9c74` is `NotAnImprovement()`, and it has history here: it reached a
    // player as raw hex on 2026-08-02 because the ABI carried no error entries at
    // all, which is why this table exists.
    //
    // The contract now records every attested run, so that error is gone and this
    // asserts the removal rather than the presence. It matters because a selector
    // is derived from the name: an app pointed at a *stale* deployment can still
    // receive `0xdafa9c74`, and with no entry to match it against will report
    // "unrecognised revert 0xdafa9c74" — which is the correct outcome. Re-adding
    // the entry to make that message prettier would describe a rule this
    // deployment does not have.
    assert.equal(selector("NotAnImprovement()"), "0xdafa9c74");
    assert.ok(!abiErrors().includes("NotAnImprovement"));
  });
});

describe("revertName", () => {
  it("names the error so a caller can branch on it", () => {
    // Callers branch on this rather than on the sentence, which would break the
    // next time the wording improves.
    assert.equal(
      revertName({ decoded: { errorName: "SessionAlreadyUsed", args: [] } }),
      "SessionAlreadyUsed",
    );
  });

  it("is null when nothing decoded, rather than a guess", () => {
    assert.equal(revertName({ type: "ContractRevertedWithPayload", data: "0xdafa9c74" }), null);
    assert.equal(revertName(null), null);
    assert.equal(revertName("nope"), null);
  });
});

describe("isContractRevert", () => {
  // This decides blame, not wording. `submit.ts` picks between "the leaderboard
  // rejected this attestation" and "the submit could not run", and `board.ts`
  // picks between BoardUnavailable — which makes the panel say "redeploy the
  // contract" — and a plain error. Getting it backwards sends someone to redeploy
  // a contract that is fine.
  it("is true for a revert, however much of it decoded", () => {
    assert.ok(isContractRevert({ type: "ContractRevertedWithPayload", data: "0x0f2b0e4b" }));
    assert.ok(isContractRevert({ data: "0xdafa9c74" }));
    assert.ok(isContractRevert({ decoded: { errorName: "Expired", args: [] } }));
  });

  it("is false for a dispatch error, which is not the contract refusing", () => {
    assert.ok(!isContractRevert({ type: "AccountNotMapped" }));
    assert.ok(!isContractRevert({ type: "OutOfGas" }));
    assert.ok(!isContractRevert({ type: "Module", value: { index: 60, error: "0x04000000" } }));
  });

  it("is false for shapes it was not given", () => {
    assert.ok(!isContractRevert(null));
    assert.ok(!isContractRevert(undefined));
    assert.ok(!isContractRevert("nope"));
  });
});

describe("revertMessage", () => {
  it("explains a decoded error in the player's terms", () => {
    const message = revertMessage({
      type: "ContractRevertedWithPayload",
      data: "0x0f2b0e4b",
      decoded: { errorName: "SessionAlreadyUsed", args: [] },
    });
    assert.match(message, /already been submitted/);
  });

  it("falls back to the error name when the contract grows one we do not describe", () => {
    assert.equal(revertMessage({ decoded: { errorName: "SomethingNew", args: [] } }), "SomethingNew");
  });

  it("keeps the selector when nothing decodes", () => {
    const message = revertMessage({ type: "ContractRevertedWithPayload", data: "0x12345678" });
    assert.equal(message, "unrecognised revert 0x12345678");
  });

  it("names a dispatch failure instead of printing it as JSON", () => {
    // `QueryResult.value` carries the runtime's raw dispatch error when the call
    // never reaches the contract. Before this branch existed it fell through to
    // `JSON.stringify`, so a player read `{"type":"AccountNotMapped"}`.
    assert.match(revertMessage({ type: "AccountNotMapped" }), /pallet-revive mapping/);
    assert.match(revertMessage({ type: "OutOfGas" }), /ran out of gas/);
    assert.match(revertMessage({ type: "Module", value: { index: 60 } }), /before the contract ran/);
  });

  it("still names a dispatch tag it has no prose for", () => {
    // The point of the branch is that nothing reaches the player as JSON.
    assert.equal(revertMessage({ type: "SomethingNewInRevive" }), "the call failed: SomethingNewInRevive");
  });

  it("survives shapes it was not given", () => {
    // This runs on an already-failed submit. Throwing here would replace a real
    // revert with an unrelated TypeError and lose the actual reason.
    assert.doesNotThrow(() => revertMessage(null));
    assert.doesNotThrow(() => revertMessage(undefined));
    assert.doesNotThrow(() => revertMessage("plain string"));
  });
});
