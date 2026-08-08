// ## Why `@parity/product-sdk` is pinned to 0.19.1, exactly, and must not float
//
// The SDK version this app can use is set by the *installed Polkadot Desktop
// build*, not by npm's `latest`. App and host are two independent
// implementations of one SCALE wire protocol, and there is no negotiation step:
// if the two disagree about a type's shape, the bytes are simply misread.
//
// `@parity/truapi` 0.6.0 changed `DerivationIndex` from `u32` to
// `TaggedUnion({Left: u32, Right: Hex(32)})` — one extra tag byte. It sits
// inside `ProductAccountId`, which is the first field of
// `ProductAccountTxPayload`, so that byte shifts *every field after the signer*.
// The host then reads the `extensions` vector length out of garbage, gets an
// enormous count, and runs off the end of the buffer:
//
//     Transport error RangeError: Offset is outside the bounds of the DataView
//
// It fires the moment a contract write is submitted. The transaction never
// reaches the phone, and the account's nonce stays 0 — the extrinsic is
// destroyed inside the host before it is ever sent. That is the "signing is
// accepted and then never answered" failure, and it is why `submit.ts` could
// dry-run successfully and still land nothing.
//
// Crucially, **account resolution working proves nothing about compatibility**.
// `HostAccountGetRequest` carries only the account, so the host reads 4 of the 5
// bytes as 0 and ignores the trailing one — nothing follows to misalign. Signing
// is the first message with fields after the signer, so it is the first to break.
//
//     product-sdk 0.19.1 → sdk-host 0.14.1 → truapi ^0.5.0 → 0.5.1   ✅
//     product-sdk 0.20.0 → sdk-host 0.15.0 → truapi ^0.6.0           ❌
//     product-sdk 0.20.1 → sdk-host 0.15.1 → truapi ^0.7.0           ❌
//
// 0.19.1 is the newest release wire-compatible with a Desktop carrying host-api
// 0.8.10. Verified against the installed binary rather than copied from the
// reference apps, which sit four minors back on 0.15.1:
//
//     npx @electron/asar extract-file \
//       "/Applications/Polkadot Desktop Dev.app/Contents/Resources/app.asar" \
//       node_modules/@novasamatech/host-api/dist/protocol/v1/accounts.js
//
// That host declares `DerivationIndex = u32` and
// `ProductAccountId = Tuple(DotNsIdentifier, DerivationIndex)`; truapi 0.5.1
// declares `Struct({dotNsIdentifier: str, derivationIndex: u32})`. SCALE encodes
// `Struct` and `Tuple` identically, so those agree byte for byte.
//
// `package.json` therefore carries **no caret** on `@parity/product-sdk` or
// `@parity/product-sdk-tx`, and pins `@parity/truapi` directly even though
// nothing imports it — it is the wire-critical package and is otherwise only
// transitive, so a pin is the only place the constraint is visible. This
// previously read `"@parity/product-sdk": "*"`, which is how the tree drifted
// onto 0.20.1 in the first place.
//
// Two consequences in the code: `SmartContractAllowance` takes a plain `u32`
// here, not a `{ tag: "Left" }` union (see `wallet.ts`), and
// `product-sdk-contracts` 0.9.2 has no `isContractAccountMapped` (see
// `submit.ts`). Both are downgrades of convenience, not of capability.
//
// Before bumping any of these, re-extract the host's `accounts.js` and diff it
// against `node_modules/@parity/truapi/dist/generated/types.js`.

import { devnet_asset_hub } from "@parity/product-sdk-descriptors/devnet-asset-hub";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { polkadot_asset_hub } from "@parity/product-sdk-descriptors/polkadot-asset-hub";

/**
 * Which Polkadot network this build targets.
 *
 * One flag, because the choice is not one choice. A network selects the Asset
 * Hub the contract lives on, the Bulletin chain Cloud Storage talks to, and the
 * contract address itself — and picking those independently is how a build ends
 * up half on one network and half on another.
 *
 * That is not hypothetical. Cloud Storage's environment defaults to `paseo`
 * while everything else here was pinned to devnet, so the app asked Polkadot
 * Desktop for Paseo Bulletin, was refused the chain, and lost the host — and
 * with it the ability to submit a score at all. The docs warn that the usual
 * form of this bug is *silent*: "your data is simply not where you expect it
 * and nothing errors". We got the loud version only by luck.
 *
 * Set at build time:
 *
 *     VITE_NETWORK=devnet npm run build     # default
 *     VITE_NETWORK=paseo npm run build
 *     VITE_NETWORK=polkadot npm run build
 *
 * `vite.config.ts` reads the same variable to decide which chain metadata to
 * keep in the bundle, so the flag governs both what the app asks for and what
 * it actually ships the metadata to talk to.
 */
export type Network = "devnet" | "paseo" | "polkadot";

const RAW = import.meta.env.VITE_NETWORK ?? "devnet";

function parse(value: string): Network {
  if (value === "devnet" || value === "paseo" || value === "polkadot") return value;
  // Fail at startup rather than at the first chain call. A typo here would
  // otherwise surface much later as a chain-support error, which reads as an
  // infrastructure problem rather than a build one.
  throw new Error(`VITE_NETWORK must be devnet, paseo or polkadot — got "${value}"`);
}

export const NETWORK: Network = parse(RAW);

/**
 * The Asset Hub descriptor for this network.
 *
 * All three are imported statically so the selection stays a build-time
 * constant. The unused ones cost nothing in the bundle: `vite.config.ts`
 * replaces the chain *metadata* modules that this network does not use, which
 * is where the weight is.
 */
export const ASSET_HUB = {
  devnet: devnet_asset_hub,
  paseo: paseo_asset_hub,
  polkadot: polkadot_asset_hub,
}[NETWORK];

/**
 * The Cloud Storage environment, which is the Bulletin chain to use.
 *
 * The SDK accepts only `paseo` and `devnet`; there is no Bulletin on Polkadot
 * yet. A `polkadot` build therefore runs without Cloud Storage rather than
 * connecting to a testnet's Bulletin, which would be worse than not having it.
 */
export const CLOUD_STORAGE: { environment: "devnet" | "paseo" } | false =
  NETWORK === "polkadot" ? false : { environment: NETWORK };

// The leaderboard address used to be a `DEPLOYED` table here. It is now
// `cdm.json`'s — see `contract.ts` — installed by
// `cdm i -n devnet @dw3labs/rainbow-leaderboard` and kept next to the ABI it
// has to agree with. `VITE_CONTRACT` still overrides it, and the EIP-712
// warning that lived on this constant moved there with it.

/**
 * The dotNS name this Product is published under.
 *
 * Not cosmetic: it is half of a `ProductAccountId` (`{dotNsIdentifier,
 * derivationIndex}`), so it identifies the account the host derives for us and
 * sponsors. Getting it wrong yields a different account with no allowance.
 *
 * Which also means **changing it is not a rename**. The host derives the
 * account from this string, so a new name is a new account: a new address for
 * the leaderboard to credit, no `SmartContractAllowance` until the host is
 * asked again, and no `pallet-revive` mapping until `ensureAccountMapped`
 * sends one. All three recover by themselves on the next submit — at the cost
 * of two wallet prompts — but scores standing under the old name stay there,
 * because they are keyed by the address that earned them.
 *
 * Moved from `dw3labsgame.dot` to `rainbow-dev.dot` on 2026-07-31.
 */
export const PRODUCT_NAME = import.meta.env.VITE_PRODUCT_NAME ?? "rainbow-dev.dot";

/**
 * Derivation index of the product account that signs contract calls.
 *
 * The same index is passed to `requestResourceAllocation` as
 * `SmartContractAllowance`, which pre-warms that exact account's PGAS. The two
 * must agree or the host funds one account and submits from another.
 */
export const CONTRACT_ACCOUNT_INDEX = 0;

/**
 * Which board this build shows.
 *
 * A `gameId` on the contract is pinned to a `rulesHash`, so it names a ruleset
 * rather than a number. The app needs it before any enclave call in order to read
 * the board on a cold load, which is why it is a build constant here rather than
 * taken from `/identity`.
 *
 * **Two**, not one, and not a guess: the live verifier's `/identity` reports
 * `gameId: 2` with `rulesHash 0x02bdb80f…`, which is `keccak256` of the current
 * 33,599-byte `sim.wasm`. Game 1 was the 22,820-byte artifact from E0.2 and is
 * not registered on this deployment at all — no verifier serves that ruleset any
 * more, so registering it would advertise a board nobody can play.
 *
 * The enclave states its own `gameId`, and a disagreement is worth saying out
 * loud: it means the board on screen is not the board the run would land on.
 */
export const GAME_ID = Number(import.meta.env.VITE_GAME_ID ?? 2);

