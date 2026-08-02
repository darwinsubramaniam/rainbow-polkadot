import type { Action } from "./processor";

/**
 * Whatever the Processor's situation currently offers, rendered the same way
 * wherever it is offered — on the cabinet and in the diagram's Processor box.
 *
 * Two shapes, and which one an action takes is decided by whether it carries a
 * `pressed` state rather than by the caller:
 *
 * - a **switch** for the simulator, because it is a setting that is on or off
 *   and stays where it is put. Drawn as the track-and-knob every phone already
 *   teaches, so the state is legible from the position of the knob and not only
 *   from the words. `role="switch"` with `aria-checked` is the same statement
 *   for a screen reader; a `<button>` carries it rather than a checkbox because
 *   this takes effect on press, with no form to submit.
 * - a **plain button** for "Check verifier", which does something once and has
 *   no state to be in.
 *
 * The label does not repeat the state — no "Simulation: on" beside a knob that
 * already says so, which is two things to keep in agreement and one of them
 * redundant.
 */
export function ActionButtons({ actions }: { actions: readonly Action[] }) {
  return (
    <>
      {actions.map((a) =>
        a.pressed === undefined ? (
          <button key={a.label} type="button" className="ghost" onClick={a.onClick}>
            {a.label}
          </button>
        ) : (
          <button
            key={a.label}
            type="button"
            className="switch"
            role="switch"
            aria-checked={a.pressed}
            onClick={a.onClick}
          >
            <span className="switch-track" aria-hidden="true">
              <span className="switch-knob" />
            </span>
            {a.label}
          </button>
        ),
      )}
    </>
  );
}
