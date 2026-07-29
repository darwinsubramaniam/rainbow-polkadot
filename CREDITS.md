# Credits

## Art and audio

The platformer's sprites come from **[Kenney](https://kenney.nl)** — *New Platformer
Pack 1.1*, released under [CC0 1.0](http://creativecommons.org/publicdomain/zero/1.0/).
Attribution is not required by the licence; it is here because the pack is good
and Kenney funds it through [donations](https://kenney.nl/donate) and
[Patreon](https://patreon.com/kenney).

What ships in `app/public/art/` is a subset: the four 64 px "Default"
spritesheets, repacked from Kenney's Starling XML into PixiJS spritesheet JSON
by `app/scripts/pack-art.mjs`. The pack's `Vector/`, `Double/`, and loose
`Sprites/` directories are ~2.8 MB of source art and duplicate resolutions that
the app never reads, so they are not committed. To regenerate:

```sh
cd app && node scripts/pack-art.mjs /path/to/kenney_new-platformer-pack-1.1
```
