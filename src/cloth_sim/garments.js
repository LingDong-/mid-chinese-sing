// garments.js — procedural garments.
// Tailored garments (shirt, jacket, trenchcoat, dress, skirts) are built like real clothes: flat 2D panels (front, back,
// sleeves) are triangulated, placed around the body and sewn together along named edges (vertices welded). Rest lengths
// come from the 2D pattern, so the cloth is truly flat fabric and the 3D placement only needs to be roughly right.
// Draped pieces (cape, shawl, sash, ribbon) are strips laid along a path over the body.
//
// mesh: { positions: Float32Array(3n), indices: Uint32Array, uvTri?: Float32Array(6T), pins: [{i, bone, local}], shear?, stitches? }

// ------------------------------------------------------------------ 2D utilities
const len2 = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);
function polyLength(pts) { let l = 0; for (let i = 1; i < pts.length; i++) l += len2(pts[i - 1], pts[i]); return l; }
function resample(pts, n) { // n+1 points evenly spaced by arc length
  const L = polyLength(pts), out = [pts[0].slice()]; let seg = 1, acc = 0;
  for (let k = 1; k < n; k++) { const target = L * k / n;
    while (seg < pts.length - 1 && acc + len2(pts[seg - 1], pts[seg]) < target) { acc += len2(pts[seg - 1], pts[seg]); seg++; }
    const d = len2(pts[seg - 1], pts[seg]), f = d > 0 ? (target - acc) / d : 0;
    out.push([pts[seg - 1][0] + (pts[seg][0] - pts[seg - 1][0]) * f, pts[seg - 1][1] + (pts[seg][1] - pts[seg - 1][1]) * f]); }
  out.push(pts[pts.length - 1].slice()); return out;
}
function bezier(p0, p1, p2, p3, n = 32) { const o = []; for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t; o.push([u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0], u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1]]); } return o; }
const line = (p, q) => [p, q];
function inside(poly, x, y) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
function distToPoly(poly, x, y) { let best = Infinity; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[j], b = poly[i]; const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx*dx + dy*dy; let t = l2 > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); const ex = a[0] + dx*t - x, ey = a[1] + dy*t - y; best = Math.min(best, ex*ex + ey*ey); } return Math.sqrt(best); }

// Bowyer–Watson Delaunay triangulation of 2D points. Returns triangles as [i,j,k] (counter-clockwise).
function delaunay(P) {
  const n = P.length; let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const p of P) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); }
  const d = Math.max(maxx - minx, maxy - miny) * 10, mx = (minx + maxx) / 2, my = (miny + maxy) / 2;
  const pts = P.concat([[mx - 2 * d, my - d], [mx, my + 2 * d], [mx + 2 * d, my - d]]);
  const mk = (a, b, c) => { const ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1], cx = pts[c][0], cy = pts[c][1];
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by)); if (Math.abs(D) < 1e-18) return null;
    const ux = ((ax*ax + ay*ay) * (by - cy) + (bx*bx + by*by) * (cy - ay) + (cx*cx + cy*cy) * (ay - by)) / D;
    const uy = ((ax*ax + ay*ay) * (cx - bx) + (bx*bx + by*by) * (ax - cx) + (cx*cx + cy*cy) * (bx - ax)) / D;
    return { a, b, c, ux, uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 }; };
  let tris = [mk(n, n + 1, n + 2)];
  for (let i = 0; i < n; i++) {
    const px = pts[i][0], py = pts[i][1], bad = [], edges = new Map();
    for (let t = 0; t < tris.length; t++) { const T = tris[t]; if ((px - T.ux) ** 2 + (py - T.uy) ** 2 < T.r2 * (1 + 1e-12)) bad.push(t); }
    for (const t of bad) { const T = tris[t]; for (const [a, b] of [[T.a, T.b], [T.b, T.c], [T.c, T.a]]) { const k = a < b ? a + ',' + b : b + ',' + a; const e = edges.get(k); if (e) e.n++; else edges.set(k, { a, b, n: 1 }); } }
    for (let k = bad.length - 1; k >= 0; k--) { const t = bad[k]; tris[t] = tris[tris.length - 1]; tris.pop(); }
    for (const e of edges.values()) if (e.n === 1) { const T = mk(e.a, e.b, i); if (T) tris.push(T); }
  }
  const out = [];
  for (const T of tris) { if (T.a >= n || T.b >= n || T.c >= n) continue;
    const a = pts[T.a], b = pts[T.b], c = pts[T.c]; const s = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    out.push(s >= 0 ? [T.a, T.b, T.c] : [T.a, T.c, T.b]); }
  return out;
}

// ------------------------------------------------------------------ panels
// A panel is a closed outline made of named edges (consecutive edges share endpoints, counter-clockwise), plus a placement
// function place([x,y]) -> [X,Y,Z] and an outward(p3) -> direction used to orient triangles consistently.
export class Panel {
  constructor(name, place, outward) { this.name = name; this.place = place; this.outward = outward || (p => [p[0], 0, p[2]]); this.edges = []; this.pinEdges = []; }
  edge(name, pts, n) { this.edges.push({ name, pts: n ? resample(pts, n) : pts }); return this; }
  pinEdge(name, bone, from = 0, to = 1) { this.pinEdges.push({ name, bone, from, to }); return this; }
  // triangulate: boundary samples + brick lattice interior
  build(S) {
    const outline = [], edgeIdx = {};
    for (const e of this.edges) { const ids = []; for (let k = 0; k < e.pts.length; k++) {
      if (k === e.pts.length - 1) { ids.push(-1); break; } // last point = next edge's first
      ids.push(outline.length); outline.push(e.pts[k]); }
      edgeIdx[e.name] = ids; }
    // close indices (-1 -> next edge's first index)
    const names = this.edges.map(e => e.name);
    for (let i = 0; i < names.length; i++) { const ids = edgeIdx[names[i]]; ids[ids.length - 1] = edgeIdx[names[(i + 1) % names.length]][0]; }
    let area = 0; for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) area += outline[j][0] * outline[i][1] - outline[i][0] * outline[j][1];
    if (area < 0) console.warn('panel outline is clockwise:', this.name);
    const pts = outline.map(p => p.slice());
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const p of outline) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); }
    const h = S * Math.sqrt(3) / 2; let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
    for (let j = 0, y = miny + 0.5 * h; y < maxy; j++, y += h) for (let x = minx + (0.5 + 0.5 * (j & 1)) * S; x < maxx; x += S) {
      const px = x + 0.02 * S * rnd(), py = y + 0.02 * S * rnd();
      if (inside(outline, px, py) && distToPoly(outline, px, py) > 0.55 * S) pts.push([px, py]); }
    let tris = delaunay(pts);
    tris = tris.filter(([a, b, c]) => inside(outline, (pts[a][0] + pts[b][0] + pts[c][0]) / 3, (pts[a][1] + pts[b][1] + pts[c][1]) / 3));
    // check the outline edges survived
    const es = new Set(); for (const [a, b, c] of tris) for (const [p, q] of [[a, b], [b, c], [c, a]]) es.add(p < q ? p + ',' + q : q + ',' + p);
    let missing = 0; for (let i = 0; i < outline.length; i++) { const a = i, b = (i + 1) % outline.length; if (!es.has(a < b ? a + ',' + b : b + ',' + a)) missing++; }
    if (missing) console.warn(`panel ${this.name}: ${missing} outline edges not in triangulation`);
    this.pts = pts; this.tris = tris; this.edgeIdx = edgeIdx; this.nBoundary = outline.length;
    return this;
  }
}

// Sew panels: seams = [[panelA, edgeA, panelB, edgeB, reverse]] weld vertex pairs along the edges. Returns a cloth mesh.
export function assemble(panels, seams, body, S) {
  for (const p of panels) p.build(S);
  const offset = new Map(); let n = 0; for (const p of panels) { offset.set(p, n); n += p.pts.length; }
  const parent = new Int32Array(n); for (let i = 0; i < n; i++) parent[i] = i;
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
  for (const [A, ea, B, eb, rev] of seams) {
    const ia = A.edgeIdx[ea], ib = B.edgeIdx[eb]; if (!ia || !ib) throw new Error('unknown seam edge ' + ea + '/' + eb);
    const na = ia.length - 1, nb = ib.length - 1;
    if (na !== nb) console.warn(`seam ${A.name}.${ea} (${na}) vs ${B.name}.${eb} (${nb}) sample mismatch`);
    for (let k = 0; k <= na; k++) { const kb = Math.round(k * nb / na); union(offset.get(A) + ia[k], offset.get(B) + ib[rev ? nb - kb : kb]); }
  }
  const remap = new Int32Array(n).fill(-1); let m = 0; for (let i = 0; i < n; i++) if (find(i) === i) remap[i] = m++;
  for (let i = 0; i < n; i++) remap[i] = remap[find(i)];
  const positions = new Float32Array(3 * m), placed = new Uint8Array(m), indices = [], uvTri = [], pins = [], seen = new Set();
  for (const p of panels) {
    const o = offset.get(p);
    for (let i = 0; i < p.pts.length; i++) { const g = remap[o + i]; if (placed[g]) continue; const q = p.place(p.pts[i]); positions.set(q, 3 * g); placed[g] = 1; }
    // orientation: flip if the placed triangle normal points inward
    let flip = 0, cnt = 0;
    for (const [a, b, c] of p.tris) { const A = p.place(p.pts[a]), B = p.place(p.pts[b]), C = p.place(p.pts[c]);
      const ux = B[0]-A[0], uy = B[1]-A[1], uz = B[2]-A[2], vx = C[0]-A[0], vy = C[1]-A[1], vz = C[2]-A[2];
      const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx; const ow = p.outward([(A[0]+B[0]+C[0])/3, (A[1]+B[1]+C[1])/3, (A[2]+B[2]+C[2])/3]);
      flip += nx*ow[0] + ny*ow[1] + nz*ow[2] < 0 ? 1 : -1; if (++cnt > 40) break; }
    for (const [a, b, c] of p.tris) {
      const ga = remap[o + a], gb = remap[o + b], gc = remap[o + c]; if (ga === gb || gb === gc || ga === gc) continue;
      if (flip > 0) { indices.push(ga, gc, gb); uvTri.push(...p.pts[a], ...p.pts[c], ...p.pts[b]); } else { indices.push(ga, gb, gc); uvTri.push(...p.pts[a], ...p.pts[b], ...p.pts[c]); }
    }
    for (const pe of p.pinEdges) { const ids = p.edgeIdx[pe.name]; for (let k = 0; k < ids.length; k++) { const f = k / (ids.length - 1); if (f < pe.from - 1e-9 || f > pe.to + 1e-9) continue; const i = ids[k]; const g = remap[o + i]; if (seen.has(g)) continue; seen.add(g); pins.push({ i: g, bone: pe.bone, local: body.restInverse(pe.bone)([positions[3*g], positions[3*g+1], positions[3*g+2]]) }); } }
  }
  return { positions, indices: new Uint32Array(indices), uvTri: new Float32Array(uvTri), pins, stitches: new Int32Array(0), panels: panels.length };
}

// ------------------------------------------------------------------ strips along a path (cape, shawl, sash, ribbon)
export function grid(nu, nv, f, { closedU = false, uLen = 1, vLen = 1, panel = 0 } = {}) {
  const cols = nu, n = cols * nv;
  const positions = new Float32Array(3 * n), uv = new Float32Array(2 * n), pan = new Int32Array(n).fill(panel);
  const du = closedU ? 1 / nu : 1 / (nu - 1);
  for (let j = 0; j < nv; j++) for (let i = 0; i < cols; i++) {
    let u = (i + (j & 1 ? 0.5 : 0)) * du; if (!closedU) { if (i === 0) u = 0; if (i === cols - 1) u = 1; } // brick offset rows, straight edges
    const v = j / (nv - 1), k = j * cols + i;
    const p = f(u, v); positions[3*k] = p[0]; positions[3*k+1] = p[1]; positions[3*k+2] = p[2];
    uv[2*k] = u * uLen; uv[2*k+1] = v * vLen;
  }
  const idx = [], shear = [];
  const segs = closedU ? nu : nu - 1;
  for (let j = 0; j < nv - 1; j++) for (let i = 0; i < segs; i++) {
    const a = j * cols + i, b = j * cols + (i + 1) % cols, c = (j + 1) * cols + i, d = (j + 1) * cols + (i + 1) % cols;
    if (j & 1) { idx.push(a, b, d, a, d, c); shear.push(a, d, b, d); } else { idx.push(a, b, c, b, d, c); shear.push(b, c, a, c); }
  }
  return { positions, indices: new Uint32Array(idx), uv, panel: pan, pins: [], stitches: new Int32Array(0), shear: new Int32Array(shear), nu: cols, nv, at: (i, j) => j * cols + ((i % cols) + cols) % cols };
}
export function pin(m, i, bone, body) { const x = m.positions; m.pins.push({ i, bone, local: body.restInverse(bone)([x[3*i], x[3*i+1], x[3*i+2]]) }); }

// strip of width w along a Catmull-Rom path through keys [{p:[x,y,z], n:[nx,ny,nz]}]; n = local body normal (width runs along tangent x n)
function strip(keys, w, S, opts = {}) {
  const P = keys.map(k => k.p), N = keys.map(k => k.n);
  const cr = (arr, i, t) => { const p0 = arr[Math.max(0, i - 1)], p1 = arr[i], p2 = arr[Math.min(arr.length - 1, i + 1)], p3 = arr[Math.min(arr.length - 1, i + 2)];
    return [0, 1, 2].map(k => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2*p0[k] - 5*p1[k] + 4*p2[k] - p3[k]) * t*t + (-p0[k] + 3*p1[k] - 3*p2[k] + p3[k]) * t*t*t)); };
  // sample densely, then by arc length
  const dense = []; for (let i = 0; i < P.length - 1; i++) for (let k = 0; k < 20; k++) dense.push({ p: cr(P, i, k / 20), n: cr(N, i, k / 20) }); dense.push({ p: P[P.length - 1], n: N[N.length - 1] });
  const cum = [0]; for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + Math.hypot(...dense[i].p.map((v, k) => v - dense[i - 1].p[k])));
  const L = cum[cum.length - 1], nv = Math.round(L / S) + 1, nu = Math.round(w / S) + 1;
  const at = (s) => { let i = 1; while (i < cum.length - 1 && cum[i] < s) i++; const f = (s - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
    const p = dense[i - 1].p.map((v, k) => v + (dense[i].p[k] - v) * f), n = dense[i - 1].n.map((v, k) => v + (dense[i].n[k] - v) * f);
    const t = dense[i].p.map((v, k) => v - dense[i - 1].p[k]); return { p, n, t }; };
  const m = grid(nu, nv, (u, v) => { const { p, n, t } = at(v * L); let wd = cross(t, n); const l = Math.hypot(...wd) || 1; wd = wd.map(v => v / l);
    return [p[0] + wd[0] * (u - 0.5) * w, p[1] + wd[1] * (u - 0.5) * w, p[2] + wd[2] * (u - 0.5) * w]; }, { uLen: w, vLen: L });
  m.L = L; return m;
}
function cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0]/l, a[1]/l, a[2]/l]; }

// ------------------------------------------------------------------ garments
export const garmentNames = ['shirt', 'jacket', 'trenchcoat', 'dress', 'gown', 'skirt', 'longskirt', 'shawl', 'sash', 'cape', 'ribbon'];

export function makeGarment(name, body, S = 0.025) {
  const J = body.joints, R = body.radii;
  const shoulderY = J.lShoulder[1], waistY = J.hips[1] + 0.06, kneeY = J.lKnee[1];
  const rho = R.torsoZ / R.torsoX; // cross-section aspect
  const qp = (rx, rz) => (Math.PI / 2) * Math.sqrt((rx*rx + rz*rz) / 2); // quarter perimeter of an ellipse (approx)
  const rxFromHw = hw => hw * (2 / Math.PI) / Math.sqrt((1 + rho*rho) / 2);
  const bust = body.bust ? body.caps.filter(c => c.bust) : [];
  // place a body-panel point: x -> angle around the torso, hw(y) = panel half width below the armpit; above it the cross
  // section shrinks in depth following the shoulders so front and back meet on top.
  const wrapTorso = (side, hw, yAp, yTop) => (p) => {
    const w = hw(Math.min(p[1], yAp)), a = p[0] / w * (Math.PI / 2), rx = rxFromHw(w), rz = rho * rx;
    let g = 1; if (p[1] > yAp) { const f = (p[1] - yAp) / Math.max(1e-6, yTop - yAp); g = Math.max(0.12, Math.sqrt(Math.max(0, 1 - f * f))); }
    let q = [rx * Math.sin(a), p[1], side * rz * Math.cos(a) * g];
    if (q[1] < 0.03) { const ex = 0.03 - q[1]; q[1] = 0.03 + 0.002 * ex; const l = Math.hypot(q[0], q[2]) || 1; q[0] += q[0] / l * ex; q[2] += q[2] / l * ex; } // below the floor: spread outward instead
    if (side > 0) for (const b of bust) { const c = b.world, d = [q[0] - c[0], q[1] - c[1], q[2] - c[2]], l = Math.hypot(...d), r = b.r + 0.015; if (l < r) q = [c[0] + d[0] / l * r, c[1] + d[1] / l * r, c[2] + d[2] / l * r]; }
    return q;
  };
  // sleeve placement: 2D (u, v<=0) -> around the arm axis; u maps to angle (u>0 = front), v along the arm
  const wrapArm = (side, W, r) => { const s = J[side + 'Shoulder'], d = body.armDir(side), sg = side === 'l' ? 1 : -1;
    const e1 = [sg * -d[1], sg * d[0], 0], e2 = [0, 0, 1]; // e1: away from the body, perpendicular to the arm
    return (p) => { const a = p[0] / (W / 2) * Math.PI, t = -p[1] - 0.03;
      return [s[0] + d[0]*t + r*(e1[0]*Math.cos(a) + e2[0]*Math.sin(a)), s[1] + d[1]*t + r*(e1[1]*Math.cos(a) + e2[1]*Math.sin(a)), s[2] + d[2]*t + r*(e1[2]*Math.cos(a) + e2[2]*Math.sin(a))]; }; };
  const armOutward = (side) => { const s = J[side + 'Shoulder'], d = body.armDir(side); return (q) => { const px = q[0]-s[0], py = q[1]-s[1], pz = q[2]-s[2], t = px*d[0]+py*d[1]+pz*d[2]; return [px - d[0]*t, py - d[1]*t, pz - d[2]*t]; }; };
  const nOf = (pts) => Math.max(2, Math.round(polyLength(pts) / S));

  // --- a tailored top: body (front/back or front halves) + optional sleeves
  // opts: ease, hemY, sleeveLen (0 = none), sleeveEase, open (front split with gap), flare (extra half width at the hem), neckF, neckB
  const top = (opts) => {
    const { ease, hemY, sleeveLen = 0, sleeveEase = 0.02, open = 0, flare = 0, neckF = 0.07, neckB = 0.02 } = opts;
    const rx = R.torsoX + ease, rz = R.torsoZ + ease, hwChest = qp(rx, rz);
    const yAp = shoulderY - 0.19, yTip = shoulderY + 0.03, xTip = J.lShoulder[0] + 0.02, xNeck = 0.075, yNeckSide = shoulderY + 0.07;
    const hw = (y) => hwChest + flare * Math.max(0, (yAp - y) / (yAp - hemY));
    const yTop = yNeckSide;
    // armhole (right side, armpit -> tip), scooped so its length fits the sleeve cap; mirrored for the left
    const Wsl = 2 * Math.PI * (R.arm + sleeveEase), capH = (shoulderY - yAp) / -body.armDir('l')[1] + 0.03;
    const armholeR = (bulge) => bezier([hw(yAp), yAp], [hw(yAp) + bulge, yAp + 0.08], [xTip + 0.03, yTip - 0.1], [xTip, yTip]);
    let bulge = 0.0, ah = armholeR(0);
    const needed = 1.04 * Math.hypot(Wsl / 2, capH);
    for (let k = 0; k < 12 && polyLength(ah) < needed; k++) { bulge += 0.01; ah = armholeR(bulge); }
    const nAh = nOf(ah), nSide = Math.max(2, Math.round((yAp - hemY) / S)), nSh = nOf([[xTip, yTip], [xNeck, yNeckSide]]);
    const mirror = pts => pts.map(p => [-p[0], p[1]]).reverse();
    const neck = (depth, n) => bezier([xNeck, yNeckSide], [xNeck, yNeckSide - depth], [0.03, yNeckSide - depth], [0, yNeckSide - depth], n);
    const panels = [], seams = [];
    const bodyPanel = (nm, side, depth) => {
      const P = new Panel(nm, wrapTorso(side, hw, yAp, yTop));
      const sideR = [], sideL = [];
      for (let k = 0; k <= nSide; k++) { const y = hemY + (yAp - hemY) * k / nSide; sideR.push([hw(y), y]); sideL.push([-hw(y), y]); }
      P.edge('hem', line([-hw(hemY), hemY], [hw(hemY), hemY]), Math.max(2, Math.round(2 * hw(hemY) / S)))
       .edge('sideR', sideR).edge('armholeR', ah, nAh).edge('shoulderR', line([xTip, yTip], [xNeck, yNeckSide]), nSh)
       .edge('neck', neck(depth, 16).concat(mirror(neck(depth, 16)).slice(1)), Math.max(4, Math.round(polyLength(neck(depth, 16)) * 2 / S)))
       .edge('shoulderL', line([-xNeck, yNeckSide], [-xTip, yTip]), nSh).edge('armholeL', mirror(ah), nAh).edge('sideL', sideL.slice().reverse());
      if (side < 0) P.pinEdge('neck', 'chest', 0.2, 0.8); // the back neckline is held; the front hangs from the shoulder seams
      return P;
    };
    const back = bodyPanel('back', -1, neckB); panels.push(back);
    if (!open) {
      const front = bodyPanel('front', 1, neckF); panels.push(front);
      seams.push([front, 'sideR', back, 'sideR', false], [front, 'sideL', back, 'sideL', false], [front, 'shoulderR', back, 'shoulderR', false], [front, 'shoulderL', back, 'shoulderL', false]);
      panels.frontR = front; panels.frontL = front;
    } else { // two front halves with a gap at the centre
      const gap = open;
      for (const sg of [1, -1]) {
        const P = new Panel(sg > 0 ? 'frontR' : 'frontL', wrapTorso(1, hw, yAp, yTop));
        const sideE = []; for (let k = 0; k <= nSide; k++) { const y = hemY + (yAp - hemY) * k / nSide; sideE.push([hw(y), y]); }
        const nk = neck(neckF, 16).filter(p => p[0] >= gap); nk.push([gap, nk[nk.length - 1][1]]);
        const nCF = Math.max(2, Math.round((nk[nk.length - 1][1] - hemY) / S));
        if (sg > 0) P.edge('hem', line([gap, hemY], [hw(hemY), hemY]), Math.max(2, Math.round((hw(hemY) - gap) / S))).edge('sideR', sideE).edge('armholeR', ah, nAh).edge('shoulderR', line([xTip, yTip], [xNeck, yNeckSide]), nSh).edge('neck', nk, Math.max(3, nOf(nk))).edge('centre', line(nk[nk.length - 1], [gap, hemY]), nCF);
        else { const mk = mirror(nk); P.edge('hem', line([-hw(hemY), hemY], [-gap, hemY]), Math.max(2, Math.round((hw(hemY) - gap) / S))).edge('centre', line([-gap, hemY], mk[0]), nCF).edge('neck', mk, Math.max(3, nOf(mk))).edge('shoulderL', line([-xNeck, yNeckSide], [-xTip, yTip]), nSh).edge('armholeL', mirror(ah), nAh).edge('sideL', sideE.map(p => [-p[0], p[1]]).reverse()); }
        panels.push(P);
        if (sg > 0) { seams.push([P, 'sideR', back, 'sideR', false], [P, 'shoulderR', back, 'shoulderR', false]); panels.frontR = P; }
        else { seams.push([P, 'sideL', back, 'sideL', false], [P, 'shoulderL', back, 'shoulderL', false]); panels.frontL = P; }
      }
    }
    if (sleeveLen > 0) {
      // sleeve panel: cuff (back->front), front side seam up, cap front half (corner->top), cap back half (top->corner), back side seam down
      const Wc = Math.min(Wsl, 2 * Math.PI * (R.arm * 0.8 + sleeveEase)), L = sleeveLen;
      const capHalf = (k, sg) => bezier([0, 0], [sg * Wsl / 2 * 0.55 * k, 0], [sg * Wsl / 2, -capH * 0.5], [sg * Wsl / 2, -capH]); // sg=+1 front
      // choose cap curvature k so its length matches the armhole
      let k = 0.5, lo = 0, hi = 1.5; for (let it = 0; it < 20; it++) { k = (lo + hi) / 2; if (polyLength(capHalf(k, 1)) < polyLength(ah)) lo = k; else hi = k; }
      for (const side of ['l', 'r']) {
        const P = new Panel('sleeve' + side, wrapArm(side, Wsl, Wsl / (2 * Math.PI)), armOutward(side));
        const nS = Math.max(2, Math.round(Math.hypot(Wsl / 2 - Wc / 2, L - capH) / S));
        P.edge('cuff', line([-Wc / 2, -L], [Wc / 2, -L]), Math.max(2, Math.round(Wc / S)))
         .edge('sideF', line([Wc / 2, -L], [Wsl / 2, -capH]), nS).edge('capF', capHalf(k, 1).reverse(), nAh).edge('capB', capHalf(k, -1), nAh).edge('sideB', line([-Wsl / 2, -capH], [-Wc / 2, -L]), nS);
        panels.push(P);
        seams.push([P, 'sideF', P, 'sideB', true]);
        if (side === 'l') seams.push([P, 'capF', panels.frontR, 'armholeR', false], [P, 'capB', back, 'armholeR', true]);
        else seams.push([P, 'capF', panels.frontL, 'armholeL', true], [P, 'capB', back, 'armholeL', false]);
      }
    }
    return assemble(panels, seams, body, S);
  };

  const skirtPanels = (yWaist, hemY, hwWaist, hwHem, bone) => {
    const hw = y => hwWaist + (hwHem - hwWaist) * (yWaist - y) / (yWaist - hemY);
    const nSide = Math.max(2, Math.round(Math.hypot(hwHem - hwWaist, yWaist - hemY) / S));
    const panels = [], seams = [];
    for (const side of [1, -1]) {
      const P = new Panel(side > 0 ? 'front' : 'back', wrapTorso(side, hw, yWaist + 1, yWaist + 2));
      P.edge('hem', line([-hwHem, hemY], [hwHem, hemY]), Math.max(2, Math.round(2 * hwHem / S))).edge('sideR', line([hwHem, hemY], [hwWaist, yWaist]), nSide)
       .edge('waist', line([hwWaist, yWaist], [-hwWaist, yWaist]), Math.max(2, Math.round(2 * hwWaist / S))).edge('sideL', line([-hwWaist, yWaist], [-hwHem, hemY]), nSide);
      P.pinEdge('waist', bone); panels.push(P);
    }
    seams.push([panels[0], 'sideR', panels[1], 'sideR', false], [panels[0], 'sideL', panels[1], 'sideL', false]);
    return assemble(panels, seams, body, S);
  };

  let m, desc;
  switch (name) {
    case 'shirt': m = top({ ease: 0.03, hemY: waistY - 0.12, sleeveLen: 0.27, sleeveEase: 0.018 }); desc = 't-shirt: front + back + two sleeves, sewn at shoulders, sides and armholes; neckline pinned'; break;
    case 'jacket': m = top({ ease: 0.045, hemY: waistY - 0.16, sleeveLen: 0.6, sleeveEase: 0.03, open: 0.012, flare: 0.02 }); desc = 'open jacket: back, two front halves, long sleeves'; break;
    case 'trenchcoat': m = top({ ease: 0.05, hemY: kneeY - 0.12, sleeveLen: 0.62, sleeveEase: 0.035, open: 0.012, flare: 0.12 }); desc = 'knee-length open coat with flared skirt and long sleeves'; break;
    case 'dress': case 'gown': {
      const yTop = shoulderY - 0.07, hemY = name === 'gown' ? -0.35 : 0.08; // the gown's pattern extends well below the floor so it pools
      const hwB = qp(R.torsoX + 0.012, R.torsoZ + 0.012), hwH = qp(R.hipX + 0.012, R.hipZ + 0.012);
      const hw = y => { if (y > waistY) return hwB + (bust.length ? 0.02 : 0); const t = (waistY - y) / (waistY - 0.08); return hwH + (name === 'gown' ? 0.45 : 0.55) * t * t; };
      const nSide = 48;
      const panels = [], seams = [];
      for (const side of [1, -1]) {
        const P = new Panel(side > 0 ? 'front' : 'back', wrapTorso(side, hw, yTop + 1, yTop + 2));
        const sideR = []; for (let k = 0; k <= nSide; k++) { const y = hemY + (yTop - hemY) * k / nSide; sideR.push([hw(y), y]); }
        const nS = nOf(sideR);
        P.edge('hem', line([-hw(hemY), hemY], [hw(hemY), hemY]), Math.max(2, Math.round(2 * hw(hemY) / S))).edge('sideR', sideR, nS)
         .edge('top', line([hw(yTop), yTop], [-hw(yTop), yTop]), Math.max(2, Math.round(2 * hw(yTop) / S))).edge('sideL', sideR.map(p => [-p[0], p[1]]).reverse(), nS);
        P.pinEdge('top', 'chest'); panels.push(P);
      }
      seams.push([panels[0], 'sideR', panels[1], 'sideR', false], [panels[0], 'sideL', panels[1], 'sideL', false]);
      m = assemble(panels, seams, body, S); desc = name === 'gown' ? 'floor-length gown that pools on the floor' : 'strapless full-length dress: front + back panels with flared skirt, top edge pinned'; break;
    }
    case 'skirt': m = skirtPanels(waistY, kneeY - 0.05, qp(R.hipX + 0.012, R.hipZ + 0.012), qp(R.hipX + 0.012, R.hipZ + 0.012) + 0.28, 'hips'); desc = 'knee-length flared skirt (front + back panels)'; break;
    case 'longskirt': m = skirtPanels(waistY, 0.08, qp(R.hipX + 0.012, R.hipZ + 0.012), qp(R.hipX + 0.012, R.hipZ + 0.012) + 0.5, 'hips'); desc = 'ankle-length full skirt'; break;
    case 'shawl': {
      const xs = J.lShoulder[0] - 0.03, yS = shoulderY + 0.065, zf = R.torsoZ + 0.03, zb = -R.torsoZ - 0.03;
      const keys = [{ p: [0.2, 0.55, zf + 0.02], n: [0, 0, 1] }, { p: [0.19, 1.25, zf], n: [0, 0, 1] }, { p: [xs, yS, 0.02], n: [0, 1, 0] }, { p: [0.08, 1.47, zb], n: [0, 0, -1] },
        { p: [-0.08, 1.47, zb], n: [0, 0, -1] }, { p: [-xs, yS, 0.02], n: [0, 1, 0] }, { p: [-0.19, 1.25, zf], n: [0, 0, 1] }, { p: [-0.2, 0.55, zf + 0.02], n: [0, 0, 1] }];
      m = strip(keys, 0.42, S);
      // held at the shoulder tops (middle of the width)
      for (const v of [2 / 7, 5 / 7]) { const j = Math.round(v * (m.nv - 1)); for (const i of [Math.floor(m.nu / 2) - 1, Math.floor(m.nu / 2), Math.floor(m.nu / 2) + 1]) pin(m, m.at(i, j), 'chest', body); }
      desc = 'shawl over both shoulders, ends hanging down the front, held at the shoulders'; break;
    }
    case 'sash': {
      const rx = R.torsoX + 0.03, rz = R.torsoZ + 0.03;
      const keys = [{ p: [rx * 0.9, J.hips[1] - 0.02, rz * 0.5], n: [0.7, 0, 0.7] }, { p: [0, 1.22, rz + 0.01], n: [0, 0, 1] }, { p: [-0.11, 1.44, rz * 0.7], n: [-0.3, 0.4, 1] },
        { p: [-0.13, shoulderY + 0.07, 0], n: [-0.2, 1, 0] }, { p: [-0.11, 1.44, -rz * 0.7], n: [-0.3, 0.4, -1] }, { p: [0, 1.22, -rz - 0.01], n: [0, 0, -1] }, { p: [rx * 0.9, J.hips[1] - 0.02, -rz * 0.5], n: [0.7, 0, -0.7] }];
      m = strip(keys, 0.12, S);
      for (let i = 0; i < m.nu; i++) { pin(m, m.at(i, 0), 'hips', body); pin(m, m.at(i, m.nv - 1), 'hips', body); }
      const js = Math.round(0.5 * (m.nv - 1)); for (let i = 0; i < m.nu; i++) pin(m, m.at(i, js), 'chest', body);
      desc = 'sash from the left hip over the right shoulder and down the back, pinned at hips and shoulder'; break;
    }
    case 'cape': {
      const w = 0.6, len = 1.2; const nu = Math.round(w / S) + 1, nv = Math.round(len / S) + 1, rr = R.torsoZ + 0.02;
      m = grid(nu, nv, (u, v) => [(u - 0.5) * w, shoulderY + 0.05 - v * len, -rr - 0.02 - 0.1 * v], { uLen: w, vLen: len });
      for (let i = 0; i < nu; i += 2) pin(m, m.at(i, 0), 'chest', body);
      desc = 'cape pinned along the shoulders'; break;
    }
    case 'ribbon': {
      const w = 0.06, len = 1.0, s2 = 0.015; const nu = Math.round(w / s2) + 1, nv = Math.round(len / s2) + 1, h = J.rHand;
      m = grid(nu, nv, (u, v) => [h[0] + (u - 0.5) * w, h[1] - v * len, h[2] + 0.03], { uLen: w, vLen: len });
      for (let i = 0; i < nu; i++) pin(m, m.at(i, 0), 'rHand', body);
      desc = 'ribbon held in the right hand'; break;
    }
    default: throw new Error('unknown garment ' + name);
  }
  m.desc = desc;
  pushOutside(m, body);
  for (const p of m.pins) p.local = body.restInverse(p.bone)([m.positions[3*p.i], m.positions[3*p.i+1], m.positions[3*p.i+2]]); // anchors from the final placement
  return m;
}

// move vertices that start inside the body (rest pose) to just outside it, a few passes for overlapping capsules
function pushOutside(m, body, gap = 0.012) {
  const x = m.positions, C = body.capsules, n = x.length / 3;
  for (let pass = 0; pass < 4; pass++) for (let i = 0; i < n; i++) for (let c = 0; c < C.length; c += 7) {
    const ax = C[c], ay = C[c+1], az = C[c+2], bx = C[c+3]-ax, by = C[c+4]-ay, bz = C[c+5]-az, r = C[c+6] + gap;
    let t = ((x[3*i]-ax)*bx + (x[3*i+1]-ay)*by + (x[3*i+2]-az)*bz) / (bx*bx+by*by+bz*bz + 1e-12); t = Math.min(1, Math.max(0, t));
    const dx = x[3*i]-ax-bx*t, dy = x[3*i+1]-ay-by*t, dz = x[3*i+2]-az-bz*t, d = Math.hypot(dx, dy, dz);
    if (d < r && d > 1e-9) { const k = r / d; x[3*i] = ax + bx*t + dx*k; x[3*i+1] = ay + by*t + dy*k; x[3*i+2] = az + bz*t + dz*k; }
  }
}
