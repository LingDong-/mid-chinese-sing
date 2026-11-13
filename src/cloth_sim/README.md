# cloth_sim

Standalone garment cloth simulation for the web. Plain JavaScript, no dependencies; renders with WebGL2 in the demo
but the solver only produces positions/normals/indices, so it drops into any renderer.

    python3 -m http.server      # any static server, then open index.html

Files

- `cloth.js`     the solver (`Cloth`), a Web Worker wrapper (`ClothAsync`) and `warmup()`
- `clothworker.js` worker entry used by `ClothAsync`
- `garments.js`  procedural garments: tailored ones from flat sewing patterns (front/back/sleeve panels, Delaunay
                 triangulated, welded along named seams) and draped strips (shawl, sash, cape, ribbon)
- `body.js`      capsule mannequin: skeleton, procedural motions, optional bust
- `demo.js` / `index.html`  viewer. URL params: `garment, motion, bust=1, worker=1, spacing, bend, comp, mu, th, substeps, self=0, wire=1, strobe=4`

## How the solver works

XPBD (position based dynamics with compliance), 12 substeps per frame, one Gauss-Seidel pass per substep:

- stretch: distance constraints on every triangle edge, compliance 0 (inextensible), with reduced stiffness under
  compression (`compressionStiffness`) so fabric buckles into folds instead of acting like a shell
- bending: isometric (hinge Laplacian) bending, rank-one form, flat rest state taken from the 2D pattern.
  `bendCompliance` is the main fabric knob: ~3 canvas, 15 soft cotton, 40 silk
- collisions: capsules (and a ground plane), colliders interpolated per substep between the previous and current
  pose so fast limbs never tunnel; Coulomb friction against the moving skin; collision runs last so every frame ends
  penetration free. Overlapping capsules are handled with up to 3 passes per particle
- self collision: particle repulsion through a spatial hash, excluding 2-ring neighbours. The particle radius is
  0.35 x spacing by default; setting it close to the spacing makes the mesh fight itself and never settle
- rest lengths come from the sewing pattern (`mesh.uvTri`) when present, otherwise from the initial 3D positions

Measured on an M3 Max in Chrome: 1.4k particles (t-shirt) 3 ms, 3.7k (dress, coat) 8-10 ms, 6.4k (floor-length
gown) 15 ms per frame. Chrome's JIT needs a few seconds to warm up on first use; call `warmup()` once at start-up
(the demo and the worker do) so the first garment doesn't stutter.

## Integration

```js
import { Cloth, ClothAsync, warmup } from './cloth.js';
warmup();
const cloth = new Cloth(mesh, { bendCompliance: 15, thickness: 0.006 });
cloth.resetColliders(capsules);      // Float32Array, 7 per capsule: ax ay az bx by bz r (world space, metres)
cloth.resetPinTargets(pinTargets);   // Float32Array, 3 per pin, world space
// every frame:
cloth.setColliders(capsules);        // current pose; the solver sweeps from the previous one
cloth.setPinTargets(pinTargets);
cloth.step(dt);                      // dt ~ 1/60; clamp large dts yourself
cloth.computeNormals();
upload(cloth.positions, cloth.normals, cloth.indices);
```

`mesh` needs `positions` (3n), `indices` (triangles) and optionally `pins` (`[{i, compliance}]`: kinematic, or with `compliance` > 0 (m/N) pulled toward the target by a soft constraint), `uvTri` (2D pattern coords per
triangle corner), `stitches`, `shear`. `garments.js` produces these; the body it expects exposes joint positions,
radii, `armDir(side)` and `restInverse(bone)` (see `body.js`), so other characters can be fitted by giving the same.

`ClothAsync` has the same inputs but runs the solver in a worker: call `update(dt, capsules, pinTargets)` every
frame; results arrive a frame later with `renderColliders`, the pose they belong to, so draw the character with that
pose to keep cloth and skin in sync.

A fresh garment needs about half a second of settling on the still body before it is shown (the demo runs 30
steps in `build()`); after that the residual motion at rest is a fraction of a millimetre.

Pinned vertices follow a bone rigidly (local offset in the bone frame, computed in the rest pose). Garments hang from
a few pins (back neckline, waistband, shoulder points) and otherwise rest on the body by contact.

## Garments

shirt, jacket, trenchcoat (open front, flared), dress, gown (pools on the floor), skirt, longskirt: sewn from panels.
Pattern parameters are in `makeGarment` (ease, hem, sleeve length, armhole depth); the panel outlines are plain 2D
polylines so new silhouettes are a matter of editing those. shawl, sash (over the shoulder), cape, ribbon: strips laid
along a path. `spacing` sets the particle spacing in metres (0.025 default; 0.018 looks silkier at ~2x the cost).

## Known limits

- cloth caught in a tight crease between two colliders (armpit with the arm clamped down) is pushed to one surface,
  which can stretch a few edges there momentarily
- self collision is particle based; very thin folds can still interpenetrate under violent motion
- at 60 fps the solver is CPU bound at roughly 6-7k particles on a fast laptop; use the worker to keep the main
  thread free, or lower `substeps` (10 still behaves well)
