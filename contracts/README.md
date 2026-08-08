# Rainbow leaderboard contract

Solidity, compiled to PolkaVM with `resolc` for Asset Hub via `pallet-revive`.

## Setup

`lib/` is gitignored (902 files / 14 MB). Restore it with the pinned versions:

```bash
forge install OpenZeppelin/openzeppelin-contracts@v5.4.0 --no-git
forge install foundry-rs/forge-std@v1.11.0 --no-git
forge build
forge test
```

## What the contract does

A score is accepted only if a verifier running a deterministic replay inside an Acurast
processor's secure enclave has signed for it. The contract itself checks nothing about the
game — it checks that the attestation is well-formed, fresh, unspent, from a trusted
signer, and an actual improvement.

Ranking is **not** on-chain. Insertion into a sorted array is unbounded gas; clients rank
off-chain from `ScoreRecorded` events.

## The two defects this fixes

**D1 — seed grinding.** `Goal.md` claimed that binding the seed to `(player, sessionId)`
prevented grinding. It did not: the *client* chose when to request a `sessionId`, so it
could sample seeds indefinitely, and the enclave was specified as stateless with "no
database", leaving nowhere to count.

The fix makes a session identifier underivable-by-choice:

```
sessionId = keccak256(player, epoch, k)      epoch = block.timestamp / epochSeconds
                                             k     ∈ [0, maxSessionsPerEpoch)
```

`sessionId` is therefore never transmitted as a claim — it is *derived*, so a malformed
one cannot exist. The contract enforces `k < maxSessionsPerEpoch` and `epoch <= now`,
which caps re-rolls at `maxSessionsPerEpoch` per epoch **on-chain**, where it is auditable,
rather than relying on the enclave to police itself.

The seed itself stays secret: `seed = HMAC(rootKey, player ‖ sessionId)` with `rootKey`
never leaving the TEE. Deriving `sessionId` publicly does not let a player compute seeds
offline and shop for a good one.

**D3 — decorative `gameId` and unpinned rules.** `best` was `mapping(address => uint64)`,
so two games shared one scoreboard while `gameId` sat unused in the payload. And no rules
version was bound, so upgrading the verifier silently mixed scores earned under different
rulesets.

Now `best` is `mapping(gameId => mapping(player => uint64))`, and each game's `rulesHash`
is registered **write-once**. A new ruleset means a new `gameId`, which keeps every board
internally comparable by construction.

## Deliberate deviations from Goal.md §7

- **`msg.sender` is not bound.** Goal.md put `msg.sender` in the digest to stop a third
  party submitting someone else's attestation and being credited. Naming `player`
  explicitly defeats that attack directly, and additionally permits gasless relaying —
  the score always credits `player` regardless of who pays. Tested.
- **`sessionId` is not a signed field.** It is derived from `(player, epoch, k)`, which
  are signed. One less field, and structural validity for free.
- **Custom errors instead of string `require`s.** Cheaper, and each reject path gets a
  distinct selector the tests assert on.

## The enclave seam

E0.3 established by experiment that `signer_sign` signs its 32-byte input **directly** —
no envelope, no pre-hash — so EIP-712 works exactly as designed. But it returns **64 bytes
of `r‖s` with no recovery id**, while `ECDSA.recover` needs 65 bytes with `v ∈ {27,28}`.

The verifier job must therefore reconstruct `v`: try both candidates, keep the one that
recovers to its own known address. `test_enclaveShapedSignature_requiresRecoveryIdReconstruction`
reproduces this end-to-end, including asserting that raw `r‖s` is rejected and that the
wrong recovery id fails. This seam is the easiest place in the system to produce a silent,
permanent failure, so it is tested rather than assumed.

Use `scoreDigest(claim)` as the single source of truth for what to sign — do not
reimplement the encoding on the job side.

## Verifier key management

`isVerifier` is a **set**. An Acurast deployment's signing key is scoped to that
deployment, so every redeploy mints a new address unless `reuseKeysFrom` is used. Add the
new key without removing the old, so attestations already in flight stay valid until they
expire.

The key is independently checkable: Acurast publishes a deployment's public keys on-chain
in the assignment *before the job runs*, so `setVerifier`'s argument can be verified
against Acurast chain state rather than trusted. That check is necessarily off-chain —
this contract lives on Asset Hub and cannot read Acurast.

`setVerifier` remains the single point of compromise. For anything beyond a vanity board,
put ownership behind a multisig or governance.

## Tests

```
forge test              # 34 tests
forge test --gas-report
```

Every reject path is covered: expiry (including the inclusive boundary), replay,
non-improvement (including equal), unknown game, rules mismatch, future epoch, session
index at the cap, non-verifier signer, garbage signature, **malleable (high-s) signature**,
tampered score, swapped player, extended expiry, and cross-deployment replay.

`submit` costs ~85k gas.

> **A note on `vm.expectRevert`.** It attaches to the next *external* call. A helper that
> computes the digest before signing makes one, which silently swallows the expectation
> and leaves the test asserting nothing. Twelve tests failed this way initially. The
> `_expectRevert` helper exists so the ordering cannot be got wrong per-test — prefer it
> over inlining `vm.expectRevert`.
