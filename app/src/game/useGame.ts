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
import { Engine, type RunResult } from "./engine";
import { Renderer } from "./renderer";

// Served from public/, so it is resolved against the document rather than
// imported as a module. `BASE_URL` is "./" here, which is what lets the bundle
// work from the gateway's client-side resolver instead of an origin root.
const WASM_URL = `${import.meta.env.BASE_URL}sim.wasm`;

/** HUD refresh rate. Sixty React renders a second would be wasteful. */
const HUD_INTERVAL_MS = 100;

export interface GameState {
  ready: boolean;
  error: string | null;
  hud: Snapshot | null;
  result: RunResult | null;
}

export function useGame(mountRef: React.RefObject<HTMLDivElement | null>) {
  const engineRef = useRef<Engine | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const simRef = useRef<Sim | null>(null);
  const lastHudRef = useRef(0);

  const [state, setState] = useState<GameState>({
    ready: false,
    error: null,
    hud: null,
    result: null,
  });

  // -- boot ----------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const mount = mountRef.current;
        if (!mount) return;

        const sim = await Sim.load(WASM_URL);
        const renderer = await Renderer.create(mount);

        // StrictMode double-invokes effects in development; without this the
        // second pass would leave an orphaned WebGL context and canvas behind.
        if (cancelled) {
          renderer.destroy();
          sim.dispose();
          return;
        }

        simRef.current = sim;
        rendererRef.current = renderer;
        engineRef.current = new Engine(sim, renderer);
        setState((s) => ({ ...s, ready: true }));
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
      engineRef.current = null;
      rendererRef.current = null;
      simRef.current = null;
    };
  }, [mountRef]);

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

    engine.start(
      seed,
      (snap) => {
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

  return { ...state, start, press };
}
