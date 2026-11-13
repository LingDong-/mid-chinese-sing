// cloth.js — standalone garment cloth simulation (XPBD, substepped, CPU).
// Units: meters, seconds, kilograms.  No dependencies.
//
//   const cloth = new Cloth(mesh, params)
//     mesh.positions : Float32Array(3n)  initial world positions
//     mesh.indices   : Uint32Array       triangles
//     mesh.uvTri     : Float32Array(6T)  optional: flat sewing-pattern coords per triangle corner; rest lengths come from these
//     mesh.shear     : Int32Array(2k)    optional: edges (vertex pairs) that are quad diagonals -> softer shear compliance
//     mesh.stitches  : Int32Array(2k)    optional: vertex pairs sewn together (zero rest length)
//     mesh.pins      : [{i, target:[x,y,z], compliance}] vertices driven kinematically (compliance > 0, m/N: pulled toward the target by a soft XPBD constraint instead)
//     mesh.massScale, mesh.bendScale, mesh.friction : Float32Array(n) optional per-vertex fabric: mass and bending-compliance multipliers, friction coefficient
//   each frame:
//     cloth.setColliders(capsules)  // Float32Array, 7 per capsule: ax ay az bx by bz r (world space)
//     cloth.setPinTargets(targets)  // Float32Array(3*pins.length), world space
//     cloth.step(dt)
//   read cloth.positions, cloth.normals (after cloth.computeNormals()), cloth.indices

const HALF = new Int8Array([0,0,0, 1,0,0, -1,1,0, 0,1,0, 1,1,0, -1,-1,1, 0,-1,1, 1,-1,1, -1,0,1, 0,0,1, 1,0,1, -1,1,1, 0,1,1, 1,1,1]);

export const defaultParams = {
  substeps: 12,
  gravity: -9.81,
  density: 0.25,          // kg/m^2
  stretchCompliance: 0,   // m/N  (0 = inextensible)
  shearCompliance: 2e-5,
  bendCompliance: 15,     // isometric bending compliance (scaled by hinge area): ~3 stiff canvas, 15 soft cotton, 40 silk
  thickness: 0.006,       // collision offset from body surface (m)
  friction: 0.5,          // static+kinetic coefficient vs body
  damping: 0.6,           // 1/s velocity damping
  compressionStiffness: 0.3, // 0..1 fraction of stretch stiffness used when an edge is shorter than rest (lets cloth buckle into folds instead of acting like a shell)
  noise: 0.001,           // m of random jitter added to the initial positions (seeds buckling; symmetric meshes otherwise stay symmetric)
  ground: null,           // y of a ground plane the cloth collides with, or null
  selfCollision: true,
  selfRadius: 0,          // particle radius for self-collision (m); 0 = automatic, 0.35 x particle spacing (larger values fight the mesh and never settle)
  maxSpeed: 30,           // m/s clamp (safety)
};

export class Cloth {
  constructor(mesh, params = {}) {
    const p = this.params = Object.assign({}, defaultParams, params);
    const n = this.n = mesh.positions.length / 3;
    this.x = new Float64Array(mesh.positions); // solver state (doubles are ~10% faster in V8 and avoid float32 round-off creep)
    if (p.noise) { let seed = 1234; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5; for (let i = 0; i < 3 * n; i++) this.x[i] += p.noise * rnd(); }
    this.positions = new Float32Array(this.x); // public copy, refreshed at the end of step()
    this.prev = new Float64Array(this.x);
    this.vel = new Float64Array(3 * n);
    this.normals = new Float32Array(3 * n);
    this.indices = mesh.indices instanceof Uint32Array ? mesh.indices : new Uint32Array(mesh.indices);
    this.uv = mesh.uv || null;
    this.panel = mesh.panel || new Int32Array(n);
    this.stitches = mesh.stitches || null;
    this.shearEdges = mesh.shear || null;
    this.uvTri = mesh.uvTri || null; // flat pattern coords per triangle corner (6 per triangle): rest lengths/areas come from the pattern, not the 3D placement
    this.invMass = new Float32Array(n);
    this.pins = (mesh.pins || []).map(q => ({ i: q.i, c: q.compliance || 0 }));
    this.pinTargets = new Float32Array(3 * this.pins.length);
    this.pinPrev = new Float32Array(3 * this.pins.length);
    for (let k = 0; k < this.pins.length; k++) {
      const q = mesh.pins[k], t = q.target || [this.x[3*q.i], this.x[3*q.i+1], this.x[3*q.i+2]];
      this.pinTargets.set(t, 3 * k); this.pinPrev.set(t, 3 * k);
    }
    this.restPositions = mesh.positions; this.massScale = mesh.massScale || null; this.mu = mesh.friction || null;
    this._buildConstraints();
    if (mesh.bendScale) for (let k = 0; k < this.nBend; k++) { const I = this.bendIdx, o = 4 * k; this.bendArea[k] /= 0.25 * (mesh.bendScale[I[o]] + mesh.bendScale[I[o+1]] + mesh.bendScale[I[o+2]] + mesh.bendScale[I[o+3]]); }
    if (!p.selfRadius) p.selfRadius = 0.35 * this.restSpacing;
    this._buildMasses(p.density);
    for (const q of this.pins) if (!q.c) this.invMass[q.i] = 0;
    this.colliders = new Float32Array(0); this.collPrev = new Float32Array(0);
    this.candStart = new Int32Array(n + 1); this.cand = new Int32Array(0);
    this.time = 0;
    this.stats = { ms: 0, contacts: 0 };
    // self collision hash
    this.hashSize = 1 << Math.ceil(Math.log2(2 * n)); this.hashStart = new Int32Array(this.hashSize + 1); this.hashIdx = new Int32Array(n);
    this.neighStart = new Int32Array(n + 1); this.neigh = new Int32Array(0);
    this._cellTmp = new Int32Array(n); this._fillTmp = new Int32Array(this.hashSize); this._capTmp = new Float32Array(14); this._sph = new Float32Array(4); this._contacts = 0;
  }

  _buildMasses(density) {
    const x = this.restPositions, idx = this.indices, m = new Float32Array(this.n), uvT = this.uvTri;
    for (let t = 0; t < idx.length; t += 3) {
      let area;
      if (uvT) { const o = 2 * t; area = 0.5 * Math.abs((uvT[o+2]-uvT[o]) * (uvT[o+5]-uvT[o+1]) - (uvT[o+4]-uvT[o]) * (uvT[o+3]-uvT[o+1])) * density / 3; }
      else { const a = 3 * idx[t], b = 3 * idx[t+1], c = 3 * idx[t+2];
        const ux = x[b]-x[a], uy = x[b+1]-x[a+1], uz = x[b+2]-x[a+2], vx = x[c]-x[a], vy = x[c+1]-x[a+1], vz = x[c+2]-x[a+2];
        const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
        area = 0.5 * Math.sqrt(nx*nx+ny*ny+nz*nz) * density / 3; }
      m[idx[t]] += area; m[idx[t+1]] += area; m[idx[t+2]] += area;
    }
    const floor = density * this.restSpacing * this.restSpacing * 0.3; // avoid extreme mass ratios at slivers
    for (let i = 0; i < this.n; i++) this.invMass[i] = m[i] > 0 ? 1 / (Math.max(m[i], floor) * (this.massScale ? this.massScale[i] : 1)) : 0;
  }

  _buildConstraints(x = this.restPositions) {
    const idx = this.indices, uvT = this.uvTri;
    // edges: key -> {a,b, opp:[], len:[]} (len = rest length of the edge as seen from each adjacent triangle)
    const edges = new Map();
    const key = (a, b) => a < b ? a * this.n + b : b * this.n + a;
    const shearSet = new Set(); if (this.shearEdges) for (let k = 0; k < this.shearEdges.length; k += 2) shearSet.add(key(this.shearEdges[k], this.shearEdges[k+1]));
    const dist3 = (a, b) => { const dx = x[3*a]-x[3*b], dy = x[3*a+1]-x[3*b+1], dz = x[3*a+2]-x[3*b+2]; return Math.sqrt(dx*dx+dy*dy+dz*dz); };
    for (let t = 0; t < idx.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = idx[t + e], b = idx[t + (e + 1) % 3], c = idx[t + (e + 2) % 3];
        const k = key(a, b);
        let E = edges.get(k);
        if (!E) { E = { a: Math.min(a, b), b: Math.max(a, b), opp: [], len: [] }; edges.set(k, E); }
        E.opp.push(c);
        if (uvT) { const o = 2 * (t + e), p = 2 * (t + (e + 1) % 3); E.len.push(Math.hypot(uvT[o] - uvT[p], uvT[o+1] - uvT[p+1])); } else E.len.push(dist3(a, b));
      }
    }
    const dist = (a, b) => edges.get(key(a, b)).len[0];
    // per-triangle edge length lookup for hinge layouts (edge a-b inside triangle that has opposite vertex c)
    const triLen = (a, b, c) => { const E = edges.get(key(a, b)); const i = E.opp.indexOf(c); return E.len[i < 0 ? 0 : i]; };
    // stretch constraints: structural first then shear
    const sIdx = [], sRest = [], hIdx = [], hRest = [];
    const bend = [];
    for (const [k, E] of edges) {
      if (shearSet.has(k)) { hIdx.push(E.a, E.b); hRest.push(dist(E.a, E.b)); } else { sIdx.push(E.a, E.b); sRest.push(dist(E.a, E.b)); }
      if (E.opp.length === 2) bend.push([E.a, E.b, E.opp[0], E.opp[1]]);
    }
    if (this.stitches) for (let k = 0; k < this.stitches.length; k += 2) { sIdx.push(this.stitches[k], this.stitches[k+1]); sRest.push(0); }
    this.stretchIdx = new Int32Array(sIdx); this.stretchRest = new Float32Array(sRest);
    this.shearIdx = new Int32Array(hIdx); this.shearRest = new Float32Array(hRest);
    // isometric bending (Bergou et al.): Q = 3/(A0+A1) K K^T with K from flat cotangents.
    // flat layout of the two triangles from rest edge lengths.
    const nb = bend.length;
    this.bendIdx = new Int32Array(4 * nb); this.bendK = new Float32Array(4 * nb); this.bendArea = new Float32Array(nb);
    const cot = (ax, ay, bx, by) => (ax*bx + ay*by) / Math.max(1e-12, Math.abs(ax*by - ay*bx)); // cot of angle between vectors
    let nbValid = 0;
    for (let k = 0; k < nb; k++) {
      const [i0, i1, i2, i3] = bend[k];
      const l01 = triLen(i0, i1, i2), l02 = triLen(i0, i2, i1), l12 = triLen(i1, i2, i0), l03 = triLen(i0, i3, i1), l13 = triLen(i1, i3, i0);
      // lay flat: x0=(0,0), x1=(l01,0), x2 above, x3 below
      const p0 = [0, 0], p1 = [l01, 0];
      const c2 = (l02*l02 - l12*l12 + l01*l01) / (2*l01), h2 = Math.sqrt(Math.max(0, l02*l02 - c2*c2));
      const c3 = (l03*l03 - l13*l13 + l01*l01) / (2*l01), h3 = Math.sqrt(Math.max(0, l03*l03 - c3*c3));
      const p2 = [c2, h2], p3 = [c3, -h3];
      const A0 = 0.5 * l01 * h2, A1 = 0.5 * l01 * h3;
      if (A0 < 1e-10 || A1 < 1e-10) continue;
      // cotangents: c01 at x0 between (x1-x0, x2-x0); c02 at x1 between (x0-x1, x2-x1); c03 at x0 between (x1-x0,x3-x0); c04 at x1 between (x0-x1,x3-x1)
      const c01 = cot(p1[0]-p0[0], p1[1]-p0[1], p2[0]-p0[0], p2[1]-p0[1]);
      const c02 = cot(p0[0]-p1[0], p0[1]-p1[1], p2[0]-p1[0], p2[1]-p1[1]);
      const c03 = cot(p1[0]-p0[0], p1[1]-p0[1], p3[0]-p0[0], p3[1]-p0[1]);
      const c04 = cot(p0[0]-p1[0], p0[1]-p1[1], p3[0]-p1[0], p3[1]-p1[1]);
      // hinge Laplacian weights (sum to 0, annihilate the flat layout). Q = 3/(A0+A1) K K^T is rank one, so the
      // bending constraint is C = |m| with m = sum_i K'_i x_i, K' = sqrt(3/(A0+A1)) K.
      const K = [c02 + c04, c01 + c03, -c01 - c02, -c03 - c04], sq = Math.sqrt(3 / (A0 + A1));
      this.bendK.set([sq * K[0], sq * K[1], sq * K[2], sq * K[3]], 4 * nbValid);
      this.bendIdx.set([i0, i1, i2, i3], 4 * nbValid); this.bendArea[nbValid] = A0 + A1;
      nbValid++;
    }
    this.nBend = nbValid;
    let mean = 0; for (let i = 0; i < sRest.length; i++) mean += sRest[i]; this.restSpacing = sRest.length ? mean / sRest.length : 0.02;
    // 2-ring neighborhoods (over stretch+shear edges, incl. stitches) excluded from self-collision
    const n = this.n, deg = new Int32Array(n + 1), S = this.stretchIdx, H = this.shearIdx;
    for (let k = 0; k < S.length; k++) deg[S[k] + 1]++; for (let k = 0; k < H.length; k++) deg[H[k] + 1]++;
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    const adj = new Int32Array(deg[n]), fill = deg.slice(0, n);
    for (let k = 0; k < S.length; k += 2) { adj[fill[S[k]]++] = S[k+1]; adj[fill[S[k+1]]++] = S[k]; }
    for (let k = 0; k < H.length; k += 2) { adj[fill[H[k]]++] = H[k+1]; adj[fill[H[k+1]]++] = H[k]; }
    const es = this.exclStart = new Int32Array(n + 1), mark = new Int32Array(n).fill(-1), tmp = new Int32Array(64);
    let list = new Int32Array(32 * n), cnt = 0;
    for (let i = 0; i < n; i++) {
      let m = 0; mark[i] = i;
      for (let a = deg[i]; a < deg[i+1]; a++) { const j = adj[a]; if (mark[j] !== i) { mark[j] = i; if (m < 64) tmp[m++] = j; }
        for (let b = deg[j]; b < deg[j+1]; b++) { const k = adj[b]; if (mark[k] !== i) { mark[k] = i; if (m < 64) tmp[m++] = k; } } }
      const sub = tmp.subarray(0, m).sort();
      if (cnt + m > list.length) { const nl = new Int32Array(list.length * 2); nl.set(list); list = nl; }
      list.set(sub, cnt); cnt += m; es[i + 1] = cnt;
    }
    this.exclList = list.slice(0, cnt);
  }

  setColliders(caps) {
    if (this.collPrev.length !== caps.length) { this.collPrev = new Float32Array(caps); this.colliders = new Float32Array(caps); }
    else { const t = this.collPrev; this.collPrev = this.colliders; this.colliders = t; this.colliders.set(caps); }
  }
  // call once after the body has been moved to its initial pose so there's no sweep from zero
  resetColliders(caps) { this.colliders = new Float32Array(caps); this.collPrev = new Float32Array(caps); }

  setPinTargets(t) { const s = this.pinPrev; this.pinPrev = this.pinTargets; this.pinTargets = s; this.pinTargets.set(t); }
  resetPinTargets(t) { this.pinTargets.set(t); this.pinPrev.set(t); }

  // broadphase: which capsules can each particle touch this frame
  _broadphase(dt) {
    const n = this.n, x = this.x, v = this.vel, C = this.colliders, P = this.collPrev, nc = C.length / 7;
    const start = this.candStart; let list = this.cand; let cnt = 0;
    const th = this.params.thickness;
    // bounding sphere of each swept capsule (prev+cur poses)
    if (!this._sph || this._sph.length < 4 * nc) this._sph = new Float32Array(4 * Math.max(1, nc));
    const S = this._sph;
    for (let c = 0; c < nc; c++) {
      const o = 7 * c, q = 4 * c;
      const cx = 0.25 * (C[o]+C[o+3]+P[o]+P[o+3]), cy = 0.25 * (C[o+1]+C[o+4]+P[o+1]+P[o+4]), cz = 0.25 * (C[o+2]+C[o+5]+P[o+2]+P[o+5]);
      let rr = 0;
      for (let e = 0; e < 4; e++) { const a = e < 2 ? C : P, oo = o + 3 * (e & 1); const ex = a[oo]-cx, ey = a[oo+1]-cy, ez = a[oo+2]-cz; rr = Math.max(rr, ex*ex+ey*ey+ez*ez); }
      S[q] = cx; S[q+1] = cy; S[q+2] = cz; S[q+3] = Math.sqrt(rr) + Math.max(C[o+6], P[o+6]) + th + 0.01;
    }
    for (let i = 0; i < n; i++) {
      start[i] = cnt;
      const px = x[3*i], py = x[3*i+1], pz = x[3*i+2];
      const margin = dt * Math.sqrt(v[3*i]*v[3*i] + v[3*i+1]*v[3*i+1] + v[3*i+2]*v[3*i+2]);
      for (let c = 0; c < nc; c++) {
        const q = 4 * c, dx = px-S[q], dy = py-S[q+1], dz = pz-S[q+2], R = S[q+3] + margin;
        if (dx*dx+dy*dy+dz*dz < R*R) { if (cnt >= list.length) { const nl = new Int32Array(Math.max(64, list.length * 2)); nl.set(list); list = nl; } list[cnt++] = c; }
      }
    }
    start[n] = cnt; this.cand = list;
  }

  _buildHash() {
    const n = this.n, x = this.x, h = this.hashSize, start = this.hashStart, idx = this.hashIdx;
    const inv = 1 / (2 * this.params.selfRadius);
    start.fill(0);
    const cell = this._cellTmp;
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(x[3*i] * inv), cy = Math.floor(x[3*i+1] * inv), cz = Math.floor(x[3*i+2] * inv);
      const c = (Math.imul(cx, 92837111) ^ Math.imul(cy, 689287499) ^ Math.imul(cz, 283923481)) & (h - 1);
      cell[i] = c; start[c + 1]++;
    }
    for (let i = 0; i < h; i++) start[i + 1] += start[i];
    const fill = this._fillTmp; fill.set(start.subarray(0, h));
    for (let i = 0; i < n; i++) idx[fill[cell[i]]++] = i;
    // neighbor lists (built once per frame with margin)
    const r = 2 * this.params.selfRadius, r2 = r * r * 1.5 * 1.5, es = this.exclStart, el = this.exclList;
    const ns = this.neighStart; let nl = this.neigh; let cnt = 0;
    for (let i = 0; i < n; i++) {
      ns[i] = cnt;
      const px = x[3*i], py = x[3*i+1], pz = x[3*i+2];
      const cx = Math.floor(px * inv), cy = Math.floor(py * inv), cz = Math.floor(pz * inv);
      // half stencil: own cell (j > i) + the 13 forward neighbour cells (all j); every pair is visited once
      for (let o = 0; o < 14; o++) {
        const ox = HALF[3*o], oy = HALF[3*o+1], oz = HALF[3*o+2];
        const c = (Math.imul(cx+ox, 92837111) ^ Math.imul(cy+oy, 689287499) ^ Math.imul(cz+oz, 283923481)) & (h - 1);
        for (let k = start[c]; k < start[c + 1]; k++) {
          const j = idx[k]; if (o === 0 ? j <= i : j === i) continue;
          const dx = x[3*j]-px, dy = x[3*j+1]-py, dz = x[3*j+2]-pz;
          if (dx*dx+dy*dy+dz*dz > r2) continue;
          let ex = false; for (let e = es[i], ee = es[i+1]; e < ee; e++) { if (el[e] === j) { ex = true; break; } if (el[e] > j) break; }
          if (ex) continue;
          if (cnt >= nl.length) { const a = new Int32Array(Math.max(256, nl.length * 2)); a.set(nl); nl = a; }
          nl[cnt++] = j;
        }
      }
    }
    ns[n] = cnt; this.neigh = nl;
  }

  step(dt) {
    const t0 = performance.now();
    const p = this.params, ns = p.substeps, h = dt / ns;
    this._broadphase(dt);
    if (p.selfCollision) this._buildHash();
    const aStretch = p.stretchCompliance / (h * h), aShear = p.shearCompliance / (h * h), aBend = p.bendCompliance / (h * h);
    const nc = this.colliders.length / 7;
    if (this._capTmp.length < 14 * nc) this._capTmp = new Float32Array(14 * nc);
    const damp = Math.max(0, 1 - p.damping * h);
    this._contacts = 0;
    for (let s = 0; s < ns; s++) {
      const t1 = (s + 1) / ns;
      this._lerpColliders(t1, ns);
      this._integrate(h, damp, p.gravity, p.maxSpeed);
      this._movePins(t1, h * h);
      this._solveDistance(this.stretchIdx, this.stretchRest, aStretch, p.compressionStiffness);
      this._solveDistance(this.shearIdx, this.shearRest, aShear, p.compressionStiffness);
      this._solveBending(aBend);
      if (p.selfCollision) this._solveSelf();
      this._collide(p.thickness, p.friction); // last, so the frame ends penetration-free
      this._updateVelocities(1 / h);
    }
    this.positions.set(this.x);
    this.time += dt;
    this.stats.ms = performance.now() - t0; this.stats.contacts = this._contacts / ns;
  }

  // capsule poses at the end of this substep + their displacement during it (for friction)
  _lerpColliders(t1, ns) {
    const C = this.colliders, P = this.collPrev, capT = this._capTmp, nc = C.length / 7, th = this.params.thickness;
    for (let c = 0; c < nc; c++) {
      const o = 7 * c, q = 14 * c;
      for (let e = 0; e < 6; e++) { capT[q+e] = P[o+e] + (C[o+e] - P[o+e]) * t1; capT[q+7+e] = (C[o+e] - P[o+e]) / ns; }
      capT[q+6] = P[o+6] + (C[o+6] - P[o+6]) * t1 + th;
    }
  }

  _integrate(h, damp, g, maxV) {
    const x = this.x, px = this.prev, v = this.vel, w = this.invMass, mv2 = maxV * maxV;
    for (let i = 0, n = this.n; i < n; i++) {
      const o = 3 * i;
      if (w[i] === 0) continue;
      let vx = v[o] * damp, vy = (v[o+1] + g * h) * damp, vz = v[o+2] * damp;
      const sp = vx*vx+vy*vy+vz*vz; if (sp > mv2) { const k = maxV / Math.sqrt(sp); vx *= k; vy *= k; vz *= k; }
      px[o] = x[o]; px[o+1] = x[o+1]; px[o+2] = x[o+2];
      x[o] += vx * h; x[o+1] += vy * h; x[o+2] += vz * h;
    }
  }

  _movePins(t1, h2) {
    const x = this.x, px = this.prev, pins = this.pins, pt = this.pinTargets, pp = this.pinPrev, w = this.invMass;
    for (let k = 0; k < pins.length; k++) {
      const o = 3 * pins[k].i, q = 3 * k;
      if (pins[k].c) { const wi = w[pins[k].i]; if (!wi) continue; const f = wi / (wi + pins[k].c / h2);   // soft pin
        for (let e = 0; e < 3; e++) x[o+e] += (pp[q+e] + (pt[q+e] - pp[q+e]) * t1 - x[o+e]) * f; continue; }
      px[o] = x[o]; px[o+1] = x[o+1]; px[o+2] = x[o+2];
      x[o] = pp[q] + (pt[q] - pp[q]) * t1; x[o+1] = pp[q+1] + (pt[q+1] - pp[q+1]) * t1; x[o+2] = pp[q+2] + (pt[q+2] - pp[q+2]) * t1;
    }
  }

  _collide(th, mu0) {
    const x = this.x, px = this.prev, w = this.invMass, cs = this.candStart, cl = this.cand, capT = this._capTmp;
    let contacts = 0;
    for (let i = 0, n = this.n; i < n; i++) {
      if (w[i] === 0 || cs[i] === cs[i+1]) continue;
      const o = 3 * i;
      let X = x[o], Y = x[o+1], Z = x[o+2];
      const multi = cs[i+1] - cs[i] > 1, mu = this.mu ? this.mu[i] : mu0; let hit = false;
      for (let pass = 0, k = cs[i]; k < cs[i+1]; k++) { // up to 3 passes when several capsules overlap (one push-out can land inside another)
        if (k === cs[i+1] - 1 && multi && hit && pass < 2) { pass++; k = cs[i] - 1; hit = false; continue; }
        const q = 14 * cl[k];
        const ax = capT[q], ay = capT[q+1], az = capT[q+2], bx = capT[q+3]-ax, by = capT[q+4]-ay, bz = capT[q+5]-az, r = capT[q+6];
        let t = ((X-ax)*bx + (Y-ay)*by + (Z-az)*bz) / (bx*bx+by*by+bz*bz + 1e-12);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = X - (ax + bx*t), dy = Y - (ay + by*t), dz = Z - (az + bz*t);
        const d2 = dx*dx+dy*dy+dz*dz;
        if (d2 >= r*r) continue;
        const d = Math.sqrt(d2) + 1e-9, inv = 1 / d, nx = dx*inv, ny = dy*inv, nz = dz*inv, pen = r - d;
        X += nx * pen; Y += ny * pen; Z += nz * pen;
        contacts++; hit = true;
        // friction: relative tangential displacement vs capsule surface displacement this substep
        const sx = capT[q+7] + (capT[q+10]-capT[q+7]) * t, sy = capT[q+8] + (capT[q+11]-capT[q+8]) * t, sz = capT[q+9] + (capT[q+12]-capT[q+9]) * t;
        let rx = X - px[o] - sx, ry = Y - px[o+1] - sy, rz = Z - px[o+2] - sz;
        const rn = rx*nx + ry*ny + rz*nz; rx -= rn*nx; ry -= rn*ny; rz -= rn*nz;
        const rl = Math.sqrt(rx*rx+ry*ry+rz*rz);
        if (rl > 1e-12) {
          const f = rl < mu * pen ? 1 : Math.min(1, mu * pen / rl);
          X -= rx * f; Y -= ry * f; Z -= rz * f;
        }
      }
      x[o] = X; x[o+1] = Y; x[o+2] = Z;
    }
    const gy = this.params.ground;
    if (gy !== null && gy !== undefined) {
      const lim = gy + th;
      for (let i = 0, n = this.n; i < n; i++) {
        const o = 3 * i; if (w[i] === 0 || x[o+1] >= lim) continue;
        const pen = lim - x[o+1]; x[o+1] = lim;
        let rx = x[o] - px[o], rz = x[o+2] - px[o+2]; const rl = Math.sqrt(rx*rx + rz*rz);
        if (rl > 1e-12) { const f = rl < mu0 * pen ? 1 : Math.min(1, mu0 * pen / rl); x[o] -= rx * f; x[o+2] -= rz * f; }
      }
    }
    this._contacts += contacts;
  }

  _updateVelocities(ih) {
    const x = this.x, px = this.prev, v = this.vel;
    for (let o = 0, m = 3 * this.n; o < m; o++) v[o] = (x[o] - px[o]) * ih;
  }

  _solveDistance(idx, rest, alpha, comp) {
    const x = this.x, w = this.invMass;
    for (let k = 0, m = idx.length; k < m; k += 2) {
      const a = 3 * idx[k], b = 3 * idx[k+1], wa = w[idx[k]], wb = w[idx[k+1]], ws = wa + wb;
      if (ws === 0) continue;
      const dx = x[b]-x[a], dy = x[b+1]-x[a+1], dz = x[b+2]-x[a+2];
      const d = Math.sqrt(dx*dx+dy*dy+dz*dz); if (d < 1e-9) continue;
      const r = rest[k >> 1];
      const s = (d - r) / (ws + alpha) / d * (d < r ? comp : 1);
      const sa = s * wa, sb = s * wb;
      x[a] += dx*sa; x[a+1] += dy*sa; x[a+2] += dz*sa;
      x[b] -= dx*sb; x[b+1] -= dy*sb; x[b+2] -= dz*sb;
    }
  }

  _solveBending(alpha) {
    const x = this.x, w = this.invMass, I = this.bendIdx, K = this.bendK, A = this.bendArea;
    for (let k = 0, nb = this.nBend; k < nb; k++) {
      const o = 4 * k;
      const a = I[o], b = I[o+1], c = I[o+2], d = I[o+3], wa = w[a], wb = w[b], wc = w[c], wd = w[d];
      const ka = K[o], kb = K[o+1], kc = K[o+2], kd = K[o+3];
      const W = wa*ka*ka + wb*kb*kb + wc*kc*kc + wd*kd*kd; if (W === 0) continue;
      const ia = 3*a, ib = 3*b, ic = 3*c, id = 3*d;
      // m = sum K_i x_i (zero when the hinge is flat)
      const mx = ka*x[ia] + kb*x[ib] + kc*x[ic] + kd*x[id], my = ka*x[ia+1] + kb*x[ib+1] + kc*x[ic+1] + kd*x[id+1], mz = ka*x[ia+2] + kb*x[ib+2] + kc*x[ic+2] + kd*x[id+2];
      const s = -1 / (W + alpha / A[k]);
      const sa = s*wa*ka, sb = s*wb*kb, sc = s*wc*kc, sd = s*wd*kd;
      x[ia] += sa*mx; x[ia+1] += sa*my; x[ia+2] += sa*mz;
      x[ib] += sb*mx; x[ib+1] += sb*my; x[ib+2] += sb*mz;
      x[ic] += sc*mx; x[ic+1] += sc*my; x[ic+2] += sc*mz;
      x[id] += sd*mx; x[id+1] += sd*my; x[id+2] += sd*mz;
    }
  }

  _solveSelf() {
    const x = this.x, w = this.invMass, ns = this.neighStart, nl = this.neigh, r = 2 * this.params.selfRadius, r2 = r * r;
    for (let i = 0, n = this.n; i < n; i++) {
      const a = 3 * i, wa = w[i];
      for (let k = ns[i]; k < ns[i+1]; k++) {
        const j = nl[k], b = 3 * j, wb = w[j], ws = wa + wb; if (ws === 0) continue;
        const dx = x[b]-x[a], dy = x[b+1]-x[a+1], dz = x[b+2]-x[a+2], d2 = dx*dx+dy*dy+dz*dz;
        if (d2 >= r2 || d2 < 1e-12) continue;
        const d = Math.sqrt(d2), s = (d - r) / ws / d, sa = s * wa, sb = s * wb;
        x[a] += dx*sa; x[a+1] += dy*sa; x[a+2] += dz*sa;
        x[b] -= dx*sb; x[b+1] -= dy*sb; x[b+2] -= dz*sb;
      }
    }
  }

  computeNormals() {
    const x = this.positions, idx = this.indices, nrm = this.normals; nrm.fill(0);
    for (let t = 0; t < idx.length; t += 3) {
      const a = 3 * idx[t], b = 3 * idx[t+1], c = 3 * idx[t+2];
      const ux = x[b]-x[a], uy = x[b+1]-x[a+1], uz = x[b+2]-x[a+2], vx = x[c]-x[a], vy = x[c+1]-x[a+1], vz = x[c+2]-x[a+2];
      const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
      nrm[a] += nx; nrm[a+1] += ny; nrm[a+2] += nz; nrm[b] += nx; nrm[b+1] += ny; nrm[b+2] += nz; nrm[c] += nx; nrm[c+1] += ny; nrm[c+2] += nz;
    }
    for (let i = 0; i < nrm.length; i += 3) { const l = Math.hypot(nrm[i], nrm[i+1], nrm[i+2]) || 1; nrm[i] /= l; nrm[i+1] /= l; nrm[i+2] /= l; }
    return nrm;
  }
}

// Run a small throwaway cloth so the JIT has optimized the solver before the first real garment is built (Chrome tiers up slowly).
export function warmup(steps = 60) {
  const n = 14, pos = new Float32Array(3 * n * n), idx = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const k = j * n + i; pos[3*k] = i * 0.02; pos[3*k+1] = 1; pos[3*k+2] = j * 0.02; if (i && j) idx.push(k, k - 1, k - n, k - 1, k - n - 1, k - n); }
  const c = new Cloth({ positions: pos, indices: new Uint32Array(idx), pins: [{ i: 0 }, { i: n - 1 }] });
  c.resetColliders(new Float32Array([0.1, 0.5, 0.1, 0.2, 0.5, 0.2, 0.3]));
  for (let s = 0; s < steps; s++) { c.setColliders(new Float32Array([0.1, 0.5 + 0.001 * s, 0.1, 0.2, 0.5, 0.2, 0.3])); c.step(1 / 60); }
  c.computeNormals();
}

// Same simulation in a Web Worker (clothworker.js). Each update() posts the body pose; the worker answers with positions and
// normals. If the worker is still busy the pose is kept and the elapsed time accumulated, so the simulation never queues up.
// Results lag one frame behind: draw the body with `renderColliders` (the pose the current cloth state was computed for).
export class ClothAsync {
  constructor(mesh, params = {}, workerUrl = new URL('./clothworker.js', import.meta.url)) {
    this.n = mesh.positions.length / 3; this.indices = mesh.indices; this.pins = mesh.pins || [];
    this.positions = new Float32Array(mesh.positions); this.normals = new Float32Array(3 * this.n);
    this.params = Object.assign({}, defaultParams, params);
    this.ready = false; this.busy = false; this.accum = 0; this.pending = null; this.renderColliders = null; this.stats = { ms: 0, contacts: 0 };
    this.worker = new Worker(workerUrl, { type: 'module' });
    this.worker.onerror = (e) => console.error('cloth worker failed to load:', e.message || e);
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'error') { console.error('cloth worker:', m.message); return; }
      if (m.type === 'ready') { this.ready = true; return; }
      if (m.type === 'frame') { this.positions = m.positions; this.normals = m.normals; this.stats = m.stats; this.renderColliders = m.colliders; this.busy = false; this.time = m.time;
        if (this.pending) { const p = this.pending; this.pending = null; this._post(p.dt, p.colliders, p.pinTargets); } }
    };
    this.worker.postMessage({ type: 'init', mesh: { positions: mesh.positions, indices: mesh.indices, uvTri: mesh.uvTri, shear: mesh.shear, stitches: mesh.stitches, massScale: mesh.massScale, bendScale: mesh.bendScale, friction: mesh.friction, pins: this.pins.map(p => ({ i: p.i, compliance: p.compliance })) }, params });
  }
  reset(colliders, pinTargets, settleSteps = 0) { this.worker.postMessage({ type: 'reset', colliders: new Float32Array(colliders), pinTargets: new Float32Array(pinTargets), settleSteps }); }
  setParams(p) { Object.assign(this.params, p); this.worker.postMessage({ type: 'params', params: p }); }
  update(dt, colliders, pinTargets) {
    if (!this.ready) return; // still building/settling: ignore poses until then (hold the character still meanwhile)
    this.accum = Math.min(this.accum + dt, 1 / 30);
    if (this.busy) { this.pending = { dt: this.accum, colliders: new Float32Array(colliders), pinTargets: new Float32Array(pinTargets) }; return; }
    this._post(this.accum, new Float32Array(colliders), new Float32Array(pinTargets));
  }
  _post(dt, colliders, pinTargets) { this.busy = true; this.accum = 0; this.worker.postMessage({ type: 'step', dt, colliders, pinTargets }, [colliders.buffer, pinTargets.buffer]); }
  computeNormals() { return this.normals; } // already computed by the worker
  dispose() { this.worker.terminate(); }
}
