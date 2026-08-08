/// <reference types="vite/client" />

// Replaced with a literal by `vite.config.ts`'s `define`. Typed through
// `src/build.ts` rather than used raw, so the shape has one owner.
declare const __BUILD__: import("./build").BuildStamp;

// The descriptors package ships per-chain subpath exports whose generated types
// are not visible to `moduleResolution: bundler` in every layout. Declaring the
// one this app uses keeps the build honest without loosening `strict`.
declare module "@parity/product-sdk-descriptors/devnet-asset-hub" {
  import type { ChainDefinition } from "polkadot-api";
  export const devnet_asset_hub: ChainDefinition;
}

// The gas-sizing A/B in `chain/submit.ts`. Unset means "send no gasLimit",
// which is what ships; see the long note on `WEIGHT_BUFFER_PERCENT` for why
// this is an environment variable rather than an edit.
interface ImportMetaEnv {
  readonly VITE_WEIGHT_BUFFER?: string;
}
