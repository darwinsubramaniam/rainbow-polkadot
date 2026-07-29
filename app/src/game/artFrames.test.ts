// Checks the frame-name contract against the atlases that are actually committed.
//
// `assets.ts` refuses an incomplete pack at runtime, which protects the player
// but only tells us about it once the app is running in a browser. This does
// the same check against `public/art/*.json` in CI, where a rename introduced
// by regenerating the pack is cheap to fix.
//
// It imports `artFrames.ts` and not `assets.ts` on purpose: the loader pulls in
// PixiJS and a DOM, and neither exists under `node --test`.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ART_GROUPS,
  PLAYER_COLORS,
  REQUIRED_FRAMES,
  SFX_FILES,
  TERRAIN_FRAMES,
  playerColorFor,
  solidTerrainFrame,
} from "./artFrames.ts";

const ART_DIR = path.join(import.meta.dirname, "..", "..", "public", "art");

interface Atlas {
  frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }>;
  meta: { image: string; size: { w: number; h: number } };
}

function readAtlas(group: string): Atlas {
  return JSON.parse(readFileSync(path.join(ART_DIR, `${group}.json`), "utf8")) as Atlas;
}

test("every required frame exists in the committed atlases", () => {
  const all = new Set<string>();
  for (const group of ART_GROUPS) {
    for (const name of Object.keys(readAtlas(group).frames)) all.add(name);
  }

  const missing = REQUIRED_FRAMES.filter((n) => !all.has(n));
  assert.deepEqual(missing, [], "regenerate public/art/ with scripts/pack-art.mjs");
});

test("frame names do not collide across atlases", () => {
  // The loader flattens all four sheets into one namespace, so a collision
  // would silently shadow whichever sheet loaded first.
  const owner = new Map<string, string>();
  for (const group of ART_GROUPS) {
    for (const name of Object.keys(readAtlas(group).frames)) {
      const prev = owner.get(name);
      assert.equal(prev, undefined, `"${name}" is in both ${prev} and ${group}`);
      owner.set(name, group);
    }
  }
});

test("frames stay inside their sheet", () => {
  // A frame rect that overhangs the image samples whatever is adjacent in the
  // atlas, which shows up as a sliver of an unrelated sprite along one edge.
  for (const group of ART_GROUPS) {
    const { frames, meta } = readAtlas(group);
    for (const [name, { frame }] of Object.entries(frames)) {
      assert.ok(
        frame.x >= 0 && frame.y >= 0 &&
          frame.x + frame.w <= meta.size.w &&
          frame.y + frame.h <= meta.size.h,
        `${group}: "${name}" is outside the ${meta.size.w}x${meta.size.h} sheet`,
      );
    }
  }
});

test("every sound cue has a file, and no unused file ships", () => {
  const wanted = Object.values(SFX_FILES).sort();
  const shipped = readdirSync(path.join(ART_DIR, "sfx")).sort();

  // Both directions. A cue with no file is a silent event at runtime; a file
  // with no cue is dead weight in a bundle that is uploaded against a quota,
  // and means `SOUNDS` in scripts/pack-art.mjs has drifted from the cue table.
  assert.deepEqual(shipped, wanted, "re-run scripts/pack-art.mjs");
});

test("every neighbourhood autotiles to a frame that exists", () => {
  // All sixteen, so no combination reaches the renderer as a bad texture name.
  for (let bits = 0; bits < 16; bits++) {
    const frame = solidTerrainFrame(!!(bits & 1), !!(bits & 2), !!(bits & 4), !!(bits & 8));
    assert.ok(
      (TERRAIN_FRAMES as readonly string[]).includes(frame),
      `up/down/left/right = ${bits.toString(2).padStart(4, "0")} gave "${frame}"`,
    );
  }
});

test("autotiling puts grass on exposed tops and caps on platform ends", () => {
  const [up, down, left, right] = [true, true, true, true];

  // A tile buried on all four sides shows no edge at all.
  assert.equal(solidTerrainFrame(up, down, left, right), "terrain_grass_block_center");

  // The ground's surface: open above, buried below, neighbours either side.
  assert.equal(solidTerrainFrame(false, down, left, right), "terrain_grass_block_top");
  // …and where that surface ends at a pit.
  assert.equal(solidTerrainFrame(false, down, false, right), "terrain_grass_block_top_left");
  assert.equal(solidTerrainFrame(false, down, left, false), "terrain_grass_block_top_right");

  // A floating platform is one tile tall, so it gets the rounded run, never the
  // nine-slice pieces — which have square sides and would read as a cut-off slab.
  assert.equal(solidTerrainFrame(false, false, false, right), "terrain_grass_horizontal_left");
  assert.equal(solidTerrainFrame(false, false, left, right), "terrain_grass_horizontal_middle");
  assert.equal(solidTerrainFrame(false, false, left, false), "terrain_grass_horizontal_right");

  // A lone tile, which a platform truncated against the goal's keep-out can be.
  assert.equal(solidTerrainFrame(false, false, false, false), "terrain_grass_block");

  // One tile wide.
  assert.equal(solidTerrainFrame(false, down, false, false), "terrain_grass_vertical_top");
  assert.equal(solidTerrainFrame(up, down, false, false), "terrain_grass_vertical_middle");
  assert.equal(solidTerrainFrame(up, false, false, false), "terrain_grass_vertical_bottom");
});

test("player colour is stable, spread, and defined without a wallet", () => {
  assert.equal(playerColorFor(null), PLAYER_COLORS[0]);
  assert.equal(playerColorFor(undefined), PLAYER_COLORS[0]);
  assert.equal(playerColorFor(""), PLAYER_COLORS[0]);

  const addr = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  assert.equal(playerColorFor(addr), playerColorFor(addr), "must not vary between calls");
  assert.ok(PLAYER_COLORS.includes(playerColorFor(addr)));

  // Not a uniformity claim — just that the hash does not collapse to one
  // colour, which a broken mix would.
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(playerColorFor(`5Grwva${i}Fz9rcQpDWS57CtERHpNehXCPcN`));
  assert.equal(seen.size, PLAYER_COLORS.length, "hash does not reach every colour");
});
