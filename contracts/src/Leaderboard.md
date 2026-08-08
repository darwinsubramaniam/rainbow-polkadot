# Rainbow Leaderboard

`Leaderboard` records TEE-attested high scores for the Rainbow game.

A score is accepted only when a verifier running a deterministic replay inside an Acurast
processor's secure enclave has signed an EIP-712 `Score` payload for it. The contract makes
no claim about the game itself — it checks that the attestation is well-formed, fresh,
unspent, and from a trusted signer.

It does **not** check that the score is an improvement. Every well-formed attestation is
recorded and consumes its session; a weaker run simply leaves the boards holding the better
number. Scoring badly is not a reason to refuse a transaction.

## Submitting

Call `submit(claim, signature)` with a `ScoreClaim` and the enclave's 65-byte signature.
Anyone may relay: the score always credits `claim.player`, who is bound inside the signed
payload, so submission can be gasless.

Use `scoreDigest(claim)` as the single source of truth for what the enclave must sign.
Acurast's `signer_sign` returns 64 bytes of `r‖s` with no recovery id, so the verifier job
must reconstruct `v` (try both, keep the one recovering to its own address) and normalise
it to `{27, 28}` before the signature is usable here.

## Sessions

A session is identified by `sessionIdFor(player, epoch, k)` = `keccak256(player, epoch, k)`,
where `epoch = block.timestamp / epochSeconds` and `k ∈ [0, maxSessionsPerEpoch)`. The
identifier is derived rather than supplied, so a malformed one cannot exist, and the cap on
`k` bounds how many seeds a player can re-roll per epoch. Each session is single-use.

## Games

Each `gameId` is registered once with an immutable `rulesHash` pinning the ruleset its
scores were earned under. Best scores are keyed per game, so boards never mix — a new
ruleset means a new `gameId`.

## Two boards

Every accepted attestation updates both:

- **All-time** — `best(gameId, player)`, enumerated by `playerCount(gameId)` and
  `board(gameId, offset, limit)`. Never reset.
- **Daily** — `dailyBest(gameId, day, player)`, enumerated by
  `dailyPlayerCount(gameId, day)` and `dailyBoard(gameId, day, offset, limit)`.

`day` is `dayOf(claim.epoch)` = `claim.epoch / 24`, since `epochSeconds` is an hour. It
therefore comes out of a field the enclave already signs — the daily board needed no new
claim field, so the EIP-712 typehash, every digest, and the verifier job are unchanged.

Because the day is derived from the epoch a run was *played* in, a run finished just before
midnight lands on that day's board even if the transaction arrives after it. How long a
closed day stays writable is bounded by the verifier's `ATTESTATION_TTL`, not by this
contract.

Nothing is deleted at midnight — this runtime has no timers. Yesterday's board still exists
and is still readable; `currentDay()` is simply a different key. Storage grows by one roster
entry per player per day they play.

## Reading the leaderboard

Nothing sorted is kept on-chain, because insertion into a sorted array is unbounded gas.
Both `board` and `dailyBoard` return players in first-score order with live scores, clamp a
limit that overruns the end, and return empty past it rather than reverting — so a client
pages until it sees a short page, then sorts.

Do not rank from `ScoreRecorded` events: this chain reports `Revive.call` blocks as having
no transactions, so `eth_getLogs` over this address returns empty while `eth_call` answers
correctly. The rosters exist for exactly that reason.
