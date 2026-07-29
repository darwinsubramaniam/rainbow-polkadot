import { useEffect, useRef } from "react";

import type { Snapshot } from "../sim/sim";
import type { RunResult } from "../game/engine";
import type { HudIcons } from "../game/useGame";

interface Props {
  hud: Snapshot | null;
  result: RunResult | null;
  seed: string | null;
  /** Null when the art pack did not load; the HUD then stays textual. */
  icons: HudIcons | null;
}

/**
 * Read-only numbers from the running simulation.
 *
 * Fed from a snapshot sampled ~10× a second rather than every frame: the
 * simulation runs at 60Hz and re-rendering React that often would burn budget
 * the game loop needs, for numbers no one can read that fast.
 *
 * Rendered on the cabinet's chin rather than as a page panel — these numbers
 * belong to the screen above them, and the seed is the screen's provenance.
 */
export function Hud({ hud, result, seed, icons }: Props) {
  const score = result ? result.score : (hud?.score ?? 0n);
  const lives = result ? result.lives : (hud?.lives ?? 0);
  const coins = result ? result.coins : (hud?.coins ?? 0);
  const tick = result ? result.ticks : (hud?.tick ?? 0);

  /**
   * How many hearts to draw in total, so lost ones can be shown as empty.
   *
   * Observed rather than declared. The starting count lives in a private
   * constant in crates/sim and is not on the wasm ABI, so writing `3` here
   * would be a second copy of a rule that could drift the next time the
   * simulation is tuned. Lives only ever go down, so the highest seen in a run
   * is the run's maximum.
   */
  const maxLives = useRef(0);
  useEffect(() => {
    maxLives.current = 0;
  }, [seed]);
  if (lives > maxLives.current) maxLives.current = lives;

  return (
    <section className="hud">
      <span>
        <b>score</b> {String(score)}
      </span>
      <span>
        <b>lives</b>{" "}
        {icons && maxLives.current > 0 ? (
          // aria-hidden and a text label alongside: a row of background-image
          // spans is invisible to a screen reader, and the count is the point.
          <span className="icons" role="img" aria-label={`${lives} of ${maxLives.current}`}>
            {Array.from({ length: maxLives.current }, (_, i) => (
              <i key={i} style={i < lives ? icons.heart : icons.heartEmpty} aria-hidden="true" />
            ))}
          </span>
        ) : lives > 0 ? (
          "♥".repeat(lives)
        ) : (
          "—"
        )}
      </span>
      <span>
        <b>coins</b>
        {icons && <i className="icon-inline" style={icons.coin} aria-hidden="true" />}
        {coins}
      </span>
      <span>
        <b>tick</b> {tick}
      </span>
      <span className="seed">
        <b>seed</b> {seed ?? "—"}
      </span>
    </section>
  );
}
