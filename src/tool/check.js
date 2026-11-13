// check.js — geometry checker for the singer (same build / performance / simulation code as stage.html).
//   arch -arm64 node tool/check.js [--shawlfile f|0 (default: shawl.<style>.json if present)] [--shawl (only the 帔帛's path: landmarks along it, wrists, layering, at bind and in the dance)] [--style tang|song] [--headdress baijiao|zhucui|gele] [--poem 0] [--seed 1] [--step 0.1] [--zstep 1] [--render]
// Checks, over sampled frames of the whole song plus synthetic extreme poses:
//   1. attachment: every part (and every connected component of per-component parts: petals, strands, lashes…)
//      is within EPS of its declared parent; the contact graph (union-find) is one component; body is one watertight mesh
//   2. penetration: cloth stays outside the body; outer cloth layers stay outside the skirt; hair cap only embedded at its rim
//   3. z-fighting: surfaces of different meshes (and far-apart regions of one cloth) that are nearly coplanar
//      (normals within 10°) and closer than GMIN.  --render also runs the screen-space jitter test in headless Chrome.
//   5. cloth sync: playback emulation (≤ 1 cloth step per 50 fps frame): lag behind the body, how long cloth stays inside it
//   4. motion (tool/motion.js): limb self-collision (body capsules), joint velocity / acceleration / jerk, stillness,
//      camera speed / acceleration / zoom / shot lengths / reversals.
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const F = require('../figure.js'), SING = require('../sing.js'), dict = require('../speech/mc_dict.json');
const args = process.argv.slice(2), opt = { poem: 0, seed: 1, step: 0.1, zstep: 1.0, render: false, style: 'tang' };
for (let i = 0; i < args.length; i++) { const k = args[i].replace(/^--/, ''); if (k === 'render') opt.render = true; else if (k === 'shawl') opt.shawl = true; else if (k === 'style' || k === 'headdress' || k === 'fig' || k === 'shawlfile' || k === 'cloth') opt[k] = args[++i]; else opt[k] = +args[++i]; }
const EPS = 0.002, GMIN = 0.0001, COS10 = Math.cos(10 * Math.PI / 180), PEN_TOL = 0.0005;
const T0 = Date.now(), log = (...a) => console.log(...a);

(async () => {
F.setClothLib(await import('../cloth_sim/cloth.js'));
/* ---------- build exactly like the page ---------- */
const FF = opt.fig ? { file: opt.fig, def: JSON.parse(fs.readFileSync(opt.fig, 'utf8')) } : F.figFile(opt.style, path.join(__dirname, '..')), DEF0 = FF.def;   // (--fig file: any figure file)   // figure.<style>.json (else figure.json) if (opt.headdress && DEF0.costume.song) DEF0.costume.song.headdress = opt.headdress;   // (--headdress baijiao|zhucui|gele)
const SHAWL = opt.shawlfile ? (opt.shawlfile === '0' ? false : JSON.parse(fs.readFileSync(opt.shawlfile, 'utf8'))) : F.shawlFile(opt.style, path.join(__dirname, '..'));   // the drawn 帔帛 (shawl.<style>.json from shawl.html) if present; --shawlfile f / 0
const fig = F.build({ def: F.styleDef(DEF0, opt.style), costume: opt.style, cloth: opt.cloth, shawl: SHAWL }, () => {});   // (--cloth old: the older verlet cloth)
const P = SING.POEMS[opt.poem], song = SING.compose(P.text, dict, { seed: opt.seed }), audio = SING.render(song, { voice: 'woman', seed: opt.seed });
const perf = F.perform(song, audio.syls, { seed: opt.seed, fig, style: opt.style }), sk = fig.sk, Wb = F.bindW(sk);
fig.sim = new F.Sim(fig);
const poseAt = (t, k) => { const W = F.solve(sk, perf.controls(t)); return k >= 1 ? W : F.blendW(Wb, W, k); };
const SPEC = fig.garb && fig.garb.shawlSpec;   // (the drawn shawl in use: the file's or figure.js's SHAWL_DEF)
log(`checker: ${path.basename(FF.file)}${SPEC ? ' + drawn shawl (' + (SHAWL ? 'shawl file' : 'built-in') + ', ' + SPEC.points.length + ' points, laid in the ' + SPEC.pose + ' pose)' : ''}, ${P.title}, ${perf.dur.toFixed(1)}s, ${fig.parts.length} parts, built in ${((Date.now() - T0) / 1000).toFixed(1)}s`);

/* ---------- geometry helpers ---------- */
function Hash(cell, bits) { this.c = cell; this.N = 1 << (bits || 20); this.head = new Int32Array(this.N); this.next = null; }
Hash.prototype.key = function (x, y, z) { const a = Math.floor(x / this.c), b = Math.floor(y / this.c), c = Math.floor(z / this.c); return ((a * 73856093) ^ (b * 19349663) ^ (c * 83492791)) & (this.N - 1); };
Hash.prototype.build = function (P, n) {
  this.P = P; this.head.fill(-1); if (!this.next || this.next.length < n) this.next = new Int32Array(n);
  for (let i = 0; i < n; i++) { const k = this.key(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); this.next[i] = this.head[k]; this.head[k] = i; }
  return this;
};
Hash.prototype.each = function (x, y, z, r, f) {   // f(i) for points in cells overlapping the ball
  const c = this.c, P = this.P, r2 = r * r, ax = Math.floor((x - r) / c), bx = Math.floor((x + r) / c), ay = Math.floor((y - r) / c), by = Math.floor((y + r) / c), az = Math.floor((z - r) / c), bz = Math.floor((z + r) / c);
  for (let a = ax; a <= bx; a++) for (let b = ay; b <= by; b++) for (let d = az; d <= bz; d++) {
    const k = ((a * 73856093) ^ (b * 19349663) ^ (d * 83492791)) & (this.N - 1);
    for (let i = this.head[k]; i >= 0; i = this.next[i]) { const dx = P[i * 3] - x, dy = P[i * 3 + 1] - y, dz = P[i * 3 + 2] - z; if (dx * dx + dy * dy + dz * dz <= r2) f(i); }
  }
};
function vtri(nv, idx) {   // vertex → triangles (CSR)
  const deg = new Int32Array(nv + 1); for (let i = 0; i < idx.length; i++) deg[idx[i] + 1]++;
  for (let i = 0; i < nv; i++) deg[i + 1] += deg[i];
  const T = new Int32Array(idx.length), f = deg.slice(0, nv); for (let i = 0; i < idx.length; i++) T[f[idx[i]]++] = (i / 3) | 0;
  return { off: deg, t: T };
}
function closestTri(px, py, pz, P, I, t, out) {   // Ericson, closest point on triangle t
  const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
  const ax = P[a], ay = P[a + 1], az = P[a + 2], abx = P[b] - ax, aby = P[b + 1] - ay, abz = P[b + 2] - az, acx = P[c] - ax, acy = P[c + 1] - ay, acz = P[c + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az, d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let u, v;
  const bpx = px - P[b], bpy = py - P[b + 1], bpz = pz - P[b + 2], d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  const cpx = px - P[c], cpy = py - P[c + 1], cpz = pz - P[c + 2], d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
  if (d1 <= 0 && d2 <= 0) { u = 0; v = 0; }
  else if (d3 >= 0 && d4 <= d3) { u = 1; v = 0; }
  else if (vc <= 0 && d1 >= 0 && d3 <= 0) { u = d1 / (d1 - d3); v = 0; }
  else if (d6 >= 0 && d5 <= d6) { u = 0; v = 1; }
  else if (vb <= 0 && d2 >= 0 && d6 <= 0) { u = 0; v = d2 / (d2 - d6); }
  else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); u = 1 - w; v = w; }
  else { const den = 1 / (va + vb + vc); u = vb * den; v = vc * den; }
  const qx = ax + abx * u + acx * v, qy = ay + aby * u + acy * v, qz = az + abz * u + acz * v;
  let nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx; const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
  const dx = px - qx, dy = py - qy, dz = pz - qz, d = Math.hypot(dx, dy, dz), s = dx * nx + dy * ny + dz * nz;
  out.d = d; out.sd = s >= 0 ? d : -d; out.nx = nx; out.ny = ny; out.nz = nz; out.edge = !(u > 1e-6 && v > 1e-6 && u + v < 1 - 1e-6);
  return out;
}
// a posed surface: positions + triangles + vertex hash. query(): nearest vertex, then the triangles of its 1-ring;
// the sign (outside > 0) comes from the face normal, flipped if the mesh is wound inward (decided once at bind)
function Surf(name, idx, nv, cell, bindP, bindN) {
  this.name = name; this.idx = idx; this.nv = nv; this.vt = vtri(nv, idx); this.h = new Hash(cell || 0.004); this.tmp = {}; this.flip = 1;
  if (bindP && bindN) { let agree = 0; for (let t = 0; t < idx.length / 3; t += 7) { closestTri(0, 0, 0, bindP, idx, t, this.tmp); const v = idx[t * 3] * 3; agree += this.tmp.nx * bindN[v] + this.tmp.ny * bindN[v + 1] + this.tmp.nz * bindN[v + 2] > 0 ? 1 : -1; } this.flip = agree >= 0 ? 1 : -1; }
}
Surf.prototype.set = function (P) { this.P = P; this.h.build(P, this.nv); if (this.h2) this.h2.build(P, this.nv); return this; };
Surf.prototype.nearestV = function (x, y, z, R, skipV) {
  let bv = -1, bd = R * R; const P = this.P;
  this.h.each(x, y, z, R, function (v) { if (skipV && skipV(v)) return; const d = (P[v * 3] - x) ** 2 + (P[v * 3 + 1] - y) ** 2 + (P[v * 3 + 2] - z) ** 2; if (d < bd) { bd = d; bv = v; } });
  return bv;
};
Surf.prototype.query = function (x, y, z, R, skipV) {
  let v = this.nearestV(x, y, z, Math.min(R, this.h.c * 1.5), skipV);
  if (v < 0 && R > this.h.c * 1.5) { if (!this.h2) { this.h2 = new Hash(0.02, 18); this.h2.build(this.P, this.nv); } const h = this.h; this.h = this.h2; v = this.nearestV(x, y, z, R, skipV); this.h = h; }
  if (v < 0) return null;
  const tris = new Set(), vt = this.vt, I = this.idx;
  for (let j = vt.off[v]; j < vt.off[v + 1]; j++) { const t = vt.t[j]; for (let k = 0; k < 3; k++) { const w = I[t * 3 + k]; for (let q = vt.off[w]; q < vt.off[w + 1]; q++) tris.add(vt.t[q]); } }
  let best = null; const tmp = this.tmp;
  for (const t of tris) { if (skipV && (skipV(I[t * 3]) || skipV(I[t * 3 + 1]) || skipV(I[t * 3 + 2]))) continue; closestTri(x, y, z, this.P, I, t, tmp);
    if (!best || tmp.d < best.d - 1e-9 || (Math.abs(tmp.d - best.d) <= 1e-9 && !tmp.edge)) best = Object.assign({ t, v }, tmp); }
  if (best && this.flip < 0) { best.sd = -best.sd; best.nx = -best.nx; best.ny = -best.ny; best.nz = -best.nz; }
  return best;
};

/* ---------- per-part posed geometry ---------- */
const parts = fig.parts.filter(p => p.mesh || p.cloth), byName = {}; parts.forEach(p => byName[p.name] = p);
const body = fig.body, nB = body.pos.length / 3, bodyP = new Float32Array(nB * 3), bodyS = new Surf('body', body.idx, nB, 0.004, body.pos, body.nrm);
parts.forEach(p => {
  if (p.cloth) { p.idx = p.cloth.tris(); p.nv = p.cloth.n; }
  else { p.idx = p.mesh.idx; p.nv = p.mesh.pos.length / 3; }
  p.P = new Float32Array(p.nv * 3);
  p.comp = F.components(p.nv, p.idx);
  if (p.name !== 'body') p.S = new Surf(p.name, p.idx, p.nv, p.cloth ? 0.03 : 0.004, p.cloth ? null : p.mesh.pos, p.cloth ? null : p.mesh.nrm);
});
let DQ = new Float32Array(sk.bones.length * 8);
function poseParts(W) {
  F.poseDQ(sk, W, DQ);
  F.skin(body, DQ, bodyP); bodyS.set(bodyP); byName.body.P = bodyP;
  parts.forEach(p => {
    if (p.name === 'body') return;
    if (p.cloth) p.P.set(p.cloth.x); else F.skin(p.mesh, DQ, p.P);
    p.S.set(p.P);
  });
}
const ROBES = ['robeFL', 'robeB', 'robeFR', 'yokeL', 'yokeR'];
const parentsOf = p => p.name === 'shawl' ? ROBES.concat(['sleeveL', 'sleeveR']) : p.parents ? p.parents : p.parent ? [p.parent] : [];
// candidate contact vertices per (part component) at bind: the ones within 4 mm of the parent
function surfOf(name) { return name === 'body' ? bodyS : byName[name].S; }

/* ---------- results ---------- */
const R = { attach: {}, pen: {}, penTri: {}, nest: {}, zf: {}, graph: [], frames: 0, extra: [] };
function note(map, key, t, d) { const e = map[key] || (map[key] = { n: 0, worst: -Infinity, at: null, frames: new Set() }); e.n++; e.frames.add(t); if (d > e.worst) { e.worst = d; e.at = t; } }

/* ---------- static checks (bind) ---------- */
const bc = F.components(nB, body.idx), loops = F.boundaryLoops(body).length;
log(`body: ${nB} verts, ${bc.count} connected component(s), ${loops} boundary loop(s) ${bc.count === 1 && loops === 0 ? 'OK' : 'FAIL'}`);
// attachment units: whole part, or each connected component for per-component parts
function units(p) {
  if (!p.perComponent) return [{ name: p.name, verts: null }];
  const L = p.comp.label, groups = new Map(); for (let i = 0; i < p.nv; i++) { let g = groups.get(L[i]); if (!g) groups.set(L[i], g = []); g.push(i); }
  return [...groups.values()].map((v, i) => ({ name: p.name + '#' + i, verts: v }));
}
const rigidSame = p => !p.cloth && p.kind === 'rigid' && parentsOf(p).every(q => { const pp = byName[q]; return pp && !pp.cloth && pp.kind === 'rigid' && pp.mesh.bone === p.mesh.bone; });
const allUnits = []; parts.forEach(p => { if (p.name === 'body') return; units(p).forEach(u => { u.part = p; allUnits.push(u); }); });
log(`attachment units: ${allUnits.length} (${parts.length} parts; per-component parts split: ${parts.filter(p => p.perComponent).map(p => p.name).join(', ')})`);

function unitDist(u, all) {   // min over the unit's vertices of the distance to any parent surface (negative = embedded → 0)
  const p = u.part, P = p.P, vs = !all && u.cand ? u.cand : u.verts || [...Array(p.nv).keys()], near = [];
  let best = Infinity, who = null;
  for (const q of parentsOf(p)) {
    const S = surfOf(q);
    for (let k = 0; k < vs.length; k++) {
      const i = vs[k], r = S.query(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], Math.min(0.03, (u.cand ? best : 0.005) + 0.004));
      if (!r) continue; const d = Math.max(0, q === 'body' || !byName[q].cloth ? r.sd : r.d);
      if (d < 0.005) near.push(i);
      if (d < best) { best = d; who = q; } if (best <= 0 && u.cand) return { d: 0, who };
    }
  }
  if (!u.cand && near.length) u.cand = near;                 // contact candidates for later frames
  if (best > EPS && u.cand && !all) return unitDist(u, true);   // candidates drifted: measure everything
  return { d: best, who };
}
// union-find over parts (components connect to their part; parts connect to parents when within EPS)
function UF() { const p = new Map(); const f = x => { if (!p.has(x)) p.set(x, x); let r = x; while (p.get(r) !== r) r = p.get(r); p.set(x, r); return r; }; return { f, u: (a, b) => p.set(f(a), f(b)), size: () => new Set([...p.keys()].map(f)).size }; }

/* ---------- frame evaluation ---------- */
// When the closest body feature is an edge (a crease, or where the skinned body meets itself in the armpit) the normal's
// sign is unreliable: confirm 'inside' by ray parity (three directions, majority) against the posed body.
function insideParity(x, y, z) {
  const I = body.idx, BP = bodyP, D = [[0.31, 0.12, 0.94], [-0.7, 0.2, 0.68], [0.1, 0.98, 0.17]];
  let votes = 0;
  for (const d0 of D) { const l = Math.hypot(...d0), d = d0.map(q => q / l); let n = 0;
    for (let k = 0; k < I.length; k += 3) {
      const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
      const e1x = BP[b] - BP[a], e1y = BP[b + 1] - BP[a + 1], e1z = BP[b + 2] - BP[a + 2], e2x = BP[c] - BP[a], e2y = BP[c + 1] - BP[a + 1], e2z = BP[c + 2] - BP[a + 2];
      const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x, det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-14) continue; const inv = 1 / det, sx = x - BP[a], sy = y - BP[a + 1], sz = z - BP[a + 2], u = (sx * px + sy * py + sz * pz) * inv; if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x, v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv; if (v < 0 || u + v > 1) continue;
      if ((e2x * qx + e2y * qy + e2z * qz) * inv > 0) n++;
    }
    votes += n & 1; }
  return votes >= 2;
}
const rigidOnce = new Set(); let DBG = 0; const CUR = { i: -1, tri: false };
function checkFrame(t, W, label) {
  poseParts(W); R.frames++;
  const uf = UF(); uf.f('body');
  // 1. attachments
  allUnits.forEach(u => {
    const p = u.part;
    if (rigidSame(p) && rigidOnce.has(u.name)) { uf.u(u.name, parentsOf(p)[0]); if (u.verts) uf.u(u.name, p.name); return; }
    const r = unitDist(u);
    if (r.d <= EPS) { uf.u(u.name, r.who); if (u.verts) uf.u(u.name, p.name); if (rigidSame(p)) rigidOnce.add(u.name); }
    else { note(R.attach, u.name + ' → ' + parentsOf(p).join('|'), label, r.d); }
  });
  // bead chains: bead to bead / branch, measured between sphere surfaces
  (fig.chains || []).forEach((ch, ci) => ch.x && ch.x.forEach((x, j) => {
    let d; if (j) { const y = ch.x[j - 1]; d = Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) - ch.beads[j].r - ch.beads[j - 1].r; }
    else { const r = byName[ch.parent || 'buyao'].S.query(x[0], x[1], x[2], 0.03); d = r ? r.d - ch.beads[j].r : 1; }
    const nm = 'bead' + ci + '.' + j, par = ch.parent || 'buyao'; if (Math.abs(d) <= EPS) uf.u(nm, j ? 'bead' + ci + '.' + (j - 1) : par); else note(R.attach, nm + ' → ' + (j ? 'bead' + ci + '.' + (j - 1) : par), label, Math.abs(d));
  }));
  // 玉環綬: the jade ring lies on the gathered ribbons (gap from its back to their midline ≤ EPS), the ribbons within its radius
  const J = fig.garments && fig.garments.jade && fig.garments.jade.state;
  if (J) { const d = Math.abs((J.rib[0] - J.c[0]) * J.n[0] + (J.rib[1] - J.c[1]) * J.n[1] + (J.rib[2] - J.c[2]) * J.n[2]) - fig.garments.jade.r;
    let thr = 0; fig.cloths.filter(c => /^sash[LR]$/.test(c.name)).forEach(c => { for (let j = 0; j < 2; j++) { const i = (fig.garments.jade.v * 2 + j) * 3; thr = Math.max(thr, Math.hypot(c.x[i] - J.rib[0], c.x[i + 1] - J.rib[1], c.x[i + 2] - J.rib[2])); } });
    const out = thr - (fig.garments.jade.R - fig.garments.jade.w / 2);   // the ribbons pass within the ring's hole
    if (d <= EPS && out <= EPS) uf.u('jadeRing', 'sashL'); else note(R.attach, 'jadeRing → sashL|sashR (threaded)', label, Math.max(d, out)); }
  const ncomp = uf.size(); R.graph.push([label, ncomp]);
  // 2. penetration: cloth particles and triangle centroids vs the body
  parts.filter(p => p.cloth).forEach(p => {
    const P = p.P, test = (x, y, z) => { const r = bodyS.query(x, y, z, 0.04); if (r && r.sd < -PEN_TOL && (!r.edge || insideParity(x, y, z))) { note(CUR.tri ? R.penTri : R.pen, p.name + ' inside body @' + sk.bones[body.bi[r.v * 4]].name + (CUR.i >= 0 ? (p.cloth.pin[CUR.i] >= 0 ? ' (pinned)' : ' row ' + 5 * Math.floor(CUR.i / p.cloth.nu / 5) + '+') : ''), label, -r.sd);
      if (process.env.CHECK_DEBUG && (process.env.CHECK_DEBUG === '1' || p.name === process.env.CHECK_DEBUG) && (!process.env.CHECK_BONE || sk.bones[body.bi[r.v * 4]].name === process.env.CHECK_BONE) && DBG++ < 8) { let bv = -1, bd = 1e9; for (let v = 0; v < nB; v++) { const d = (bodyP[v * 3] - x) ** 2 + (bodyP[v * 3 + 1] - y) ** 2 + (bodyP[v * 3 + 2] - z) ** 2; if (d < bd) { bd = d; bv = v; } }
        log('DBG', p.name, CUR.i >= 0 ? 'row ' + Math.floor(CUR.i / p.cloth.nu) + ' col ' + CUR.i % p.cloth.nu : '', [x, y, z].map(q => q.toFixed(4)).join(','), 'query v', r.v, 'd', r.d.toFixed(4), 'sd', r.sd.toFixed(4), 'n', [r.nx, r.ny, r.nz].map(q => q.toFixed(2)).join(','), 'brute v', bv, Math.sqrt(bd).toFixed(4), 'edge', r.edge); } } };
    CUR.tri = false; for (let i = 0; i < p.nv; i++) { CUR.i = i; test(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); } CUR.i = -1;
    for (let k = 0; k < p.idx.length; k += 3) { const a = p.idx[k] * 3, b = p.idx[k + 1] * 3, c = p.idx[k + 2] * 3; CUR.i = p.idx[k]; CUR.tri = true; test((P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3); }
  });
  // hair flower: petals and leaves must stay outside the hair (they sway on the stem)
  [['peonyLeaves', 'hairCap'], ['peonyPetals', 'hairCap']].forEach(([a, b]) => { const A = byName[a], B = byName[b]; if (!A || !B) return;
    const bp = A.sway ? A.sway.info.base : null, M0 = A.mesh.pos;
    for (let i = 0; i < A.nv; i += 2) { if (bp && M0 && Math.hypot(M0[i * 3] - bp[0], M0[i * 3 + 1] - bp[1], M0[i * 3 + 2] - bp[2]) < 0.014) continue;   // the petal bases sit in the flower's heart, by design
      const r = B.S.query(A.P[i * 3], A.P[i * 3 + 1], A.P[i * 3 + 2], 0.01); if (r && !r.edge && r.sd < -PEN_TOL) note(R.pen, a + ' inside ' + b, label, -r.sd); } });
  // nesting: robe / shawl / sash outside the skirt (signed by the skirt's outward side), shawl outside the robe
  const skirt = byName.skirt, root = W.p[sk.by.root];
  function outward(S, r, x, z) { const ox = x - root[0], oz = z - root[2]; return Math.sign(r.nx * ox + r.nz * oz) || 1; }
  [['robeFL', 'skirt'], ['robeFR', 'skirt'], ['robeB', 'skirt'], ['shawl', 'skirt'], ['sashL', 'skirt'], ['sashR', 'skirt'], ['shawl', 'robeB'], ['shawl', 'robeFL'], ['shawl', 'robeFR']].forEach(([a, b]) => {
    const A = byName[a], B = byName[b]; if (!A || !B) return;
    for (let i = 0; i < A.nv; i++) {
      if (A.cloth.pin[i] >= 0) continue;
      const x = A.P[i * 3], y = A.P[i * 3 + 1], z = A.P[i * 3 + 2], r = B.S.query(x, y, z, 0.02); if (!r || r.edge) continue;
      const sd = r.sd * outward(B.S, r, x, z); if (sd < 0.0008) note(R.nest, a + ' under/through ' + b + ' (row ' + 5 * Math.floor(i / A.cloth.nu / 5) + '+, skirt row ' + Math.floor(B.idx[r.t * 3] / B.cloth.nu) + ')', label, 0.0008 - sd);
    }
  });
  return ncomp;
}
// 3. z-fighting: nearly coplanar & closer than GMIN (different meshes; far-apart regions of one cloth)
const ZPAIRS = [['band', 'body'], ['sashKnot', 'band'], ['skirt', 'body'], ['sleeveL', 'body'], ['sleeveR', 'body'], ['shawl', 'body'], ['hairCap', 'body'], ['band', 'skirt'], ['sashL', 'skirt'], ['sashR', 'skirt'], ['sashL', 'sashR'],
  ['shawl', 'skirt'], ['shawl', 'sleeveL'], ['shawl', 'sleeveR'], ['hairStrands', 'hairCap'], ['comb', 'hairCap'], ['goldFlower', 'hairCap'], ['buyao', 'hairCap'], ['peonyLeaves', 'hairCap'], ['peonyPetals', 'peonyPetals'],
  ['braceletL', 'body'], ['braceletR', 'body'], ['armletL', 'body'], ['armletR', 'body'], ['sleeveL', 'armletL'], ['sleeveR', 'armletR'], ['shoeL', 'body'], ['shoeR', 'body'], ['lashesL', 'body'], ['lashesR', 'body'],
  ['belt', 'band'], ['belt', 'skirt'], ['belt', 'body'], ['sashKnot', 'belt'], ['sashL', 'belt'], ['sashR', 'belt'], ['crownComb', 'crown'], ['skirt', 'skirt'], ['sleeveL', 'sleeveL'], ['sleeveR', 'sleeveR'], ['shawl', 'shawl']];
(DEF0.ornaments || []).forEach((o, i) => { const n = o.name || 'ornament' + i; fig.parts.filter(p => p.name === n || p.name === n + 'M').forEach(p => ZPAIRS.push([p.name, 'hairCap'], [p.name + 'Pearls', p.name], [p.name + 'Stalks', p.name], [p.name + 'Pearls', p.name + 'Stalks'])); });
ZPAIRS.push(['facePearls', 'body']);
(DEF0.cords || []).forEach((o, i) => ZPAIRS.push([o.name || 'cord' + i, 'hairCap']));   // (like the other hair ornaments: against the cap; the strands are sub-pixel cards)   // SVG ornaments
ROBES.forEach(r => { ZPAIRS.push([r, 'body'], [r, 'skirt'], [r, r], ['sleeveL', r], ['sleeveR', r], ['shawl', r]); });
function vnorm(p, P) { return F.vertexNormals(P, p.idx); }
function checkZ(label) {
  ZPAIRS.forEach(([a, b]) => {
    const A = byName[a], B = b === 'body' ? null : byName[b]; if (!A || (b !== 'body' && !B)) return;
    const S = b === 'body' ? bodyS : B.S, NA = vnorm(A, A.P), two = A.cloth || (B && B.cloth) || /lash|petal|Leaves/.test(a + b), same = a === b;
    const grid = A.cloth ? A.cloth : null, stride = A.nv > 60000 ? 7 : 1;
    for (let i = 0; i < A.nv; i += stride) {
      const x = A.P[i * 3], y = A.P[i * 3 + 1], z = A.P[i * 3 + 2];
      const skip = same ? (w => { if (grid) { const ua = i % grid.nu, va = (i / grid.nu) | 0, ub = w % grid.nu, vb = (w / grid.nu) | 0; let du = Math.abs(ua - ub); if (grid.wrap) du = Math.min(du, grid.nu - du); return du + Math.abs(va - vb) <= 4; }
        return A.comp.label[w] === A.comp.label[i]; }) : null;
      const r = S.query(x, y, z, 0.003, skip); if (!r || r.d >= GMIN) continue;
      const c = NA[i * 3] * r.nx + NA[i * 3 + 1] * r.ny + NA[i * 3 + 2] * r.nz;
      if ((two ? Math.abs(c) : c) > COS10) note(R.zf, a + ' ~ ' + b, label, GMIN - r.d);
    }
  });
}

/* ---------- sewn garments (fig.garb, cloth_sim): penetration, layering, pins and knot, gaps, stretch, z-fighting, jitter ---------- */
const GB = fig.garb, GR = { pen: {}, penTri: {}, nest: {}, pin: {}, zf: {}, gap: {}, strain: {}, frames: 0 };
let gsim = null, GP = null;
if (GB) {
  gsim = new F.GSim(fig);
  const n = GB.n, pieceOf = new Int16Array(n).fill(-1), names = Object.keys(GB.pieces);
  GP = names.map((name, k) => { const idx = []; GB.pieces[name].forEach(pn => { pn.vmap.forEach(v => pieceOf[v] = k); for (let i = 0; i < pn.tris.length; i += 3) { const a = pn.vmap[pn.tris[i]], b = pn.vmap[pn.tris[i + 1]], c = pn.vmap[pn.tris[i + 2]]; if (a !== b && b !== c && a !== c) idx.push(a, b, c); } });
    return { name, k, idx: new Uint32Array(idx), S: new Surf(name, new Uint32Array(idx), n, 0.03), skip: v => pieceOf[v] !== k }; });
  GP.byName = {}; GP.forEach(p => GP.byName[p.name] = p); GP.pieceOf = pieceOf;
  // particles shared by two pieces (welds: ribbon tops in the band, the shawl's middle on the robe) and their 4 cm neighbourhood: not a layering fault
  const own = new Map(); GP.forEach(p => { for (let i = 0; i < p.idx.length; i++) { const v = p.idx[i], s = own.get(v); if (s === undefined) own.set(v, p.k); else if (s !== p.k) own.set(v, -1); } });
  GP.sewn = new Uint8Array(n); const X = GB.mesh.positions; own.forEach((s, v) => { if (s !== -1) return; for (let i = 0; i < n; i++) if (Math.hypot(X[i * 3] - X[v * 3], X[i * 3 + 1] - X[v * 3 + 1], X[i * 3 + 2] - X[v * 3 + 2]) < 0.04) GP.sewn[i] = 1; });
  const c0 = new (await import('../cloth_sim/cloth.js')).Cloth(GB.mesh, GB.params); GP.sIdx = c0.stretchIdx; GP.sRest = c0.stretchRest;   // the edges and their pattern rest lengths
  log(`garments: ${n} particles in ${names.length} pieces (${names.join(', ')}), ${GB.pins.length} pins, ${GB.coll.caps.length} capsules`);
}
const LAYERS = [['robeB', 'skirt'], ['robeFL', 'skirt'], ['robeFR', 'skirt'], ['sleeveL', 'skirt'], ['sleeveR', 'skirt'], ['robeB', 'band'], ['robeFL', 'band'], ['robeFR', 'band'], ['sashL', 'skirt'], ['sashR', 'skirt'],
  ['shawl', 'robeB'], ['shawl', 'robeFL'], ['shawl', 'robeFR'], ['shawl', 'sleeveL'], ['shawl', 'sleeveR'], ['shawl', 'skirt']];
function segTri(P, i, j, a, b, c) {   // does segment ij cross triangle abc (Möller–Trumbore, both ends on either side)
  if (i === a || i === b || i === c || j === a || j === b || j === c) return false;
  const o = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], d = [P[j * 3] - o[0], P[j * 3 + 1] - o[1], P[j * 3 + 2] - o[2]], A = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]];
  const e1 = [P[b * 3] - A[0], P[b * 3 + 1] - A[1], P[b * 3 + 2] - A[2]], e2 = [P[c * 3] - A[0], P[c * 3 + 1] - A[1], P[c * 3 + 2] - A[2]];
  const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]], det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2]; if (Math.abs(det) < 1e-14) return false;
  const inv = 1 / det, s = [o[0] - A[0], o[1] - A[1], o[2] - A[2]], u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv; if (u < 0 || u > 1) return false;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]], v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv; if (v < 0 || u + v > 1) return false;
  const tt = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv; return tt > 0 && tt < 1;
}
function garbFrame(t, W, zf) {
  const P = gsim.cloth.positions, N = gsim.cloth.computeNormals(), pieceOf = GP.pieceOf; GR.frames++;
  GP.forEach(p => p.S.set(P));
  // 2a. penetration: particles and triangle centroids inside the posed body
  const test = (x, y, z, k, tri) => { const r = bodyS.query(x, y, z, 0.04); if (r && r.sd < -PEN_TOL && (!r.edge || insideParity(x, y, z))) note(tri ? GR.penTri : GR.pen, GP[k].name + ' inside body @' + sk.bones[body.bi[r.v * 4]].name, t, -r.sd); return r; };
  const near = new Float32Array(GB.n).fill(1); let deep = 0;
  for (let i = 0; i < GB.n; i++) { const r = test(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], pieceOf[i], false); if (r) { near[i] = r.sd; if (r.sd < -0.005 && (!r.edge || insideParity(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]))) deep++; } }
  GP.forEach(p => { for (let k = 0; k < p.idx.length; k += 3) { const a = p.idx[k] * 3, b = p.idx[k + 1] * 3, c = p.idx[k + 2] * 3; test((P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3, p.k, true); } });
  // gap to the skin where a piece rests on the body (particles within 25 mm of it): median per piece (a floating garment shows here)
  GP.forEach(p => { const g = []; for (let i = 0; i < GB.n; i++) if (pieceOf[i] === p.k && near[i] < 0.025) g.push(near[i]); if (!g.length) return; g.sort((a, b) => a - b); const e = GR.gap[p.name] || (GR.gap[p.name] = { med: [], n: 0 }); e.med.push(g[g.length >> 1]); e.n = Math.max(e.n, g.length); });
  // 2b. layering: an outer piece's edges must not pass through the piece under it (segment–triangle crossings)
  LAYERS.forEach(([a, b]) => { const A = GP.byName[a], B = GP.byName[b]; if (!A || !B) return;
    const cell = 0.04, grid = new Map(), I = B.idx, key = (x, y, z) => Math.floor(x / cell) + ',' + Math.floor(y / cell) + ',' + Math.floor(z / cell);
    for (let t = 0; t < I.length; t += 3) { const v = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3]; const lo = [0, 1, 2].map(k => Math.floor(Math.min(P[v[0] + k], P[v[1] + k], P[v[2] + k]) / cell)), hi = [0, 1, 2].map(k => Math.floor(Math.max(P[v[0] + k], P[v[1] + k], P[v[2] + k]) / cell));
      for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) { const k = x + ',' + y + ',' + z; (grid.get(k) || grid.set(k, []).get(k)).push(t); } }
    let cross = 0, at = null;
    for (let e = 0; e < GP.sIdx.length; e += 2) { const i = GP.sIdx[e], j = GP.sIdx[e + 1]; if (pieceOf[i] !== A.k || pieceOf[j] !== A.k || GP.sewn[i] || GP.sewn[j]) continue;
      const seen = new Set(); for (const k of new Set([key(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]), key(P[j * 3], P[j * 3 + 1], P[j * 3 + 2])])) for (const t of grid.get(k) || []) { if (seen.has(t)) continue; seen.add(t);
        if (segTri(P, i, j, I[t], I[t + 1], I[t + 2])) { cross++; at = at || [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]; } } }
    if (cross) { const rb = bodyS.query(at[0], at[1], at[2], 0.1); note(GR.nest, a + ' through ' + b + ' @' + (rb ? sk.bones[body.bi[rb.v * 4]].name : '-'), t, cross); } });
  // 1. pins: each pinned particle on its skinned anchor and within its clearance of the skin; the knot on the band
  GB.pins.forEach((pn, k) => { const i = pn.i, d = Math.hypot(P[i * 3] - gsim.pinT[k * 3], P[i * 3 + 1] - gsim.pinT[k * 3 + 1], P[i * 3 + 2] - gsim.pinT[k * 3 + 2]), r = bodyS.query(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], 0.1);
    if (d > 1e-4) note(GR.pin, GP[pieceOf[i]].name + ' pin off its anchor', t, d); const nm = GP[pieceOf[i]].name, lim = nm === 'shawl' ? 0.07 : 0.035; if (!r || r.sd > lim) note(GR.pin, nm + ' pin #' + k + ' > ' + lim * 1000 + ' mm off the skin', t, r ? r.sd : 0.05); });
  if (GB.knot.length === 2) {   // the knot (in the band's frame at the ribbons' points) touches the band or the ribbons
    const f = F.knotFrame(P, N, GB.knot), K = GP.knot || (GP.knot = F.knotMesh((DEF0.costume[opt.style].garments.sash || {}).knot).pos); let d = 1;
    for (let i = 0; i < K.length; i += 3) { const x = f.o[0] + f.x[0] * K[i] + f.y[0] * K[i + 1] + f.z[0] * K[i + 2], y = f.o[1] + f.x[1] * K[i] + f.y[1] * K[i + 1] + f.z[1] * K[i + 2], z = f.o[2] + f.x[2] * K[i] + f.y[2] * K[i + 1] + f.z[2] * K[i + 2];
      ['band', 'sashL', 'sashR'].forEach(nm => { const q = GP.byName[nm]; if (!q) return; const r = q.S.query(x, y, z, 0.03, q.skip); if (r) d = Math.min(d, Math.max(0, r.sd)); }); }
    if (d > EPS) note(GR.pin, 'sashKnot off the band', t, d); }
  // stretch: edge length over its pattern length
  const SI = GP.sIdx, SR = GP.sRest;
  for (let k = 0; k < SI.length; k += 2) { const r = SR[k >> 1]; if (!r) continue; const a = SI[k] * 3, b = SI[k + 1] * 3, s = Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]) / r - 1, nm = GP[pieceOf[SI[k]]].name;
    const e = GR.strain[nm] || (GR.strain[nm] = { max: 0, at: 0, over: 0, n: 0 }); e.n++; if (s > 0.1) e.over++; if (s > e.max) { e.max = s; e.at = t; const r = bodyS.query(P[a], P[a + 1], P[a + 2], 0.05); e.bone = r ? sk.bones[body.bi[r.v * 4]].name : '-'; } }
  // 3. z-fighting: nearly coplanar (< 10°) and closer than GMIN — piece vs body, and pieces against each other
  if (zf) GP.forEach(p => { for (let i = 0; i < GB.n; i++) { if (pieceOf[i] !== p.k) continue; const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const rb = bodyS.query(x, y, z, 0.003); if (rb && rb.d < GMIN && Math.abs(N[i * 3] * rb.nx + N[i * 3 + 1] * rb.ny + N[i * 3 + 2] * rb.nz) > COS10) note(GR.zf, p.name + ' ~ body', t, GMIN - rb.d);
    GP.forEach(q => { if (q === p) return; const r = q.S.query(x, y, z, 0.003, q.skip); if (r && r.d < GMIN && Math.abs(N[i * 3] * r.nx + N[i * 3 + 1] * r.ny + N[i * 3 + 2] * r.nz) > COS10) note(GR.zf, p.name + ' ~ ' + q.name, t, GMIN - r.d); }); } });
  return deep;
}
function garbReport() {
  table('G1. pins and knot (pinned particle off its anchor > 0.1 mm, off the skin by more than 35 mm (shawl: 70 mm, over the sleeve); knot off the band > ' + EPS * 1000 + ' mm)', GR.pin);
  log('   resting gap to the skin (median over frames of each piece\'s median, particles within 25 mm): ' + Object.keys(GR.gap).map(k => { const m = GR.gap[k].med.slice().sort((a, b) => a - b); return k + ' ' + (m[m.length >> 1] * 1000).toFixed(1) + ' mm'; }).join(', '));
  table('G2a. penetration: cloth particles inside the body (> ' + PEN_TOL * 1000 + ' mm)', GR.pen);
  const tri = Object.keys(GR.penTri); log(`   (info) cloth triangle centroids inside the body: ${tri.length ? tri.length + ' region(s), worst ' + (Math.max(...tri.map(k => GR.penTri[k].worst)) * 1000).toFixed(1) + ' mm (' + tri.sort((a, b) => GR.penTri[b].worst - GR.penTri[a].worst).slice(0, 4).join('; ') + ')' : 'none'}`);
  table('G2b. layering: edges of an outer garment through the one below (worst = number of crossing edges in a frame)', GR.nest, 'n');
  table('G3. z-fighting: coplanar (<10°) and closer than ' + GMIN * 1000 + ' mm', GR.zf);
  log('\nG4. stretch (edge length / pattern length − 1; max, frames-edges over 10%): ' + Object.keys(GR.strain).map(k => k + ' ' + (GR.strain[k].max * 100).toFixed(0) + '% @' + GR.strain[k].at.toFixed(1) + 's near ' + GR.strain[k].bone + ' (' + (GR.strain[k].over / GR.strain[k].n * 100).toFixed(3) + '%)').join(', '));
  // G5. jitter at rest: hold the last pose 3 s, then the motion of every particle over 1 s (RMS about its mean, and the largest step)
  const Wl = gsim.W, tl = gsim.t, hold = () => Wl, n = GB.n, acc = new Float64Array(n * 3), acc2 = new Float64Array(n), frames = []; let stepMax = 0, prev = null;
  gsim.advance(hold, tl + 3); let acc3 = new Float64Array(n);
  for (let f = 1; f <= 60; f++) { gsim.advance(hold, tl + 3 + f / 60); const P = gsim.cloth.positions; frames.push(new Float32Array(P)); if (frames.length >= 3) { const A = frames[frames.length - 3], B = frames[frames.length - 2]; for (let i = 0; i < n; i++) acc3[i] = Math.max(acc3[i], Math.hypot(P[i * 3] - 2 * B[i * 3] + A[i * 3], P[i * 3 + 1] - 2 * B[i * 3 + 1] + A[i * 3 + 1], P[i * 3 + 2] - 2 * B[i * 3 + 2] + A[i * 3 + 2])); }
    if (prev) for (let i = 0; i < n * 3; i += 3) stepMax = Math.max(stepMax, Math.hypot(P[i] - prev[i], P[i + 1] - prev[i + 1], P[i + 2] - prev[i + 2])); prev = frames[frames.length - 1]; }
  const rms = new Float64Array(n); for (let i = 0; i < n; i++) { let mx = 0, my = 0, mz = 0; frames.forEach(P => { mx += P[i * 3]; my += P[i * 3 + 1]; mz += P[i * 3 + 2]; }); mx /= 60; my /= 60; mz /= 60; let s = 0; frames.forEach(P => { s += (P[i * 3] - mx) ** 2 + (P[i * 3 + 1] - my) ** 2 + (P[i * 3 + 2] - mz) ** 2; }); rms[i] = Math.sqrt(s / 60); }
  const sr = Array.from(rms).sort((a, b) => a - b), jit = sr[n - 1];
  const byP = {}; for (let i = 0; i < n; i++) { const nm = GP[GP.pieceOf[i]].name; byP[nm] = Math.max(byP[nm] || 0, rms[i]); }
  log(`\nG5. jitter at rest (pose held 3 s, then 1 s): RMS motion median ${(sr[n >> 1] * 1000).toFixed(3)} mm, p99 ${(sr[Math.floor(0.99 * n)] * 1000).toFixed(3)} mm, max ${(jit * 1000).toFixed(3)} mm (${Object.keys(byP).map(k => k + ' ' + (byP[k] * 1000).toFixed(2)).join(', ')}); largest frame step ${(stepMax * 1000).toFixed(3)} mm, largest second difference (shake) ${(Math.max(...acc3) * 1000).toFixed(3)} mm: ${jit < 0.001 ? 'OK' : 'FAIL'}`);
  GR.jitter = jit;
  return Object.keys(GR.pin).length + Object.keys(GR.pen).length + Object.keys(GR.nest).length + Object.keys(GR.zf).length + (jit < 0.001 ? 0 : 1);
}
// G6. sync under load: the live worker steps with whatever time has passed; at 30 Hz (a busy machine) the cloth must still
// keep out of the body during the fast moves: particles > 5 mm deep, per frame, against the 60 Hz run
function garbSync(ref) {
  const g = new F.GSim(fig); g.dt = 1 / 30; let worst = 0, at = 0, tot = 0;
  ref.forEach(([t, n0]) => { g.advance(poseAt, t); const P = g.cloth.positions; let n = 0; poseParts(g.W); for (let i = 0; i < GB.n; i++) { const r = bodyS.query(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], 0.04); if (r && r.sd < -0.005 && (!r.edge || insideParity(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]))) n++; } tot += n; if (n - n0 > worst) { worst = n - n0; at = t; } });
  log(`\nG6. cloth/skin sync: the body is drawn at the time of the cloth state shown (ClothAsync renderColliders), so they never drift apart; under load (cloth stepped at 30 Hz) particles > 5 mm inside the body: ${tot} over the song, at most ${worst} more than at 60 Hz in one frame${worst ? ' (@' + at.toFixed(1) + 's)' : ''}: ${worst <= 3 ? 'OK' : 'FAIL'}`);
  return worst <= 3 ? 0 : 1;
}

// the 帔帛's path: its centreline sampled along its length, each sample labelled with the nearest body landmark (wrist, forearm,
// elbow, upper arm top/under, armpit, shoulder, back, front; 'hanging' when nothing is within 15 cm), runs collapsed
function shawlPath(W, P) {
  const sh = GB.pieces.shawl; if (!sh) return null; const pn = sh[0], sp = GB.mesh.uvTri && ((GB.shawlSpec || DEF0.costume[opt.style].garments.shawl).spacing || 0.03);
  const cl = pn.uv.map((q, i) => [q, pn.vmap[i]]).filter(([q]) => Math.abs(q[0]) < 0.6 * sp).sort((a, b) => a[0][1] - b[0][1]).map(e => e[1]);
  const J = n => W.p[sk.by[n]], seg = (x, a, b) => { const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], t = Math.max(0, Math.min(1, ((x[0] - a[0]) * ab[0] + (x[1] - a[1]) * ab[1] + (x[2] - a[2]) * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2))); return { t, d: Math.hypot(x[0] - a[0] - ab[0] * t, x[1] - a[1] - ab[1] * t, x[2] - a[2] - ab[2] * t), y: a[1] + ab[1] * t }; };
  const fwd = F.qrot(W.q[sk.by.root], [0, 0, 1]), labels = [], raw = []; let wrist = 1;
  const elb = (S, x) => {   // round the elbow: top, inside (toward the front of the body) or outside (toward the back), in the arm's own frame
    const E = J('fore' + S), A = J('arm' + S), u = F.v3.norm(F.v3.sub(E, A)), up = F.v3.norm(F.v3.sub([0, 1, 0], F.v3.mul(u, u[1]))), fp = F.v3.norm(F.v3.sub(fwd, F.v3.mul(u, F.v3.dot(fwd, u)))), d = F.v3.sub(x, E);
    const ph = Math.atan2(F.v3.dot(d, fp), F.v3.dot(d, up)) * 180 / Math.PI; return S + ' elbow ' + (Math.abs(ph) < 50 ? 'top' : ph > 0 ? 'inside' : Math.abs(ph) > 130 ? 'under' : 'outside'); };
  cl.forEach(i => { const x = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], c = [];
    ['L', 'R'].forEach(S => { c.push([S, 'upper', seg(x, J('arm' + S), J('fore' + S))], [S, 'fore', seg(x, J('fore' + S), J('hand' + S))], [S, 'hand', seg(x, J('hand' + S), J('middle1' + S))]); wrist = Math.min(wrist, Math.hypot(x[0] - J('hand' + S)[0], x[1] - J('hand' + S)[1], x[2] - J('hand' + S)[2])); });
    c.push(['', 'torso', seg(x, J('root'), J('neck'))]); c.forEach(e => { e[3] = e[2].d - (e[1] === 'torso' ? 0.13 : 0.04); }); c.sort((a, b) => a[3] - b[3]); const [S, k, r] = c[0]; let l;   // (distances from the limb or torso surface, roughly)
    if (c[0][3] > 0.08) l = 'hanging'; else if (k === 'hand') l = S + ' wrist'; else if (k === 'fore') l = r.t < 0.3 ? elb(S, x) : r.t > 0.85 ? S + ' wrist' : S + ' forearm';
    else if (k === 'upper') l = r.t > 0.8 ? elb(S, x) : r.t > 0.3 ? S + ' upper arm ' + (x[1] > r.y ? 'top' : 'under') : S + (x[1] > r.y ? ' shoulder' : ' armpit');
    else { const o = [x[0] - J('root')[0], 0, x[2] - J('root')[2]]; l = o[0] * fwd[0] + o[2] * fwd[2] < 0 ? 'back' : 'front'; }
    raw.push(l); });
  raw.forEach((l, i) => { const w = [raw[i - 1], l, raw[i + 1]], m = w.filter(x => x === l).length >= 2 || i === 0 || i === raw.length - 1 ? l : raw[i - 1]; if (labels[labels.length - 1] !== m) labels.push(m); });   // (a 3-sample majority: a twist doesn't read as a detour)
  let thumb = 1; for (const i of pn.vmap) for (const S of ['L', 'R']) for (const b of ['thumb2', 'thumb3', 'index2', 'middle2']) { const j = J(b + S); thumb = Math.min(thumb, Math.hypot(P[i * 3] - j[0], P[i * 3 + 1] - j[1], P[i * 3 + 2] - j[2])); }
  let low = [9, 9]; for (const i of pn.vmap) { const k = P[i * 3] > W.p[sk.by.root][0] ? 0 : 1; low[k] = Math.min(low[k], P[i * 3 + 1]); }
  return { seq: labels.join(' → '), wrist, thumb, low };
}
if (opt.shawl && GB) {
  const g = new F.GSim(fig), show = (name, W) => { const r = shawlPath(W, g.cloth.positions); log(`${name}: ${r.seq}\n   nearest wrist ${(r.wrist * 100).toFixed(1)} cm${r.wrist < 0.04 ? '  FAIL (< 4 cm)' : ''}, nearest thumb / finger joint (any shawl particle) ${(r.thumb * 100).toFixed(1)} cm, lowest point of the ends L ${(r.low[0] * 100).toFixed(0)} / R ${(r.low[1] * 100).toFixed(0)} cm above the floor`); return r; };
  gsim = g; const frame = (t, W) => { poseParts(W); garbFrame(t, W, false); };
  const lp = SPEC ? F.layPose(sk, SPEC.pose) : F.bindW(sk), ln = SPEC && SPEC.pose === 'rest' ? 'rest pose' : 'bind A-pose';
  g.reset(poseAt, 0, 'laid'); show(ln + ', shawl just laid on the robe', lp); frame('laid', lp);
  g.reset(poseAt, 0, true); show(ln + ', settled', lp); frame('bind', lp);
  g.reset(poseAt, 0); show('t=0 (first frame)', g.W); frame(0, g.W);
  const shown = [1, 3, 5, 8, 12, 20, 28, 36, 44], all = new Set(shown); if (opt.dense) for (let t = 0; t <= perf.dur + 1e-9; t += opt.dense) all.add(+t.toFixed(2));   // (--dense 0.2: every 0.2 s for the piercing and layering counts)
  [...all].sort((a, b) => a - b).forEach(t => { g.advance(poseAt, t); if (shown.includes(t)) show('t=' + t, g.W); frame(t, g.W); });
  log(`shawl checked at ${all.size + 3} frames`);
  table('shawl layering (edges of the shawl through the robe and sleeves)', Object.fromEntries(Object.entries(GR.nest).filter(([k]) => /^shawl/.test(k))), 'n');
  table('shawl penetration', Object.fromEntries(Object.entries(GR.pen).filter(([k]) => /^shawl/.test(k))));
  const tri = Object.entries(GR.penTri).filter(([k]) => /^shawl.*@(thumb|index|middle|ring|pinky|hand)/.test(k)); log('shawl triangles pierced by the hand / thumb: ' + (tri.length ? tri.map(([k, e]) => k + ' ' + (e.worst * 1000).toFixed(1) + ' mm in ' + e.frames.size + ' frame(s)').join('; ') : 'none'));
  process.exit(0);
}
/* ---------- run: the whole song, then extreme poses ---------- */
const syncRef = []; const frames = []; for (let t = 0; t <= perf.dur + 1e-9; t += opt.step) frames.push(+t.toFixed(3));
let lastZ = -1e9; const t1 = Date.now();
fig.sim.reset(-5);   // the warm-up (bind → rest, 2.4 s) and settling are over by t = 0
frames.forEach((t, fi) => {
  fig.sim.advance(poseAt, t);
  if (gsim) gsim.advance(poseAt, t);
  const W = gsim ? gsim.W : fig.sim.W || poseAt(t, 1);
  checkFrame(t, W, t); if (gsim) syncRef.push([t, garbFrame(t, W, t - lastZ >= opt.zstep - 1e-9)]);
  if (t - lastZ >= opt.zstep - 1e-9) { checkZ(t); lastZ = t; }
  if (fi % 50 === 0) process.stdout.write(`  t=${t.toFixed(1)}s (${((Date.now() - t1) / 1000).toFixed(0)}s)\r`);
});
log(`song: ${frames.length} frames every ${opt.step}s (z-fight every ${opt.zstep}s) in ${((Date.now() - t1) / 1000).toFixed(0)}s            `);
// extreme poses (rigid / skinned parts only; cloth keeps its last state): every pose in the library + face extremes
const ext = Object.keys(F.POSES || {}).length ? F.POSES : null;
const extremes = [];
(function () {
  const C = F.defaultControls(); C.jaw = 1; C.lipRound = 1; C.blinkL = C.blinkR = 1; C.browL = C.browR = 1; C.smile = 1; extremes.push(['face max', C]);
  const D = F.defaultControls(); D.lipPress = 1; D.lipSpread = 1; D.smile = 1; extremes.push(['lips pressed+spread', D]);
  ['L', 'R'].forEach(S => { const E = F.defaultControls(); E['arm' + S] = Object.assign({}, E['arm' + S], { raise: 1.7, fwd: 0.6, elbow: 2.0, pron: 1.5, wflex: 0.8, fing: [1, 1, 1, 1, 0.8] }); E.head = [0.25, 0.5, 0.2]; E.neck = [0.15, 0.3, 0]; extremes.push(['arm' + S + ' extreme + head turned', E]); });
  if (ext) Object.keys(ext).forEach(k => { const E = F.defaultControls(); E.armL = ext[k].L; E.armR = ext[k].R; E.spine = ext[k].spine; E.head = ext[k].head; extremes.push(['pose ' + k, E]); });
})();
extremes.forEach(([name, C]) => { const W = F.solve(sk, C); poseParts(W);
  // rigid / skinned parts only
  allUnits.filter(u => !u.part.cloth).forEach(u => { if (rigidSame(u.part)) return; const r = unitDist(u); if (r.d > EPS) note(R.attach, u.name + ' → ' + parentsOf(u.part).join('|'), name, r.d); });
});

/* ---------- report ---------- */
function table(title, map, unit) {
  const ks = Object.keys(map);
  log(`\n${title}: ${ks.length ? 'FAIL (' + ks.length + ')' : 'OK'}`);
  ks.sort((a, b) => map[b].worst - map[a].worst).slice(0, 25).forEach(k => { const e = map[k], fr = [...e.frames].slice(0, 6).map(x => typeof x === 'number' ? x.toFixed(1) + 's' : x).join(', ');
    log(`  ${k.padEnd(34)} worst ${unit === 'n' ? e.worst + ' edges' : (e.worst * 1000).toFixed(2) + ' mm'} at ${typeof e.at === 'number' ? e.at.toFixed(1) + 's' : e.at}; ${e.frames.size} frame(s): ${fr}${e.frames.size > 6 ? ' …' : ''}`); });
}
table('1. attachment (gap to parent > ' + EPS * 1000 + ' mm)', R.attach);
const bad = R.graph.filter(g => g[1] !== 1);
log(`   contact graph: ${bad.length ? 'FAIL — ' + bad.length + ' frame(s) with more than one component, e.g. ' + bad.slice(0, 5).map(g => g[0] + 's:' + g[1]).join(' ') : 'one connected component in all ' + R.graph.length + ' frames'}`);
table('2a. penetration: cloth vertices inside the body (> ' + PEN_TOL * 1000 + ' mm)', R.pen);
const tri = Object.keys(R.penTri);
log(`   (info) cloth triangle interiors (centroids) inside the body: ${tri.length ? tri.length + ' region(s), worst ' + (Math.max(...tri.map(k => R.penTri[k].worst)) * 1000).toFixed(1) + ' mm (' + tri.sort((a, b) => R.penTri[b].worst - R.penTri[a].worst).slice(0, 3).join('; ') + ')' : 'none'}`);
table('2b. layering: outer cloth closer than 0.8 mm to / inside the layer below', R.nest);
table('3. z-fighting: coplanar (<10°) and closer than ' + GMIN * 1000 + ' mm', R.zf);
const gfail = GB ? garbReport() : 0;
// 5. cloth sync: playback emulation — 50 fps frames, at most one cloth step per frame (worse than the page, which may take
//    two within its time budget); the sim must never trail the animation by more than a step, and no cloth particle may stay
//    > 5 mm inside the body for long (that is what lagging cloth looks like: the body pokes through, then the cloth jumps)
if (!GB) (function () {
  // reference: the same frames with the cloth fully stepped. Lag shows as more cloth inside the body than in the
  // reference; the two runs diverge chaotically in detail, so compare counts of deep particles (> 5 mm) per frame and
  // report the longest stretch where the emulation has clearly more (≥ 8 particles)
  const T = []; for (let t = 0; t <= perf.dur; t += 0.02) T.push(t);
  const cnt = d => d.reduce((a, f) => a + f.reduce((x, y) => x + y, 0), 0);
  let sim = new F.Sim(fig); const ref = T.map(t => { sim.advance(poseAt, t); return cnt(sim.deep(0.005)); });
  sim = new F.Sim(fig); let lag = 0, run = 0, longest = 0, at = 0, who = 'cloth', worst = 0;
  T.forEach((t, fi) => { sim.advance(poseAt, t, 0, 1); if (t > 3) lag = Math.max(lag, t - sim.t);
    const ex = cnt(sim.deep(0.005)) - ref[fi]; worst = Math.max(worst, ex); run = ex >= 8 ? run + 0.02 : 0; if (run > longest) { longest = run; at = t; } });
  const ok = lag <= F.SIM_DT + 1e-6; R.sync = ok;   // the guarantee is the lag; the penetration stretch under this stress setting is reported (info)
  log(`\n5. cloth sync (playback emulation, 50 fps, ≤ 1 cloth step per frame, ${sim.skipped || 0} carried catch-ups): max lag behind the animation ${(lag * 1000).toFixed(0)} ms (≤ ${(F.SIM_DT * 1000).toFixed(0)}), longest stretch with clearly more cloth inside the body than the fully stepped cloth ${(longest * 1000).toFixed(0)} ms (@${at.toFixed(1)}s, info: the page takes up to two steps per frame and keeps up; most extra particles in a frame ${worst})  ${ok ? 'OK' : 'FAIL'}`);
})();
log('\n4. motion: self-collision, motion quality, camera (tool/motion.js)');
const mfails = require('./motion.js').report(require('./motion.js').analyze(fig, perf), log);
const sfail = GB ? garbSync(syncRef) : 0;
const fail = gfail + sfail + Object.keys(R.attach).length + bad.length + Object.keys(R.pen).length + Object.keys(R.nest).length + Object.keys(R.zf).length + (bc.count !== 1 || loops ? 1 : 0) + mfails.length + (GB || R.sync ? 0 : 1);
log(`\n${fail ? 'FAILED' : 'ALL CHECKS PASSED'} — ${R.frames} frames + ${extremes.length} extreme poses, ${((Date.now() - T0) / 1000).toFixed(0)}s`);
if (opt.render) {
  log('\nrender flicker test (headless Chrome, 0.25 px jitter):');
  const t = (perf.t0 + 3).toFixed(2);
  log(execFileSync(path.join(__dirname, 'shoot.sh'), ['--url-extra', '&t=' + t, '--flicker', 'full:cam=full', '--flicker', 'medium:cam=medium', '--flicker', 'face:cam=face', '--flicker', 'hair:cam=hair', '--flicker', 'hands:cam=hands'], { encoding: 'utf8' }).split('\n').filter(l => /flicker/.test(l)).join('\n'));
}
process.exit(fail ? 1 : 0);
})();
