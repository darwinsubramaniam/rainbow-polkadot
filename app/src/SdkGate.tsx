import { Component, useEffect, useState, type ReactNode } from "react";
import { ProductSDKProvider } from "@parity/product-sdk/react";
import { isInsideContainer } from "@parity/product-sdk/host";

/**
 * Mount the Product SDK when there is a host, and get out of the way when there
 * is not.
 *
 * `ProductSDKProvider` calls `createApp`, which throws "Host storage
 * unavailable" outside the container. The provider sits above the whole tree, so
 * that failure would take the app down with it — including the game and the
 * enclave round-trip, neither of which needs a host.
 *
 * Detection uses the SDK's own `isInsideContainer()`, which knows about both
 * Polkadot Browser and Polkadot Desktop.
 *
 * An earlier version inferred this from `window.self !== window.top`, reasoning
 * that a Product is delivered into a cross-origin iframe — which E0.1 measured,
 * but only on the *web gateway*. Polkadot Desktop loads the app top-level, so
 * that check reported "no host" inside a real host and silently disabled
 * submitting. Hence: ask the SDK, never infer from the frame.
 */
interface Props {
  children: ReactNode;
  onStandalone: (reason: string) => void;
}

type Mode = "detecting" | "host" | "standalone";

export function SdkGate({ children, onStandalone }: Props) {
  const [mode, setMode] = useState<Mode>("detecting");

  useEffect(() => {
    let cancelled = false;

    const standalone = (reason: string) => {
      if (cancelled) return;
      onStandalone(reason);
      setMode("standalone");
    };

    isInsideContainer()
      .then((inside) => {
        if (cancelled) return;
        if (inside) setMode("host");
        else standalone("not running inside a host container");
      })
      // A detection failure is not proof of absence, but there is nothing else
      // to go on, and the boundary below still covers a host that appears later.
      .catch((e: unknown) => standalone(e instanceof Error ? e.message : String(e)));

    return () => {
      cancelled = true;
    };
    // `onStandalone` is a stable module-level function; re-running detection on
    // every render would thrash the host transport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (mode === "detecting") return <div className="boot">detecting host…</div>;
  if (mode === "standalone") return <>{children}</>;

  return <SdkBoundary onFail={onStandalone}>{children}</SdkBoundary>;
}

/**
 * Backstop for the case detection cannot cover: the host says it is there but
 * `createApp` fails anyway. Without this the app would render nothing at all.
 *
 * The boundary owns the provider rather than wrapping it from outside. If it
 * merely wrapped, recovering would re-render the same failing provider, and the
 * fallback would never actually drop it.
 */
interface BoundaryProps {
  children: ReactNode;
  onFail: (reason: string) => void;
}

class SdkBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  componentDidCatch(error: Error) {
    if (this.state.failed) return;
    this.props.onFail(error.message);
    this.setState({ failed: true });
  }

  render() {
    // Without the provider, downstream reads `ProductSDKContext` and gets null
    // rather than throwing.
    if (this.state.failed) return <>{this.props.children}</>;

    return (
      <ProductSDKProvider name="rainbow" fallback={<div className="boot">starting…</div>}>
        {this.props.children}
      </ProductSDKProvider>
    );
  }
}
