# End-to-end — enclave-attested score on-chain

**Working** (2026-07-29). A score computed inside an Acurast processor's secure enclave,
attested with a key that never leaves it, accepted by a PolkaVM contract on Asset Hub.

```
player ──inputLog──► enclave (Acurast job 380396, Android 1.26.0)
                       │  replays sim.wasm, computes the score itself
                       │  signs EIP-712 with the secure-element key
                       ▼
                     r‖s (64 bytes, no recovery id)
                       │  client reconstructs v
                       ▼
                     Leaderboard 0x9cc62a70… (Paseo Asset Hub, PolkaVM)
```

## The run

```
enclave secp256k1 : 03d0718b2c6879e4cd418458014032d026986924d9031356109800472abe79da7d
enclave address   : 0xafbd70f7501e03008b82eb253c772ccd3016dafd
rulesHash matches on-chain registration ✓
score (computed BY the enclave): 80  over 6721 ticks
signature : 0x3ea73b52…9b677ca0 (64 bytes)
recovered v: 27
best(1, 0x…B2) = 80   MATCHES the attested score ✓
```

Block `0x490caaa5…` #11561213.

## Why each property actually holds

**The score is not claimed, it is computed.** `/attest` takes `{player, epoch, k, inputLog}`
and there is no score field to send. The enclave replays the log against `sim.wasm` and the
score is whatever comes out. Goal.md §6's "claimedScore (compared, never used)" is
implemented more strongly: never even accepted.

**The verifier key is read from chain state, not trusted.** Acurast publishes a
deployment's public keys in the assignment before the job runs, so
`0xafbd70f7…` was obtained from `acurastMarketplace.storedMatches` and registered with
`setVerifier` *before* the enclave ever spoke. `attest-and-submit.mjs` re-checks the
enclave's advertised key against it and aborts on mismatch.

**The rules are pinned to the artifact being executed.** The enclave computes
`rulesHash = keccak256(sim.wasm)` from the file it actually loaded — it is not configured.
It therefore cannot attest for a ruleset it is not running, and the client verifies that
hash equals the one registered on-chain for the game.

**The digest is computed inside.** Signing a digest handed in by the caller would let anyone
get anything signed. The enclave builds the EIP-712 digest itself, and it was verified
byte-identical to the deployed contract's `scoreDigest` before deployment.

**The seed is secret.** `seed = keccak256(signer_sign("rainbow-seed-v1" ‖ sessionId))`.
`signer_sign` is deterministic (RFC 6979, measured in E0.3) and its key never leaves the
secure element, so this is a PRF the player cannot evaluate offline. `sessionId` is public;
the seed it maps to is not — which is what stops seed shopping.

> **Caveat, stated rather than buried:** this reuses the attestation key as a PRF. The
> distinct `"rainbow-seed-v1"` prefix keeps preimages disjoint from any EIP-712 digest, so
> it cannot be coerced into producing an attestation. A separate HD-derived key
> (`signer_sign` supports `derivationPath` on secp256k1) would still be cleaner and is the
> right fix before this carries any value.

## Negative tests, against the live system

| Attempt | Result |
|---|---|
| session slot `k=99` (above the cap) | enclave: `session index out of range` |
| epoch in the future | enclave: `epoch in the future` |
| malformed log (non-monotonic ticks) | enclave: `sim rejected the log (status -2)` |
| replay a consumed session | chain: `0x36177dda` `SessionAlreadyUsed` |
| real signature, different player + inflated score | chain: `0x342bd384` `BadAttestation` |
| honest score below the player's best | chain: `0xdafa9c74` `NotAnImprovement` |

> The tamper test needed care. The first attempt returned `SessionAlreadyUsed`, not
> `BadAttestation` — the cheap structural checks run before signature recovery, so reusing a
> spent session short-circuits before the signature is ever examined. It only tests what it
> claims when aimed at a **fresh** session.

## Board state

| Player | Best | Provenance |
|---|---|---|
| `0x…B2` | 80 | **enclave-attested** — the real thing |
| `0x…A1` | 12345 | test data from the PolkaVM bring-up, signed by a throwaway key since revoked |
| `0x…C3` | 0 | tamper attempt, rejected |

The `0x…A1` entry was valid under the contract's rules when submitted; the key that signed
it is no longer a verifier. On a devnet board that is acceptable, but it is test data and
should not be mistaken for a played score.

## Reproduce

```bash
export PATH="$HOME/.foundry-polkadot/bin:$PATH"

# Exercise the entrypoint locally first — ~40s, and it starts from an image with
# no curl and no node, which is the part that keeps failing on the phone.
cd e2e/acurast-verifier/local-test && ./run.sh --smoke

cd .. && acurast deploy rainbow-verifier   # hostname is fixed; see .env

# register the deployment's key, read from Acurast chain state
node scripts/revive-call.mjs --to $CONTRACT \
  --data "$(cast calldata 'setVerifier(address,bool)' $ENCLAVE_ADDR true)"

node scripts/attest-and-submit.mjs \
  --verifier https://<tunnel> --expect-verifier $ENCLAVE_ADDR --player 0x… --k 0
```

`<tunnel>` is a per-run hostname only while the job falls back to a quick tunnel. Set
`CF_TUNNEL_TOKEN` and `VERIFIER_HOSTNAME` in `e2e/acurast-verifier/.env` and the phone
instead attaches as a connector to a named tunnel you own: the hostname then lives in
Cloudflare rather than in the job, and survives a restart or a reassignment to a different
processor. `.env.example` has the one-time Cloudflare setup. Note that the tunnel must stay
single-connector — Cloudflare round-robins replicas, and a second phone would sign with a
key the client never pinned — so `numberOfReplicas` stays 1 and `start.sh` withdraws at boot
if the public hostname's `/identity` is not its own.

Local iteration without deploying:

```bash
cd e2e/acurast-verifier
docker run --rm -v "$PWD:/w" -w /w -e BRIDGE_SOCKET=acurast-mock … node:22-slim sh -c \
  'node local-test/mock-bridge.mjs & node app/verifier.mjs'
```

The mock returns a deterministic fake signature — enough to validate that the enclave's
`scoreDigest` and `sessionIdFor` match the deployed contract, which is the failure that
would otherwise cost a deploy cycle to find.

## Still open

- **Verifier key rotation.** Keys are per-deployment; every redeploy mints a new address.
  `isVerifier` is a set and additions do not remove, so in-flight attestations survive — but
  nothing prunes revoked keys yet.
- **Seed PRF** should use a derived key rather than the attestation key (above).
- **The game is a strawman.** The simulation is a placeholder built to exercise determinism,
  not a designed game.
- **Bots and Sybil remain undefended**, as Goal.md always said. The input log is published
  nowhere yet either — writing it to Bulletin alongside the score would make every run
  independently re-verifiable and is the single strongest addition available.
