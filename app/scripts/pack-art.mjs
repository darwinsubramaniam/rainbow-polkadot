// Convert the Kenney art pack into the four atlases the app ships.
//
// This is an AUTHOR-TIME step, not a build step, and deliberately so. Unlike
// `sync-wasm`, whose output must be regenerated on every build because the
// bundled bytes have to hash to the on-chain `rulesHash`, the art is inert: it
// cannot change what the enclave computes. So the outputs are committed and the
// raw pack stays out of the repo, which keeps ~2.8 MB of unused vector, double
// resolution, and per-file duplicates from being cloned by everyone forever.
//
// Run it again only when the pack is upgraded:
//
//   node scripts/pack-art.mjs [path-to-pack]
//
// It reads Kenney's Starling-format XML and emits PixiJS spritesheet JSON. Only
// `frame` is written per entry: the pack's frames are untrimmed and unrotated,
// and Pixi falls back to the frame rect for the source size when `sourceSize`
// is absent (see Spritesheet._processFrames). Writing the redundant fields
// anyway would roughly double the JSON for no behavioural difference.

import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEST_DIR = path.join(HERE, "..", "public", "art");

const DEFAULT_PACK = path.join(HERE, "..", "..", "kenney_new-platformer-pack-1.1");

/**
 * Groups to emit, and the pack file each comes from.
 *
 * The "Default" (64 px tile) variants only. "Double" is 128 px, which the
 * renderer would immediately halve, and the Vector/ directory is source art.
 */
const GROUPS = ["tiles", "characters", "enemies", "backgrounds"];

/**
 * Sound files to copy, mirroring SFX_FILES in src/game/artFrames.ts.
 *
 * Six of the pack's ten: only what the game triggers. `artFrames.test.ts`
 * asserts this list and the cue table have not drifted apart.
 */
const SOUNDS = [
  "sfx_jump.ogg",
  "sfx_coin.ogg",
  "sfx_hurt.ogg",
  "sfx_disappear.ogg",
  "sfx_magic.ogg",
  "sfx_select.ogg",
];

const packDir = process.argv[2] ?? DEFAULT_PACK;

/** Parse Starling `<SubTexture>` entries into Pixi's frame dictionary. */
function parseAtlas(xml) {
  const frames = {};
  const re = /<SubTexture\s+name="([^"]+)"\s+x="(\d+)"\s+y="(\d+)"\s+width="(\d+)"\s+height="(\d+)"\s*\/>/g;

  for (const m of xml.matchAll(re)) {
    const [, name, x, y, w, h] = m;
    if (name in frames) throw new Error(`duplicate frame "${name}"`);
    frames[name] = { frame: { x: +x, y: +y, w: +w, h: +h } };
  }

  if (Object.keys(frames).length === 0) throw new Error("no <SubTexture> entries matched");
  return frames;
}

/** PNG dimensions straight out of the IHDR chunk, so no image decoder is needed. */
function pngSize(file) {
  const b = readFileSync(file);
  if (b.readUInt32BE(12) !== 0x49484452) throw new Error(`${file}: not a PNG (no IHDR)`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

try {
  statSync(packDir);
} catch {
  console.error(`\npack-art: cannot read ${packDir}`);
  console.error("Pass the pack directory as an argument, or download it from kenney.nl.\n");
  console.error("This is only needed to regenerate app/public/art/ — the outputs are committed.\n");
  process.exit(1);
}

mkdirSync(DEST_DIR, { recursive: true });

// Frame names are used as a single flat namespace by the loader, so a collision
// between two sheets would silently shadow one of them.
const seen = new Map();
let totalBytes = 0;

for (const group of GROUPS) {
  const srcPng = path.join(packDir, "Spritesheets", `spritesheet-${group}-default.png`);
  const srcXml = path.join(packDir, "Spritesheets", `spritesheet-${group}-default.xml`);

  const frames = parseAtlas(readFileSync(srcXml, "utf8"));
  const size = pngSize(srcPng);

  for (const name of Object.keys(frames)) {
    const other = seen.get(name);
    if (other) throw new Error(`frame "${name}" appears in both ${other} and ${group}`);
    seen.set(name, group);
  }

  copyFileSync(srcPng, path.join(DEST_DIR, `${group}.png`));
  writeFileSync(
    path.join(DEST_DIR, `${group}.json`),
    `${JSON.stringify({ frames, meta: { image: `${group}.png`, format: "RGBA8888", size, scale: 1 } })}\n`,
  );

  const bytes =
    statSync(path.join(DEST_DIR, `${group}.png`)).size +
    statSync(path.join(DEST_DIR, `${group}.json`)).size;
  totalBytes += bytes;

  console.log(
    `pack-art: ${group.padEnd(12)} ${String(Object.keys(frames).length).padStart(3)} frames  ` +
      `${size.w}x${size.h}  ${(bytes / 1024).toFixed(0)} KB`,
  );
}

// -- sounds -----------------------------------------------------------------

const sfxDir = path.join(DEST_DIR, "sfx");
mkdirSync(sfxDir, { recursive: true });

let sfxBytes = 0;
for (const file of SOUNDS) {
  copyFileSync(path.join(packDir, "Sounds", file), path.join(sfxDir, file));
  sfxBytes += statSync(path.join(sfxDir, file)).size;
}
totalBytes += sfxBytes;
console.log(
  `pack-art: ${"sounds".padEnd(12)} ${String(SOUNDS.length).padStart(3)} files` +
    `${" ".repeat(12)}${(sfxBytes / 1024).toFixed(0)} KB`,
);

console.log(`pack-art: ${(totalBytes / 1024).toFixed(0)} KB total -> public/art/`);
