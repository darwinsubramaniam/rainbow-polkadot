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
 * Development fallback.
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
 */
const devManager = new SignerManager({
  dappName: "Rainbow (dev)",
  createProvider: () => new DevProvider({ names: ["Alice", "Bob"] }),
  // Persist to the browser's own storage. The default reaches for *host*
  // storage inside a container, and this manager exists precisely for the case
  // where there is no host — so the default would fail for the same reason the
  // SDK provider does.
  persistence: globalThis.localStorage,
});

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
 * host connection fails and the dev fallback takes over.
 */
export function useSignerState() {
  return useSyncExternalStore(
    (cb) => {
      const a = hostManager.subscribe(cb);
      const b = devManager.subscribe(cb);
      return () => {
        a();
        b();
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
