# Host API conformance — every chain call, and the host call it makes

**Status: conformant** (2026-07-31) · one real leak found and closed, see
[What was not host-routed](#what-was-not-host-routed-and-is-now-gone).

## Why this document exists

A Product review flagged the app:

> **Direct Chain Access** — This app uses a direct chain connection instead of the
> recommended host API.

The flag is wrong on its stated grounds and right that something had leaked. There has never
been a chain connection in this app that the host did not open — no `WsProvider`, no
`ApiPromise`, no smoldot, no WebSocket, no RPC URL, in the source or in the bundle. But the
published Product *was* shipping a construction of the SDK's `DevProvider`, with its own
keypair derivation, alongside the host's signer. From the outside those are hard to tell
apart, and a reviewer should not have to take the difference on trust.

So this document does two things: it maps every chain touchpoint to the host call it makes,
with the SDK's own words on why the one suspicious-looking call is the sanctioned one; and it
records what was actually wrong, what closed it, and the check that stops it reopening.

## What the host API is

A Product holds no keys and opens no sockets. `@parity/product-sdk` v0.19.1 lends both:

| | |
|---|---|
| `createApp({name, cloudStorage})` | opens the host transport; returns `App` |
| `app.chain.connect(chains)` | connects, host-routed; returns typed APIs plus `.raw.<name>` |
| `app.chain.getClient(desc)` | typed PAPI `TypedApi` — storage reads, extrinsics |
| `app.chain.getRawClient(desc)` | host-routed untyped `PolkadotClient` — contracts |
| `requestResourceAllocation(...)` | host gate: pre-warmed PGAS for the product account |
| `SignerManager` / `getProductAccount(...)` | the host's signer, and the product's account |

There is no second path. `@parity/product-sdk-chain-client/dist/index.d.ts:70-77`:

> Connections route through the host provider (`@parity/product-sdk-host`) — the SDK is
> designed to run exclusively inside a host container (Polkadot Browser / Desktop). Throws if
> no host provider is available; **there is no direct-WebSocket fallback.**

## Every chain touchpoint

| Site | Host call it makes |
|---|---|
| `app/src/SdkGate.tsx:109-127` | `createApp`, with a `cloudStorage:false` retry on Bulletin refusal |
| `app/src/chain/board.ts:54-77` | `app.chain.connect` → `getRawClient` → `createContractFromClient`, **no signer** |
| `app/src/chain/board.ts:111,119,149` | contract views `playerCount`, `board` (paged 50, capped 200), `best` |
| `app/src/chain/submit.ts:55` | `currentManager().getProductAccount(PRODUCT_NAME, 0)` |
| `app/src/chain/submit.ts:66-86` | same connect + `getRawClient`, plus `defaultSigner`/`defaultOrigin` |
| `app/src/chain/submit.ts:135` | `requestResourceAllocation([{tag:"SmartContractAllowance", value:0}])` |
| `app/src/chain/submit.ts:194-205` | `app.chain.getClient` → `query.Revive.OriginalAccount` → `ensureAccountMapped` |
| `app/src/chain/submit.ts:259-279` | `.query()` dry-run → `applyWeightBuffer` → `.tx()` → read-back |
| `app/src/chain/useBoard.ts:56-113` | drives the board reads; polls on a refresh key, holds no subscription |

**The board loads before the wallet does.** `board.ts` builds its handle without a signer,
which is why it is a separate function from the one in `submit.ts` — deriving the product
account costs a host round trip, and a read needs no account at all.

**Nothing here subscribes.** Every read is a dry-run against best-block. There is no
`chainHead` follow of our own, which is the other shape "direct chain access" could have taken.

## "Raw" means untyped, not un-hosted

`getRawClient` is the one call whose name invites the reviewer's reading. Two things about it.

**It is the host's client.** The quote above is unambiguous: every connection the SDK hands
out is routed through the host provider, and there is no fallback that would produce any
other kind. *Raw* distinguishes an untyped `PolkadotClient` from a `TypedApi`. It does not
distinguish hosted from unhosted, because unhosted does not exist.

**It is required, not preferred.** `createContractFromClient` builds on
`createContractRuntimeFromClient`, and `@parity/product-sdk-contracts/dist/types-BKcrGoiN.d.ts`
is explicit about which of the two runtime factories a live chain needs:

> `createContractRuntime(api)` — Wrap a typed PAPI API as a `ContractRuntime`. **Intended for
> tests and advanced setups** … Routes the dry-run through the typed
> (compatibility-token-checked) `ReviveApi.call` — fine for mocks but **susceptible to
> `Incompatible runtime entry` errors on a live chain whose descriptor lags.** Prefer
> `createContractRuntimeFromClient` for production use.

> `createContractRuntimeFromClient(client, descriptor)` — … The runtime-API dry-run, which is
> *not* tolerant of descriptor drift on PAPI's compat-token path, is routed through
> `client.getUnsafeApi()` — bypassing the compat check while preserving argument and return
> shapes. **Use this on every production code path** that calls a contract's `.tx()` or
> `.query()` against a live chain.

Moving off the raw client would mean moving onto the factory the SDK labels as being for
tests, and buying a class of failure — a contract that stops reading after an Asset Hub
runtime upgrade — in exchange for a variable rename. The call sites carry this reasoning
inline (`board.ts:58-70`, `submit.ts:70-72`) so the next reader does not re-litigate it.

## The audit

Run against `app/src` and against the built bundle, 2026-07-31:

```
### grep app/src
(no matches)
### grep dist
(no matches)
### dev-signer construction in dist
(no matches)
### chain deps
@parity/product-sdk *
@parity/product-sdk-descriptors ^0.8.0
@parity/product-sdk-tx ^0.3.2
```

The pattern set for the first two is
`wss://|ws://|getWsProvider|WsProvider|ApiPromise|smoldot|new WebSocket`. The dependency list
is every chain-related entry in `app/package.json` — there is no `@polkadot/api`, no `dedot`,
no `@substrate/connect`. `polkadot-api` appears once in `app/src/vite-env.d.ts:7` as a
`import type` for `ChainDefinition`, pulled in transitively by the descriptors package; no
value from it is ever imported.

## What was not host-routed, and is now gone

`app/src/chain/wallet.ts` constructed a second `SignerManager` — dev keypairs via
`DevProvider`, persisted to `localStorage` — at **module load, unconditionally**. It was
intended for `npm run dev`, where there is no host to lend a signer, but nothing stopped it
from being built and shipped. `connectWallet()` tried the host first and fell back to it.

Confirmed in the published bundle before the fix:

```
"Rainbow (dev)" ×1  assets/index-DF5Zlt3-.js
  …inbow"}),Db=new b_({dappName:"Rainbow (dev)",createProvider:()=>new j6({n…
"Ferdie" ×1  assets/index-DF5Zlt3-.js
  …"Bob","Charlie","Dave","Eve","Ferdie"],j6=class{type="dev";names;m…
```

`Ferdie` was the tell. The app only ever asked for `["Alice","Bob"]`, so `Ferdie` could only
come from `DEFAULT_DEV_NAMES` inside the SDK's `DevProvider` — the class itself was in the
bundle, not merely our call to it.

**The fix** is one ternary on `import.meta.env.DEV` (`wallet.ts:45-55`), which Vite replaces
with `false` at build time. A build now constructs only the host manager, `active` can only
ever be `hostManager`, and `submit.ts`'s `getProductAccount` is therefore host-routed by
construction rather than by convention.

**One behaviour changed with it.** A published Product that cannot reach the host now surfaces
the host's error instead of silently connecting `//Alice` under the message "no host found —
using dev accounts". That fallback was a dead end anyway — `//Alice` holds nothing on Asset
Hub and is not mapped for `pallet-revive`, so it could never land a submission — and the
message described the wrong failure.

> **The dev bytes did not all leave, and it would be dishonest to imply they did.**
> `index-*.js` went from 1,188,672 to 1,188,488 bytes: 184 bytes, which is our construction
> call and nothing more. `SignerManager.createProvider()` has a `case "dev": return new
> DevProvider(…)` arm (`@parity/product-sdk-signer/dist/index.js:822`), so the class is
> reachable from the host path and no bundler will shake it out. Every Product built on this
> SDK ships those bytes. Reaching that arm takes an explicit `connect("dev")`; the app only
> ever calls `connect()`, which defaults to the host provider.

## Known false triggers

Two files in this repo do open sockets. Neither is app code, and neither is in any bundle's
import graph:

| | |
|---|---|
| `scripts/revive-call.mjs:33,44,74` | Node developer CLI. `getWsProvider` + `wss://asset-hub-paseo-rpc.n.dwellir.com`, for owner-only contract calls that `cast` cannot make. Header says so. |
| `harness/cdp-probe.mjs:81` | `new WebSocket` to the Chrome DevTools Protocol. Not a chain. |

A scanner pointed at the repository rather than at `dist/` will find the first one. It is the
most likely origin of the review flag.

## The guard

`app/scripts/check-bundle.mjs`, chained onto `npm run build`, greps the built artifact and
exits nonzero on two groups of markers: direct chain access (the pattern set above) and local
signer (`Rainbow (dev)`). Because it runs as the last step of `build`, the publish flow
(`npm run build` → `pad ./dist …`) cannot upload a bundle that failed it.

It is deliberately narrow on the second group. `Ferdie`, the SDK's dev seed phrase, the
`DevProvider` class, `sr25519`, `mnemonic` and `entropy` are all present in a *correct* build —
the first three via `SignerManager` as described above, the rest via
`@parity/product-sdk-contracts`' legitimate use of hdkd-helpers and the chain-metadata
descriptor chunks. Banning them would fail every build, and a check that cries wolf gets
`--no-verify`'d, which is worse than no check. `dappName: "Rainbow (dev)"` is ours, survives
minification intact, and answers the only question a bundle can answer: not *are the dev bytes
present* — they always are — but *does this app build a dev signer*.

The guard was confirmed to fail before it was trusted to pass: run against the pre-fix bundle
it reported the three hits quoted above and exited 1.
