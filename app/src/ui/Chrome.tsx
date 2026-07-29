import { GitHubMark } from "./Logos";
import type { Route } from "./useHashRoute";

const REPO = "https://github.com/darwinsubramaniam/rainbow-polkadot";

/**
 * Header and footer.
 *
 * Two links and a repo — the nav is small on purpose. The play page is the
 * game and nothing else, and everything explanatory lives on one page behind
 * one link.
 */
export function SiteHeader({ route }: { route: Route }) {
  return (
    <header className="site-head">
      <div className="container">
        <a className="brand" href="#/">
          <span className="mark" aria-hidden="true" />
          Rainbow
        </a>
        <nav className="site-nav" aria-label="Main">
          <a href="#/" aria-current={route === "play" ? "page" : undefined}>
            Play
          </a>
          <a href="#/how" aria-current={route === "how" ? "page" : undefined}>
            How it works
          </a>
          <a className="icon" href={REPO} target="_blank" rel="noreferrer" title="Source on GitHub">
            <GitHubMark />
          </a>
        </nav>
      </div>
    </header>
  );
}

/**
 * Footer, following the DW3 Labs pattern: a muted band under a hairline rule,
 * columns of quiet links with mono micro-headings, then a separator and a thin
 * bottom bar carrying the legal line and a tagline.
 */
export function SiteFooter() {
  return (
    <footer className="site-foot">
      <div className="container foot-grid">
        <div className="foot-about">
          <p className="foot-brand">Rainbow</p>
          <p>
            A platformer whose score is recomputed inside a TEE and proven on-chain. Built as a proof-of-concept for
            what a Polkadot Product can do.
          </p>
          <p className="foot-warn">
            Prototype. Unaudited, actively experimental, and published for research and developer education. Running on
            the Polkadot Products Devnet — nothing here holds value.
          </p>
        </div>

        <nav className="foot-col" aria-label="Site">
          <p className="foot-head">Rainbow</p>
          <a href="#/">Play</a>
          <a href="#/how">How it works</a>
          <a className="with-icon" href={REPO} target="_blank" rel="noreferrer">
            <GitHubMark />
            GitHub
          </a>
        </nav>

        <nav className="foot-col" aria-label="Built with">
          <p className="foot-head accent">Built with</p>
          <a href="https://polkadot.com" target="_blank" rel="noreferrer">
            Polkadot
          </a>
          <a href="https://acurast.com" target="_blank" rel="noreferrer">
            Acurast
          </a>
          <a href="https://dw3labs.com" target="_blank" rel="noreferrer">
            DW3 Labs
          </a>
        </nav>
      </div>

      <div className="foot-rule" />

      <div className="container foot-bar">
        <span>© 2026 DW3 Labs</span>
        <span className="tagline">Deterministic · Attested · Open source</span>
      </div>
    </footer>
  );
}
