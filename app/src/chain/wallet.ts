// Wallet access for contract calls.
//
// The React `useWallet` hook is fine for showing an account, but it exposes no
// `PolkadotSigner` — and `createContract` needs one (via a `SignerManager`) to
// build a transaction. So the manager is owned here directly, which is also the
// shape the SDK's own contract examples use.

import { DevProvider, SignerManager } from "@parity/product-sdk/wallet";
import { useSyncExternalStore } from "react";

/**
 * The host manager: the real path, used whenever the app runs as a Product.
 *
 * One module-level instance. Connection state and the selected account are
 * genuinely global, and a per-component manager would open competing host
 * connections.
 */
const hostManager = new SignerManager({ dappName: "Rainbow" });

/**
 * Development fallback — **dev builds only**.
 *
 * Outside the Polkadot host there is no wallet to lend a signer, so a plain
 * `npm run dev` would stop at "connect an account" and nothing below it could
 * be exercised — including the parts worth testing locally, which are the game
 * and the enclave round-trip. This provides well-known dev accounts instead.
 *
 * It is a genuine fallback, not a mode switch: the host is always tried first,
 * so being inside a Product is never mistaken for local development. Note that
 * a dev account cannot land a real submission — `//Alice` holds nothing on
 * Asset Hub and is not mapped for `pallet-revive` — so on-chain writes still
 * require the host. Play and attestation work either way.
 *
 * Gated on `import.meta.env.DEV`, which Vite replaces with `false` at build
 * time. Rollup then drops this branch, the SDK's `DevProvider`, and the
 * `@parity/product-sdk-keys` seed derivation it reaches — both SDK packages
 * declare `"sideEffects": false`, and `DevProvider`'s only heavy import is
 * used solely inside its own `connect()`, so the whole graph goes.
 *
 * That is not tidiness. A Product that ships its own keypair generation
 * alongside the host's signer is, from the outside, indistinguishable from one
 * that does not use the host at all — which is exactly what a review will say
 * about it. The published bundle should contain no signing path but the host's.
 */
const devManager: SignerManager | null = import.meta.env.DEV
  ? new SignerManager({
      dappName: "Rainbow (dev)",
      createProvider: () => new DevProvider({ names: ["Alice", "Bob"] }),
      // Persist to the browser's own storage. The default reaches for *host*
      // storage inside a container, and this manager exists precisely for the
      // case where there is no host — so the default would fail for the same
      // reason the SDK provider does.
      persistence: globalThis.localStorage,
    })
  : null;

// In a build `devManager` is `null`, so this can only ever be `hostManager`.
// That is what makes `submit.ts`'s `currentManager().getProductAccount(...)`
// host-routed by construction rather than by convention.
let active: SignerManager = hostManager;

/** The manager that successfully connected. Passed to `createContract`. */
export const currentManager = (): SignerManager => active;

export type WalletMode = "host" | "dev";
let mode: WalletMode = "host";
export const walletMode = (): WalletMode => mode;

/**
 * Subscribe React to the active manager's state.
 *
 * `useSyncExternalStore` rather than `useState` + an effect: the manager mutates
 * synchronously inside the call stack that triggered it, and this is the hook
 * built for exactly that, without tearing under concurrent rendering.
 *
 * Both managers are subscribed, because which one is active can change when the
 * host connection fails and the dev fallback takes over. In a build there is no
 * second manager, so the optional calls below collapse to the host alone.
 */
export function useSignerState() {
  return useSyncExternalStore(
    (cb) => {
      const a = hostManager.subscribe(cb);
      const b = devManager?.subscribe(cb);
      return () => {
        a();
        b?.();
      };
    },
    () => active.getState(),
    () => active.getState(),
  );
}

async function tryConnect(manager: SignerManager): Promise<Error | null> {
  try {
    // The manager reports failure on the `err` channel instead of throwing.
    // Skipping this check leaves a null signer and no error to explain it.
    const result = await manager.connect();
    if (!result.ok) return result.error;

    const [first] = result.value;
    if (!first) return new Error("no accounts returned");

    if (!manager.getState().selectedAccount) {
      manager.selectAccount(first.address);
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

/** Connect: the Product host if there is one, otherwise dev accounts. */
export async function connectWallet(): Promise<WalletMode> {
  const hostError = await tryConnect(hostManager);
  if (!hostError) {
    active = hostManager;
    mode = "host";
    return "host";
  }

  // A build has no second manager. Report the host failure — the only real one
  // — rather than degrading to a signer that could not land a submission
  // anyway, under a message that says the host is missing when it is merely
  // unreachable.
  if (!devManager) throw hostError;

  const devError = await tryConnect(devManager);
  if (devError) {
    // Report the host failure: that is the one that matters when this really is
    // running as a Product, and the dev failure would only mislead.
    throw hostError;
  }

  active = devManager;
  mode = "dev";
  return "dev";
}
