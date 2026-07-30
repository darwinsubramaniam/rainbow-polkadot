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
 */
const DEPLOYED: Partial<Record<Network, string>> = {
  devnet: "0x9cc62a70E0d2ed75432C3d9c1F997a122eE976a0",
};

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
