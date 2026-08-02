import type { Health } from "../chain/health";

/**
 * What the Acurast Processor is doing, and what can be done about it.
 *
 * Derived here rather than at either place that shows it, because there are now
 * two: the Processor box in the diagram, and the strip on the cabinet. Both have
 * to offer the same way out of the same dead end, and a second copy of this
 * ladder would drift — the diagram would learn that the job is back while the
 * cabinet still said it was down, over one machine with one status.
 *
 * The four situations are the whole of it, and the order below is the order they
 * have to be tested in. Note what none of them claims: this is liveness only.
 * Something answering `/identity` is not something the contract trusts, which is
 * a separate fact with a separate failure — see `chain/health.ts`.
 */
export interface Action {
  label: string;
  /**
   * Set when the control is a switch rather than a one-shot: whether it is
   * currently on. Both places that render an action turn this into
   * `role="switch"` with a sliding knob, and render a plain button when it is
   * undefined — which is what makes "Check verifier" read as something you do
   * and "Simulation" as something that is in a state.
   *
   * The state is therefore in the position of the knob, not in the words, so
   * the label stays "Simulation" in both. Nothing here is the site's primary
   * button any more either: a blue slab labelled with a state is ambiguous
   * about whether it reports that state or moves to it, so the recommendation
   * lives in the sentence beside the control.
   */
  pressed?: boolean;
  onClick: () => void;
}

export interface ProcessorState {
  /** How it is doing. Colours the dot in both places. */
  tone: Health;
  /** A word or two, for the status line inside the diagram's box. */
  text: string;
  /**
   * The same situation as a sentence, for the cabinet — or null when there is
   * nothing worth interrupting a player for. Absent whenever the deployed
   * Processor is answering and being used, which is most of the time.
   */
  notice: string | null;
  /** Whatever the current situation offers, in the order to offer it. */
  actions: Action[];
}

export interface ProcessorStateInput {
  /** Liveness of the real Processor — probed even while simulating. */
  health: Health;
  /** Whether the enclave is currently being simulated in this tab. */
  simulated: boolean;
  /**
   * True when the tier gives no choice about that — a guest, who has no account
   * to open a session with the deployed enclave. The Processor is then not
   * probed at all, so nothing here may report on it either way.
   */
  simulationForced: boolean;
  onRecheck: () => void;
  onToggleSimulation: () => void;
}

const HEALTH_TEXT: Record<Health, string> = {
  unknown: "",
  checking: "checking…",
  online: "online",
  offline: "not answering",
};

export function processorState({
  health,
  simulated,
  simulationForced,
  onRecheck,
  onToggleSimulation,
}: ProcessorStateInput): ProcessorState {
  // A guest never probes the Processor, so nothing here may claim it is down.
  // Saying "still down" about a machine nobody looked at is the same class of
  // mistake as claiming a step reached the chain: it reads as a measurement and
  // is not one. No notice either — a guest has no second endpoint to be
  // offered, so there is no decision to interrupt them with.
  if (simulationForced) {
    return { tone: "unknown", text: "Processor: not checked", notice: null, actions: [] };
  }

  if (simulated) {
    const back = health === "online";
    return {
      tone: back ? "online" : "unknown",
      text: back
        ? "Processor is back"
        : health === "checking"
          ? "Processor: checking…"
          : "Processor still down",
      // One line each, because this sits on the cabinet above the game and a
      // paragraph there is a paragraph nobody reads. What a simulated run cannot
      // do is said where it is decided: the ⑥ arrow in the diagram is struck
      // through, and the run is filed under its own history.
      //
      // The first branch is the whole point of probing while simulating: the
      // moment the job is back the player can be told, and shown the way out.
      // Without it, switching the simulator on is a one-way door — the app stops
      // asking, and nobody has a reason to ever switch it off.
      notice: back
        ? "The verifier is answering again — switch simulation off to play for the leaderboard."
        : "Running in simulation mode because the verifier cannot be reached.",
      actions: [
        // Always offered, so nobody has to sit out the fifteen-minute probe
        // interval to find out the job has been restarted.
        { label: "Check verifier", onClick: onRecheck },
        // Always offered too, and always the same control in the same place.
        // Being in the simulator is a choice, and a choice you cannot reverse is
        // a trap — which is what two differently-worded buttons appearing in
        // different situations amounted to. One toggle, showing where it is.
        { label: "Simulation", pressed: true, onClick: onToggleSimulation },
      ],
    };
  }

  if (health === "offline") {
    return {
      tone: "offline",
      text: HEALTH_TEXT.offline,
      notice: "The verifier cannot be reached. Continue Playing with simulated verifer. Sorry for inconvenience",
      actions: [
        { label: "Check again", onClick: onRecheck },
        { label: "Simulation", pressed: false, onClick: onToggleSimulation },
      ],
    };
  }

  return { tone: health, text: HEALTH_TEXT[health], notice: null, actions: [] };
}
