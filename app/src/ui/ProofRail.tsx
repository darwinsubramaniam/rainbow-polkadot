export type StepState = "idle" | "active" | "done" | "failed";

export interface Step {
  /** Two or three words, for the stepper under the game. */
  short: string;
  /** The full claim, used as the hover title. */
  what: string;
  why: string;
  state: StepState;
}

/**
 * The proof trace, as a stepper.
 *
 * The six things that have to happen before a number is allowed onto the
 * leaderboard. It reads left to right under the game rather than down a
 * column beside it — the game should get the width, and this only needs to
 * answer "where am I". The full argument for each step is on the write-up
 * page; here it is the hover title.
 */
export function ProofRail({ steps }: { steps: Step[] }) {
  return (
    <ol className="rail">
      {steps.map((s, i) => (
        <li key={s.short} className={s.state} title={`${s.what} — ${s.why}`}>
          <span className="pip" aria-hidden="true">
            {s.state === "done" ? "✓" : s.state === "failed" ? "✕" : String(i + 1).padStart(2, "0")}
          </span>
          <span className="what">{s.short}</span>
          <span className="sr">{s.what}</span>
        </li>
      ))}
    </ol>
  );
}
