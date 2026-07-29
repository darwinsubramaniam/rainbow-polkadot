# Deployment — Polkadot Products Devnet

**Live** (2026-07-29). Deployed with `cdm`, verified end-to-end on-chain.

| | |
|---|---|
| Contract | **`0x9cc62a70E0d2ed75432C3d9c1F997a122eE976a0`** |
| CDM package | `@dw3labs/rainbow-leaderboard` |
| Chain | Paseo Asset Hub, EVM chain id **420420417** |
| Owner | `0x50AFf5a51BE03d5914D9b5A42c548Dc35A73f7D8` (mapped from `5GmrGRR2…`) |
| Compiler | Resolc v1.4.0 + Solc v0.8.28 → 37.3 KB PolkaVM |
| Metadata | `bafk2bzaceddal7nhqmecnensoi72ky5dkvqt4fd64w6mucgjdvg7njmc2dley` |
| `epochSeconds` | 3600 |
| `maxSessionsPerEpoch` | 12 |
| Game 1 `rulesHash` | `0x229be8b7d3e8a9a5027edfc677153d4d10d0751be59a63ea6cce60f858bd479c` |

`rulesHash` is `keccak256(sim.wasm)` over the exact 22,820-byte artifact from
[E0.2](E0.2-determinism.md) (`sha256 c56a68b3…e0b5`). The rules *are* that artifact, so the
board is pinned to a simulation anyone can hash and check.

## Verified on-chain, not just in tests

Unit tests run on the EVM under `solc`. Production runs **PolkaVM under `resolc`**, which
is a different backend — so EIP-712 domain construction and `ecrecover` were re-proven
against the live deployment:

```
registerGame           → gameRules(1) == keccak256(sim.wasm)          ✓
setVerifier (temp key) → isVerifier == true                           ✓
scoreDigest            → read from the DEPLOYED contract              ✓
submit                 → best(1, player) = 12345, session consumed    ✓
replay same session    → reverts 0x36177dda == SessionAlreadyUsed()   ✓
setVerifier(false)     → temp key removed; score survives             ✓
```

The signing key used for that submission was a throwaway, registered only to exercise the
path and **removed immediately afterwards**. The contract currently has **no verifier**, so
it accepts nothing until a real Acurast deployment key is registered — it fails closed.

The submission was also relayed: sent by the Substrate account, credited to
`0x…00A1`. Gasless relaying works on the real chain.

## Toolchain — three things that are not obvious

### 1. `cdm build` needs foundry-polkadot, not upstream Foundry

`cdm` shells out to `forge build --resolc`, a flag that exists only in
[foundry-polkadot](https://github.com/paritytech/foundry-polkadot). Installing it normally
**overwrites** `~/.foundry/bin/forge`. It honours `FOUNDRY_DIR`, so install it isolated
instead and put it on `PATH` only when building contracts:

```bash
export FOUNDRY_DIR="$HOME/.foundry-polkadot"
mkdir -p "$FOUNDRY_DIR/bin"
curl -sSfL https://raw.githubusercontent.com/paritytech/foundry-polkadot/master/foundryup/foundryup \
  -o "$FOUNDRY_DIR/bin/foundryup-polkadot" && chmod +x "$FOUNDRY_DIR/bin/foundryup-polkadot"
FOUNDRY_DIR="$FOUNDRY_DIR" "$FOUNDRY_DIR/bin/foundryup-polkadot"

# then, only for contract work:
export PATH="$HOME/.foundry-polkadot/bin:$PATH"
cdm build -n devnet && cdm deploy -n devnet
```

Upstream `forge` (1.7.2-nightly) stays intact for the normal test loop.

### 2. `cdm deploy` passes NO constructor arguments

The first deploy attempt died with `Revive.ContractReverted` because the constructor took
`(address, uint64, uint32)` and received nothing — `epochSeconds == 0` hit the config
guard. Without that guard it would have deployed a contract whose `currentEpoch()` divides
by zero forever.

The contract now has a **zero-argument constructor**, with the epoch length and grind cap
as compile-time constants and the verifier/game set afterwards by the owner. That is also
the more honest model: they are rules, and rules belong pinned to the deployment.

### 3. Owner calls cannot go through `cast`

`pallet-revive` gives a Substrate account a **mapped** H160, and there is no ECDSA key
behind it. `cast send --mnemonic` derives an Ethereum BIP44 key and signs as a completely
different address — `OwnableUnauthorizedAccount(0xb35Ff4ba…)`.

Owner calls go through `revive.call` signed by the sr25519 key: `scripts/revive-call.mjs`.

> **That script must use polkadot-api (papi), not @polkadot/api.** Asset Hub Paseo expects
> the newer extrinsic format; `@polkadot/api` builds version 4 and the runtime panics
> decoding it — `wasm 'unreachable' instruction executed` inside
> `TaggedTransactionQueue_validate_transaction`. It reads like a bad contract call, but it
> reproduces on `system.remark`, which is what proves it is the client. `dotns` uses papi
> for exactly this reason.

`Revive.call`'s papi fields also have to be exact — `weight_limit` (not `gas_limit`),
`dest` as a plain hex string (not `Binary`), `data` as `Uint8Array` (not `Binary`).
Anything else yields only `Incompatible runtime entry Tx(Revive.call)`.

## Operating it

```bash
export PATH="$HOME/.foundry-polkadot/bin:$PATH"
A=0x9cc62a70E0d2ed75432C3d9c1F997a122eE976a0

# read (any ETH JSON-RPC client works for views)
cast call $A "best(uint64,address)(uint64)" 1 0xPLAYER \
  --rpc-url https://paseo-assethub-rpc.laissez-faire.trade

# write as owner
node scripts/revive-call.mjs --to $A \
  --data "$(cast calldata 'setVerifier(address,bool)' 0xVERIFIER true)"
```

## Next

Register the Acurast deployment's `secp256k1` address as verifier. It is published on-chain
in the assignment before the job runs (see [E0.3](E0.3-E0.4-acurast.md)), so it can be read
from Acurast chain state rather than taken on trust. Note it is **per deployment** — every
redeploy mints a new address unless `reuseKeysFrom` is used, so add without removing.
