# The singer (3D)

A procedural singer in raw WebGL2 who sings and dances to the audio from sing.js / band.js. There are two styles on the same system: **Tang** (唐, the default) and **Song** (宋). There are no assets. The body is a signed distance field (SDF) built from primitives, polygonized at load, skinned to a skeleton, and dressed in cloth sewn from flat patterns.

Pages need a local server (`python3 -m http.server`). Node tools: see README.md (native arm64 node; `--experimental-websocket` for the tools that drive Chrome).

## Files

| file | role |
|---|---|
| `figure.js` | everything about the figure, in the browser and in Node (exports `FIG`): the SDF tree, polygonizer, skeleton, skinning, face rig, hair, ornaments, the sewn garments and their colliders, the cloth driver `GSim`, `perform()` (choreography, lip-sync, camera plan) and the figure-file upgrade |
| `stage.js`, `stage.html` | renderer (shaders, shadows, bloom), props (screen, lamps), audio, subtitles, UI, and the `?shot` / `?video` modes |
| `figure.tang.json`, `figure.song.json` | one complete figure per style: body, skeleton, face parameters, hair, costume, ornaments, makeup paint |
| `edit.html`/`.js` | shape editor: body, skeleton, hair masses, ornaments, cords |
| `face.html`/`.js` | makeup painter and lash editor |
| `shawl.html`/`.js` | path editor for the Tang shawl (帔帛) |
| `cloth_sim/` | the cloth solver: `cloth.js` (`Cloth`, `ClothAsync`, `warmup`) and `clothworker.js` |
| `tool/video.js` (+ `video_page.js`), `tool/stills.js`, `tool/maker.js`, `tool/videos.sh` | video rendering and the maker server |
| `tool/check.js` (+ `motion.js`) | geometry, cloth and motion checker |
| `tool/svg2outline.js` | turns a traced SVG outline into the built-in ornament shapes |

## Pages

**stage.html.** The UI has poem, music (voice + 簫/琵琶 or full band), play, camera (auto / full / medium / face / orbit) and the 唐/宋 style selectors. In orbit mode: drag to rotate; shift-, right-, middle- or two-finger drag to pan; wheel or pinch to zoom; double-click to reset.

| URL parameter | effect |
|---|---|
| `style=tang\|song` | which figure file (`figure.<style>.json`); `fig=path` loads any file |
| `poem=i`, `seed=n`, `band` | preset poem, choreography seed, full band |
| `text=…&title=…&mode=…&tempo=…` | a custom poem (used by the video tool) |
| `era=high` | 盛唐 pronunciation (README) |
| `prelude=short\|none` | shorter instrumental opening (about 3 s) or none |
| `cam=full\|medium\|face\|auto\|orbit`, `az el dist fov tx ty tz` | camera |
| `res=0.005&fine=0.0018` | body mesh resolution (body / face and hands, metres) |
| `headdress=zhucui\|baijiao\|gele` | Song headdress |
| `only=…`, `hide=…` | show only, or hide, these garment pieces (names below) |
| `brow=…` | preview a brow style |
| `shawl=file\|0` | load a drawn shawl from a file, or use the older key-point path |
| `cloth=old` | the older cloth system, for comparison |
| `shot&t=12.3`, `video` | a single still frame, or offline frames for the video tool |

**edit.html** (`?style=`):
- Click to select; ⇧/⌘ adds to the selection or box-selects.
- W / E / R move, rotate, scale; Q toggles world/local axes; F frames the selection.
- L/R mirroring is on by default.
- The hierarchy has groups for "body", "hair" (side/back masses held to the head, buns free), "ornaments" and "cords".
- Panels for blend radius, material, bone, mirror partner and joint editing; a pose slider previews the skinning.
- Saving downloads `figure.<style>.json`.

**face.html** (`?style=`):
- Paint layers: powder 鉛粉, rouge, eyes, brows, lips, ornaments. Each layer has opacity, blend and gloss.
- Tools: brush, eraser, blur, eyedropper and stamps (brow styles, 花鈿, lips).
- Mirror, undo/redo, flat or lit view, and mouth / blink / hair toggles.
- Lash panel: length, curl, density, thickness, colour, inner/mid/outer profile, and three draggable control points per lid.
- Saves into the figure file.

**shawl.html** (Tang):
- The figure, dressed and settled, in the A-pose or the rest pose.
- The shawl's centreline is a Catmull–Rom curve through control points. Drag them with a gizmo, insert or delete points, and set a twist (roll) per point.
- Pins: any point can be a rigid or soft pin on a bone.
- "settle" lays and settles the shawl; "play" runs the warm-up and the dance on a poem. A red overlay marks shawl triangles pierced by the body and shawl edges passing through the robe, sleeves or skirt.
- Export writes `shawl.tang.json`. When present, that file overrides the built-in shawl (`SHAWL_DEF.tang` in figure.js).

## Figure file

- **`body`**: the SDF tree.
  - A group is `{group, op: union|subtract, k (smooth-blend radius), kids}`. A primitive is `{id, type, bone, sig (weight falloff), mat (skin|lip|nail|brow), mirror (partner id)}`.
  - Primitive types:
    - `sphere {c, r}`
    - `ellipsoid {c, r:[a,b,c], u, v}`
    - `cone {a, b, ra, rb}`, optionally with `s` (elliptic section), `u` (section orientation) and `capA`/`capB` (end roundness)
    - `shell {c, r, t, u, v}` (hollow ellipsoid of thickness t)
    - `special` (eye opening, lips, mouth slit)
  - Code finds some groups by name: `head`, `neck`, `armL/R` (inside `elbowL/R`), `legL/R`, `face`.
- **`params`**:
  - eye centre and radius, mouth, `eyeOpening`, `lips`;
  - `lashes`: length, curl, density, thickness, colour, profile, control points.
- **`skeleton`**: joint rest positions, finger tips, palm normals. The rig is built from it.
- **`hair.<key>`** (key `tang`, or `song_<headdress>`): hairline, strands, volume, and `masses` (the editable primitive groups the hair cap is built from).
- **`costume.<style>`**: `garments` (the sewn patterns, below) plus style options: Song's headdress, comb, the 珠翠 spray and the jade ring.
- **`ornaments`**: traced pieces, e.g. `{name, shape, thickness, round, relief, bend, pearls {r, gap, offset, stalk}, material, mirror, seat, place}`. `shape` names an outline in figure.js (`ORN_SHAPES`, generated by `tool/svg2outline.js` from `tool/<name>.svg`; trace one closed path, any units).
- **`cords`**: silk cords tied round the hair, `{name, wraps, thickness, color, seat, ends, place}`.
- **`decals`** / **`paint`**: makeup. Paint layers are PNGs in a cylindrical projection around the head; when paint exists, the decals are only the starting point for "reset from decals".
- **`version`**: `FIG.upgrade` brings older files up to date (idempotent; the editors run it on open).

## Pipeline

1. **Geometry.**
   - The SDF is compiled and meshed with surface nets, finer on the face and hands.
   - Small holes are sealed, and per-vertex occlusion and thickness are baked.
   - In the browser this runs in a worker and is cached in IndexedDB, keyed by the figure file and `BUILD_VERSION`. Bump `BUILD_VERSION` in figure.js whenever geometry code changes.
2. **Skinning.**
   - Each bone's weight comes from a soft minimum over its primitives' distances, smoothed and limited to 4 bones per vertex.
   - The back of the elbow (olecranon) rides with the forearm.
   - The face rig splits the head weights (jaw, lips, corners, cheeks, brows, lids).
   - Dual-quaternion skinning, in the shader and in Node.
3. **Performance** (`FIG.perform`):
   - Key poses are placed on the phrase grid. Tang: rest, stand, fold, offer, lift, orchid, spread, sweep, bow. Song: a smaller, more upright set with 叉手.
   - The intro (a greeting bow and turn) is used only when the prelude is long enough.
   - A smoothed spline runs through the poses, with:
     - overlapping action, where shoulder, elbow, wrist and fingers each lag a little;
     - lift on high notes and bows at cadences;
     - layered micro-noise, soft joint limits and capsule self-collision.
   - Lip-sync from the IPA; blinks, saccades, breaths.
   - The camera plan is one continuous shot: framing changes at phrase boundaries with eased, speed-limited moves and a slow orbit drift.
4. **Cloth** (cloth_sim, XPBD): inextensible stretch, isometric bending, swept capsule colliders with friction, particle self-collision and a floor.
   - **Garments** are sewn from flat panels (Delaunay-triangulated outlines welded along named seams, with rest lengths from the pattern). They hang from a few pins and otherwise rest on the body by contact.
     - Tang:
       - 裙 skirt: three flared panels, pooling on the floor;
       - 裙腰 band: above the bust, with the dark patterned border;
       - 裙帶 ribbons and knot;
       - 大袖紗羅衫: open-front gauze robe with wide sleeves;
       - 帔帛: shawl along the drawn path, pinned at the elbows.
     - Song:
       - 褙子: straight collar, side slits, narrow sleeves, 領抹 edge bands;
       - 抹胸: a wrap closed at the back;
       - 百迭裙: the pleated skirt;
       - the belt with its bow and ribbons, and the 玉環綬 jade ring riding on them.
   - **Colliders**: about 77 capsules fitted to the bind-pose surface. Each capsule end follows the skin it covers. Per costume, `garments.grow` enlarges chosen capsules and `garments.bustTips` adds a bust-tip sphere fitted to the current shape.
   - **Warm-up**: seams relax without gravity, garments hang in the A-pose, then ease into the first pose. The shawl is laid last, outside the robe.
   - **Stepping**: fixed 1/60 s steps (variable steps make XPBD stiffness pulse). Live, the steps run in a worker (`ClothAsync`), and the body is drawn at the time of the cloth state shown. Shots, video and the checker step the same way synchronously, so the video matches the stage.
5. **Secondary motion**: bracelets, 步搖 and earring bead chains, flower sway (small substepped simulations).
6. **Rendering**:
   - **Skin**: wrap diffuse with warm scatter, matte two-lobe specular, paint layers.
   - **Other shaders**: eyes with refraction, Kajiya-Kay hair, lashes, silk and gauze.
   - **Lighting and post**: PCSS shadows, HDR, MSAA, bloom.
   - **Subtitles**: character, Baxter and IPA per syllable. HanaMinA for the characters, Source Code Pro for the romanization. The IPA uses register-aware Chao tone letters.

Garment names for `only=` / `hide=` (also printed in the console and returned by `STAGE.garments()`):
- **Tang:** `band`, `skirt`, `robeB`, `robeFL`, `robeFR`, `sleeveL`, `sleeveR`, `shawl`, `sashL`, `sashR`, `sashKnot`, `shoeL`, `shoeR`.
- **Song:** `band` (抹胸), `skirt`, `belt`, `robeB`, `robeFL`, `robeFR`, `sleeveL`, `sleeveR`, `sashL`, `sashR`, `sashKnot`, `jadeRing`, the shoes.
- **Groups:** `robe`, `sleeves`, `sash`, `shoes`, `beizi`/`褙子`, `moxiong`/`抹胸`/`collar`, `裙`, `衫`, `帔帛`, `裙帶`.

Example: `stage.html?style=song&hide=beizi`.

## Video

`node --experimental-websocket tool/video.js [--poem 2 | --file poems.txt --only k] [--style song] [--band full] [--fps 30] [--res 720] [--aspect portrait] [--prelude short|none] [--era high] [--t0 --t1] [--out file]`

- **Rendering:** headless Chrome renders `stage.html?video` frame by frame (frame n at t = n/fps on the audio clock), 2× supersampled, with burnt-in subtitles. About 1 minute per 50 s of song.
- **Encoding:** WebCodecs, H.264 + AAC into a hand-written MP4 muxer, with a WebM fallback. The AAC encoder delay is measured and trimmed, so audio and video stay in sync.
- **Portrait:** `--aspect portrait` gives 9:16. The subtitles are scaled once per song, so its longest line just fits the width, and raised clear of phone UI. The output name gets `_9x16`; `--prelude` adds `_short` / `_none`.
- **Stills:** `tool/stills.js file.mp4 t1 t2 …` pulls stills (`VW=720 VH=1280` for portrait).

## Checker

`node tool/check.js [--style song] [--poem 0 --seed 1 --step 0.1]` runs over the whole song plus extreme poses:
- **attachment:** every part within 2 mm of its parent, one connected figure;
- **pins:** pins and knots on their anchors;
- **cloth inside the body:** particles and triangles;
- **layering:** outer cloth passing through the layer below;
- **z-fighting:** near-coplanar surfaces that would flicker;
- **stretch:** per garment;
- **jitter at rest;**
- **sync under load;**
- **motion:** joint speed, acceleration and jerk; limb self-collision; camera speed and zoom rates.

`--shawl` reports the shawl's path, hand piercings and crossings.

## Tuned values worth keeping

- Fixed 1/60 s cloth steps, damping 3, self-collision radius 9.5 mm (smaller lets layers slip through), compression stiffness 0.1.
- Collider fit and per-costume growth (Song +8 / +5 / +3 mm), bust tips 60 mm (Tang), the skirt's 4 mm forward offset (`band.fwd`).
- Skin roughness about 0.56 (powder 0.66). A small shadow offset at the front of the armpits removes a self-shadowing band at grazing light.
- In long one-line statements, put comments on their own line: a `//` has swallowed code before. figure.js is `'use strict'`.
