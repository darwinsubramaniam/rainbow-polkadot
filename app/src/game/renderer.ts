// PixiJS v8 scene for the platformer.
//
// Everything here is drawn with `Graphics` primitives — no texture lookups,
// nothing that can 404 inside a sandboxed Product. That was originally the
// whole renderer; it is now the *floor*. `assets.ts` may hand `create` a loaded
// art pack, and when it does the sprite path takes over; when it hands over
// null — a missing atlas, a slow connection, a sandbox that will not serve
// public/ — the primitives below still draw a complete, playable game.
//
// Keeping both paths is cheap, and it is the reason adding art cannot turn a
// published Product into a blank canvas.
//
// Renderer choice is deliberate: WebGL is requested explicitly rather than
// letting PixiJS prefer WebGPU. E0.1 measured WebGL2 working inside the Product
// sandbox; WebGPU was not measured there, and a Product cannot set the COOP/COEP
// headers that some paths want. Preferring the measured one is the safe call.

import { Application, Container, Graphics, Sprite, TilingSprite } from "pixi.js";
import { TILE_EMPTY, TILE_GOAL, TILE_SOLID, TILE_SPIKE, type Snapshot } from "../sim/sim";
import type { Art } from "./assets";
import {
  ENEMY_SPECIES,
  PLAYER_COLORS,
  solidTerrainFrame,
  type PlayerColor,
} from "./artFrames";

/**
 * The play field, in simulation units. One unit is one simulation pixel, so a
 * 16-unit tile is one `TILE`, and every camera and entity coordinate below can
 * be used exactly as the snapshot reports it.
 */
export const VIEW_W = 320;
export const VIEW_H = 240;

/**
 * Device pixels per simulation unit.
 *
 * Kenney draws a tile at 64 px; the simulation's tile is 16 units. Rendering
 * 1:1 would mean throwing away three quarters of every sprite, and the result
 * is mush — the art has outlines and interior detail that do not survive a 4×
 * downsample.
 *
 * So the whole stage is scaled instead: the canvas is 1280×960 device pixels,
 * every sprite is drawn at its native size, and CSS shrinks the finished canvas
 * to fit the cabinet. Nothing else in the file changes units — `VIEW_W`, the
 * camera, and the primitive fallback all still work in simulation units, and
 * this constant is applied once, at the stage.
 */
export const RENDER_SCALE = 4;

/**
 * How much of the view one backdrop tile covers, vertically.
 *
 * Above 1 on purpose. The backdrop is a 256-square image with its clouds in the
 * lower half; sized to exactly fill the field, that band lands on the horizon
 * and the terrain is read against white. Oversizing it and showing the top of
 * the image instead puts open sky behind the play area and leaves only the cloud
 * tops peeking in above the ground. It also means the tile never repeats
 * vertically, so there is no seam to hide.
 */
const SKY_COVER = 1.25;

/**
 * On-screen size of a sprite's *frame*, in simulation units.
 *
 * These are frame sizes, not silhouette sizes: Kenney pads each frame, so a
 * character drawn in a 24-unit frame stands about 18 units tall (its art fills
 * 97 of 128 rows) and an enemy in a 16-unit frame fills 10 to 14.
 *
 * They are all larger than the boxes the simulation collides with — the player
 * is 10×14, an enemy 12×12 — and deliberately so. Art sized down to its hitbox
 * looks starved next to 16-unit tiles. The overhang is the usual platformer
 * compromise, and it is safe here in a way it would not be in a normal game:
 * the sprite cannot influence the simulation, so nothing about how it is drawn
 * can make a run play differently or replay differently in the enclave.
 */
const PLAYER_FRAME = 24;
const ENEMY_FRAME = 16;
const COIN_FRAME = 16;

/** Frames per animation flip, as a power of two shift on the tick count. */
const WALK_SHIFT = 2; // ~7 flips a second
const SPIN_SHIFT = 3; // coins, slower
const FLAG_SHIFT = 4; // the goal flag, slower still

const COLOR = {
  sky: 0x0d1119,
  /**
   * The pack's own sky, used as the canvas clear colour on the art path.
   *
   * It is the exact blue at the top of `background_clouds`, so the backdrop
   * meets the clear colour invisibly, and a pit shows sky rather than the dark
   * chrome colour that would otherwise sit behind the world.
   */
  skyArt: 0xc3e3ff,
  hill: 0x141a26,
  solid: 0x3b4a63,
  solidTop: 0x54688a,
  spike: 0xff6b6b,
  goal: 0x3ddc84,
  coin: 0xffd166,
  enemy: 0xc678dd,
  enemyEye: 0x1a1020,
  player: 0x7aa2f7,
  playerHurt: 0xffffff,
  notch: 0x0d1119,
} as const;

export class Renderer {
  readonly app: Application;

  /**
   * The loaded art pack, or null when drawing from primitives.
   *
   * Owned by whoever called `create` — `destroy` here deliberately does not
   * free it, because the pack outlives the renderer across a StrictMode
   * remount and re-decoding four atlases for that would be waste.
   */
  readonly art: Art | null;

  private readonly world = new Container();
  private readonly hills = new Graphics();
  private readonly terrain = new Graphics();
  private readonly coins = new Graphics();
  private readonly enemies = new Graphics();
  private readonly player = new Graphics();
  private readonly progress = new Graphics();

  /** Backdrop, on the art path only. Null when drawing from primitives. */
  private readonly sky: TilingSprite | null = null;

  /**
   * Terrain as sprites, on the art path only.
   *
   * Built once per level and thereafter only translated by the camera, for the
   * same reason the primitive terrain is: the level is immutable for the whole
   * run, and rebuilding a couple of thousand tiles per frame would dominate the
   * budget to redraw something that did not change.
   */
  private readonly terrainArt: Container | null = null;

  /** Sprite pools for the moving things, on the art path only. */
  private readonly coinsArt: Container | null = null;
  private readonly enemiesArt: Container | null = null;
  private readonly playerArt: Sprite | null = null;
  private readonly coinPool: Sprite[] = [];
  private readonly enemyPool: Sprite[] = [];

  /** The goal flag, so `draw` can wave it. Rebuilt with the terrain. */
  private flagArt: Sprite | null = null;

  private playerColor: PlayerColor = PLAYER_COLORS[0];

  /**
   * Which way each enemy is walking, and where it was last seen.
   *
   * The snapshot reports an enemy's position but not its velocity, so heading
   * is recovered by differencing across frames. Keyed by slot, not by array
   * position, so an enemy dying does not make the survivors turn round. A
   * remembered heading is kept when the delta is too small to read, which stops
   * an enemy flickering as it turns.
   */
  private readonly enemyLastX = new Map<number, number>();
  private readonly enemyFacing = new Map<number, number>();

  private levelW = 0;
  private tile = 16;
  private terrainData: Uint8Array | null = null;

  private constructor(app: Application, art: Art | null) {
    this.app = app;
    this.art = art;

    if (art) {
      const cover = (VIEW_H * SKY_COVER) / 256;
      this.sky = new TilingSprite({
        texture: art.texture("background_clouds"),
        width: VIEW_W,
        height: VIEW_H,
        tileScale: { x: cover, y: cover },
      });
      this.terrainArt = new Container();
      this.coinsArt = new Container();
      this.enemiesArt = new Container();

      this.playerArt = new Sprite(art.texture(`character_${this.playerColor}_idle`));
      // Anchored at the feet: Kenney draws every character standing on the
      // bottom edge of its frame, so this pins the sprite to the hitbox's
      // bottom edge and lets the extra height rise above it.
      this.playerArt.anchor.set(0.5, 1);
    }

    // Draw order is the add order.
    app.stage.addChild(this.sky ?? this.hills);
    app.stage.addChild(this.world);
    this.world.addChild(this.terrainArt ?? this.terrain);
    this.world.addChild(this.coinsArt ?? this.coins);
    this.world.addChild(this.enemiesArt ?? this.enemies);
    this.world.addChild(this.playerArt ?? this.player);
    app.stage.addChild(this.progress);

    // Applied once, here: everything downstream stays in simulation units.
    app.stage.scale.set(RENDER_SCALE);
  }

  /**
   * Build the scene.
   *
   * `art` is optional and null-tolerant by design: the caller decides whether
   * the pack loaded, and this never has to care beyond picking a draw path.
   */
  static async create(mount: HTMLElement, art: Art | null = null): Promise<Renderer> {
    const app = new Application();
    await app.init({
      width: VIEW_W * RENDER_SCALE,
      height: VIEW_H * RENDER_SCALE,
      background: art ? COLOR.skyArt : COLOR.sky,
      antialias: false,
      roundPixels: true,
      autoDensity: false,
      preference: "webgl",
      // The React layer owns the loop, so nothing should advance on its own.
      autoStart: false,
    });

    app.canvas.style.width = "100%";
    app.canvas.style.height = "auto";
    app.canvas.style.display = "block";
    mount.appendChild(app.canvas);

    return new Renderer(app, art);
  }

  /**
   * Set which of the pack's five characters the player is drawn as.
   *
   * Cosmetic and free to change at any time — the next `draw` picks it up. It
   * carries no meaning to the simulation, which is why it can be derived from
   * the connected account without any of that reaching the input log.
   */
  setPlayerColor(color: PlayerColor): void {
    this.playerColor = color;
  }

  /**
   * Rebuild the static terrain layer for a newly generated level.
   *
   * Terrain is immutable for the whole run, so it is drawn once into a single
   * Graphics and then only translated by the camera. Re-emitting ~2,400 tiles
   * every frame would dominate the frame budget for no benefit.
   */
  setLevel(terrain: Uint8Array, levelW: number, levelH: number, tile: number): void {
    this.terrainData = terrain;
    this.levelW = levelW;
    this.tile = tile;

    if (this.art && this.terrainArt) {
      this.buildTerrainSprites(terrain, levelW, levelH, tile, this.art, this.terrainArt);
      return;
    }

    const g = this.terrain;
    g.clear();

    for (let ty = 0; ty < levelH; ty++) {
      for (let tx = 0; tx < levelW; tx++) {
        const t = terrain[ty * levelW + tx];
        if (t === undefined || t === 0) continue;
        const px = tx * tile;
        const py = ty * tile;

        if (t === TILE_SOLID) {
          g.rect(px, py, tile, tile).fill(COLOR.solid);
          g.rect(px, py, tile, 3).fill(COLOR.solidTop);
        } else if (t === TILE_SPIKE) {
          g.poly([px, py + tile, px + tile / 2, py + 2, px + tile, py + tile]).fill(COLOR.spike);
        } else if (t === TILE_GOAL) {
          g.rect(px + tile / 2 - 2, py, 4, tile).fill(COLOR.goal);
        }
      }
    }

    this.hills.clear();
    for (let i = 0; i < 14; i++) {
      this.hills.rect(i * 140, 150, 90, 90).fill(COLOR.hill);
    }
  }

  /**
   * Lay out one sprite per non-empty tile.
   *
   * The simulation's terrain is four flat values, so everything that makes a
   * level look like a place — grass on the exposed top, rounded caps on a
   * platform's ends, a pole under the flag — is decided here, from the grid,
   * and is worth nothing to the simulation. Which is the point: none of it can
   * change what the enclave replays.
   */
  private buildTerrainSprites(
    terrain: Uint8Array,
    levelW: number,
    levelH: number,
    tile: number,
    art: Art,
    into: Container,
  ): void {
    into.removeChildren().forEach((c) => c.destroy());
    this.flagArt = null;
    this.enemyLastX.clear();
    this.enemyFacing.clear();

    /**
     * Is the tile at (tx, ty) solid, for the purpose of choosing an edge?
     *
     * Off the sides is solid, matching the walls the simulation collides
     * against, so a level does not open with a rounded cliff edge. Below the
     * floor is solid too, so the bottom row is not drawn with grass on its
     * underside. Above the level is open sky.
     *
     * Only TILE_SOLID counts: a spike or the goal column sitting on the ground
     * should leave the ground beneath it looking like an exposed surface,
     * because it is one.
     */
    const solid = (tx: number, ty: number): boolean => {
      if (tx < 0 || tx >= levelW) return true;
      if (ty < 0) return false;
      if (ty >= levelH) return true;
      return terrain[ty * levelW + tx] === TILE_SOLID;
    };

    for (let ty = 0; ty < levelH; ty++) {
      for (let tx = 0; tx < levelW; tx++) {
        const t = terrain[ty * levelW + tx];
        if (t === undefined || t === TILE_EMPTY) continue;

        let frame: string;
        if (t === TILE_SOLID) {
          frame = solidTerrainFrame(
            solid(tx, ty - 1),
            solid(tx, ty + 1),
            solid(tx - 1, ty),
            solid(tx + 1, ty),
          );
        } else if (t === TILE_SPIKE) {
          frame = "spikes";
        } else if (t === TILE_GOAL) {
          // The goal is a column. Only its top tile carries the flag; the rest
          // is the pole the flag is flying from.
          frame = terrain[(ty - 1) * levelW + tx] === TILE_GOAL ? "flag_off" : "flag_green_a";
        } else {
          continue;
        }

        const sprite = new Sprite(art.texture(frame));
        sprite.position.set(tx * tile, ty * tile);
        // Sized in simulation units. The stage's RENDER_SCALE takes each of
        // these back to the texture's native 64 px, so nothing is resampled.
        sprite.setSize(tile, tile);
        into.addChild(sprite);

        // Kept so `draw` can wave it. There is exactly one goal per level.
        if (frame === "flag_green_a") this.flagArt = sprite;
      }
    }
  }

  /** Draw one frame from a simulation snapshot. */
  draw(s: Snapshot): void {
    if (!this.terrainData) return;

    // Camera follows the player, clamped so it never shows past the level.
    const half = VIEW_W / 2;
    const maxX = this.levelW * this.tile - VIEW_W;
    // Snapped to a whole device pixel rather than a whole simulation unit: at
    // RENDER_SCALE the latter is a four-pixel step, and the camera visibly
    // stutters as the player walks.
    const camX =
      Math.round(Math.max(0, Math.min(s.x - half, maxX)) * RENDER_SCALE) / RENDER_SCALE;

    this.world.x = -camX;
    // Parallax: the backdrop drifts at a third of the camera's rate.
    if (this.sky) this.sky.tilePosition.x = -camX * 0.35;
    else this.hills.x = -((camX * 0.35) % 140) - 140;

    if (this.art) {
      this.drawEntitiesArt(s, camX, this.art);
      this.drawProgress(s);
      return;
    }

    // -- coins ------------------------------------------------------------
    const c = this.coins;
    c.clear();
    for (const coin of s.coinsOnField) {
      // Cheap cull: anything off-camera costs nothing to skip and there can be
      // sixty-four of them.
      if (coin.x < camX - 16 || coin.x > camX + VIEW_W + 16) continue;
      c.circle(coin.x, coin.y, 4).fill(COLOR.coin);
    }

    // -- enemies ----------------------------------------------------------
    const e = this.enemies;
    e.clear();
    for (const en of s.enemies) {
      if (en.x < camX - 16 || en.x > camX + VIEW_W + 16) continue;
      const ex = en.x - 6;
      const ey = en.y - 6;
      e.rect(ex, ey, 12, 12).fill(COLOR.enemy);
      e.rect(ex + 2, ey + 3, 3, 3).fill(COLOR.enemyEye);
      e.rect(ex + 7, ey + 3, 3, 3).fill(COLOR.enemyEye);
    }

    // -- player -----------------------------------------------------------
    const p = this.player;
    p.clear();
    // Blink while invulnerable, so losing a life is legible without a HUD glance.
    const hidden = s.invuln && ((s.tick >> 2) & 1) === 0;
    if (!hidden) {
      p.rect(s.x - 5, s.y - 7, 10, 14).fill(s.invuln ? COLOR.playerHurt : COLOR.player);
      p.rect(s.x - 5 + (s.facing > 0 ? 6 : 1), s.y - 4, 3, 3).fill(COLOR.notch);
    }

    this.drawProgress(s);
  }

  private drawProgress(s: Snapshot): void {
    const pr = this.progress;
    pr.clear();
    pr.rect(0, 0, VIEW_W, 3).fill({ color: 0xffffff, alpha: 0.1 });
    const frac = s.x / (this.levelW * this.tile);
    pr.rect(frac * VIEW_W - 1, 0, 3, 3).fill(COLOR.player);
  }

  /**
   * Draw the player, the enemies and the coins from the art pack.
   *
   * Every frame choice here is a function of the snapshot — the tick count, the
   * ground flag, the velocity — and never of the wall clock. That costs nothing
   * and it means a run drawn from a replayed input log animates identically to
   * the run the player actually had, frame for frame.
   *
   * Sprites are pooled rather than created per frame. There can be sixty-four
   * coins, and allocating them every frame would hand the collector work at
   * exactly the moments the loop is busiest.
   */
  private drawEntitiesArt(s: Snapshot, camX: number, art: Art): void {
    const onCamera = (x: number): boolean => x >= camX - 24 && x <= camX + VIEW_W + 24;

    // -- coins ------------------------------------------------------------
    let n = 0;
    for (const coin of s.coinsOnField) {
      if (!onCamera(coin.x)) continue;
      const sprite = this.take(this.coinPool, this.coinsArt!, COIN_FRAME / 64, 0.5, n);
      // Offset by slot so sixty-four coins do not flip in lockstep, which reads
      // as one blinking object rather than a field of spinning ones.
      const edge = (((s.tick >> SPIN_SHIFT) + coin.slot) & 1) === 1;
      sprite.texture = art.texture(edge ? "coin_gold_side" : "coin_gold");
      sprite.position.set(coin.x, coin.y);
      n++;
    }
    this.hideFrom(this.coinPool, n);

    // -- enemies ----------------------------------------------------------
    n = 0;
    for (const en of s.enemies) {
      const previous = this.enemyLastX.get(en.slot);
      if (previous !== undefined && Math.abs(en.x - previous) > 0.01) {
        this.enemyFacing.set(en.slot, en.x > previous ? 1 : -1);
      }
      this.enemyLastX.set(en.slot, en.x);
      if (!onCamera(en.x)) continue;

      // Species from the slot, so it is fixed for the whole run.
      const species = ENEMY_SPECIES[en.slot % ENEMY_SPECIES.length]!;
      const step = (((s.tick >> WALK_SHIFT) + en.slot) & 1) === 1 ? "walk_b" : "walk_a";

      const sprite = this.take(this.enemyPool, this.enemiesArt!, ENEMY_FRAME / 64, 1, n);
      sprite.texture = art.texture(`${species}_${step}`);
      // Kenney draws these facing left, so a left-heading enemy is unmirrored.
      sprite.scale.x = (ENEMY_FRAME / 64) * -(this.enemyFacing.get(en.slot) ?? -1);
      // The simulation's enemy box is 12 tall and centred on `y`, so its feet
      // are six below — which is where the sprite is anchored.
      sprite.position.set(en.x, en.y + 6);
      n++;
    }
    this.hideFrom(this.enemyPool, n);

    // -- the goal flag ----------------------------------------------------
    if (this.flagArt) {
      const wave = ((s.tick >> FLAG_SHIFT) & 1) === 1 ? "flag_green_b" : "flag_green_a";
      this.flagArt.texture = art.texture(wave);
    }

    // -- player -----------------------------------------------------------
    const p = this.playerArt!;
    // Blink while invulnerable, so losing a life is legible without a HUD glance.
    p.visible = !(s.invuln && ((s.tick >> 2) & 1) === 0);
    p.texture = art.texture(this.playerFrame(s));
    p.scale.set((PLAYER_FRAME / 128) * (s.facing > 0 ? 1 : -1), PLAYER_FRAME / 128);
    // The player box is 14 tall and centred on `y`; feet are seven below.
    p.position.set(s.x, s.y + 7);
  }

  /** The pose the snapshot puts the player in. */
  private playerFrame(s: Snapshot): string {
    const c = this.playerColor;
    if (s.invuln) return `character_${c}_hit`;
    if (!s.onGround) return `character_${c}_jump`;
    // A threshold rather than a test against zero: the player keeps a sliver of
    // velocity while friction bleeds off, and animating that reads as a twitch.
    if (Math.abs(s.vx) > 0.15) {
      return `character_${c}_${((s.tick >> WALK_SHIFT) & 1) === 1 ? "walk_b" : "walk_a"}`;
    }
    return `character_${c}_idle`;
  }

  /**
   * The pool's sprite at `index`, creating it on first use.
   *
   * The index is the caller's running count for this frame, not anything
   * derived from the pool: `visible` is left set from the previous frame until
   * `hideFrom` clears the tail, so counting visible sprites here would skip
   * over live entries and grow the pool without bound.
   */
  private take(
    pool: Sprite[],
    into: Container,
    scale: number,
    anchorY: number,
    index: number,
  ): Sprite {
    let sprite = pool[index];
    if (!sprite) {
      // Texture is assigned by the caller on this same frame.
      sprite = new Sprite();
      sprite.anchor.set(0.5, anchorY);
      pool.push(sprite);
      into.addChild(sprite);
    }
    sprite.visible = true;
    sprite.scale.set(scale);
    return sprite;
  }

  /** Hide every sprite in a pool from `from` on. */
  private hideFrom(pool: Sprite[], from: number): void {
    for (let i = from; i < pool.length; i++) pool[i]!.visible = false;
  }

  destroy(): void {
    this.app.destroy(true, { children: true });
  }
}
