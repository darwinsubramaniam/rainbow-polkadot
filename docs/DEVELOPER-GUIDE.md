# Rainbow — Developer Guide

How to build, deploy and operate a leaderboard where scores are **proven**, not claimed.

Everything here has been run end-to-end against live infrastructure. Where something is
untested or unsolved, it says so.

---

## 1. The problem, in one paragraph

A wallet signature proves **who signed**, never **what is true**. If a player signs
`score = 999999`, the signature is perfectly valid and the claim is a lie. So a leaderboard
needs an authority over score computation that the player does not control.

Rainbow puts that authority inside a **TEE** (Trusted Execution Environment) — a secure
enclave on an Acurast processor, which is a physical Android phone. The enclave re-plays the
player's own keypresses against the exact same game code, works out the score itself, and
signs the result with a key that never leaves the phone's secure element.

The player is never trusted. Only their **input log** is accepted, and even that is replayed
rather than believed.

---

## 2. The shape of the system

```mermaid
graph LR
    subgraph Untrusted["UNTRUSTED — the player controls all of this"]
        C["Game client<br/>browser, runs sim.wasm"]
    end

    subgraph Enclave["TRUSTED via hardware attestation"]
        V["Verifier job<br/>Acurast processor<br/>runs the SAME sim.wasm"]
    end

    subgraph Chain["TRUSTLESS — anyone can check"]
        L["Leaderboard contract<br/>PolkaVM on Asset Hub"]
        A["Acurast chain<br/>publishes the enclave's public key"]
    end

    C -->|"inputLog"| V
    V -->|"EIP-712 signature"| C
    C -->|"submit score + signature"| L
    A -.->|"verifier address read from here"| L

    style Untrusted fill:#3a1f1f,stroke:#b3261e,color:#fff
    style Enclave fill:#1f3a24,stroke:#0a7d33,color:#fff
    style Chain fill:#1f2c3a,stroke:#1565c0,color:#fff
```

**One simulation, not two.** The client and the enclave run the *same compiled
`sim.wasm`*. Two hand-written implementations would drift on rounding or iteration order and
start flagging honest players as cheats.

---

## 3. Who you have to trust

| Component | Trust | Why |
|---|---|---|
| Game client | **none** | Fully attacker-controlled. Assume it is modified. |
| Input log | **none** | Accepted as data, then replayed. Never believed. |
| Verifier enclave | hardware | Key lives in the phone's secure element. Its **public key is published on-chain** before the job runs, so you verify rather than trust the operator. |
| Cloudflare tunnel | **liveness only** | It carries bytes. It cannot forge a signature made inside the secure element — it can only stall or censor. |
| `setVerifier` owner | **full** | The single point of compromise. Put it behind a multisig for anything beyond a demo. |

---

## 4. The end-to-end flow

```mermaid
sequenceDiagram
    autonumber
    participant P as Player (browser)
    participant E as Enclave (Acurast)
    participant L as Leaderboard (Asset Hub)

    Note over P,E: 1. Claim a session and get its seed
    P->>E: POST /session {player, k}
    E->>E: sessionId = keccak256(player, epoch, k)
    E->>E: seed = PRF(sessionId) — derived in the secure element
    E-->>P: {seed, epoch, k, sessionId}

    Note over P: 2. Play offline. No network, no cost.
    P->>P: sim.wasm generates the level FROM the seed
    P->>P: record inputLog = [(tick, buttons), …]

    Note over P,E: 3. Ask for an attestation
    P->>E: POST /attest {player, epoch, k, inputLog}

    Note over E: 4. The enclave trusts nothing but the log
    E->>E: sessionId = keccak256(player, epoch, k)
    E->>E: seed = PRF(sessionId) — secret, in-enclave
    E->>E: replay sim.wasm → score
    E->>E: build EIP-712 digest
    E->>E: sign with secure-element key

    E-->>P: {claim, signature r‖s}

    Note over P: 5. Reconstruct v (signer_sign omits it)
    P->>P: try v=27, v=28 → keep the one that recovers

    P->>L: submit(claim, signature)
    L->>L: checks: expiry, k, epoch, rules, session, improvement, signer
    L-->>P: NewBest event
```

**Playing is free.** Cost is paid per *claim*, not per minute played — a ten-minute run is
~36,000 ticks that compresses to a few kilobytes, because the log records only input
*changes*, not frames.

### Why the seed is handed out at all

The level is *generated from the seed*, so the client cannot draw anything without it —
step 1 is not optional. That is a deliberate trade, and the terms matter:

**Seeds are issued for the current epoch only.** `/attest` and the contract both accept
any epoch `<= current`, because a run played at the end of one epoch may legitimately be
submitted during the next. Issuing *seeds* on those terms would be a different matter: a
player could walk back through every past epoch, harvest twelve seeds from each, sample
them all offline and play only the friendliest one. Restricting issuance to the current
epoch is what holds the cap at `maxSessionsPerEpoch` per hour.

Seeds remain unguessable either way — `deriveSeed` signs inside the secure element, so
knowing one seed says nothing about the next. A player gets the twelve they are entitled
to and must play each to find out what it holds.

> **Known gap.** `/session` is unauthenticated: anyone may request any address's seeds and
> learn which levels that player will face. It consumes nothing (sessions are spent
> on-chain at `submit`, not at issuance) and any resulting score still credits the bound
> player, so it is an information leak rather than a theft. Binding issuance to a wallet
> signature is the obvious hardening and is **not** done here.

---

## 5. What the contract actually checks

Order matters: the cheap structural checks run **before** the expensive signature recovery,
so a malformed submission is rejected cheaply.

```mermaid
flowchart TD
    S["submit(claim, signature)"] --> E1{"past expiry?"}
    E1 -->|yes| X1["Expired"]
    E1 -->|no| E2{"k &lt; maxSessionsPerEpoch?"}
    E2 -->|no| X2["SessionIndexOutOfRange"]
    E2 -->|yes| E3{"epoch &lt;= now?"}
    E3 -->|no| X3["EpochInFuture"]
    E3 -->|yes| E4{"game registered?"}
    E4 -->|no| X4["UnknownGame"]
    E4 -->|yes| E5{"rulesHash matches?"}
    E5 -->|no| X5["RulesMismatch"]
    E5 -->|yes| E6{"session unused?"}
    E6 -->|no| X6["SessionAlreadyUsed"]
    E6 -->|yes| E7{"beats their best?"}
    E7 -->|no| X7["NotAnImprovement"]
    E7 -->|yes| E8{"signer is a verifier?"}
    E8 -->|no| X8["BadAttestation"]
    E8 -->|yes| OK["consume session<br/>store best<br/>emit NewBest"]

    style OK fill:#1f3a24,stroke:#0a7d33,color:#fff
    style X1 fill:#3a1f1f,stroke:#b3261e,color:#fff
    style X8 fill:#3a1f1f,stroke:#b3261e,color:#fff
```

> **Watch this ordering when writing tests.** A tamper test aimed at an already-spent session
> returns `SessionAlreadyUsed` and never reaches the signature check — so it proves nothing.
> Always aim signature tests at a **fresh** session.

### Two design decisions worth understanding

**Anti-grinding (why `epoch` and `k` exist).** A player could otherwise ask for session after
session, sample each seed for a few seconds, throw away the bad ones and only finish the
lucky ones. So a session identifier is **derived, never claimed**:

```
sessionId = keccak256(player, epoch, k)
epoch     = block.timestamp / 3600      (one hour)
k         ∈ [0, 12)                     (12 slots per hour)
```

Because it is derived, a malformed session identifier cannot exist. The contract enforces
`k < 12` and `epoch <= now` **on-chain**, so the re-roll cap is auditable rather than
something the enclave polices on its own honour. The *seed* stays secret inside the enclave,
so a player still cannot compute seeds offline and shop for a good one.

**Rules pinning (why `rulesHash` exists).** Each game registers a `rulesHash` **once**, and
it is `keccak256(sim.wasm)` — the hash of the exact simulation binary. Upgrading the game
means a **new `gameId`**, not a mutated hash. Otherwise scores earned under old rules would
sit on the same board as scores earned under new ones, silently incomparable.

---

## 6. Setup

### 6.1 Toolchain

```bash
node --version      # 22+ required by pad/cdm
rustup target add wasm32-unknown-unknown
npm i -g @acurast/cli @polkadot-community-foundation/cdm-cli
cdm setup           # installs the Rust/PVM toolchain; npm does NOT
```

> **Two Foundry builds, and you may need both.**
>
> - **Upstream Foundry** (`curl -L https://foundry.paradigm.xyz | bash`) — for `forge test`,
>   `cast`, and `forge create`. This is the [official Polkadot docs](https://docs.polkadot.com/smart-contracts/dev-environments/foundry/) path.
> - **foundry-polkadot** — only if you deploy with `cdm`, because `cdm` shells out to
>   `forge build --resolc`, a flag upstream does not have.
>
> Its installer **overwrites** `~/.foundry/bin/forge`. Install it isolated instead:
>
> ```bash
> export FOUNDRY_DIR="$HOME/.foundry-polkadot"
> mkdir -p "$FOUNDRY_DIR/bin"
> curl -sSfL https://raw.githubusercontent.com/paritytech/foundry-polkadot/master/foundryup/foundryup \
>   -o "$FOUNDRY_DIR/bin/foundryup-polkadot" && chmod +x "$FOUNDRY_DIR/bin/foundryup-polkadot"
> FOUNDRY_DIR="$FOUNDRY_DIR" "$FOUNDRY_DIR/bin/foundryup-polkadot"
>
> # then, ONLY for cdm builds:
> export PATH="$HOME/.foundry-polkadot/bin:$PATH"
> ```

### 6.2 Accounts

You need **three** distinct things funded/authorised, and they trip people up because they
are separate:

```mermaid
graph TD
    A["Substrate account<br/>(sr25519, e.g. 5GmrGRR2…)"] -->|"dotns account map"| B["Mapped H160<br/>0x50AFf5a5…"]
    B --> C["owns contracts deployed via cdm"]
    A --> D["PAS from faucet.polkadot.io<br/>(pays fees)"]
    A --> E["Bulletin authorization<br/>(dotns bulletin authorize)"]
    E --> F["lets cdm publish metadata"]

    style C fill:#1f2c3a,stroke:#1565c0,color:#fff
```

> **A mapped H160 has no private key.** It is derived from your Substrate account. So
> `cast send --mnemonic` will *not* work for owner-only calls on a `cdm`-deployed contract —
> cast derives an Ethereum BIP44 key and signs as a completely different address. See §9.

---

## 7. Part 1 — the simulation

The whole guarantee rests on the sim replaying **identically** everywhere. If the browser and
the enclave disagree by one point, an honest player is flagged as a cheat with no error
anywhere.

```bash
cargo test -p sim                                          # 27 tests
cargo build -p sim-wasm --release --target wasm32-unknown-unknown
cargo run  -p replay --release -- compare --seeds 512      # native vs wasmi
cargo run  -p replay --release -- export  --seeds 48
node harness/run-node.mjs                                  # wasmi vs V8
cargo run  -p replay --release -- selftest                 # NEGATIVE CONTROL
```

Rules that make this work, enforced structurally rather than by convention:

| Rule | How it is enforced |
|---|---|
| No I/O, no wall-clock, no `HashMap` | `#![no_std]` — they are unreachable |
| No floating point | fixed-point 16.16 throughout |
| Pinned RNG | PCG32 written **in-tree**, no `rand` dependency |
| No pointer-width-dependent state | no `usize` in `State`, asserted by a test |
| Fixed timestep | `step()` takes no delta — the tick count *is* the clock |

> **Why not `rand::SmallRng`?** It is explicitly not reproducible across versions, and has
> historically picked a different algorithm by pointer width — exactly the wasm32 (32-bit)
> versus aarch64 (64-bit) split this system spans.

> **Always run `selftest`.** A harness that only ever prints PASS looks identical whether it
> is checking carefully or not checking at all. `selftest` injects a known one-bit fault and
> asserts the detector finds it, at the right tick.

---

## 8. Part 2 — the contract

### 8.1 Test

```bash
cd contracts
forge install OpenZeppelin/openzeppelin-contracts@v5.4.0 --no-git
forge install foundry-rs/forge-std@v1.11.0 --no-git
forge test          # 34 tests, every reject path
```

### 8.2 Deploy

```mermaid
graph LR
    S["Leaderboard.sol<br/>+ @custom:cdm annotation"] --> B["cdm build -n devnet<br/>(resolc → PolkaVM)"]
    B --> D["cdm deploy -n devnet"]
    D --> M["metadata → Bulletin"]
    D --> C["contract → Asset Hub"]
    D --> R["package name → CDM registry"]
    C --> G["registerGame(1, rulesHash)"]
    C --> V["setVerifier(enclaveAddr, true)"]

    style C fill:#1f2c3a,stroke:#1565c0,color:#fff
```

The CDM package name comes from a NatSpec annotation on the contract itself:

```solidity
/// @custom:cdm @dw3labs/rainbow-leaderboard
contract Leaderboard is EIP712, Ownable { … }
```

```bash
export PATH="$HOME/.foundry-polkadot/bin:$PATH"
cd contracts
cdm build  -n devnet
cdm deploy -n devnet --bulletin-url wss://bulletin-paseo-02.tservices.es:9443
```

> **`cdm deploy` passes NO constructor arguments.** A contract with a non-empty constructor
> receives nothing and reverts with `Revive.ContractReverted`. Design for a **zero-argument
> constructor** plus owner-only setters — and validate anyway, so a misconfiguration is a
> clean revert instead of a permanently broken contract.

> **Package names are permanent and global.** The registry is append-only. And `cdm` with no
> configured account signs as **Alice, silently** — the name is then hers forever. Check
> `~/.cdm/accounts.json` before your first deploy.

> **Bulletin publish can time out** at 300s. That is usually the endpoint, not your
> authorization — check with `dotns bulletin status <ss58> --env devnet` and retry with a
> different `--bulletin-url`. Note the contract deploys *before* metadata, so a timeout can
> orphan a deployed-but-unregistered contract.

### 8.3 Configure

`rulesHash` is the hash of the simulation binary itself:

```bash
RULES=$(node -e '
  const {keccak_256}=require("@noble/hashes/sha3.js");
  const b=require("fs").readFileSync("target/wasm32-unknown-unknown/release/sim_wasm.wasm");
  console.log("0x"+Buffer.from(keccak_256(b)).toString("hex"))')

node scripts/revive-call.mjs --to $CONTRACT \
  --data "$(cast calldata 'registerGame(uint64,bytes32)' 1 $RULES)"
```

---

## 9. Owner calls — the part that surprises everyone

```mermaid
flowchart TD
    Q["Need an owner-only call<br/>(setVerifier, registerGame)"] --> H{"How was the contract deployed?"}
    H -->|"cdm"| M["Owner = MAPPED H160<br/>no private key exists"]
    H -->|"forge create"| E["Owner = your ECDSA account"]
    M --> P["revive.call extrinsic,<br/>signed sr25519, via papi<br/>scripts/revive-call.mjs"]
    E --> K["plain cast send ✓"]

    style P fill:#3a2f1f,stroke:#8a6100,color:#fff
    style K fill:#1f3a24,stroke:#0a7d33,color:#fff
```

```bash
# reads work with any Ethereum JSON-RPC client
cast call $CONTRACT "best(uint64,address)(uint64)" 1 0xPLAYER \
  --rpc-url https://paseo-assethub-rpc.laissez-faire.trade

# owner writes on a cdm-deployed contract
node scripts/revive-call.mjs --to $CONTRACT \
  --data "$(cast calldata 'setVerifier(address,bool)' 0xVERIFIER true)"
```

> **`@polkadot/api` cannot sign for this chain.** It builds extrinsic version 4; Asset Hub
> Paseo expects newer, and the runtime *panics while decoding* —
> `wasm 'unreachable' instruction executed` inside `TaggedTransactionQueue_validate_transaction`.
> It reads like a bad contract call, but it **reproduces on `system.remark`**, which is what
> proves it is the client. Use **polkadot-api (papi)**, as `dotns` does.

---

## 10. Part 3 — the verifier enclave

The verifier is a small Node job that bundles `sim.wasm` and a vendored keccak256 — 52 KB
total, comfortably under the ~1 MB IPFS ceiling for an Acurast bundle.

```mermaid
graph TD
    R["POST /attest<br/>{player, epoch, k, inputLog}"] --> V1{"k in range?<br/>epoch not future?"}
    V1 -->|no| RJ["reject"]
    V1 -->|yes| S["sessionId = keccak256(player, epoch, k)"]
    S --> SD["seed = PRF(sessionId)<br/>secret, never leaves enclave"]
    SD --> RP["replay sim.wasm with seed + inputLog"]
    RP -->|"log malformed"| RJ
    RP --> SC["score = whatever the replay produced"]
    SC --> DG["build EIP-712 digest IN HERE"]
    DG --> SG["signer_sign → r‖s"]
    SG --> OUT["return claim + signature"]

    style OUT fill:#1f3a24,stroke:#0a7d33,color:#fff
    style RJ fill:#3a1f1f,stroke:#b3261e,color:#fff
```

**Four rules the enclave must never break:**

1. **No score is accepted.** `/attest` has no score field at all — it can only be computed.
2. **The digest is built inside.** Signing a caller-supplied digest would let anyone get
   anything signed.
3. **`rulesHash` is computed from the loaded artifact**, not configured, so the enclave
   cannot attest for a ruleset it is not running.
4. **The seed cannot be computed outside.**
   `seed = keccak256(signer_sign("rainbow-seed-v1" ‖ sessionId))`. `signer_sign` is
   deterministic (RFC 6979) and its key is in the secure element, so this is a PRF the
   player cannot evaluate offline. The seed *is* released by `/session` — the level is
   generated from it, so the client cannot play without it — but only for the current
   epoch and only for `k < maxSessionsPerEpoch`. See "Why the seed is handed out at all"
   above.

### Deploy it

```bash
cd e2e/acurast-verifier
# .env: ACURAST_MNEMONIC, CONTRACT, CHAIN_ID, GAME_ID, WEBHOOK_URL
acurast estimate-fee rainbow-verifier    # validates config BEFORE spending
acurast deploy rainbow-verifier
```

Key config, and why:

```jsonc
"runtime": "Shell",                     // Node.js runtime CANNOT do EIP-712 — see below
"assignmentStrategy": {
  "type": "Single",                     // "Competing" rotates processors → rotates keys
  "instantMatch": [{"processor": "<SS58>", "maxAllowedStartDelayInMs": 10000}]
},
"usageLimit": {"maxMemory": 2000, "maxNetworkRequests": 10, "maxStorage": 10000},
"mutability": "Mutable"                 // required if you later use reuseKeysFrom
```

> **The runtime choice is load-bearing.** On the **Node.js** runtime,
> `_STD_.chains.ethereum.signer.sign` force-prepends `"acusig" ‖ SCRIPT_HASH` before hashing,
> so an EIP-712 digest could never be recovered by the contract. The **Shell/Cargo** runtime's
> `signer_sign` signs the bytes you give it, with no envelope. Use `Shell`.

> **`usageLimit` is a requirement, not a cap.** It is matched against what the processor
> *advertises*; ask for more than the device offers and it becomes ineligible. And the units
> are not bytes — `networkRequestQuota` is a `u8`, so it is a *count*. Check the device's
> advertised values first.

> **`instantMatch` skips the lottery.** Without it you are competing for public processors,
> which is what strands most first deployments at "finding the processor". It also skips the
> ~4.5 h warmup for a freshly onboarded device.

---

## 11. Part 4 — wiring them together

This is the step that makes the trust story real.

```mermaid
sequenceDiagram
    participant You
    participant AC as Acurast chain
    participant L as Leaderboard

    Note over AC: the processor publishes the deployment's<br/>public keys BEFORE the job runs
    You->>AC: read storedMatches → pubKeys.secp256k1
    You->>You: address = keccak256(uncompressed pubkey)[-20:]
    You->>L: setVerifier(address, true)
    Note over L: the contract now trusts a key you<br/>VERIFIED, not one the enclave claimed
```

```bash
# 1. read the enclave's key from Acurast chain state (not from the enclave!)
#    acurastMarketplace.storedMatches → assignment.pubKeys.secp256k1

# 2. register it
node scripts/revive-call.mjs --to $CONTRACT \
  --data "$(cast calldata 'setVerifier(address,bool)' 0xafbd70f7… true)"

# 3. run the whole flow
node scripts/attest-and-submit.mjs \
  --verifier https://<tunnel> --expect-verifier 0xafbd70f7… --player 0x… --k 0
```

> **Keys are per deployment.** Every redeploy mints a new verifier address unless you use
> `reuseKeysFrom`. Keep `isVerifier` a **set** and *add without removing*, so attestations
> already in flight stay valid until they expire.

---

## 12. Part 5 — the signature detail that will cost you a day

Acurast's `signer_sign` returns **64 bytes** (`r‖s`) with **no recovery id**.
`ECDSA.recover` needs **65** with `v ∈ {27, 28}`.

```mermaid
graph LR
    A["signer_sign<br/>→ 64 bytes r‖s"] --> B{"try v = 27"}
    B -->|"recovers to<br/>enclave address"| C["use 27"]
    B -->|"no"| D{"try v = 28"}
    D -->|"recovers"| E["use 28"]
    D -->|"no"| F["signature is not<br/>from this key"]

    style C fill:#1f3a24,stroke:#0a7d33,color:#fff
    style E fill:#1f3a24,stroke:#0a7d33,color:#fff
    style F fill:#3a1f1f,stroke:#b3261e,color:#fff
```

```js
for (const rec of [0, 1]) {
  const packed = new Uint8Array(65);
  packed[0] = rec; packed.set(rs, 1);
  const pub = secp256k1.recoverPublicKey(packed, digest, {prehash: false});
  if (addressOf(pub) === enclaveAddress) { v = 27 + rec; break; }
}
```

Use the contract's `scoreDigest(claim)` as the **single source of truth** for what to sign.
Do not reimplement the EIP-712 encoding on the job side and hope it matches — verify it does,
before deploying:

```bash
# enclave's digest, computed locally against a mock bridge
# vs the deployed contract's:
cast call $CONTRACT "scoreDigest((address,uint64,uint64,uint64,uint32,bytes32,uint64))(bytes32)" \
  "($PLAYER,1,$SCORE,$EPOCH,$K,$RULES,$EXPIRY)" --rpc-url $RPC
```

---

## 13. Part 6 — the game, and shipping it as a Product

The client is a **React + Vite + PixiJS v8** app in `app/`, published to the Products
Devnet as a static bundle.

### The rule the client must not break

The client never implements a game rule. It steps `sim.wasm` and draws what comes back.
A JavaScript reimplementation of the physics would be a second ruleset, it would drift,
and honest players would start being flagged as cheats. `app/src/sim/sim.ts` is the whole
interface: `sim_create` → `sim_step_one` → `sim_snapshot`.

**React does not own the loop.** It owns the chrome; PixiJS owns the play surface and is
driven imperatively. Reconciling a scene graph at sixty ticks a second would put a diffing
pass inside a fixed-timestep loop that has to stay exact — the tick count *is* the clock the
enclave replays against. React sees a 10 Hz HUD sample, never a frame.

**The tick convention is load-bearing.** An input change is stamped with the number of steps
already taken and pushed *before* stepping, matching `replay_with`. Get this off by one and
nothing looks wrong — the game plays perfectly and only the attestation disagrees.

### What the sandbox allows

Everything here rests on [E0.1](E0.1-product-sandbox.md), which measured a Product's sandbox
before any of it was built:

| Capability | Result | Consequence |
|---|---|---|
| `WebAssembly.instantiate` | PASS | `sim.wasm` runs client-side — no fallback existed if it had not |
| Third-party HTTPS fetch | PASS | the app calls the enclave tunnel directly; no relay needed |
| WebGL2 | PASS | PixiJS v8 is viable |
| `SharedArrayBuffer` | absent | rules out threaded engine targets; PixiJS does not need it |

The renderer therefore requests `preference: "webgl"` explicitly rather than letting PixiJS
prefer WebGPU, which was never measured in the sandbox.

### Detecting the host

A Product gets its signer and chain RPC from the host. Outside one, `ProductSDKProvider`
throws `Host storage unavailable` — and since it sits above the whole tree, that takes the
game down with it.

`app/src/SdkGate.tsx` asks **`isInsideContainer()`** from `@parity/product-sdk/host`, then
mounts the provider only when there is a host, with an error boundary behind it.

> **Do not infer the host from the frame.** An earlier version used
> `window.self !== window.top`, reasoning that a Product is delivered into a cross-origin
> iframe — which E0.1 did measure, but only on the *web gateway*. **Polkadot Desktop loads
> the app top-level**, so that check reported "no host" inside a real host and silently
> disabled submitting, with no error to explain it.

Without a host the app still plays and still gets scores attested; only the on-chain submit
is unavailable. A `DevProvider` fallback supplies dev accounts so `npm run dev` is useful.

### Working without an enclave

An Acurast job is a *onetime* execution behind a quick tunnel, so the verifier URL baked into
`Play.tsx` is stale the moment the job ends — and redeploying to change one line of UI is a
poor loop. `npm run dev` therefore offers **Simulate the enclave**, a switch in the Session
panel that replaces the deployed verifier with `app/src/chain/mock.ts`, running in the tab.

It is a second implementation of `verifier.mjs`, deliberately faithful: the same
`sessionIdFor`, the same `keccak256(sign("rainbow-seed-v1" ‖ sessionId))` seed derivation, a
replay through `sim_verify` on its **own** wasm instance — not the one the player just
played on — and the same EIP-712 digest. `rulesHash` is hashed from the bytes it actually
loaded. Steps 1–5 of the proof rail work end to end with nothing deployed.

What it is not is a verifier. Its key is derived from a string in the source, so anyone can
sign anything with it; the contract's `isVerifier` set does not contain it. Two guards keep
that from becoming confusing rather than obvious:

- **It never submits.** `finish()` stops after attesting and says why. Step 6 stays idle,
  because the simulator cannot honestly reach it.
- **Sessions do not cross over.** Simulated runs are held under `rainbow.session.sim`,
  separate from `rainbow.session`. The two enclaves derive different seeds for the same
  `(player, epoch, k)`, so replaying one's held seed against the other would produce a score
  mismatch that looks exactly like a cheat.

The switch and the module behind it are gated on `import.meta.env.DEV` and reached through a
dynamic `import()`, so a build drops both — which matters, given the byte quota below.

### Publishing

```bash
cd app
npm run build                     # sync-wasm → tsc → vite build, emits dist/
pad ./dist <name>.dot --env devnet --mnemonic "$MNEMONIC"
```

> **`pad` ignores the `MNEMONIC` environment variable** despite its own `--help` offering it.
> It falls back to a dev worker account and then fails with
> `Domain <name>.dot is already owned by 0x…`, which reads like an ownership problem and is
> really a signing-identity one. Pass `--mnemonic` explicitly.

> **The gateway serves a resolver shell, so `curl` cannot verify a deploy.** Both `/` and
> `/sim.wasm` return the same ~20 KB HTML; resolution happens client-side through a
> service-worker VFS into a sandboxed iframe. Open it in a browser to check.

**Bundle size is a quota, not a fee.** Bulletin storage is authorization-based — this
deployment's account holds 20 MB. The SDK reaches every supported chain through dynamic
imports, so Rollup emitted metadata for Kusama, Polkadot, Paseo and Individuality too:
6 MB of the 7.1 MB build, for chains the app never connects to. `vite.config.ts` stubs the
unused ones, taking the bundle to **3.1 MB** — the difference between two deploys and six.
Check the quota with `dotns bulletin status <ss58> --env devnet`.

---

## 14. Live reference

| | |
|---|---|
| Contract | `0x9cc62a70E0d2ed75432C3d9c1F997a122eE976a0` |
| CDM package | `@dw3labs/rainbow-leaderboard` |
| Chain | Paseo Asset Hub, EVM chain id `420420417` |
| ETH-RPC (reads) | `https://paseo-assethub-rpc.laissez-faire.trade` |
| Substrate RPC (writes) | `wss://asset-hub-paseo-rpc.n.dwellir.com` |
| Owner | `0x50AFf5a51BE03d5914D9b5A42c548Dc35A73f7D8` |
| `epochSeconds` / `maxSessionsPerEpoch` | 3600 / 12 |
| Game 1 `rulesHash` | `0x229be8b7…bd479c` — retired: the falling-orb strawman |
| Game 2 `rulesHash` | `0x02bdb80f…bd049b` = `keccak256(sim.wasm)` — the platformer |
| `sim.wasm` (game 2) | 33,599 bytes, ABI version 2 |
| Product app | `dw3labsgame.dot` — https://dw3labsgame.dev-dot.li |
| App bundle CID | `bafybeihq4votaqskcndngna3hvnwrwg3eazk7v4qxdbrerpxqpx4xkjnhy` |

> **A new ruleset is a new `gameId`, never a mutated hash.** `gameRules` is write-once by
> design (defect D3): scores earned under one set of physics must not share a board with
> scores earned under another. Game 1's board still exists and is still valid; it is simply
> closed. The contract did **not** need redeploying for this.

---

## 15. Troubleshooting

| Symptom | Cause |
|---|---|
| `unexpected argument '--resolc'` | upstream Foundry; `cdm` needs foundry-polkadot |
| `Revive.ContractReverted` on deploy | constructor takes arguments; `cdm` passes none |
| `OwnableUnauthorizedAccount(0x…)` | `cast` signing as a BIP44 key, not your mapped H160 |
| `wasm 'unreachable'` in `validate_transaction` | `@polkadot/api` building extrinsic v4 — use papi |
| `Incompatible runtime entry Tx(Revive.call)` | papi field names — `weight_limit`, `dest` as hex string, `data` as `Uint8Array` |
| Acurast job stuck "finding the processor" | no `instantMatch`, or `usageLimit` exceeds what the device advertises |
| Acurast job dies silently | DevTools is **mainnet-only** — a canary job has no stdout. Instrument with a webhook. |
| `apt` exits 100 in the proot | `TMPDIR` leak — `export TMPDIR=/tmp` first |
| `cp X X failed` in the job | the bundle extracts to `/root/app`, which **is** `$HOME/app` |
| `rulesHash` changed after a comment-only edit | `overflow-checks = true` bakes panic `file:line:col` into the binary, so **adding a comment to `crates/sim` shifts line numbers and changes the artifact**. See below. |

### Editing `crates/sim` after a game is registered

`rulesHash` is `keccak256(sim.wasm)`, and the release profile sets `overflow-checks = true`.
Overflow checks emit panic metadata carrying the **source line and column**, so the compiled
bytes depend on the *layout* of the source, not just its behaviour. A reformatting, a new
comment, or a clippy autofix such as `tx < 10 || tx >= N` → `!(10..N).contains(&tx)` all
change the artifact — one of those was measured moving it by a single byte, another kept the
length identical and changed the contents.

Once a `gameId` is registered this is no longer cosmetic: the source must keep reproducing
the exact artifact the enclave bundles and the contract is pinned to. Verify before
committing any change to that crate:

```bash
cargo build -p sim-wasm --release --target wasm32-unknown-unknown
node -e 'const{keccak_256}=require("./scripts/node_modules/@noble/hashes/sha3.js");
  console.log("0x"+Buffer.from(keccak_256(
    require("fs").readFileSync("target/wasm32-unknown-unknown/release/sim_wasm.wasm"))).toString("hex"))'
# must equal gameRules(2) on-chain
```

If a change to the rules is genuinely wanted, it is a **new `gameId`**, not a new hash for
the old one.
| Revert `0x36177dda` / `0xdafa9c74` / `0x342bd384` | `SessionAlreadyUsed` / `NotAnImprovement` / `BadAttestation` |

---

## 16. What this does **not** solve

Stated plainly, because a security design that overclaims is worse than one that admits its
edges.

- **Bots and TAS-quality play.** A perfectly executed input log is a *valid* input log.
  Behavioural heuristics inside the enclave are detection, not proof, and an arms race.
- **Sybil.** Nothing stops one human farming many accounts. The Products **personhood
  precompile** is the identified path if the board ever carries value.
- **Hardware attacks on the TEE.** Trust is inherited from the chip vendor's attestation root.
- **Operator device selection.** Using the public processor market instead of your own fleet
  is what removes this.
- **Cloudflare in the path.** Liveness and censorship dependency, not an integrity one.
- **Seed PRF reuses the attestation key.** Domain-separated so it cannot be coerced into
  producing an attestation, but a `derivationPath`-derived key would be cleaner.

**Explicitly not a threat: cherry-picking.** A player choosing which runs to submit is
harmless for a *highest score* board — a withheld run is indistinguishable from a run that
never happened. This would **not** hold for win rates, ELO or tournament records, where the
denominator matters; those need enclave-submitted results rather than player-relayed ones.

---

## 17. The strongest thing still unbuilt

Publish the **input log to Bulletin** alongside each score.

The log fully determines the run, so anyone could re-replay it and check the score
independently. That changes the claim from *"trust the TEE"* to *"the TEE is a fast path over
a publicly re-verifiable record"* — and it comes with ghost replays, spectating and dispute
resolution as side effects.

---

## Further reading

| Document | Contents |
|---|---|
| `docs/E0.2-determinism.md` | cross-target determinism evidence |
| `docs/E0.1-product-sandbox.md` | what a Polkadot Product may do in its sandbox |
| `docs/E0.3-E0.4-acurast.md` | `signer_sign` semantics, tunnel |
| `docs/deployment-devnet.md` | deployment specifics, `cdm` vs `forge create` |
| `docs/end-to-end.md` | the working run, with negative tests |
| `contracts/README.md` | contract design, D1/D3 rationale |
| `Goal.md` | the original design document |
