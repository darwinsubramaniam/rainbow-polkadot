// The Leaderboard contract, as `cdm.json` describes it.
//
// Address, ABI and TypeScript types now come from one place: the manifest that
//
//     cdm i -n devnet @dw3labs/rainbow-leaderboard
//
// installs into `app/`, plus the module augmentation it writes to `.cdm/`. All
// three used to be maintained by hand — a `DEPLOYED` table in `network.ts`, a
// ~150-line `LEADERBOARD_ABI` in `leaderboard.ts`, and a `method()` helper in
// `submit.ts` that cast the handle to `Record<string, unknown>` because the
// generic factory had nothing better to offer. The hand-written ABI was also
// quietly incomplete: it declared nine errors, and the deployed contract has
// thirteen — the four OpenZeppelin ones (`OwnableUnauthorizedAccount`,
// `OwnableInvalidOwner`, `InvalidShortString`, `StringTooLong`) would have
// reached a player as raw selectors.
//
// Two things to know before editing:
//
//  1. `tsconfig.json` must include `.cdm`, or the generated augmentation is
//     inert, `getContract` falls back to its untyped overload, and every call
//     below silently degrades to `unknown` without a single error.
//  2. Re-run `cdm i` after any redeploy. The manifest pins a version and an
//     address, and a stale one is indistinguishable from a correct one until a
//     call reverts.

import {
  ContractManager,
  type CdmJson,
  type ContractOptions,
  type ContractRuntime,
} from "@parity/product-sdk/contracts";
import type { App } from "@parity/product-sdk/core";

import cdmJson from "../../cdm.json";
import { ASSET_HUB, NETWORK } from "./network";

/** The CDM library name, which is also the key into `cdm.json`. */
export const LEADERBOARD = "@dw3labs/rainbow-leaderboard";

const MANIFEST = cdmJson as CdmJson;

const INSTALLED = MANIFEST.contracts?.[LEADERBOARD];
if (!INSTALLED) {
  // At module load rather than at the first call. A missing manifest entry is a
  // setup mistake, and the useful moment to say so is before the board renders
  // an empty state that looks like "nobody has played yet".
  throw new Error(
    `cdm.json has no entry for ${LEADERBOARD} — run \`cdm i -n ${NETWORK} ${LEADERBOARD}\` in app/`,
  );
}

/**
 * The deployed Leaderboard address.
 *
 * From the manifest, overridable with `VITE_CONTRACT`. The override survives the
 * move to CDM because `cdm.json` holds exactly one address and this app builds
 * for three networks: switching targets otherwise means re-running `cdm i -n …`
 * and leaving a modified manifest in the tree, which is a worse workflow than an
 * environment variable for a one-off `paseo` build.
 *
 * Changing this address is never only a client change. The EIP-712 domain names
 * `verifyingContract`, so the enclave's signature is bound to whichever address
 * *it* was configured with: an attestation signed for one deployment is refused
 * by another as `BadAttestation`. The Acurast job's `CONTRACT` env must move in
 * step — and note the ABI still comes from the manifest, so an override pointed
 * at a deployment with a different shape will decode against the wrong one.
 */
export const CONTRACT: string = import.meta.env.VITE_CONTRACT ?? INSTALLED.address;

/**
 * The manifest actually handed to `ContractManager`, with any override applied.
 *
 * Cloned rather than mutated: the imported JSON is module state shared with
 * anything else that reads it, and a build-time override is not a reason to
 * rewrite what the manifest on disk says.
 */
const RESOLVED: CdmJson = import.meta.env.VITE_CONTRACT
  ? {
      ...MANIFEST,
      contracts: {
        ...MANIFEST.contracts,
        [LEADERBOARD]: { ...INSTALLED, address: CONTRACT },
      },
    }
  : MANIFEST;

/**
 * A typed handle on the Leaderboard.
 *
 * `options` is what separates the two callers, and the difference is
 * deliberate. `board.ts` passes nothing: a view resolves its origin from the
 * pallet-revive fallback, so the board loads before the player has connected
 * anything. `submit.ts` passes the product account as `defaultSigner` /
 * `defaultOrigin`, which costs a host round trip to derive and is required
 * because only that account has the host's allowance.
 *
 * **Never pass `signerManager`.** The documented resolution order puts it
 * *above* the static signer, so it would reinstate the player's wallet as the
 * sender — an account with no allowance, which the host refuses to submit for
 * at all (`Submit failed, no allowance set for account`).
 *
 * A fresh manager per call, matching the handles this replaced. The underlying
 * chain connection is cached by the SDK, so the cost is building a runtime
 * object, not a round trip.
 */
async function managerFor(app: App, options?: ContractOptions): Promise<ContractManager> {
  // Idempotent — connections are cached by the SDK.
  await app.chain.connect({ assetHub: ASSET_HUB });

  // "Raw" here means untyped, not un-hosted — the name invites the opposite
  // reading, and a review did read it that way. `product-sdk-chain-client`:
  // "Connections route through the host provider … there is no direct-WebSocket
  // fallback." This client is the host's; there is no other kind to get.
  //
  // It also has to be this one rather than the typed API from `getClient`.
  // `fromClient` builds on `createContractRuntimeFromClient`, which the SDK says
  // to "use on every production code path that calls a contract's .tx() or
  // .query() against a live chain" — because it routes the dry-run through
  // `getUnsafeApi()`. The typed factory is documented as being for tests, and
  // "susceptible to `Incompatible runtime entry` errors on a live chain whose
  // descriptor lags". Ours will lag eventually.
  const client = app.chain.getRawClient(ASSET_HUB);

  // `fromClient`, not `fromLive`. Live resolution would re-read the address from
  // the CDM registry at boot and survive a redeploy without a rebuild — but the
  // EIP-712 binding above means an address that moves without the verifier's
  // `CONTRACT` env moving too turns every submission into `BadAttestation`. A
  // snapshot makes that mismatch a build-time fact instead of a runtime one.
  return ContractManager.fromClient(RESOLVED, client, ASSET_HUB, options);
}

/** A typed handle on the Leaderboard. See {@link managerFor} for what `options` is for. */
export async function leaderboard(app: App, options?: ContractOptions) {
  return (await managerFor(app, options)).getContract(LEADERBOARD);
}

/**
 * The runtime backing the contract handles.
 *
 * Wanted by the account-mapping helpers, which take a `ContractRuntime` rather
 * than a contract because mapping is a property of the *signer*, not of anything
 * the Leaderboard declares. Taken from the manager rather than built alongside
 * it, which the SDK calls out specifically: it "avoids the alternative of
 * building a second runtime against the same client and descriptor".
 *
 * No `options` — a runtime carries no signer or origin, so there is nothing for
 * them to configure.
 */
export async function contractRuntime(app: App): Promise<ContractRuntime> {
  return (await managerFor(app)).getRuntime();
}

/** The handle {@link leaderboard} returns, for callers that need to name it. */
export type Leaderboard = Awaited<ReturnType<typeof leaderboard>>;
