// React binding for the Pixi game.
//
// The split is deliberate: React owns the chrome (session panel, HUD numbers,
// log), and PixiJS owns the play surface, driven imperatively. Reconciling a
// scene graph through React at sixty ticks a second would put a diffing pass in
// the middle of a fixed-timestep loop that has to stay exact — the tick count is
// the clock the enclave replays against, so nothing may perturb its pacing.
//
// React therefore never sees a frame. It sees a throttled snapshot for the HUD
// and the final result when the run ends.

import { useCallback, useEffect, useRef, useState } from "react";

import { Sim, type Snapshot } from "../sim/sim";
import { playerColorFor } from "./artFrames";
import { loadArt, type Art } from "./assets";
import { Engine, type RunResult } from "./engine";
import { Renderer } from "./renderer";
import { loadSound, type Sound } from "./sound";

// Served from public/, so it is resolved against the document rather than
// imported as a module. `BASE_URL` is "./" here, which is what lets the bundle
// work from the gateway's client-side resolver instead of an origin root.
const WASM_URL = `${import.meta.env.BASE_URL}sim.wasm`;

/** HUD refresh rate. Sixty React renders a second would be wasteful. */
const HUD_INTERVAL_MS = 100;

/** On-screen size of a HUD icon, to sit with the HUD's 0.8rem monospace. */
const ICON_PX = 16;

/**
 * The HUD's icons as inline CSS, or null when the art pack did not load.
 *
 * Computed once at boot rather than per render: the atlas rects never change,
 * and these end up in the style prop of elements that re-render ten times a
 * second while a run is going.
 */
export interface HudIcons {
  heart: Record<string, string>;
  heartEmpty: Record<string, string>;
  coin: Record<string, string>;
}

export interface GameState {
  ready: boolean;
  error: string | null;
  hud: Snapshot | null;
  result: RunResult | null;
  /**
   * Whether the art pack loaded.
   *
   * False means the game is drawing from primitives. That is a supported way to
   * play, not an error — `error` stays null — but it is worth surfacing so a
   * sandbox that will not serve `public/art/` is diagnosable from the UI rather
   * than only from the console.
   */
  art: boolean;
  /** Null whenever `art` is false, so the HUD falls back to plain text. */
  icons: HudIcons | null;
}

/**
 * @param address The connected account, or null. Only used to pick which of the
 *   pack's five characters the player is drawn as, so the same account always
 *   gets the same one. Nothing derived from it reaches the input log or the
 *   score — see `playerColorFor`.
 */
export function useGame(
  mountRef: React.RefObject<HTMLDivElement | null>,
  address: string | null = null,
) {
  const engineRef = useRef<Engine | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const simRef = useRef<Sim | null>(null);
  const artRef = useRef<Art | null>(null);
  const soundRef = useRef<Sound | null>(null);
  const lastHudRef = useRef(0);

  const [state, setState] = useState<GameState>({
    ready: false,
    error: null,
    hud: null,
    result: null,
    art: false,
    icons: null,
  });

  // -- boot ----------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const mount = mountRef.current;
        if (!mount) return;

        // Both fetches go out together: the art is ~260 KB served from the same
        // place as sim.wasm, and serialising them would add a round trip to a
        // boot the player is already waiting on.
        //
        // Art must be resolved *before* `ready`, not streamed in behind it.
        // `engine.ts` clamps catch-up to MAX_CATCHUP_MS, so decoding four
        // atlases part-way through a run would be paid for by dropping
        // simulation ticks — a visible hitch, during which the input log keeps
        // recording whatever the player was holding.
        //
        // `loadArt` resolves to null rather than rejecting, so a failed pack
        // cannot take the game down with it.
        // Sound joins the same round of fetches. Like the art it resolves to
        // null rather than rejecting, so a browser that refuses audio — or a
        // sandbox that will not serve the .ogg files — costs the game nothing
        // but its sound.
        const [sim, art, sound] = await Promise.all([
          Sim.load(WASM_URL),
          loadArt(),
          loadSound(),
        ]);
        const renderer = await Renderer.create(mount, art);

        // StrictMode double-invokes effects in development; without this the
        // second pass would leave an orphaned WebGL context and canvas behind.
        if (cancelled) {
          renderer.destroy();
          sim.dispose();
          art?.destroy();
          sound?.destroy();
          return;
        }

        simRef.current = sim;
        artRef.current = art;
        soundRef.current = sound;
        rendererRef.current = renderer;
        engineRef.current = new Engine(sim, renderer);
        setState((s) => ({
          ...s,
          ready: true,
          art: art !== null,
          icons: art && {
            heart: art.cssIcon("hud_heart", ICON_PX),
            heartEmpty: art.cssIcon("hud_heart_empty", ICON_PX),
            coin: art.cssIcon("hud_coin", ICON_PX),
          },
        }));
      } catch (e) {
        if (!cancelled) {
          setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
        }
      }
    })();

    return () => {
      cancelled = true;
      engineRef.current?.destroy();
      rendererRef.current?.destroy();
      // The renderer does not own the pack, so its GPU textures are freed here
      // with everything else rather than being left behind by a remount.
      artRef.current?.destroy();
      soundRef.current?.destroy();
      engineRef.current = null;
      rendererRef.current = null;
      simRef.current = null;
      artRef.current = null;
      soundRef.current = null;
    };
  }, [mountRef]);

  // -- player character ----------------------------------------------------
  //
  // Its own effect, and deliberately not a dependency of the boot effect above:
  // connecting a wallet mid-session would otherwise tear down the WebGL context
  // and reload sim.wasm to change the colour of a sprite.
  useEffect(() => {
    rendererRef.current?.setPlayerColor(playerColorFor(address));
  }, [address, state.ready]);

  // -- keyboard ------------------------------------------------------------
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // Space and the arrows scroll the page otherwise, which is jarring mid-run.
      if (engineRef.current?.handleKey(e.code, true)) e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      if (engineRef.current?.handleKey(e.code, false)) e.preventDefault();
    };
    // Losing focus with a key held would keep writing that button into the
    // input log, and the enclave would faithfully replay it.
    const blur = () => engineRef.current?.releaseAll();

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", blur);
    };
  }, []);

  const start = useCallback((seed: bigint) => {
    const engine = engineRef.current;
    if (!engine) return;

    setState((s) => ({ ...s, result: null }));
    lastHudRef.current = 0;

    // This runs inside the click that started the run, which is the user
    // gesture browsers require before audio may play.
    soundRef.current?.unlock();
    soundRef.current?.reset();
    soundRef.current?.play("select");

    engine.start(
      seed,
      (snap) => {
        // Every frame, before the HUD throttle below: a cue missed is a cue
        // gone, and a coin taken between two HUD samples would be silent.
        soundRef.current?.observe(snap);

        const now = performance.now();
        if (now - lastHudRef.current < HUD_INTERVAL_MS) return;
        lastHudRef.current = now;
        setState((s) => ({ ...s, hud: snap }));
      },
      (result) => setState((s) => ({ ...s, hud: null, result })),
    );
  }, []);

  const press = useCallback((k: "left" | "right" | "jump", down: boolean) => {
    engineRef.current?.setKey(k, down);
  }, []);

  /**
   * Mute or unmute.
   *
   * Applied to the sound module rather than held in React state, so toggling it
   * mid-run does not re-render anything on the loop's path. The caller owns the
   * persisted preference.
   */
  const setMuted = useCallback((muted: boolean) => {
    soundRef.current?.setMuted(muted);
  }, []);

  return { ...state, start, press, setMuted };
}
