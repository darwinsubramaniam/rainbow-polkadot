# Rainbow Leaderboard

`Leaderboard` records TEE-attested high scores for the Rainbow game.

A score is accepted only when a verifier running a deterministic replay inside an Acurast
processor's secure enclave has signed an EIP-712 `Score` payload for it. The contract makes
no claim about the game itself — it checks that the attestation is well-formed, fresh,
unspent, from a trusted signer, and an actual improvement on the player's own best.

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

## Reading the leaderboard

Ranking is computed off-chain from `NewBest(gameId, player, score, sessionId, epoch)`
events. Nothing sorted is kept on-chain, because insertion into a sorted array is unbounded
gas.

`best(gameId, player)` returns a single player's current best.
