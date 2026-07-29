// PixiJS v8 scene for the platformer.
//
// Everything is drawn with `Graphics` primitives — no texture atlas, no assets
// to load, nothing to 404 inside a sandboxed Product. Shapes only, which is
// also what keeps the published bundle small enough to be comfortable against
// the Bulletin byte quota.
//
// Renderer choice is deliberate: WebGL is requested explicitly rather than
// letting PixiJS prefer WebGPU. E0.1 measured WebGL2 working inside the Product
// sandbox; WebGPU was not measured there, and a Product cannot set the COOP/COEP
// headers that some paths want. Preferring the measured one is the safe call.

import { Application, Container, Graphics } from "pixi.js";
import { TILE_GOAL, TILE_SOLID, TILE_SPIKE, type Snapshot } from "../sim/sim";

export const VIEW_W = 320;
export const VIEW_H = 240;

const COLOR = {
  sky: 0x0d1119,
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

  private readonly world = new Container();
  private readonly hills = new Graphics();
  private readonly terrain = new Graphics();
  private readonly coins = new Graphics();
  private readonly enemies = new Graphics();
  private readonly player = new Graphics();
  private readonly progress = new Graphics();

  private levelW = 0;
  private tile = 16;
  private terrainData: Uint8Array | null = null;

  private constructor(app: Application) {
    this.app = app;

    // Draw order is the add order.
    app.stage.addChild(this.hills);
    app.stage.addChild(this.world);
    this.world.addChild(this.terrain, this.coins, this.enemies, this.player);
    app.stage.addChild(this.progress);
  }

  static async create(mount: HTMLElement): Promise<Renderer> {
    const app = new Application();
    await app.init({
      width: VIEW_W,
      height: VIEW_H,
      background: COLOR.sky,
      antialias: false,
      // Integer-ratio upscaling of a 320×240 field: smoothing would turn crisp
      // tile edges into mush.
      roundPixels: true,
      autoDensity: false,
      preference: "webgl",
      // The React layer owns the loop, so nothing should advance on its own.
      autoStart: false,
    });

    app.canvas.style.width = "100%";
    app.canvas.style.height = "auto";
    app.canvas.style.imageRendering = "pixelated";
    app.canvas.style.display = "block";
    mount.appendChild(app.canvas);

    return new Renderer(app);
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

  /** Draw one frame from a simulation snapshot. */
  draw(s: Snapshot): void {
    if (!this.terrainData) return;

    // Camera follows the player, clamped so it never shows past the level.
    const half = VIEW_W / 2;
    const maxX = this.levelW * this.tile - VIEW_W;
    const camX = Math.round(Math.max(0, Math.min(s.x - half, maxX)));

    this.world.x = -camX;
    // Parallax: the backdrop drifts at a third of the camera's rate.
    this.hills.x = -((camX * 0.35) % 140) - 140;

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

    // -- progress strip ---------------------------------------------------
    const pr = this.progress;
    pr.clear();
    pr.rect(0, 0, VIEW_W, 3).fill({ color: 0xffffff, alpha: 0.1 });
    const frac = s.x / (this.levelW * this.tile);
    pr.rect(frac * VIEW_W - 1, 0, 3, 3).fill(COLOR.player);
  }

  destroy(): void {
    this.app.destroy(true, { children: true });
  }
}
