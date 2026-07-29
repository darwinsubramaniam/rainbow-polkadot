# TEE-verified game leaderboard on Polkadot

Design for an on-chain high-score leaderboard where submitted scores are cryptographically
attested by a replay verifier running inside an Acurast processor's secure enclave.

---

## 1. Problem

A signature proves *who* signed, not *what is true*. If the player signs `score = 999999`,
the signature is valid and the claim is a lie. The leaderboard therefore needs an authority
over score computation that the player does not control.

This design moves that authority into a TEE running a deterministic replay of the player's
own inputs.

---

## 2. Threat model

### Defended

| Attack | Mitigation |
|---|---|
| Player invents a score | Enclave recomputes it from the input log |
| Player grinds favourable seeds | Seed derived inside the TEE, bound to `(player, sessionId)` |
| Player replays an old attestation | `sessionId` consumed on-chain, plus `expiry` |
| Attestation reused on another chain or redeploy | EIP-712 domain binds `chainId` + contract address |
| Player submits someone else's attestation | Payload binds `msg.sender` |
| Operator silently changes game rules | Rules pinned to the deployed, attested job |
| Single faulty or compromised device | Optional k-of-n processor quorum |

### Not defended

- **Bots, macros, TAS-quality play.** A perfectly executed input log is a valid input log.
  Behavioural heuristics can be added inside the enclave (sub-human reaction intervals,
  repeated frame-perfect chains) but this is detection, not proof, and it is an arms race.
- **Hardware attacks on the TEE.** Trust is inherited from the chip vendor's attestation root.
- **Operator device selection.** If the allowlist contains only your own fleet, players still
  trust your hardware choice. Using the public processor market removes this.

### Explicitly not a threat

**Cherry-picking is fine.** The player choosing which runs to submit is harmless for a
"highest score" board — a withheld run is indistinguishable from a run that never happened.
This would *not* hold for win rates, ELO, or tournament records, where the denominator matters.
Those need enclave-submitted results instead of player-relayed ones.

---

## 3. Components

| Component | Implementation | Trust |
|---|---|---|
| `sim` crate | Rust, compiled to a single WASM module | Source of truth for game rules |
| Game client | Browser (wasm) or native (wasmtime) | Fully untrusted |
| Verifier | Acurast deployment wrapping the same WASM | Trusted via hardware attestation |
| Leaderboard | Solidity on Asset Hub (pallet-revive / PolkaVM) | Trustless |

**One simulation, not two.** The client and the enclave run the *same compiled artifact*.
Two hand-written implementations will drift on rounding or iteration order and produce false
cheat flags on honest players.

> Note: ink! has been unmaintained since January 2026. Contracts on Polkadot now target
> Asset Hub via `pallet-revive`, running Solidity compiled to PolkaVM bytecode with `resolc`.

---

## 4. Protocol

```
1. Session start   client ──► enclave    request(playerAddr)
                   enclave ──► client    sessionId, seed

2. Play            client                offline, records inputLog

3. Claim           client ──► enclave    sessionId, inputLog, claimedScore

4. Verify          enclave               re-derive seed, replay, compare

5. Attest          enclave ──► client    EIP-712 signature

6. Submit          client ──► contract   score, sessionId, expiry, sig
```

Play is entirely offline. Cost scales with *claims*, not playtime.

### Seed derivation

```
seed = HMAC-SHA256(rootKey, playerAddr ‖ sessionId)[0..8]
```

`rootKey` is generated inside the TEE and never leaves it. Derivation is stateless — the
deployment needs no database and can be ephemeral.

---

## 5. Attestation payload

EIP-712 typed data. The domain separator supplies `chainId` and `verifyingContract` for free.

```solidity
Score(
    address player,
    uint64  gameId,
    uint64  score,
    bytes32 sessionId,
    uint64  expiry
)
```

---

## 6. Enclave rules

The verifier must trust **nothing** from the client except the input log itself.

```
DERIVED INSIDE      seed, sessionId binding, rules version
ACCEPTED FROM CLIENT inputLog, claimedScore (compared, never used)
REJECTED             any client-supplied seed, starting state, or rules version
```

If the client can supply the seed or the starting state, it picks a trivially easy
configuration and the whole scheme is theatre.

Verification steps:

1. Re-derive `seed` from `(playerAddr, sessionId)`.
2. Reject if `inputLog.len() > MAX_TICKS`.
3. Reject malformed logs (non-monotonic ticks, out-of-range button masks).
4. `state = sim::init(seed)`, then `sim::step` for each entry.
5. Reject unless `sim::score(state) == claimedScore`.
6. Optionally apply plausibility heuristics.
7. Sign the EIP-712 payload with `expiry = now + ATTESTATION_TTL`.

---

## 7. Contract

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract Leaderboard is EIP712, Ownable {
    bytes32 private constant SCORE_TYPEHASH = keccak256(
        "Score(address player,uint64 gameId,uint64 score,bytes32 sessionId,uint64 expiry)"
    );

    mapping(address => uint64) public best;
    mapping(bytes32 => bool)   public usedSession;
    mapping(address => bool)   public isVerifier;

    event NewBest(address indexed player, uint64 score, bytes32 sessionId);

    constructor(address initialVerifier)
        EIP712("Leaderboard", "1")
        Ownable(msg.sender)
    {
        isVerifier[initialVerifier] = true;
    }

    function submit(
        uint64  gameId,
        uint64  score,
        bytes32 sessionId,
        uint64  expiry,
        bytes calldata sig
    ) external {
        require(block.timestamp <= expiry,      "expired");
        require(!usedSession[sessionId],        "session used");
        require(score > best[msg.sender],       "not a new best");

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(
                SCORE_TYPEHASH, msg.sender, gameId, score, sessionId, expiry
            ))
        );

        require(isVerifier[ECDSA.recover(digest, sig)], "bad attestation");

        usedSession[sessionId] = true;
        best[msg.sender] = score;
        emit NewBest(msg.sender, score, sessionId);
    }

    function setVerifier(address v, bool ok) external onlyOwner {
        isVerifier[v] = ok;
    }
}
```

Notes:

- Use OpenZeppelin `ECDSA`, never raw `ecrecover` — the precompile at `0x01` returns a garbage
  address rather than reverting on an invalid signature, and raw ECDSA is malleable, which
  breaks naive replay checks.
- `msg.sender` inside the digest binds the attestation to the submitting account.
- `score > best[msg.sender]` enforces cherry-picking on-chain. A lower submission reverts, so
  the player's own judgement about what beats their best is never trusted.
- `setVerifier` should be behind a multisig or governance in production. It is the single
  point of compromise.
- Ranking itself is computed off-chain from `NewBest` events. Do not maintain a sorted array
  on-chain — insertion is unbounded gas.

---

## 8. Determinism requirements

The replay guarantee is worth exactly as much as the simulation's determinism.

| Requirement | Rule |
|---|---|
| Timestep | Fixed tick (e.g. 60/s). Never `delta_time`. |
| Arithmetic | Integer or fixed-point (`fixed` crate). No `f32`/`f64`. |
| RNG | `SmallRng::seed_from_u64(seed)`. Never `thread_rng`. |
| Collections | `BTreeMap` / sorted `Vec`. Never `HashMap` iteration. |
| Concurrency | Single-threaded sim. |
| I/O | None. No wall-clock, no filesystem, no network. |

Interface:

```rust
pub fn init(seed: u64) -> State;
pub fn step(state: &mut State, input: Input);
pub fn score(state: &State) -> u64;
```

Pure `sim` crate, no rendering. Render in a separate crate that reads `State`.

### Log format

One entry per input *change*, not per frame — RLE across held buttons.

```
(tick: u32, buttons: u8)
```

A 10-minute run at 60 Hz is ~36,000 ticks, compressing to a few KB. Replay is headless, so
rendering — normally ~99% of a game's CPU cost — is skipped entirely. Simulating 36,000 ticks
of platformer physics takes well under a second on a processor phone.

This is a solved problem in practice: TAS files (`.fm2`, `.bk2`) are exactly this, and they
replay bit-identically across machines and decades.

---

## 9. Cost model

| Cost | Paid by | Scales with |
|---|---|---|
| Gas on `submit` | Player | Claims |
| Acurast execution | Operator (ACU) | Claims |
| Play | Nobody | — |

Rate-limit claims per player. There is no reason for a player to need more than a handful of
verifications per hour, and it caps both spend and heuristic brute-forcing.

---

## 10. Build order

De-risk the hard part first. The Acurast job and the contract are each ~150 lines; the
determinism work is where this quietly fails.

1. **`sim` crate, deterministic.** Prove it: replay the same log on two machines and two
   architectures, assert identical final state hashes. Fuzz with random logs.
2. **WASM build.** Verify the client and a standalone runner agree on the same artifact.
3. **Contract.** Deploy to Asset Hub testnet with a plain EOA as verifier. Test replay,
   expiry, and monotonicity paths.
4. **Acurast job.** Swap the EOA for the deployment's attested address.
5. **Heuristics and quorum.** Only once the base path is solid.

---

## 11. Open decisions

- **Fleet vs public processors.** Own fleet is cheaper and simpler; public market gives players
  a real trust guarantee. Can start with the former and migrate — the contract only needs
  `setVerifier`.
- **Quorum size.** 1-of-1 is fine for a vanity board; k-of-n once there is prize money.
- **Attestation TTL.** Short enough to bound stockpiling, long enough that a player who signs
  and then hits a gas spike does not lose the run. Start at 24h.
- **Per-game vs per-player sessions.** Currently one `sessionId` per run. If sessions become
  expensive, batch several runs into one attestation and submit the max.