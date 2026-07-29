// Sound effects, driven entirely by watching the simulation's own numbers.
//
// The rule this module exists to respect: nothing here may reach the game loop.
// `engine.ts` records the input log that the enclave replays, and a run is only
// accepted if the enclave computes the same score from it. So audio observes,
// and never participates:
//
//   * No hook in `engine.ts`. Cues are recovered from consecutive snapshots —
//     the coin count went up, a life went away, the player left the ground
//     moving upward. Everything audible is already visible.
//   * Nothing is awaited on the loop's path. `observe` does a handful of
//     integer comparisons and, at most, starts a buffer playing; decoding
//     happened at boot.
//   * A failure to load, decode, or play is silent. A browser that refuses
//     audio still has a playable, attestable game.
//
// WebAudio rather than <audio> elements: several cues can overlap — a coin
// while landing on an enemy — and one AudioBuffer can be played any number of
// times concurrently, where an HTMLAudioElement has to be cloned or restarted.

import { SFX_FILES, type Cue } from "./artFrames";
import type { Snapshot } from "../sim/sim";

const SFX_BASE = `${import.meta.env.BASE_URL}art/sfx/`;

/** Headroom so the effects sit under, rather than over, the player's music. */
const GAIN = 0.55;

export interface Sound {
  /**
   * Start the audio clock. Must be called from inside a user gesture.
   *
   * Browsers create an AudioContext in a suspended state and only allow it to
   * resume in response to a real interaction. Decoding works while suspended,
   * so everything is ready by the time this is called from the Play button.
   */
  unlock(): void;
  setMuted(muted: boolean): void;
  /** Play a cue directly — for UI, where there is no snapshot to diff. */
  play(cue: Cue): void;
  /**
   * Diff this frame's snapshot against the last and play what changed.
   *
   * Called once per rendered frame, which may span several simulation ticks.
   * Two coins taken inside one frame are one sound, which is right: they were
   * one event as far as the player perceived it.
   */
  observe(s: Snapshot): void;
  /** Forget the previous snapshot, at the start of a run. */
  reset(): void;
  destroy(): void;
}

/**
 * Load and decode every cue.
 *
 * Never throws. A null return means the game runs silently.
 */
export async function loadSound(): Promise<Sound | null> {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch (e) {
    console.warn("audio unavailable, running silently:", e);
    return null;
  }

  const gain = ctx.createGain();
  gain.gain.value = GAIN;
  gain.connect(ctx.destination);

  const buffers = new Map<Cue, AudioBuffer>();
  let muted = false;

  try {
    await Promise.all(
      Object.entries(SFX_FILES).map(async ([cue, file]) => {
        const res = await fetch(`${SFX_BASE}${file}`);
        if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
        buffers.set(cue as Cue, await ctx.decodeAudioData(await res.arrayBuffer()));
      }),
    );
  } catch (e) {
    console.warn("audio unavailable, running silently:", e);
    void ctx.close().catch(() => {});
    return null;
  }

  // The previous frame, for edge detection. Null before the first frame of a
  // run, which is what stops a fresh run from firing every cue at once as the
  // counters jump from their end-of-last-run values.
  let last: Snapshot | null = null;

  const fire = (cue: Cue): void => {
    if (muted || ctx.state !== "running") return;
    const buffer = buffers.get(cue);
    if (!buffer) return;
    // A BufferSource is single-use by design; this is the intended pattern and
    // the node is collected once it has finished.
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(gain);
    src.start();
  };

  return {
    unlock() {
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    },
    setMuted(next) {
      muted = next;
    },
    play(cue) {
      fire(cue);
    },
    reset() {
      last = null;
    },
    observe(s) {
      const prev = last;
      last = s;
      if (!prev) return;

      // Coins: the simulation's running total, so this survives a coin being
      // taken on the same frame as anything else.
      if (s.coins > prev.coins) fire("coin");

      // An enemy leaving the field can only be one the player landed on.
      if (s.enemies.length < prev.enemies.length) fire("stomp");

      // Losing a life. Checked before the jump edge below, because being hurt
      // also launches the player off the ground.
      if (s.lives < prev.lives) {
        fire("hurt");
      } else if (prev.onGround && !s.onGround && s.vy < 0) {
        // Left the ground moving upward. Walking off a ledge is also a
        // ground-to-air transition, but that one is falling — vy is positive.
        fire("jump");
      }

      if (s.won && !prev.won) fire("win");
    },
    destroy() {
      buffers.clear();
      void ctx.close().catch(() => {});
    },
  };
}
