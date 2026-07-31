> [!WARNING]
> This is a prototype, reference implementation, and proof-of-concept. This open source code is provided for research, experimentation, and developer education only. It has not been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete features. The app is a self-custodial wallet that can hold real assets — use at your own risk.

<div align="center">

# Rainbow Polkadot

*A proof of concept for building a platform game on Polkadot, where the player submits
a proof of their score to the leaderboard trustlessly.*

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
| `sim` — deterministic platformer | 50 tests; identical across native / wasmi / V8 |
| `Leaderboard` contract | deployed `0x9cc62a70…`, 34 tests |
| Acurast verifier enclave | deployed, attesting |
| End-to-end | verified on-chain, with negative tests |
| The game itself | run, jump, stomp, collect. Basic shapes; playable in a browser. |

## Play it

Published as a Polkadot Product: **[dw3labsgame.dev-dot.li](https://dw3labsgame.dev-dot.li)**,
or `dw3labsgame.dot` inside the Polkadot app.

Or run it locally:

```bash
cargo build -p sim-wasm --release --target wasm32-unknown-unknown
cd app && npm install && npm run dev      # http://localhost:5173
```

Arrows to move, space to jump — *hold* it, a tap is a deliberately shorter hop.
Press **New session** to have the enclave issue a seed, play the run, then
**Attest & submit**. The page shows the score your browser computed next to the
score the enclave independently recomputed from your keypresses alone. They
should be identical — that is the whole point of the thing.

Outside the Polkadot app there is no host to lend a signer, so the game and the
attestation work but the on-chain submit does not. `web/index.html` is a
dependency-free version of the same client, kept as a reference for the wasm
protocol and served by `scripts/serve-game.mjs`.

The level is *generated from the seed*, and the seed is derived inside the
enclave's secure element, so you cannot see a level before you are given it, nor
shop for an easy one: `maxSessionsPerEpoch` caps you at twelve per hour.

### Documentation

| | |
|---|---|
| [DEVELOPER-GUIDE](docs/DEVELOPER-GUIDE.md) | **read this first** |
| [end-to-end](docs/end-to-end.md) | the working run and what it proves |
| [host API conformance](docs/host-api-conformance.md) | every chain call, and the host call it makes |
| [deployment-devnet](docs/deployment-devnet.md) | deploying, `cdm` vs `forge create` |
| [E0.2 determinism](docs/E0.2-determinism.md) | why replay is bit-identical |
| [E0.1 product sandbox](docs/E0.1-product-sandbox.md) | what a Product may do |
| [E0.3 / E0.4 Acurast](docs/E0.3-E0.4-acurast.md) | `signer_sign` semantics, tunnel |
| [Goal.md](Goal.md) | the original design |


Game Asset - New Platformer Pack (1.1) Created/distributed by Kenney (www.kenney.nl) https://kenney.nl/assets/new-platformer-pack