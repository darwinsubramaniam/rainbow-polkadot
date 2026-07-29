// The contract between the Kenney pack and the game — sprite frames and sound
// cues both.
//
// Frame names are strings that live in a JSON file the compiler never sees, so
// a typo or a pack upgrade that renames a sprite would fail at runtime, inside
// the Product sandbox, as a missing texture on a frame nobody looks at until it
// is reached. Naming every frame up front turns that into two earlier failures:
// a test that runs against the committed atlases (artFrames.test.ts), and a
// load-time check that rejects an incomplete pack and falls back to primitives.
//
// Deliberately free of PixiJS imports. This is data about the art, and keeping
// it importable from plain Node is what lets the test check it without a DOM.

/** The four atlases in `public/art/`, each a `<group>.png` + `<group>.json` pair. */
export const ART_GROUPS = ["tiles", "characters", "enemies", "backgrounds"] as const;

export type ArtGroup = (typeof ART_GROUPS)[number];

/**
 * Player colours the pack ships, in the order the wallet-derived pick indexes
 * them. Appending is safe; reordering would give every existing player a new
 * colour, so treat this as append-only.
 */
export const PLAYER_COLORS = ["beige", "green", "pink", "purple", "yellow"] as const;

export type PlayerColor = (typeof PLAYER_COLORS)[number];

/** Player poses the simulation can actually express. */
const PLAYER_POSES = ["idle", "walk_a", "walk_b", "jump", "hit", "front"] as const;

/**
 * Enemy species, keyed by the enemy's slot in the simulation's fixed array.
 *
 * The simulation exposes no enemy kind — it has one enemy behaviour — so the
 * species is a purely cosmetic function of the slot index. It must be the slot
 * and not the position in `Snapshot.enemies`, which compacts as enemies die and
 * would make the survivors change species mid-run.
 */
export const ENEMY_SPECIES = ["slime_normal", "slime_spike", "ladybug", "mouse", "snail"] as const;

const ENEMY_POSES = ["rest", "walk_a", "walk_b"] as const;

/**
 * Terrain autotile variants.
 *
 * The simulation's terrain is a flat `TILE_SOLID`/empty grid — it has no notion
 * of an edge or a corner — so which of these a tile gets is decided entirely by
 * its four-neighbourhood, at level-build time. See `solidTerrainFrame`.
 *
 * Three families, because the generator produces three shapes: the ground is a
 * multi-row slab (nine-slice), floating platforms are one tile tall
 * (`horizontal_*`), and a truncated platform can end up one tile wide
 * (`vertical_*`, and `terrain_grass_block` when it is a lone tile).
 */
export const TERRAIN_FRAMES = [
  "terrain_grass_block",
  "terrain_grass_block_top",
  "terrain_grass_block_top_left",
  "terrain_grass_block_top_right",
  "terrain_grass_block_left",
  "terrain_grass_block_right",
  "terrain_grass_block_center",
  "terrain_grass_block_bottom",
  "terrain_grass_block_bottom_left",
  "terrain_grass_block_bottom_right",
  "terrain_grass_horizontal_left",
  "terrain_grass_horizontal_middle",
  "terrain_grass_horizontal_right",
  "terrain_grass_vertical_top",
  "terrain_grass_vertical_middle",
  "terrain_grass_vertical_bottom",
] as const;

/** Everything else the renderer names directly. */
const FIXED_FRAMES = [
  // hazards
  "spikes",
  // the goal column: a flag on top of a run of bare pole
  "flag_green_a",
  "flag_green_b",
  "flag_off",
  // pickups
  "coin_gold",
  "coin_gold_side",
  // HUD
  "hud_heart",
  "hud_heart_empty",
  "hud_coin",
  // backdrop. Every background in the pack is fully opaque, so they are
  // alternatives rather than layers — this is the one the renderer draws.
  "background_clouds",
] as const;

/**
 * Every frame the app will ask for, flattened.
 *
 * Built from the lists above rather than written out, so adding a player colour
 * or an enemy species cannot leave the required set behind.
 */
export const REQUIRED_FRAMES: readonly string[] = [
  ...TERRAIN_FRAMES,
  ...FIXED_FRAMES,
  ...PLAYER_COLORS.flatMap((c) => PLAYER_POSES.map((p) => `character_${c}_${p}`)),
  ...ENEMY_SPECIES.flatMap((s) => ENEMY_POSES.map((p) => `${s}_${p}`)),
];

/**
 * Sound cues, and the pack file each plays.
 *
 * Only the six the game actually triggers are shipped; the pack has ten. The
 * list is duplicated in `scripts/pack-art.mjs`, which copies them, and the two
 * are held together by a test rather than by hope.
 *
 * Every cue is a consequence the player can already see on screen. Nothing here
 * is an input to anything — audio is downstream of the snapshot and cannot
 * reach the input log.
 */
export const SFX_FILES = {
  jump: "sfx_jump.ogg",
  coin: "sfx_coin.ogg",
  hurt: "sfx_hurt.ogg",
  stomp: "sfx_disappear.ogg",
  win: "sfx_magic.ogg",
  select: "sfx_select.ogg",
} as const;

export type Cue = keyof typeof SFX_FILES;

/**
 * Choose the terrain frame for one solid tile from its four neighbours.
 *
 * Pure, and pure on purpose: this is the whole of the autotiler's judgement,
 * and keeping it free of the scene graph is what lets every one of its sixteen
 * inputs be checked in a test rather than by squinting at a level.
 *
 * Each argument is "is the tile on that side solid". Diagonals are ignored —
 * Kenney's set has no inner-corner piece to put there, and the generator never
 * produces the staircase shapes that would want one.
 *
 * Callers decide what lies outside the level. The renderer treats the columns
 * beyond either end as solid (matching the simulation's walls) and everything
 * below the bottom row as solid too, so the floor is not drawn with a grass cap
 * on its underside.
 */
export function solidTerrainFrame(
  up: boolean,
  down: boolean,
  left: boolean,
  right: boolean,
): string {
  // One tile tall: a floating platform. Kenney draws these with rounded caps,
  // which the nine-slice pieces do not have.
  if (!up && !down) {
    if (!left && !right) return "terrain_grass_block";
    if (!left) return "terrain_grass_horizontal_left";
    if (!right) return "terrain_grass_horizontal_right";
    return "terrain_grass_horizontal_middle";
  }

  // One tile wide: a column, which the generator can produce by truncating a
  // platform against the goal's keep-out zone.
  if (!left && !right) {
    if (!up) return "terrain_grass_vertical_top";
    if (!down) return "terrain_grass_vertical_bottom";
    return "terrain_grass_vertical_middle";
  }

  // Otherwise a slab: pick the nine-slice cell by which edges are exposed.
  if (!up) {
    if (!left) return "terrain_grass_block_top_left";
    if (!right) return "terrain_grass_block_top_right";
    return "terrain_grass_block_top";
  }
  if (!down) {
    if (!left) return "terrain_grass_block_bottom_left";
    if (!right) return "terrain_grass_block_bottom_right";
    return "terrain_grass_block_bottom";
  }
  if (!left) return "terrain_grass_block_left";
  if (!right) return "terrain_grass_block_right";
  return "terrain_grass_block_center";
}

/**
 * Pick a player colour from an account address.
 *
 * A player keeps the same character across every run from the same account,
 * without any of it being stored anywhere. Purely cosmetic: nothing derived
 * here reaches the input log or the score, so it cannot affect what the enclave
 * replays. Callers pass `null` before a wallet is connected and get the first
 * colour.
 *
 * FNV-1a over the address bytes. Not a security primitive — it only needs to
 * spread five ways and be stable across sessions and machines.
 */
export function playerColorFor(address: string | null | undefined): PlayerColor {
  if (!address) return PLAYER_COLORS[0];

  let h = 0x811c9dc5;
  for (let i = 0; i < address.length; i++) {
    h ^= address.charCodeAt(i);
    // Multiply by the 32-bit FNV prime without leaving the safe integer range.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return PLAYER_COLORS[h % PLAYER_COLORS.length]!;
}
