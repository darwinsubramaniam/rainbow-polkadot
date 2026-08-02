import { ActionButtons } from "./ActionButtons";
import type { ProcessorState } from "./processor";

/**
 * What the Processor is doing, said on the cabinet.
 *
 * The diagram already says this, and says it better — but it says it a long way
 * down the page, and on a narrow screen it is not drawn at all. What replaces it
 * there is the rail: the same six steps, and no controls. So the one situation
 * that actually strands a player — an account connected, the deployed Processor
 * not answering, and the only route into the in-tab enclave behind a gear icon
 * on a stage they are not looking at — had no visible way out on a phone. They
 * would press Play and be told it failed.
 *
 * This is that way out, put where it cannot be missed and at every width: a
 * strip between the picture and the HUD, inside the element that goes
 * fullscreen. It covers no part of the game, and it is absent whenever the
 * deployed Processor is answering and being used.
 *
 * Deliberately the same on desktop, where the diagram offers the same two
 * buttons further down. Saying it twice is the lesser cost: the diagram is
 * off-screen for as long as anyone is playing, which is exactly when the job
 * ending is discovered.
 */
export function StageNotice({ state }: { state: ProcessorState }) {
  if (!state.notice) return null;

  return (
    <div className={`stage-notice n-${state.tone}`} role="status">
      <span className="dot" aria-hidden="true" />
      <span className="stage-notice-text">{state.notice}</span>
      {state.actions.length > 0 && (
        <span className="stage-notice-actions">
          <ActionButtons actions={state.actions} />
        </span>
      )}
    </div>
  );
}
