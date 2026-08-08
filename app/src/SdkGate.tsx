import { useEffect, useState, type ReactNode } from "react";
import { ProductSDKContext } from "@parity/product-sdk/react";
import { createApp } from "@parity/product-sdk/core";
import type { App } from "@parity/product-sdk/core";

import { CLOUD_STORAGE, NETWORK } from "./chain/network";

/**
 * Connect to the Product host, and get out of the way if there genuinely is not
 * one.
 *
 * Two things here are deliberate, and both are scar tissue.
 *
 * ## 1. Cloud storage must name its environment, or it takes submitting with it
 *
 * `createApp` defaults to `cloudStorage: { environment: "paseo" }` and opens a
 * connection to **Paseo Bulletin** (`0x8cfe6717…`) during construction. This
 * Product is published on the Devnet, whose Bulletin is a *different chain*
 * (`devnet_bulletin`, `0xe101f0fa…`). Polkadot Desktop does not support the
 * Paseo one, so the whole call rejected:
 *
 *     ChainNotSupportedError: Chain 0x8cfe6717… is not supported by the current
 *     host. It may not be enabled in this host build, or its genesis hash may
 *     have drifted after a network reset.
 *
 * The cost was wildly out of proportion to the cause: an unset default on a
 * service this app does not use took down the one capability it cannot do
 * without. `createApp` rejecting meant no host, which meant no signer, which
 * meant a player holding an enclave-signed attestation was told to go and land
 * it from a CLI. Asset Hub — the chain that actually matters here — was
 * supported throughout and was never implicated.
 *
 * The documented fix is to name the environment, which is what the quickstart
 * does. Per the docs, the value is silently wrong rather than loud if you omit
 * it: "your app reads and writes Bulletin on Paseo, not on this Devnet — a
 * different chain, so your data is simply not where you expect it and nothing
 * errors." Here it did error, only because Desktop declines the chain outright.
 *
 * `cloudStorage: false` also stops the crash, and this app would never notice
 * the difference — but it would leave the wrong reason on the record and break
 * the moment anything here wanted Bulletin. The fallback below is where that
 * option earns its place instead.
 *
 * ## 2. Nothing predicts whether a host exists — we try, and see
 *
 * Two earlier versions gated on a predicate and both were wrong in the
 * expensive direction. The first inferred from `window.self !== window.top`;
 * Polkadot Desktop loads the app top-level, so it reported "no host" inside a
 * real one. The second asked `isInsideContainer()`, which outside an iframe is
 * one synchronous look for a marker the host injects — asked once on mount,
 * that is a race.
 *
 * The failure is asymmetric. A false negative is silent and permanent: the app
 * quietly drops its one privileged capability and nothing looks broken. A false
 * positive is immediate and legible: `createApp` rejects and we fall back. So
 * do not ask. Call `createApp`, and treat only its rejection as absence.
 *
 * There is also no error boundary around the children any more. The old one
 * caught *anything* thrown in the subtree and reported it as "no host", which is
 * how a chain-support error came to look like a missing host for as long as it
 * did. Owning the async here means the failure is caught where it happens, with
 * its real message.
 */
interface Props {
  children: ReactNode;
  onStandalone: (reason: string) => void;
}

/** How long `createApp` may hang before we stop waiting on it. */
const CONNECT_TIMEOUT_MS = 8000;

type State =
  | { phase: "connecting" }
  | { phase: "host"; app: App }
  | { phase: "standalone" };

export function SdkGate({ children, onStandalone }: Props) {
  const [state, setState] = useState<State>({ phase: "connecting" });

  useEffect(() => {
    let settled = false;

    const standalone = (reason: string) => {
      if (settled) return;
      settled = true;
      onStandalone(reason);
      setState({ phase: "standalone" });
    };

    // A rejection we can see is handled below. This covers the one we cannot:
    // a `createApp` that never settles would otherwise leave the app showing
    // "connecting…" forever, which is worse than falling back.
    const timer = setTimeout(
      () => standalone(`host did not respond within ${CONNECT_TIMEOUT_MS}ms`),
      CONNECT_TIMEOUT_MS,
    );

    const connected = (app: App) => {
      // Already settled — by the timeout, by a rejection, or by this effect
      // being cleaned up — so nothing will ever hold this `app`. Drop it.
      //
      // Dropping genuinely leaks: `createApp` opens a host transport during
      // construction, and React StrictMode makes an abandoned one the *normal*
      // development path — the effect runs, is cleaned up, and runs again, so
      // the first `createApp` resolves after `settled` is already true.
      //
      // **There is no safe teardown to call here, and reaching for the obvious
      // one broke submitting.** `app.chain.destroyAll()` reads like an instance
      // method and is not: it delegates to a *module-level* `destroyAll()` in
      // `@parity/product-sdk-chain-client`, which empties a client registry
      // shared by every `App` in the tab. Calling it on the abandoned app
      // therefore destroys the connections the *live* one is using, and the next
      // contract call fails `Host provider is disconnected` — several steps
      // later, with nothing pointing back here. Measured, not theorised: it took
      // a working submit path to failing on every attempt.
      //
      // So the leak stays until the SDK offers per-app disposal. It costs an
      // idle transport in development and nothing in a build, where the effect
      // runs once. That is strictly cheaper than severing the one connection
      // that matters.
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setState({ phase: "host", app });
    };

    // Cloud Storage is a service this app does not use, so it must never be the
    // reason a player cannot land a score. Ask for the network's own Bulletin;
    // if the host still will not give it to us, drop the service rather than
    // the host.
    createApp({ name: "rainbow", cloudStorage: CLOUD_STORAGE })
      .then(connected)
      .catch((e: unknown) => {
        if (settled) return;
        const why = e instanceof Error ? e.message : String(e);
        createApp({ name: "rainbow", cloudStorage: false })
          .then((app) => {
            // Worth saying out loud: the app is fully usable, but anything
            // added later that touches Bulletin will find it missing.
            console.warn(
              `[rainbow] cloud storage unavailable on ${NETWORK} (${why}); continuing without it`,
            );
            connected(app);
          })
          .catch(() => {
            clearTimeout(timer);
            standalone(why);
          });
      });

    return () => {
      settled = true;
      clearTimeout(timer);
    };
    // `onStandalone` is a stable module-level function; re-running this would
    // thrash the host transport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.phase === "connecting") return <div className="boot">connecting to host…</div>;

  // Downstream reads `ProductSDKContext` directly and treats null as "no host",
  // so standalone simply renders the children with no provider above them.
  if (state.phase === "standalone") return <>{children}</>;

  return <ProductSDKContext.Provider value={state.app}>{children}</ProductSDKContext.Provider>;
}
