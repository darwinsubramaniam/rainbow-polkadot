import type { ReactNode } from "react";

import { AcurastMark, DeviceMark, PolkadotMark, UserMark } from "./Logos";

export type StepState = "idle" | "active" | "done" | "failed";

/**
 * Where a step happens.
 *
 * Four actors, and the whole architecture is which of them is doing the work:
 * the player, the app in their browser, the Acurast Processor holding the
 * verifier, and the leaderboard contract. Naming the venue under each step is
 * what turns six pieces of jargon into a story — "Seed issued" says nothing on
 * its own, "Seed issued / Acurast Processor" says the seed came from somewhere
 * the player does not control, which is the entire point of the project.
 */
export type Venue = "you" | "app" | "handoff" | "processor" | "chain";

const VENUES: Record<Venue, { mark: ReactNode; label: string }> = {
  you: { mark: <UserMark />, label: "You, in this app" },
  app: { mark: <DeviceMark />, label: "This app" },
  // The mark is the destination rather than the sender: the arrow already says
  // it left here, and the Processor is the fact worth recognising.
  handoff: { mark: <AcurastMark />, label: "App → Processor" },
  processor: { mark: <AcurastMark />, label: "Acurast Processor" },
  chain: { mark: <PolkadotMark />, label: "Leaderboard contract" },
};

/**
 * A stable name for each step, so the flow diagram can find the one it wants.
 *
 * The diagram maps steps onto arrows between four parties, which is not the
 * order they are declared in — and matching on the display label would mean a
 * copy edit silently unwires an arrow.
 */
export type StepId = "account" | "seed" | "run" | "log" | "signed" | "chain";

export interface Step {
  id: StepId;
  /** Two or three words, for the stepper under the game. */
  short: string;
  /** Which of the four actors does this one. */
  where: Venue;
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
 *
 * Each step also carries its venue, because the sequence alone never explained
 * the thing worth explaining: three of these happen somewhere the player has
 * no control over, and that is why the score means anything.
 */
export function ProofRail({ steps }: { steps: Step[] }) {
  return (
    <ol className="rail">
      {steps.map((s, i) => {
        const venue = VENUES[s.where];
        return (
          <li key={s.id} className={s.state} title={`${venue.label} — ${s.what}. ${s.why}`}>
            <span className="pip" aria-hidden="true">
              {s.state === "done" ? "✓" : s.state === "failed" ? "✕" : String(i + 1).padStart(2, "0")}
            </span>
            <span className="what">{s.short}</span>
            {/* Decorative here: the marks sit directly beside the name of the
                thing they stand for, so announcing them would say it twice. */}
            <span className="where">
              <span className="glyph" aria-hidden="true">
                {venue.mark}
              </span>
              {venue.label}
            </span>
            <span className="sr">{s.what}</span>
          </li>
        );
      })}
    </ol>
  );
}
