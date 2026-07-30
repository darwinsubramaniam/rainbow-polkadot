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

/**
 * The leaderboard contract on this network.
 *
 * Overridable with `VITE_CONTRACT` so a redeploy does not need a code change.
 * Only devnet has an address today; the others are deliberately absent rather
 * than guessed, so a premature paseo build fails loudly here instead of sending
 * transactions to an address that means nothing on that chain.
 *
 * Redeployed 2026-07-30 to add the board views (`playerCount`, `board`), which
 * the previous address does not have — it answers `best` correctly and reverts
 * on anything a leaderboard needs.
 *
 * Changing this address is never only a client change. The EIP-712 domain names
 * `verifyingContract`, so the enclave's signature is bound to whichever address
 * *it* was configured with: the same claim yields digest `0x10e24cc4…` here and
 * `0x477d099a…` on the old deployment, both read from the two live contracts. An
 * attestation signed for one is refused by the other as `BadAttestation`. The
 * Acurast job's `CONTRACT` env must therefore move in step with this constant.
 */
const DEPLOYED: Partial<Record<Network, string>> = {
  devnet: "0x891548f5268FA27B68553eb4841f9246b38A16fA",
};

/**
 * The dotNS name this Product is published under.
 *
 * Not cosmetic: it is half of a `ProductAccountId` (`{dotNsIdentifier,
 * derivationIndex}`), so it identifies the account the host derives for us and
 * sponsors. Getting it wrong yields a different account with no allowance.
 */
export const PRODUCT_NAME = import.meta.env.VITE_PRODUCT_NAME ?? "dw3labsgame.dot";

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

export const CONTRACT: string = (() => {
  const override = import.meta.env.VITE_CONTRACT;
  if (override) return override;
  const known = DEPLOYED[NETWORK];
  if (!known) {
    throw new Error(
      `no leaderboard contract recorded for "${NETWORK}" — deploy one and pass VITE_CONTRACT`,
    );
  }
  return known;
})();
