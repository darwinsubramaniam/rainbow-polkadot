/// <reference types="vite/client" />

// The descriptors package ships per-chain subpath exports whose generated types
// are not visible to `moduleResolution: bundler` in every layout. Declaring the
// one this app uses keeps the build honest without loosening `strict`.
declare module "@parity/product-sdk-descriptors/devnet-asset-hub" {
  import type { ChainDefinition } from "polkadot-api";
  export const devnet_asset_hub: ChainDefinition;
}
