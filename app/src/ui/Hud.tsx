import type { Snapshot } from "../sim/sim";
import type { RunResult } from "../game/engine";

interface Props {
  hud: Snapshot | null;
  result: RunResult | null;
  seed: string | null;
}

/**
 * Read-only numbers from the running simulation.
 *
 * Fed from a snapshot sampled ~10× a second rather than every frame: the
 * simulation runs at 60Hz and re-rendering React that often would burn budget
 * the game loop needs, for numbers no one can read that fast.
 */
export function Hud({ hud, result, seed }: Props) {
  const score = result ? result.score : (hud?.score ?? 0n);
  const lives = result ? result.lives : (hud?.lives ?? 0);
  const coins = result ? result.coins : (hud?.coins ?? 0);
  const tick = result ? result.ticks : (hud?.tick ?? 0);

  return (
    <section className="panel hud">
      <span>
        <b>score</b> {String(score)}
      </span>
      <span>
        <b>lives</b> {lives > 0 ? "♥".repeat(lives) : "—"}
      </span>
      <span>
        <b>coins</b> {coins}
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
