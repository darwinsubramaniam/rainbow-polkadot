> [!WARNING]
> This is a prototype, reference implementation, and proof-of-concept. This open source code is provided for research, experimentation, and developer education only. It has not been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete features. The app is a self-custodial wallet that can hold real assets — use at your own risk.

<div align="center">

# Rainbow Polkadot

*This is proof of concept how a Platform game can be developed and run in the Polkadot. The overall idea is to allow the player to submit the proof of score trustlessly into the the leaderboard.*

</div>

## Start here

**[docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md)** — the whole system explained, with
diagrams and step-by-step instructions for the contract and the attestation flow.

A wallet signature proves *who signed*, never *what is true*. A player can sign
`score = 999999` and the signature is perfectly valid. So the score is computed inside a
**TEE** on an Acurast processor, which replays the player's own input log against the same
`sim.wasm` the client ran and signs the result with a key that never leaves the secure
element.

### Status

Working end-to-end on the Polkadot Products Devnet: an enclave-computed score, signed in the
secure element, accepted by a PolkaVM contract on Asset Hub.

| Piece | State |
|---|---|
| `sim` — deterministic simulation | 27 tests; identical across native / wasmi / V8 |
| `Leaderboard` contract | deployed `0x9cc62a70…`, 34 tests |
| Acurast verifier enclave | deployed, attesting |
| End-to-end | verified on-chain, with negative tests |
| The game itself | **a strawman** built to exercise determinism, not a designed game |

### Documentation

| | |
|---|---|
| [DEVELOPER-GUIDE](docs/DEVELOPER-GUIDE.md) | **read this first** |
| [end-to-end](docs/end-to-end.md) | the working run and what it proves |
| [deployment-devnet](docs/deployment-devnet.md) | deploying, `cdm` vs `forge create` |
| [E0.2 determinism](docs/E0.2-determinism.md) | why replay is bit-identical |
| [E0.1 product sandbox](docs/E0.1-product-sandbox.md) | what a Product may do |
| [E0.3 / E0.4 Acurast](docs/E0.3-E0.4-acurast.md) | `signer_sign` semantics, tunnel |
| [Goal.md](Goal.md) | the original design |

<div align="center">
