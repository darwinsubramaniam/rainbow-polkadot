import { Play } from "./Play";
import { HowItWorks } from "./pages/HowItWorks";
import { SiteFooter, SiteHeader } from "./ui/Chrome";
import { useHashRoute } from "./ui/useHashRoute";

/**
 * The shell: header, page, footer.
 *
 * `Play` stays mounted only while it is the current route — unmounting it tears
 * down the Pixi application and the wasm instance with it, which is the correct
 * behaviour when the reader has navigated away from the game.
 */
export function App() {
  const route = useHashRoute();

  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <SiteHeader route={route} />
      <main id="main">{route === "how" ? <HowItWorks /> : <Play />}</main>
      <SiteFooter />
    </div>
  );
}
