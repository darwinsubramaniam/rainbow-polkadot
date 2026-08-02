# Research: Rainbow codebase ground truth (collected 2026-07-31)

Condensed from a full repo walk with file:line evidence. This is the factual spine of the
article — every claim here is verifiable in the repo.

## Architecture: four components, three trust zones

| Component | Where it lives | Stack |
|---|---|---|
| Deterministic simulation (`sim.wasm`) | shared artifact, runs in BOTH browser and enclave | Rust → wasm32 (`crates/sim`, `crates/sim-wasm`) |
| Game client / Polkadot Product | browser (Polkadot Desktop webview or dev-dot.li gateway) | React 19 + Vite 8 + Pixi.js (`app/src/`) |
| Verifier enclave | Acurast processor (Android phone, proot Ubuntu, Shell runtime) | Node.js, zero npm deps, 391 lines (`e2e/acurast-verifier/app/verifier.mjs`) |
| Leaderboard contract | Paseo Asset Hub, pallet-revive/PolkaVM, chain id 420420417 | Solidity + OpenZeppelin (`contracts/src/Leaderboard.sol`) |

Canonical diagram: `docs/DEVELOPER-GUIDE.md:28-51`; trust table `:59-68`.

**One simulation, not two.** Browser and enclave execute the same compiled `sim.wasm`
bytes. Client binds the interactive ABI half (`sim_create`/`sim_step_one`); enclave binds
the verification half (`sim_verify`). `app/src/sim/sim.ts:1-11`.

## The proof flow (THE core story)

1. **Client records inputs, not scores.** `LogEntry = [tick, buttons]` — input *changes*
   only (`app/src/game/engine.ts:30,135-144`). 60 Hz fixed tick, MAX_TICKS 36,000 = 10 min.
2. **No score is ever sent.** `/attest` takes `{player, epoch, k, inputLog}` — "no score
   is sent. There is no field for one." (`app/src/chain/enclave.ts:113-125`,
   `verifier.mjs:216`). The enclave computes the score itself by replaying.
3. **Enclave checks then replays**: structural validation → re-derives sessionId + seed
   internally (never accepted from caller) → `sim_verify(seed, log)` replays the whole
   game → builds claim from the replay's own output (`verifier.mjs:216-251`).
4. **rulesHash = keccak256 of the wasm it actually loaded** — "the enclave cannot attest
   for a ruleset it is not running" (`verifier.mjs:112-118`).
5. **Signs one EIP-712 digest** with the deployment's secp256k1 key via the phone's
   signer bridge (abstract Unix socket, `signer_sign`, RFC 6979 deterministic, 64-byte
   r‖s) (`verifier.mjs:32-68,71,182-210`).
6. **The player's own wallet submits** claim + signature to the contract. The untrusted
   party carries the sealed envelope.
7. **Contract verifies**: expiry → session-index range → epoch → known game → rulesHash
   match → session not used → score improvement → `ECDSA.tryRecover(scoreDigest(c), sig)`
   → `isVerifier[signer]` (`Leaderboard.sol:244-281`).

**There is NO Merkle tree and NO hash-chaining in the repo.** The proof method is:
deterministic replay + single ECDSA signature over an EIP-712 digest. Do not overclaim.

Signed struct (byte-identical in verifier.mjs:182-186 and Leaderboard.sol:39-41):
`Score(address player,uint64 gameId,uint64 score,uint64 epoch,uint32 k,bytes32 rulesHash,uint64 expiry)`
`sessionId` deliberately absent — derived from `(player, epoch, k)` on both sides.
`ticks`/`stateHash` returned outside `claim`, NOT covered by the signature.

## Cryptography

- secp256k1 ECDSA, RFC 6979 deterministic nonce (measured: `docs/E0.3-E0.4-acurast.md:27-31`)
- keccak-256 throughout; EIP-712 typed data; domain = name "RainbowLeaderboard", version
  "1", chainId 420420417, verifyingContract → redeploy invalidates all signatures
  (measured, both digests printed: `docs/deployment-devnet.md:31-41`)
- `sessionId = keccak256(abi.encode(player, epoch, k))` — identical in contract
  (`Leaderboard.sol:167-169`), enclave (`verifier.mjs:151-153`), mock (`mock.ts:188-190`)
- seed = PRF over sessionId using the attestation key + RFC 6979 determinism
  (`verifier.mjs:168-176`); honestly documented caveat: reuses attestation key as PRF
- v-byte reconstruction: signer gives 64 bytes; client tries both recovery ids
  (`app/src/chain/leaderboard.ts:117-138`); wrong guess → contract reverts, no hazard
- Game RNG: PCG32; physics 16.16 fixed-point, no floats → cross-engine determinism
- Determinism evidence: native vs wasmi vs V8 compared PER TICK — 512 seeds / 3.37M ticks
  identical (native↔wasmi), 48 vectors / 372k ticks (wasmi↔V8) (`docs/E0.2-determinism.md:30-36`)

## Chain side

- `isVerifier` is a mapping (set), owner-only `setVerifier` — because every Acurast
  redeploy mints a new key (`Leaderboard.sol:100-105,306-309`)
- Live verifier `0xce0d7dfaf3b8d377ced5ba25cb47f26d192e75d2` registered block 11595667;
  key read from **Acurast chain state** (`acurastMarketplace.storedMatches` →
  `assignment.pubKeys.secp256k1`), not from the enclave's own claim
- `ECDSA.tryRecover` not raw ecrecover (malleability + garbage-address footguns)
- Anti-grinding pinned as constants: epoch 1h, max 12 sessions/epoch ("changing the grind
  cap changes what a score means", `Leaderboard.sol:46-65`)
- eth_getLogs is blind to Revive.call extrinsics → roster in storage + paginated `board()`
  view; ranking off-chain (`Leaderboard.sol:82-95,209-228`)

## Acurast deployment facts

- `rainbow-verifier`, Shell runtime, proot Ubuntu aarch64 (sha256-pinned), canary network,
  single processor instantMatch + whitelist, 1 replica, onetime 1h jobs, Immutable
  (`e2e/acurast-verifier/acurast.json`)
- **`onlyAttestedDevices: true`** (`acurast.json:46`) — the deployment requires attested
  devices. (CORRECTED 2026-07-31 by Darwin: an earlier agent pass misreported this as
  false. Note: local CLI records under `.acurast/deploy/*.json` show `false` for jobs
  380396–380406 — treat those as CLI-side records, not the source of truth.)
- Key tracks the bundle: env-var change kept key `0xce0d7dfa…` across jobs 380405→380406;
  one byte under `app/` rotates it (`docs/deployment-devnet.md:43-49`)
- Named Cloudflare tunnel `rainbow-verifier.dw3labs.work` for a stable hostname; the
  single-connector guard (`lib/tunnel.sh:106-154`) withdraws the tunnel if the public
  hostname's key ≠ local key (round-robin would mix signers)
- Transport explicitly generic: "any service that gives it a reachable hostname does the
  job" (`app/src/ui/ProofFlow.tsx:278-306`); Acurast native tunnel now viable
- No device-attestation verification code in repo; the actual anchor is key provenance:
  `scripts/attest-and-submit.mjs:56-68` aborts if enclave key ≠ chain state or rulesHash ≠
  on-chain gameRules

## Polkadot Product facts

- Product = static bundle on Bulletin chain + `.dot` DotNS domain, rendered in sandboxed
  webview/gateway. Holds no keys, opens no sockets; host lends signing and chain RPC.
- Published as `rainbow-dev.dot` / rainbow-dev.dev-dot.li (README.md:39-40) — note: CID
  under the NEW name recorded as not-yet-published at research time
- `.dot` name is an account-derivation input, not a label — changing it derives a
  different product account (`app/src/chain/wallet.ts:29-61`, `network.ts:96-108`)
- Read path needs no wallet (`getRawClient`, no signer); write path adds signer + origin
- Host prerequisites handled in-app: SmartContractAllowance + one-time pallet-revive
  map_account (`submit.ts:134-214`)
- Detection by attempt, not prediction (`SdkGate.tsx:44-62`); 3 tiers: guest (no account,
  in-tab enclave, GUEST = 0x6775657374… "guest" in ASCII) / practice / live (`mode.ts`)
- Build guard greps bundle for wss://, WsProvider, smoldot, dev-signer marker
  (`app/scripts/check-bundle.mjs`)
- Sandbox probe (E0.1): HTTPS egress + WebAssembly allowed; no SharedArrayBuffer

## "The game is not the POC" — repo's own words

- "**The game is a strawman.** The simulation is a placeholder built to exercise
  determinism, not a designed game." (`docs/end-to-end.md:138-139`)
- Goal.md is titled "TEE-verified game leaderboard on Polkadot", opens on the crypto
  problem, not a game concept
- Verifier is game-agnostic except sim.wasm: swap wasm + env vars and the same 391-line
  file verifies a different game
- Enclave is an interface with two implementations (remote Acurast job / in-browser
  simulated) — same sessionId, seed, replay, digest; only the key location differs
- Contract is multi-game by construction (everything keyed by gameId; rulesHash write-once
  per game); published as reusable CDM package `@dw3labs/rainbow-leaderboard`
- Strongest unbuilt extension (DEVELOPER-GUIDE.md:1014-1021): publish input log to
  Bulletin → "the TEE is a fast path over a publicly re-verifiable record"

## Honest-limitations inventory (for the Limitations section)

1. `/session` unauthenticated — seed peeking possible (info leak, not theft)
2. Seed PRF reuses the attestation key (domain-separated, but not a dedicated key)
3. Cloudflare terminates TLS — liveness/censorship dependency (not integrity)
4. `setVerifier` owner is a single EOA — "the single point of compromise"
5. Bots / TAS-quality play / Sybil undefended by design
6. No pruning of revoked verifier keys yet
7. Devnet board mixes test data with the one genuinely enclave-attested score
8. rulesHash brittleness: a comment in `crates/sim` changes the wasm → new rulesHash
9. Hardware attacks on the TEE explicitly out of scope — trust inherited from chip
   vendor's attestation root
