// Loads the Kenney atlases, or decides to do without them.
//
// `renderer.ts` used to draw the whole game from `Graphics` primitives, on the
// stated grounds that a Product bundle has nothing to 404 against. That is a
// real constraint and this module is the answer to it rather than a retraction
// of it: the primitive renderer stays, and art is an enhancement that either
// loads completely or is declined. A missing atlas degrades to the game as it
// shipped before, never to a blank canvas.
//
// Two things follow from that, and both are load-time rather than draw-time:
//
//   * `loadArt` never throws. Failure is a null return and a console warning.
//   * A pack that is merely *incomplete* is a failure too. Every frame in
//     REQUIRED_FRAMES is checked before the art is accepted, so the renderer
//     can index the atlas without a per-lookup existence test and without the
//     risk of a hole that only appears on the one level that reaches it.
//
// Loading also has to finish before a run starts. `engine.ts` clamps catch-up
// to MAX_CATCHUP_MS, so a texture decode landing mid-run would be absorbed by
// dropping simulation ticks — the player would see a hitch, and the input log
// would record the buttons they were holding through it. `useGame` therefore
// awaits this during boot, alongside sim.wasm, and gates `ready` on both.

import { ImageSource, Spritesheet, Texture, type SpritesheetData } from "pixi.js";

import { ART_GROUPS, REQUIRED_FRAMES, type ArtGroup } from "./artFrames";

// Served from public/ and resolved against the document, exactly as sim.wasm
// is. `BASE_URL` is "./", which is what makes the bundle work from the
// gateway's client-side resolver rather than needing a real origin root.
const ART_BASE = `${import.meta.env.BASE_URL}art/`;

/**
 * Ceiling on how long the whole art load may take before it is abandoned.
 *
 * Without it a stalled request would hold the Play button disabled forever on
 * a flaky connection, when falling back to primitives would have let the player
 * play. 10s is generous for ~260 KB and short enough not to read as a hang.
 */
const LOAD_TIMEOUT_MS = 10_000;

/**
 * The loaded art pack.
 *
 * Frame names are a single flat namespace across the four atlases. They are
 * unique — `pack-art.mjs` refuses to emit a collision — which lets callers name
 * a sprite without also naming the sheet it happens to live on.
 */
export interface Art {
  /** Look up a frame. Throws on an unknown name: every name is checked at load. */
  texture(name: string): Texture;
  /**
   * The same frame as inline CSS, for drawing an atlas sprite in the DOM.
   *
   * The HUD is DOM rather than canvas — it holds selectable text and belongs in
   * the accessibility tree — so its icons cannot be Pixi sprites. This renders
   * one as a background-image window onto the atlas, sized to `px` wide.
   *
   * Derived from the loaded atlas rather than from a table of coordinates, so
   * regenerating the pack cannot leave the HUD pointing at the wrong sprite.
   */
  cssIcon(name: string, px: number): Record<string, string>;
  destroy(): void;
}

/** Fetch and decode one image without going through the Assets singleton.
 *
 * `Assets` is a global registry whose `init` is once-per-page; under React's
 * StrictMode double-invoked effects that turns into warnings and shared cache
 * entries across a renderer that was already torn down. Owning the decode here
 * keeps the lifetime of every GPU resource tied to this module's `destroy`.
 */
async function loadImage(url: string, signal: AbortSignal): Promise<HTMLImageElement> {
  // Fetch first rather than assigning `img.src` directly, so an HTTP failure is
  // an error with a status rather than an untyped `onerror`, and so the abort
  // signal actually cancels the transfer.
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);

  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = objectUrl;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function loadSheet(group: ArtGroup, signal: AbortSignal): Promise<Spritesheet> {
  const res = await fetch(`${ART_BASE}${group}.json`, { signal });
  if (!res.ok) throw new Error(`${group}.json: HTTP ${res.status}`);
  const data = (await res.json()) as SpritesheetData;

  const img = await loadImage(`${ART_BASE}${group}.png`, signal);

  const source = new ImageSource({
    resource: img,
    // The renderer draws this art at native tile size into a field that CSS
    // then scales down to fit, so filtering is a downscale. Nearest would
    // shimmer as the camera moves; mipmaps keep it stable.
    scaleMode: "linear",
    autoGenerateMipmaps: true,
    label: `art:${group}`,
  });

  const sheet = new Spritesheet(new Texture({ source }), data);
  await sheet.parse();
  return sheet;
}

/**
 * Load every atlas, or return null.
 *
 * Never throws and never leaks: a partial load is destroyed before returning.
 */
export async function loadArt(): Promise<Art | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);
  const sheets: Spritesheet[] = [];

  try {
    // In parallel: four small requests one after another would spend most of
    // the wall clock in round trips.
    const loaded = await Promise.all(ART_GROUPS.map((g) => loadSheet(g, controller.signal)));
    sheets.push(...loaded);

    const textures = new Map<string, Texture>();
    // Which sheet each frame came from, so `cssIcon` can point at the right
    // PNG. The Pixi texture knows its source but not the URL it was fetched
    // from, and only this loop still has that.
    const sheetOf = new Map<string, ArtGroup>();
    for (const [i, sheet] of loaded.entries()) {
      const group = ART_GROUPS[i]!;
      for (const [name, texture] of Object.entries(sheet.textures)) {
        textures.set(name, texture);
        sheetOf.set(name, group);
      }
    }

    // Reject an incomplete pack rather than discovering the hole at draw time.
    const missing = REQUIRED_FRAMES.filter((n) => !textures.has(n));
    if (missing.length) {
      throw new Error(
        `${missing.length} frame(s) missing from the art pack: ${missing.slice(0, 5).join(", ")}` +
          (missing.length > 5 ? ", …" : "") +
          " — regenerate with scripts/pack-art.mjs",
      );
    }

    const art: Art = {
      texture(name) {
        const t = textures.get(name);
        if (!t) throw new Error(`no art frame "${name}"`);
        return t;
      },
      cssIcon(name, px) {
        const { frame, source } = art.texture(name);
        // Scale the whole atlas by the same factor that takes this frame to
        // `px`, then offset it so the frame lands in the element's box.
        const k = px / frame.width;
        return {
          backgroundImage: `url("${ART_BASE}${sheetOf.get(name)}.png")`,
          backgroundPosition: `${-frame.x * k}px ${-frame.y * k}px`,
          backgroundSize: `${source.width * k}px ${source.height * k}px`,
          width: `${px}px`,
          height: `${frame.height * k}px`,
        };
      },
      destroy() {
        // `true` also destroys the shared texture source behind the sheet.
        for (const sheet of sheets) sheet.destroy(true);
        textures.clear();
        sheetOf.clear();
      },
    };
    return art;
  } catch (e) {
    for (const sheet of sheets) sheet.destroy(true);
    console.warn("art unavailable, falling back to primitives:", e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
