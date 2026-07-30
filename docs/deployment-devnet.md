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

## There are two deployment paths, and the simpler one is official

The [Polkadot docs](https://docs.polkadot.com/smart-contracts/dev-environments/foundry/)
describe a completely different workflow to `cdm`: **upstream** Foundry nightly
(`curl -L https://foundry.paradigm.xyz | bash`, `foundryup --version nightly`), plain
`forge build`, then `forge create --rpc-url … --private-key … --broadcast`.

Both were tested against the same chain (`chainId 420420417` — the docs' "Polkadot TestNet"
RPC and the devnet Asset Hub RPC report the identical id).

| | `cdm` | `forge create` |
|---|---|---|
| Deployed at | `0x9cc62a70…` | `0x5029d587…` |
| Toolchain | **foundry-polkadot** (`--resolc`) | **upstream Foundry** |
| Bytecode | PolkaVM, 37 KB | EVM, 4.5 KB |
| Owner | mapped Substrate H160 | your ECDSA account |
| Owner calls | `revive.call` + papi (`scripts/revive-call.mjs`) | plain **`cast send`** ✓ |
| CDM registry | **yes** — resolve by name | no |

`pallet-revive` accepts **both** EVM and PolkaVM bytecode, which is why the upstream path
works at all.

> **Correcting an earlier claim.** Installing foundry-polkadot is required **for `cdm`**,
> because `cdm` shells out to `forge build --resolc`. It is *not* required to deploy to this
> chain. Anything above that reads as "you need the fork to deploy" is too strong — you need
> it to use `cdm`.

**Which to use.** Rainbow stays on `cdm`, because the CDM registry gives name-based contract
resolution that `@parity/product-sdk-contracts` consumes from the Product app — worth the
operational friction. For rapid iteration, or any contract the app does not resolve by name,
`forge create` is markedly simpler: your own ECDSA key owns it and `cast` does everything.

`0x5029d587…` was deployed purely to settle this comparison and is not part of the system.

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

## Verifier registered (2026-07-30)

The contract no longer fails closed. Acurast deployment `380403`'s key is registered:

| | |
|---|---|
| Verifier | `0xce0d7dfaf3b8d377ced5ba25cb47f26d192e75d2` |
| secp256k1 | `032cd907b739b8c108050efa4132f59a2c40241db1aef1a1dd3f3b861321e418e9` |
| Serving at | `https://rainbow-verifier.dw3labs.work` |
| Registered in | block `#11590096` |

The address was read from the **on-chain assignment** before the job ran, not from the
enclave's own claim, and the public hostname was then confirmed to serve that same key —
so the entry is derivable from chain state rather than trusted (see
[E0.3/E0.4](E0.3-E0.4-acurast.md)).

The address tracks the **verifier bundle**, not the deployment: redeploying identical bytes
returns the same key and needs no transaction, while any edit to `start.sh` or `lib/*.sh`
rotates it and requires a fresh `setVerifier`. Job 380404 redeployed 380403's bundle
unchanged and reused `0xce0d7dfa…` exactly (see [E0.3/E0.4](E0.3-E0.4-acurast.md)). Add
without removing, so an in-flight attestation from a previous job is not invalidated
mid-round.

Read the key from the assignment rather than assuming either way — `acurast deployments <id>`
prints it, and comparing costs nothing next to a silently-rejected attestation.

```bash
node scripts/revive-call.mjs --to $CONTRACT \
  --data "$(cast calldata 'setVerifier(address,bool)' $ENCLAVE_ADDR true)" --dry-run
```

Dry-run first — it catches an owner mismatch or a reverting call for free, before spending
the fee (this one estimated 83705808 plancks).
