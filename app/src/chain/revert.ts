// What the Leaderboard contract says when it says no.
//
// Split out of `leaderboard.ts` and deliberately free of imports: that module
// re-exports from `network.ts`, which pulls three chain descriptor packages, and
// Node's type-stripping test runner would have to load all of it to check a
// string table. This stays a leaf so the failure path can be tested directly.

// The error ABI entries used to be listed here, and listing them by hand was
// the problem: a custom error arrives as four bytes of selector, and without an
// entry to match it against the SDK hands back the raw payload — so a revert the
// contract states precisely reaches the player as `0xdafa9c74`. The table was
// written to fix exactly that and still missed four of the thirteen errors the
// deployed contract declares, because nothing checked it against the artifact.
//
// `cdm.json` now carries all thirteen. What stays here is the part CDM cannot
// generate: what each one *means* to someone who has just finished a run.

/**
 * What each revert means, in the terms the player is actually in.
 *
 * The contract's names are precise and say nothing to someone who has just
 * finished a run, so every one of them is spelled out here.
 *
 * `NotAnImprovement` used to be the entry that mattered most — it was by a wide
 * margin the most common outcome of a submit, and it was not a failure at all.
 * The contract no longer has it: a score that beats nothing is recorded like any
 * other. Nothing in this table now describes a run that was played honestly.
 *
 * Unmapped names fall through to the name itself, which still beats a selector,
 * so a contract that grows an error the app has not caught up with degrades to
 * "the leaderboard rejected this: SomethingNew".
 */
const REASONS: Record<string, string> = {
  SessionAlreadyUsed: "this session has already been submitted — start a new run",
  Expired: "the attestation expired before it reached the chain — play again for a fresh one",
  BadAttestation:
    "the signature did not recover to a registered verifier — this enclave is not (or is no longer) trusted by the contract",
  RulesMismatch: "this build's rules do not match the ones the board registered for this game",
  UnknownGame: "this game is not registered on the leaderboard",
  EpochInFuture:
    "the attestation names an epoch the chain has not reached — check the clock on the verifier",
  SessionIndexOutOfRange: "this session index is past the per-epoch limit the contract allows",
};

/**
 * The contract's own name for a revert, when the SDK managed to decode one.
 *
 * Separate from the sentence because a caller sometimes needs to *branch* on
 * which error it was, not just print it — and matching on prose would break the
 * moment the wording is improved.
 */
export function revertName(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const name = (value as { decoded?: { errorName?: unknown } }).decoded?.errorName;
  return typeof name === "string" ? name : null;
}

/**
 * Failures that are not the contract saying no.
 *
 * `QueryResult.value` carries two different things under one `success: false`,
 * and conflating them misattributes blame. When the contract reverts it is a
 * `ContractRevertInfo` — tagged `ContractRevertedWithPayload`, with the selector
 * and usually a decoded name. When the call never *reaches* the contract's own
 * code, it is the runtime's raw dispatch error instead: the docs name `Module`,
 * `ContractReverted`, `OutOfGas` and `AccountNotMapped` as the usual ones.
 *
 * The distinction matters most where it is easiest to get wrong. `AccountNotMapped`
 * is not the leaderboard refusing an attestation, it is the *sender* not being
 * mapped — a fault in the three host round trips that run before the contract
 * call, which `submit.ts` reports separately for exactly this reason. Reporting
 * it as "the leaderboard rejected this attestation" sends the reader to the one
 * place the bug is not.
 */
const DISPATCH: Record<string, string> = {
  AccountNotMapped:
    "the sending account has no pallet-revive mapping, so the call never ran — this is the sender, not the score",
  OutOfGas: "the call ran out of gas before it finished — the gas limit was too low, not the claim",
  ContractReverted: "the contract reverted without a payload, so there is no reason to read",
  Module: "the runtime rejected the call before the contract ran",
};

/**
 * Did the *contract* refuse, or did the call never get that far?
 *
 * Callers use this to frame the message, not to decide whether to fail. Keyed on
 * the shape the SDK documents for a revert — the tag, or the selector and
 * decoding that only a revert carries — so anything else is a dispatch failure.
 */
export function isContractRevert(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const info = value as { type?: unknown; data?: unknown; decoded?: unknown };
  return (
    info.type === "ContractRevertedWithPayload" ||
    typeof info.data === "string" ||
    (info.decoded !== null && info.decoded !== undefined)
  );
}

/**
 * A failed call, as a sentence.
 *
 * Takes the SDK's `QueryResult.value` — which is `unknown` at the call site,
 * since the contract handle is generic — and narrows it defensively rather than
 * trusting a shape. A submit that has already failed is the worst possible place
 * to throw a second, unrelated error while trying to describe the first.
 */
export function revertMessage(value: unknown): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? String(value);
  const info = value as { type?: unknown; reason?: unknown; data?: unknown };

  const name = revertName(value);
  if (name !== null) return REASONS[name] ?? name;

  // `reason` carries a plain `require` string or a panic. This contract raises
  // neither, but a library underneath it can.
  if (typeof info.reason === "string" && info.reason) return info.reason;

  // Nothing decoded. The selector is the only fact left, and it is enough to
  // identify the error by hand against the contract source.
  if (typeof info.data === "string") return `unrecognised revert ${info.data}`;

  // Not a revert at all — see `DISPATCH`. The tag is named even when it is not
  // one we have prose for, because `{"type":"Whatever"}` printed as JSON is the
  // failure this branch exists to stop.
  if (typeof info.type === "string") return DISPATCH[info.type] ?? `the call failed: ${info.type}`;

  return JSON.stringify(value);
}
