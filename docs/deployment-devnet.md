# Deployment — Polkadot Products Devnet

**Live** (2026-08-05). Deployed with `cdm`, verified on-chain.

> **Redeployed 2026-08-05** for the daily board and the removal of the improvement check.
> The previous contract was `0x891548f5268FA27B68553eb4841f9246b38A16fA`; scores standing
> on it are not migrated and are not reachable from the app.
>
> Verified by reading `currentDay()` through `ReviveApi.call` on both addresses — `20670`
> on the new one, empty on the old, which is how you tell the bytecode apart.
>
> **`cdm deploy` is not idempotent — it instantiates every time.** The first run
> (`0xc4fac51758e92afe165409682b851fa9fa8178d0`) deployed and registered cleanly, then timed
> out after 300s publishing the CDM package metadata to Bulletin. Re-running to retry the
> publish deployed a *second* instance at the address above and published the metadata; it
> did not repair the first. There is no metadata-only mode.
>
> So `0xc4fac517…` is an **orphan**: same bytecode, `registerGame(2, …)` applied, owner
> correct, no metadata, and nothing points at it. It is harmless — no verifier is registered
> on it, so it can never accept a score — but do not confuse the two when reading blocks
> from 2026-08-05. If a future retry is needed, expect a third address and budget the
> `registerGame` and `setVerifier` calls that follow it.
>
> **Toolchain note.** `cdm build` shells out to `forge --resolc`, which upstream Foundry
> does not have. `~/.foundry/bin` shadows `~/.foundry-polkadot/bin` on this machine, so
> `cdm` fails with `unexpected argument '--resolc'` until you prefix the call:
> `PATH="$HOME/.foundry-polkadot/bin:$PATH" cdm deploy -n devnet`.

| | |
|---|---|
| Contract | **`0xb359526f0ffa243678e7bed762c6fc96e45c9915`** |
| CDM package | `@dw3labs/rainbow-leaderboard` |
| Chain | Paseo Asset Hub, EVM chain id **420420417** |
| Owner | `0x50AFf5a51BE03d5914D9b5A42c548Dc35A73f7D8` (mapped from `5GmrGRR2…`) |
| Compiler | Resolc v1.4.0 + Solc v0.8.28 → 55.3 KB PolkaVM |
| Metadata | `bafk2bzaced2n7a3tspv6jmznxmfgmlkktj42z4o6x2265vjcqzpzmsoanvx36` |
| `epochSeconds` | 3600 |
| `maxSessionsPerEpoch` | 12 |
| Game **2** `rulesHash` | `0x02bdb80f1e5195422ac6204060295b6733e2fc1cef196fc49af654f970bd049b` (registered in `#11832873`) |
| Verifier | `0xb956b535a026e14469bba04103de209b4985a727` (job 380426, registered in `#11833581`) |

`rulesHash` is `keccak256(sim.wasm)` over the current 33,599-byte artifact
(`sha256 134633be…`). The rules *are* that artifact, so the board is pinned to a simulation
anyone can hash and check.

**The board is game 2, not game 1.** The live verifier's `/identity` reports `gameId: 2` with
that rulesHash, and it is the verifier that decides what a landed score means. Game 1 was the
22,820-byte artifact from [E0.2](E0.2-determinism.md) (`0x229be8b7…`) and is deliberately
**not** registered here — no deployed verifier serves that ruleset, so registering it would
advertise a board nobody can play. `app/src/chain/network.ts` therefore defaults
`GAME_ID` to 2.

## The verifier redeploy — done, and the key rotated as expected

**Job 380426**, canary, processor `5CHmRH4ceUVcjqNG3vkkDLk3NoLfkKMdyyqLKVVMzRbR5rdq`,
bundle `ipfs://QmRP4dSQR9FUHsWaGsGRgtGaPtqPRWw4qvLyBBTv9LVp3m`. It reports
`contract: 0xb359526f…`, `gameId: 2`, `rulesHash: 0x02bdb80f…`, and signs as
`0xb956b535a026e14469bba04103de209b4985a727` — registered with `setVerifier` in `#11833581`
and read back as `isVerifier == 1`.

The previous key `0x5332edf5…` is deliberately **not** registered: it serves the old
`rainbow-seed-v1` per-player levels and was bound to `0x891548f5…`.

### Three things that cost time, recorded so they do not twice

**`maxCostPerExecution` must clear the processor's live price, and the failure names neither.**
Registration was rejected twice with `acurastMarketplace.InsufficientRewardInMatch` — "Match
is invalid due to insufficient reward regarding the current source pricing" — at
`32003610000` and again at `64000000000`. It went through at `160000000000`, the value in
git. The error reports no price and no shortfall, so the only method is to raise and retry;
start from the committed value rather than bisecting upward. A cap is a ceiling, not a
charge.

**`acurast deployments ls` is down on every network.** `-n canary` returns `fetch failed`,
`-n mainnet` returns an HTML error page parsed as JSON, `-n devnet` throws. So the documented
"read the key off the assignment" step was unavailable, and the signing key was taken from
the job's own `GET /identity` instead. That is weaker — it trusts the endpoint rather than
verifying against chain state — so re-check it against the assignment when the CLI recovers.

**Boot takes ~5 minutes.** The tunnel returned Cloudflare 1033 / HTTP 530 for 280s after
`acurast deploy` reported success, then came up. Do not read an early 530 as a failed deploy.

### The seed change, verified against the live job

Two different addresses asking for the same `(epoch, k)` now receive the **same** seed, while
`sessionId` still differs per player — so levels are shared and slot accounting is not:

```
k=0  player 0x1111…  seed 4289041773203437748   sessionId 0x49274def…
k=0  player 0x2222…  seed 4289041773203437748   sessionId 0x55ae8f19…
k=3  player 0x1111…  seed 11682649945149339120  sessionId 0x67e03020…
k=3  player 0x2222…  seed 11682649945149339120  sessionId 0x3dad64ac…
```

### Previously: the reasoning for the rotation

Two things changed at once, and only the first is the usual repointing:

1. `CONTRACT` moved to `0xc4fac517…` in `acurast-verifier/.env`. On its own this is an
   environment variable, not a bundle file, so it would not rotate the signing key.
2. **`app/verifier.mjs` itself changed** — `deriveSeed` now keys on `(epoch, k)` instead of
   `sessionId`, with the domain prefix bumped to `rainbow-seed-v2`. Any edit under `app/`
   changes the bundle, and the key tracks the bundle. So the redeployed job **will** publish
   a new `secp256k1` key and needs a fresh `setVerifier`.

The last live job on the old contract signed as `0x5332edf5782cb29ee9b37a288ebe25c0cb13c86d`
(public key `0285cc57…`, read from `/identity`). That address is *not* registered on the new
contract and should not be — it serves the old `rainbow-seed-v1` levels.

```bash
acurast deploy                       # canary; app/ changed, so expect a new key
acurast deployments <id> -n canary   # read the published SECP256k1 key off the assignment
# derive its H160, then, as owner:
node scripts/revive-call.mjs --to 0xb359526f0ffa243678e7bed762c6fc96e45c9915 \
  --data $(cast calldata "setVerifier(address,bool)" 0xNEWKEY true)
```

Confirm afterwards that `/identity` reports `contract: 0xc4fac517…` and `gameId: 2`, and that
`isVerifier(0xNEWKEY)` reads true — a mismatch on either is a silent `BadAttestation` at the
end of somebody's run.

### Previously (job 380406, old contract)

The EIP-712 domain names `verifyingContract`, so an attestation is bound to the address the
*enclave* was configured with — and the job is still configured with the previous one. Read
from both live contracts, the same claim hashes:

```
scoreDigest(claim) on 0x891548f5…  → 0x10e24cc4c513192d99693b950c8d47ac0390170ea9d048fb275e8236093c55e5
scoreDigest(claim) on 0x9cc62a70…  → 0x477d099a56d03403e88f1405f295d7491347e745b3c3704ed9e369525f571fbc
```

A signature over the second is refused by the first as `BadAttestation`. Until the job moved,
the app could play and attest but every submit reverted.

**Job 380406** (2026-07-30, canary) carries `CONTRACT=0x891548f5…` and reports it on
`/identity`. Its bundle is byte-identical to 380405's (`ipfs://QmaKwfk9y…`), and the key was
**preserved** — the on-chain assignment publishes `SECP256k1 0x032cd907…`, which derives to
`0xce0d7dfa…`, already registered above. So no `setVerifier` was needed, which is the
practical confirmation that `CONTRACT` being an env var rather than a bundle file keeps the key
stable. Keep `app/` byte-identical if you want that to stay true: any edit under it — even a
comment — rotates the key and costs a fresh `setVerifier`.

`CONTRACT` is an Acurast **environment variable** (see the env list in
`acurast-verifier/acurast.json`), not a file in the signed bundle, so changing it should
not rotate the signing key — the key tracks the bundle. Read it back from the new assignment
anyway rather than assuming, exactly as [E0.3/E0.4](E0.3-E0.4-acurast.md) argues:

```bash
# acurast-verifier/.env
CONTRACT=0x891548f5268FA27B68553eb4841f9246b38A16fA

acurast deploy                       # then read the key off the new assignment
acurast deployments <id> -n canary   # if it is no longer 0xce0d7dfa…, setVerifier the new one
```

> **`-n canary`.** The CLI defaults to `mainnet` and this project is on `canary`
> (`acurast.json`), so the default silently queries the wrong network — `deployments list`
> comes back "Database query exceeded timeout" or "fetch failed" rather than saying so.

### Wait for the old job to end before deploying the repointed one

`assert_sole_connector` in `app/lib/tunnel.sh` cannot catch this particular collision, and
that is worth knowing before relying on it. It compares the *signing key* at the public
hostname against the local one — but the key tracks the bundle, so a repointed redeploy of
identical bytes has **the same key**. Two overlapping jobs would pass the check while signing
for two different `verifyingContract` domains, and Cloudflare would round-robin between them:
roughly half of all submissions reverting `BadAttestation`, with nothing in either log to say
why. Closing it properly means comparing `/identity`'s `contract` and `gameId` too, which
costs a key rotation to ship (any edit under `app/` changes the bundle).

Until then the rule is operational, and it is what was done here: these are `onetime` jobs
with a one-hour `maxExecutionTimeInMs` and `restartPolicy: no`, so let the previous one end —
the tunnel starts answering **530** when no connector is left — and only then deploy.

### The previous deployment

`0x9cc62a70E0d2ed75432C3d9c1F997a122eE976a0` is not migrated and not deleted. It still holds
`best(1, 0x…00A1) = 12345` from the original bring-up and `best(2, 0x…00A1) = 255` from the
first real Polkadot Desktop submission. Scores do not move: a new address is a new EIP-712
domain, so the two boards are separate by construction. The new board starts empty.

## Verified on-chain, not just in tests

Unit tests run on the EVM under `solc`. Production runs **PolkaVM under `resolc`**, which is a
different backend, so anything that depends on it gets re-proven against the live deployment
rather than trusted from the test suite.

Read back from `0x891548f5…` after setup:

```
owner()             → 0x50AFf5a5…                       ✓ mapped from 5GmrGRR2…
epochSeconds()      → 3600      maxSessionsPerEpoch()   → 12
before setup:       → UnknownGame / no verifier         ✓ fails closed
registerGame(2, …)  → gameRules(2) == 0x02bdb80f…       ✓ block #11595644
setVerifier(ce0d…)  → isVerifier == true                ✓ block #11595667
playerCount(2)      → 0                                 ✓ the view EXISTS (it reverts on 0x9cc62a70…)
board(2, 0, 10)     → two empty arrays                  ✓ well-formed ABI encoding
scoreDigest(claim)  → 0x10e24cc4…                       ✓ differs from the old deployment's
```

`playerCount` and `board` returning rather than reverting is the whole point of this redeploy:
under `resolc` the empty-array encoding is what the app decodes, and it decodes.

Both dry-runs before the owner calls estimated 83,755,808 plancks and matched what executed.

### A score landed, and the board shows it (block #11596233)

Run end-to-end against the repointed verifier (job 380406) with
`scripts/attest-and-submit.mjs`:

```
enclave secp256k1  032cd907…  → address 0xce0d7dfa…      ✓ matches the on-chain assignment
enclave rulesHash  0x02bdb80f…                            ✓ matches gameRules(2)
attestation        score 25 over 36000 ticks, epoch 495945, k 0
                   — computed BY the enclave; no score was ever sent to it
signature          64 bytes r‖s, recovered v = 28         ✓ E0.3 reconstruction still holds
submit             ok, block #11596233, fee est. 99,755,808
best(2, 0x…00A1)   25                                     ✓ MATCHES the attested score
```

and the enumeration this redeploy exists for:

```
playerCount(2)   → 1
board(2, 0, 10)  → ([0x…00A1], [25])
```

The app's own read path was then checked against those exact return bytes — decoded with the
ABI entry from `app/src/chain/leaderboard.ts` through the same `decodeFunctionResult` the SDK
calls, then the SDK's multi-output normalisation, then `rank()`:

```
raw 386 chars → { players: ["0x…00A1"], scores: [25n] } → #1 0x…00A1 25
rankOf(ranked, "0x…00a1") → 0
```

Two things that would each have been a silent wrong answer: the **named** ABI outputs are what
make it `{players, scores}` rather than `{_0, _1}`, and the contract returns a **checksummed**
address while the app derives a lowercase one from `ss58ToH160` — so the player's own row is
matched case-insensitively or it never highlights.

The submission was relayed — sent by the Substrate account, credited to `0x…00A1` — so gasless
relaying is re-proven on this address too.

### And the published app reads it (CID `bafybeigw5zxqde…`)

> **Historical.** This run published to `dw3labsgame.dot`, which is the name the Product held
> at the time. It has since moved to `rainbow-dev.dot` — see the live reference in the
> [developer guide](DEVELOPER-GUIDE.md). The record below is left as it happened; changing the
> name in it would make a dated, block-numbered result describe a deploy that never occurred.

Published with `pad ./dist dw3labsgame.dot --env devnet`, finalised at block **11596472**,
`contenthash` verified on-chain and P2P retrieval confirmed in 266 ms. Then opened in a real
browser — the only way, since the gateway serves a resolver shell that makes both `/` and
`/sim.wasm` return the same HTML, and headless Chrome cannot run the smoldot light client that
resolves it:

```
iframe → dw3labsgame.app.dev-dot.li/?cid=bafybeigw5zxqde…&network=devnet   ✓ CID matches
Top 10  ·  2 players · 0s ago
  1  0xE2a7…5F2c   4050
  2  0x0000…00A1     25
```

This is the piece the CLI run could not prove: the panel's host path — `getRawClient` →
`createContractFromClient` → `.query()` → paging → `rank()` — working inside a published
Product against live chain state. Note row 1: it is **second** in the contract's roster order
and first on screen, which is the unsorted-on-chain/ranked-in-client split doing its job.

Pre-publish checks, run against `dist/` rather than trusted (the whole build is inspectable):

```
bundle           3.81 MB of the 20 MB authorization
sim.wasm         33,599 bytes, keccak256 0x02bdb80f… == gameRules(2)
new contract     0x891548f5… present · OLD 0x9cc62a70… absent (0 occurrences)
GAME_ID          inlined as 2
verifier URL     rainbow-verifier.dw3labs.work baked in
trycloudflare    1 occurrence — the migration's own endsWith test
dev-only code    mock enclave and DevProvider tree-shaken
```

### On the previous deployment (2026-07-29)

The original bring-up proved the same seam there, including the parts not re-run above:

```
submit                 → best(1, player) = 12345, session consumed    ✓
replay same session    → reverts 0x36177dda == SessionAlreadyUsed()   ✓
setVerifier(false)     → temp key removed; score survives             ✓
```

That submission used a throwaway signing key, registered only to exercise the path and removed
immediately afterwards. It was also relayed — sent by the Substrate account, credited to
`0x…00A1` — so gasless relaying works on the real chain.

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

## Why the board needed a redeploy (2026-07-30)

The contract carries the enumeration a leaderboard needs — a per-game roster appended on a
player's first accepted score, plus `playerCount(gameId)` and `board(gameId, offset, limit)`.
`0x9cc62a70…` predates all three and reverts on them, which is what forced the new address at
the top of this file.

A redeploy is never just `cdm deploy`. The sequence that was actually run:

```bash
export PATH="$HOME/.foundry-polkadot/bin:$PATH"
cdm build -n devnet && cdm deploy -n devnet          # → 0x891548f5…
A=0x891548f5268FA27B68553eb4841f9246b38A16fA
R=0x02bdb80f1e5195422ac6204060295b6733e2fc1cef196fc49af654f970bd049b   # keccak256(sim.wasm)

node scripts/revive-call.mjs --to $A --data "$(cast calldata 'registerGame(uint64,bytes32)' 2 $R)" --dry-run
node scripts/revive-call.mjs --to $A --data "$(cast calldata 'registerGame(uint64,bytes32)' 2 $R)"
node scripts/revive-call.mjs --to $A --data "$(cast calldata 'setVerifier(address,bool)' 0xce0d7dfaf3b8d377ced5ba25cb47f26d192e75d2 true)"
```

then `DEPLOYED.devnet` and `GAME_ID` in `app/src/chain/network.ts` (or `VITE_CONTRACT` /
`VITE_GAME_ID` at build time), and — still outstanding — the job's `CONTRACT` env.

Note the `gameId` is **2**, taken from the verifier's `/identity` rather than from this file's
previous "Game 1" row, which had gone stale against the deployed enclave. Ask the thing that
signs, not the doc.

### Why the roster exists at all, given `ScoreRecorded`

The original design said clients rank off-chain from `NewBest` (now `ScoreRecorded`) logs, and the contract still
emits them. **They are unreadable from any Ethereum-shaped client on this chain.** Measured
against `https://paseo-assethub-rpc.laissez-faire.trade`:

```
eth_call    gameRules(1)                      → 0x229be8b7…  ✓ correct
eth_getLogs address=0x9cc62a70, fromBlock=0x0 → []
eth_getBlockByNumber 11590096                 → transactions: []
```

Block `#11590096` is where `setVerifier` landed, so that block demonstrably contains a
contract call — the ETH-RPC view simply does not surface Substrate `Revive.call` extrinsics
as transactions, and therefore emits no logs for them. No indexer covers the chain either
(`blockscout-passet-hub…` does not resolve, `assethub-paseo.subscan.io/api` 404s).

So enumeration had to be storage. It costs one SSTORE per player, once, and keeps the
unbounded part — the ordering — off-chain, which is what `board`'s `offset`/`limit` is for.

A personal *top ten* is a different matter: the contract stores one score per player by
design, so the app keeps its own list of the runs it attested (`app/src/chain/history.ts`)
and labels that panel as this-device memory. The scores in it are still enclave-signed; only
the list is local.

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
