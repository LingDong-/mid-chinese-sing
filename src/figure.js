/* figure.js — a Tang-dynasty singer, built procedurally (no DOM; shared by stage.js, edit.js and tool/check.js).
   The shape is data: figure.json holds the body's SDF tree (groups with smooth-blend radius k; spheres, round cones,
   ellipsoids and a few named 'special' face primitives, each with a bone, weight falloff, material and L/R mirror
   partner), the face parameters, hair styles and costumes. The body is polygonized once at bind pose (narrow-band
   surface nets on a grid warped finer at face and hands), skinned with dual quaternions. Hair, garments and ornaments
   are separate parts, each with a declared parent. Tang's garments are sewn from flat panels and simulated by cloth_sim
   (XPBD, capsules fitted to her surface: GSim), Song's too (the older verlet Sim cloth stays for old files); the 步搖 bead chains are deterministic.

   FIG.build({def: figure.json})  → fig {sk, body, parts, cloths, chains, hair, …}
   FIG.perform(song, syls, {seed, fig}) → perf.controls(t): lip-sync, dance, gaze, blinks, breathing (stateless in t);
                                    perf.camera(t): the planned camera; with fig, limbs avoid each other and the torso
   new FIG.Sim(fig).advance(poseAt, t[, budgetMs])  steps the cloth (1/90 s steps)
   FIG.solve(sk, controls) → world bone transforms; FIG.poseDQ / FIG.skin as in the vertex shader
*/
(function (root) {
'use strict';
var PI = Math.PI, sqrt = Math.sqrt, abs = Math.abs, min = Math.min, max = Math.max, sin = Math.sin, cos = Math.cos, exp = Math.exp, floor = Math.floor, ceil = Math.ceil;

/* ================= math ================= */
function v3(x, y, z) { return [x, y, z]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function len(a) { return sqrt(dot(a, a)); }
function norm(a) { var l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function mirror(a) { return [-a[0], a[1], a[2]]; }
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function smooth(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
function mix(a, b, t) { return a + (b - a) * t; }
// quaternions [x,y,z,w]
function qaxis(ax, an) { var s = sin(an / 2), a = norm(ax); return [a[0] * s, a[1] * s, a[2] * s, cos(an / 2)]; }
function qmul(a, b) {
  return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}
function qconj(q) { return [-q[0], -q[1], -q[2], q[3]]; }
function qrot(q, v) {   // rotate v by unit quaternion q
  var x = q[0], y = q[1], z = q[2], w = q[3], tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx];
}
function qnorm(q) { var l = sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; }
function qslerp(a, b, t) {
  var d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3], s = 1;
  if (d < 0) { d = -d; s = -1; }
  if (d > 0.9995) return qnorm([a[0] + (s * b[0] - a[0]) * t, a[1] + (s * b[1] - a[1]) * t, a[2] + (s * b[2] - a[2]) * t, a[3] + (s * b[3] - a[3]) * t]);
  var th = Math.acos(d), k0 = sin((1 - t) * th) / sin(th), k1 = s * sin(t * th) / sin(th);
  return [a[0] * k0 + b[0] * k1, a[1] * k0 + b[1] * k1, a[2] * k0 + b[2] * k1, a[3] * k0 + b[3] * k1];
}
var QI = [0, 0, 0, 1];
// a rotation that takes unit vector a to unit vector b
function qfromto(a, b) {
  var c = cross(a, b), d = dot(a, b);
  if (d < -0.99999) { var o = abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; return qaxis(cross(a, o), PI); }
  return qnorm([c[0], c[1], c[2], 1 + d]);
}
// seeded random
function rng(seed) { var s = (seed >>> 0) || 1; return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function hash3(x, y, z) { var h = sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return h - floor(h); }
function vnoise(x, y, z) {   // smooth value noise in [-1,1]
  var ix = floor(x), iy = floor(y), iz = floor(z), fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  function h(a, b, c) { return hash3(ix + a, iy + b, iz + c); }
  var a = mix(mix(h(0, 0, 0), h(1, 0, 0), fx), mix(h(0, 1, 0), h(1, 1, 0), fx), fy), b = mix(mix(h(0, 0, 1), h(1, 0, 1), fx), mix(h(0, 1, 1), h(1, 1, 1), fx), fy);
  return mix(a, b, fz) * 2 - 1;
}

/* ================= SDF tree =================
   leaf: {f(x,y,z), c, r (bounding sphere), bone, sig}     node: {op, k, kids, c, r}
   compile() → function (x, y, z, cut): exact where the result < cut, otherwise a lower bound */
function smin(a, b, k) { if (k <= 0) return a < b ? a : b; var h = max(k - abs(a - b), 0) / k; return (a < b ? a : b) - h * h * k * 0.25; }
function smax(a, b, k) { return -smin(-a, -b, k); }
function Sph(c, r, bone) { var cx = c[0], cy = c[1], cz = c[2]; return { f: function (x, y, z) { x -= cx; y -= cy; z -= cz; return sqrt(x * x + y * y + z * z) - r; }, c: c, r: r, bone: bone, t: 0, prm: [], spec: { type: 'sphere', c: c.slice(), r: r } }; }
// a stable perpendicular to a direction (the default cross-section frame of a cone)
function perpOf(w) { return norm(cross(w, abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])); }
// generalized round cone: elliptical cross-section s = [sx, sy] along u and v = w × u (w = a→b), and per-end caps:
// cap 1 = hemispherical end (default), 0 = flat cut, 0..1 = flat end with its rim rounded by cap × r_end, > 1 = a
// bulged knob (a larger end ball, smoothly joined). Evaluated in the local frame; the section scaling multiplies the
// result by min(sx, sy, 1), which keeps it a lower bound of the true distance (safe for culling, smooth-min, tracing).
// With all defaults it is exactly the round cone below.
function interRound(a, b, r) { var ux = max(r + a, 0), uy = max(r + b, 0); return min(-r, max(a, b)) + sqrt(ux * ux + uy * uy); }   // rounded intersection
function ECone(a, b, ra, rb, s, u, capA, capB, bone) {
  var cA = capA == null ? 1 : capA, cB = capB == null ? 1 : capB, sx = s ? s[0] : 1, sy = s ? s[1] : 1;
  if (sx === 1 && sy === 1 && cA === 1 && cB === 1) { var c0 = Cone(a, b, ra, rb, bone); if (u) c0.spec.u = u.slice(); return c0; }
  var w = norm(sub(b, a)), uu = u ? norm(sub(u, mul(w, dot(u, w)))) : perpOf(w), vv = cross(w, uu), L = len(sub(b, a)), k = min(sx, sy, 1);
  var rc = Cone([0, 0, 0], [0, 0, L], ra, rb).f, ax = a[0], ay = a[1], az = a[2];
  function inner(x, y, z) {
    var d = rc(x, y, z);
    if (cA < 1) d = interRound(d, -z, cA * ra); else if (cA > 1) d = smin(d, sqrt(x * x + y * y + z * z) - ra * cA, ra * 0.4);
    if (cB < 1) d = interRound(d, z - L, cB * rb); else if (cB > 1) d = smin(d, sqrt(x * x + y * y + (z - L) * (z - L)) - rb * cB, rb * 0.4);
    return d;
  }
  var f = function (x, y, z) { x -= ax; y -= ay; z -= az; return inner((x * uu[0] + y * uu[1] + z * uu[2]) / sx, (x * vv[0] + y * vv[1] + z * vv[2]) / sy, x * w[0] + y * w[1] + z * w[2]) * k; };
  var spec = { type: 'cone', a: a.slice(), b: b.slice(), ra: ra, rb: rb, u: uu.slice() };
  if (sx !== 1 || sy !== 1) spec.s = [sx, sy]; if (cA !== 1) spec.capA = cA; if (cB !== 1) spec.capB = cB;
  return { f: f, c: lerp3(a, b, 0.5), r: L / 2 + max(ra * max(cA, 1), rb * max(cB, 1)) * max(sx, sy, 1), bone: bone, spec: spec };
}
// shell: a hollow ellipsoid of mid-radii r and thickness t (the eyelids); exact for a sphere shell
function Shell(c, r, t, u, v, bone) {
  var rr = Array.isArray(r) ? r : [r, r, r], cx = c[0], cy = c[1], cz = c[2], h = t / 2, f, sph = rr[0] === rr[1] && rr[1] === rr[2] && (!u || (u[0] === 1 && !u[1] && !u[2])) && (!v || (v[1] === 1 && !v[0] && !v[2]));
  if (sph) { var rm = rr[0]; f = function (x, y, z) { x -= cx; y -= cy; z -= cz; return abs(sqrt(x * x + y * y + z * z) - rm) - h; }; }
  else { var E = Ell(c, rr, u, v), k = min(rr[0], rr[1], rr[2]) / max(rr[0], rr[1], rr[2]); f = function (x, y, z) { return abs(E.f(x, y, z)) * k - h; }; }
  return { f: f, c: c, r: max(rr[0], rr[1], rr[2]) + h, bone: bone, spec: { type: 'shell', c: c.slice(), r: rr.slice(), t: t, u: (u || [1, 0, 0]).slice(), v: (v || [0, 1, 0]).slice() } };
}
function Cone(a, b, ra, rb, bone) {   // round cone (capsule with two radii), exact
  var ax = a[0], ay = a[1], az = a[2], bx = b[0] - ax, by = b[1] - ay, bz = b[2] - az, l2 = bx * bx + by * by + bz * bz, rr = ra - rb, a2 = l2 - rr * rr, il2 = 1 / l2;
  var f = function (x, y, z) {
    var px = x - ax, py = y - ay, pz = z - az, pb = px * bx + py * by + pz * bz;
    var qx = px * l2 - bx * pb, qy = py * l2 - by * pb, qz = pz * l2 - bz * pb, x2 = qx * qx + qy * qy + qz * qz, yy = pb - l2, y2 = yy * yy * l2, z2 = pb * pb * l2;
    var k = (rr > 0 ? 1 : -1) * rr * rr * x2;
    if ((yy > 0 ? 1 : -1) * a2 * y2 > k) return sqrt(x2 + y2) * il2 - rb;
    if ((pb > 0 ? 1 : -1) * a2 * z2 < k) return sqrt(x2 + z2) * il2 - ra;
    return (sqrt(x2 * a2 * il2) + pb * rr) * il2 - ra;
  };
  return { f: f, c: lerp3(a, b, 0.5), r: sqrt(l2) / 2 + max(ra, rb), bone: bone, t: 1, prm: [ax, ay, az, bx, by, bz, l2, rr, a2, il2, ra, rb], spec: { type: 'cone', a: a.slice(), b: b.slice(), ra: ra, rb: rb } };
}
// ellipsoid with radii r along axes (u, v, w) (orthonormal; default world axes); iq's bound-ish approximation
function Ell(c, r, u, v, bone) {
  u = u ? norm(u) : [1, 0, 0]; v = v ? norm(sub(v, mul(u, dot(v, u)))) : [0, 1, 0]; var w = cross(u, v);
  var cx = c[0], cy = c[1], cz = c[2], ux = u[0] / r[0], uy = u[1] / r[0], uz = u[2] / r[0], vx = v[0] / r[1], vy = v[1] / r[1], vz = v[2] / r[1], wx = w[0] / r[2], wy = w[1] / r[2], wz = w[2] / r[2];
  var f = function (x, y, z) {
    x -= cx; y -= cy; z -= cz;
    var a = x * ux + y * uy + z * uz, b = x * vx + y * vy + z * vz, d = x * wx + y * wy + z * wz, k0 = sqrt(a * a + b * b + d * d);
    var k1 = sqrt(a * a / (r[0] * r[0]) + b * b / (r[1] * r[1]) + d * d / (r[2] * r[2]));
    return k1 > 1e-9 ? k0 * (k0 - 1) / k1 : -min(r[0], r[1], r[2]);
  };
  return { f: f, c: c, r: max(r[0], r[1], r[2]), bone: bone, t: 2, prm: [cx, cy, cz, ux, uy, uz, vx, vy, vz, wx, wy, wz, 1 / r[0], 1 / r[1], 1 / r[2], min(r[0], r[1], r[2])], spec: { type: 'ellipsoid', c: c.slice(), r: r.slice(), u: u.slice(), v: v.slice() } };
}
// a chain of round cones through points with radii (for lips, brows, helix…)
function Chain(pts, rad, bone) { var ks = []; for (var i = 0; i + 1 < pts.length; i++) ks.push(Cone(pts[i], pts[i + 1], rad[i], rad[i + 1], bone)); return U(0, ks); }
function Fn(f, c, r, bone) { return { f: f, c: c, r: r, bone: bone }; }
function U(k, kids) { return { op: 'u', k: k, kids: kids.filter(Boolean) }; }
function Sub(k, a, b) { return { op: 's', k: k, kids: [a, b] }; }
function Int(k, a, b) { return { op: 'i', k: k, kids: [a, b] }; }
function bounds(n) {   // bounding spheres (leaves have them)
  if (!n.op) return n;
  n.kids.forEach(bounds);
  if (n.op === 'u') {
    var lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    n.kids.forEach(function (k) { for (var i = 0; i < 3; i++) { lo[i] = min(lo[i], k.c[i] - k.r); hi[i] = max(hi[i], k.c[i] + k.r); } });
    n.c = lerp3(lo, hi, 0.5); n.r = 0;
    n.kids.forEach(function (k) { n.r = max(n.r, len(sub(k.c, n.c)) + k.r); });
    n.r += n.k;
  } else { n.c = n.kids[0].c; n.r = n.kids[0].r + n.k; }
  return n;
}
function compile(n) { return (n.flat || (n.flat = Flat(n))).full; }
/* flat interpreter: the tree in typed arrays, one monomorphic recursive evaluator. Pruning (per ball) only
   replaces the child lists, so a block of the polygonizer evaluates just the primitives that can matter there. */
function Flat(tree) {
  var nodes = [];
  (function walk(n) { n.fi = nodes.length; nodes.push(n); if (n.op) n.kids.forEach(walk); })(tree);
  var N = nodes.length, T = new Int8Array(N), K = new Float64Array(N), C = new Float64Array(N * 4), PO = new Int32Array(N), prm = [], FN = [], KS0 = [];
  var KO0 = new Int32Array(N), KC0 = new Int32Array(N);
  nodes.forEach(function (n, i) {
    C[i * 4] = n.c[0]; C[i * 4 + 1] = n.c[1]; C[i * 4 + 2] = n.c[2]; C[i * 4 + 3] = n.r;
    if (n.op) { T[i] = n.op === 'u' ? 10 : n.op === 's' ? 11 : 12; K[i] = n.k; KO0[i] = KS0.length; KC0[i] = n.kids.length; n.kids.forEach(function (k) { KS0.push(k.fi); }); return; }
    T[i] = n.t == null ? 3 : n.t; PO[i] = T[i] === 3 ? FN.length : prm.length;
    if (T[i] === 3) FN.push(n.f); else prm.push.apply(prm, n.prm);
  });
  var P = new Float64Array(prm), KS = new Int32Array(KS0), KO = KO0, KC = KC0, KS00 = KS;
  function ev(i, x, y, z, cut) {
    var o = i * 4, dx = x - C[o], dy = y - C[o + 1], dz = z - C[o + 2], db = Math.sqrt(dx * dx + dy * dy + dz * dz) - C[o + 3];
    if (db > cut) return db;
    var t = T[i], q = PO[i];
    if (t === 10) {
      var k = K[i], s = KO[i], m = KC[i], d = ev(KS[s], x, y, z, cut + k);
      for (var j = 1; j < m; j++) { var e = ev(KS[s + j], x, y, z, (d < cut + k ? d : cut + k) + k), hh = k - Math.abs(d - e); d = (d < e ? d : e) - (hh > 0 ? hh * hh * 0.25 / k : 0); }
      return d;
    }
    if (t === 11 || t === 12) {
      var k2 = K[i], s2 = KO[i], a = ev(KS[s2], x, y, z, cut);
      if (a > cut + k2) return a;
      var b = ev(KS[s2 + 1], x, y, z, t === 11 ? k2 - a : cut + k2); if (t === 11) b = -b;
      var h2 = k2 - Math.abs(a - b); return (a > b ? a : b) + (h2 > 0 ? h2 * h2 * 0.25 / k2 : 0);
    }
    if (t === 0) return db;
    if (t === 1) {   // round cone
      var px = x - P[q], py = y - P[q + 1], pz = z - P[q + 2], bx = P[q + 3], by = P[q + 4], bz = P[q + 5], l2 = P[q + 6], rr = P[q + 7], a2 = P[q + 8], il2 = P[q + 9];
      var pb = px * bx + py * by + pz * bz, qx = px * l2 - bx * pb, qy = py * l2 - by * pb, qz = pz * l2 - bz * pb, x2 = qx * qx + qy * qy + qz * qz, yy = pb - l2, y2 = yy * yy * l2, z2 = pb * pb * l2;
      var kk = (rr > 0 ? 1 : -1) * rr * rr * x2;
      if ((yy > 0 ? 1 : -1) * a2 * y2 > kk) return Math.sqrt(x2 + y2) * il2 - P[q + 11];
      if ((pb > 0 ? 1 : -1) * a2 * z2 < kk) return Math.sqrt(x2 + z2) * il2 - P[q + 10];
      return (Math.sqrt(x2 * a2 * il2) + pb * rr) * il2 - P[q + 10];
    }
    if (t === 2) {   // ellipsoid
      var ex = x - P[q], ey = y - P[q + 1], ez = z - P[q + 2];
      var u = ex * P[q + 3] + ey * P[q + 4] + ez * P[q + 5], v = ex * P[q + 6] + ey * P[q + 7] + ez * P[q + 8], w = ex * P[q + 9] + ey * P[q + 10] + ez * P[q + 11];
      var k0 = Math.sqrt(u * u + v * v + w * w), u2 = u * P[q + 12], v2 = v * P[q + 13], w2 = w * P[q + 14], k1 = Math.sqrt(u2 * u2 + v2 * v2 + w2 * w2);
      return k1 > 1e-9 ? k0 * (k0 - 1) / k1 : -P[q + 15];
    }
    return FN[q](x, y, z);
  }
  var root = tree.fi;
  function full(x, y, z, cut) { KO = KO0; KC = KC0; KS = KS00; return ev(root, x, y, z, cut); }
  function prune(c, R) {   // returns an evaluator specialized to the ball
    var x = c[0], y = c[1], z = c[2], R2 = R * 1.6 + 1e-4, ko = new Int32Array(N), kc = new Int32Array(N), ks = [];
    function exact(i, cut) { KO = KO0; KC = KC0; KS = KS00; return ev(i, x, y, z, cut); }
    function pr(i) {   // returns the node index to use
      var t = T[i]; if (t < 10) return i;
      var s = KO0[i], m = KC0[i];
      if (t === 10) {
        var lb = [], ds = [], order = [], ub = 1e9, j;
        for (j = 0; j < m; j++) { var c2 = KS00[s + j] * 4; lb.push(Math.sqrt(sq(x - C[c2]) + sq(y - C[c2 + 1]) + sq(z - C[c2 + 2])) - C[c2 + 3]); ds.push(lb[j]); order.push(j); }
        order.sort(function (a, b) { return lb[a] - lb[b]; });
        for (j = 0; j < m; j++) { var o2 = order[j]; if (lb[o2] - R2 > ub + K[i]) continue; ds[o2] = exact(KS00[s + o2], ub + K[i] + 2 * R2); ub = Math.min(ub, ds[o2] + R2); }
        var keep = []; for (j = 0; j < m; j++) if (ds[j] - R2 <= ub + K[i]) keep.push(pr(KS00[s + j]));
        if (keep.length === 1) return keep[0];
        ko[i] = ks.length; kc[i] = keep.length; keep.forEach(function (q) { ks.push(q); }); return i;
      }
      var a = exact(KS00[s], 1e9), b = exact(KS00[s + 1], K[i] - a + 3 * R2);
      if (t === 11 && b - R2 > K[i] - a + R2) return pr(KS00[s]);
      var ka = pr(KS00[s]), kb = pr(KS00[s + 1]); ko[i] = ks.length; kc[i] = 2; ks.push(ka, kb); return i;
    }
    var r = pr(root), KSp = new Int32Array(ks);
    return function (x, y, z, cut) { KO = ko; KC = kc; KS = KSp; return ev(r, x, y, z, cut); };
  }
  return { full: full, prune: prune };
}
function prune(n, c, R) { return (n.flat || (n.flat = Flat(n))).prune(c, R); }
function leaves(n, out) { out = out || []; if (!n.op) out.push(n); else if (n.op === 'u') n.kids.forEach(function (k) { leaves(k, out); }); else leaves(n.kids[0], out); return out; }

/* ================= polygonizer =================
   Narrow-band surface nets: hierarchical block activation (SDF is ~1-Lipschitz), samples only near the surface,
   vertices Newton-projected onto the true surface, normals from the SDF gradient. Different resolutions for
   body / head / hands are joined by clipping each along a plane and zipping the boundary loops (see zip). */
// Grid warp: inside a zone (center c, physical radius R0) the grid is m× finer; it relaxes back to identity by
// u-radius Ru1 (coarser in between: radial slope g ≤ gmax). Identity outside, so zones compose freely.
function Zone(c, R0, m, L) {
  var Ru0 = R0 * m, Ru1 = Ru0 + L, A = 1.5 * (1 - 1 / m) * (0.5 + Ru0 / L), gmax = 1 / m + (1 - 1 / m) * 0.5 + A;
  function phi(r) { if (r <= Ru0) return r / m; if (r >= Ru1) return r; var t = (r - Ru0) / L; return Ru0 / m + L * (t / m + (1 - 1 / m) * t * t / 2 + A * (2 * t * t - 4 * t * t * t / 3)); }
  return { c: c, Ru1: Ru1, gmax: gmax, m: m, map: function (x, y, z, out) {
    var dx = x - c[0], dy = y - c[1], dz = z - c[2], r = sqrt(dx * dx + dy * dy + dz * dz);
    if (r >= Ru1 || r < 1e-12) { out[0] = x; out[1] = y; out[2] = z; out[3] = 1; return; }
    var f = phi(r) / r; out[0] = c[0] + dx * f; out[1] = c[1] + dy * f; out[2] = c[2] + dz * f; out[3] = r <= Ru0 ? 1 / m : f;
  } };
}
function Warp(zones) {
  var t = [0, 0, 0, 1];
  return { zones: zones, lip: max.apply(null, zones.map(function (z) { return z.gmax; }).concat([1])), fwd: function (x, y, z) {
    var sc = 1; for (var i = 0; i < zones.length; i++) { zones[i].map(x, y, z, t); x = t[0]; y = t[1]; z = t[2]; sc *= t[3]; } return [x, y, z, sc];
  }, near: function (x, y, z) { for (var i = 0; i < zones.length; i++) { var c = zones[i].c; if (sq(x - c[0]) + sq(y - c[1]) + sq(z - c[2]) < sq(zones[i].Ru1 + 0.02)) return true; } return false; } };
}
function polygonize(tree, lo, hi, h, o) {
  o = o || {};
  var FL = tree.flat || (tree.flat = Flat(tree)), sdf = FL.full, ulo = [lo[0] - 2 * h, lo[1] - 2 * h, lo[2] - 2 * h], uhi = [hi[0] + 2 * h, hi[1] + 2 * h, hi[2] + 2 * h], i;
  var W = o.warp || { lip: 1, zones: [], fwd: function (x, y, z) { return [x, y, z, 1]; }, near: function () { return false; } };
  W.zones.forEach(function (z) { for (var i = 0; i < 3; i++) { ulo[i] = min(ulo[i], z.c[i] - z.Ru1 - 2 * h); uhi[i] = max(uhi[i], z.c[i] + z.Ru1 + 2 * h); } });
  var B = o.B || 4, nb = [0, 1, 2].map(function (i) { return Math.ceil((uhi[i] - ulo[i]) / (h * B)); }), N = nb.map(function (n) { return n * B + 1; });
  function WP(i, j, k) { return W.fwd(ulo[0] + i * h, ulo[1] + j * h, ulo[2] + k * h); }
  function F(i, j, k, cut) { var p = WP(i, j, k); return sdf(p[0], p[1], p[2], cut); }
  function physR(ci, cj, ck, hs) {   // physical radius of the image of a (small) u-cube: from its mapped corners
    var c = WP(ci, cj, ck), r = 0;
    for (var q = 0; q < 8; q++) { var p = WP(ci + (q & 1 ? hs : -hs), cj + (q & 2 ? hs : -hs), ck + (q & 4 ? hs : -hs)); r = max(r, sqrt(sq(p[0] - c[0]) + sq(p[1] - c[1]) + sq(p[2] - c[2]))); }
    return r * 1.15;
  }
  // 1) active blocks: hierarchical test from coarse super-blocks (margin for approximate distances)
  var active = [], halfB = h * B * 0.866;
  (function rec(i0, j0, k0, s) {
    if (i0 >= nb[0] || j0 >= nb[1] || k0 >= nb[2]) return;
    var ci = (i0 + s / 2) * B, cj = (j0 + s / 2) * B, ck = (k0 + s / 2) * B, d = F(ci, cj, ck, 1e9), rad = halfB * s * 1.25 + 1.5 * h;
    if (W.near(ulo[0] + ci * h, ulo[1] + cj * h, ulo[2] + ck * h)) rad = s > 2 ? rad * W.lip : physR(ci, cj, ck, s * B / 2) * 1.2 + 1.5 * h * WP(ci, cj, ck)[3];
    if (abs(d) > rad) return;
    if (s === 1) { active.push([i0, j0, k0]); return; }
    var hs = s / 2; for (var c2 = 0; c2 < 8; c2++) rec(i0 + (c2 & 1) * hs, j0 + (c2 >> 1 & 1) * hs, k0 + (c2 >> 2) * hs, hs);
  })(0, 0, 0, 1 << Math.ceil(Math.log2(max(nb[0], nb[1], nb[2]))));
  // 2) per block: pruned sdf, corner samples, vertices (projected), attributes
  var S = B + 1, cellV = new Map(), P = [], Nn = [], X = [], blocks = [], e1 = 1e-4, ie4 = 1 / (4 * e1);
  active.forEach(function (b) {
    var i0 = b[0] * B, j0 = b[1] * B, k0 = b[2] * B, bc4 = WP(i0 + B / 2, j0 + B / 2, k0 + B / 2), bc = [bc4[0], bc4[1], bc4[2]], zoned = W.near(bc[0], bc[1], bc[2]);
    var br = zoned ? physR(i0 + B / 2, j0 + B / 2, k0 + B / 2, B / 2) : halfB, f = prune(tree, bc, br + 2 * h * (zoned ? bc4[3] : 1)), vals = new Float32Array(S * S * S), pos = 0, neg = 0;
    for (var k = 0; k < S; k++) for (var j = 0; j < S; j++) for (var i = 0; i < S; i++) { var wp = WP(i0 + i, j0 + j, k0 + k), v = f(wp[0], wp[1], wp[2], 2 * h); vals[i + S * (j + S * k)] = v; if (v < 0) neg++; else pos++; }
    if (!neg || !pos) return;
    blocks.push({ b: b, vals: vals });
    var grad = function (x, y, z) {
      var a = f(x + e1, y - e1, z - e1, 1), bb = f(x - e1, y - e1, z + e1, 1), c2 = f(x - e1, y + e1, z - e1, 1), d = f(x + e1, y + e1, z + e1, 1);
      return [(a - bb - c2 + d) * ie4, (-a - bb + c2 + d) * ie4, (-a + bb - c2 + d) * ie4];
    };
    var fb = o.attr ? FL.prune(bc, br + (o.attrR || 0.05)) : null;
    for (k = 0; k < B; k++) for (j = 0; j < B; j++) for (i = 0; i < B; i++) {
      var m = 0, cs = CS;
      for (var c3 = 0; c3 < 8; c3++) { var vv = vals[(i + (c3 & 1)) + S * ((j + (c3 >> 1 & 1)) + S * (k + (c3 >> 2)))]; cs[c3] = vv; if (vv < 0) m |= 1 << c3; }
      if (m === 0 || m === 255) continue;
      var sx = 0, sy = 0, sz = 0, ne = 0;
      for (var e = 0; e < 12; e++) {
        var a = EDGE[e][0], bb = EDGE[e][1];
        if ((cs[a] < 0) === (cs[bb] < 0)) continue;
        var t = cs[a] / (cs[a] - cs[bb]);
        sx += (a & 1) + ((bb & 1) - (a & 1)) * t; sy += (a >> 1 & 1) + ((bb >> 1 & 1) - (a >> 1 & 1)) * t; sz += (a >> 2) + ((bb >> 2) - (a >> 2)) * t; ne++;
      }
      var gi = i0 + i, gj = j0 + j, gk = k0 + k;
      cellV.set(gi + N[0] * (gj + N[1] * gk), P.length / 3);
      var wv = W.fwd(ulo[0] + (gi + sx / ne) * h, ulo[1] + (gj + sy / ne) * h, ulo[2] + (gk + sz / ne) * h), x = wv[0], y = wv[1], z = wv[2], x0 = x, y0 = y, z0 = z;
      var d0 = f(x, y, z, 1), g = grad(x, y, z), gl = dot(g, g);
      if (gl > 1e-20) { x -= d0 * g[0] / gl; y -= d0 * g[1] / gl; z -= d0 * g[2] / gl; }
      var dx = x - x0, dy = y - y0, dz = z - z0, dl = sqrt(dx * dx + dy * dy + dz * dz), lim = h * 0.7 * wv[3];
      if (dl > lim) { x = x0 + dx * lim / dl; y = y0 + dy * lim / dl; z = z0 + dz * lim / dl; }
      var n = norm(grad(x, y, z));
      P.push(x, y, z); Nn.push(n[0], n[1], n[2]);
      if (fb) X.push(o.attr(fb, x, y, z, n, zoned));
    }
  });
  // 3) quads across sign-changing edges (edge from corner (i,j,k) along each axis, owned by its block)
  var idx = [], holes = 0;
  function cv(i, j, k) { var r = cellV.get(i + N[0] * (j + N[1] * k)); return r === undefined ? -1 : r; }
  blocks.forEach(function (bl) {
    var b = bl.b, vals = bl.vals, i0 = b[0] * B, j0 = b[1] * B, k0 = b[2] * B;
    for (var k = 0; k < B; k++) for (var j = 0; j < B; j++) for (var i = 0; i < B; i++) {
      var v0 = vals[i + S * (j + S * k)], gi = i0 + i, gj = j0 + j, gk = k0 + k;
      for (var ax = 0; ax < 3; ax++) {
        var v1 = vals[(i + (ax === 0)) + S * ((j + (ax === 1)) + S * (k + (ax === 2)))];
        if ((v0 < 0) === (v1 < 0)) continue;
        var q;
        if (ax === 0) q = [cv(gi, gj - 1, gk - 1), cv(gi, gj, gk - 1), cv(gi, gj, gk), cv(gi, gj - 1, gk)];
        else if (ax === 1) q = [cv(gi - 1, gj, gk - 1), cv(gi - 1, gj, gk), cv(gi, gj, gk), cv(gi, gj, gk - 1)];
        else q = [cv(gi - 1, gj - 1, gk), cv(gi, gj - 1, gk), cv(gi, gj, gk), cv(gi - 1, gj, gk)];
        if (q[0] < 0 || q[1] < 0 || q[2] < 0 || q[3] < 0) { holes++; continue; }
        if (v0 >= 0) q.reverse();
        idx.push(q);
      }
    }
  });
  P = new Float32Array(P);
  var T = new Uint32Array(idx.length * 6), ti = 0;
  function d2(a, b) { var x = P[a * 3] - P[b * 3], y = P[a * 3 + 1] - P[b * 3 + 1], z = P[a * 3 + 2] - P[b * 3 + 2]; return x * x + y * y + z * z; }
  idx.forEach(function (q) {
    if (d2(q[0], q[2]) < d2(q[1], q[3])) { T[ti++] = q[0]; T[ti++] = q[1]; T[ti++] = q[2]; T[ti++] = q[0]; T[ti++] = q[2]; T[ti++] = q[3]; }
    else { T[ti++] = q[0]; T[ti++] = q[1]; T[ti++] = q[3]; T[ti++] = q[1]; T[ti++] = q[2]; T[ti++] = q[3]; }
  });
  var out = { pos: P, nrm: new Float32Array(Nn), idx: T, holes: holes };
  if (o.attr) { var w = X.length ? X[0].length : 0, A2 = new Float32Array(X.length * w); X.forEach(function (x, i) { A2.set(x, i * w); }); out.attr = A2; out.attrW = w; }
  return out;
}
var CS = new Float64Array(8);
var EDGE = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

// mesh utilities
function components(nv, idx) {   // union-find over triangles → component id per vertex
  var p = new Int32Array(nv); for (var i = 0; i < nv; i++) p[i] = i;
  function f(x) { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; }
  for (i = 0; i < idx.length; i += 3) { var a = f(idx[i]), b = f(idx[i + 1]), c = f(idx[i + 2]); p[b] = a; p[f(c)] = a; }
  var lab = new Int32Array(nv), m = new Map(), n = 0;
  for (i = 0; i < nv; i++) { var r = f(i); if (!m.has(r)) m.set(r, n++); lab[i] = m.get(r); }
  return { label: lab, count: n };
}
/* seal a polygonized surface: fill small boundary loops (surface-nets misses in thin creases) with a fan around a new
   vertex projected onto the SDF, and drop small detached components (sealed internal cavities, e.g. a cut that never
   reaches the surface), so the body stays one closed mesh. */
function sealMesh(m, F, log) {
  var P = Array.from(m.pos), N = Array.from(m.nrm), w = m.attrW || 0, A2 = w ? Array.from(m.attr) : null, I = Array.from(m.idx), filled = 0;
  boundaryLoops(m).forEach(function (L) {
    if (L.length < 3 || L.length > 40) return;
    var c = [0, 0, 0], at = []; for (var k = 0; k < w; k++) at.push(0);
    L.forEach(function (v) { for (var k2 = 0; k2 < 3; k2++) c[k2] += P[v * 3 + k2] / L.length; for (k2 = 0; k2 < w; k2++) at[k2] += A2[v * w + k2] / L.length; });
    for (var it = 0; it < 4; it++) { var g = sdfGrad(F, c), d = F(c[0], c[1], c[2], 1); c = sub(c, mul(g, d)); }
    var n = sdfGrad(F, c), vi = P.length / 3; P.push(c[0], c[1], c[2]); N.push(n[0], n[1], n[2]); if (w) A2.push.apply(A2, at);
    for (var i = 0; i < L.length; i++) I.push(L[(i + 1) % L.length], L[i], vi);
    filled++;
  });
  var nv = P.length / 3, cc = components(nv, I), cnt = new Int32Array(cc.count), keep = new Int32Array(nv).fill(-1), n2 = 0, dropped = [];
  for (var v = 0; v < nv; v++) cnt[cc.label[v]]++;
  var big = 0; for (var q = 1; q < cc.count; q++) if (cnt[q] > cnt[big]) big = q;
  for (q = 0; q < cc.count; q++) if (q !== big && cnt[q] < nv * 0.01) dropped.push(cnt[q]);
  for (v = 0; v < nv; v++) if (cc.label[v] === big || cnt[cc.label[v]] >= nv * 0.01) keep[v] = n2++;
  var out = { pos: new Float32Array(n2 * 3), nrm: new Float32Array(n2 * 3), idx: [], attrW: w, attr: w ? new Float32Array(n2 * w) : undefined, holes: m.holes };
  for (v = 0; v < nv; v++) if (keep[v] >= 0) { for (var k3 = 0; k3 < 3; k3++) { out.pos[keep[v] * 3 + k3] = P[v * 3 + k3]; out.nrm[keep[v] * 3 + k3] = N[v * 3 + k3]; } for (k3 = 0; k3 < w; k3++) out.attr[keep[v] * w + k3] = A2[v * w + k3]; }
  for (var t = 0; t < I.length; t += 3) if (keep[I[t]] >= 0) out.idx.push(keep[I[t]], keep[I[t + 1]], keep[I[t + 2]]);
  out.idx = new Uint32Array(out.idx);
  if (log && (filled || dropped.length)) log('body: sealed ' + filled + ' small hole(s), dropped ' + dropped.length + ' detached piece(s) (' + dropped.join(', ') + ' verts)');
  return out;
}
function neighbors(nv, idx) {   // CSR adjacency
  var deg = new Int32Array(nv + 1);
  for (var i = 0; i < idx.length; i += 3) for (var e = 0; e < 3; e++) { deg[idx[i + e] + 1] += 2; }
  for (i = 0; i < nv; i++) deg[i + 1] += deg[i];
  var adj = new Int32Array(deg[nv]), fill = deg.slice(0, nv);
  for (i = 0; i < idx.length; i += 3) for (e = 0; e < 3; e++) { var a = idx[i + e], b = idx[i + (e + 1) % 3]; adj[fill[a]++] = b; adj[fill[b]++] = a; }
  return { off: deg, adj: adj };
}

// keep triangles whose centroid passes keep(x,y,z); compact vertices
function filterMesh(m, keep) {
  var nv = m.pos.length / 3, P = m.pos, map = new Int32Array(nv).fill(-1), T = [], n = 0;
  for (var i = 0; i < m.idx.length; i += 3) {
    var a = m.idx[i], b = m.idx[i + 1], c = m.idx[i + 2];
    if (!keep((P[a * 3] + P[b * 3] + P[c * 3]) / 3, (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3, (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3)) continue;
    T.push(a, b, c);
  }
  T.forEach(function (v) { if (map[v] < 0) map[v] = n++; });
  var pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), w = m.attrW || 0, at = w ? new Float32Array(n * w) : null;
  for (i = 0; i < nv; i++) if (map[i] >= 0) { for (var k = 0; k < 3; k++) { pos[map[i] * 3 + k] = P[i * 3 + k]; nrm[map[i] * 3 + k] = m.nrm[i * 3 + k]; } for (k = 0; k < w; k++) at[map[i] * w + k] = m.attr[i * w + k]; }
  return { pos: pos, nrm: nrm, idx: new Uint32Array(T.map(function (v) { return map[v]; })), attr: at, attrW: w };
}
function concatMeshes(ms) {
  var nv = 0, ni = 0; ms.forEach(function (m) { nv += m.pos.length / 3; ni += m.idx.length; });
  var pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), idx = new Uint32Array(ni), o = 0, oi = 0, offs = [], w = ms[0].attrW || 0, at = w ? new Float32Array(nv * w) : null;
  ms.forEach(function (m) { offs.push(o); pos.set(m.pos, o * 3); nrm.set(m.nrm, o * 3); if (w) at.set(m.attr, o * w); for (var i = 0; i < m.idx.length; i++) idx[oi++] = m.idx[i] + o; o += m.pos.length / 3; });
  return { pos: pos, nrm: nrm, idx: idx, offs: offs, attr: at, attrW: w };
}
// boundary loops: directed edges without a twin, chained
function boundaryLoops(m) {
  var E = new Map(), nv = m.pos.length / 3;
  for (var i = 0; i < m.idx.length; i += 3) for (var e = 0; e < 3; e++) { var a = m.idx[i + e], b = m.idx[i + (e + 1) % 3]; E.set(a * nv + b, [a, b]); }
  var nxt = new Map();
  E.forEach(function (ab) { if (!E.has(ab[1] * nv + ab[0])) nxt.set(ab[0], ab[1]); });
  var seen = new Set(), loops = [];
  nxt.forEach(function (b, a) {
    if (seen.has(a)) return;
    var L = [], v = a, guard = 0;
    while (!seen.has(v) && nxt.has(v) && guard++ < 1e6) { seen.add(v); L.push(v); v = nxt.get(v); }
    loops.push(L);
  });
  return loops;
}
/* ================= skeleton =================
   Bind frames are world-aligned (identity rotation), so local rotations are authored with world-space axes at bind.
   Her left = +x, up = +y, she faces +z. Meters. */
function Skeleton(def) {
  var B = [], by = {};
  function bone(name, parent, p) { var b = { name: name, parent: parent == null ? -1 : by[parent], p: p, i: B.length }; B.push(b); by[name] = b.i; return b; }
  bone('root', null, [0, 0.95, 0]);
  bone('spine', 'root', [0, 1.03, -0.005]);
  bone('spine2', 'spine', [0, 1.13, -0.01]);
  bone('chest', 'spine2', [0, 1.24, -0.015]);
  bone('neck', 'chest', [0, 1.375, -0.022]);
  bone('head', 'neck', [0, 1.455, -0.012]);
  var O = [0, 1.49, 0], hl = function (x, y, z) { return [O[0] + x, O[1] + y, O[2] + z]; };
  bone('jaw', 'head', hl(0, -0.012, 0.008));
  bone('tongue', 'jaw', hl(0, -0.05, 0.06));
  bone('lipL', 'jaw', hl(0, -0.065, 0.0935));
  bone('lipU', 'head', hl(0, -0.055, 0.0955));
  [1, -1].forEach(function (s) {
    var S = s > 0 ? 'L' : 'R';
    bone('corner' + S, 'head', hl(0.0205 * s, -0.061, 0.0885));
    bone('cheek' + S, 'head', hl(0.038 * s, -0.03, 0.075));
    bone('brow' + S, 'head', hl(0.03 * s, 0.026, 0.082));
    bone('eye' + S, 'head', hl(EYE_C[0] * s, EYE_C[1], EYE_C[2]));
    bone('lidU' + S, 'head', hl(EYE_C[0] * s, EYE_C[1], EYE_C[2]));
    bone('lidD' + S, 'head', hl(EYE_C[0] * s, EYE_C[1], EYE_C[2]));
  });
  var arms = {};
  [1, -1].forEach(function (s) {
    var S = s > 0 ? 'L' : 'R', M = function (p) { return [p[0] * s, p[1], p[2]]; };
    var Sh = [0.163, 1.322, -0.015], dU = norm([0.7071, -0.7071, 0]), E = add(Sh, mul(dU, 0.272)), dF = norm([0.68, -0.70, 0.2]), Wr = add(E, mul(dF, 0.235));
    bone('clav' + S, 'chest', M([0.018, 1.35, 0.012]));
    bone('arm' + S, 'clav' + S, M(Sh));
    bone('fore' + S, 'arm' + S, M(E));
    bone('hand' + S, 'fore' + S, M(Wr));
    // hand frame: a = finger direction, n = palm normal, t = thumb side
    var a = dF, n = norm(sub([-0.7071, -0.7071, 0], mul(dF, dot([-0.7071, -0.7071, 0], dF)))), t = norm(cross(a, n)); if (t[2] < 0) t = mul(t, -1);
    var H = { W: Wr, a: a, n: n, t: t };
    H.L = function (u, v, w) { return add(Wr, add(mul(a, u), add(mul(t, v), mul(n, w)))); };
    var fingers = [], F = [['index', 0.093, 0.024, 6, [0.040, 0.024, 0.021], [0.0083, 0.0073, 0.0064, 0.0054]],
      ['middle', 0.096, 0.0075, 1, [0.044, 0.028, 0.022], [0.0085, 0.0075, 0.0066, 0.0056]],
      ['ring', 0.093, -0.0095, -5, [0.041, 0.026, 0.021], [0.008, 0.0071, 0.0062, 0.0053]],
      ['pinky', 0.086, -0.0255, -12, [0.032, 0.019, 0.018], [0.0071, 0.0062, 0.0055, 0.0048]]];
    F.forEach(function (f) {
      var p = H.L(f[1], f[2], 0), sp = f[3] * PI / 180, dir = norm(add(mul(a, cos(sp)), mul(t, sin(sp)))), lat = norm(cross(dir, n));   // +rotation about lat flexes toward the palm
      var curl = [12, 16, 9], js = [p], d = dir;
      for (var k = 0; k < 3; k++) { d = qrot(qaxis(lat, curl[k] * PI / 180), d); js.push(add(js[k], mul(d, f[4][k]))); }
      fingers.push({ name: f[0], js: js, r: f[5], lat: lat, dir: dir });
    });
    // thumb: from the CMC joint, angled out toward t and down into the palm side
    var tc = H.L(0.02, 0.016, 0.009), td = norm(add(add(mul(a, 0.62), mul(t, 0.62)), mul(n, 0.48))), tl = thumbAxis(td, a, t, n);   // tl: thumb flex axis
    var tj = [tc], dd = td, tlen = [0.040, 0.031, 0.026], tcurl = [0, 10, 12];
    for (var k = 0; k < 3; k++) { dd = qrot(qaxis(cross(dd, n), tcurl[k] * PI / 180), dd); tj.push(add(tj[k], mul(dd, tlen[k]))); }
    fingers.unshift({ name: 'thumb', js: tj, r: [0.0105, 0.0094, 0.0083, 0.0068], lat: tl, dir: td });
    fingers.forEach(function (f) { for (var k = 0; k < 3; k++) bone(f.name + (k + 1) + S, k ? f.name + k + S : 'hand' + S, M(f.js[k])); });
    H.fingers = fingers;
    arms[S] = { Sh: Sh, E: E, W: Wr, dU: dU, dF: dF, H: H, M: M, s: s };
    var hip = [0.088, 0.9, -0.005], knee = [0.095, 0.495, 0.005], ank = [0.104, 0.078, -0.028], ball = [0.112, 0.022, 0.1];
    bone('thigh' + S, 'root', M(hip)); bone('shin' + S, 'thigh' + S, M(knee)); bone('foot' + S, 'shin' + S, M(ank)); bone('toe' + S, 'foot' + S, M(ball));
    arms[S].leg = { hip: hip, knee: knee, ank: ank, ball: ball };
  });
  var sk = { bones: B, by: by, O: O, hl: hl, arms: arms };
  if (def && def.skeleton) applySkeleton(sk, def.skeleton);
  return sk;
}
// thumb flexion axis: flexing curls the thumb across the palm toward the pinky base (−t), into the palm (+n, the side
// the fingers curl to) and a little toward the fingers (+a); the axis turns the thumb's direction toward that goal
function thumbAxis(td, a, t, n) { var g = norm(add(add(mul(t, -0.7), mul(n, 0.6)), mul(a, 0.25))); return norm(cross(td, g)); }
/* skeleton in figure.json: {joints: {bone: [x,y,z]}, tips: {indexL: [x,y,z], …} (finger end sites), palm: {L, R} (palm
   normals)}. Eye and lid joints always sit at the eye centre (params.eye). Missing entries keep the built-in defaults. */
var FIXED_JOINT = /^(eye|lid)[UD]?[LR]$/;
function applySkeleton(sk, J) {
  sk.bones.forEach(function (b) { if (J.joints && J.joints[b.name] && !FIXED_JOINT.test(b.name)) b.p = J.joints[b.name].slice(); });
  ['L', 'R'].forEach(function (S) {
    var A = sk.arms[S], M = A.M, P = function (n) { return M(sk.bones[sk.by[n + S]].p); }, H = A.H;   // left-side coordinates
    var oldW = A.W, oldTips = H.fingers.map(function (f) { return sub(f.js[3], f.js[2]); });
    A.Sh = P('arm'); A.E = P('fore'); A.W = P('hand'); A.dU = norm(sub(A.E, A.Sh)); A.dF = norm(sub(A.W, A.E));
    var a = A.dF, n0 = J.palm && J.palm[S] ? M(J.palm[S]) : H.n, n = norm(sub(n0, mul(a, dot(n0, a)))), t = norm(cross(a, n)); if (t[2] < 0) t = mul(t, -1);
    var Wr = A.W; H.W = Wr; H.a = a; H.n = n; H.t = t; H.L = function (u, v, w) { return add(Wr, add(mul(a, u), add(mul(t, v), mul(n, w)))); };
    H.fingers.forEach(function (f, fi) {
      for (var k = 0; k < 3; k++) f.js[k] = P(f.name + (k + 1));
      f.js[3] = J.tips && J.tips[f.name + S] ? M(J.tips[f.name + S]) : add(f.js[2], oldTips[fi]);
      f.dir = norm(sub(f.js[1], f.js[0])); f.lat = f.name === 'thumb' ? thumbAxis(f.dir, a, t, n) : norm(cross(f.dir, n));
    });
    A.leg = { hip: P('thigh'), knee: P('shin'), ank: P('foot'), ball: P('toe') };
  });
}
function skeletonToJSON(sk) {
  var J = { joints: {}, tips: {}, palm: {} }, r6 = function (v) { return v.map(function (x) { return +x.toFixed(6); }); };
  sk.bones.forEach(function (b) { if (!FIXED_JOINT.test(b.name)) J.joints[b.name] = r6(b.p); });
  ['L', 'R'].forEach(function (S) { var A = sk.arms[S]; A.H.fingers.forEach(function (f) { J.tips[f.name + S] = r6(A.M(f.js[3])); }); J.palm[S] = r6(A.M(A.H.n)); });
  return J;
}

/* ================= body sculpt (bind pose) ================= */
// face parameters (figure.json "params"); defaults are the original constants
var AP = { wLat: 0.0131, wMed: 0.0114, up: 0.0054, lo: 0.0034, tilt: 0.0019, off: [0, 0], rot: 0 };          // eye opening (almond), per eye mirrored
var LP = { wU: 0.0198, wL: 0.0185, thick: [1, 1], depth: [1, 1], arch: 15, slitW: 0.0187 };                     // lips: half widths, thickness/depth scales (upper, lower)
var LS = { len: 1, curl: 1, density: 1, thick: 1, color: [0.012, 0.009, 0.008], profile: [0.55, 1, 0.85], ctrl: [[0, 0], [0, 0], [0, 0]] };                                                                                     // eyelashes
var AP0 = JSON.parse(JSON.stringify(AP)), LP0 = JSON.parse(JSON.stringify(LP)), LS0 = JSON.parse(JSON.stringify(LS));
var EYE_C = [0.0315, 0.004, 0.0635], EYE_R = 0.0118, SOCK_IN = EYE_R + 0.0008, SOCK_OUT = SOCK_IN + 0.0031, MOUTH = [0, -0.0605, 0.0955], HALFGAP = 0.0017;
// eyelid aperture (almond) in eye-local projected coords; s = side (+1 left)
/* eyelashes: roots along the actual upper lid margin (the aperture's upper edge, pressed onto the skin), each lash
   leaving the lid along its surface normal and curling up; length follows an inner / middle / outer profile and tapers
   at the corners. params.lashes: len, curl, density, thick, color, profile [inner, mid, outer], ctrl — three offsets
   (head-local x, y in metres, mirrored) at the inner corner, middle and outer corner that move / bend the lash line */
// The lash line follows the visible rim of the upper lid: rays cast straight back (head −z) from in front of the eye, just
// above the opening's upper edge, stop on the first surface they meet: the outer face of the lid (never its underside or
// the eyeball socket behind it, which a nearest-surface projection found near the inner corner). Samples go from the middle
// out to both corners and reject a hit that jumps in depth (the ray slipped past the rim): then they retry a little higher.
function lashCurve(sk, body, S) {
  var s = S === 'L' ? 1 : -1, E = add(sk.O, [EYE_C[0] * s, EYE_C[1], EYE_C[2]]), BF = body.sdf, C = LS.ctrl || [[0, 0], [0, 0], [0, 0]], off = AP.off || [0, 0];
  var quad = function (q, t) { return q[0] * (1 - t) * (1 - 2 * t) + q[1] * 4 * t * (1 - t) + q[2] * t * (2 * t - 1); };
  var NS = 64, pts = new Array(NS + 1);
  function cast(t, prevZ) {
    var xl = mix(-AP.wMed, AP.wLat, t) * 0.985, qx = (xl + off[0]) * s, A2 = aperture(qx, 0, s);
    var ox = quad([C[0][0], C[1][0], C[2][0]], t) * s, oy = quad([C[0][1], C[1][1], C[2][1]], t);
    for (var dy = 0.0003; dy <= 0.0033; dy += 0.0005) {
      var x = E[0] + qx + ox, y = E[1] + A2.up + off[1] + oy + dy, z0 = E[2] + 0.035, tt = 0, d = 1;
      if (!BF) return { t: t, p: [x, y, E[2] + sqrt(max(sq(SOCK_OUT + 0.001) - sq(qx) - sq(A2.up), 1e-8))], n: [0, 0.3, 1] };
      for (var i = 0; i < 120 && tt < 0.06; i++) { d = BF(x, y, z0 - tt, 1); if (d < 2e-5) break; tt += max(d, 1e-4); }
      var z = z0 - tt; if (d >= 2e-5 || z < E[2] + 0.002 || (prevZ != null && abs(z - prevZ) > 0.0022)) continue;
      // direction: the lid's outer face 1.5 mm above the rim (the rounded rim itself faces down over the eye), tilted up
      var y2 = y + 0.0015, t2 = 0; for (i = 0; i < 120 && t2 < 0.06; i++) { var d2 = BF(x, y2, z0 - t2, 1); if (d2 < 2e-5) break; t2 += max(d2, 1e-4); }
      var nU = abs((z0 - t2) - z) < 0.004 ? sdfGrad(BF, [x, y2, z0 - t2]) : sdfGrad(BF, [x, y, z]);
      return { t: t, p: [x, y, z], n: norm(add(norm(add(nU, sdfGrad(BF, [x, y, z]))), [0, 0.12, 0])) };
    }
    return null;
  }
  var mid = NS >> 1; pts[mid] = cast(0.5, null);
  for (var k = mid + 1; k <= NS; k++) { var pr = pts[k - 1]; pts[k] = cast(k / NS, pr ? pr.p[2] : null) || (pr ? { t: k / NS, p: pr.p, n: pr.n } : null); }
  for (k = mid - 1; k >= 0; k--) { pr = pts[k + 1]; pts[k] = cast(k / NS, pr ? pr.p[2] : null) || (pr ? { t: k / NS, p: pr.p, n: pr.n } : null); }
  return pts;
}
function lashMesh(sk, body, S) {
  var s = S === 'L' ? 1 : -1, M = new Mesh(), bi = [], bw = [];
  var hash = body.hash || (body.hash = VHash(body.pos, 0.01)), n = max(8, Math.round(60 * (LS.density || 1))), P = LS.profile || [0.55, 1, 0.85];
  var quad = function (q, t) { return q[0] * (1 - t) * (1 - 2 * t) + q[1] * 4 * t * (1 - t) + q[2] * t * (2 * t - 1); };   // through t = 0, ½, 1
  var CV = lashCurve(sk, body, S), NS = CV.length - 1;
  function at(t) { var f = clamp(t, 0, 1) * NS, i = min(floor(f), NS - 1), u = f - i, a = CV[i], b = CV[i + 1]; return { p: lerp3(a.p, b.p, u), n: norm(lerp3(a.n, b.n, u)) }; }
  for (var k = 0; k < n; k++) {
    var t = 0.03 + 0.94 * k / (n - 1), R0 = at(t), root = R0.p, nl = R0.n;
    var tp = quad(P, t) * (0.45 + 0.55 * smooth(0, 0.18, t) * smooth(1, 0.82, t)), lenL = 0.0068 * tp * (LS.len || 1);
    var outD = norm(add(nl, [0.18 * s * max(t - 0.5, 0), 0.12, 0])), side = norm(cross(outD, [0, 1, 0])), upD = norm(cross(side, outD)); if (upD[1] < 0) upD = mul(upD, -1);
    var vb = hash.near(root, 0.01), wdt = 0.0007 * (LS.thick || 1);
    M.grid(1, 4, function (u, v) {
      var cu = (LS.curl || 1) * 0.8 * v * v, p = add(root, add(mul(outD, v * lenL * (1 - 0.35 * cu)), add(mul(upD, lenL * cu), mul(side, (u - 0.5) * wdt * (1 - 0.8 * v)))));
      p = add(p, mul(nl, -0.0005 * (1 - v)));   // root tucked into the lid
      return { p: p, n: norm(add(outD, upD)), uv: [u, v, 0, 0] };
    });
    for (var q = 0; q < 10; q++) for (var j = 0; j < 4; j++) { bi.push(body.bi[vb * 4 + j]); bw.push(body.bw[vb * 4 + j]); }
  }
  var lm = M.out(null, 'lash'); lm.bi = new Uint8Array(bi); lm.bw = new Float32Array(bw);
  lm.handles = [0.03, 0.5, 0.97].map(function (t) { return at(t).p; });   // the editor's control points sit on the lash line
  return lm;
}
function aperture(qx, qy, s, open) {
  qx -= AP.off[0] * s; qy -= AP.off[1];
  if (AP.rot) { var cr = cos(AP.rot * s), sr = sin(AP.rot * s), rx = qx * cr + qy * sr; qy = -qx * sr + qy * cr; qx = rx; }
  var xl = qx * s, w = xl >= 0 ? AP.wLat : AP.wMed, xn = clamp(xl / w, -1, 1), f = max(1 - xn * xn, 0);
  var tilt = AP.tilt * max(xn, 0) * max(xn, 0), up = AP.up * sqrt(f) * (0.78 + 0.22 * f) * (1 - 0.12 * xn) + tilt, lo = -AP.lo * f * (1.3 - 0.3 * f) + tilt * 0.8;
  if (open != null) up = lo + (up - lo) * open;
  return { up: up, lo: lo, xn: xn, w: w, xl: xl };
}
function ellipse2(dy, dz, a, b, c, s) {   // approx. signed distance to a 2D ellipse rotated by (cos, sin)
  var y = dy * c - dz * s, z = dy * s + dz * c, k0 = sqrt(y * y / (a * a) + z * z / (b * b)), k1 = sqrt(y * y / (a * a * a * a) + z * z / (b * b * b * b));
  return k1 > 1e-12 ? k0 * (k0 - 1) / k1 : -min(a, b);
}
function lipShape(lower) {   // swept ellipse along the mouth arch; returns f(x,y,z) in head-local coords
  var xc = lower ? LP.wL : LP.wU, ang = lower ? -0.5 : 0.42, ca = cos(ang), sa = sin(ang), th = LP.thick[lower ? 1 : 0], dp = LP.depth[lower ? 1 : 0], arch = LP.arch;
  function bump(x) { x = 1 - x * x; return x > 0 ? x * x : 0; }
  return function (X, Y, Z) {
    var u = min(abs(X) / xc, 1), s = sqrt(1 - u * u), dx = max(abs(X) - xc, 0), Zr = Z - (MOUTH[2] - arch * X * X), Yr = Y - MOUTH[1], a, b, yc, zc;
    if (!lower) { a = (0.0007 + 0.0026 * s) * th; b = (0.0009 + 0.0027 * s) * dp; yc = HALFGAP * s + a + 0.0005 * bump((u - 0.27) / 0.22) - 0.0003 * bump(u / 0.15) - 0.0004 * (1 - s); zc = -0.6 * b + 0.0002; }
    else { a = (0.0008 + 0.0037 * s) * th; b = (0.0011 + 0.0033 * s) * dp; yc = -HALFGAP * s - a - 0.0002 * (1 - s); zc = -0.65 * b - 0.0006; }
    return ellipse2(Yr - yc, Zr - zc, a, b, ca, sa) + dx * 1.2;
  };
}
function sq(x) { return x * x; }
// named special primitives (their geometry follows the face parameters: eye centre, mouth position, lip gap)
function special(name, side, O) {
  var s = side || 1, E = add(O, [EYE_C[0] * s, EYE_C[1], EYE_C[2]]), C0 = add(O, [0, MOUTH[1], MOUTH[2]]), n;
  if (name === 'socketOut') n = Sph(E, SOCK_OUT);
  else if (name === 'socketIn') n = Sph(E, SOCK_IN);
  else if (name === 'lidShell') n = Fn(function (x, y, z) { x -= E[0]; y -= E[1]; z -= E[2]; return abs(sqrt(x * x + y * y + z * z) - (SOCK_IN + SOCK_OUT) / 2) - (SOCK_OUT - SOCK_IN) / 2; }, E, SOCK_OUT);
  else if (name === 'aperture') n = Fn(function (x, y, z) {
      var qx = x - E[0], qy = y - E[1], qz = z - E[2]; if (qz < 0.0) return 0.01 - qz;
      var A2 = aperture(qx, qy, s), Ap = aperture(qx + 3e-4, qy, s), Am = aperture(qx - 3e-4, qy, s);
      var su = (Ap.up - Am.up) / 6e-4, sl = (Ap.lo - Am.lo) / 6e-4;
      return max(max(max((qy - A2.up) / sqrt(1 + su * su), (A2.lo - qy) / sqrt(1 + sl * sl)), abs(A2.xl) - A2.w), SOCK_IN * 0.7 - qz);
    }, add(E, [0, 0, 0.02]), 0.03);
  else if (name === 'lipUpper' || name === 'lipLower') { var L = lipShape(name === 'lipLower'); n = Fn(function (x, y, z) { return L(x - O[0], y - O[1], z - O[2]); }, C0, 0.03); }
  else if (name === 'mouthSlit') n = Fn(function (x, y, z) {
      var X0 = x - O[0], Y = y - O[1] - MOUTH[1], Z = z - O[2] - (MOUTH[2] - LP.arch * X0 * X0), u = min(abs(X0) / LP.slitW, 1), g = HALFGAP * (1.15 - 0.85 * u * u);
      return max(max((abs(Y) - g) / 1.02, abs(X0) - LP.slitW), -(Z + 0.016));
    }, C0, 0.04);
  else throw new Error('unknown special primitive ' + name);
  n.spec = { type: 'special', name: name, side: side || 0 }; if (n.t === 0) n.t = undefined;
  return n;
}


/* ================= body mesh: multi-resolution, zipped, weighted ================= */
/* ---- figure definition ⇄ JSON ----
   group: {group: name, op: 'union'|'subtract'|'intersect', k, kids: [...]}   (subtract: first kid minus the rest)
   prim:  {id, type: sphere|cone|ellipsoid|special, ...params, bone, sig (weight falloff), mat, mirror: id of the L/R partner} */
var OPS = { u: 'union', s: 'subtract', i: 'intersect' }, OPI = { union: 'u', subtract: 's', intersect: 'i' };
function treeToJSON(tree, sk) {
  var id = 0, prims = [];
  function ser(n) {
    if (n.op) { var g = { group: n.name || '', op: OPS[n.op], k: n.k, kids: n.kids.map(ser) }; return g; }
    var p = { id: ++id }; for (var k in n.spec) p[k] = Array.isArray(n.spec[k]) ? n.spec[k].map(function (x) { return +x.toFixed(6); }) : typeof n.spec[k] === 'number' ? +n.spec[k].toFixed(6) : n.spec[k];
    p.bone = n.bone == null ? null : sk.bones[n.bone].name; if (n.sig) p.sig = n.sig; if (n.mat) p.mat = n.mat;
    prims.push(p); return p;
  }
  var root = ser(tree), mx = function (v) { return [-v[0], v[1], v[2]]; };
  function key(p) {   // mirrored description for partner matching
    var q = JSON.parse(JSON.stringify(p)); delete q.id; delete q.bone; delete q.mirror;
    ['c', 'a', 'b'].forEach(function (k) { if (q[k]) q[k] = mx(q[k]); }); if (q.u) q.u = [q.u[0], -q.u[1], -q.u[2]]; if (q.v) q.v = [-q.v[0], q.v[1], q.v[2]]; if (q.side) q.side = -q.side;
    return JSON.stringify(q, function (k, v) { return typeof v === 'number' ? Math.round(v * 1e5) : v; });
  }
  var by = new Map(); prims.forEach(function (p) { var q = JSON.parse(JSON.stringify(p)); delete q.id; delete q.bone; delete q.mirror; by.set(JSON.stringify(q, function (k, v) { return typeof v === 'number' ? Math.round(v * 1e5) : v; }), p); });
  prims.forEach(function (p) { var m = by.get(key(p)); if (m && m !== p && (p.c ? Math.abs(p.c[0]) > 1e-6 : true)) p.mirror = m.id; });
  return root;
}
function treeFromJSON(j, sk) {
  function bld(n) {
    if (n.kids) { var g = { op: OPI[n.op], k: n.k, kids: n.kids.map(bld), name: n.group }; return g; }
    var l;
    if (n.type === 'sphere') l = Sph(n.c, n.r);
    else if (n.type === 'cone') l = n.s || n.u || n.capA != null || n.capB != null ? ECone(n.a, n.b, n.ra, n.rb, n.s, n.u, n.capA, n.capB) : Cone(n.a, n.b, n.ra, n.rb);
    else if (n.type === 'ellipsoid') l = Ell(n.c, n.r, n.u, n.v);
    else if (n.type === 'shell') l = Shell(n.c, n.r, n.t, n.u, n.v);
    else l = special(n.name, n.side, sk.O);
    l.bone = n.bone == null ? null : sk.by[n.bone]; l.sig = n.sig || 0.02; l.mat = n.mat; l.pid = n.id;
    if (n.bone != null && l.bone === undefined) throw new Error('unknown bone ' + n.bone);
    return l;
  }
  return bounds(bld(j));
}
// face / rig parameters that the special primitives and the face rig share
function findGroup(g, name) { if (g.group === name) return g; for (var i = 0; g.kids && i < g.kids.length; i++) { var r = findGroup(g.kids[i], name); if (r) return r; } return null; }
// load a figure definition (figure.json): body tree, face parameters, hair styles, costumes
var ORN = [], CORDS = [];   // figure "ornaments" (traced jade pieces) and "cords" (silk cords tying the hair)
function load(def) { setParams(def.params); HAIR = def.hair; COSTUME = def.costume; ORN = def.ornaments || []; CORDS = def.cords || []; return def; }
// the hair style of a costume: hair.<hair>_<headdress> when the costume has a headdress with its own hair (Song), else hair.<hair>
function hairKey(C) { C = C || {}; var k = C.hair || 'tang'; return C.headdress && HAIR[k + '_' + C.headdress] ? k + '_' + C.headdress : k; }
function setParams(P) { if (!P) return; ['eyeOpening', 'lips', 'lashes'].forEach(function (k, i) { var D = [AP, LP, LS][i], DEF0 = [AP0, LP0, LS0][i]; for (var q in DEF0) D[q] = JSON.parse(JSON.stringify(P[k] && P[k][q] !== undefined ? P[k][q] : DEF0[q])); }); if (P.eye) { EYE_C = P.eye.c; EYE_R = P.eye.r; SOCK_IN = EYE_R + 0.0008; SOCK_OUT = SOCK_IN + 0.0031; } if (P.mouth) MOUTH = P.mouth; if (P.halfGap) HALFGAP = P.halfGap; }
function buildBody(sk, cfg, log) {
  var t0 = Date.now(), tree = treeFromJSON(cfg.headOnly ? findGroup(cfg.def.body, 'head') : cfg.def.body, sk), sdf = compile(tree), A = sk.arms;
  var hb = cfg.res || { body: 0.005, fine: 0.0018 };   // body 5 mm, face / hands 1.8 mm (no visible faceting; see the report)
  // per-vertex bake inside the polygonizer (pruned sdf): AO from SDF samples along n, thickness along -n
  var PO = { attrR: 0.03, attr: function (f, x, y, z, n, zoned) {
    var occ = 0, sc = 1, nx = n[0], ny = n[1], nz = n[2];
    for (var i = 1; i <= 5; i++) { var hh = 0.0016 * i * i; occ += sc * max(0, hh - f(x + nx * hh, y + ny * hh, z + nz * hh, hh)); sc *= 0.65; }
    var t = 0.0012; if (zoned) for (i = 0; i < 16 && t < 0.03; i++) { var d = f(x - nx * t, y - ny * t, z - nz * t, 1); if (d > 0) break; t += max(-d, 0.0015); } else t = 0.1;
    return [clamp(1 - 14 * occ, 0, 1), t];
  } };
  var zoom = hb.body / hb.fine, zones = [Zone(sk.hl(0, -0.012, 0.012), 0.112, zoom, 0.16)];
  if (!cfg.headOnly) ['L', 'R'].forEach(function (S) { var a = A[S]; zones.push(Zone(a.M(add(a.W, mul(a.dF, 0.085))), 0.108, zoom, 0.15)); });
  PO.warp = Warp(zones);
  var m = cfg.headOnly ? polygonize(tree, [-0.1, 1.36, -0.13], [0.1, 1.64, 0.13], hb.body, PO) : polygonize(tree, [-0.72, -0.06, -0.2], [0.72, 1.68, 0.22], hb.body, PO);
  if (log) log('body: polygonized ' + (m.pos.length / 3) + ' verts, ' + m.holes + ' holes, ' + (Date.now() - t0) + 'ms');
  // smooth the thickness attribute (translucency) over the mesh
  if (m.attr) { var nb0 = neighbors(m.pos.length / 3, m.idx), th = new Float32Array(m.pos.length / 3); for (var i = 0; i < th.length; i++) th[i] = m.attr[i * 2 + 1];
    for (var it = 0; it < 6; it++) { var t2 = new Float32Array(th.length); for (i = 0; i < th.length; i++) { var s0 = th[i] * 2, c = 2; for (var j = nb0.off[i]; j < nb0.off[i + 1]; j++) { s0 += th[nb0.adj[j]]; c++; } t2[i] = s0 / c; } th = t2; }
    for (i = 0; i < th.length; i++) m.attr[i * 2 + 1] = th[i];
    // and the occlusion: a few passes, so the shadow under the chin / along the jaw is smooth (no speckle)
    var ao = new Float32Array(th.length); for (i = 0; i < ao.length; i++) ao[i] = m.attr[i * 2];
    for (it = 0; it < 4; it++) { var a2 = new Float32Array(ao.length); for (i = 0; i < ao.length; i++) { var s1 = ao[i] * 2, c1 = 2; for (j = nb0.off[i]; j < nb0.off[i + 1]; j++) { s1 += ao[nb0.adj[j]]; c1++; } a2[i] = s1 / c1; } ao = a2; }
    for (i = 0; i < ao.length; i++) m.attr[i * 2] = ao[i]; }
  m = sealMesh(m, sdf, log);
  m.sdf = sdf; m.tree = tree; m.headSdf = headSDF(cfg.def, sk);
  m.boundary = boundaryLoops(m).length;
  var t1 = Date.now(); weights(m, sk, tree); var t2 = Date.now();
  faceWeights(m, sk); bake(m, sdf, sk);
  if (log) log('weights ' + (t2 - t1) + 'ms, face+bake ' + (Date.now() - t2) + 'ms');
  if (log) log('body: ' + (m.pos.length / 3) + ' verts, ' + (m.idx.length / 3) + ' tris, boundary loops left ' + m.boundary + ', ' + (Date.now() - t0) + 'ms');
  return m;
}

// skin weights: soft-min over the bones' primitive distances, then smoothed over the mesh. 4 influences.
function weights(m, sk, tree) {
  var nv = m.pos.length / 3, P = m.pos, L = leaves(tree).filter(function (l) { return l.bone != null && l.bone !== undefined; }), nb = sk.bones.length;
  var BI = new Uint8Array(nv * 4), BW = new Float32Array(nv * 4), db = new Float64Array(nb), sg = new Float64Array(nb), MAT = m.matv = new Float32Array(nv);
  for (var v = 0; v < nv; v++) {
    var x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    db.fill(1e9); var bestD = 1e9, dLip = 1e9, dNon = 1e9;
    for (var i = 0; i < L.length; i++) {
      var l = L[i], dx = x - l.c[0], dy = y - l.c[1], dz = z - l.c[2];
      if (sqrt(dx * dx + dy * dy + dz * dz) - l.r > 0.08) continue;
      var d = l.f(x, y, z); if (d < db[l.bone]) { db[l.bone] = d; sg[l.bone] = l.sig; } if (d < bestD) { bestD = d; MAT[v] = MATID[l.mat] || 0; }
      if (l.mat === 'lip') dLip = min(dLip, d); else dNon = min(dNon, d);
    }
    if (MAT[v] <= 1 && dLip < 1e8) MAT[v] = smooth(0.0012, -0.0012, dLip - dNon);   // lip ↔ skin as a soft weight (no jagged edge)
    var best = 0; for (i = 1; i < nb; i++) if (db[i] < db[best]) best = i;
    var ws = [];
    for (i = 0; i < nb; i++) { if (db[i] > 1e8) continue; var s = min(sg[i], sg[best]), e = (db[i] - db[best]) / s; if (e < 4) ws.push([i, exp(-e * 1.5)]); }
    setW(BI, BW, v, ws);
  }
  // smooth (sparse) — a few Jacobi passes
  var nb2 = neighbors(nv, m.idx);
  for (var it0 = 0; it0 < 3; it0++) { var M2 = MAT.slice(); for (v = 0; v < nv; v++) { if (MAT[v] > 1) continue; var s0 = MAT[v], c0 = 1; for (var j0 = nb2.off[v]; j0 < nb2.off[v + 1]; j0++) { var u0 = nb2.adj[j0]; if (MAT[u0] <= 1) { s0 += MAT[u0]; c0++; } } M2[v] = s0 / c0; } MAT.set(M2); }
  for (var it = 0; it < 4; it++) {
    var BI2 = new Uint8Array(nv * 4), BW2 = new Float32Array(nv * 4);
    for (v = 0; v < nv; v++) {
      var acc = new Map();
      function addw(u, f) { for (var k = 0; k < 4; k++) { var w = BW[u * 4 + k]; if (w > 0) acc.set(BI[u * 4 + k], (acc.get(BI[u * 4 + k]) || 0) + w * f); } }
      addw(v, 1);
      var a0 = nb2.off[v], a1 = nb2.off[v + 1], f = 1 / max(1, a1 - a0);
      for (var j = a0; j < a1; j++) addw(nb2.adj[j], f);
      var arr = []; acc.forEach(function (w, b) { arr.push([b, w]); });
      setW(BI2, BW2, v, arr);
    }
    BI = BI2; BW = BW2;
  }
  // elbows: a tighter upper-arm ↔ forearm transition (a defined crease instead of a bent hose): the forearm's share of
  // the two is pushed through a smoothstep, the rest of the weights untouched
  // Near the joint the split follows position instead: on the back (olecranon) side a sharp cut just above the joint line,
  // so the bony point rides rigidly with the forearm and the upper arm stays rigid down to it; on the inner (crease) side a
  // wider transition, so the bend is taken there (dual quaternions keep the crease's volume: it folds instead of thinning)
  ['L', 'R'].forEach(function (S) {
    var ba = sk.by['arm' + S], bf = sk.by['fore' + S], E = sk.bones[bf].p, dU = norm(sub(E, sk.bones[ba].p)), fz = norm(sub([0, 0, 1], mul(dU, dU[2])));
    for (var v2 = 0; v2 < nv; v2++) {
      var ka = -1, kf = -1; for (var k = 0; k < 4; k++) { if (BW[v2 * 4 + k] > 0 && BI[v2 * 4 + k] === ba) ka = k; if (BW[v2 * 4 + k] > 0 && BI[v2 * 4 + k] === bf) kf = k; }
      if (ka < 0 && kf < 0) continue;
      var q = sub([m.pos[v2 * 3], m.pos[v2 * 3 + 1], m.pos[v2 * 3 + 2]], E);
      if (ka < 0 || kf < 0) {   // only one of the two: near the joint, give the other an empty slot (weight 0 for now)
        if (len(q) > 0.06) continue; var ke = -1; for (k = 0; k < 4; k++) if (BW[v2 * 4 + k] === 0) { ke = k; break; } if (ke < 0) continue;
        BI[v2 * 4 + ke] = ka < 0 ? ba : bf; if (ka < 0) ka = ke; else kf = ke; }
      var wa = BW[v2 * 4 + ka], wf = BW[v2 * 4 + kf], sum = wa + wf, fr = smooth(0.2, 0.8, wf / sum);
      var sAx = dot(q, dU), rr = sub(q, mul(dU, sAx)), rl = len(rr);
      if (abs(sAx) < 0.07 && rl < 0.06) {
        var front = smooth(-0.35, 0.35, rl > 1e-6 ? dot(rr, fz) / rl : 0);   // 0 back … 1 crease side
        var frB = smooth(-0.034, -0.012, sAx), frF = smooth(-0.035, 0.03, sAx), frP = mix(frB, frF, front);
        fr = mix(fr, frP, 1 - smooth(0.045, 0.07, abs(sAx)));
      }
      BW[v2 * 4 + ka] = sum * (1 - fr); BW[v2 * 4 + kf] = sum * fr;
    }
  });
  m.bi = BI; m.bw = BW;
}
var MATID = { skin: 0, lip: 1, nail: 2, brow: 3 };   // body surface materials (per primitive; the dominant one per vertex)
function setW(BI, BW, v, ws) {
  ws.sort(function (a, b) { return b[1] - a[1]; }); ws = ws.slice(0, 4).filter(function (x) { return x[1] > 0.01; });
  var s = 0; ws.forEach(function (x) { s += x[1]; });
  for (var k = 0; k < 4; k++) { BI[v * 4 + k] = k < ws.length ? ws[k][0] : 0; BW[v * 4 + k] = k < ws.length ? ws[k][1] / s : 0; }
}
function getW(m, v) { var r = []; for (var k = 0; k < 4; k++) if (m.bw[v * 4 + k] > 0) r.push([m.bi[v * 4 + k], m.bw[v * 4 + k]]); return r; }

// face rig: split the head weight into jaw / lips / corners / cheeks / brows / lids by fields in head-local coords
function faceFields(sk, x, y, z) {   // head-local; returns {bone: w} fractions of the head weight
  var by = sk.by, r = {}, ym = MOUTH[1], ax = abs(x), s = x >= 0 ? 1 : -1, S = s > 0 ? 'L' : 'R';
  // jaw: below the mouth line, which rises laterally toward the jaw joint; sharp at the lips, soft on the cheeks
  var yl = ym + max(ax - 0.019, 0) * 0.55 + max(0.07 - z, 0) * 0.25 * smooth(0.015, 0.03, ax);
  var w = 0.0007 + 0.35 * max(ax - 0.0195, 0) + 0.25 * max(0.088 - z, 0) * smooth(0.0, 0.02, ax - 0.012) + 0.05 * max(0.092 - z, 0);
  var J = smooth(-w, w, yl - y) * smooth(-0.025, 0.02, z) * (1 - smooth(-0.115, -0.085, -y) * 0) * (1 - 0.6 * smooth(0.04, 0.07, ax) * smooth(-0.04, 0, y - ym));
  // under the chin toward the neck: fade
  J *= 1 - smooth(0.005, 0.045, -(z - 0.03)) * smooth(-0.1, -0.08, y) * 0.0;
  if (y < -0.085 && z < 0.045) J *= smooth(-0.005, 0.045, z);
  r.jaw = J;
  var front = smooth(0.0775, 0.0895, z);
  var lipMask = exp(-Math.pow(ax / 0.024, 4)) * front;
  r.lipU = (1 - J) * lipMask * exp(-sq(max(y - ym, 0) / 0.009)) * 0.9;
  r.lipL = J * lipMask * exp(-sq(max(ym - y, 0) / 0.011)) * 0.9;
  var cd = sqrt(sq(ax - 0.0205) + sq((y - ym) * 1.2) + sq((z - 0.0885) * 0.8));
  r['corner' + S] = exp(-sq(cd / 0.0105)) * 0.85 * smooth(0.06, 0.08, z);
  r['cheek' + S] = exp(-(sq((ax - 0.038) / 0.02) + sq((y + 0.03) / 0.018) + sq((z - 0.075) / 0.02))) * 0.7;
  r['brow' + S] = exp(-(sq((ax - 0.03) / 0.022) + sq((y - 0.028) / 0.011))) * smooth(0.06, 0.08, z) * 0.8;
  // eyelids: rotate about the eye center; weight per column so the margin closes onto the lower lid
  var E = [EYE_C[0] * s, EYE_C[1], EYE_C[2]], qx = x - E[0], qy = y - E[1], qz = z - E[2], A0 = aperture(qx, qy, s), Ac = aperture(0, 0, s);
  var rr = sqrt(qx * qx + qy * qy + qz * qz);
  if (rr < 0.026 && qz > -0.004) {
    var zz = sqrt(max(sq(SOCK_OUT) - qx * qx, 1e-8)), col = (Math.atan2(A0.up, zz) - Math.atan2(A0.lo, zz)) / (Math.atan2(Ac.up, SOCK_OUT) - Math.atan2(Ac.lo, SOCK_OUT));
    col = clamp(col, 0, 1) * smooth(-1.25, -0.95, -abs(A0.xn));
    var mid = (A0.up + A0.lo) / 2, zf = smooth(-0.004, 0.003, qz);
    var up = smooth(mid - 0.0004, mid + 0.0004, qy) * (1 - smooth(A0.up + 0.004, A0.up + 0.013, qy)) * zf * smooth(0.033, 0.024, rr);
    var dn = (1 - smooth(mid - 0.0004, mid + 0.0004, qy)) * (1 - smooth(-A0.lo + 0.003, -A0.lo + 0.009, -qy)) * zf * smooth(0.03, 0.02, rr);
    r['lidU' + S] = up * col; r['lidD' + S] = dn * col * 0.9;
  }
  return r;
}
function faceWeights(m, sk) {
  var nv = m.pos.length / 3, P = m.pos, O = sk.O, H = sk.by.head, by = sk.by;
  for (var v = 0; v < nv; v++) {
    var ws = getW(m, v), k = -1;
    for (var i = 0; i < ws.length; i++) if (ws[i][0] === H) k = i;
    if (k < 0) continue;
    var wh = ws[k][1], x = P[v * 3] - O[0], y = P[v * 3 + 1] - O[1], z = P[v * 3 + 2] - O[2];
    if (y < -0.13) continue;
    var f = faceFields(sk, x, y, z), J = f.jaw, out = ws.filter(function (_, i) { return i !== k; });
    // head part and jaw part each get their sub-bones
    var restH = 1, restJ = 1, add2 = function (b, w) { if (w > 0.003) out.push([by[b], w]); };
    var hs = ['lipU', 'cornerL', 'cornerR', 'cheekL', 'cheekR', 'browL', 'browR', 'lidUL', 'lidUR', 'lidDL', 'lidDR'], sumH = 0;
    hs.forEach(function (b) { if (f[b]) sumH += f[b]; });
    var scale = sumH > 1 ? 1 / sumH : 1;
    var corner = (f.cornerL || 0) + (f.cornerR || 0);
    hs.forEach(function (b) { if (f[b]) add2(b, wh * f[b] * scale * (b.indexOf('corner') === 0 ? 1 : (1 - J))); });
    var usedH = 0; hs.forEach(function (b) { if (f[b]) usedH += f[b] * scale * (b.indexOf('corner') === 0 ? 1 : (1 - J)); });
    var lipL = (f.lipL || 0) * (1 - corner);
    add2('lipL', wh * lipL);
    var jawW = max(0, J * (1 - corner) - lipL);
    add2('jaw', wh * jawW);
    add2('head', wh * max(0, 1 - usedH - lipL - jawW));
    setW(m.bi, m.bw, v, out);
  }
}
// bake: AO/thickness come from the polygonizer; here the fingernail mask
function bake(m, sdf, sk) {
  var nv = m.pos.length / 3, P = m.pos, aux = new Float32Array(nv * 4), A = sk.arms, tips = [];
  ['L', 'R'].forEach(function (S) { var a = A[S]; a.H.fingers.forEach(function (f) { var js = f.js.map(a.M); tips.push({ a: js[2], b: js[3], r: f.r[3], n: a.M(a.H.n) }); }); });
  for (var v = 0; v < nv; v++) {
    var x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    aux[v * 4] = m.attr ? m.attr[v * 2] : 1; aux[v * 4 + 2] = m.attr ? m.attr[v * 2 + 1] : 0.1; aux[v * 4 + 3] = m.matv ? m.matv[v] : 0;
    var nail = 0;
    if (abs(x) > 0.4) for (var i = 0; i < tips.length; i++) {
      var T = tips[i], ab = sub(T.b, T.a), l = len(ab), dir = mul(ab, 1 / l), p = [x - T.a[0], y - T.a[1], z - T.a[2]], u = dot(p, dir) / l;
      if (u < 0.15 || u > 1.3) continue;
      var radial = sub(p, mul(dir, u * l)), rl = len(radial); if (rl > T.r * 1.7) continue;
      var dors = -dot(radial, T.n) / (rl || 1);
      nail = max(nail, smooth(0.3, 0.55, dors) * smooth(0.25, 0.42, u) * (1 - smooth(1.1, 1.22, u)));
    }
    aux[v * 4 + 1] = max(nail, aux[v * 4 + 3] === 2 ? 1 : 0);
  }
  m.aux = aux;
}

/* ================= posing =================
   A pose is a set of controls (angles in radians, offsets in meters). solve() turns it into world rotations and
   positions of every bone (FK from bind; the right side mirrors the left-side math). */
function mirrorQ(q) { return [q[0], -q[1], -q[2], q[3]]; }
function defaultControls() {
  var c = { root: [0, 0, 0], yaw: 0, hip: [0, 0, 0], spine: [0, 0, 0], chest: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0], breath: 0,
    jaw: 0, lipRound: 0, lipSpread: 0, lipPress: 0, lipUp: 0, smile: 0, tongue: 0, blinkL: 0, blinkR: 0, browL: 0, browR: 0, eyeYaw: 0, eyePitch: 0, sneer: 0 };
  ['L', 'R'].forEach(function (S) {
    c['arm' + S] = { raise: 0.18, fwd: 0.05, twist: 0, elbow: 0.25, pron: 0, wflex: 0, wdev: 0, clav: 0, fing: [0.25, 0.25, 0.25, 0.25, 0.2], spread: 0, thumb: 0 };
    c['leg' + S] = { lift: 0, bend: 0 };
  });
  return c;
}
// fixed thumb pose: rotate the whole thumb at its base so it points along the hand (a), ~20° out toward the thumb side
// (t) and slightly in front of the palm (n); the MCP / IP undo the thumb's built-in bind curl so it is straight
function thumbRest(H, f) { var dir = norm(sub(f.js[1], f.js[0])), want = norm(add(add(mul(H.a, 0.86), mul(H.t, 0.45)), mul(H.n, 0.16))); return qfromto(dir, want); }
function thumbStraighten(f) {
  var out = [[0, 0, 0, 1]];
  for (var k = 1; k < 3; k++) { var d0 = norm(sub(f.js[k], f.js[k - 1])), d1 = norm(sub(f.js[k + 1], f.js[k])); out.push(qfromto(d1, d0)); }   // local: bind frames are world-aligned
  return out;
}
function Rx(a) { return qaxis([1, 0, 0], a); } function Ry(a) { return qaxis([0, 1, 0], a); } function Rz(a) { return qaxis([0, 0, 1], a); }
function eul(e) { return qmul(Ry(e[1]), qmul(Rx(e[0]), Rz(e[2]))); }   // [pitch, yaw, roll]
function solve(sk, c) {
  var B = sk.bones, n = B.length, L = new Array(n), T = new Array(n), by = sk.by;
  for (var i = 0; i < n; i++) { L[i] = [0, 0, 0, 1]; T[i] = null; }
  // torso chain
  L[by.root] = qmul(Ry(c.yaw), eul(c.hip));
  L[by.spine] = eul(mul(c.spine, 0.5)); L[by.spine2] = eul(mul(c.spine, 0.5));
  L[by.chest] = qmul(eul(c.chest), Rx(-0.03 * c.breath));
  L[by.neck] = eul(c.neck); L[by.head] = eul(c.head);
  // face
  L[by.jaw] = Rx(0.26 * c.jaw);
  var press = c.lipPress, rnd = c.lipRound, spr = c.lipSpread, sm = c.smile;
  T[by.lipU] = [0, -0.0017 * press + 0.0012 * c.lipUp - 0.0006 * rnd, 0.0022 * rnd - 0.0004 * spr - 0.0003 * press];
  T[by.lipL] = [0, 0.0021 * press + 0.0003 * rnd, 0.0024 * rnd - 0.0004 * spr - 0.0004 * press];
  [1, -1].forEach(function (s) {
    var S = s > 0 ? 'L' : 'R';
    T[by['corner' + S]] = [s * (-0.0042 * rnd + 0.0028 * spr + 0.0018 * sm), 0.0019 * sm - 0.0003 * spr, 0.0016 * rnd - 0.0014 * spr - 0.001 * sm];
    T[by['cheek' + S]] = [s * 0.0006 * sm, 0.0018 * sm, 0.0006 * sm];
    T[by['brow' + S]] = [0, 0.0022 * c['brow' + S], 0.0004 * c['brow' + S]];
    var bl = clamp(c['blink' + S], 0, 1);
    L[by['lidU' + S]] = Rx(0.68 * bl);
    L[by['lidD' + S]] = Rx(-0.07 * bl - 0.03 * sm);
    L[by['eye' + S]] = qmul(Ry(c.eyeYaw), Rx(-c.eyePitch));
  });
  L[by.tongue] = Rx(-0.2 * c.tongue);
  // arms (left math, mirrored for the right)
  ['L', 'R'].forEach(function (S) {
    var a = sk.arms[S], ac = c['arm' + S], mir = S === 'R' ? mirrorQ : function (q) { return q; };
    var cr = ac.raise - 0.785, crp = 0.5 * (cr + sqrt(cr * cr + 0.01));   // smooth max(cr, 0)
    L[by['clav' + S]] = mir(Rz((ac.clav || 0) + 0.3 * crp + 0.08 * (cr - crp)));   // the shoulder rises with the arm, but barely drops below the bind angle (keeps the armpit open)
    // upper arm direction: raise = abduction from hanging (0) to horizontal (PI/2); fwd = flexion toward +z
    var d = norm([sin(ac.raise) * cos(ac.fwd), -cos(ac.raise) * cos(ac.fwd), sin(ac.fwd)]);
    var sw = qfromto(a.dU, d), tw = qaxis(d, ac.twist);
    L[by['arm' + S]] = mir(qmul(tw, sw));
    var hinge = norm(cross(a.dU, [0, 0, 1]));   // in the upper arm's bind frame
    // pronation rolls the forearm about its own axis (half in the forearm, half at the wrist, as radius and ulna do)
    L[by['fore' + S]] = mir(qmul(qaxis(hinge, ac.elbow), qaxis(a.dF, 0.5 * ac.pron)));
    L[by['hand' + S]] = mir(qmul(qaxis(a.dF, 0.5 * ac.pron), qmul(qaxis(a.H.t, -ac.wflex), qaxis(a.H.n, ac.wdev))));
    a.H.fingers.forEach(function (f, fi) {
      var curl = ac.fing[fi === 0 ? 4 : fi - 1] || 0;
      for (var k = 0; k < 3; k++) {
        // thumb: the CMC barely flexes — it abducts out of the palm plane and opposes (swinging in front of the palm and
        // rolling the nail sideways); the MCP flexes moderately and the IP does most of the curling
        // the thumb is held still for now (the user's request): straight, pointing ahead along the hand, a little out
        // from the index finger and just in front of the palm plane — no curl, opposition or noise
        if (f.name === 'thumb') { L[by[f.name + (k + 1) + S]] = mir(k === 0 ? (a.H.thumbRest || (a.H.thumbRest = thumbRest(a.H, f))) : (a.H.thumbStraight || (a.H.thumbStraight = thumbStraighten(f)))[k]); continue; }
        var ang = curl * [1.0, 1.25, 0.8][k] * 1.1;
        var q = qaxis(f.lat, ang);
        if (k === 0) q = qmul(qaxis(a.H.n, (ac.spread || 0) * [0.12, 0.02, -0.1, -0.22][fi - 1] * 2), q);
        L[by[f.name + (k + 1) + S]] = mir(q);
      }
    });
    var lc = c['leg' + S];
    L[by['thigh' + S]] = mir(Rx(-(lc.lift || 0)));
    L[by['shin' + S]] = mir(Rx(lc.bend || 0));
    L[by['foot' + S]] = mir(Rx(-0.6 * (lc.bend || 0) + 0.5 * (lc.lift || 0) + (lc.ank || 0)));   // the ankle keeps the foot level, plus its own drift
  });
  // FK
  var Q = new Array(n), P = new Array(n);
  for (i = 0; i < n; i++) {
    var b = B[i];
    if (b.parent < 0) { Q[i] = L[i]; P[i] = add(b.p, c.root); continue; }
    var pq = Q[b.parent], off = sub(b.p, B[b.parent].p); if (T[i]) off = add(off, T[i]);
    Q[i] = qmul(pq, L[i]); P[i] = add(P[b.parent], qrot(pq, off));
  }
  return { q: Q, p: P };
}
function bindW(sk) { return { q: sk.bones.map(function () { return [0, 0, 0, 1]; }), p: sk.bones.map(function (b) { return b.p.slice(); }) }; }
function blendW(A, B, k) { return { q: A.q.map(function (q, i) { return qslerp(q, B.q[i], k); }), p: A.p.map(function (p, i) { return lerp3(p, B.p[i], k); }) }; }
// dual quaternions per bone (8 floats each) for skinning
function poseDQ(sk, W, out) {
  out = out || new Float32Array(sk.bones.length * 8);
  sk.bones.forEach(function (b, i) {
    var r = W.q[i], t = sub(W.p[i], qrot(r, b.p)), d = qmul([t[0], t[1], t[2], 0], r);
    out[i * 8] = r[0]; out[i * 8 + 1] = r[1]; out[i * 8 + 2] = r[2]; out[i * 8 + 3] = r[3];
    out[i * 8 + 4] = d[0] * 0.5; out[i * 8 + 5] = d[1] * 0.5; out[i * 8 + 6] = d[2] * 0.5; out[i * 8 + 7] = d[3] * 0.5;
  });
  return out;
}
// CPU skinning (same math as the vertex shader) — for the checker and for cloth anchors
function skin(m, DQ, out, nout) {
  var P = m.pos, Nn = m.nrm, nv = P.length / 3, bi = m.bi, bw = m.bw, one = m.bone;
  out = out || new Float32Array(nv * 3);
  for (var v = 0; v < nv; v++) {
    var r0, r1, r2, r3, d0, d1, d2, d3;
    if (bi) {
      var b0 = bi[v * 4] * 8, w = bw[v * 4];
      var q0 = DQ[b0], q1 = DQ[b0 + 1], q2 = DQ[b0 + 2], q3 = DQ[b0 + 3];
      r0 = q0 * w; r1 = q1 * w; r2 = q2 * w; r3 = q3 * w; d0 = DQ[b0 + 4] * w; d1 = DQ[b0 + 5] * w; d2 = DQ[b0 + 6] * w; d3 = DQ[b0 + 7] * w;
      for (var k = 1; k < 4; k++) {
        w = bw[v * 4 + k]; if (w <= 0) continue;
        var bb = bi[v * 4 + k] * 8; if (DQ[bb] * q0 + DQ[bb + 1] * q1 + DQ[bb + 2] * q2 + DQ[bb + 3] * q3 < 0) w = -w;
        r0 += DQ[bb] * w; r1 += DQ[bb + 1] * w; r2 += DQ[bb + 2] * w; r3 += DQ[bb + 3] * w; d0 += DQ[bb + 4] * w; d1 += DQ[bb + 5] * w; d2 += DQ[bb + 6] * w; d3 += DQ[bb + 7] * w;
      }
      var l = sqrt(r0 * r0 + r1 * r1 + r2 * r2 + r3 * r3); r0 /= l; r1 /= l; r2 /= l; r3 /= l; d0 /= l; d1 /= l; d2 /= l; d3 /= l;
    } else { var o = (one || 0) * 8; r0 = DQ[o]; r1 = DQ[o + 1]; r2 = DQ[o + 2]; r3 = DQ[o + 3]; d0 = DQ[o + 4]; d1 = DQ[o + 5]; d2 = DQ[o + 6]; d3 = DQ[o + 7]; }
    var x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    // p' = p + 2 r×(r×p + w p) + 2 (w d - dw r + r×d)
    var cx = r1 * z - r2 * y + r3 * x, cy = r2 * x - r0 * z + r3 * y, cz = r0 * y - r1 * x + r3 * z;
    out[v * 3] = x + 2 * (r1 * cz - r2 * cy) + 2 * (r3 * d0 - d3 * r0 + r1 * d2 - r2 * d1);
    out[v * 3 + 1] = y + 2 * (r2 * cx - r0 * cz) + 2 * (r3 * d1 - d3 * r1 + r2 * d0 - r0 * d2);
    out[v * 3 + 2] = z + 2 * (r0 * cy - r1 * cx) + 2 * (r3 * d2 - d3 * r2 + r0 * d1 - r1 * d0);
    if (nout) { x = Nn[v * 3]; y = Nn[v * 3 + 1]; z = Nn[v * 3 + 2]; cx = r1 * z - r2 * y + r3 * x; cy = r2 * x - r0 * z + r3 * y; cz = r0 * y - r1 * x + r3 * z;
      nout[v * 3] = x + 2 * (r1 * cz - r2 * cy); nout[v * 3 + 1] = y + 2 * (r2 * cx - r0 * cz); nout[v * 3 + 2] = z + 2 * (r0 * cy - r1 * cx); }
  }
  return out;
}

/* ================= hair =================
   Cap: the head SDF offset outward inside a hairline region, smooth-unioned with the bun; polygonized, and the
   part that dives under the skin trimmed (an embedded rim). Strands: thin ribbons traced along a comb-flow field
   on the cap (scalp: swept up to the bun; bun: wrapped around it), each in its own height layer. */
var HAIR = {};   // from figure.json (hair styles: bun ellipsoids, hairline, thickness, strand count)
function hairline(H, az) {   // hairline height (head-local y) by azimuth (0 = front)
  var a = abs(az), L = H.line;
  for (var i = 1; i < L.length; i++) if (a <= L[i][0]) { var t = (a - L[i - 1][0]) / (L[i][0] - L[i - 1][0]); t = t * t * (3 - 2 * t); return mix(L[i - 1][1], L[i][1], t); }
  return L[L.length - 1][1];
}
function hairTree(sk, H, bodyF) {
  var O = sk.O, hc = [0, 0.02, -0.012];
  var cap = Fn(function (x, y, z) {
    var X = x - O[0], Y = y - O[1], Z = z - O[2], az = Math.atan2(X, Z - hc[2]), hy = hairline(H, az);
    // region: above the hairline; clear of the ears
    var reg = (hy - Y) * 0.8, ed = sqrt(sq(abs(X) - 0.072) + sq(Y + 0.01) * 0.5 + sq(Z + 0.01)) - 0.03;
    reg = max(reg, -ed);
    var up = smooth(hy, hy + 0.012, Y), t = H.thick * (0.35 + 0.65 * up) + 0.0015 * smooth(0.05, 0.11, Y);
    t += (H.volume || 0) * smooth(hy, hy + 0.035, Y);   // hair mass: thin at the hairline, full over the crown, sides and back
    return max(bodyF(x, y, z, 1) - t, reg);
  }, add(O, [0, 0.03, -0.01]), 0.17);
  var buns = H.bun.map(function (b) { return Ell(add(O, [b[0], b[1], b[2]]), [b[3], b[4], b[5]]); });
  var temples = [1, -1].map(function (s) { return Ell(add(O, [0.058 * s, 0.045, 0.012]), [0.022, 0.03, 0.04]); });
  // 鬢: the side masses swept out wide over the temples and the top of the ears, and a full rounded mass at the back;
  // each is held to a band just outside the scalp cap (so it reads as hair over the head, never a floating blob)
  var sv = H.side || 0, bv = H.back || 0, masses = [];
  if (sv) [1, -1].forEach(function (s) { masses.push(Ell(add(O, [0.066 * s, 0.03, -0.004]), [0.034 * sv, 0.048 * sv, 0.05 * sv])); });
  if (bv) masses.push(Ell(add(O, [0, 0.045, -0.062]), [0.07 * bv, 0.062 * bv, 0.045 * bv]));
  var hold = function (m) { return Int(0.008, m, Fn(function (x, y, z) { return max(bodyF(x, y, z, 1) - 0.028, O[1] - 0.025 - y); }, m.c, m.r)); };   // within 28 mm of the head, above mid-ear
  var templesI = temples.map(function (t) { return Int(0.01, t, Fn(function (x, y, z) { return cap.f(x, y, z) - 0.006; }, t.c, t.r)); });
  if (H.masses) {   // editable masses (edit.html): groups of primitives; a group marked held is clipped to the band round the head
    var heldT = [], other = [];
    H.masses.kids.forEach(function (g) { if (g.held) (g.kids || [g]).forEach(function (p) { heldT.push(hold(treeFromJSON(p, sk))); }); else other.push(treeFromJSON(g, sk)); });
    return bounds(U(H.masses.k, [U(H.temple, [cap].concat(templesI).concat(heldT))].concat(other)));
  }
  var held = masses.map(hold);
  return bounds(U(H.bunK, [U(H.temple, [cap].concat(temples.map(function (t) { return Int(0.01, t, Fn(function (x, y, z) { return cap.f(x, y, z) - 0.006; }, t.c, t.r)); })).concat(held)), U(0.02, buns)]));
}
// a hair style's masses as editable primitives (edit.html): the bun ellipsoids, and the side / back masses (held), from the
// older parameters; exactly the same shape as those parameters build
function hairMasses(H, O, id0) {
  var id = id0 || 9001, P = function (c, r) { return { id: id++, type: 'ellipsoid', c: add(O, c), r: r, u: [1, 0, 0], v: [0, 1, 0], bone: 'head', sig: 0.02 }; }, sv = H.side || 0, bv = H.back || 0, held = [];
  if (sv) { var L = P([0.066, 0.03, -0.004], [0.034 * sv, 0.048 * sv, 0.05 * sv]), R = P([-0.066, 0.03, -0.004], [0.034 * sv, 0.048 * sv, 0.05 * sv]); L.mirror = R.id; R.mirror = L.id; held.push(L, R); }
  if (bv) held.push(P([0, 0.045, -0.062], [0.07 * bv, 0.062 * bv, 0.045 * bv]));
  return { group: 'hair', op: 'union', k: H.bunK, kids: [{ group: 'side and back (held)', op: 'union', k: 0, held: true, kids: held }, { group: 'buns', op: 'union', k: 0.02, kids: H.bun.map(function (b) { return P([b[0], b[1], b[2]], [b[3], b[4], b[5]]); }) }] };
}
// the bun ellipsoids of a hair style, head-local [x, y, z, rx, ry, rz] (from its masses when edited)
function bunList(H, O) { if (!H.masses) return H.bun; var g = H.masses.kids.find(function (k) { return k.group === 'buns'; }) || H.masses.kids[H.masses.kids.length - 1], out = [];
  (function walk(n) { if (n.kids) n.kids.forEach(walk); else if (n.c) { var r = n.r.length ? n.r : [n.r, n.r, n.r]; out.push([n.c[0] - O[0], n.c[1] - O[1], n.c[2] - O[2], r[0], r[1], r[2]]); } })(g); return out.length ? out : [[0, 0.13, -0.02, 0.05, 0.05, 0.05]]; }
// the head and neck alone (what the hair sits on): ~half the primitives of the full body, so hair building is faster
function headSDF(def, sk) { var h = findGroup(def.body, 'head'), n = findGroup(def.body, 'neck'); if (!h) return null; return compile(treeFromJSON({ group: 'hairbody', op: 'union', k: 0.022, kids: n ? [h, n] : [h] }, sk)); }
function hairSDF(sk, H, bodyF) { var tree = hairTree(sk, H, bodyF); return { tree: tree, F: (tree.flat = Flat(tree)).full }; }
function buildHair(sk, body, cfg, log) {
  var t0 = Date.now(), H = HAIR[cfg.hair || 'tang'], O = sk.O, bodyF = body.headSdf || body.sdf, hs = hairSDF(sk, H, bodyF), tree = hs.tree, F = hs.F;
  var lo0 = add(O, [-0.13, -0.09, -0.15]), hi0 = add(O, [0.13, 0.27, 0.12]);
  if (H.masses) (function walk(n) { if (n.kids) return n.kids.forEach(walk); var ends = n.c ? [n.c] : [n.a, n.b], r = n.c ? (n.r.length ? max(n.r[0], n.r[1], n.r[2]) : n.r) : max(n.ra, n.rb) * (n.s ? max(n.s[0], n.s[1]) : 1);
    ends.forEach(function (c) { for (var i = 0; i < 3; i++) { lo0[i] = min(lo0[i], c[i] - r); hi0[i] = max(hi0[i], c[i] + r); } }); })(H.masses);   // (edited masses may reach further)
  var raw = polygonize(tree, lo0, hi0, cfg.hairRes || 0.0022);
  // trim what lies under the skin (keep a thin embedded rim so it touches)
  var P = raw.pos, nv = P.length / 3, bd = new Float32Array(nv);
  for (var i = 0; i < nv; i++) bd[i] = bodyF(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], 0.02);
  var j = 0, cap = filterMesh(raw, function () { var a = raw.idx[j], b = raw.idx[j + 1], c = raw.idx[j + 2]; j += 3; return max(bd[a], bd[b], bd[c]) > -0.0006; });
  // flow field + hairline fade
  P = cap.pos; nv = P.length / 3;
  var Nn = cap.nrm, uv = new Float32Array(nv * 4), bunC = add(O, [0, 0.13, -0.01]);
  function flow(p, n) {
    var X = p[0] - O[0], Y = p[1] - O[1], Z = p[2] - O[2], r = sub(p, bunC), onBun = smooth(0.085, 0.115, Y + 0.02 * (Z < -0.03 ? 1 : 0));
    var up = sub(add(bunC, [0, -0.02, 0]), p);                   // scalp: toward the bun base
    var around = cross([0.15, 1, 0.1], r);                        // bun: wrapped (slight spiral)
    var d = add(mul(norm(up), 1 - onBun), mul(norm(around), onBun));
    d = sub(d, mul(n, dot(d, n))); return norm(d);
  }
  for (i = 0; i < nv; i++) {
    var p = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], n = [Nn[i * 3], Nn[i * 3 + 1], Nn[i * 3 + 2]], f = flow(p, n), d = bodyF(p[0], p[1], p[2], 0.02);
    uv[i * 4] = f[0]; uv[i * 4 + 1] = f[1]; uv[i * 4 + 2] = f[2]; uv[i * 4 + 3] = smooth(0.0002, 0.0032, d);
  }
  cap.uv = uv; cap.bone = sk.by.head;
  // strands: area-weighted roots, traced along the flow, kept at a per-layer height above the cap
  var R = rng(cfg.seed || 7), tri = cap.idx, area = [], tot = 0;
  for (i = 0; i < tri.length; i += 3) { var a = tri[i] * 3, b = tri[i + 1] * 3, c = tri[i + 2] * 3;
    var ar = len(cross([P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]])) / 2; tot += ar; area.push(tot); }
  function gradF(x, y, z) { var e = 1e-4; return norm([F(x + e, y, z, 1) - F(x - e, y, z, 1), F(x, y + e, z, 1) - F(x, y - e, z, 1), F(x, y, z + e, 1) - F(x, y, z - e, 1)]); }
  var pos = [], nrm = [], suv = [], aux = [], idx = [], NS = cfg.strands || H.strands, SEG = 14, layers = 18;
  for (var sI = 0; sI < NS; sI++) {
    var u = R() * tot, lo = 0, hi = area.length - 1; while (lo < hi) { var md = (lo + hi) >> 1; if (area[md] < u) lo = md + 1; else hi = md; }
    var r1 = R(), r2 = R(); if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
    var A0 = tri[lo * 3] * 3, B0 = tri[lo * 3 + 1] * 3, C0 = tri[lo * 3 + 2] * 3, q = [];
    for (var k = 0; k < 3; k++) q.push(P[A0 + k] + (P[B0 + k] - P[A0 + k]) * r1 + (P[C0 + k] - P[A0 + k]) * r2);
    if (bodyF(q[0], q[1], q[2], 0.02) < 0.0025) continue;   // no roots on the trimmed rim
    var layer = sI % layers, hgt = 0.0005 + layer * 0.00016, w = 0.0007 + R() * 0.0009, L = 0.035 + R() * 0.07, step = L / SEG, base = pos.length / 3, tone = R();
    var pts = [], ok = true;
    for (k = 0; k <= SEG; k++) {
      var g, dd;
      for (var it = 0; it < 4; it++) { g = gradF(q[0], q[1], q[2]); dd = F(q[0], q[1], q[2], 1); q = sub(q, mul(g, dd)); if (abs(dd) < 2e-5) break; }   // onto the cap surface
      var hk = k === 0 ? -0.0016 : hgt, pk = add(q, mul(g, hk));   // root embedded, then straight up to its layer height
      if (k) for (it = 0; it < 3 && F(pk[0], pk[1], pk[2], 1) < hgt * 0.9; it++) pk = add(pk, mul(gradF(pk[0], pk[1], pk[2]), hgt - F(pk[0], pk[1], pk[2], 1)));   // (in creases too)
      pts.push({ p: pk, n: g });
      var fl = flow(q, g); fl = norm(add(fl, mul([R() - 0.5, R() - 0.5, R() - 0.5], 0.25)));
      q = add(q, mul(fl, step));
    }
    for (k = 0; k <= SEG; k++) {
      var t = pts[k], tg = norm(sub(pts[min(k + 1, SEG)].p, pts[max(k - 1, 0)].p)), side = norm(cross(tg, t.n)), ww = w * (1 - 0.7 * k / SEG);
      [-1, 1].forEach(function (sd) { var pp = add(t.p, mul(side, sd * ww / 2)); pos.push(pp[0], pp[1], pp[2]); nrm.push(t.n[0], t.n[1], t.n[2]); suv.push(tg[0], tg[1], tg[2], k / SEG); aux.push(tone, sd, layer / layers, 1); });
      if (k < SEG) { var v0 = base + k * 2; idx.push(v0, v0 + 1, v0 + 2, v0 + 1, v0 + 3, v0 + 2); }
    }
  }
  var strands = { pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(suv), aux: new Float32Array(aux), idx: new Uint32Array(idx), bone: sk.by.head, seg: SEG };
  if (log) log('hair: cap ' + nv + ' verts, ' + (pos.length / 3 / (SEG + 1) / 2) + ' strands, ' + (Date.now() - t0) + 'ms');
  return { cap: cap, strands: strands, sdf: F };
}

/* ================= garments =================
   Skinned shells (the skirt band) copy the weights of the nearest body vertex. Cloth is a particle grid
   (verlet + position constraints) whose pinned rows follow skinned anchors on the body. */
var COSTUME = {};   // from figure.json (band, skirt, robe, sleeve, shawl, sash dimensions per costume)
// spatial hash over body vertices (bind pose)
function VHash(P, cell) {
  var m = new Map(), n = P.length / 3;
  function key(x, y, z) { return (floor(x / cell) + 512) * 1048576 + (floor(y / cell) + 512) * 1024 + (floor(z / cell) + 512); }
  for (var i = 0; i < n; i++) { var k = key(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]), a = m.get(k); if (a) a.push(i); else m.set(k, [i]); }
  return { near: function (p, R) {   // nearest vertex within R
    var best = -1, bd = R * R, r = Math.ceil(R / cell), cx = floor(p[0] / cell), cy = floor(p[1] / cell), cz = floor(p[2] / cell);
    for (var dx = -r; dx <= r; dx++) for (var dy = -r; dy <= r; dy++) for (var dz = -r; dz <= r; dz++) {
      var a = m.get((cx + dx + 512) * 1048576 + (cy + dy + 512) * 1024 + (cz + dz + 512)); if (!a) continue;
      for (var j = 0; j < a.length; j++) { var v = a[j], d = sq(P[v * 3] - p[0]) + sq(P[v * 3 + 1] - p[1]) + sq(P[v * 3 + 2] - p[2]); if (d < bd) { bd = d; best = v; } }
    }
    return best;
  } };
}
// body surface point on a horizontal ray from the axis (cx, cz) at height y, azimuth th (0 = front): the first exit
// going outward (so the arms, away from the torso in the bind pose, are never hit)
function surfaceRay(F, y, th, c) {
  var dx = sin(th), dz = cos(th), t = 0, lo = 0;
  while (t < 0.5 && F(c[0] + dx * t, y, c[1] + dz * t, 1) < 0) { lo = t; t += 0.002; }
  var hi = t; for (var i = 0; i < 30; i++) { var m = (lo + hi) / 2; if (F(c[0] + dx * m, y, c[1] + dz * m, 1) < 0) lo = m; else hi = m; }
  return [c[0] + dx * hi, y, c[1] + dz * hi];
}
// convex-hull helpers (Song garments): fabric spans hollows instead of tracing them
function upperHull(a, h) {   // a: increasing parameters, h: heights → the upper convex hull's height at each a (≥ h)
  var H = [];
  for (var i = 0; i < a.length; i++) { while (H.length >= 2) { var o = H[H.length - 2], b = H[H.length - 1]; if ((a[b] - a[o]) * (h[i] - h[o]) - (h[b] - h[o]) * (a[i] - a[o]) >= 0) H.pop(); else break; } H.push(i); }
  var out = h.slice(), k = 0;
  for (i = 0; i < a.length; i++) { while (k + 1 < H.length - 1 && a[H[k + 1]] < a[i]) k++; var p = H[k], q = H[min(k + 1, H.length - 1)]; out[i] = p === q ? h[p] : max(h[i], h[p] + (h[q] - h[p]) * (a[i] - a[p]) / (a[q] - a[p])); }
  return out;
}
function liftCurve(P, N) {   // points along a curve, lifted along N onto the upper hull of their heights (an open curve spans its dips)
  var a = [0], h = P.map(function (p) { return dot(p, N); });
  for (var i = 1; i < P.length; i++) a.push(a[i - 1] + len(sub(P[i], P[i - 1])) + 1e-9);
  var u = upperHull(a, h); return P.map(function (p, i) { return add(p, mul(N, u[i] - h[i])); });
}
function hullRing(P, c) {   // a closed ring of points around the vertical axis through c = [x, z]: each pushed out to the ring's 2D convex hull
  var pts = P.map(function (p, i) { return [p[0], p[2], i]; }).sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; }), cr = function (o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }, lo = [], hi = [];
  pts.forEach(function (q) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); });
  pts.slice().reverse().forEach(function (q) { while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); });
  var Hl = lo.slice(0, -1).concat(hi.slice(0, -1));
  return P.map(function (p) { var dx = p[0] - c[0], dz = p[2] - c[1], L = Math.hypot(dx, dz) || 1, ux = dx / L, uz = dz / L, best = L;
    for (var i = 0; i < Hl.length; i++) { var A = Hl[i], B = Hl[(i + 1) % Hl.length], ex = B[0] - A[0], ez = B[1] - A[1], den = ux * ez - uz * ex; if (abs(den) < 1e-12) continue;
      var t = ((A[0] - c[0]) * ez - (A[1] - c[1]) * ex) / den, sP = ((A[0] - c[0]) * uz - (A[1] - c[1]) * ux) / den; if (t > 0 && sP >= -1e-9 && sP <= 1 + 1e-9) best = max(best, t); }
    return [c[0] + ux * best, p[1], c[1] + uz * best]; });
}
function sdfGrad(F, p) { var e = 1e-4; return norm([F(p[0] + e, p[1], p[2], 1) - F(p[0] - e, p[1], p[2], 1), F(p[0], p[1] + e, p[2], 1) - F(p[0], p[1] - e, p[2], 1), F(p[0], p[1], p[2] + e, 1) - F(p[0], p[1], p[2] - e, 1)]); }
// Anchors: points riding on the skinned body (bind pos + weights of the nearest body vertex)
function Anchors(body) { this.body = body; this.pos = []; this.bi = []; this.bw = []; this.hash = body.hash || (body.hash = VHash(body.pos, 0.01)); }
Anchors.prototype.add = function (p, wfrom) {
  var v = this.hash.near(wfrom || p, 0.05), i = this.pos.length / 3;
  this.pos.push(p[0], p[1], p[2]);
  for (var k = 0; k < 4; k++) { this.bi.push(v >= 0 ? this.body.bi[v * 4 + k] : 0); this.bw.push(v >= 0 ? this.body.bw[v * 4 + k] : (k ? 0 : 1)); }
  return i;
};
Anchors.prototype.addBone = function (p, bone) {   // a point carried rigidly by one bone
  var i = this.pos.length / 3; this.pos.push(p[0], p[1], p[2]); this.bi.push(bone, 0, 0, 0); this.bw.push(1, 0, 0, 0); return i;
};
Anchors.prototype.finish = function () { this.mesh = { pos: new Float32Array(this.pos), bi: new Uint8Array(this.bi), bw: new Float32Array(this.bw) }; this.cur = new Float32Array(this.pos.length); return this; };
Anchors.prototype.update = function (DQ) { skin(this.mesh, DQ, this.cur); return this.cur; };

// a skinned shell: rings of surface points offset along the normal; returns a mesh with copied weights
function shellMesh(body, rings, off, thick, norms, wpts) {   // (wpts: optional points to take the skin weights from, e.g. the body surface under a lifted shell)   // (norms: optional per-point normals, for shells that are not on the surface)
  var nu = rings[0].length, nr = rings.length, pos = [], nrm = [], uv = [], bi = [], bw = [], idx = [], F = body.sdf, hash = body.hash || (body.hash = VHash(body.pos, 0.01));
  function vert(p, n, u, v, wp) {
    var q = add(p, mul(n, off)), b = hash.near(wp || p, 0.05);
    pos.push(q[0], q[1], q[2]); nrm.push(n[0], n[1], n[2]); uv.push(u, v, 0, 0);
    for (var k = 0; k < 4; k++) { bi.push(body.bi[b * 4 + k]); bw.push(body.bw[b * 4 + k]); }
    return pos.length / 3 - 1;
  }
  var grid = [];
  // the seam column is duplicated (u = 1) so no triangle wraps from u ≈ 1 back to 0 (that would squeeze the whole pattern
  // into one strip and break the texture derivatives)
  for (var r = 0; r < nr; r++) { grid.push([]); for (var i = 0; i <= nu; i++) { var p = rings[r][i % nu], n = norms ? norms[r][i % nu] : sdfGrad(F, p); grid[r].push({ p: p, n: n, w: wpts ? wpts[r][i % nu] : null, v: vert(p, n, i / nu, r / (nr - 1), wpts ? wpts[r][i % nu] : null) }); } }
  for (r = 0; r + 1 < nr; r++) for (i = 0; i < nu; i++) { var a = grid[r][i].v, b = grid[r][i + 1].v, c = grid[r + 1][i].v, d = grid[r + 1][i + 1].v; idx.push(a, c, b, b, c, d); }
  // thickness: turned-in edges top and bottom (a folded hem)
  [0, nr - 1].forEach(function (r, e) {
    var vs = grid[r].map(function (g, i) { var dn = mul([0, e ? -1 : 1, 0], 1); return vert(add(g.p, mul(g.n, -thick)), dn, i / nu, e, g.w); });
    var vo = grid[r].map(function (g, i) { var dn = [0, e ? -1 : 1, 0]; var q = add(g.p, mul(g.n, off)); var b = hash.near(g.w || g.p, 0.05); pos.push(q[0], q[1], q[2]); nrm.push(dn[0], dn[1], dn[2]); uv.push(i / nu, e, 0, 0); for (var k = 0; k < 4; k++) { bi.push(body.bi[b * 4 + k]); bw.push(body.bw[b * 4 + k]); } return pos.length / 3 - 1; });
    for (var i = 0; i < nu; i++) { var a = vo[i], b = vo[i + 1], c = vs[i], d = vs[i + 1]; if (e) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c); }
  });
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(uv), bi: new Uint8Array(bi), bw: new Float32Array(bw), idx: new Uint32Array(idx) };
}

/* ---- cloth ---- */
function Cloth(o) {
  var n = o.nu * o.nv; this.o = o; this.name = o.name; this.nu = o.nu; this.nv = o.nv; this.wrap = !!o.wrap; this.n = n;
  this.x = new Float32Array(o.X0); this.px = new Float32Array(o.X0); this.X0 = new Float32Array(o.X0);
  this.w = new Float32Array(n).fill(1); this.pin = new Int32Array(n).fill(-1); this.pinOff = new Float32Array(n * 3);
  var self = this, C = [], R = [], K = [];
  function idx(u, v) { if (self.wrap) u = (u + o.nu) % o.nu; else if (u < 0 || u >= o.nu) return -1; return v < 0 || v >= o.nv ? -1 : v * o.nu + u; }
  this.idx = idx;
  function con(a, b, k) { if (a < 0 || b < 0) return; C.push(a, b); R.push(sqrt(sq(o.X0[a * 3] - o.X0[b * 3]) + sq(o.X0[a * 3 + 1] - o.X0[b * 3 + 1]) + sq(o.X0[a * 3 + 2] - o.X0[b * 3 + 2])) * (o.restScale ? o.restScale(a, b) : 1)); K.push(k); }
  for (var v = 0; v < o.nv; v++) for (var u = 0; u < o.nu; u++) {
    var i = idx(u, v);
    con(i, idx(u + 1, v), 1); con(i, idx(u, v + 1), 1);
    con(i, idx(u + 1, v + 1), o.shear || 0.5); con(idx(u + 1, v), idx(u, v + 1), o.shear || 0.5);
    con(i, idx(u + 2, v), o.bend || 0.15); con(i, idx(u, v + 2), o.bend || 0.15);
  }
  this.C = new Int32Array(C); this.R = new Float32Array(R); this.K = new Float32Array(K);
}
Cloth.prototype.pinTo = function (i, anchor, off) { this.pin[i] = anchor; this.w[i] = 0; if (off) this.pinOff.set(off, i * 3); };
// long-range attachments (no stretching beyond the rest path to the nearest pinned particle along the v direction)
Cloth.prototype.lra = function () {
  var o = this.o, X = this.X0, L = [], D = [];
  for (var u = 0; u < o.nu; u++) {
    var acc = new Float64Array(o.nv); for (var v = 1; v < o.nv; v++) { var a = (v - 1) * o.nu + u, b = v * o.nu + u; acc[v] = acc[v - 1] + sqrt(sq(X[a * 3] - X[b * 3]) + sq(X[a * 3 + 1] - X[b * 3 + 1]) + sq(X[a * 3 + 2] - X[b * 3 + 2])); }
    for (v = 0; v < o.nv; v++) {
      var i = v * o.nu + u; if (this.pin[i] >= 0) continue;
      var best = -1, bd = 1e9; for (var w = 0; w < o.nv; w++) { var j = w * o.nu + u; if (this.pin[j] >= 0 && abs(acc[w] - acc[v]) < bd) { bd = abs(acc[w] - acc[v]); best = j; } }
      if (best >= 0) { L.push(i, best); D.push(bd * 1.03); }
    }
  }
  this.L = new Int32Array(L); this.LD = new Float32Array(D);
};
// triangles of the grid (for rendering / checks)
Cloth.prototype.tris = function () {
  var T = [], o = this.o, idx = this.idx;
  for (var v = 0; v + 1 < o.nv; v++) for (var u = 0; u < (this.wrap ? o.nu : o.nu - 1); u++) { var a = idx(u, v), b = idx(u + 1, v), c = idx(u, v + 1), d = idx(u + 1, v + 1); T.push(a, b, c, b, d, c); }
  return new Uint32Array(T);
};

// colliders: the body's own primitives (round cones, ellipsoids), carried rigidly by their bones, inflated
function colliders(body, sk) {
  var L = leaves(body.tree).filter(function (l) { return (l.t === 1 || l.t === 2) && l.bone != null && l.r > 0.012; }), out = [];
  var skip = /^(jaw|tongue|lip|corner|cheek|brow|eye|lid|thumb|index|middle|ring|pinky|toe)/;
  L.forEach(function (l) {
    var bn = sk.bones[l.bone].name; if (skip.test(bn)) return;
    if (l.t === 1) { var p = l.prm; out.push({ t: 1, bone: l.bone, a: [p[0], p[1], p[2]], b: [p[0] + p[3], p[1] + p[4], p[2] + p[5]], ra: p[10], rb: p[11], c: l.c, r: l.r }); }
    else { var q = l.prm; out.push({ t: 2, bone: l.bone, c: [q[0], q[1], q[2]], ax: [norm([q[3], q[4], q[5]]), norm([q[6], q[7], q[8]]), norm([q[9], q[10], q[11]])], rad: [1 / q[12], 1 / q[13], 1 / q[14]], r: l.r }); }
  });
  return out;
}
function poseColliders(cols, sk, W, margin) {
  return cols.map(function (c) {
    var b = sk.bones[c.bone], q = W.q[c.bone], P = W.p[c.bone], tf = function (x) { return add(P, qrot(q, sub(x, b.p))); };
    if (c.t === 1) return { t: 1, a: tf(c.a), b: tf(c.b), ra: c.ra + margin, rb: c.rb + margin, c: tf(c.c), r: c.r + margin };
    return { t: 2, c: tf(c.c), ax: c.ax.map(function (a) { return qrot(q, a); }), rad: c.rad.map(function (r) { return r + margin; }), r: c.r + margin };
  });
}
function collide(x, i, cols) {   // push particle i of x out of all colliders; returns true if touched
  var px = x[i * 3], py = x[i * 3 + 1], pz = x[i * 3 + 2], hit = false;
  for (var k = 0; k < cols.length; k++) {
    var c = cols[k], dx = px - c.c[0], dy = py - c.c[1], dz = pz - c.c[2];
    if (dx * dx + dy * dy + dz * dz > c.r * c.r) continue;
    if (c.t === 1) {
      var ab0 = c.b[0] - c.a[0], ab1 = c.b[1] - c.a[1], ab2 = c.b[2] - c.a[2], l2 = ab0 * ab0 + ab1 * ab1 + ab2 * ab2;
      var t = clamp(((px - c.a[0]) * ab0 + (py - c.a[1]) * ab1 + (pz - c.a[2]) * ab2) / l2, 0, 1);
      var qx = px - (c.a[0] + ab0 * t), qy = py - (c.a[1] + ab1 * t), qz = pz - (c.a[2] + ab2 * t), d = sqrt(qx * qx + qy * qy + qz * qz), r = c.ra + (c.rb - c.ra) * t;
      if (d < r && d > 1e-9) { var f = r / d; px = c.a[0] + ab0 * t + qx * f; py = c.a[1] + ab1 * t + qy * f; pz = c.a[2] + ab2 * t + qz * f; hit = true; }
    } else {
      var a0 = (dx * c.ax[0][0] + dy * c.ax[0][1] + dz * c.ax[0][2]) / c.rad[0], a1 = (dx * c.ax[1][0] + dy * c.ax[1][1] + dz * c.ax[1][2]) / c.rad[1], a2 = (dx * c.ax[2][0] + dy * c.ax[2][1] + dz * c.ax[2][2]) / c.rad[2];
      var e = sqrt(a0 * a0 + a1 * a1 + a2 * a2);
      if (e < 1 && e > 1e-9) { a0 = a0 / e * c.rad[0]; a1 = a1 / e * c.rad[1]; a2 = a2 / e * c.rad[2];
        px = c.c[0] + c.ax[0][0] * a0 + c.ax[1][0] * a1 + c.ax[2][0] * a2; py = c.c[1] + c.ax[0][1] * a0 + c.ax[1][1] * a1 + c.ax[2][1] * a2; pz = c.c[2] + c.ax[0][2] * a0 + c.ax[1][2] * a1 + c.ax[2][2] * a2; hit = true; }
    }
  }
  if (hit) { x[i * 3] = px; x[i * 3 + 1] = py; x[i * 3 + 2] = pz; }
  return hit;
}
// a layer field: per (azimuth, height) bin the outer radius of a cloth around a vertical axis; outer layers stay outside it
function Field(na, nh, y0, y1) { this.na = na; this.nh = nh; this.y0 = y0; this.y1 = y1; this.r = new Float32Array(na * nh); this.c = [0, 0]; }
Field.prototype.build = function (cls, c) {
  var na = this.na, nh = this.nh, r = this.r, tmp = new Float32Array(na * nh); this.c = c;
  for (var ci = 0; ci < cls.length; ci++) for (var x = cls[ci].x, n = cls[ci].n, i = 0; i < n; i++) {
    var dx = x[i * 3] - c[0], dz = x[i * 3 + 2] - c[1], a = Math.atan2(dx, dz), hb = floor((x[i * 3 + 1] - this.y0) / (this.y1 - this.y0) * nh), ab = floor((a / (2 * PI) + 0.5) * na) % na;
    if (hb < 0 || hb >= nh) continue; var rr = sqrt(dx * dx + dz * dz); if (rr > tmp[hb * na + ab]) tmp[hb * na + ab] = rr;
  }
  for (var h = 0; h < nh; h++) for (var a2 = 0; a2 < na; a2++) {   // dilate (neighbors) so gaps between particles are covered
    var m = 0; for (var dh = -1; dh <= 1; dh++) for (var da = -1; da <= 1; da++) { var hh = h + dh; if (hh < 0 || hh >= nh) continue; m = max(m, tmp[hh * na + (a2 + da + na) % na]); }
    r[h * na + a2] = m;
  }
};
Field.prototype.push = function (x, i, gap) {
  var dx = x[i * 3] - this.c[0], dz = x[i * 3 + 2] - this.c[1], a = Math.atan2(dx, dz), hb = floor((x[i * 3 + 1] - this.y0) / (this.y1 - this.y0) * this.nh);
  if (hb < 0 || hb >= this.nh) return false;
  var R = this.r[hb * this.na + floor((a / (2 * PI) + 0.5) * this.na) % this.na]; if (!R) return false;
  var rr = sqrt(dx * dx + dz * dz); if (rr >= R + gap) return false;
  var f = (R + gap) / max(rr, 1e-6); x[i * 3] = this.c[0] + dx * f; x[i * 3 + 2] = this.c[1] + dz * f; return true;
};

function buildGarments(sk, body, cfg, log) {
  var t0 = Date.now(), C = COSTUME[cfg.costume || 'tang'], F = body.sdf, A = new Anchors(body), G = { cloths: [], parts: [] }, ax = [0, -0.008];
  // band top line: front, back and (optional) side heights — it passes over the chest in front and under the arms
  function bandTop(th) { var c = cos(th), sd = C.band.side != null ? C.band.side : (C.band.top[0] + C.band.top[1]) / 2; return c > 0 ? mix(sd, C.band.top[0], c) : mix(sd, C.band.top[1], c * c); }
  // --- band (裙腰): skinned shell around the chest ---
  var NB = 96, rings = [];
  var NBR = C.band.rows || 4;   // (more rows for a tall band, e.g. the Song 抹胸, so it follows the bust)
  for (var r = 0; r < NBR; r++) { var ring = []; for (var j = 0; j < NB; j++) { var th = PI + 2 * PI * j / NB; ring.push(surfaceRay(F, bandTop(th) - C.band.h * r / (NBR - 1), th, ax)); } rings.push(ring); }
  if (C.band.hull) {   // (Song 抹胸) fabric, not paint: off the skin, spanning the cleavage and the hollow under the bust (each column
    // lifted onto its convex profile, each ring onto its 2D hull, blended with the body by 'hull'), gentle folds lower down
    var BH = C.band.hull, rc = [ax[0], ax[1]], br = rings.map(function (rg) { return rg.map(function (p) { return p.slice(); }); });
    for (j = 0; j < NB; j++) { th = PI + 2 * PI * j / NB; var col = liftCurve(br.map(function (rg) { return rg[j]; }), [sin(th), 0, cos(th)]); col.forEach(function (p, r2) { br[r2][j] = p; }); }
    br = br.map(function (rg) { return hullRing(rg, rc); });
    var bandN = [], bandP = [];
    for (r = 0; r < NBR; r++) { bandP.push([]); for (j = 0; j < NB; j++) { th = PI + 2 * PI * j / NB; var q0 = rings[r][j], qh = br[r][j], rb0 = Math.hypot(q0[0] - rc[0], q0[2] - rc[1]), rbh = Math.hypot(qh[0] - rc[0], qh[2] - rc[1]), tv = r / (NBR - 1);
      var wave = (C.band.wave || 0) * (0.35 + 0.65 * tv) * sin(th * 17 + 1.7 * sin(th * 5) + tv * 1.3), rr = mix(rb0, rbh, BH) + C.band.off + wave;
      bandP[r].push([rc[0] + sin(th) * rr, q0[1], rc[1] + cos(th) * rr]); } }
    for (r = 0; r < NBR; r++) { bandN.push([]); for (j = 0; j < NB; j++) { var t1 = sub(bandP[r][(j + 1) % NB], bandP[r][(j + NB - 1) % NB]), t2 = sub(bandP[min(r + 1, NBR - 1)][j], bandP[max(r - 1, 0)][j]), nn = norm(cross(t1, t2));
      th = PI + 2 * PI * j / NB; if (dot(nn, [sin(th), 0, cos(th)]) < 0) nn = mul(nn, -1); bandN[r].push(nn); } }
    G.band = shellMesh(body, bandP, 0, C.band.thick, bandN, rings); G.bandR = function (th2, y2) {   // the band's outer radius in direction th2 at height y2 (for the belt)
      var jj = Math.round(((th2 - PI) / (2 * PI) % 1 + 1) % 1 * NB) % NB, t = (bandTop(th2) - y2) / C.band.h * (NBR - 1), r0 = clamp(floor(t), 0, NBR - 2), f = clamp(t - r0, 0, 1);
      return mix(Math.hypot(bandP[r0][jj][0] - rc[0], bandP[r0][jj][2] - rc[1]), Math.hypot(bandP[r0 + 1][jj][0] - rc[0], bandP[r0 + 1][jj][2] - rc[1]), f); };
  } else
  G.band = shellMesh(body, rings, C.band.off, C.band.thick);
  // --- skirt: gathered tube from just under the band to the floor ---
  var S = C.skirt, nu = S.nu, nv = S.nv, X = new Float32Array(nu * nv * 3), PINR = 3, pins = [], follow = [];
  // the pinned rows follow the drape from the band's lower edge over the bust (the upper tangent of the body profile in
  // that direction), so the fabric tents over the bust instead of hugging under it; the free rows start below the apex
  var prof = function (y, th) { var sp = surfaceRay(F, y, th, ax); return sqrt(sq(sp[0] - ax[0]) + sq(sp[2] - ax[1])); };
  for (j = 0; j < nu; j++) {
    th = PI + 2 * PI * j / nu; var y0 = bandTop(th) - C.band.h, r0 = prof(y0, th) + S.off, slope = 0, yT = y0 - 0.044;
    for (var yy = y0 - 0.01; yy > y0 - 0.2; yy -= 0.005) { var sl = (prof(yy, th) + S.off + 0.006 - r0) / (y0 - yy); if (sl > slope) { slope = sl; yT = min(yy, y0 - 0.044); } }
    var front = smooth(0.25, 0.65, cos(th)); slope *= front; yT = mix(y0 - 0.044, yT, front);   // tent only over the bust, hug the sides (the arms rest there)
    var rTop = 0, yLast = 0;
    for (var v = 0; v < nv; v++) {
      var y, q;
      if (v < PINR) {
        y = y0 - (y0 - yT) * v / (PINR - 1); var sp = surfaceRay(F, y, th, ax), rS = sqrt(sq(sp[0] - ax[0]) + sq(sp[2] - ax[1])), n = sdfGrad(F, sp);
        var rr0 = max(rS + S.off + v * 0.0012 + front * 0.0015 * v, r0 + slope * (y0 - y) + (v ? 0.002 + 0.002 * front : 0), rTop * (v ? 0.995 : 0)); rTop = rr0; yLast = y;   // extra leeway over the bust
        q = [ax[0] + sin(th) * rr0, y, ax[1] + cos(th) * rr0];
        if (v === 0) q = add(sp, mul(n, S.off));
        pins.push([v * nu + j, A.add(q, sp)]);
      } else {
        var t = (v - PINR + 1) / (nv - PINR); y = mix(yLast, S.hemY, t);
        var rr = 0.155 + (S.hemR - 0.155) * Math.pow(t, 1.35); rr = max(rr, rTop + 0.01 * (v - PINR + 1), prof(y, th) + 0.006);
        q = [ax[0] + sin(th) * rr, y, ax[1] + cos(th) * rr];
        if (v < PINR + 6) { var fj = (v - PINR) / 6; follow.push([v * nu + j, A.add(q, surfaceRay(F, y, th, ax)), 0.3 * sq(1 - fj)]); }   // the bodice follows the torso
      }
      X.set(q, (v * nu + j) * 3);
    }
  }
  var skirt = new Cloth({ name: 'skirt', nu: nu, nv: nv, X0: X, wrap: true, bend: 0.25, shear: 0.6, damp: 0.988, iters: 5, mass: 1,
    restScale: function (a, b) { var va = floor(a / nu), vb = floor(b / nu); return va === vb && va >= PINR && va <= PINR + 3 ? 1.22 : 1; } });
  pins.forEach(function (pn) { skirt.pinTo(pn[0], pn[1]); }); skirt.follow = follow;
  skirt.uvw = restUV(skirt, true); skirt.layer = 1; skirt.thick = 0.0012;
  G.cloths.push(skirt);
  // --- gauze robe: hangs from a collar ring over the shoulders, open in front ---
  // --- gauze robe: a yoke over the shoulders; a back panel and two front panels hang from it, open under the arms
  // (the sleeves cover the arms), so no fabric is ever trapped between arm and torso ---
  if (C.robe) {
    var R = C.robe, rows = R.rows || [[0.088, 0.078, 0.0016], [0.099, 0.087, 0.0016], [0.11, 0.096, 0.0016], [0.121, 0.105, 0.0016]], NP = rows.length, RC = (R.nu || 60) / 60;   // robe.nu scales the panels' columns
    var piece = function (name, thA, thB, ncol, hang) { ncol = Math.max(4, Math.round(ncol * RC));
      var nvv = hang ? R.nv : NP, X2 = new Float32Array(ncol * nvv * 3), pinsR = [], ancs = [], softR = [];
      for (j = 0; j < ncol; j++) {
        th = thA + (thB - thA) * j / (ncol - 1);
        ancs.push(rows.map(function (rw) {   // a guess around the neck base, projected onto the nearest body surface
          var sp2 = [sin(th) * rw[0], 1.345 + 0.04 * (1 - cos(th)) / 2 - (rw[0] - 0.088) * 0.5, -0.016 + cos(th) * rw[1]];
          for (var i = 0; i < 30; i++) { var d = F(sp2[0], sp2[1], sp2[2], 1), gg = sdfGrad(F, sp2); sp2 = sub(sp2, mul(gg, d)); if (abs(d) < 1e-6) break; }
          return { s: sp2, p: add(sp2, mul(sdfGrad(F, sp2), rw[2])) };
        }));
      }
      if (R.hull) for (v = 0; v < NP; v++) {   // (Song) each yoke row spans the hollows across the piece too (collarbones, front of the shoulder)
        var rp = ancs.map(function (a2) { return a2[v].p; }), cxz = rp.reduce(function (m, q) { return add(m, [q[0], 0, q[2] + 0.016]); }, [0, 0, 0]);
        liftCurve(rp, norm(cxz)).forEach(function (q, j2) { ancs[j2][v].p = q; });
      }
      for (j = 0; j < ncol; j++) {
        th = thA + (thB - thA) * j / (ncol - 1);
        var anc = ancs[j];
        if (R.hull) {   // (Song) the yoke spans the hollows by the collarbones instead of sinking into them: the row points are lifted
          // onto their upper hull along the column (and stay at least the yoke's offset off the skin)
          var Nh = norm(anc.reduce(function (m, q) { return add(m, sdfGrad(F, q.s)); }, [0, 0, 0])), lifted = liftCurve(anc.map(function (q) { return q.p; }), Nh);
          anc.forEach(function (q, k) { q.p = lifted[k]; });
        }
        var last = anc[NP - 1].p, y1 = last[1], r1 = sqrt(sq(last[0]) + sq(last[2] + 0.016));
        for (v = 0; v < nvv; v++) {
          var q;
          if (v < NP) { q = anc[v].p; if (R.hull && hang && v === NP - 1) softR.push([v * ncol + j, A.add(anc[v].p, anc[v].s)]); else pinsR.push([v * ncol + j, A.add(anc[v].p, anc[v].s)]); }   // (Song: the yoke's last row is carried, not pinned: a gradual hand-over)
          else { var tt = (v - NP + 1) / (nvv - NP), yy = y1 - Math.pow(tt, 1.45) * R.len, rad = min(r1 + 0.009 * (v - NP + 1), max(r1, 0.2 + R.flare * tt)); q = [sin(th) * rad, yy, -0.016 + cos(th) * rad];
            var dq = F(q[0], q[1], q[2], 1); if (dq < 0.008) q = add(q, mul(sdfGrad(F, q), 0.008 - dq)); }
          if (R.hull && v >= NP) {   // (Song: the upper panel lies on the body below the yoke, its clearance growing from the yoke's to R.hull)
            var s5 = projectTo(F, q), c5 = mix(rows[NP - 1][2] + 0.0008, R.hull, smooth(0, 0.1, y1 - q[1])), on5 = add(s5, mul(sdfGrad(F, s5), c5)), dq5 = F(q[0], q[1], q[2], 1);
            if (dq5 < R.hull) q = add(q, mul(sdfGrad(F, q), R.hull - dq5)); q = lerp3(q, on5, smooth(1.0, 1.12, q[1])); }
          X2.set(q, (v * ncol + j) * 3);
        }
        if (R.hull && hang) {   // (Song) the upper panel continues the yoke's spanned line down the column (no ledge below the yoke)
          var vsH = []; for (v = 0; v < nvv && X2[(v * ncol + j) * 3 + 1] > 1.06; v++) vsH.push(v);
          var LP = liftCurve(vsH.map(function (v2) { var i2 = (v2 * ncol + j) * 3; return [X2[i2], X2[i2 + 1], X2[i2 + 2]]; }), Nh);
          vsH.forEach(function (v2, k2) { if (v2 >= NP) X2.set(LP[k2], (v2 * ncol + j) * 3); });
        }
      }
      if (R.hull && hang) for (v = NP; v < nvv; v++) {   // … and spans across the row, over the hollow in front of the shoulder
        var i0 = v * ncol * 3; if (X2[i0 + 1] < 1.06) break; var rowP = [], cx = 0, cz = 0;
        for (j = 0; j < ncol; j++) { rowP.push([X2[i0 + j * 3], X2[i0 + j * 3 + 1], X2[i0 + j * 3 + 2]]); cx += X2[i0 + j * 3]; cz += X2[i0 + j * 3 + 2] + 0.016; }
        var LR = liftCurve(rowP, norm([cx / ncol, 0, cz / ncol])); LR.forEach(function (p2, j2) { X2.set(p2, i0 + j2 * 3); });
      }
      var cl = new Cloth({ name: name, nu: ncol, nv: nvv, X0: X2, wrap: false, bend: 0.08, shear: 0.5, damp: 0.982, iters: 4, drag: 0.6 });
      pinsR.forEach(function (pn) { cl.pinTo(pn[0], pn[1]); });
      // snug at the top: below the yoke the panel rides on the chest / back (full strength down to the bust, fading out
      // by the waist); only the lower part hangs free. Targets carry the torso's skin weights (found toward its axis)
      cl.follow = softR.map(function (q) { return [q[0], q[1], 0.95]; });
      for (v = NP; v < nvv; v++) for (j = 0; j < ncol; j++) { var iq = (v * ncol + j) * 3, yq = X2[iq + 1], kq = R.hull ? 0.9 * smooth(1.0, 1.18, yq) : smooth(1.13, 1.25, yq);   /* (Song: the whole upper panel, sides too, rides on its spanned rest shape) */ if (kq <= 0.01) continue;
        var thq = Math.atan2(X2[iq], X2[iq + 2] + 0.016); if (!R.hull) kq *= smooth(0.3, 0.6, abs(cos(thq))); if (kq <= 0.01) continue; cl.follow.push([v * ncol + j, A.add([X2[iq], yq, X2[iq + 2]], projectTo(F, [X2[iq], yq, X2[iq + 2]])), kq]); }
      cl.uvw = restUV(cl, false); cl.layer = 2; cl.gauze = R.gauze !== false; cl.robe = true;
      if (R.trim) {   // (Song 褙子) uvw.z = arc length from the front edge (front panels; 9 elsewhere) for the 領抹 edge bands
        var ec = name === 'robeFL' ? 0 : name === 'robeFR' ? ncol - 1 : -1;
        for (v = 0; v < nvv; v++) for (j = 0; j < ncol; j++) cl.uvw[(v * ncol + j) * 4 + 2] = ec < 0 ? 9 : abs(cl.uvw[(v * ncol + j) * 4] - cl.uvw[(v * ncol + ec) * 4]);
      }
      G.cloths.push(cl);
    };
    var t1 = 1.12, t2 = 2.05;
    var t0r = R.open || 0.5;
    piece('robeFL', t0r, t1, 14, true); piece('yokeL', t1, t2, 10, false); piece('robeB', t2, 2 * PI - t2, 28, true);
    piece('yokeR', 2 * PI - t2, 2 * PI - t1, 10, false); piece('robeFR', 2 * PI - t1, 2 * PI - t0r, 14, true);
  }
  // --- sleeves: wide tubes from the shoulder seam past the wrist, hanging below the arm ---
  if (C.sleeve) ['L', 'R'].forEach(function (Sd) {
    var a = sk.arms[Sd], M = a.M, Sl = C.sleeve, nu3 = Sl.nu, nv3 = Sl.nv, X3 = new Float32Array(nu3 * nv3 * 3);
    var axis = M(a.dU), base = M(add(a.Sh, mul(a.dU, 0.01))), g = norm(sub([0, -1, 0], mul(axis, dot([0, -1, 0], axis)))), side = norm(cross(axis, g));
    var pins = [], elbowAt = len(sub(a.E, a.Sh)), SA = Sl.arc0 || Sl.arc || 0.6, SA0 = (1 - SA) / 2, closed = SA >= 1;   // arc: the share of the circumference (open underneath; ≥ 1: a closed tube)
    var thOf = function (j, tv) { var ar = mix(Sl.arc0, Sl.arc, smooth(0.2, 0.55, tv)); return 2 * PI * (0.5 - ar / 2 + ar * j / (nu3 - 1)); };   // (arc0: open under the upper arm, closing toward the forearm)
    if (closed) { SA = (nu3 - 1) / nu3; SA0 = 0.5 / nu3; }
    for (j = 0; j < nu3; j++) {
      th = 2 * PI * (SA0 + SA * j / (nu3 - 1)); var dir = add(mul(g, cos(th)), mul(side, sin(th)));
      // seam ring: ray from the shoulder joint outward perpendicular to the arm
      var tt2 = 0.12; for (var i = 0; i < 80; i++) { var pp = add(base, mul(dir, tt2)), d = F(pp[0], pp[1], pp[2], 1); if (d < 2e-5) break; tt2 -= d; if (tt2 < 0) { tt2 = 0; break; } }
      if (closed) { tt2 = 0; while (tt2 < 0.12 && F(base[0] + dir[0] * tt2, base[1] + dir[1] * tt2, base[2] + dir[2] * tt2, 1) < 0) tt2 += 0.0005; }   // (closed: out from the joint, never across into the torso)
      var sp3 = add(base, mul(dir, tt2)), n3 = sdfGrad(F, sp3), ap3 = add(sp3, mul(n3, Sl.off || 0.0009));
      pins.push(A.add(ap3, sp3));
      var nar = [];
      for (v = 0; v < nv3; v++) {
        var tv = v / (nv3 - 1), along = Sl.len * tv, rr2 = mix(Sl.r0, Sl.r1, Math.pow(tv, 0.7)), drop = max(0, rr2 - 0.05);
        var cpt = add(add(base, mul(axis, along)), mul(g, drop));
        var q3 = v === 0 ? ap3 : add(cpt, mul(dir, rr2));
        var wS = smooth(elbowAt * 0.55, elbowAt + 0.08, along);   // over the upper arm the sleeve hugs it (~4 mm off the skin)
        if (v && wS < 1) { var axp = add(base, mul(axis, along)), tA = 0; while (tA < 0.1 && F(axp[0] + dir[0] * tA, axp[1] + dir[1] * tA, axp[2] + dir[2] * tA, 1) < 0) tA += 0.001;   // outward from the arm's axis to its skin (never across to the torso)
          q3 = lerp3(add(axp, mul(dir, tA + 0.0045)), q3, wS); }
        if (v && Sl.narrow) {   // (Song) a narrow sleeve: around the upper arm, then the forearm, a little looser toward the cuff, sagging a little underneath
          if (Sl.arc0) th = thOf(j, tv);
          var onF = along > elbowAt, axN = onF ? M(a.dF) : axis, cN = onF ? M(add(a.E, mul(a.dF, along - elbowAt))) : M(add(a.Sh, mul(a.dU, along))), gN = norm(sub([0, -1, 0], mul(axN, dot([0, -1, 0], axN)))), dN = add(mul(gN, cos(th)), mul(norm(cross(axN, gN)), sin(th))), tN = 0;
          while (tN < 0.1 && F(cN[0] + dN[0] * tN, cN[1] + dN[1] * tN, cN[2] + dN[2] * tN, 1) < 0) tN += 0.0005;
          nar[v] = { c: cN, d: dN, g: gN, t: min(tN, 0.055), along: along, tv: tv, th: th };
          q3 = add(add(cN, mul(dN, tN + 0.0045 + Sl.ease * tv + (Sl.elbowEase || 0.009) * (1 - smooth(0.02, 0.09, abs(along - elbowAt))))), mul(gN, Sl.sag * tv * max(0, cos(th))));   // (+ ease round the elbow, so it bends inside the sleeve)
        }
        if (v) { var dq3 = F(q3[0], q3[1], q3[2], 1); if (dq3 < 0.006) q3 = add(q3, mul(sdfGrad(F, q3), 0.006 - dq3)); }   // hug the arm, never cut into it
        X3.set(q3, (v * nu3 + j) * 3);
      }
      if (Sl.narrow && nar.length > 3) {   // the sleeve spans the arm's grooves (deltoid–biceps, above the elbow): each column's radius is lifted
        // onto its upper convex hull along the arm (which also leaves extra room round the elbow), then eased as above
        var vs = [], tH = []; for (v = 2; v < nv3; v++) if (nar[v]) vs.push(v);
        [vs.filter(function (v2) { return nar[v2].along <= elbowAt; }), vs.filter(function (v2) { return nar[v2].along > elbowAt; })].forEach(function (seg) {   // upper arm and forearm each
          if (seg.length < 2) { seg.forEach(function (v2) { tH.push(nar[v2].t); }); return; } upperHull(seg.map(function (v2) { return nar[v2].along; }), seg.map(function (v2) { return nar[v2].t; })).forEach(function (t2) { tH.push(t2); }); });
        vs.forEach(function (v2, k2) { var o = nar[v2], tt = mix(o.t, max(tH[k2], o.t), 0.8) + 0.0045 + Sl.ease * o.tv + (Sl.elbowEase || 0.009) * (1 - smooth(0.02, 0.09, abs(o.along - elbowAt)));
          var q4 = add(add(o.c, mul(o.d, tt)), mul(o.g, Sl.sag * o.tv * max(0, cos(o.th)))), dq4 = F(q4[0], q4[1], q4[2], 1); if (dq4 < 0.006) q4 = add(q4, mul(sdfGrad(F, q4), 0.006 - dq4)); X3.set(q4, (v2 * nu3 + j) * 3); });
      }
    }
    // the sleeve rests on the arm: its top line (opposite the hanging side) rides on the arm surface up to the wrist
    var topPins = [], elbowAlong = len(sub(a.E, a.Sh)), wristAlong = elbowAlong + len(sub(a.W, a.E));
    for (v = 1; v < nv3; v++) {
      var along2 = Sl.len * v / (nv3 - 1); if (along2 > (Sl.narrow ? wristAlong - 0.035 : elbowAlong - 0.03)) break; if (Sl.narrow && abs(along2 - elbowAlong) < 0.035) continue;   // (narrow: along the forearm too, clear of the elbow)
      var overArmlet = abs(along2 - 0.15) < 0.022;
      var onFore = along2 > elbowAlong, cpt2 = onFore ? M(add(a.E, mul(a.dF, along2 - elbowAlong))) : M(add(a.Sh, mul(a.dU, along2))), ax2 = onFore ? M(a.dF) : axis;
      var gq = norm(sub([0, -1, 0], mul(ax2, dot([0, -1, 0], ax2)))), sq2 = norm(cross(ax2, gq));
      [-1, 0, 1].forEach(function (dj) {
        var jj = floor(nu3 / 2) + dj, th2 = Sl.arc0 ? thOf(jj, v / (nv3 - 1)) : 2 * PI * (SA0 + SA * jj / (nu3 - 1)), dir2 = add(mul(gq, cos(th2)), mul(sq2, sin(th2)));
        var t3 = 0.1; for (var i = 0; i < 80; i++) { var p3 = add(cpt2, mul(dir2, t3)), d3 = F(p3[0], p3[1], p3[2], 1); if (d3 < 2e-5) break; t3 -= d3; if (t3 < 0) { t3 = 0; break; } }
        var s3 = add(cpt2, mul(dir2, t3)), n3b = sdfGrad(F, s3), a3 = add(s3, mul(n3b, overArmlet ? 0.0042 : 0.0009)), idx3 = v * nu3 + jj;
        if (Sl.narrow) a3 = [X3[idx3 * 3], X3[idx3 * 3 + 1], X3[idx3 * 3 + 2]];   // (narrow: pinned on the spanned rest shape, not traced on the skin)
        X3.set(a3, idx3 * 3); topPins.push([idx3, A.add(a3, s3)]);
      });
    }
    var elbowRest = Sl.elbowLen ? function (ia, ib) { var va = floor(ia / nu3), vb = floor(ib / nu3); if (va === vb) return 1; var al = Sl.len * (va + vb) / 2 / (nv3 - 1); return 1 + Sl.elbowLen * (1 - smooth(0.02, 0.07, abs(al - elbowAt))); } : undefined;   // (extra length at the elbow: it bunches on the inside when bent)
    var sl = new Cloth({ name: 'sleeve' + Sd, nu: nu3, nv: nv3, X0: X3, wrap: closed, restScale: elbowRest, bend: Sl.bend || 0.06, shear: 0.5, damp: 0.98, iters: 4, drag: 0.8 });
    // snug over the upper arm (riding on the arm's skin weights), fading out past the elbow, so only the big hanging part swings
    sl.follow = [];
    for (v = 1; v < nv3; v++) { var alongF = Sl.len * v / (nv3 - 1), kF = Sl.narrow ? 0.7 * smooth(0.045, 0.1, abs(alongF - elbowAlong)) : 1 - smooth(elbowAlong * 0.5, elbowAlong - 0.02, alongF); if (kF <= 0.01) continue;   // free before the elbow bends (narrow: carried by the arm all along)
      var axP = M(add(a.Sh, mul(a.dU, min(alongF, elbowAlong - 0.01))));
      for (j = 0; j < nu3; j++) { var iF = (v * nu3 + j) * 3; var pF = [X3[iF], X3[iF + 1], X3[iF + 2]]; sl.follow.push([v * nu3 + j, A.add(pF, projectTo(F, pF)), kF * (1 - (Sl.narrow ? 0.6 : 1) * smooth(0.12, 0.35, abs(j / (nu3 - 1) - 0.5)))]); } }
    for (j = 0; j < nu3; j++) { if (Sl.narrow && cos(2 * PI * (SA0 + SA * j / (nu3 - 1))) > 0.2) continue; sl.pinTo(j, pins[j]); }   // (narrow: the seam is not pinned in the armpit, where the arm folds against the chest)
    topPins.forEach(function (tp) { sl.pinTo(tp[0], tp[1]); });
    sl.uvw = restUV(sl, closed); sl.layer = 3; if (Sl.margin) sl.margin = Sl.margin; if (Sl.limbGrow) sl.limbGrow = Sl.limbGrow;
    if (Sl.elbowMargin) { sl.marginA = new Float32Array(sl.n); for (var im = 0; im < sl.n; im++) sl.marginA[im] = Sl.margin + (Sl.elbowMargin - Sl.margin) * (1 - smooth(0.03, 0.08, abs(Sl.len * floor(im / nu3) / (nv3 - 1) - elbowAt))); }   // (a wider margin round the elbow) sl.gauze = Sl.gauze !== false; sl.side = Sd;
    G.cloths.push(sl);
  });
  // --- shawl (帔帛): across the back, over both forearms, ends hanging ---
  if (C.shawl) {
    var Sh = C.shawl, nu4 = Sh.nu, nv4 = Sh.nv, X4 = new Float32Array(nu4 * nv4 * 3), aL = sk.arms.L;
    var elbowTop = function (s) { var e = aL.M(add(aL.E, mul(aL.dU, -0.075))); return [e[0] * s, e[1] + 0.045, e[2]]; };
    var path = function (u) {   // u in [-1, 1] along the shawl; 0 = back center
      var s = u < 0 ? -1 : 1, a = abs(u), back = [0, 1.19, -0.135], sideB = [0.2 * s, 1.17, -0.1], over = elbowTop(s), hang = [over[0] + 0.03 * s, 0.25, over[2] + 0.07];
      var k1 = 0.25, k2 = 0.45;
      if (a < k1) return lerp3(back, sideB, a / k1);
      if (a < k2) return lerp3(sideB, over, (a - k1) / (k2 - k1));
      return lerp3(over, hang, (a - k2) / (1 - k2));
    };
    var shPins = [];
    for (v = 0; v < nv4; v++) {
      var u = -1 + 2 * v / (nv4 - 1), c0 = path(u), c1 = path(u + 0.01), tg = norm(sub(c1, c0)), wdir = abs(u) < 0.45 ? [0, 1, 0] : norm(cross(tg, [1, 0, 0]));
      wdir = norm(sub(wdir, mul(tg, dot(wdir, tg))));
      for (j = 0; j < nu4; j++) X4.set(add(c0, mul(wdir, (j / (nu4 - 1) - 0.5) * Sh.w * (abs(u) < 0.45 ? 0.6 : 1))), (v * nu4 + j) * 3);
    }
    var shawl = new Cloth({ name: 'shawl', nu: nu4, nv: nv4, X0: X4, wrap: false, bend: 0.1, shear: 0.5, damp: 0.982, iters: 4, drag: 1.0 });
    // pins: the back center (to the upper back) and one cross row over each forearm
    var mid = floor(nv4 / 2);
    for (j = 0; j < nu4; j++) { var yb = 1.19 + (j / (nu4 - 1) - 0.5) * Sh.w * 0.6, bp = surfaceRay(F, yb, PI, ax), bn = sdfGrad(F, bp), pb = add(bp, mul(bn, 0.0075 + 0.0012));
      X4.set(pb, (mid * nu4 + j) * 3); shawl.X0.set(pb, (mid * nu4 + j) * 3); shawl.x.set(pb, (mid * nu4 + j) * 3); shawl.px.set(pb, (mid * nu4 + j) * 3); shawl.pinTo(mid * nu4 + j, A.add(pb, bp)); }
    [-1, 1].forEach(function (s) {
      var vv = floor((nv4 - 1) * ((s * 0.45) + 1) / 2), cE = s > 0 ? aL.M(add(aL.E, mul(aL.dU, -0.075))) : mirror(aL.M(add(aL.E, mul(aL.dU, -0.075)))), fa = s > 0 ? aL.M(aL.dU) : mirror(aL.M(aL.dU));
      var up4 = norm(sub([0, 1, 0], mul(fa, dot([0, 1, 0], fa)))), fr4 = norm(sub([0, 0, 1], mul(fa, dot([0, 0, 1], fa))));
      for (var kr = -2; kr <= 2; kr++) {   // rows wrap over the arm top: behind → over → in front
        var phi = kr * s * 0.5, dir4 = add(mul(up4, cos(phi)), mul(fr4, sin(phi))), row = vv + kr;
        for (j = 0; j < nu4; j++) {
          var cpt4 = add(cE, mul(fa, (j / (nu4 - 1) - 0.5) * 0.06)), t4 = 0.1;
          for (var i4 = 0; i4 < 80; i4++) { var p4 = add(cpt4, mul(dir4, t4)), d4 = F(p4[0], p4[1], p4[2], 1); if (d4 < 2e-5) break; t4 -= d4; if (t4 < 0) { t4 = 0; break; } }
          var s4 = add(cpt4, mul(dir4, t4)), q4 = add(s4, mul(sdfGrad(F, s4), 0.0009 + 0.0012)), id4 = row * nu4 + j;
          X4.set(q4, id4 * 3); shawl.X0.set(q4, id4 * 3); shawl.x.set(q4, id4 * 3); shawl.px.set(q4, id4 * 3); shawl.pinTo(id4, A.add(q4, s4));
        }
      }
    });
    var shPinList = []; for (var i = 0; i < shawl.n; i++) if (shawl.pin[i] >= 0) shPinList.push([i, shawl.pin[i]]);
    shawl = new Cloth(shawl.o); shPinList.forEach(function (q) { shawl.pinTo(q[0], q[1]); });
    shawl.uvw = restUV(shawl, false); shawl.layer = 4;
    G.cloths.push(shawl);
  }
  // --- sash ribbons (裙帶): tied in a knot at the seam of the band and the skirt; the two long ends lie on the skirt and
  // hang. The top third rides on the chest (blending out over the middle); the lower half swings ---
  if (C.sash) {
    var yb = bandTop(0) - C.band.h, kp = surfaceRay(F, yb, 0, ax), kn = sdfGrad(F, kp), knotC = add(kp, mul(kn, C.band.off + 0.0068));
    var skCol = function (th, y) {   // the skirt's rest surface in direction th at height y (outermost column point), + a little
      var best = null, jj = Math.round(((th - PI) / (2 * PI) % 1 + 1) % 1 * skirt.o.nu) % skirt.o.nu, X0 = skirt.X0, nu0 = skirt.o.nu;
      for (var v2 = 0; v2 + 1 < skirt.o.nv; v2++) { var i0 = (v2 * nu0 + jj) * 3, i1 = ((v2 + 1) * nu0 + jj) * 3; if ((X0[i0 + 1] - y) * (X0[i1 + 1] - y) <= 0) { var f2 = (y - X0[i0 + 1]) / (X0[i1 + 1] - X0[i0 + 1] || 1); best = lerp3([X0[i0], X0[i0 + 1], X0[i0 + 2]], [X0[i1], X0[i1 + 1], X0[i1 + 2]], f2); break; } }
      return best;
    };
    var beltR = null;
    if (C.belt) {   // (Song) a waist band of the ribbons' red silk over the seam of 抹胸 and skirt, skinned; the knot sits on it in front
      var Bt = C.belt, NBt = 96, BR = Bt.rows || 5, brings = [], bnrm = [], rq = function (q) { return Math.hypot(q[0] - ax[0], q[2] - ax[1]); };
      for (r = 0; r < BR; r++) { var yB = yb + Bt.up - (Bt.up + Bt.down) * r / (BR - 1), rgB = []; for (j = 0; j < NBt; j++) { th = PI + 2 * PI * j / NBt;
        var rB = rq(surfaceRay(F, yB, th, ax)) + 0.004, cB = skCol(th, yB); if (cB) rB = max(rB, rq(cB) + Bt.off); if (G.bandR && yB > yb - 0.002) rB = max(rB, G.bandR(th, yB) + Bt.off);
        rgB.push([ax[0] + sin(th) * rB, yB, ax[1] + cos(th) * rB]); } brings.push(rgB); }
      for (j = 0; j < NBt; j++) { var mx = 0; for (r = 0; r < BR; r++) mx = max(mx, rq(brings[r][j])); for (r = 0; r < BR; r++) { th = PI + 2 * PI * j / NBt; brings[r][j] = [ax[0] + sin(th) * mx, brings[r][j][1], ax[1] + cos(th) * mx]; } }   // a straight (cylindrical) band
      brings = brings.map(function (rg) { return hullRing(rg, ax); });
      for (r = 0; r < BR; r++) { bnrm.push(brings[r].map(function (q) { var d = norm([q[0] - ax[0], 0, q[2] - ax[1]]); return d; })); }
      G.belt = shellMesh(body, brings, 0, Bt.thick, bnrm);
      beltR = function (th2) { var jj = Math.round(((th2 - PI) / (2 * PI) % 1 + 1) % 1 * NBt) % NBt; return rq(brings[0][jj]); };
      var yk = yb + (Bt.up - Bt.down) / 2; kp = surfaceRay(F, yk, 0, ax); kn = [0, 0, 1]; knotC = [ax[0], yk, ax[1] + beltR(0) + 0.0062];
    }
    [-1, 1].forEach(function (s) {
      var Sa = C.sash, nv5 = Sa.nv, X5 = new Float32Array(2 * nv5 * 3), th5 = (C.sash.apart || 0.055) * s, front5 = s > 0 ? 0.004 : 0;   // apart, the left one a little in front
      for (v = 0; v < nv5; v++) {
        var y5 = yb - 0.003 - v * Sa.len / (nv5 - 1), cp = skCol(th5, y5) || [sin(th5) * 0.2, y5, 0.2], rr5 = Math.hypot(cp[0], cp[2] - ax[1]) + 0.004 + front5;
        if (beltR && y5 > yb - C.belt.down - 0.004) rr5 = max(rr5, beltR(th5) + 0.0035);   // (over the belt)
        if (v === 0) rr5 = Math.hypot(knotC[0], knotC[2] - ax[1]);   // the ends come out of the knot
        for (j = 0; j < 2; j++) { var tj = th5 + (j - 0.5) * Sa.w / max(rr5, 0.05) * min(1, 0.6 + v / 4) + 0.01 * s * smooth(0, nv5, v); X5.set([sin(tj) * rr5, y5, ax[1] + cos(tj) * rr5], (v * 2 + j) * 3); }
      }
      var sash = new Cloth({ name: 'sash' + (s > 0 ? 'L' : 'R'), nu: 2, nv: nv5, X0: X5, wrap: false, bend: 0.3, shear: 0.6, damp: 0.985, iters: 4, drag: 0.3 });
      for (j = 0; j < 2; j++) sash.pinTo(j, A.add([X5[j * 3], X5[j * 3 + 1], X5[j * 3 + 2]], kp));
      // rigid with the body from the knot down to below the bust (pinned to skinned anchors: no jitter at the top), then a short
      // smooth blend (strong follow fading out over ~6 cm), and only the rest hangs free
      sash.follow = []; var yRig = C.sash.rig || 1.11;
      for (v = 1; v < nv5; v++) for (j = 0; j < 2; j++) { var iS = (v * 2 + j) * 3, pS = [X5[iS], X5[iS + 1], X5[iS + 2]];
        if (pS[1] > yRig) { sash.pinTo(v * 2 + j, A.add(pS, projectTo(F, pS))); continue; }
        var kS = 0.9 * (1 - smooth(0, 0.06, yRig - pS[1])); if (kS > 0.01) sash.follow.push([v * 2 + j, A.add(pS, projectTo(F, pS)), kS]); }
      sash.uvw = restUV(sash, false); sash.layer = 2;
      G.cloths.push(sash);
      if (C.jade && s > 0) { var bestV = 1; for (v = 1; v < nv5; v++) if (abs(X5[v * 6 + 1] - C.jade.y) < abs(X5[bestV * 6 + 1] - C.jade.y)) bestV = v; G.jade = { v: bestV, R: C.jade.R, r: C.jade.t || C.jade.r, w: C.jade.w || 2 * C.jade.r, gather: C.jade.gather };   // (玉環綬: the row the jade ring sits on)
      }
    });
    // the knot: a small wrapped knot with two short loops, rigid with the chest (its own part, on the band)
    var KS = C.sash.knotSize || 1, KM = new Mesh(), kF = frame(kn), kup = norm(sub([0, 1, 0], mul(kn, dot([0, 1, 0], kn)))), ksd = norm(cross(kn, kup));
    KM.grid(16, 10, function (u, v) { var a2 = u * 2 * PI, b2 = (v - 0.5) * PI, r2 = 0.0088 * KS, p = add(knotC, add(mul(ksd, cos(a2) * cos(b2) * r2 * 1.15), add(mul(kup, sin(b2) * r2 * 0.95), mul(kn, sin(a2) * cos(b2) * r2 * 0.7)))); return { p: p, uv: [u, v, 0, 0] }; }, true);
    if (C.sash.knotCloth) [-1, 1].forEach(function (s) {   // (knot in the ribbon silk) a bow: two flat ribbon loops out to the sides and forward, the ribbon's width upright
      KM.grid(24, 4, function (u, v) { var ang = u * 2 * PI, side = s * (0.006 + 0.02 * sin(ang * 0.5)), fwd = 0.004 + 0.009 * sin(ang) * 0.6 + 0.004 * sin(ang * 0.5), wd = (v - 0.5) * 0.02 * (0.55 + 0.45 * sin(ang * 0.5));
        return { p: add(knotC, mul(add(mul(ksd, side), add(mul(kn, fwd), mul(kup, wd))), KS)), uv: [u, v, 0, 0] }; });
    });
    else [-1, 1].forEach(function (s) {   // the loops: flattened bands looping out sideways and up
      var pts = [], rad = []; for (var q = 0; q <= 18; q++) { var t3 = q / 18, ang = t3 * 2 * PI; pts.push(add(knotC, mul(add(mul(ksd, s * (0.006 + 0.019 * sin(ang * 0.5))), add(mul(kup, 0.009 * sin(ang) + 0.005 * sin(ang * 0.5)), mul(kn, 0.003 * cos(ang)))), KS))); rad.push(0.0032 * (KS > 1 ? 1 + (KS - 1) * 0.6 : 1)); }   // (knotSize scales the bow)
      tube(KM, pts, rad, 6);
    });
    var km = KM.out(sk.by.chest, C.sash.knotMat || 'sashKnot', true);
    if (G.belt) { var kv = body.hash.near(kp, 0.05), nk = km.pos.length / 3; km.bi = new Uint8Array(nk * 4); km.bw = new Float32Array(nk * 4); for (var q7 = 0; q7 < nk; q7++) for (var k7 = 0; k7 < 4; k7++) { km.bi[q7 * 4 + k7] = body.bi[kv * 4 + k7]; km.bw[q7 * 4 + k7] = body.bw[kv * 4 + k7]; } }   // (on the belt: skinned like the waist)
    G.parts.push({ name: 'sashKnot', mesh: km, parent: G.belt ? 'belt' : 'band', kind: G.belt ? 'skinned' : 'rigid' });
  }
  // --- crown ribbons (Song 冠帶): two long silk ribbons from the back of the crown, hanging down the back over the 褙子.
  // The root row is pinned on the crown base (head weights); the next rows are carried by the head; the rest hangs ---
  if (C.ribbon && cfg.ribbonTop) cfg.ribbonTop.forEach(function (tops, k) { var top = lerp3(tops[0], tops[1], 0.5);
    var Rb = C.ribbon, nv6 = Rb.nv, X6 = new Float32Array(2 * nv6 * 3), s6 = k ? 1 : -1, zRun = top[2], step = Rb.len / (nv6 - 1);
    for (v = 0; v < nv6; v++) {
      var y6 = top[1] - v * step, sp6 = surfaceRay(F, y6, PI, ax), head6 = y6 > sk.O[1] - 0.06, zc = sp6[2] - (head6 ? 0.036 : 0.024);
      zRun = v ? min(zRun, zc) : top[2]; var z6 = y6 > 1.2 ? zRun : mix(zRun, zc, smooth(1.2, 1.0, y6)), x6 = top[0] + s6 * 0.012 * smooth(0, 0.6, v * step);
      for (j = 0; j < 2; j++) X6.set(v ? [x6 + (j - 0.5) * Rb.w, y6, z6] : tops[j], (v * 2 + j) * 3);
    }
    var rb = new Cloth({ name: 'ribbon' + (k ? 'L' : 'R'), nu: 2, nv: nv6, X0: X6, wrap: false, bend: 0.25, shear: 0.6, damp: 0.985, iters: 4, drag: 0.4 });
    for (j = 0; j < 2; j++) { var pr6 = [X6[j * 3], X6[j * 3 + 1], X6[j * 3 + 2]]; rb.pinTo(j, A.add(pr6, projectTo(F, pr6))); }
    rb.follow = []; for (v = 1; v < nv6; v++) { var kR = 0.8 * (1 - smooth(0.03, 0.12, v * step)); if (kR <= 0.01) break; for (j = 0; j < 2; j++) { var q6 = [X6[(v * 2 + j) * 3], X6[(v * 2 + j) * 3 + 1], X6[(v * 2 + j) * 3 + 2]]; rb.follow.push([v * 2 + j, A.add(q6, projectTo(F, q6)), kR]); } }
    rb.uvw = restUV(rb, false); rb.layer = 4; rb.overRobe = true; rb.hairCollide = true;
    G.cloths.push(rb);
  });
  G.cloths.forEach(function (c) { c.lra(); });
  G.anchors = A.finish();
  G.cols = colliders(body, sk);
  // collision proxy: one body vertex per 8 mm voxel, skinned every step with the body's own weights
  var seen = new Set(), sel = [], P0 = body.pos;
  for (var vi = 0; vi < P0.length / 3; vi++) { var key = floor(P0[vi * 3] / 0.008) + ',' + floor(P0[vi * 3 + 1] / 0.008) + ',' + floor(P0[vi * 3 + 2] / 0.008); if (!seen.has(key)) { seen.add(key); sel.push(vi); } }
  var pp = new Float32Array(sel.length * 3), pn = new Float32Array(sel.length * 3), pbi = new Uint8Array(sel.length * 4), pbw = new Float32Array(sel.length * 4);
  sel.forEach(function (v, k) { for (var q = 0; q < 3; q++) { pp[k * 3 + q] = P0[v * 3 + q]; pn[k * 3 + q] = body.nrm[v * 3 + q]; } for (q = 0; q < 4; q++) { pbi[k * 4 + q] = body.bi[v * 4 + q]; pbw[k * 4 + q] = body.bw[v * 4 + q]; } });
  G.proxy = { pos: pp, nrm: pn, bi: pbi, bw: pbw, n: sel.length };
  if (log) log('garments: ' + G.cloths.map(function (c) { return c.name + ' ' + c.n; }).join(', ') + ' particles, ' + (Date.now() - t0) + 'ms');
  return G;
}
// rest-space cloth coordinates in meters (u around/across, v down/along) for patterns
// render mesh for a cloth: wrapped cloths get a duplicated seam column (u = full circumference) so no triangle wraps
Cloth.prototype.renderMesh = function () {
  var o = this.o, nu = o.nu, nv = o.nv, X = this.X0;
  if (!this.wrap) return { idx: this.tris(), uv: this.uvw, map: null };
  var map = new Uint32Array(nv * (nu + 1)), uv = new Float32Array(nv * (nu + 1) * 4), idx = [];
  for (var v = 0; v < nv; v++) for (var u = 0; u <= nu; u++) {
    var r = v * (nu + 1) + u, i = v * nu + (u % nu); map[r] = i; for (var k = 0; k < 4; k++) uv[r * 4 + k] = this.uvw[i * 4 + k];
    if (u === nu) { var l = v * nu + nu - 1, f = v * nu; uv[r * 4] = this.uvw[l * 4] + sqrt(sq(X[l * 3] - X[f * 3]) + sq(X[l * 3 + 1] - X[f * 3 + 1]) + sq(X[l * 3 + 2] - X[f * 3 + 2])); uv[r * 4 + 2] = 1; }
  }
  for (v = 0; v + 1 < nv; v++) for (u = 0; u < nu; u++) { var a = v * (nu + 1) + u, b = a + 1, c = a + nu + 1, d = c + 1; idx.push(a, b, c, b, d, c); }
  return { idx: new Uint32Array(idx), uv: uv, map: map };
};
function restUV(c, wrap) {
  var o = c.o, uv = new Float32Array(c.n * 4), X = c.X0;
  // u: signed arc length along the row from the middle column (for the skirt: the front centre), so every column's u
  // changes only as the row widens — symmetric, no shear down the middle; v: arc length down the column. Texels are
  // square in the rest shape.
  var jc = o.nu >> 1, dist = function (a, b) { return sqrt(sq(X[a * 3] - X[b * 3]) + sq(X[a * 3 + 1] - X[b * 3 + 1]) + sq(X[a * 3 + 2] - X[b * 3 + 2])); };
  for (var v = 0; v < o.nv; v++) { var r0 = v * o.nu, acc = 0, u; uv[(r0 + jc) * 4] = 0;
    for (u = jc + 1; u < o.nu; u++) { acc += dist(r0 + u, r0 + u - 1); uv[(r0 + u) * 4] = acc; }
    for (acc = 0, u = jc - 1; u >= 0; u--) { acc -= dist(r0 + u, r0 + u + 1); uv[(r0 + u) * 4] = acc; } }
  var i;
  for (var u = 0; u < o.nu; u++) { var acc = 0; for (v = 0; v < o.nv; v++) { i = v * o.nu + u; if (v) { var k = i - o.nu; acc += sqrt(sq(X[i * 3] - X[k * 3]) + sq(X[i * 3 + 1] - X[k * 3 + 1]) + sq(X[i * 3 + 2] - X[k * 3 + 2])); } uv[i * 4 + 1] = acc; uv[i * 4 + 2] = u / (o.nu - (wrap ? 0 : 1)); uv[i * 4 + 3] = v / (o.nv - 1); } }
  return uv;
}

/* ---- simulation: fixed 1/120 s steps, deterministic ---- */
// offline quality (tool/video.js): solver iterations × iters, collisions in every iteration
var SIMQ = { iters: 1, allCollide: false };
var SIM_DT = 1 / 60;   // (damping, drag and follow rates below are expressed per 1/90 s and converted)
function PHash(cell, bits) { this.c = cell; this.N = 1 << bits; this.head = new Int32Array(this.N); this.next = null; }
PHash.prototype.build = function (P, n) { this.P = P; this.head.fill(-1); if (!this.next || this.next.length < n) this.next = new Int32Array(n); var c = this.c, M = this.N - 1;
  for (var i = 0; i < n; i++) { var k = ((floor(P[i * 3] / c) * 73856093) ^ (floor(P[i * 3 + 1] / c) * 19349663) ^ (floor(P[i * 3 + 2] / c) * 83492791)) & M; this.next[i] = this.head[k]; this.head[k] = i; } };
PHash.prototype.nearest = function (x, y, z) {   // nearest point within one cell ring
  var c = this.c, M = this.N - 1, P = this.P, ax = floor(x / c), ay = floor(y / c), az = floor(z / c), best = -1, bd = 1e9;
  for (var a = ax - 1; a <= ax + 1; a++) for (var b = ay - 1; b <= ay + 1; b++) for (var d = az - 1; d <= az + 1; d++) {
    for (var i = this.head[((a * 73856093) ^ (b * 19349663) ^ (d * 83492791)) & M]; i >= 0; i = this.next[i]) { var dx = P[i * 3] - x, dy = P[i * 3 + 1] - y, dz = P[i * 3 + 2] - z, q = dx * dx + dy * dy + dz * dz; if (q < bd) { bd = q; best = i; } }
  }
  return best;
};
// push particle i out of the skinned body proxy (signed distance along the nearest proxy vertex normal)
function collideProxy(x, i, PP, PN, H, m, H2, cache) {
  // the fine hash is exact within one cell (1.4 cm), the coarse one within 5 cm; beyond that we are not touching anything.
  // cache: distance at the last full search and where it was made — if we cannot have reached the body since, skip
  var px = x[i * 3], py = x[i * 3 + 1], pz = x[i * 3 + 2];
  if (cache && cache.d[i] > 0) { var mv = sqrt(sq(px - cache.p[i * 3]) + sq(py - cache.p[i * 3 + 1]) + sq(pz - cache.p[i * 3 + 2])); if (cache.d[i] - mv - (cache.M - cache.m[i]) - cache.slack > m) return false; }
  var v = H.nearest(px, py, pz), d2 = v >= 0 ? sq(PP[v * 3] - px) + sq(PP[v * 3 + 1] - py) + sq(PP[v * 3 + 2] - pz) : 1;
  if (d2 > H.c * H.c && H2) { v = H2.nearest(px, py, pz); d2 = v >= 0 ? sq(PP[v * 3] - px) + sq(PP[v * 3 + 1] - py) + sq(PP[v * 3 + 2] - pz) : 1; }
  if (cache) { cache.d[i] = v >= 0 ? min(sqrt(d2), 0.05) : 0.05; cache.m[i] = cache.M; cache.p[i * 3] = px; cache.p[i * 3 + 1] = py; cache.p[i * 3 + 2] = pz; }
  if (v < 0 || d2 > H2.c * H2.c) return false;
  var nx = PN[v * 3], ny = PN[v * 3 + 1], nz = PN[v * 3 + 2], s = (x[i * 3] - PP[v * 3]) * nx + (x[i * 3 + 1] - PP[v * 3 + 1]) * ny + (x[i * 3 + 2] - PP[v * 3 + 2]) * nz;
  if (s >= m) return false;
  var k = m - s; x[i * 3] += nx * k; x[i * 3 + 1] += ny * k; x[i * 3 + 2] += nz * k; return true;
}
function selfRepel(c, dmin, sim) {
  var H = sim.SH || (sim.SH = new PHash(dmin, 15)), x = c.x, n = c.n, nu = c.nu, M = H.N - 1, cl = H.c;
  H.build(x, n);
  for (var i = 0; i < n; i++) {
    var ui = i % nu, vi = (i / nu) | 0, ax = floor(x[i * 3] / cl), ay = floor(x[i * 3 + 1] / cl), az = floor(x[i * 3 + 2] / cl);
    for (var a = ax - 1; a <= ax + 1; a++) for (var b = ay - 1; b <= ay + 1; b++) for (var d = az - 1; d <= az + 1; d++)
      for (var j = H.head[((a * 73856093) ^ (b * 19349663) ^ (d * 83492791)) & M]; j >= 0; j = H.next[j]) {
        if (j <= i) continue;
        var du = abs(ui - j % nu); if (c.wrap) du = min(du, nu - du); if (du + abs(vi - ((j / nu) | 0)) <= 2) continue;
        var dx = x[j * 3] - x[i * 3], dy = x[j * 3 + 1] - x[i * 3 + 1], dz = x[j * 3 + 2] - x[i * 3 + 2], dd = dx * dx + dy * dy + dz * dz;
        if (dd >= dmin * dmin || dd < 1e-12) continue;
        var L = sqrt(dd), wi = c.w[i], wj = c.w[j], ws = wi + wj; if (!ws) continue;
        var e = (dmin - L) / L / ws; x[i * 3] -= dx * e * wi; x[i * 3 + 1] -= dy * e * wi; x[i * 3 + 2] -= dz * e * wi; x[j * 3] += dx * e * wj; x[j * 3 + 1] += dy * e * wj; x[j * 3 + 2] += dz * e * wj;
      }
  }
}
function Sim(fig) { this.fig = fig; this.t = null; this.H = new PHash(0.014, 16); this.H2 = new PHash(0.05, 14); this.DQ = new Float32Array(fig.sk.bones.length * 8); this.field = new Field(96, 64, 0, 1.4); this.field2 = new Field(96, 64, 0, 1.45); }
Sim.prototype.reset = function (t) {
  this.t = t; this.Wprev = null; (this.fig.cloths || []).forEach(function (c) { c.x.set(c.X0); c.px.set(c.X0); if (c.cache) c.cache.d.fill(0); });
  // bead chains hang straight down from their branch tips at bind
  (this.fig.chains || []).forEach(function (ch) { var y = ch.top[1] - ch.topR; ch.x = []; ch.px = [];
    ch.beads.forEach(function (b, j) { y -= b.r + (j ? ch.beads[j - 1].r : 0); var p = [ch.top[0], y, ch.top[2]]; if (!j) p[1] = ch.top[1] - ch.topR - b.r; else p[1] = ch.x[j - 1][1] - ch.beads[j - 1].r - b.r; ch.x.push(p); ch.px.push(p.slice()); }); });
  this.warm = t;   // warm-up: bind (A-pose) → arms-down rest → the performance, so the arms never sweep through the cloth
};
// budgetMs (interactive playback): never spend more than this per call; if the sim falls behind, it skips time
/* rings (bracelet, jade bangle): their own fixed 240 Hz substeps, decoupled from the cloth (which may fall behind under
   a playback budget) and from the render rate. Each substep poses the arm at the substep's own time; the ring is a
   damped point in world space, constrained in the forearm's frame to contain the limb's cross-section (it rests on the
   arm and hangs, with a little sliding along it). The shown offset is interpolated between the last two substeps. */
var RING_DT = 1 / 240;
// the hair flower sways a little on its stem: a damped angular spring (in head space) driven by the head's own linear and
// angular acceleration; the flower's parts are rotated about its base each frame
Sim.prototype.swayStep = function (W) {
  var sw = this.fig.parts.filter(function (p) { return p.sway; }); if (!sw.length) return;
  var I = sw[0].sway.info, b = this.fig.sk.bones[I.bone], q = W.q[I.bone], P = W.p[I.bone], base = add(P, qrot(q, sub(I.base, b.p)));
  var S = this.swayS || (this.swayS = { x: [0, 0, 0], v: [0, 0, 0], pb: null, ppb: null });
  if (S.pb && S.ppb) {
    var acc = mul(add(sub(base, mul(S.pb, 2)), S.ppb), 1 / (RING_DT * RING_DT)), aL = qrot(qconj(q), sub(acc, [0, -9.81, 0]));   // apparent gravity in head space
    var tq = cross(I.axis, aL), k = 260, c = 2 * sqrt(k) * 0.35;   // torque from inertia + gravity about the base (an underdamped spring)
    for (var i = 0; i < 3; i++) { S.v[i] += (tq[i] * 0.004 - k * S.x[i] - c * S.v[i]) * RING_DT; S.x[i] += S.v[i] * RING_DT; }
    var L = len(S.x); if (L > 0.12) S.x = mul(S.x, 0.12 / L);
  }
  S.ppb = S.pb; S.pb = base; S.prev = S.cur; S.cur = S.x.slice();
};
Sim.prototype.swayShow = function (al) {
  var S = this.swayS; if (!S || !S.cur) return; var r = S.prev ? lerp3(S.prev, S.cur, al) : S.cur, ang = len(r), qq = ang > 1e-7 ? qaxis(mul(r, 1 / ang), ang) : [0, 0, 0, 1];
  this.fig.parts.forEach(function (p) { if (!p.sway) return; var c = p.sway.info.base, P0 = p.sway.pos0, N0 = p.sway.nrm0, P = p.mesh.pos, N = p.mesh.nrm;
    for (var i = 0; i < P.length; i += 3) { var d = qrot(qq, [P0[i] - c[0], P0[i + 1] - c[1], P0[i + 2] - c[2]]), n = qrot(qq, [N0[i], N0[i + 1], N0[i + 2]]); P[i] = c[0] + d[0]; P[i + 1] = c[1] + d[1]; P[i + 2] = c[2] + d[2]; N[i] = n[0]; N[i + 1] = n[1]; N[i + 2] = n[2]; }
    p.swayMoved = true; });
};
Sim.prototype.ringsAdvance = function (poseAt, t) {
  var rings = this.fig.parts.filter(function (p) { return p.ring; }), sk = this.fig.sk; if (!rings.length) return;
  if (this.rt == null || t < this.rt - 1e-9 || t - this.rt > 2) { this.rt = t - 1.5; rings.forEach(function (p) { p.ring.x = null; }); }   // settle from 1.5 s back
  var g = -9.81 * RING_DT * RING_DT;
  while (this.rt + RING_DT <= t + 1e-9) {
    this.rt += RING_DT; var W = poseAt(this.rt, 1); this.swayStep(W);
    rings.forEach(function (p) {
      var R = p.ring, b = sk.bones[R.bone], q = W.q[R.bone], P = W.p[R.bone], toW = function (x) { return add(P, qrot(q, sub(x, b.p))); }, toB = function (x) { return add(b.p, qrot(qconj(q), sub(x, P))); };
      if (!R.x) { R.x = toW(R.c0); R.px = R.x.slice(); R.off = [0, 0, 0]; R.vS = [0, 0, 0]; }
      var v = sub(R.x, R.px); R.px = R.x.slice(); R.x = add(R.x, add(mul(v, 0.985), [0, g, 0]));
      var o = sub(toB(R.x), R.c0), s = clamp(dot(o, R.ax), -R.slide, R.slide), o2 = [dot(o, R.t), dot(o, R.b)], hit = false;
      for (var it = 0; it < 6; it++) R.pts.forEach(function (pk) { var dx = pk[0] - o2[0], dy = pk[1] - o2[1], L = sqrt(dx * dx + dy * dy); if (L > R.rin) { var f = 1 - R.rin / L; o2[0] += dx * f; o2[1] += dy * f; hit = true; } });
      var offP = add(add(mul(R.t, o2[0]), mul(R.b, o2[1])), mul(R.ax, s));
      R.x = toW(add(R.c0, offP));
      // what is shown follows the physical offset with a short critically damped lag (skin friction: no snapping across
      // the gap); the set of valid offsets is convex (an intersection of discs), so the blend stays clear of the arm
      R.offPrev = R.off; if (!R.vS) R.vS = [0, 0, 0]; var wS = 18;
      for (var k3 = 0; k3 < 3; k3++) { R.vS[k3] += (wS * wS * (offP[k3] - R.off[k3]) - 2 * wS * R.vS[k3]) * RING_DT; }
      R.off = add(R.off, mul(R.vS, RING_DT));
      if (hit) R.px = add(mul(R.px, 0.7), mul(R.x, 0.3));   // contact friction: lose some of the relative speed
    });
  }
  var al = clamp((t - this.rt) / RING_DT, 0, 1);
  this.swayShow(al);   // (this.rt ≤ t < this.rt + dt) — show the state between the last two substeps
  rings.forEach(function (p) {
    var R = p.ring, o0 = R.offPrev || R.off, off = lerp3(o0, R.off, 1), pos = p.mesh.pos, p0 = R.pos0;   // offsets change by < 0.1 mm per substep
    off = lerp3(o0, R.off, al);
    for (var i = 0; i < pos.length; i += 3) { pos[i] = p0[i] + off[0]; pos[i + 1] = p0[i + 1] + off[1]; pos[i + 2] = p0[i + 2] + off[2]; }
    R.moved = true;
  });
};
// change the cloth step (interactive: the page raises the rate while it has time to spare); velocities are kept
Sim.prototype.setRate = function (hz) {
  var nd = 1 / hz, od = this.dt || SIM_DT; if (Math.abs(nd - od) < 1e-9) return; this.dt = nd;
  (this.fig.cloths || []).forEach(function (c) { for (var i = 0; i < c.x.length; i++) c.px[i] = c.x[i] - (c.x[i] - c.px[i]) * nd / od; });
};
// cloth particles deeper than 'depth' inside the body (proxy test: nearest skinned proxy point and its normal) → Uint8Array
Sim.prototype.deep = function (depth) {
  var out = [], PP = this.PP, PN = this.PN, H = this.H; if (!PP) return out;
  this.fig.garments.cloths.forEach(function (c) { var x = c.x, f = new Uint8Array(c.n);
    for (var i = 0; i < c.n; i++) { var v = H.nearest(x[i * 3], x[i * 3 + 1], x[i * 3 + 2]); if (v < 0) continue;
      var sd = (x[i * 3] - PP[v * 3]) * PN[v * 3] + (x[i * 3 + 1] - PP[v * 3 + 1]) * PN[v * 3 + 1] + (x[i * 3 + 2] - PP[v * 3 + 2]) * PN[v * 3 + 2]; if (sd < -depth) f[i] = 1; }
    out.push(f); });
  return out;
};
// carry (see Sim.step): bone-rigid transfer from pose Wa to Wb, scaled by each cloth's carry share (× k)
var CARRY = { ribbonL: ['head', 0.5], ribbonR: ['head', 0.5], skirt: ['root', 0.85], robeFL: ['spine', 0.7], robeFR: ['spine', 0.7], robeB: ['spine', 0.7], yokeL: ['chest', 0.9], yokeR: ['chest', 0.9], shawl: ['chest', 0.6], sleeveL: ['armL', 0.75], sleeveR: ['armR', 0.75], sashL: ['root', 0.7], sashR: ['root', 0.7] };
// (on a catch-up, arm-carried cloth keeps its share: a rigid upper-arm carry would push it into a bending forearm)
function carryCloth(cloths, sk, Wa, Wb, k, full) {
  cloths.forEach(function (c) {
    var C = CARRY[c.name]; if (!C) return;
    var b = sk.by[C[0]], f = full ? (/^sleeve|^shawl/.test(c.name) ? C[1] : 1) : C[1] * k, qa = Wa.q[b], qb = Wb.q[b], pa = Wa.p[b], pb = Wb.p[b], dq = qmul(qb, qconj(qa)), x = c.x, px = c.px;
    var tr = function (X, i) { var r = qrot(dq, [X[i] - pa[0], X[i + 1] - pa[1], X[i + 2] - pa[2]]); X[i] += (pb[0] + r[0] - X[i]) * f; X[i + 1] += (pb[1] + r[1] - X[i + 1]) * f; X[i + 2] += (pb[2] + r[2] - X[i + 2]) * f; };
    for (var i = 0; i < c.n; i++) { if (c.pin[i] >= 0) continue; tr(x, i * 3); tr(px, i * 3); }
  });
}
// budgetMs (interactive playback): the cloth may take fewer steps than real time allows, but it never trails the body —
// when out of budget it jumps to the current time, carrying the cloth fully with the body for the skipped interval.
Sim.prototype.advance = function (poseAt, t, budgetMs, maxSteps) {
  this.ringsAdvance(poseAt, t);
  if (this.t === null || t < this.t - 1e-9 || (!budgetMs && !maxSteps && t - this.t > 6)) this.reset(t - 4);
  var t0 = Date.now(), n = 0;
  var DT = this.dt || SIM_DT;
  while (this.t + DT <= t + 1e-9) {
    if (this.t - this.warm < 2.6) { this.t += DT; this.step(poseAt, this.t); n = 0; t0 = Date.now(); continue; }   // the warm-up (bind → rest → pose) always runs in full
    if ((budgetMs && Date.now() - t0 > budgetMs) || (maxSteps && n >= maxSteps)) {
      if (t - this.t > DT && this.Wprev && t - this.warm > 2.4 && this.fig.garments) { var W = poseAt(t, 1); carryCloth(this.fig.garments.cloths, this.fig.sk, this.Wprev, W, 1, true); this.Wprev = W; this.t = t; this.skipped = (this.skipped || 0) + 1; }
      break;
    }
    this.t += DT; this.step(poseAt, this.t); n++;
  }
};
Sim.prototype.step = function (poseAt, t) {
  var fig = this.fig, sk = fig.sk, G = fig.garments, e = t - this.warm;
  if (!this.Wrest) { this.Wbind = bindW(sk); var rc = defaultControls(); rc.lipPress = 0.6; this.Wrest = solve(sk, rc); }
  var W = e < 1.2 ? blendW(this.Wbind, this.Wrest, smooth(0, 1.2, e)) : e < 2.4 ? blendW(this.Wrest, poseAt(t, 1), smooth(1.2, 2.4, e)) : poseAt(t, 1);
  poseDQ(sk, W, this.DQ);
  var dt = this.dt || SIM_DT, gdt = -9.81 * dt * dt;
  if (G) {   // (the old cloth: Song until it is sewn too; Tang's garments are in GSim)
  var anc = G.anchors.update(this.DQ), self = this, PR = G.proxy;
  if (!this.PP) { this.PP = new Float32Array(PR.n * 3); this.PN = new Float32Array(PR.n * 3); }
  if (!this.PPprev) this.PPprev = new Float32Array(PR.n * 3); this.PPprev.set(this.PP);
  skin(PR, this.DQ, this.PP, this.PN); this.H.build(this.PP, PR.n); this.H2.build(this.PP, PR.n);
  var bm = 0, PPa = this.PP, PPb = this.PPprev; for (var pi = 0; pi < PR.n * 3; pi += 3) { var dd = sq(PPa[pi] - PPb[pi]) + sq(PPa[pi + 1] - PPb[pi + 1]) + sq(PPa[pi + 2] - PPb[pi + 2]); if (dd > bm) bm = dd; }
  this.bodyM = (this.bodyM || 0) + sqrt(bm);   // accumulated bound on how far any body point has moved
  var limbs = poseColliders(G.limbs || (G.limbs = G.cols.filter(function (c) { return /^(arm|fore|hand)/.test(sk.bones[c.bone].name); })), sk, W, 0.004);
  if (fig.caps) poseCaps(fig.caps.filter(function (c) { return /^(upper|fore|hand)[LR]$/.test(c.name); }), sk, W).forEach(function (c) {   // + the fitted forearm / hand capsules (cover the wrist)
    var r = c.r / 0.9 + 0.003; limbs.push({ t: 1, a: c.a, b: c.b, ra: r, rb: r, c: lerp3(c.a, c.b, 0.5), r: len(sub(c.b, c.a)) / 2 + r }); });
  var grow = function (c, g) { var q = Object.assign({}, c); if (c.t === 1) { q.ra += g; q.rb += g; } else q.rad = c.rad.map(function (r) { return r + g; }); q.r = c.r + g; return q; };
  var limbsMid = limbs.map(function (c) { return grow(c, 0.006); }), limbsSl = null;   // (limbsSl: narrow sleeves, grown by their limbGrow)   // the robe panels keep a little clear of the forearms (capsules are thinner than the arm near the wrist)
  var limbsWide = limbs.map(function (c) { var q = Object.assign({}, c); if (c.t === 1) { q.ra += 0.008; q.rb += 0.008; } else q.rad = c.rad.map(function (r) { return r + 0.008; }); q.r = c.r + 0.008; return q; });   // the shawl keeps clear of the arms
  var PP = this.PP, PN = this.PN, H = this.H, H2 = this.H2, MARGIN = { skirt: 0.005, robeFL: 0.0095, robeFR: 0.0095, robeB: 0.0095, yokeL: 0.0095, yokeR: 0.0095, shawl: 0.015, sleeveL: 0.0055, sleeveR: 0.0055, sashL: 0.0045, sashR: 0.0045 };
  var root = W.p[sk.by.root], fc = [root[0], root[2] - 0.008], field = this.field, field2 = this.field2, robeDone = false;
  // carry: each cloth rides along with its carrier bone (a share of the bone's rigid motion since the last step is applied
  // to positions and previous positions alike, so no velocity is injected) — the cloth never trails the body
  G.cloths.forEach(function (c) { if (c.follow) { if (!c.pre) { c.pre = new Float32Array(c.x.length); c.cd = new Float32Array(c.x.length); } c.pre.set(c.x); } });
  if (this.Wprev) carryCloth(G.cloths, sk, this.Wprev, W, 1);
  G.cloths.forEach(function (c) { if (c.follow) for (var q = 0; q < c.x.length; q++) c.cd[q] = c.x[q] - c.pre[q]; });   // what the carry already moved
  this.Wprev = W;
  G.cloths.forEach(function (c) {
    if ((c.name === 'shawl' || c.overRobe) && !robeDone) { field2.build(G.cloths.filter(function (q) { return q.robe; }), fc); robeDone = true; }
    var o = c.o, x = c.x, px = c.px, n = c.n, rate = dt * 90, damp = Math.pow(o.damp || 0.985, rate), drag = (o.drag || 0) / rate;
    for (var i = 0; i < n; i++) {
      if (c.pin[i] >= 0) { var a = c.pin[i] * 3; px[i * 3] = x[i * 3]; px[i * 3 + 1] = x[i * 3 + 1]; px[i * 3 + 2] = x[i * 3 + 2]; x[i * 3] = anc[a]; x[i * 3 + 1] = anc[a + 1]; x[i * 3 + 2] = anc[a + 2]; continue; }
      var vx = (x[i * 3] - px[i * 3]) * damp, vy = (x[i * 3 + 1] - px[i * 3 + 1]) * damp, vz = (x[i * 3 + 2] - px[i * 3 + 2]) * damp;
      if (drag) { var sp = sqrt(vx * vx + vy * vy + vz * vz), f = 1 / (1 + drag * sp * 6); vx *= f; vy *= f; vz *= f; }
      px[i * 3] = x[i * 3]; px[i * 3 + 1] = x[i * 3 + 1]; px[i * 3 + 2] = x[i * 3 + 2];
      x[i * 3] += vx; x[i * 3 + 1] += vy + gdt; x[i * 3 + 2] += vz;
    }
    if (c.follow) for (var fi = 0; fi < c.follow.length; fi++) {   // rows under the band are carried by the torso (rigidly near the top, less below)
      var fq = c.follow[fi], ii = fq[0] * 3, aa = fq[1] * 3, kk = 1 - Math.pow(1 - fq[2], dt * 90);
      for (var ax3 = 0; ax3 < 3; ax3++) { var dlt = (anc[aa + ax3] - x[ii + ax3]) * kk; x[ii + ax3] += dlt; px[ii + ax3] += dlt * 0.6;
        if (self.ancPrev) { var va = anc[aa + ax3] - self.ancPrev[aa + ax3], vt = va - c.cd[ii + ax3], vr = x[ii + ax3] - px[ii + ax3] - vt; px[ii + ax3] = x[ii + ax3] - vt - vr * (1 - 0.6 * fq[2]); } }   // damp the motion relative to the body (minus what the carry moved)
    }
    var C = c.C, R = c.R, K = c.K, w = c.w, nc = R.length, it = Math.round((o.iters || 6) * SIMQ.iters), AC = SIMQ.allCollide;
    if (AC) { if (!c.hitF || c.hitF.length !== n) c.hitF = new Uint8Array(n); else c.hitF.fill(0); }
    if (!c.cache) c.cache = { d: new Float32Array(n), m: new Float32Array(n), p: new Float32Array(n * 3), slack: 0.004, M: 0 };
    c.cache.M = self.bodyM;   // a particle is searched again only once it, or the body (its fastest point), may have closed the gap
    for (var s = 0; s < it; s++) {
      for (var q = 0; q < nc; q++) {
        var ia = C[q * 2], ib = C[q * 2 + 1], wa = w[ia], wb = w[ib], ws = wa + wb; if (!ws) continue;
        var dx = x[ib * 3] - x[ia * 3], dy = x[ib * 3 + 1] - x[ia * 3 + 1], dz = x[ib * 3 + 2] - x[ia * 3 + 2], d = sqrt(dx * dx + dy * dy + dz * dz); if (d < 1e-9) continue;
        var e = (d - R[q]) / d * K[q] / ws, ex = dx * e, ey = dy * e, ez = dz * e;
        if (e < 0 && K[q] < 0.4) { ex *= 0.3; ey *= 0.3; ez *= 0.3; }   // bending resists compression only weakly → folds
        x[ia * 3] += ex * wa; x[ia * 3 + 1] += ey * wa; x[ia * 3 + 2] += ez * wa; x[ib * 3] -= ex * wb; x[ib * 3 + 1] -= ey * wb; x[ib * 3 + 2] -= ez * wb;
      }
      if (c.L) for (q = 0; q < c.LD.length; q++) {
        var li = c.L[q * 2], lj = c.L[q * 2 + 1], ldx = x[li * 3] - x[lj * 3], ldy = x[li * 3 + 1] - x[lj * 3 + 1], ldz = x[li * 3 + 2] - x[lj * 3 + 2], ld = sqrt(ldx * ldx + ldy * ldy + ldz * ldz);
        if (ld > c.LD[q]) { var lf = c.LD[q] / ld; x[li * 3] = x[lj * 3] + ldx * lf; x[li * 3 + 1] = x[lj * 3 + 1] + ldy * lf; x[li * 3 + 2] = x[lj * 3 + 2] + ldz * lf; }
      }
      if (AC || s === it - 1 || s === (it >> 1)) for (i = 0; i < n; i++) {
        if (!w[i]) continue;
        var hit = collideProxy(x, i, PP, PN, H, c.marginA ? c.marginA[i] : c.margin || MARGIN[c.name] || 0.0045, H2, c.cache);
        if (AC || s === it - 1 || (c.layer === 1 && s === (it >> 1))) { var lb = c.name === 'shawl' ? limbsWide : c.robe ? limbsMid : c.limbGrow ? (limbsSl || (limbsSl = limbs.map(function (q) { return grow(q, c.limbGrow); }))) : limbs; if (collide(x, i, lb)) { hit = true; collide(x, i, lb); } }   // twice: out of one limb may be into its neighbour (elbow, wrist)   // arms push every layer (the skirt too) out radially
        if (c.layer > 1 && c.name !== 'sleeveL' && c.name !== 'sleeveR') hit = field.push(x, i, c.name === 'shawl' ? 0.012 : /^sash/.test(c.name) ? 0.01 : 0.008) || hit;
        if (c.name === 'shawl' || c.overRobe) hit = field2.push(x, i, 0.004) || hit;
        if (x[i * 3 + 1] < 0.003) { x[i * 3 + 1] = 0.003; hit = true; }
        if (hit && AC) c.hitF[i] = 1;
        else if (hit) { px[i * 3] = mix(px[i * 3], x[i * 3], 0.3); px[i * 3 + 1] = mix(px[i * 3 + 1], x[i * 3 + 1], 0.3); px[i * 3 + 2] = mix(px[i * 3 + 2], x[i * 3 + 2], 0.3); }
      }
    }
    if (AC) for (i = 0; i < n; i++) if (c.hitF[i]) { px[i * 3] = mix(px[i * 3], x[i * 3], 0.3); px[i * 3 + 1] = mix(px[i * 3 + 1], x[i * 3 + 1], 0.3); px[i * 3 + 2] = mix(px[i * 3 + 2], x[i * 3 + 2], 0.3); }   // contact friction once per step
    if (c.o.self !== false) selfRepel(c, 0.007, self);
    if (c.name === 'skirt') field.build([c], fc);

  });
  // crown ribbons stay outside the hair (its SDF, in the head's bind space)
  if (fig.hair && fig.hair.sdf) G.cloths.forEach(function (c) { if (!c.hairCollide) return; var HFc = fig.hair.sdf, hbq = W.q[sk.by.head], hbp = W.p[sk.by.head], hb0 = sk.bones[sk.by.head].p;
    for (var i = 0; i < c.n; i++) { if (c.pin[i] >= 0) continue; var pw = [c.x[i * 3], c.x[i * 3 + 1], c.x[i * 3 + 2]], pbn = add(hb0, qrot(qconj(hbq), sub(pw, hbp))), dh = HFc(pbn[0], pbn[1], pbn[2], 0.05) - 0.003;
      if (dh < 0) { var gh = qrot(hbq, sdfGrad(HFc, pbn)); c.x[i * 3] -= gh[0] * dh; c.x[i * 3 + 1] -= gh[1] * dh; c.x[i * 3 + 2] -= gh[2] * dh; } } });
  // the two ribbons keep at least 6 mm apart (no z-fighting where they cross)
  var rA = G.cloths.find(function (c) { return c.name === 'sashL'; }), rB = G.cloths.find(function (c) { return c.name === 'sashR'; });
  if (rA && rB) for (var ia = 0; ia < rA.n; ia++) for (var ib = 0; ib < rB.n; ib++) {
    var xa = rA.x, xb = rB.x, ddx = xa[ia * 3] - xb[ib * 3], ddy = xa[ia * 3 + 1] - xb[ib * 3 + 1], ddz = xa[ia * 3 + 2] - xb[ib * 3 + 2], dl = sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
    if (dl < 0.006 && dl > 1e-7) { var push = (0.006 - dl) / dl * 0.5, wa = rA.w[ia] ? 1 : 0, wb = rB.w[ib] ? 1 : 0; xa[ia * 3] += ddx * push * wa; xa[ia * 3 + 1] += ddy * push * wa; xa[ia * 3 + 2] += ddz * push * wa; xb[ib * 3] -= ddx * push * wb; xb[ib * 3 + 1] -= ddy * push * wb; xb[ib * 3 + 2] -= ddz * push * wb; }
  }
  // 玉環綬 (Song): a jade ring on the two sash ribbons at knee height. The ribbons are gathered at its row (no wider than
  // the ring), and the ring lies on them, facing out, carried by the ribbons' frame there (state for the renderer and the checker)
  if (G.jade && rA && rB) { var JV = G.jade.v, rowP = function (c, v) { return lerp3([c.x[v * 6], c.x[v * 6 + 1], c.x[v * 6 + 2]], [c.x[v * 6 + 3], c.x[v * 6 + 4], c.x[v * 6 + 5]], 0.5); };
    var cJ = lerp3(rowP(rA, JV), rowP(rB, JV), 0.5);
    [rA, rB].forEach(function (c) { for (var jj = 0; jj < 2; jj++) { var ii = (JV * 2 + jj) * 3, dx = c.x[ii] - cJ[0], dy = c.x[ii + 1] - cJ[1], dz = c.x[ii + 2] - cJ[2], dl = sqrt(dx * dx + dy * dy + dz * dz);
      if (dl > G.jade.gather) { var f = G.jade.gather / dl; c.x[ii] = cJ[0] + dx * f; c.x[ii + 1] = cJ[1] + dy * f; c.x[ii + 2] = cJ[2] + dz * f; } } });
    cJ = lerp3(rowP(rA, JV), rowP(rB, JV), 0.5);
    var tJ = norm(sub(lerp3(rowP(rA, JV - 1), rowP(rB, JV - 1), 0.5), lerp3(rowP(rA, JV + 1), rowP(rB, JV + 1), 0.5))), aJ = sub(rowP(rB, JV), rowP(rA, JV)); aJ = norm(sub(aJ, mul(tJ, dot(aJ, tJ))));
    var nJ = cross(aJ, tJ), out = [cJ[0] - root[0], 0, cJ[2] - root[2]]; if (dot(nJ, out) < 0) { nJ = mul(nJ, -1); aJ = mul(aJ, -1); }
    G.jade.state = { c: add(cJ, mul(nJ, G.jade.r + 0.0016)), n: nJ, t: tJ, a: aJ, rib: cJ }; }
  this.ancPrev = (this.ancPrev && this.ancPrev.length === anc.length) ? (this.ancPrev.set(anc), this.ancPrev) : new Float32Array(anc);
  }
  // bead chains (步搖 dangles): touching beads, the top bead touching the branch tip; collide with the hair cap
  var hb = sk.by.head, hq = W.q[hb], hp = W.p[hb], h0 = sk.bones[hb].p, HF = fig.hair && fig.hair.sdf;
  function toW(p) { return add(hp, qrot(hq, sub(p, h0))); }
  function toB(p) { return add(h0, qrot(qconj(hq), sub(p, hp))); }
  (fig.chains || []).forEach(function (ch) {
    var top = toW(ch.top), X = ch.x, PX = ch.px;
    for (var j = 0; j < X.length; j++) { var v = sub(X[j], PX[j]); PX[j] = X[j].slice(); X[j] = add(X[j], add(mul(v, 0.992), [0, gdt, 0])); }
    for (var it = 0; it < 8; it++) {
      for (j = 0; j < X.length; j++) {
        var a = j ? X[j - 1] : top, ra = j ? ch.beads[j - 1].r : ch.topR, d = sub(X[j], a), L = len(d), want = ra + ch.beads[j].r;
        if (L < 1e-9) continue;
        var corr = mul(d, (L - want) / L);
        if (j) { X[j - 1] = add(X[j - 1], mul(corr, 0.5)); X[j] = sub(X[j], mul(corr, 0.5)); } else X[j] = sub(X[j], corr);
      }
      if (HF) for (j = 0; j < X.length; j++) { var pb = toB(X[j]), dd = HF(pb[0], pb[1], pb[2], 0.05) - ch.beads[j].r - 0.0005; if (dd < 0) { var g = sdfGrad(HF, pb); X[j] = toW(sub(pb, mul(g, dd))); } }
      if (ch.collideBody && fig.body.headSdf) for (j = 0; j < X.length; j++) { var BF2 = fig.body.headSdf, pc = toB(X[j]), dc = BF2(pc[0], pc[1], pc[2], 0.05) - ch.beads[j].r - 0.0008; if (dc < 0) X[j] = toW(sub(pc, mul(sdfGrad(BF2, pc), dc))); }   // (earrings: off the jaw and neck)
    }
  });
  this.W = W;
};

/* ================= sewn garments on the cloth_sim solver (XPBD) =================
   The solver (cloth_sim/cloth.js: Cloth, ClothAsync, warmup) is an ES module; the host loads it and hands it over with
   FIG.setClothLib(module) before simulating (stage.js, tool/check.js). Garments are sewn here from flat panels
   (figure.<style>.json costume.<style>.garments); the body is a set of capsules fitted to her skinned surface. */
var CL = null;
function setClothLib(m) { CL = m; }
// ---- colliders: capsules fitted to the bind-pose body surface (one vertex per 8 mm voxel; not the face, fingers or
// toes), by gradient descent on the signed gap between the capsule union and the skin (skin outside the union costs 9×
// more than union outside the skin). Each capsule end is skinned with the mean weights of the skin it covers, so the
// colliders deform with the body (shoulders, hips) instead of riding rigidly on one bone.
var NOFIT = /^(head|tongue|lip|corner|cheek|brow|eye|lid|toe)/;
function capD(p, c, out) {   // signed distance from p to capsule c ({a, b, r}); out: [t, nx, ny, nz]
  var ax = c.a[0], ay = c.a[1], az = c.a[2], bx = c.b[0] - ax, by = c.b[1] - ay, bz = c.b[2] - az, l2 = bx * bx + by * by + bz * bz;
  var t = l2 > 1e-12 ? clamp(((p[0] - ax) * bx + (p[1] - ay) * by + (p[2] - az) * bz) / l2, 0, 1) : 0;
  var dx = p[0] - ax - bx * t, dy = p[1] - ay - by * t, dz = p[2] - az - bz * t, d = sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
  if (out) { out[0] = t; out[1] = dx / d; out[2] = dy / d; out[3] = dz / d; }
  return d - c.r;
}
function fitColliders(sk, body, log, G) {   // (G: the costume's garments; G.bustTips: also a small sphere on each bust's tip)
  var F = body.sdf, B = sk.bones, J = function (n) { return B[sk.by[n]].p; }, P = body.pos, nv = P.length / 3, caps = [];
  var seen = new Set(), S = [];
  for (var v = 0; v < nv; v++) { if (NOFIT.test(B[body.bi[v * 4]].name)) continue; var key = floor(P[v * 3] / 0.008) + ',' + floor(P[v * 3 + 1] / 0.008) + ',' + floor(P[v * 3 + 2] / 0.008); if (seen.has(key)) continue; seen.add(key); S.push(v); }
  function radiusAt(p, ax) { var t0 = perpOf(ax), t1 = cross(ax, t0), s = 0; for (var k = 0; k < 8; k++) { var d = add(mul(t0, cos(k * PI / 4)), mul(t1, sin(k * PI / 4))), r = 0; while (r < 0.2 && F(p[0] + d[0] * r, p[1] + d[1] * r, p[2] + d[2] * r, 1) < 0) r += 0.002; s += r; } return s / 8; }
  function cap(name, a, b, r) { caps.push({ name: name, a: a.slice(), b: b.slice(), r: r || radiusAt(lerp3(a, b, 0.5), norm(sub(b, a))) * 0.92 }); }
  function chain(name, pts) { for (var i = 0; i + 1 < pts.length; i++) cap(name + i, pts[i], pts[i + 1]); }
  // torso: columns at six azimuths per slab, inside the surface
  var ys = [0.76, 0.86, 0.96, 1.06, 1.16, 1.25, 1.33], ax0 = [0, -0.01];
  for (var k = 0; k + 1 < ys.length; k++) for (var j = 0; j < 6; j++) {
    var th = j * PI / 3 + PI / 6, ym = (ys[k] + ys[k + 1]) / 2, sp = surfaceRay(F, ym, th, ax0), R = Math.hypot(sp[0] - ax0[0], sp[2] - ax0[1]), r = min(0.07, 0.55 * R), d = R - r;
    var c = [ax0[0] + sin(th) * d, 0, ax0[1] + cos(th) * d]; cap('torso' + k + '_' + j, [c[0], ys[k] - 0.01, c[2]], [c[0], ys[k + 1] + 0.01, c[2]], r);
  }
  var best = [0, 0, 0];   // bust: a sphere per side at the most protruding point of the front
  for (var y = 1.04; y <= 1.3; y += 0.01) for (th = 0.15; th <= 1.1; th += 0.05) { var q = surfaceRay(F, y, th, ax0), rr = Math.hypot(q[0], q[2] - ax0[1]); if (rr > best[0]) best = [rr, y, th]; }
  ['L', 'R'].forEach(function (s, i) { var t2 = best[2] * (i ? -1 : 1), c2 = [sin(t2) * (best[0] - 0.05), best[1], ax0[1] + cos(t2) * (best[0] - 0.05)]; cap('bust' + s, c2, c2, 0.05); });
  cap('neck', J('neck'), lerp3(J('neck'), J('head'), 0.8)); cap('jaw', J('jaw'), sk.hl(0, -0.07, 0.065), 0.03);
  ['L', 'R'].forEach(function (s) {
    var A = J('arm' + s), E = J('fore' + s), W = J('hand' + s), Hh = J('middle1' + s), Cl = J('clav' + s);
    cap('shoulder' + s, lerp3(Cl, J('neck'), 0.3), A, 0.045); cap('deltoid' + s, A, lerp3(A, E, 0.3), 0.045);
    chain('upper' + s, [lerp3(A, E, 0.15), lerp3(A, E, 0.55), E]); chain('fore' + s, [E, lerp3(E, W, 0.5), W]);
    cap('hand' + s, W, Hh, 0.02); cap('knuckles' + s, J('index1' + s), J('pinky1' + s), 0.011); cap('palm' + s, lerp3(W, J('index1' + s), 0.45), lerp3(W, J('pinky1' + s), 0.45), 0.013);
    var tip = function (f) { var b = J(f + '3' + s); return add(b, mul(sub(b, J(f + '2' + s)), 0.85)); };
    cap('thumb' + s, J('thumb1' + s), tip('thumb'), 0.009); cap('fingersA' + s, lerp3(J('index1' + s), J('middle1' + s), 0.5), lerp3(tip('index'), tip('middle'), 0.5), 0.011); cap('fingersB' + s, lerp3(J('ring1' + s), J('pinky1' + s), 0.5), lerp3(tip('ring'), tip('pinky'), 0.5), 0.01);   // (two 'mittens' and the thumb)
    var T = J('thigh' + s), K = J('shin' + s), A2 = J('foot' + s), Tt = J('toe' + s);
    chain('thigh' + s, [lerp3(T, K, 0.1), lerp3(T, K, 0.55), K]); chain('shin' + s, [K, lerp3(K, A2, 0.5), A2]); cap('foot' + s, A2, Tt, 0.03); cap('heel' + s, [A2[0], 0.035, A2[2] - 0.02], lerp3(A2, Tt, 0.4), 0.03);
  });
  // optimize (Adam); candidates per sample: capsules within 5 cm of it at the start
  var NS = S.length, X = new Float32Array(NS * 3); S.forEach(function (v, i) { X[i * 3] = P[v * 3]; X[i * 3 + 1] = P[v * 3 + 1]; X[i * 3 + 2] = P[v * 3 + 2]; });
  var cand = [], p = [0, 0, 0], tmp = [0, 0, 0, 0];
  for (var i = 0; i < NS; i++) { p[0] = X[i * 3]; p[1] = X[i * 3 + 1]; p[2] = X[i * 3 + 2]; var l = []; caps.forEach(function (c, ci) { if (capD(p, c) < 0.05) l.push(ci); }); cand.push(l); }
  var NP = caps.length * 7, m1 = new Float64Array(NP), m2 = new Float64Array(NP), g = new Float64Array(NP), own = new Int32Array(NS), dS = new Float32Array(NS);
  function evalAll(grad) {
    var L = 0; if (grad) g.fill(0);
    for (var i = 0; i < NS; i++) {
      p[0] = X[i * 3]; p[1] = X[i * 3 + 1]; p[2] = X[i * 3 + 2]; var bd = 1e9, bc = -1, l = cand[i];
      for (var k = 0; k < l.length; k++) { var d = capD(p, caps[l[k]]); if (d < bd) { bd = d; bc = l[k]; } }
      own[i] = bc; dS[i] = bd; if (bc < 0) continue;
      var w = bd > 0 ? 9 : 1; L += w * bd * bd; if (!grad) continue;
      capD(p, caps[bc], tmp); var gd = 2 * w * bd, t = tmp[0], o = bc * 7;
      for (var q = 0; q < 3; q++) { g[o + q] -= gd * (1 - t) * tmp[1 + q]; g[o + 3 + q] -= gd * t * tmp[1 + q]; }
      g[o + 6] -= gd;
    }
    return L / NS;
  }
  var lr = 0.0015;
  for (var it = 1; it <= 300; it++) {
    evalAll(true);
    caps.forEach(function (c, ci) { var o = ci * 7, prm = [c.a[0], c.a[1], c.a[2], c.b[0], c.b[1], c.b[2], c.r];
      for (var q = 0; q < 7; q++) { var gi = g[o + q]; m1[o + q] = 0.9 * m1[o + q] + 0.1 * gi; m2[o + q] = 0.999 * m2[o + q] + 0.001 * gi * gi;
        prm[q] -= lr * (m1[o + q] / (1 - Math.pow(0.9, it))) / (sqrt(m2[o + q] / (1 - Math.pow(0.999, it))) + 1e-9); }
      c.a = prm.slice(0, 3); c.b = prm.slice(3, 6); c.r = max(0.008, prm[6]); });
    if (it === 200) lr *= 0.3;
  }
  evalAll(false);
  if (G && G.bustTips) ['L', 'R'].forEach(function (s) {   // per bust, where the fit leaves the most skin outside the capsules (its tip): a sphere of radius G.bustTips whose surface stands 2 mm out of that point
    var bc = caps.find(function (c) { return c.name === 'bust' + s; }), bi2 = -1, bd2 = 0;
    for (var i = 0; i < NS; i++) { var q = [X[i * 3], X[i * 3 + 1], X[i * 3 + 2]]; if ((q[0] > 0) === (s === 'L') && q[2] > bc.a[2] && len(sub(q, bc.a)) < bc.r + 0.03 && dS[i] > bd2) { bd2 = dS[i]; bi2 = i; } }
    if (bi2 < 0) return; var tp = [X[bi2 * 3], X[bi2 * 3 + 1], X[bi2 * 3 + 2]], c3 = sub(tp, mul(sdfGrad(F, tp), G.bustTips - 0.002)); cap('bustTip' + s, c3, c3, G.bustTips); });
  // skin weights of each capsule end: the mean weights of the skin it owns near that end (else of the nearest vertex)
  var hash = body.hash || (body.hash = VHash(body.pos, 0.01)), pos = [], bi = [], bw = [];
  caps.forEach(function (c, ci) { [0, 1].forEach(function (e) {
    var acc = {}, n = 0;
    for (var i = 0; i < NS; i++) { if (own[i] !== ci) continue; p[0] = X[i * 3]; p[1] = X[i * 3 + 1]; p[2] = X[i * 3 + 2]; capD(p, c, tmp); var wt = e ? tmp[0] : 1 - tmp[0]; if (c.a === c.b) wt = 1; if (wt <= 0.25) continue;
      var v = S[i]; for (var k = 0; k < 4; k++) { var b = body.bi[v * 4 + k], w = body.bw[v * 4 + k] * wt; if (w > 0) acc[b] = (acc[b] || 0) + w; } n += wt; }
    var E = e ? c.b : c.a;
    if (!n) { var vv = hash.near(E, 0.2); for (var k = 0; k < 4; k++) acc[body.bi[vv * 4 + k]] = (acc[body.bi[vv * 4 + k]] || 0) + body.bw[vv * 4 + k]; }
    var top = Object.keys(acc).map(function (b) { return [+b, acc[b]]; }).sort(function (x, y) { return y[1] - x[1]; }).slice(0, 4), sum = top.reduce(function (s, x) { return s + x[1]; }, 0);
    pos.push(E[0], E[1], E[2]); for (k = 0; k < 4; k++) { bi.push(top[k] ? top[k][0] : 0); bw.push(top[k] ? top[k][1] / sum : 0); }
  }); });
  var head = sk.hl(0, -0.01, 0);   // the skull: a fixed sphere on the head bone (the face is not fitted)
  caps.push({ name: 'head', a: head, b: head, r: 0.085 }); pos.push(head[0], head[1], head[2], head[0], head[1], head[2]); bi.push(sk.by.head, 0, 0, 0, sk.by.head, 0, 0, 0); bw.push(1, 0, 0, 0, 1, 0, 0, 0);
  var st = Array.from(dS).sort(function (a, b) { return a - b; }), pc = function (f) { return (st[floor(f * (NS - 1))] * 1000).toFixed(1); };
  if (log) log('colliders: ' + caps.length + ' capsules fitted to ' + NS + ' skin points; gap skin−capsules mm: p1 ' + pc(0.01) + ' p10 ' + pc(0.1) + ' median ' + pc(0.5) + ' p90 ' + pc(0.9) + ' p99 ' + pc(0.99) + ' max ' + pc(1));
  return { caps: caps, mesh: { pos: new Float32Array(pos), bi: new Uint8Array(bi), bw: new Float32Array(bw) }, gap: dS, samples: S };
}
// posed capsules (7 floats each) from the dual quaternions of a pose
function poseColl(C, DQ, out) {
  var n = C.caps.length, Pp = skin(C.mesh, DQ, C.tmp || (C.tmp = new Float32Array(n * 6))); out = out || new Float32Array(n * 7);
  for (var i = 0; i < n; i++) { for (var k = 0; k < 6; k++) out[i * 7 + k] = Pp[i * 6 + k]; out[i * 7 + 6] = C.caps[i].r; }
  return out;
}

// ---- flat patterns (after cloth_sim/garments.js): a panel is a closed counter-clockwise outline of named edges (metres),
// Delaunay-triangulated (boundary samples + a brick lattice inside) and placed around the body by place([x, y]) → 3D
function plen(P) { var l = 0; for (var i = 1; i < P.length; i++) l += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); return l; }
function resample(P, n) {   // n + 1 points evenly spaced by arc length
  var L = plen(P), out = [P[0].slice()], seg = 1, acc = 0;
  for (var k = 1; k < n; k++) { var tg = L * k / n, d;
    while (seg < P.length - 1 && acc + (d = Math.hypot(P[seg][0] - P[seg - 1][0], P[seg][1] - P[seg - 1][1])) < tg) { acc += d; seg++; }
    d = Math.hypot(P[seg][0] - P[seg - 1][0], P[seg][1] - P[seg - 1][1]); var f = d > 0 ? (tg - acc) / d : 0;
    out.push([P[seg - 1][0] + (P[seg][0] - P[seg - 1][0]) * f, P[seg - 1][1] + (P[seg][1] - P[seg - 1][1]) * f]); }
  out.push(P[P.length - 1].slice()); return out;
}
function bez(p0, p1, p2, p3, n) { var o = []; n = n || 32; for (var i = 0; i <= n; i++) { var t = i / n, u = 1 - t; o.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]); } return o; }
function inPoly(P, x, y) { var c = false; for (var i = 0, j = P.length - 1; i < P.length; j = i++) { var a = P[i], b = P[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
function dPoly(P, x, y) { var best = Infinity; for (var i = 0, j = P.length - 1; i < P.length; j = i++) { var a = P[j], b = P[i], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy, t = l2 > 0 ? clamp(((x - a[0]) * dx + (y - a[1]) * dy) / l2, 0, 1) : 0, ex = a[0] + dx * t - x, ey = a[1] + dy * t - y; best = min(best, ex * ex + ey * ey); } return sqrt(best); }
function delaunay(P) {   // Bowyer–Watson; triangles [i, j, k] counter-clockwise
  var n = P.length, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  P.forEach(function (p) { x0 = min(x0, p[0]); x1 = max(x1, p[0]); y0 = min(y0, p[1]); y1 = max(y1, p[1]); });
  var d = max(x1 - x0, y1 - y0) * 10, mx = (x0 + x1) / 2, my = (y0 + y1) / 2, pts = P.concat([[mx - 2 * d, my - d], [mx, my + 2 * d], [mx + 2 * d, my - d]]);
  function mk(a, b, c) { var ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1], cx = pts[c][0], cy = pts[c][1], D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by)); if (abs(D) < 1e-18) return null;
    var ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D, uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D;
    return { a: a, b: b, c: c, ux: ux, uy: uy, r2: sq(ax - ux) + sq(ay - uy) }; }
  var tris = [mk(n, n + 1, n + 2)];
  for (var i = 0; i < n; i++) {
    var px = pts[i][0], py = pts[i][1], bad = [], edges = new Map();
    for (var t = 0; t < tris.length; t++) { var T = tris[t]; if (sq(px - T.ux) + sq(py - T.uy) < T.r2 * (1 + 1e-12)) bad.push(t); }
    bad.forEach(function (t) { var T = tris[t]; [[T.a, T.b], [T.b, T.c], [T.c, T.a]].forEach(function (e) { var k = e[0] < e[1] ? e[0] + ',' + e[1] : e[1] + ',' + e[0], E = edges.get(k); if (E) E.n++; else edges.set(k, { a: e[0], b: e[1], n: 1 }); }); });
    for (var k = bad.length - 1; k >= 0; k--) { tris[bad[k]] = tris[tris.length - 1]; tris.pop(); }
    edges.forEach(function (e) { if (e.n === 1) { var T2 = mk(e.a, e.b, i); if (T2) tris.push(T2); } });
  }
  var out = [];
  tris.forEach(function (T) { if (T.a >= n || T.b >= n || T.c >= n) return; var a = pts[T.a], b = pts[T.b], c = pts[T.c], s = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]); out.push(s >= 0 ? [T.a, T.b, T.c] : [T.a, T.c, T.b]); });
  return out;
}
function Panel(name, place, outward) { this.name = name; this.place = place; this.outward = outward; this.edges = []; }
Panel.prototype.edge = function (name, pts, n) { this.edges.push({ name: name, pts: resample(pts, n) }); return this; };
Panel.prototype.build = function (S) {
  var outline = [], E = {}, self = this;
  this.edges.forEach(function (e) { var ids = []; for (var k = 0; k < e.pts.length - 1; k++) { ids.push(outline.length); outline.push(e.pts[k]); } E[e.name] = ids; });
  this.edges.forEach(function (e, i) { E[e.name].push(E[self.edges[(i + 1) % self.edges.length].name][0]); });   // last point = the next edge's first
  var pts = outline.map(function (p) { return p.slice(); }), x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, h = S * sqrt(3) / 2, seed = 7, rnd = function () { return (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5; };
  outline.forEach(function (p) { x0 = min(x0, p[0]); x1 = max(x1, p[0]); y0 = min(y0, p[1]); y1 = max(y1, p[1]); });
  for (var j = 0, y = y0 + 0.5 * h; y < y1; j++, y += h) for (var x = x0 + (0.5 + 0.5 * (j & 1)) * S; x < x1; x += S) { var px = x + 0.02 * S * rnd(), py = y + 0.02 * S * rnd(); if (inPoly(outline, px, py) && dPoly(outline, px, py) > 0.55 * S) pts.push([px, py]); }
  this.tris = delaunay(pts).filter(function (t) { return inPoly(outline, (pts[t[0]][0] + pts[t[1]][0] + pts[t[2]][0]) / 3, (pts[t[0]][1] + pts[t[1]][1] + pts[t[2]][1]) / 3); });
  this.pts = pts; this.E = E; return this;
};
// sew panels into one cloth mesh: seams [A, edgeA, B, edgeB, reversed] weld vertex pairs along the edges, welds [[A, i, B, j]]
// single vertices. Per panel: vmap (panel vertex → cloth particle) and its triangles (for rendering with the pattern uv)
function sew(panels, seams, welds, S, log) {
  panels.forEach(function (p) { p.build(p.S || S); }); welds = welds ? welds() : [];
  var off = [], n = 0; panels.forEach(function (p) { off.push(n); n += p.pts.length; });
  var par = new Int32Array(n); for (var i = 0; i < n; i++) par[i] = i;
  function find(i) { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; }
  function uni(a, b) { a = find(a); b = find(b); if (a !== b) par[max(a, b)] = min(a, b); }
  var at = function (p) { return off[panels.indexOf(p)]; };
  seams.forEach(function (s) { var ia = s[0].E[s[1]], ib = s[2].E[s[3]]; if (!ia || !ib) throw new Error('unknown seam edge ' + s[0].name + '.' + s[1] + ' / ' + s[2].name + '.' + s[3]);
    var na = ia.length - 1, nb = ib.length - 1; if (na !== nb && log) log('seam ' + s[0].name + '.' + s[1] + ' (' + na + ') vs ' + s[2].name + '.' + s[3] + ' (' + nb + ')');
    for (var k = 0; k <= na; k++) { var kb = Math.round(k * nb / na); uni(at(s[0]) + ia[k], at(s[2]) + ib[s[4] ? nb - kb : kb]); } });
  welds.forEach(function (w) { uni(at(w[0]) + w[1], at(w[2]) + w[3]); });
  var remap = new Int32Array(n).fill(-1), m = 0; for (i = 0; i < n; i++) if (find(i) === i) remap[i] = m++;
  for (i = 0; i < n; i++) remap[i] = remap[find(i)];
  var pos = new Float32Array(3 * m), placed = new Uint8Array(m), idx = [], uvT = [];
  panels.forEach(function (p, pi) {
    var o = off[pi]; p.vmap = new Int32Array(p.pts.length); p.P3 = [];
    p.pts.forEach(function (q, i) { var g = remap[o + i], X = p.place(q); p.vmap[i] = g; p.P3.push(X); if (!placed[g]) { pos.set(X, 3 * g); placed[g] = 1; } });
    var flip = 0; p.tris.forEach(function (t, ti) { if (ti % 7) return; var A = p.P3[t[0]], B = p.P3[t[1]], C = p.P3[t[2]], nn = cross(sub(B, A), sub(C, A)), q = p.pts, ow = p.outward(lerp3(lerp3(A, B, 0.5), C, 1 / 3), [(q[t[0]][0] + q[t[1]][0] + q[t[2]][0]) / 3, (q[t[0]][1] + q[t[1]][1] + q[t[2]][1]) / 3]); flip += dot(nn, ow) < 0 ? 1 : -1; });
    p.flip = flip > 0; p.t0 = idx.length / 3; p.rtris = [];
    p.tris.forEach(function (t) { var a = t[0], b = flip > 0 ? t[2] : t[1], c = flip > 0 ? t[1] : t[2]; p.rtris.push(a, b, c);
      var ga = p.vmap[a], gb = p.vmap[b], gc = p.vmap[c]; if (ga === gb || gb === gc || ga === gc) return;
      idx.push(ga, gb, gc); uvT.push(p.pts[a][0], p.pts[a][1], p.pts[b][0], p.pts[b][1], p.pts[c][0], p.pts[c][1]); });
    p.t1 = idx.length / 3;
  });
  return { positions: pos, indices: new Uint32Array(idx), uvTri: new Float32Array(uvT), n: m };
}
// the body's outer cross-section at height y: rays from the axis c (first exit, so the arms never count) above the
// crotch, the outermost surface of both legs below; pushed out to the convex hull, by arc length from the front (+z)
// toward +x. Cached per 5 mm.
function Hull(F, c) {
  var cache = {}, N = 128;
  return function (y) {
    var k = Math.round(y / 0.005); if (cache[k]) return cache[k]; y = k * 0.005; var P = [];
    for (var j = 0; j < N; j++) { var th = 2 * PI * j / N, q;
      if (y >= 0.77) q = surfaceRay(F, y, th, c); else { var dx = sin(th), dz = cos(th), r = 0.3; while (r > 0.01 && F(c[0] + dx * r, y, c[1] + dz * r, 1) > 0) r -= 0.002; q = [c[0] + dx * r, y, c[1] + dz * r]; }
      P.push(q); }
    P = hullRing(P, c); var cum = [0]; for (j = 1; j <= N; j++) cum.push(cum[j - 1] + Math.hypot(P[j % N][0] - P[j - 1][0], P[j % N][2] - P[j - 1][2]));
    return (cache[k] = { P: P, cum: cum, L: cum[N], N: N, c: c, y: y });
  };
}
function hullAt(H, f, k, off) {   // point at arc fraction f (0 = front, 0.25 = +x side, 0.5 = back), scaled by k about the axis, off outward
  var s = ((f % 1) + 1) % 1 * H.L, j = 1; while (j < H.N && H.cum[j] < s) j++;
  var a = H.P[j - 1], b = H.P[j % H.N], u = (s - H.cum[j - 1]) / max(1e-9, H.cum[j] - H.cum[j - 1]), x = a[0] + (b[0] - a[0]) * u, z = a[2] + (b[2] - a[2]) * u;
  var tl = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1, nx = -(b[2] - a[2]) / tl, nz = (b[0] - a[0]) / tl;
  return [H.c[0] + (x - H.c[0]) * k + nx * off, H.y, H.c[1] + (z - H.c[1]) * k + nz * off];
}
function hullF(H, th) { var j = (((th / (2 * PI)) % 1) + 1) % 1 * H.N, i = floor(j); return (H.cum[i] + (H.cum[min(i + 1, H.N)] - H.cum[i]) * (j - i)) / H.L; }   // arc fraction of azimuth th
// pull a point out of the capsules (+ gap): a few passes for overlapping ones
function pushOut(p, caps, gap) { for (var pass = 0; pass < 4; pass++) caps.forEach(function (c) { var t = [0, 0, 0, 0], d = capD(p, c, t); if (d < gap) { p[0] += t[1] * (gap - d); p[1] += t[2] * (gap - d); p[2] += t[3] * (gap - d); } }); return p; }
// Catmull-Rom path through keys [{p, n}] (n: the body normal there; the strip's width runs along tangent × n), by arc length
function Path(keys) {
  var P = keys.map(function (k) { return k.p; }), Nn = keys.map(function (k) { return k.n; });
  var cr = function (A, i, t) { var p0 = A[max(0, i - 1)], p1 = A[i], p2 = A[min(A.length - 1, i + 1)], p3 = A[min(A.length - 1, i + 2)];
    return [0, 1, 2].map(function (k) { return 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t * t + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t * t * t); }); };
  var D = []; for (var i = 0; i < P.length - 1; i++) for (var k = 0; k < 20; k++) D.push({ p: cr(P, i, k / 20), n: cr(Nn, i, k / 20) }); D.push({ p: P[P.length - 1], n: Nn[Nn.length - 1] });
  var cum = [0]; for (i = 1; i < D.length; i++) cum.push(cum[i - 1] + len(sub(D[i].p, D[i - 1].p)));
  return { L: cum[cum.length - 1], at: function (s) { var i = 1; while (i < cum.length - 1 && cum[i] < s) i++; var f = clamp((s - cum[i - 1]) / max(1e-9, cum[i] - cum[i - 1]), 0, 1);
    var t = norm(sub(D[i].p, D[i - 1].p)), n = norm(lerp3(D[i - 1].n, D[i].n, f)); return { p: lerp3(D[i - 1].p, D[i].p, f), t: t, w: norm(cross(t, n)), n: n }; } };
}

// ---- the 帔帛 drawn in shawl.html (shawl.<style>.json: {pose: 'A' | 'rest', points (world, in that pose), roll (degrees per
// point), w, spacing, fabric, pins: [{i (point), bone ('auto' = nearest), compliance (0 = rigid), offset (along the normal)}]}).
// The centreline is a centripetal Catmull-Rom curve through the points; the strip's flat side faces the nearest surface: a
// collider (capsules posed in the laying pose: 7 floats each) or, when given (cl: {P, N, skip}), a dressed garment particle
// (positions, normals, skip(i) for the shawl's own); smoothed along the curve, then turned by the roll about the tangent.
// A pin's offset is along the nearest collider's normal (capNormal).
function layPose(sk, pose) { if (pose !== 'rest') return bindW(sk); var rc = defaultControls(); rc.lipPress = 0.6; return solve(sk, rc); }   // (as GSim.reset)
function capNormal(p, caps) { var bd = 1e9, n = [0, 0, 1], o = [0, 0, 0, 0]; for (var c = 0; c < caps.length / 7; c++) { var r = caps[c * 7 + 6]; if (r <= 0) continue; var e = capD(p, { a: [caps[c * 7], caps[c * 7 + 1], caps[c * 7 + 2]], b: [caps[c * 7 + 3], caps[c * 7 + 4], caps[c * 7 + 5]], r: r }, o); if (e < bd) { bd = e; n = [o[1], o[2], o[3]]; } } return { n: n, d: bd }; }
function shawlStrip(sp, caps, cl) {
  var P = sp.points, n = P.length, R = sp.roll || [], D = [], knot = [0], NSEG = 24;
  var tk = function (a, b) { return sqrt(max(1e-6, len(sub(b, a)))); }, L2 = function (a, b, ta, tb, t) { return lerp3(a, b, (t - ta) / (tb - ta)); };
  for (var i = 0; i + 1 < n; i++) {
    var p1 = P[i], p2 = P[i + 1], p0 = i > 0 ? P[i - 1] : sub(mul(p1, 2), p2), p3 = i + 2 < n ? P[i + 2] : sub(mul(p2, 2), p1), t1 = tk(p0, p1), t2 = t1 + tk(p1, p2), t3 = t2 + tk(p2, p3);
    for (var k = 0; k < NSEG; k++) { var t = t1 + (t2 - t1) * k / NSEG, A1 = L2(p0, p1, 0, t1, t), A2 = L2(p1, p2, t1, t2, t), A3 = L2(p2, p3, t2, t3, t);   // (Barry–Goldman)
      D.push({ p: L2(L2(A1, A2, 0, t2, t), L2(A2, A3, t1, t3, t), t1, t2, t), r: mix(R[i] || 0, R[i + 1] || 0, smooth(0, 1, k / NSEG)) }); }
    knot.push(D.length);
  }
  D.push({ p: P[n - 1].slice(), r: R[n - 1] || 0 });
  var cum = [0]; for (i = 1; i < D.length; i++) cum.push(cum[i - 1] + len(sub(D[i].p, D[i - 1].p)));
  D.forEach(function (d) { var cn = capNormal(d.p, caps); d.n = cn.n; if (!cl) return; var bd = cn.d * cn.d, bi = -1, CP = cl.P, p = d.p;
    for (var i = 0, m = CP.length / 3; i < m; i++) { if (cl.skip(i)) continue; var dx = p[0] - CP[i * 3], dy = p[1] - CP[i * 3 + 1], dz = p[2] - CP[i * 3 + 2], e = dx * dx + dy * dy + dz * dz; if (e < bd) { bd = e; bi = i; } }
    if (bi >= 0) { var gn = [cl.N[bi * 3], cl.N[bi * 3 + 1], cl.N[bi * 3 + 2]]; d.n = dot(gn, cn.n) < 0 ? mul(gn, -1) : gn; } });   // (its plane; the side away from the body)
  for (var pass = 0; pass < 24; pass++) { var nn = D.map(function (d, j) { return norm(add(add(D[max(0, j - 1)].n, mul(d.n, 2)), D[min(D.length - 1, j + 1)].n)); }); D.forEach(function (d, j) { d.n = nn[j]; }); }
  D.forEach(function (d, j) { var t = norm(sub(D[min(D.length - 1, j + 1)].p, D[max(0, j - 1)].p)), m = sub(d.n, mul(t, dot(d.n, t))); m = len(m) > 1e-6 ? norm(m) : j ? D[j - 1].n : perpOf(t);
    var a = d.r * PI / 180; d.t = t; d.n = norm(add(mul(m, cos(a)), mul(cross(t, m), sin(a)))); d.w = norm(cross(t, d.n)); });
  return { L: cum[cum.length - 1], D: D, caps: caps, knots: knot.map(function (k) { return cum[k]; }), at: function (s) { var i = 1; while (i < cum.length - 1 && cum[i] < s) i++; var f = clamp((s - cum[i - 1]) / max(1e-9, cum[i] - cum[i - 1]), 0, 1);
    var t = norm(sub(D[i].p, D[i - 1].p)), nv = norm(lerp3(D[i - 1].n, D[i].n, f)); return { p: lerp3(D[i - 1].p, D[i].p, f), t: t, w: norm(cross(t, nv)), n: nv }; } };
}
// the built-in shawl as settled by GSim.reset in the A-pose (P: reset(…, true)), as a drawn one: its centreline at the key points
// (spans over 20 cm subdivided), the pins where they are, auto orientation; shawl.html starts from it without shawl.<style>.json
function shawlFromCloth(G, P) {
  var d = G.shawlDefault, pn = G.pieces.shawl[0], X = function (v) { return [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]; }, near = function (x, s) { var bv = 0, bd = 1e9; pn.uv.forEach(function (q, k) { var e = sq(q[0] - x) + sq(q[1] - s); if (e < bd) { bd = e; bv = pn.vmap[k]; } }); return X(bv); };
  var ks = []; d.knots.forEach(function (s, i) { if (i) { var s0 = d.knots[i - 1], m = ceil((s - s0) / 0.2); for (var k = 1; k < m; k++) ks.push(mix(s0, s, k / m)); } ks.push(s); });   // (spans over 20 cm subdivided)
  var pts = ks.map(function (s) { return near(0, s); }), pins = [];
  G.pins.forEach(function (p) { if (p.piece !== 'shawl') return; var q = X(p.i), bi = 0, bd = 1e9; pts.forEach(function (x, i) { var e = len(sub(x, q)); if (e < bd) { bd = e; bi = i; } }); pts[bi] = q; pins.push({ i: bi, bone: 'auto', compliance: 0, offset: 0 }); });
  return { version: 1, pose: 'A', points: pts, roll: pts.map(function () { return 0; }), w: d.w, spacing: d.spacing, fabric: d.fabric, pins: pins };
}
// the bones a pin can follow (each a segment to its child); 'auto' = the nearest in the pose W
var PIN_BONES = (function () { var o = { root: 'spine', spine: 'spine2', spine2: 'chest', chest: 'neck', neck: 'head', head: null }; ['L', 'R'].forEach(function (S) { [['clav', 'arm'], ['arm', 'fore'], ['fore', 'hand'], ['hand', 'middle1'], ['thigh', 'shin'], ['shin', 'foot'], ['foot', 'toe']].forEach(function (e) { o[e[0] + S] = e[1] + S; }); }); return o; })();
function shawlBone(sk, W, p, name) {
  if (name && name !== 'auto' && sk.by[name] !== undefined) return sk.by[name];
  var best = sk.by.chest, bd = 1e9; for (var nm in PIN_BONES) { var a = W.p[sk.by[nm]], ch = PIN_BONES[nm], d = capD(p, { a: a, b: ch ? W.p[sk.by[ch]] : a, r: 0 }); if (d < bd) { bd = d; best = sk.by[nm]; } }
  return best;
}
// problems of the shawl in a cloth state P (the garb's particles): triangles pierced by a collider (centroid more than 1 mm
// inside a capsule: the body or a hand through the strip) and shawl edges through the robe, sleeves or skirt (segment–triangle,
// as tool/check.js G2b). → {pierced: [triangle of G.issues.S], by: {capsule: count}, crossing: [edge of G.issues.E]}
function shawlIssues(G, P, caps) {
  var Z = G.issues || (G.issues = (function () {
    var tris = function (re) { var I = []; Object.keys(G.pieces).forEach(function (nm) { if (re.test(nm)) G.pieces[nm].forEach(function (pn) { for (var k = 0; k < pn.tris.length; k += 3) { var a = pn.vmap[pn.tris[k]], b = pn.vmap[pn.tris[k + 1]], c = pn.vmap[pn.tris[k + 2]]; if (a !== b && b !== c && a !== c) I.push(a, b, c); } }); }); return I; };
    var S = tris(/^shawl$/), E = [], seen = new Set(); for (var k = 0; k < S.length; k += 3) for (var e = 0; e < 3; e++) { var a = S[k + e], b = S[k + (e + 1) % 3], key = min(a, b) * 1e6 + max(a, b); if (!seen.has(key)) { seen.add(key); E.push(a, b); } }
    return { S: S, E: E, T: tris(/^(robe|sleeve|skirt)/) };
  })());
  var out = { pierced: [], by: {}, crossing: [] }, nc = caps.length / 7, S = Z.S, T = Z.T, E = Z.E, names = G.coll.caps;
  for (var k = 0; k < S.length; k += 3) { var a = S[k] * 3, b = S[k + 1] * 3, c = S[k + 2] * 3, x = (P[a] + P[b] + P[c]) / 3, y = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, z = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    for (var q = 0; q < nc; q++) { var o = q * 7, r = caps[o + 6]; if (r <= 0) continue; var ax = caps[o], ay = caps[o + 1], az = caps[o + 2], bx = caps[o + 3] - ax, by = caps[o + 4] - ay, bz = caps[o + 5] - az, l2 = bx * bx + by * by + bz * bz, s = l2 > 1e-12 ? clamp(((x - ax) * bx + (y - ay) * by + (z - az) * bz) / l2, 0, 1) : 0;
      if (Math.hypot(x - ax - bx * s, y - ay - by * s, z - az - bz * s) - r < -0.001) { out.pierced.push(k / 3); var nm = names[q] ? names[q].name.replace(/\d+$/, '') : '?'; out.by[nm] = (out.by[nm] || 0) + 1; break; } } }
  var cell = 0.04, grid = new Map(), key = function (x, y, z) { return floor(x / cell) + ',' + floor(y / cell) + ',' + floor(z / cell); };
  for (var t = 0; t < T.length; t += 3) { var v0 = T[t] * 3, v1 = T[t + 1] * 3, v2 = T[t + 2] * 3, lo = [0, 1, 2].map(function (i) { return floor(min(P[v0 + i], P[v1 + i], P[v2 + i]) / cell); }), hi = [0, 1, 2].map(function (i) { return floor(max(P[v0 + i], P[v1 + i], P[v2 + i]) / cell); });
    for (var gx = lo[0]; gx <= hi[0]; gx++) for (var gy = lo[1]; gy <= hi[1]; gy++) for (var gz = lo[2]; gz <= hi[2]; gz++) { var kk = gx + ',' + gy + ',' + gz; (grid.get(kk) || grid.set(kk, []).get(kk)).push(t); } }
  for (var e = 0; e < E.length; e += 2) { var i = E[e], j = E[e + 1], hit = false, cand = new Set((grid.get(key(P[i * 3], P[i * 3 + 1], P[i * 3 + 2])) || []).concat(grid.get(key(P[j * 3], P[j * 3 + 1], P[j * 3 + 2])) || []));
    cand.forEach(function (t) { if (!hit && segTri(P, i, j, T[t], T[t + 1], T[t + 2])) hit = true; }); if (hit) out.crossing.push(e / 2); }
  return out;
}
function segTri(P, i, j, a, b, c) {   // does segment ij cross triangle abc (Möller–Trumbore, both ends on either side; tool/check.js)
  if (i === a || i === b || i === c || j === a || j === b || j === c) return false;
  var ox = P[i * 3], oy = P[i * 3 + 1], oz = P[i * 3 + 2], dx = P[j * 3] - ox, dy = P[j * 3 + 1] - oy, dz = P[j * 3 + 2] - oz, Ax = P[a * 3], Ay = P[a * 3 + 1], Az = P[a * 3 + 2];
  var e1x = P[b * 3] - Ax, e1y = P[b * 3 + 1] - Ay, e1z = P[b * 3 + 2] - Az, e2x = P[c * 3] - Ax, e2y = P[c * 3 + 1] - Ay, e2z = P[c * 3 + 2] - Az;
  var px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x, det = e1x * px + e1y * py + e1z * pz; if (abs(det) < 1e-14) return false;
  var inv = 1 / det, sx = ox - Ax, sy = oy - Ay, sz = oz - Az, u = (sx * px + sy * py + sz * pz) * inv; if (u < 0 || u > 1) return false;
  var qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x, v = (dx * qx + dy * qy + dz * qz) * inv; if (v < 0 || u + v > 1) return false;
  var tt = (e2x * qx + e2y * qy + e2z * qz) * inv; return tt > 0 && tt < 1;
}
// shawl.<style>.json next to the figure files (Node; the stage fetches it), or null
function shawlFile(style, dir) { try { var fs = require('fs'), f = require('path').join(dir, 'shawl.' + (style || 'tang') + '.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch (e) { return null; } }
// the built-in drawn 帔帛 per costume (made in shawl.html; a shawl.<style>.json, &shawl=file or cfg.shawl overrides it, cfg.shawl
// false = the older built-in path through key points in sewTang)
var SHAWL_DEF = { tang: { version: 1, pose: 'A', w: 0.16, spacing: 0.02, fabric: {mass: 0.06, bend: 40, friction: 0.5}, pins: [{i: 7, bone: 'auto', compliance: 0, offset: 0}, {i: 17, bone: 'auto', compliance: 0, offset: 0}], roll: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], points: [
  [-0.4846,0.1543,0.237],
  [-0.3828,0.3417,0.2184],
  [-0.3332,0.4371,0.1554],
  [-0.347,0.6109,0.0968],
  [-0.3028,0.7866,0.0777],
  [-0.2971,0.93,0.0652],
  [-0.3151,1.0378,0.0525],
  [-0.3666,1.1306,-0.0109],
  [-0.338,1.0536,-0.0845],
  [-0.2656,0.9627,-0.1367],
  [-0.2368,0.8973,-0.1581],
  [-0.1476,0.8184,-0.2066],
  [-0.0138,0.784,-0.2506],
  [0.1281,0.8458,-0.2233],
  [0.2102,0.9246,-0.1657],
  [0.2682,0.9814,-0.1256],
  [0.3185,1.0707,-0.0853],
  [0.3654,1.132,-0.0146],
  [0.3661,1.0449,0.05],
  [0.3645,0.9189,0.0674],
  [0.3562,0.8115,0.0785],
  [0.3438,0.6009,0.1112],
  [0.3507,0.4432,0.1773],
  [0.2496,0.3718,0.1906],
  [0.2388,0.202,0.2265]] } };
function withShawl(G, sp) { return sp && G.shawl ? Object.assign({}, G, { shawl: Object.assign({}, G.shawl, { w: sp.w || G.shawl.w, spacing: sp.spacing || G.shawl.spacing, fabric: Object.assign({}, G.shawl.fabric, sp.fabric), path: sp }) }) : G; }

/* ---- the Tang garments, sewn (costume.tang.garments in figure.tang.json; metres, 2D pattern coordinates):
   裙 skirt: a high-waisted (齊胸) skirt of three flared panels (front, back-left, back-right; annular sectors, so the hem
   hangs level) sewn to the 裙腰 band, a straight strip round the chest above the bust, closed by a back seam and held by
   a few pins on its top edge. 大袖紗羅衫 robe: open-fronted (對襟) gauze robe, a back and two fronts sewn at the shoulders
   and sides, very wide sleeves (大袖) set into straight armholes and closed underneath, held at the back neck. 帔帛 shawl:
   a long strip over the back and both forearms, held at three points of the back and three over each forearm. 裙帶:
   two ribbons whose top edges are gathered into one point of the band each (the knot sits there). */
function sewTang(sk, body, C, G, log) {
  var F = body.sdf, S = G.spacing, c0 = [0, -0.01], H = Hull(F, c0), J = function (n) { return sk.bones[sk.by[n]].p; }, caps = C.caps.slice(0, -1);
  var NN = function (l) { return max(2, Math.round(l / S)); }, panels = [], seams = [], th0 = G.solver.thickness, gap = th0 + 0.003;
  function addP(p, nm) { p.piece = nm; panels.push(p); return p; }
  var radial = function (q) { return [q[0] - c0[0], 0, q[2] - c0[1]]; };
  // --- band (裙腰): x = arc from the centre back toward +x (her left), y up from its lower edge
  var B = G.band, top = function (th) { var c = cos(th); return c > 0 ? mix(B.side, B.top[0], c) : mix(B.side, B.top[1], c * c); };
  var bandY = function (f, y) { return top(PI - 2 * PI * f) - B.h + y; }, Lb = H(bandY(0.5, B.h / 2)).L + B.ease, bandK = function (yy) { return (Lb - 2 * PI * gap) / H(yy).L; };
  var yFit = function (y) { return min(bandY(0.5, y), B.side); }, Lfit = B.fit ? function (y) { return H(yFit(y)).L + B.ease; } : null, x0 = function (y) { return Lfit ? (Lb - Lfit(y)) / 2 : 0; };   // (fit: the Song 抹胸, each row as long as the hull there, at most at the side top: higher, the hull takes in the arms)
  if (Lfit) { Lb = Lfit(0); bandK = function (yy, y) { return (Lfit(y) - 2 * PI * gap) / H(yFit(y)).L; }; }
  var bandAt = function (f, y, off) { var yy = bandY(f, y), p = hullAt(H(yy), 0.5 - f, bandK(yy, y), off); p[2] += B.fwd || 0; return p; };   // (B.fwd: the band, its pins and the skirt hung from it moved toward her front, metres)
  var band = addP(new Panel('band', function (q) { return pushOut(bandAt(Lfit ? (q[0] - x0(q[1])) / Lfit(q[1]) : q[0] / Lb, q[1], gap), caps, gap); }, radial), 'band'), nq = NN(Lb / 4), nh = NN(B.h);
  if (B.spacing) { band.S = B.spacing; nq = max(2, Math.round(Lb / 4 / B.spacing)); nh = max(2, Math.round(B.h / B.spacing)); }   // (its own, finer spacing: the 抹胸 over the bust)
  var endP = function (s) { var P = []; for (var k = 0; k <= 12; k++) { var y = B.h * k / 12; P.push([s > 0 ? Lb - x0(y) : x0(y), y]); } return s > 0 ? P : P.reverse(); };
  band.edge('b1', [[0, 0], [Lb / 4, 0]], nq).edge('bF', [[Lb / 4, 0], [3 * Lb / 4, 0]], 2 * nq).edge('b2', [[3 * Lb / 4, 0], [Lb, 0]], nq)
    .edge('end2', Lfit ? endP(1) : [[Lb, 0], [Lb, B.h]], nh).edge('top', [[Lb - x0(B.h), B.h], [x0(B.h), B.h]], Lfit ? max(2, Math.round(Lfit(B.h) / (B.spacing || S))) : 4 * nq).edge('end1', Lfit ? endP(-1) : [[0, B.h], [0, 0]], nh);
  seams.push([band, 'end1', band, 'end2', true]);
  band.pinPts = (B.pins || []).map(function (f) { return [x0(B.h) + f * (Lfit ? Lfit(B.h) : Lb), B.h]; });
  // --- skirt: annular sectors hanging from the band's lower edge; generatrix length L(u) (longer at the front centre, over the bust)
  var K = G.skirt, Ls = bandY(0.25, 0) - K.hemY, dR = (K.hem - Lb) / (2 * PI);
  function skirtPanel(name, fA, fB, hem, Lc, nw) {
    var w = abs(fB - fA) * Lb, r1 = Ls * w / (hem - w), al = w / r1, Lf = function (u) { return Ls + (Lc - Ls) * sq(cos(PI * u / 2)); };
    var pt = function (u, rho) { var ph = u * al / 2; return [rho * sin(ph), -rho * cos(ph)]; };
    var place = function (q) {
      var rho = Math.hypot(q[0], q[1]), u = clamp(Math.atan2(q[0], -q[1]) / (al / 2), -1, 1), f = mix(fA, fB, (u + 1) / 2), s = max(0, rho - r1);
      var tp = bandAt(f, 0, gap), dr = dR * s / Lf(u), dn = norm(radial(tp));
      var y = tp[1] - sqrt(max(0, s * s - dr * dr)), ex = max(0, 0.02 - y);   // (below the floor: laid out on it, to pool)
      return pushOut([tp[0] + dn[0] * (dr + ex), 0.02 + 0.05 * ex + max(0, y - 0.02), tp[2] + dn[2] * (dr + ex)], caps, gap); };
    var P = addP(new Panel(name, place, radial), 'skirt'), arc = function (rf, a, b) { var o = []; for (var k = 0; k <= 48; k++) { var u = mix(a, b, k / 48); o.push(pt(u, rf(u))); } return o; };
    P.edge('hem', arc(function (u) { return r1 + Lf(u); }, -1, 1), NN(hem)).edge('eR', [pt(1, r1 + Ls), pt(1, r1)], NN(Ls))
      .edge('waist', arc(function () { return r1; }, 1, -1), nw).edge('eL', [pt(-1, r1), pt(-1, r1 + Ls)], NN(Ls));
    return P;
  }
  var hB = K.hem * (K.back || 0.5), sF = skirtPanel('skirtF', 0.75, 0.25, K.hem - hB, bandY(0.5, 0) - K.hemY + K.front, 2 * nq), sBL = skirtPanel('skirtBL', 0, 0.25, hB / 2, Ls, nq), sBR = skirtPanel('skirtBR', 0.75, 1, hB / 2, Ls, nq);   // (back: less fullness)
  seams.push([band, 'b1', sBL, 'waist', true], [band, 'bF', sF, 'waist', false], [band, 'b2', sBR, 'waist', true], [sF, 'eR', sBL, 'eR', false], [sF, 'eL', sBR, 'eL', false], [sBL, 'eL', sBR, 'eR', true]);
  // the skirt's (and band's) placed radius at arc fraction f of the band and height y: outer layers start outside it
  var envR = function (f, y) { var tp = bandAt(f, 0, gap), r = Math.hypot(tp[0] - c0[0], tp[2] - c0[1]); return y > tp[1] + B.h + 0.01 ? 0 : r + (y < tp[1] ? dR * (tp[1] - y) / Ls : 0); };
  // --- robe
  var R = G.robe, arms = {};
  ['L', 'R'].forEach(function (s) { var A = J('arm' + s), u = norm(sub(J('fore' + s), A)), eb = norm(sub([0, -1, 0], mul(u, -u[1]))); arms[s] = { A: A, u: u, eb: eb, ef: [0, 0, 1], ra: R ? R.armhole / PI + R.ringOff : 0.06 }; });
  if (R) {
    var yAp = R.armpit, D = R.armhole, yT = yAp + D, yN = yT + R.slope, hw = R.hw, hwH = hw + R.flare, xn = R.neck, gp = R.open;
    var sideL = bez([hwH, R.hemY], [hw + (hwH - hw) * 0.35, mix(R.hemY, yAp, 0.5)], [hw, mix(R.hemY, yAp, 0.8)], [hw, yAp], 64), sideR = sideL.map(function (p) { return [-p[0], p[1]]; }).reverse();
    var hwY = function (y) { if (y >= yAp) return hw; for (var i = 1; i < sideL.length; i++) if (sideL[i][1] >= y) return mix(sideL[i - 1][0], sideL[i][0], (y - sideL[i - 1][1]) / max(1e-9, sideL[i][1] - sideL[i - 1][1])); return hwH; };   // the half width at y, from the side seam
    var ring = function (s, c, a, Cc) {   // sleeve tube point: c around (0 = top, + = front), a along the arm (upper arm, then forearm), Cc the circumference there;
      // its top line starts on the armhole ring and comes down to R.sleeve.top above the arm, the rest hangs below
      var Ar = arms[s], E = J('fore' + s), ue = len(sub(E, Ar.A)), uF = norm(sub(J('hand' + s), E)), aa = a + R.ringAt, u = norm(lerp3(Ar.u, uF, smooth(ue - 0.05, ue + 0.05, aa)));
      var o = aa < ue ? add(Ar.A, mul(Ar.u, aa)) : add(E, mul(uF, aa - ue)), eb = norm(sub([0, -1, 0], mul(u, -u[1]))), ef = norm(cross(eb, u)); if (ef[2] < 0) ef = mul(ef, -1);
      var armR = mix(0.048, 0.03, clamp(aa / 0.52, 0, 1)), top = add(o, mul(eb, -(armR + mix(Ar.ra - 0.048, R.sleeve.top, smooth(0, 0.07, a))))), Rr = max(Ar.ra, Cc / (2 * PI)), ctr = add(top, mul(eb, Rr));
      return add(ctr, add(mul(eb, -Rr * cos(ps0(c, Cc))), mul(ef, Rr * sin(ps0(c, Cc))))); }, ps0 = function (c, Cc) { return 2 * PI * c / Cc; };
    var bodyP = function (side) { return function (q) {
      var x = q[0], y = q[1], Hh = H(clamp(y, 0.05, yAp)), hwq = hwY(y), k = max(1, hwq / (Hh.L / 4)), p = hullAt(Hh, (side > 0 ? 0 : 0.5) + side * x / hwq * 0.25, k, gap);
      var Re = 0; for (var e = 0; e < 8; e++) Re = max(Re, envR(e / 8, y)); Re += R.layer;
      if (Re > R.layer) {   // over the skirt: round it at the arc length from the centre back (narrower than the skirt: the front opens wider)
        Re = max(Re, k * Hh.L / (2 * PI)); var sA = side < 0 ? x : (x > 0 ? 1 : -1) * (2 * hwq - abs(x)), thA = PI - sA / Re; p = lerp3(p, [c0[0] + sin(thA) * Re, y, c0[1] + cos(thA) * Re], smooth(yAp, yAp - 0.1, y)); }
      if (y > yAp) {   // over the shoulder: front and back converge on the shoulder line; toward the armhole, onto the sleeve's ring
        var tl = yT + (yN - yT) * clamp((hw - abs(x)) / (hw - xn), 0, 1), fr = clamp((y - yAp) / (tl - yAp), 0, 1);
        p = [p[0], yAp + (R.shoulderY - yAp) * sin(fr * PI / 2), c0[1] + (p[2] - c0[1]) * max(0.15, sqrt(1 - fr * fr))];
        var w = smooth(hw - 0.07, hw, abs(x)); if (w > 0) p = lerp3(p, ring(x > 0 ? 'L' : 'R', side * D * (1 - clamp((y - yAp) / D, 0, 1)), 0, 2 * D), w);
      }
      if (p[1] < 0.02) { var ex = 0.02 - p[1], dl = Math.hypot(p[0] - c0[0], p[2] - c0[1]) || 1; p = [p[0] + (p[0] - c0[0]) / dl * ex, 0.02 + 0.05 * ex, p[2] + (p[2] - c0[1]) / dl * ex]; }   // (the hem below the floor: laid out on it, to pool)
      return pushOut(p, caps, gap); }; };
    var nb = bez([xn, yN], [xn * 0.6, yN - R.neckB], [xn * 0.3, yN - R.neckB], [0, yN - R.neckB], 12), neckB = nb.concat(nb.slice(0, -1).reverse().map(function (p) { return [-p[0], p[1]]; }));
    var nSide = NN(plen(sideL)), nAh = NN(D), nShd = NN(Math.hypot(hw - xn, yN - yT));
    // side slits (R.slit: the side seams sewn only above that height): each side edge split into the open slit and the seam
    var cutAt = sideL.findIndex(function (p) { return p[1] >= (R.slit || -1); }), slitL = R.slit ? sideL.slice(0, cutAt + 1) : null, upL = R.slit ? sideL.slice(cutAt) : sideL, nSl = R.slit ? NN(plen(slitL)) : 0, nUp = NN(plen(upL));
    var mir = function (P) { return P.map(function (p) { return [-p[0], p[1]]; }).reverse(); };
    var sides = function (P, s) { if (s > 0) { if (R.slit) P.edge('slitL', slitL, nSl); return P.edge('sideL', upL, nUp); } P.edge('sideR', mir(upL), nUp); if (R.slit) P.edge('slitR', mir(slitL), nSl); return P; };
    var back = addP(new Panel('robeB', bodyP(-1), radial), 'robeB');
    sides(back.edge('hem', [[-hwH, R.hemY], [hwH, R.hemY]], NN(2 * hwH)), 1).edge('armL', [[hw, yAp], [hw, yT]], nAh).edge('shL', [[hw, yT], [xn, yN]], nShd)
      .edge('neck', neckB, NN(plen(neckB))).edge('shR', [[-xn, yN], [-hw, yT]], nShd).edge('armR', [[-hw, yT], [-hw, yAp]], nAh); sides(back, -1);
    back.pinPts = [[0, yN - R.neckB], [xn, yN], [-xn, yN]];
    var fEdge = [[xn, yN], [gp, yN - R.neckF], [gp, R.hemY]], nF = NN(plen(fEdge));
    var fL = addP(new Panel('robeFL', bodyP(1), radial), 'robeFL'), fR = addP(new Panel('robeFR', bodyP(1), radial), 'robeFR');
    sides(fL.edge('hem', [[gp, R.hemY], [hwH, R.hemY]], NN(hwH - gp)), 1).edge('armL', [[hw, yAp], [hw, yT]], nAh).edge('shL', [[hw, yT], [xn, yN]], nShd).edge('front', fEdge, nF);
    fR.edge('hem', [[-hwH, R.hemY], [-gp, R.hemY]], NN(hwH - gp)).edge('front', fEdge.map(function (p) { return [-p[0], p[1]]; }).reverse(), nF).edge('shR', [[-xn, yN], [-hw, yT]], nShd).edge('armR', [[-hw, yT], [-hw, yAp]], nAh); sides(fR, -1);
    seams.push([fL, 'sideL', back, 'sideL', false], [fL, 'shL', back, 'shL', false], [fR, 'sideR', back, 'sideR', false], [fR, 'shR', back, 'shR', false]);
    // sleeves: a along the arm from the armhole, c around (+ = front); the circumference widens from 2D at the armhole to the cuff
    var SL = R.sleeve, Cw = function (a) { var t = clamp(a / SL.len, 0, 1); return 2 * D + (SL.cuff - 2 * D) * Math.pow(sin(t * PI / 2), SL.shape); };
    ['L', 'R'].forEach(function (s) {
      var Ar = arms[s], under = function (sg) { var P = []; for (var k = 0; k <= 30; k++) { var a = SL.len * k / 30; P.push([a, sg * Cw(a) / 2]); } return P; }, nU = NN(plen(under(1)));
      var sl = addP(new Panel('sleeve' + s, function (q) { return pushOut(ring(s, q[1], q[0], Cw(q[0])), caps, gap); }, function (q) { var d = sub(q, Ar.A); return sub(d, mul(Ar.u, dot(d, Ar.u))); }), 'sleeve' + s);
      sl.edge('underB', under(-1), nU).edge('cuff', [[SL.len, -SL.cuff / 2], [SL.len, SL.cuff / 2]], NN(SL.cuff)).edge('underF', under(1).reverse(), nU).edge('seamF', [[0, D], [0, 0]], nAh).edge('seamB', [[0, 0], [0, -D]], nAh);
      seams.push([sl, 'underB', sl, 'underF', true], [sl, 'seamF', s === 'L' ? fL : fR, 'arm' + s, s !== 'L'], [sl, 'seamB', back, 'arm' + s, s === 'L']);
    });
  }
  // --- shawl (帔帛): a strip along a path (Catmull-Rom through keys) over the robe; x across, y along (needs the robe's shape)
  var Sh = G.shawl;
  if (Sh && Sh.path) {   // drawn in shawl.html (shawl.<style>.json): laid along that curve in its pose, pinned where it says
    var SP = Sh.path, Wl = layPose(sk, SP.pose), ST = shawlStrip(SP, poseColl(C, poseDQ(sk, Wl))), Lsh = ST.L;   // (oriented by the colliders here; laid again facing the dressed garments in GSim.reset)
    var shawl = addP(new Panel('shawl', function (q) { var a = ST.at(q[1]); return add(a.p, mul(a.w, q[0])); }, function (q3, q2) { return ST.at(q2[1]).n; }), 'shawl');
    var Ss = shawl.S = Sh.spacing || S, NS = function (l) { return max(2, Math.round(l / Ss)); };
    shawl.edge('end1', [[-Sh.w / 2, 0], [Sh.w / 2, 0]], NS(Sh.w)).edge('r', [[Sh.w / 2, 0], [Sh.w / 2, Lsh]], NS(Lsh)).edge('end2', [[Sh.w / 2, Lsh], [-Sh.w / 2, Lsh]], NS(Sh.w)).edge('l', [[-Sh.w / 2, Lsh], [-Sh.w / 2, 0]], NS(Lsh));
    shawl.pinSpec = (SP.pins || []).filter(function (q) { return q.i >= 0 && q.i < SP.points.length; }).map(function (q) { var a = ST.at(ST.knots[q.i]), pos = add(a.p, mul(capNormal(a.p, ST.caps).n, q.offset || 0));
      return { q: [0, ST.knots[q.i]], pos: pos, bone: shawlBone(sk, Wl, pos, q.bone), compliance: q.compliance || 0, W: Wl }; });
  } else if (Sh && R) {
    var upTop = function (s) { var S2 = s > 0 ? 'L' : 'R', u = norm(sub(J('fore' + S2), J('arm' + S2))); return norm(sub([0, 1, 0], mul(u, u[1]))); };
    var seqPin = [], kp = [], backAt = bodyP(-1);
    [-1, 1].forEach(function (s) {
      // the 帔帛's drape, laid in the bind A-pose over the robe: across the back, round the outside (back) of the upper arm, over
      // the top of the elbow (one loose pin there, on the sleeve: placed in GSim.reset once the robe has settled) to its inside
      // (front), the end dropping from there in front of the sleeve; never under the arm, nowhere near the wrists
      var S2 = s > 0 ? 'L' : 'R', aE = len(sub(J('fore' + S2), J('arm' + S2))) - R.ringAt;
      var side = function (a, c) { var C = Cw(a), q = ring(S2, c, a, C), n = norm(sub(q, ring(S2, c + C / 2, a, C))); return { p: add(q, mul(n, Sh.lift)), n: n }; };
      var inner = side(aE, Cw(aE) / 4), top = side(aE, 0);
      var seq = [{ p: add(inner.p, [-Sh.inward * s, -Sh.hang, 0.03]), n: [0, 0, 1] }, { p: add(inner.p, [-Sh.inward * s * 0.4, -0.08, 0.02]), n: [0, 0, 1] }, inner, top, side(aE - 0.05, -Cw(aE - 0.05) / 4), side(aE * 0.5, -Cw(aE * 0.5) / 4),
        { p: add(backAt([Sh.backX * s, Sh.backY]), [0, 0, -0.03]), n: [0, 0, -1] }];
      seqPin.push(top.p); kp = s < 0 ? seq : kp.concat(seq.reverse()); });
    kp.splice(7, 0, { p: add(backAt([0, Sh.backY]), [0, 0, -0.03]), n: [0, 0, -1] });
    var path = Path(kp), Lsh = path.L;
    var shawl = addP(new Panel('shawl', function (q) { var a = path.at(q[1]); return pushOut(add(a.p, mul(a.w, q[0])), caps, gap + 0.004); }, function (q3, q2) { return path.at(q2[1]).n; }), 'shawl');
    var Ss = shawl.S = Sh.spacing || S, NS = function (l) { return max(2, Math.round(l / Ss)); };   // (its own, finer spacing: silk)
    shawl.edge('end1', [[-Sh.w / 2, 0], [Sh.w / 2, 0]], NS(Sh.w)).edge('r', [[Sh.w / 2, 0], [Sh.w / 2, Lsh]], NS(Lsh)).edge('end2', [[Sh.w / 2, Lsh], [-Sh.w / 2, Lsh]], NS(Sh.w)).edge('l', [[-Sh.w / 2, Lsh], [-Sh.w / 2, 0]], NS(Lsh));
    var along = function (p) { var bt = 0, bd = 1e9; for (var t = 0; t <= Lsh; t += 0.005) { var d = len(sub(path.at(t).p, p)); if (d < bd) { bd = d; bt = t; } } return bt; };
    shawl.pinPts = [[0, along(seqPin[0]), /^(arm|fore)/, 'armR'], [0, along(seqPin[1]), /^(arm|fore)/, 'armL']];   // one on top of each elbow
    var kpP = kp.map(function (k) { return k.p; });   // (this path as a starting point for shawl.html: shawlFromCloth)
    shawl.def = { version: 1, pose: 'A', w: Sh.w, spacing: Ss, fabric: Object.assign({}, Sh.fabric), knots: kpP.map(along), pins: seqPin.map(function (p) { return { i: kpP.indexOf(p), bone: 'auto', compliance: 0, offset: 0 }; }) };
  }
  // --- ribbons (裙帶): strips hanging from the band's front; the top edge gathered into one band point (bF sample k)
  // --- belt (Song): a straight strip round the waist over the band / skirt seam, outside both, pinned on its top edge like the
  // band; the ribbons hang from its lower edge and the bow sits on it
  var Bt = G.belt, hold = band, bq = nq, yH = 0;
  if (Bt) {
    var Lt = Lb + 2 * PI * Bt.off, nbq = max(2, Math.round(Lt / 4 / Bt.spacing)), nbh = max(2, Math.round((Bt.up + Bt.down) / Bt.spacing));
    var belt = addP(new Panel('belt', function (q) { var p = bandAt(q[0] / Lt, q[1] - Bt.down, gap + Bt.off); return pushOut(p, caps, gap + Bt.off); }, radial), 'belt'); belt.S = Bt.spacing;
    belt.edge('b1', [[0, 0], [Lt / 4, 0]], nbq).edge('bF', [[Lt / 4, 0], [3 * Lt / 4, 0]], 2 * nbq).edge('b2', [[3 * Lt / 4, 0], [Lt, 0]], nbq)
      .edge('end2', [[Lt, 0], [Lt, Bt.up + Bt.down]], nbh).edge('top', [[Lt, Bt.up + Bt.down], [0, Bt.up + Bt.down]], 4 * nbq).edge('end1', [[0, Bt.up + Bt.down], [0, 0]], nbh);
    seams.push([belt, 'end1', belt, 'end2', true]); belt.pinPts = (Bt.pins || []).map(function (f) { return [f * Lt, Bt.up + Bt.down]; });
    hold = belt; bq = nbq; yH = -Bt.down;
  }
  var Sa = G.sash, ribbons = [];
  if (Sa) [1, -1].forEach(function (s) {
    var Lh = Bt ? Lt : Lb, k = bq + s * max(1, Math.round(Sa.apart / (Lh / 2) * 2 * bq)), f = (Lh / 4 + k * Lh / 2 / (2 * bq)) / Lh, tp = bandAt(f, yH, gap + (Bt ? Bt.off : 0)), tn = norm(radial(tp)), ta = norm(cross([0, 1, 0], tn));
    var rb = addP(new Panel('sash' + (s > 0 ? 'L' : 'R'), function (q) { var y = -q[1], dr = dR * y / Ls + (0.012 + 0.006 * s) * smooth(0, 0.08, y); return pushOut(add(add(tp, mul(tn, dr)), [ta[0] * q[0], -y, ta[2] * q[0]]), caps, gap); }, function () { return tn; }), 'sash' + (s > 0 ? 'L' : 'R'));
    rb.S = Sa.spacing; var nw = max(2, Math.round(Sa.w / Sa.spacing)), nl = max(2, Math.round(Sa.len / Sa.spacing));
    rb.edge('top', [[Sa.w / 2, 0], [-Sa.w / 2, 0]], nw).edge('l', [[-Sa.w / 2, 0], [-Sa.w / 2, -Sa.len]], nl).edge('end', [[-Sa.w / 2, -Sa.len], [Sa.w / 2, -Sa.len]], nw).edge('r', [[Sa.w / 2, -Sa.len], [Sa.w / 2, 0]], nl);
    ribbons.push({ p: rb, k: k, top: tp[1], s: s });
  });
  var JD = G.jade && ribbons.length === 2 ? { d: ribbons[0].top - G.jade.y } : null;
  var nearest = function (p, q) { var bi = 0, bd = 1e9; p.pts.forEach(function (pt, i) { var d = sq(pt[0] - q[0]) + sq(pt[1] - q[1]); if (d < bd) { bd = d; bi = i; } }); return bi; };
  var m = sew(panels, seams, function () { var w = []; ribbons.forEach(function (r) { r.p.E.top.forEach(function (i) { w.push([r.p, i, hold, hold.E.bF[r.k]]); }); });
    panels.forEach(function (p) { (p.welds || []).forEach(function (q) { w.push([p, nearest(p, q[0]), q[1], nearest(q[1], q[2])]); }); });
    if (JD) { JD.i = ribbons.map(function (r) { return nearest(r.p, [-r.s * Sa.w / 2, -JD.d]); }); w.push([ribbons[0].p, JD.i[0], ribbons[1].p, JD.i[1]]); }   // (玉環綬: the ribbons' inner edges threaded together through the ring)
    return w; }, S, log);
  m.knot = ribbons.map(function (r) { return hold.vmap[hold.E.bF[r.k]]; });
  if (JD) { var at = function (r, x, dy) { return r.p.vmap[nearest(r.p, [x * r.s, -JD.d + dy])]; }, A0 = ribbons[0], A1 = ribbons[1], hw2 = Sa.w / 2;
    m.jade = { c: A0.p.vmap[JD.i[0]], up: at(A0, -hw2, 0.03), dn: at(A0, -hw2, -0.03), L: at(A0, hw2, 0), R: at(A1, hw2, 0), R0: G.jade.R, r: G.jade.r, w: G.jade.w || 2 * G.jade.r }; }
  layerOut(m, panels, (Bt ? [['belt', ['band', 'skirt']]] : []).concat([['robe', ['skirt', 'band', 'belt']], ['sleeve', ['skirt', 'band', 'belt']], ['sash', ['skirt']]]).concat(Sh && Sh.path ? [] : [['shawl', ['robe', 'sleeve', 'skirt', 'band'], 0.035]]), G.layerGap || 0.024);   // (a drawn shawl: laid as drawn, layered when it is dressed)
  return { m: m, panels: panels };
}
// layering at placement: particles of an outer piece closer than gap to (or inside) an inner piece's surface are moved out
// along its outward normal (pieces named by prefix; particles shared by both are left alone), outer pieces in order
function layerOut(m, panels, order, gap) {
  var X = m.positions, n = m.n, owner = new Int32Array(n).fill(-1);
  panels.forEach(function (p, k) { p.vmap.forEach(function (g) { owner[g] = owner[g] === -1 || owner[g] === k ? k : -2; }); });
  var of = function (pre) { return panels.filter(function (p) { return p.piece.indexOf(pre) === 0; }); };
  order.forEach(function (o) {
    var gp = o[2] || gap, T = [], cell = 0.06, grid = new Map(), key = function (x, y, z) { return floor(x / cell) + ',' + floor(y / cell) + ',' + floor(z / cell); };
    o[1].forEach(function (pre) { of(pre).forEach(function (p) { for (var i = 0; i < p.rtris.length; i += 3) { var a = p.vmap[p.rtris[i]], b = p.vmap[p.rtris[i + 1]], c = p.vmap[p.rtris[i + 2]]; if (a === b || b === c || a === c) continue;
      var t = T.length; T.push([a, b, c]); var k = key((X[a * 3] + X[b * 3] + X[c * 3]) / 3, (X[a * 3 + 1] + X[b * 3 + 1] + X[c * 3 + 1]) / 3, (X[a * 3 + 2] + X[b * 3 + 2] + X[c * 3 + 2]) / 3); (grid.get(k) || grid.set(k, []).get(k)).push(t); } }); });
    of(o[0]).forEach(function (p) { p.vmap.forEach(function (g) { if (owner[g] < 0) return;
      for (var pass = 0; pass < 3; pass++) {
        var q = [X[g * 3], X[g * 3 + 1], X[g * 3 + 2]], best = null, bd = 1e9, cx = floor(q[0] / cell), cy = floor(q[1] / cell), cz = floor(q[2] / cell);
        for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) (grid.get((cx + dx) + ',' + (cy + dy) + ',' + (cz + dz)) || []).forEach(function (t) {
          var A = T[t], P0 = [X[A[0] * 3], X[A[0] * 3 + 1], X[A[0] * 3 + 2]], P1 = [X[A[1] * 3], X[A[1] * 3 + 1], X[A[1] * 3 + 2]], P2 = [X[A[2] * 3], X[A[2] * 3 + 1], X[A[2] * 3 + 2]], c = triClosest(q, P0, P1, P2), d = len(sub(q, c));
          if (d < bd) { bd = d; best = { c: c, n: norm(cross(sub(P1, P0), sub(P2, P0))) }; } });
        if (!best) break; var sd = dot(sub(q, best.c), best.n); if (sd >= gp || bd > 0.3) break;
        var mv = mul(best.n, gp - sd); X[g * 3] += mv[0]; X[g * 3 + 1] += mv[1]; X[g * 3 + 2] += mv[2];
      } }); });
  });
}
function triClosest(p, a, b, c) {   // closest point on triangle abc to p (Ericson)
  var ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap); if (d1 <= 0 && d2 <= 0) return a;
  var bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp); if (d3 >= 0 && d4 <= d3) return b;
  var vc = d1 * d4 - d3 * d2; if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, mul(ab, d1 / (d1 - d3)));
  var cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp); if (d6 >= 0 && d5 <= d6) return c;
  var vb = d5 * d2 - d1 * d6; if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, mul(ac, d2 / (d2 - d6)));
  var va = d3 * d6 - d5 * d4; if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, mul(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
  var den = 1 / (va + vb + vc); return add(a, add(mul(ab, vb * den), mul(ac, vc * den)));
}
// the cloth of a costume: the sewn mesh with per-vertex fabric (mass, bending, friction), pins skinned to the body under
// them, the colliders, the solver settings, and per piece the panels to render (pattern uv)
function buildCloth(sk, body, C, G, log, coll) {
  var t0 = Date.now(); coll = coll || fitColliders(sk, body, log, G);
  if (G.grow) coll = Object.assign({}, coll, { tmp: null, caps: coll.caps.map(function (c) { var g = 0; for (var k in G.grow) if (new RegExp(k).test(c.name)) g = max(g, G.grow[k]); return g ? Object.assign({}, c, { r: c.r + g }) : c; }) });   // (per costume: some capsules a little larger, e.g. Song's under the opaque 褙子)
  var sw = sewTang(sk, body, coll, G, log), m = sw.m, n = m.n, A = new Anchors(body), pins = [], F = body.sdf;
  var mass = new Float32Array(n).fill(1), bend = new Float32Array(n).fill(1), fric = new Float32Array(n).fill(G.solver.friction), SV = G.solver;
  var fabricOf = function (piece) { return (G[piece.replace(/^(robe[A-Z]+|sleeve[LR])$/, 'robe').replace(/^skirt.*/, 'skirt').replace(/^sash[LR]$/, 'sash')] || {}).fabric || {}; };
  sw.panels.forEach(function (p) {
    var fb = fabricOf(p.piece); for (var i = 0; i < p.vmap.length; i++) { var g = p.vmap[i]; if (fb.mass) mass[g] = fb.mass / SV.density; if (fb.bend) bend[g] = fb.bend / SV.bendCompliance; if (fb.friction != null) fric[g] = fb.friction; }
    (p.pinPts || []).forEach(function (q) { var bi = 0, bd = 1e9; p.pts.forEach(function (pt, i) { var d = sq(pt[0] - q[0]) + sq(pt[1] - q[1]); if (d < bd) { bd = d; bi = i; } });
      var g = p.vmap[bi]; if (pins.some(function (x) { return x.i === g; })) return; if (q[4]) m.positions.set(q[4], g * 3);   // (an exact anchor point, e.g. on the elbow)
      var x = [m.positions[g * 3], m.positions[g * 3 + 1], m.positions[g * 3 + 2]];
      var a = A.add(x, projectTo(F, x.slice())), keep = q[2] || /^(root|spine|spine2|chest|neck)$/, ws = [0, 1, 2, 3].map(function (k) { return keep.test(sk.bones[A.bi[a * 4 + k]].name) ? A.bw[a * 4 + k] : 0; }), sw = ws[0] + ws[1] + ws[2] + ws[3];
      if (sw > 0) ws.forEach(function (w, k) { A.bw[a * 4 + k] = w / sw; }); else { A.bi.splice(a * 4, 4, sk.by[q[3] || 'chest'], 0, 0, 0); A.bw.splice(a * 4, 4, 1, 0, 0, 0); }   // (torso pins ride on the torso bones only: the arms never drag them)
      pins.push({ i: g, a: a, piece: p.piece }); });
    (p.pinSpec || []).forEach(function (q) { var bi = 0, bd = 1e9; p.pts.forEach(function (pt, i) { var d = sq(pt[0] - q.q[0]) + sq(pt[1] - q.q[1]); if (d < bd) { bd = d; bi = i; } });   // (a drawn shawl's pins: rigid on one bone, or soft)
      var g = p.vmap[bi]; if (pins.some(function (x) { return x.i === g; })) return; m.positions.set(q.pos, g * 3);
      var b = q.bone, bp = add(sk.bones[b].p, qrot(qconj(q.W.q[b]), sub(q.pos, q.W.p[b])));   // (its bind-pose place on that bone)
      pins.push({ i: g, a: A.addBone(bp, b), piece: p.piece, compliance: q.compliance }); });
  });
  A.finish();
  var params = Object.assign({}, SV, { ground: 0 });
  var mesh = { positions: m.positions, indices: m.indices, uvTri: m.uvTri, pins: pins.map(function (p) { return p.compliance ? { i: p.i, compliance: p.compliance } : { i: p.i }; }), massScale: mass, bendScale: bend, friction: fric };
  var edgeD = function (p) { var E = p.E.front || p.E.neck; if (!E) return null; var L = E.map(function (i) { return p.pts[i]; });   // (the 褙子's 領抹: pattern distance from the front edge and back neck)
    return p.pts.map(function (q) { var b = 1e9; for (var k = 1; k < L.length; k++) { var a = L[k - 1], c = L[k], dx = c[0] - a[0], dy = c[1] - a[1], l2 = dx * dx + dy * dy, t = l2 > 0 ? clamp(((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2, 0, 1) : 0; b = min(b, Math.hypot(a[0] + dx * t - q[0], a[1] + dy * t - q[1])); } return b; }); };
  var pieces = {}; sw.panels.forEach(function (p) { var o = { name: p.name, vmap: p.vmap, uv: p.pts, tris: p.rtris, band: p.piece === 'band' }; if (G.robe && G.robe.trim && /^robe/.test(p.piece)) o.edge = edgeD(p); (pieces[p.piece] = pieces[p.piece] || []).push(o); });
  if (log) log('cloth: ' + n + ' particles, ' + m.indices.length / 3 + ' triangles, ' + pins.length + ' pins, pieces ' + Object.keys(pieces).join(' ') + ' (' + (Date.now() - t0) + ' ms)');
  var shawlV = sw.panels.filter(function (p) { return p.piece === 'shawl'; }).reduce(function (a, p) { return a.concat(Array.from(p.vmap)); }, []);
  var shP = sw.panels.find(function (p) { return p.piece === 'shawl'; });
  return { mesh: mesh, params: params, coll: coll, anchors: A, pins: pins, pieces: pieces, knot: m.knot, jade: m.jade, n: n, shawlV: Array.from(new Set(shawlV)), shawlSpec: G.shawl && G.shawl.path, shawlDefault: shP && shP.def };
}
// The garment simulation: one Cloth for every garment (layers collide through its self-collision), capsules from the
// pose, pins on skinned anchors. reset(): settle at bind, ease bind → rest → the pose at t (1.4 s), then follow the
// performance. Deterministic (stage shots, video, checker); the live stage runs the same state on in a ClothAsync.
var GDT = 1 / 60;
function GSim(fig) { var G = fig.garb; this.fig = fig; this.G = G; this.DQ = new Float32Array(fig.sk.bones.length * 8); this.caps = new Float32Array((G.coll.caps.length + 1) * 7); this.t = null; }
GSim.prototype.pose = function (W, t) {   // colliders (+ a far-away zero-radius capsule carrying the time, for ClothAsync's renderColliders) and pin targets
  poseDQ(this.fig.sk, W, this.DQ); poseColl(this.G.coll, this.DQ, this.caps); var o = this.caps.length - 7; this.caps.set([t, -100, 0, t, -100, 0, 0], o);
  var a = this.G.anchors.update(this.DQ), P = this.pinT || (this.pinT = new Float32Array(this.G.pins.length * 3));
  this.G.pins.forEach(function (p, k) { P[k * 3] = a[p.a * 3]; P[k * 3 + 1] = a[p.a * 3 + 1]; P[k * 3 + 2] = a[p.a * 3 + 2]; });
};
GSim.prototype.reset = function (poseAt, t, bindOnly) {   // (bindOnly: stop after settling in the bind A-pose, for inspection)
  var sk = this.fig.sk, c = this.cloth = new CL.Cloth(this.G.mesh, this.G.params), Wb = bindW(sk), rc = defaultControls(); rc.lipPress = 0.6;
  var Wr = solve(sk, rc), Wt = poseAt(t, 1), self = this, d0 = c.params.damping, k;
  // dressing at bind, in order: the skirt, band, ribbons and robe settle first (relax the seams without gravity, slowly, so
  // nothing crosses another layer, then hang) while the shawl waits parked above (kinematic); then the shawl is laid on the
  // settled robe (outside it by the self-collision gap), its elbow anchors on the sleeves over the elbows, and settles on top
  var G = this.G, g0 = c.params.gravity, v0 = c.params.maxSpeed, shV = G.shawlV || [], w0 = new Float32Array(c.invMass), PARK = 3, parked = shV.length > 0;
  var park = function () { P = self.pinT; if (parked) G.pins.forEach(function (p, q) { if (p.piece === 'shawl') P[q * 3 + 1] += PARK; }); }, P;
  shV.forEach(function (i) { c.invMass[i] = 0; c.x[i * 3 + 1] += PARK; c.prev[i * 3 + 1] += PARK; });
  this.pose(Wb, t); park(); c.resetColliders(this.caps); c.resetPinTargets(P);
  c.params.damping = 20; c.params.gravity = 0; c.params.maxSpeed = 0.3; for (k = 0; k < 40; k++) c.step(GDT);
  c.params.gravity = g0; c.params.damping = 6; c.params.maxSpeed = 1.5;
  var hang = function (n, W) { for (k = 1; k <= n; k++) { self.pose(W || Wb, t); park(); c.setColliders(self.caps); c.setPinTargets(P); c.step(GDT); } };
  hang(70);
  var SP = G.shawlSpec, Wl = SP && SP.pose === 'rest' ? Wr : Wb;   // (a drawn shawl is laid in its own pose: rest = the others ease into it first)
  if (Wl !== Wb) { for (k = 1; k <= 90; k++) { this.pose(blendW(Wb, Wr, smooth(0, 1, k / 90)), t); park(); c.setColliders(this.caps); c.setPinTargets(P); c.step(GDT); } hang(15, Wr); }
  this.dressed = new Float32Array(c.positions);   // (the others dressed, the shawl parked: shawl.html shows this while the path is edited)
  if (bindOnly === 'dressed') { this.t = t; this.W = Wl; return; }
  if (shV.length) {
    var X = new Float32Array(c.x), X0 = G.mesh.positions, gap2 = 2 * c.params.selfRadius + 0.004, sk2 = this.fig.sk, panels = [];
    for (var nm in G.pieces) G.pieces[nm].forEach(function (pn) { panels.push({ piece: nm, vmap: pn.vmap, rtris: pn.tris }); });
    shV.forEach(function (i) { X[i * 3] = X0[i * 3]; X[i * 3 + 1] = X0[i * 3 + 1]; X[i * 3 + 2] = X0[i * 3 + 2]; });
    if (SP) {   // drawn: out of the colliders posed in its pose, the pinned particles on their targets
      this.pose(Wl, t); var cs = [], CP = this.caps, PT = this.pinT; for (var q7 = 0; q7 < CP.length; q7 += 7) if (CP[q7 + 6] > 0) cs.push({ a: [CP[q7], CP[q7 + 1], CP[q7 + 2]], b: [CP[q7 + 3], CP[q7 + 4], CP[q7 + 5]], r: CP[q7 + 6] });
      var shM = new Uint8Array(G.n); shV.forEach(function (i) { shM[i] = 1; }); var ST = shawlStrip(SP, CP, { P: c.positions, N: vertexNormals(c.positions, c.indices), skip: function (i) { return shM[i]; } });
      G.pieces.shawl.forEach(function (pn) { pn.uv.forEach(function (q, k) { var a = ST.at(q[1]); X.set(add(a.p, mul(a.w, q[0])), pn.vmap[k] * 3); }); });   // (along the curve, facing the dressed garments)
      shV.forEach(function (i) { X.set(pushOut([X[i * 3], X[i * 3 + 1], X[i * 3 + 2]], cs, c.params.thickness + 0.007), i * 3); });
      G.pins.forEach(function (p, q) { if (p.piece === 'shawl') X.set([PT[q * 3], PT[q * 3 + 1], PT[q * 3 + 2]], p.i * 3); });
    } else G.pins.forEach(function (p) {   // the elbow anchors: on the settled sleeve over the top of the elbow
      if (p.piece !== 'shawl') return; var A3 = G.anchors.mesh.pos, S2 = A3[p.a * 3] > 0 ? 'L' : 'R', E = sk2.bones[sk2.by['fore' + S2]].p, u = norm(sub(E, sk2.bones[sk2.by['arm' + S2]].p)), up = norm(sub([0, 1, 0], mul(u, u[1])));
      var want = add(E, mul(up, 0.06)), best = -1, bd = 1e9; (G.pieces['sleeve' + S2] || []).forEach(function (pn) { pn.vmap.forEach(function (v) { var d = sq(X[v * 3] - want[0]) + sq(X[v * 3 + 1] - want[1]) + sq(X[v * 3 + 2] - want[2]); if (d < bd) { bd = d; best = v; } }); });
      if (best < 0) return; var q = add([X[best * 3], X[best * 3 + 1], X[best * 3 + 2]], mul(up, gap2)); A3.set(q, p.a * 3); X.set(q, p.i * 3); });
    layerOut({ positions: X, n: G.n }, panels, [['shawl', ['robe', 'sleeve', 'skirt', 'band'], gap2]], gap2);
    shV.forEach(function (i) { for (var k3 = 0; k3 < 3; k3++) { c.x[i * 3 + k3] = c.prev[i * 3 + k3] = X[i * 3 + k3]; c.vel[i * 3 + k3] = 0; } c.invMass[i] = w0[i]; });
    G.pins.forEach(function (p) { if (!p.compliance) c.invMass[p.i] = 0; });
    parked = false; this.pose(Wl, t); c.resetPinTargets(this.pinT); c.positions.set(c.x); if (bindOnly === 'laid') { this.t = t; this.W = Wl; return; }
    c.params.damping = 20; c.params.gravity = 0; c.params.maxSpeed = 0.3; for (k = 0; k < 20; k++) c.step(GDT);
    c.params.gravity = g0; c.params.damping = 6; c.params.maxSpeed = 1.5; hang(60, Wl);
  }
  c.params.damping = d0; c.params.maxSpeed = v0;
  if (bindOnly) { this.t = t; this.W = Wl; return; }
  var go = function (W) { self.pose(W, t); c.setColliders(self.caps); c.setPinTargets(self.pinT); c.step(GDT); };
  if (Wl === Wb) for (k = 1; k <= 90; k++) go(blendW(Wb, Wr, smooth(0, 1, k / 90)));   // (slowly: the wide sleeves swing in past the skirt)
  for (k = 1; k <= 45; k++) go(blendW(Wr, Wt, smooth(0, 1, k / 45)));
  for (k = 0; k < 15; k++) go(Wt);
  this.t = t; this.W = Wt;
};
// step to time t (fixed 1/60 s steps); a jump back or far ahead re-warms from 2 s before t
GSim.prototype.advance = function (poseAt, t) {
  if (this.t === null || t < this.t - 1e-6 || t - this.t > 4) this.reset(poseAt, max(0, t - 2));
  var dt = this.dt || GDT;   // (dt: the checker also runs it at 30 Hz, as a busy worker would)
  while (this.t + dt <= t + 1e-6) { this.t += dt; var W = poseAt(this.t, 1); this.pose(W, this.t); this.cloth.setColliders(this.caps); this.cloth.setPinTargets(this.pinT); this.cloth.step(dt); this.W = W; }
};

// the ribbons' knot (裙帶 tied on the band): a wrapped knot with two short loops, built in its own frame (x along the band,
// y up, z out) and carried by the band's cloth at the ribbons' band points (knotFrame: from the cloth positions and normals)
function knotMesh(KS) {
  var KM = new Mesh(); KS = KS || 1;
  KM.grid(16, 10, function (u, v) { var a = u * 2 * PI, b = (v - 0.5) * PI, r = 0.0088 * KS; return { p: [cos(a) * cos(b) * r * 1.15, sin(b) * r * 0.95, sin(a) * cos(b) * r * 0.7], n: norm([cos(a) * cos(b) / 1.15, sin(b) / 0.95, sin(a) * cos(b) / 0.7]), uv: [u, v, 0, 0] }; }, true);
  [-1, 1].forEach(function (s) { var pts = [], rad = []; for (var q = 0; q <= 18; q++) { var a = q / 18 * 2 * PI; pts.push(mul([s * (0.006 + 0.019 * sin(a * 0.5)), 0.009 * sin(a) + 0.005 * sin(a * 0.5), 0.003 * cos(a)], KS)); rad.push(0.0032 * (KS > 1 ? 1 + (KS - 1) * 0.6 : 1)); } tube(KM, pts, rad, 6); });
  return outwardWinding(KM.out(0, 'sashKnot'));
}
function jadeFrame(P, J) {   // 玉環綬: the ring lies on the threaded ribbons, facing out (state as the old Sim's G.jade.state)
  var g = function (i) { return [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]; }, c = g(J.c), t = norm(sub(g(J.up), g(J.dn))), a = sub(g(J.R), g(J.L)); a = norm(sub(a, mul(t, dot(a, t))));
  var n = cross(a, t); if (dot(n, [c[0], 0, c[2] + 0.01]) < 0) { n = mul(n, -1); a = mul(a, -1); } return { c: add(c, mul(n, J.r + 0.0016)), n: n, t: t, a: a, rib: c };
}
function knotFrame(P, N, k) {
  var a = k[0] * 3, b = k[1] * 3, o = [(P[a] + P[b]) / 2, (P[a + 1] + P[b + 1]) / 2, (P[a + 2] + P[b + 2]) / 2], t = norm([P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]]);
  var n = norm([N[a] + N[b], N[a + 1] + N[b + 1], N[a + 2] + N[b + 2]]); n = norm(sub(n, mul(t, dot(n, t)))); var u = cross(n, t); if (u[1] < 0) { u = mul(u, -1); t = mul(t, -1); }
  return { o: add(o, mul(n, 0.006)), x: t, y: u, z: n };
}
/* ================= small rigid parts ================= */
// lat-long sphere around +z with a cornea bulge; uv = eye-local position (for iris/sclera shading)
function eyeMesh(sk, S) {
  var s = S === 'L' ? 1 : -1, C = sk.hl(EYE_C[0] * s, EYE_C[1], EYE_C[2]), NU = 48, NV = 40, pos = [], nrm = [], uv = [], idx = [];
  var cc = 0.0052, cr = 0.0078;   // cornea sphere center (along z) and radius
  for (var j = 0; j <= NV; j++) for (var i = 0; i < NU; i++) {
    var th = PI * Math.pow(j / NV, 1.15), ph = 2 * PI * i / NU, d = [sin(th) * cos(ph), sin(th) * sin(ph), cos(th)];
    // radius along d: max of eyeball and cornea sphere (smoothly)
    var b = dot(d, [0, 0, cc]), disc = b * b - (cc * cc - cr * cr), rc = disc > 0 ? b + sqrt(disc) : 0, r = EYE_R, k = 0.0006, h = max(k - abs(rc - r), 0) / k;
    r = max(rc, r) + h * h * k * 0.25;
    var p = mul(d, r);
    // normal: numeric from neighbors later
    pos.push(C[0] + p[0], C[1] + p[1], C[2] + p[2]); uv.push(p[0], p[1], p[2], 0);
  }
  for (j = 0; j < NV; j++) for (i = 0; i < NU; i++) { var a = j * NU + i, b2 = j * NU + (i + 1) % NU, c = a + NU, d2 = b2 + NU; idx.push(a, c, b2, b2, c, d2); }
  var m = { pos: new Float32Array(pos), idx: new Uint32Array(idx), uv: new Float32Array(uv) };
  m.nrm = vertexNormals(m.pos, m.idx);
  m.bone = sk.by['eye' + S];
  return m;
}
function vertexNormals(P, I) {
  var N = new Float32Array(P.length);
  for (var t = 0; t < I.length; t += 3) {
    var a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3, ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (var k = 0; k < 3; k++) { var o = I[t + k] * 3; N[o] += nx; N[o + 1] += ny; N[o + 2] += nz; }
  }
  for (var i = 0; i < N.length; i += 3) { var l = sqrt(N[i] * N[i] + N[i + 1] * N[i + 1] + N[i + 2] * N[i + 2]) || 1; N[i] /= l; N[i + 1] /= l; N[i + 2] /= l; }
  return N;
}

/* ================= ornaments =================
   Small meshes built in bind space and carried rigidly by one bone (or skinned like the lid margin). */
function Mesh() { this.pos = []; this.nrm = []; this.uv = []; this.idx = []; }
Mesh.prototype.v = function (p, n, uv) { this.pos.push(p[0], p[1], p[2]); this.nrm.push(n[0], n[1], n[2]); this.uv.push(uv ? uv[0] : 0, uv ? uv[1] : 0, uv ? uv[2] || 0 : 0, uv ? uv[3] || 0 : 0); return this.pos.length / 3 - 1; };
Mesh.prototype.grid = function (nu, nv, f, wrapU, flip) {   // f(u, v) → {p, n, uv}
  var base = this.pos.length / 3, cols = wrapU ? nu : nu + 1;
  for (var j = 0; j <= nv; j++) for (var i = 0; i < cols; i++) { var r = f(i / nu, j / nv); this.v(r.p, r.n || [0, 1, 0], r.uv || [i / nu, j / nv]); }
  for (j = 0; j < nv; j++) for (i = 0; i < nu; i++) { var a = base + j * cols + i, b = base + j * cols + (wrapU ? (i + 1) % nu : i + 1), c = a + cols, d = b + cols; if (flip) this.idx.push(a, b, c, b, d, c); else this.idx.push(a, c, b, b, c, d); }
  return this;
};
Mesh.prototype.out = function (bone, mat, smoothN) {
  var m = { pos: new Float32Array(this.pos), nrm: new Float32Array(this.nrm), uv: new Float32Array(this.uv), idx: new Uint32Array(this.idx), bone: bone, mat: mat };
  if (smoothN) m.nrm = vertexNormals(m.pos, m.idx);
  return m;
};
function frame(n) { n = norm(n); var t = norm(cross(n, abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])); return { n: n, t: t, b: cross(n, t) }; }
// tube along a polyline with radii; closed caps
function tube(M, pts, rad, seg) {
  seg = seg || 10; var n = pts.length;
  M.grid(seg, n - 1, function (u, v) {
    var k = Math.round(v * (n - 1)), tg = norm(sub(pts[min(k + 1, n - 1)], pts[max(k - 1, 0)])), F = frame(tg), a = u * 2 * PI, d = add(mul(F.t, cos(a)), mul(F.b, sin(a)));
    return { p: add(pts[k], mul(d, rad[k])), n: d, uv: [u, v, 0, 0] };
  }, true);
  [0, n - 1].forEach(function (k, e) { var tg = norm(sub(pts[min(k + 1, n - 1)], pts[max(k - 1, 0)])); sphere(M, pts[k], rad[k] * 0.999, 6); });
  return M;
}
function sphere(M, c, r, seg, sq2) { seg = seg || 10; return M.grid(seg * 2, seg, function (u, v) { var th = v * PI, ph = u * 2 * PI, d = [sin(th) * cos(ph), cos(th), sin(th) * sin(ph)]; return { p: add(c, [d[0] * r, d[1] * r * (sq2 || 1), d[2] * r]), n: d, uv: [u, v, 0, 0] }; }, true); }
function torus(M, c, F, R, r, seg) {   // F: frame (n = axis)
  return M.grid(seg || 48, 10, function (u, v) {
    var a = u * 2 * PI, b = v * 2 * PI, rd = add(mul(F.t, cos(a)), mul(F.b, sin(a))), d = add(mul(rd, cos(b)), mul(F.n, sin(b)));
    return { p: add(c, add(mul(rd, R), mul(d, r))), n: d, uv: [u, v, 0, 0] };
  }, true);
}
function projectTo(F, p, off) { for (var i = 0; i < 30; i++) { var d = F(p[0], p[1], p[2], 1) - (off || 0); if (abs(d) < 1e-6) break; p = sub(p, mul(sdfGrad(F, p), d)); } return p; }

/* Song head (宋), costume.song.headdress (each attested in Song painting; all with a white horn comb 冠梳 at the front of
   the bun and gold earrings with pearl drops):
   "baijiao" — a white horn crown (白角冠) as in 錢選《招涼仕女圖》: a thin, translucent shell, an ellipse seen from the front and a
               U seen from the side, standing on the head and curving round the bun, tilted back a little;
   "zhucui"  — no crown: a spray of white-jade leaves studded with pearls (珠翠) across the front of the bun, small sprays at the
               sides, pearl-headed pins, as in 李嵩《聽阮圖》;
   "gele"    — no crown: three grey-green leaf ornaments set into the tall bun and a band of red beads round its base, as in 《歌樂圖》. */
function songHead(sk, body, hair, part, hl) {
  var O = sk.O, by = sk.by, HF = hair.sdf, BF = body.headSdf || body.sdf, R = rng(57), SC = COSTUME.song || {}, HD = SC.headdress || 'baijiao';
  var HS = HAIR[hairKey(SC)] || HAIR.song, bun = bunList(HS, O), bc = HS.center ? hl(HS.center[0], HS.center[1], HS.center[2]) : hl(bun[0][0], (bun[0][1] + bun[bun.length - 1][1]) / 2, (bun[0][2] + bun[bun.length - 1][2]) / 2);   // (hair.center: where the ornaments are set)
  function outN(p) { return sdfGrad(HF, p); }
  function leaf(M, base, d, n, L, W, cup, shape) {   // a thin leaf/petal plate from base along d, normal n; shape(v) = half-width profile
    var sd = norm(cross(n, d)); return M.grid(8, 10, function (u, v) { var x = (u - 0.5) * 2, w = W * shape(v), c = cup * (x * x) * v + cup * 0.4 * v * v;
      return { p: add(base, add(mul(d, v * L), add(mul(sd, x * w), mul(n, c)))), uv: [u, v, 0, 0] }; }); }
  function edgePts(base, d, n, L, W, cup, shape, v) { var sd = norm(cross(n, d)), w = W * shape(v), c = cup + cup * 0.4 * v * v; return [-1, 1].map(function (x) { return add(base, add(mul(d, v * L), add(mul(sd, x * w), mul(n, cup * v + cup * 0.4 * v * v)))); }); }
  // --- 冠梳: a white horn comb standing in front of the bun, clear of the hair strands, its teeth in the hair ---
  var useSvg = ORN.length > 0;   // (the figure's SVG ornaments replace the procedural comb and 珠翠 spray)
  if (!useSvg) {
  var CO = SC.comb || {}, cc = projectTo(HF, hl(0, CO.y != null ? CO.y : 0.104, 0.1)), cn = outN(cc), up2 = norm(sub([0, 1, 0], mul(cn, dot([0, 1, 0], cn)))), sd2 = norm(cross(cn, up2)), CS = CO.size || 1.25, CM = new Mesh(), co = add(cc, mul(cn, 0.0045));
  [1, -1].forEach(function (s2) { CM.grid(32, 2, function (u, v) { var a = PI * (0.08 + 0.84 * u), r = (0.024 + 0.014 * v) * CS, p = add(co, add(mul(sd2, -cos(a) * r), add(mul(up2, sin(a) * r * 0.62 - 0.004), mul(cn, s2 * 0.0008))));
    var dh = HF(p[0], p[1], p[2], 1); if (dh < 0.0045) p = add(p, mul(sdfGrad(HF, p), 0.0045 - dh)); return { p: p, n: mul(cn, s2), uv: [u, v, 0, 0] }; }, false, s2 < 0); });
  for (var k = 0; k < 15; k++) { var a8 = PI * (0.1 + 0.8 * k / 14), tb = add(co, add(mul(sd2, -cos(a8) * 0.024 * CS), mul(up2, sin(a8) * 0.024 * CS * 0.62 - 0.004))), dt = HF(tb[0], tb[1], tb[2], 1); if (dt < 0.0045) tb = add(tb, mul(sdfGrad(HF, tb), 0.0045 - dt)); var tin = projectTo(HF, tb, -0.006); tube(CM, [tin, tb], [0.0011, 0.0013], 5); }
  part('crownComb', 'hairCap', CM.out(by.head, 'ivory', true));
  }
  var jw = [];
  if (HD === 'baijiao') {
    // a U-shaped shell round the bun: arms in front of and behind it, the bottom resting on the head; across it, an elliptic outline
    var BJ = SC.baijiao || {}, TL = BJ.tilt != null ? BJ.tilt : 0.12, Ru = BJ.depth || 0.052, yB = -0.02, yF = BJ.top || 0.1, yK = yF - 0.025, Wd = BJ.width || 0.066, yc = 0.03, Eh = 0.1;
    var AXc = [0, cos(TL), -sin(TL)], ZTc = [0, sin(TL), cos(TL)], Ry = BJ.bottom || 0.028, LF = yF - yB, LK = yK - yB, LA = PI * (Ru + Ry) / 2, Ltot = LF + LA + LK;
    var path = function (s) { var l = s * Ltot; if (l < LF) return [yF - l, Ru]; l -= LF; if (l < LA) { var a = l / LA * PI; return [yB - Ry * sin(a), Ru * cos(a)]; } l -= LA; return [yB + l, -Ru]; };   // [y, z] local
    var hw = function (y) { return Wd * sqrt(max(0.3, 1 - sq((y - yc) / Eh))); };
    var shellP = function (u, s) { var yz = path(s), x = (u - 0.5) * 2 * hw(yz[0]), p = add(add(bc, [x, 0, 0]), add(mul(AXc, yz[0]), mul(ZTc, yz[1]))), dh = HF(p[0], p[1], p[2], 1); if (dh < 0.0036) p = add(p, mul(sdfGrad(HF, p), 0.0036 - dh)); return p; };   // (clear of the hair strands)
    var SM = new Mesh(); SM.grid(24, 64, function (u, s) { return { p: shellP(u, s), uv: [(u - 0.5) * 0.16, s * Ltot, 0, 0] }; });
    var sm = SM.out(by.head, 'horn', true); part('crown', 'hairCap', sm, { parents: ['hairCap', 'hairStrands'] });   // (it rests on the strands)
    var RM = new Mesh(), e0 = [], e1 = [], tops = [[], []]; for (k = 0; k <= 64; k++) { e0.push(shellP(0, k / 64)); e1.push(shellP(1, k / 64)); } for (k = 0; k <= 24; k++) { tops[0].push(shellP(k / 24, 0)); tops[1].push(shellP(k / 24, 1)); }
    [e0, e1, tops[0], tops[1]].forEach(function (L2) { tube(RM, L2, L2.map(function () { return 0.0011; }), 5); });
    part('crownRim', 'crown', RM.out(by.head, 'ivory'));
    jw.push([add(bc, [0.045, 0.0, -0.005]), [0.8, 0.45, -0.2]], [add(bc, [-0.045, 0.0, -0.005]), [-0.8, 0.45, -0.2]]);
  } else if (HD === 'zhucui') {
    // 珠翠 (聽阮圖): one continuous carved spray of white-green jade sweeping across the top-front of the hair from the left and
    // out past the right side in cloud-like lobes with curled tips; pearls along its edges and in a string along it; a small
    // jade star on the topmost bun. The spray's spine follows the hair (clear of the strands), then continues in the air.
    if (!useSvg) {
    var ZC = SC.zhucui || {}, y0 = ZC.y != null ? ZC.y : 0.122, sp = [], NA = 64, NB = 26, OFF = 0.0058;
    for (k = 0; k < NA; k++) { var ph = -1.45 + 2.5 * k / (NA - 1), g = hl(sin(ph) * 0.105, y0 + 0.01 * cos(ph) - 0.012 * max(ph, 0), cos(ph) * 0.1 - 0.035), s0 = projectTo(HF, g); sp.push({ p: add(s0, mul(outN(s0), OFF)), n: outN(s0) }); }
    for (var it = 0; it < 3; it++) sp = sp.map(function (q, i) { if (!i || i === sp.length - 1) return q; var m = lerp3(sp[i - 1].p, sp[i + 1].p, 0.5); return { p: lerp3(q.p, m, 0.5), n: q.n }; });   // smooth the spine
    sp.forEach(function (q) { var d = HF(q.p[0], q.p[1], q.p[2], 1); if (d < OFF) q.p = add(q.p, mul(sdfGrad(HF, q.p), OFF - d)); });
    var e = sp[NA - 1], T0 = norm(sub(e.p, sp[NA - 3].p)), Tend = norm([0.95, 0.12, -0.28]), cur = e.p;   // out past her left side
    for (k = 1; k <= NB; k++) { var f = k / NB, Td = norm(lerp3(T0, Tend, f)); cur = add(cur, mul(Td, 0.095 / NB)); sp.push({ p: cur, n: e.n, air: true }); }
    var NS = sp.length, Ltot = 0, acc = [0]; for (k = 1; k < NS; k++) { Ltot += len(sub(sp[k].p, sp[k - 1].p)); acc.push(Ltot); }
    var fr = sp.map(function (q, i) { var tg = norm(sub(sp[min(i + 1, NS - 1)].p, sp[max(i - 1, 0)].p)), rh = norm(add(mul(norm([q.p[0] - bc[0], 0, q.p[2] - bc[2]]), 0.75), mul(q.n, 0.25))), nn = norm(sub(rh, mul(tg, dot(rh, tg)))), sd = norm(cross(nn, tg)); if (sd[1] < 0) sd = mul(sd, -1);   // the spray stands up from the hair, facing out; sd: toward its upper edge
      var t = acc[i] / Ltot, B = t > NA / NS ? (t - NA / NS) / (1 - NA / NS) : 0, ends = smooth(0, 0.06, t) * (1 - smooth(0.93, 1, t));
      var cl = 0.5 + 0.3 * sin(acc[i] / (0.004 + 0.006 * B) * PI) + 0.2 * sin(acc[i] * 517 + 1.3), wU = (0.009 + 0.007 * smooth(0.25, 0.7, t) + 0.014 * B) * (0.55 + (0.45 + 0.25 * B) * Math.pow(max(cl, 0), 0.7)) * ends, wL = (0.0055 + 0.006 * B) * (0.8 + 0.2 * abs(sin(PI * acc[i] / 0.01))) * ends;
      var pc = q.air ? q.p : add(q.p, mul(sd, wL + 0.0015));
      return { p: pc, tg: tg, nn: nn, sd: sd, wU: max(wU, 0.0004), wL: max(wL, 0.0004), th: 0.0021 * (0.4 + 0.6 * ends) + 0.0002, t: t, B: B }; });
    var ZM = new Mesh();
    ZM.grid(16, NS - 1, function (u, v) { var i = Math.round(v * (NS - 1)), F2 = fr[i], a = u * 2 * PI, ca = cos(a), sa = sin(a), w = ca > 0 ? F2.wU : F2.wL;
      var relief = 0.00035 * sin(F2.t * 140) * max(sa, 0) * (1 - ca * ca);   // carved ridges across the top face
      return { p: add(F2.p, add(mul(F2.sd, w * ca), mul(F2.nn, (F2.th + relief) * sa + F2.th * 0.5))), uv: [u, v, 0, 0] }; }, true);
    // curled tips: tapered spiral tubes growing out of the upper edge (more and bigger on the free end)
    var curls = [0.3, 0.46, 0.6, 0.68, 0.74, 0.8, 0.85, 0.9, 0.95, 0.985, -0.72, -0.82, -0.9, -0.96];   // (negative: from the lower edge)
    curls.forEach(function (tc0, ci) { var lo = tc0 < 0, tc = abs(tc0), i = Math.round(tc * (NS - 1)), F2 = fr[i], sdv = lo ? mul(F2.sd, -1) : F2.sd, st = add(F2.p, add(mul(sdv, (lo ? F2.wL : F2.wU) * 0.6), mul(F2.nn, F2.th * 0.5))), sz = (0.007 + 0.012 * F2.B) * (lo ? 0.7 : 1), pts = [], rad = [];
      var ax1 = norm(add(sdv, mul(F2.tg, 0.7))), ax2 = norm(sub(F2.tg, mul(ax1, dot(F2.tg, ax1))));
      for (var q = 0; q <= 16; q++) { var th3 = q / 16 * 1.05 * PI, r3 = sz * (1 - 0.35 * q / 16); pts.push(add(st, add(mul(ax1, sin(th3) * r3), mul(ax2, (1 - cos(th3)) * r3 * 0.8)))); rad.push(0.0034 * Math.pow(1 - 0.8 * q / 16, 1.3) * (0.7 + 0.3 * F2.B)); }   // a flame-like lobe with a curled tip
      tube(ZM, pts, rad, 6); });
    part('zhucuiJade', 'hairCap', ZM.out(by.head, 'jadeSpray', true), { parents: ['hairCap', 'hairStrands'] });
    // pearls: along both edges, and a string along the top face
    var PM = new Mesh(), PS = new Mesh(), lastE = [-1, -1], lastC = -1;
    fr.forEach(function (F2, i) { if (F2.t < 0.04 || F2.t > 0.97) return;
      [1, -1].forEach(function (sgn, e2) { if (acc[i] - lastE[e2] < 0.0062) return; lastE[e2] = acc[i]; var w = sgn > 0 ? F2.wU : F2.wL; sphere(PM, add(F2.p, add(mul(F2.sd, sgn * (w + 0.0006)), mul(F2.nn, F2.th * 0.5))), 0.0015, 6); });
      if (acc[i] - lastC > 0.0075) { lastC = acc[i]; sphere(PS, add(F2.p, mul(F2.nn, F2.th * 1.5 + 0.0011)), 0.0013, 6); } });
    part('zhucuiPearls', 'zhucuiJade', PM.out(by.head, 'pearl'), { perComponent: true });
    part('zhucuiString', 'zhucuiJade', PS.out(by.head, 'pearl'), { perComponent: true });
    }
    // a small jade star (with a pearl heart) on the topmost bun
    var ZS = SC.zhucui || {}, tb3 = bun[bun.length - 1], stc = projectTo(HF, hl(tb3[0], tb3[1] + tb3[4] * 0.5, tb3[2] + tb3[5] * 0.9)), stn = outN(stc), SF = frame(stn), STM = new Mesh(), sc0 = add(stc, mul(stn, 0.0042 + 0.25 * ((ZS.star || 0.0105) - 0.0105)));
    var STR = ZS.star || 0.0105;   // the star's radius (costume.song.zhucui.star)
    STM.grid(32, 2, function (u, v) { var a = u * 2 * PI, r = STR * (0.3 + 0.7 * Math.pow(abs(cos(2 * a)), 3)) * v, h = 0.0012 * (1 - v); return { p: add(sc0, add(add(mul(SF.t, cos(a) * r), mul(SF.b, sin(a) * r)), mul(stn, h))), uv: [u, v, 0, 0] }; }, true);
    STM.grid(32, 1, function (u, v) { var a = u * 2 * PI, r = STR * (0.3 + 0.7 * Math.pow(abs(cos(2 * a)), 3)); return { p: add(sc0, add(add(mul(SF.t, cos(a) * r), mul(SF.b, sin(a) * r)), mul(stn, -0.0012 * v))), uv: [u, v, 0, 0] }; }, true, true);
    tube(STM, [add(sc0, mul(stn, -0.0005)), add(sc0, mul(stn, -0.012))], [0.0011, 0.0009], 5);   // its pin, into the bun
    part('zhucuiStar', 'hairCap', STM.out(by.head, 'jadeSpray', true));
    var spe = new Mesh(); sphere(spe, add(sc0, mul(stn, 0.0016)), 0.0019, 8); part('zhucuiStarPearl', 'zhucuiStar', spe.out(by.head, 'pearl'));
  } else if (HD === 'gele') {
    var GM2 = new Mesh(), tri = function (v) { return Math.pow(sin(PI * min(v * 0.85 + 0.15, 1)), 0.5) * (0.4 + 0.6 * (1 - abs(v - 0.55) * 1.3)); };
    [[-1, 0.5], [1, 0.5], [0, -0.7]].forEach(function (o, i) {   // two flaring sideways from the top of the bun, one up at the back
      var top = projectTo(HF, add(bc, [o[0] * 0.025, 0.07, o[1] * 0.02])), n0 = outN(top), d = norm([o[0] * 0.85, 0.75, o[1] * 0.3]), nl = norm(sub(i < 2 ? [0, 0, 1] : [1, 0, 0], mul(d, dot(i < 2 ? [0, 0, 1] : [1, 0, 0], d))));
      leaf(GM2, add(top, mul(d, -0.012)), d, nl, 0.075, 0.03, 0.004, tri);
    });
    part('geleLeaves', 'hairCap', GM2.out(by.head, 'leafGG', true), { perComponent: true });
    var BD = new Mesh(); for (k = 0; k < 44; k++) { var ab = k / 44 * 2 * PI, hb = projectTo(HF, add(bc, [sin(ab) * 0.09, -0.06, cos(ab) * 0.09])); sphere(BD, add(hb, mul(outN(hb), 0.0038)), 0.0024, 6); }
    part('geleBeads', 'hairCap', BD.out(by.head, 'coral'), { perComponent: true });
  }
  // pins (簪): white jade rods with pearl heads, pushed into the bun
  jw.forEach(function (pp, i) { var d = norm(pp[1]), surf = projectTo(HF, pp[0]), M = new Mesh(), head = add(surf, mul(d, 0.016)); tube(M, [add(surf, mul(d, -0.05)), surf, head], [0.0013, 0.0014, 0.0015], 8);
    part('jadePin' + i, 'hairCap', M.out(by.head, 'jadeWhite')); var pe = new Mesh(); sphere(pe, add(head, mul(d, 0.003)), 0.0032, 8); part('jadePinPearl' + i, 'jadePin' + i, pe.out(by.head, 'pearl')); });
  // 耳墜: a gold hook through each lobe; below it a short chain (two gold beads and a pearl drop) that swings
  var chains = [];
  [1, -1].forEach(function (s2) {
    var lob = hl(0.0738 * s2, -0.0305, -0.013), inn = projectTo(BF, lob), nrm2 = sdfGrad(BF, inn), lowest = add(inn, mul(nrm2, -0.0012)), M = new Mesh();
    var hook = [add(lowest, [0, 0.003, -0.002]), lowest, add(lowest, [0.0012 * s2, -0.0045, 0.001]), add(lowest, [0.0016 * s2, -0.008, 0.0004])];
    tube(M, hook, [0.0006, 0.0006, 0.0006, 0.0006], 6); sphere(M, hook[3], 0.0014, 6);
    var nm = 'earring' + (s2 > 0 ? 'L' : 'R'); part(nm, 'body', M.out(by.head, 'gold'));
    chains.push({ top: hook[3], topR: 0.0014, parent: nm, collideBody: true, beads: [{ r: 0.0013, mat: 'gold' }, { r: 0.0013, mat: 'gold' }, { r: 0.0017, mat: 'gold' }, { r: 0.0036, mat: 'pearl' }] });
  });
  return chains;
}
function sign(x) { return x < 0 ? -1 : 1; }
// turn each triangle to agree with its vertex normals (sphere() / tube() wind against the normals they carry)
function outwardWinding(m) { if (!m || !m.idx || !m.nrm) return m; var I = m.idx, Pp = m.pos, N = m.nrm;
  for (var k = 0; k < I.length; k += 3) { var a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3, g = cross([Pp[b] - Pp[a], Pp[b + 1] - Pp[a + 1], Pp[b + 2] - Pp[a + 2]], [Pp[c] - Pp[a], Pp[c + 1] - Pp[a + 1], Pp[c + 2] - Pp[a + 2]]);
    if (g[0] * (N[a] + N[b] + N[c]) + g[1] * (N[a + 1] + N[b + 1] + N[c + 1]) + g[2] * (N[a + 2] + N[b + 2] + N[c + 2]) < 0) { var t = I[k + 1]; I[k + 1] = I[k + 2]; I[k + 2] = t; } }
  return m; }
function buildOrnaments(sk, body, hair, cfg, log) {
  var O = sk.O, by = sk.by, HF = hair.sdf, BF = body.sdf, parts = [], R = rng(31);
  function hl(x, y, z) { return add(O, [x, y, z]); }
  function part(name, parent, mesh, extra) { var p = { name: name, parent: parent, mesh: mesh, kind: 'rigid' }; for (var k in extra || {}) p[k] = extra[k]; parts.push(p); return p; }
  var song = cfg.costume === 'song', chains;
  var part0 = part; part = function (n, p, m, e) { if (!/^lashes/.test(n)) outwardWinding(m); return part0(n, p, m, e); };   // every part faces out (both styles)
  // sphere() / tube() wind their triangles against the normals they carry (inside-out once back faces are culled); the
  // Song parts get each triangle turned to agree with its vertex normal (Tang keeps its parts exactly as they were)
  var partS = function (n, p, m, e) { outwardWinding(m); return part(n, p, m, e); };
  if (song) chains = songHead(sk, body, hair, partS, hl);
  else {
  // --- peony on the front-top of the bun: receptacle, layered petals, leaves ---
  var fc = projectTo(HF, hl(0.012, 0.215, 0.07)), fn = norm(add(sdfGrad(HF, fc), [0, 0.35, 0.1])), FF = frame(fn);
  var rec = new Mesh(); sphere(rec, add(fc, mul(fn, 0.002)), 0.013, 10);
  part('peony', 'hairCap', rec.out(by.head, 'leaf'));
  var petals = new Mesh(), rings = [[11, 0.058, 0.45, 0.0], [10, 0.05, 0.72, 0.3], [9, 0.04, 0.98, 0.15], [8, 0.03, 1.24, 0.45], [7, 0.021, 1.5, 0.2]];
  rings.forEach(function (rg, ri) {
    for (var k = 0; k < rg[0]; k++) {
      var az = (k + rg[3] + R() * 0.25) * 2 * PI / rg[0], L = rg[1] * (0.9 + R() * 0.2), Wd = L * 0.75, tilt = rg[2] + R() * 0.03;
      var dir = add(mul(FF.t, cos(az)), mul(FF.b, sin(az))), out = norm(add(mul(dir, cos(tilt)), mul(fn, sin(tilt)))), side = norm(cross(fn, dir)), up = norm(cross(out, side));
      var base = add(add(add(fc, mul(fn, -0.004 + ri * 0.003 + (k % 3) * 0.0009)), mul(dir, 0.0045)), mul(up, 0.0005 * k)), seed = R() * 10;   // each petal a little above the one before (no coplanar overlaps)
      petals.grid(8, 8, function (u, v) {   // u across, v along
        var x = (u - 0.5) * 2, w = Wd * Math.pow(sin(PI * min(v * 0.95 + 0.05, 1)), 0.45) * (0.35 + 0.65 * v), cup = 0.38 * L * (x * x) * v + 0.12 * L * v * v - 0.1 * L * sq(max(v - 0.7, 0) / 0.3) * (1 - 0.5 * x * x);   // cupped, the tip curling back
        var ruffle = 0.006 * sin(x * 9 + seed) * smooth(0.45, 1, v) * (0.4 + abs(x)) + 0.002 * sin(v * 17 + seed) * x * x;   // wavy edges
        var p = add(base, add(mul(out, v * L), add(mul(side, x * w * 0.5), mul(up, cup + ruffle))));
        return { p: p, uv: [u, v, ri / 4, 0] };
      });
    }
  });
  var pm = petals.out(by.head, 'petal', true); part('peonyPetals', 'peony', pm, { perComponent: true });
  var stam = new Mesh(); for (var k = 0; k < 24; k++) { var a = R() * 2 * PI, rr = R() * 0.008, b0 = add(fc, add(mul(FF.t, cos(a) * rr), mul(FF.b, sin(a) * rr))); sphere(stam, add(b0, mul(fn, 0.004 + R() * 0.004)), 0.0022, 4); }
  part('peonyStamens', 'peony', stam.out(by.head, 'stamen'), { perComponent: true });
  var leaves = new Mesh();
  [-1, 1].forEach(function (s) {
    var dir = norm(add(mul(FF.t, s), mul(FF.b, -0.4))), side = norm(cross(fn, dir)), base = add(fc, mul(dir, 0.004));
    leaves.grid(10, 16, function (u, v) {
      var x = (u - 0.5) * 2, w = 0.022 * Math.pow(sin(PI * v), 0.8) * (1 - 0.25 * v), fold = 0.006 * abs(x) * sin(PI * min(v * 1.2, 1)), wave = 0.0018 * sin(v * 23 + s * 2) * x * x;   // midrib fold, wavy margin
      var p = add(base, add(mul(dir, v * 0.08), add(mul(side, x * w), mul(fn, -0.012 * v * v + fold + wave + 0.004))));
      var dh = HF(p[0], p[1], p[2], 1); if (dh < 0.0025) p = add(p, mul(sdfGrad(HF, p), 0.0025 - dh));   // never into the hair
      return { p: p, uv: [u, v, 0, 0] }; });
  });
  part('peonyLeaves', 'peony', leaves.out(by.head, 'leaf', true), { perComponent: true });
  var swayInfo = { base: fc, axis: fn, bone: by.head };
  parts.filter(function (p) { return /^peony/.test(p.name); }).forEach(function (p) { p.sway = { info: swayInfo, pos0: p.mesh.pos.slice(), nrm0: p.mesh.nrm.slice() }; });
  // --- gold hairpins (簪): rods pushed into the bun, ornamental heads ---
  var pins = [[0.055, 0.17, -0.02, [0.6, 0.35, -0.5]], [-0.055, 0.16, -0.01, [-0.6, 0.4, -0.45]], [0.045, 0.21, -0.03, [0.55, 0.65, -0.35]], [-0.03, 0.235, 0.0, [-0.3, 0.85, 0.2]]];
  pins.forEach(function (pp, i) {
    var surf = projectTo(HF, hl(pp[0], pp[1], pp[2])), d = norm(pp[3]), M = new Mesh(), inside = add(surf, mul(d, -0.06)), head = add(surf, mul(d, 0.035));
    tube(M, [inside, surf, head], [0.0011, 0.0013, 0.0014], 8);
    // head: a gold flower with a pearl
    var F2 = frame(d); for (var k = 0; k < 6; k++) { var a = k * PI / 3; sphere(M, add(head, add(mul(F2.t, cos(a) * 0.006), mul(F2.b, sin(a) * 0.006))), 0.0042, 6, 0.4); }
    part('pin' + i, 'hairCap', M.out(by.head, 'gold'));
    var pe = new Mesh(); sphere(pe, add(head, mul(d, 0.0035)), 0.0035, 8); part('pinPearl' + i, 'pin' + i, pe.out(by.head, 'pearl'));
  });
  // --- comb (梳): half-moon gold plate, teeth in the hair at the front of the bun ---
  var cc = projectTo(HF, hl(0, 0.115, 0.07)), cn = sdfGrad(HF, cc), CF = frame(cn), cm = new Mesh(), up2 = norm(sub([0, 1, 0], mul(cn, dot([0, 1, 0], cn)))), sd2 = norm(cross(cn, up2));
  cm.grid(24, 1, function (u, v) { var a = PI * (0.1 + 0.8 * u), r = 0.032 + 0.006 * v; var p = add(cc, add(mul(sd2, -cos(a) * r), add(mul(up2, sin(a) * r * 0.55 - 0.004), mul(cn, -0.004 + 0.0018)))); return { p: p, n: cn, uv: [u, v, 0, 0] }; });
  cm.grid(24, 1, function (u, v) { var a = PI * (0.1 + 0.8 * u), r = 0.032 + 0.006 * v; var p = add(cc, add(mul(sd2, -cos(a) * r), add(mul(up2, sin(a) * r * 0.55 - 0.004), mul(cn, -0.004 - 0.0004)))); return { p: p, n: mul(cn, -1), uv: [u, v, 0, 0] }; }, false, true);
  for (k = 0; k < 9; k++) { var a = PI * (0.15 + 0.7 * k / 8), b0 = add(cc, add(mul(sd2, -cos(a) * 0.026), add(mul(up2, sin(a) * 0.0145 - 0.004), mul(cn, -0.003)))); sphere(cm, b0, 0.0032, 6); }
  // filigree on the comb's face: wire scrolls (thin spiral tubes) and granulation (tiny beads) along the rim
  for (k = 0; k < 7; k++) { var a3 = PI * (0.18 + 0.64 * k / 6), cs = add(cc, add(mul(sd2, -cos(a3) * 0.03), add(mul(up2, sin(a3) * 0.0165 - 0.004), mul(cn, -0.0018)))), sp = [];
    for (var q = 0; q <= 14; q++) { var ang = q / 14 * 3.2 * PI, rr3 = 0.0005 + 0.0045 * q / 14; sp.push(add(cs, add(mul(sd2, cos(ang + a3) * rr3), mul(up2, sin(ang + a3) * rr3 * 0.8)))); }
    tube(cm, sp, sp.map(function () { return 0.00045; }), 4); }
  for (k = 0; k < 26; k++) { var a4 = PI * (0.1 + 0.8 * k / 25); sphere(cm, add(cc, add(mul(sd2, -cos(a4) * 0.0375), add(mul(up2, sin(a4) * 0.0375 * 0.55 - 0.004), mul(cn, -0.0024)))), 0.0009, 4); }
  part('comb', 'hairCap', cm.out(by.head, 'gold', true));
  // a small gold flower crest (金花) at the front of the hair above the comb, with a pearl heart
  var gc = projectTo(HF, hl(0, 0.138, 0.07)), gn = sdfGrad(HF, gc), GF = frame(gn), gm = new Mesh(), GS = 1.7;
  for (k = 0; k < 8; k++) { var a5 = k * PI / 4, pc = add(gc, add(mul(GF.t, cos(a5) * 0.0085 * GS), add(mul(GF.b, sin(a5) * 0.0085 * GS), mul(gn, 0.0016 * GS)))); sphere(gm, pc, 0.0042 * GS, 6, 0.4);
    var ring2 = []; for (var q2 = 0; q2 <= 16; q2++) { var b5 = q2 / 16 * 2 * PI; ring2.push(add(pc, add(mul(GF.t, cos(b5) * 0.0046 * GS), add(mul(GF.b, sin(b5) * 0.0046 * GS), mul(gn, 0.0024 * GS))))); } tube(gm, ring2, ring2.map(function () { return 0.0005; }), 3); }
  part('goldFlower', 'hairCap', gm.out(by.head, 'gold'));
  var gp = new Mesh(); sphere(gp, add(gc, mul(gn, 0.0042 * GS)), 0.0034 * GS, 8); part('goldFlowerPearl', 'goldFlower', gp.out(by.head, 'pearl'));
  // --- 步搖: a pin on the left of the bun with a branch; bead chains hang (simulated) ---
  var bs = projectTo(HF, hl(0.06, 0.185, 0.025)), bd = norm([0.75, 0.45, 0.35]), bm = new Mesh(), btip = add(bs, mul(bd, 0.03));
  tube(bm, [add(bs, mul(bd, -0.05)), bs, btip], [0.0012, 0.0013, 0.0014], 8);
  var branch = [], bF = frame(bd);
  for (k = 0; k < 5; k++) { var a = (k - 2) * 0.45, tip = add(btip, add(mul(bF.t, sin(a) * 0.022), add(mul(bd, 0.008), mul([0, -1, 0], 0.002 + 0.004 * abs(k - 2))))); tube(bm, [btip, lerp3(btip, tip, 0.5), tip], [0.0009, 0.0008, 0.0008], 6); sphere(bm, tip, 0.0026, 6); branch.push(tip); }
  // a second, smaller 步搖 on the right side of the bun (its dangles join the simulated chains)
  var bs2 = projectTo(HF, hl(-0.058, 0.2, 0.02)), bd2 = norm([-0.72, 0.5, 0.4]), btip2 = add(bs2, mul(bd2, 0.026)), bF2 = frame(bd2);
  tube(bm, [add(bs2, mul(bd2, -0.05)), bs2, btip2], [0.0011, 0.0012, 0.0013], 8);
  for (k = 0; k < 3; k++) { var a6 = (k - 1) * 0.5, tip2 = add(btip2, add(mul(bF2.t, sin(a6) * 0.016), add(mul(bd2, 0.014), mul([0, -1, 0], 0.002 + 0.004 * abs(k - 1))))); tube(bm, [btip2, lerp3(btip2, tip2, 0.5), tip2], [0.0008, 0.0007, 0.0007], 6); sphere(bm, tip2, 0.0026, 6); branch.push(tip2); }
  for (k = 0; k < 6; k++) { var a7 = k * PI / 3; sphere(bm, add(btip2, add(mul(bF2.t, cos(a7) * 0.005), mul(bF2.b, sin(a7) * 0.005))), 0.0034, 6, 0.4); }   // a gold flower head
  part('buyao', 'hairCap', bm.out(by.head, 'gold'));
  chains = branch.map(function (tip, ci) {
    var n = 4 + (ci % 2), beads = [], r0 = 0.0026;
    for (var j = 0; j < n; j++) { var r = j === n - 1 ? 0.0042 : 0.0022; beads.push({ r: r, mat: j === n - 1 ? (ci % 2 ? 'jade' : 'pearl') : 'gold' }); }
    return { top: tip, topR: r0, beads: beads };
  });
  }
  // --- bracelets (wrist) and armlets (upper arm), rigid on the forearm / upper arm ---
  ['L', 'R'].forEach(function (S) {
    var a = sk.arms[S], M = a.M;
    function radial(c, ax) {   // the limb's cross-section around c: distance to the surface in 24 directions (marching inward)
      var F2 = frame(ax), out = [];
      for (var k = 0; k < 24; k++) { var ang = k * 2 * PI / 24, dd = add(mul(F2.t, cos(ang)), mul(F2.b, sin(ang))), t = 0.08; for (var i = 0; i < 60; i++) { var p = add(c, mul(dd, t)), d = BF(p[0], p[1], p[2], 1); if (d < 1e-5) break; t -= d; } out.push({ d: dd, r: max(t, 0) }); }
      return out;
    }
    function snug(c, ax, extra) { return radial(c, ax).reduce(function (m, q) { return max(m, q.r); }, 0) + extra; }   // smallest circle around the limb
    // bracelet and jade bangle: rigid rings threaded on the forearm, slightly larger than the wrist; they hang and slide
    // under gravity and arm motion (simulated in Sim.step: constrained to contain the limb's cross-section)
    function ring(name, c, ax, extra, tubeR, mat) {
      var rd = radial(c, ax);   // per direction: the widest the limb gets over the ring's width
      [-tubeR, tubeR].forEach(function (o) { radial(add(c, mul(ax, o)), ax).forEach(function (q, k) { rd[k].r = max(rd[k].r, q.r); }); });
      var R0 = rd.reduce(function (m, q) { return max(m, q.r); }, 0) + extra, M2 = new Mesh(), F2 = frame(ax);
      torus(M2, c, F2, R0, tubeR, 48); var m = M2.out(by['fore' + S], mat);
      part(name + S, 'body', m, { boneRegion: 'fore' + S, ring: { bone: by['fore' + S], c0: c, ax: ax, t: F2.t, b: F2.b, pts: rd.map(function (q) { return [dot(mul(q.d, q.r), F2.t), dot(mul(q.d, q.r), F2.b)]; }), rin: R0 - tubeR - 0.0004, slide: 0.003, pos0: m.pos.slice() } });
    }
    var wax = M(a.dF);
    if (song) return;   // (Song: the narrow sleeves cover the arms to the wrists)
    ring('bracelet', M(add(a.W, mul(a.dF, -0.03))), wax, 0.0034, 0.0024, 'gold');
    ring('jadeBangle', M(add(a.W, mul(a.dF, -0.052))), wax, 0.0040, 0.0036, 'jade');
    // armlet: a 3-turn spiral coil worn tight on the upper arm — it follows the arm's own cross-section (no gap)
    var ac = M(add(a.Sh, mul(a.dU, 0.15))), aax = M(a.dU), F3 = frame(aax), coil = [], cr = [];
    for (k = 0; k <= 96; k++) { var t = k / 96, ang = t * 3 * 2 * PI, cc = add(ac, mul(aax, (t - 0.5) * 0.024)), dir = add(mul(F3.t, cos(ang)), mul(F3.b, sin(ang)));
      var tt = 0.08; for (var i2 = 0; i2 < 60; i2++) { var pq = add(cc, mul(dir, tt)), dq = BF(pq[0], pq[1], pq[2], 1); if (dq < 1e-5) break; tt -= dq; }
      coil.push(add(cc, mul(dir, tt + 0.0016 + 0.0004))); cr.push(0.0016); }
    var am = new Mesh(); tube(am, coil, cr, 6); part('armlet' + S, 'body', am.out(by['arm' + S], 'gold'), { boneRegion: 'arm' + S });
    // a gold finger ring (指環) at the base of one finger (left: ring finger, plain band; right: index, with a small pearl):
    // the band follows the finger's own cross-section so it sits snugly, skinned rigidly to the proximal phalanx
    var fg = S === 'L' ? 'ring' : 'index', fb = sk.bones[by[fg + '1' + S]], fe = sk.bones[by[fg + '2' + S]], fax = norm(sub(fe.p, fb.p)), fc = lerp3(fb.p, fe.p, 0.42), FR = frame(fax), tr = 0.00085, rm = new Mesh(), rad = [];
    for (k = 0; k < 40; k++) { var an = k / 40 * 2 * PI, dr = add(mul(FR.t, cos(an)), mul(FR.b, sin(an))), tq = 0; while (tq < 0.02 && BF(fc[0] + dr[0] * tq, fc[1] + dr[1] * tq, fc[2] + dr[2] * tq, 1) < 0) tq += 0.0002; rad.push(tq); }
    var rr2 = rad.map(function (r, i) { return (r + rad[(i + 1) % 40] + rad[(i + 39) % 40]) / 3; });   // a little smoothing so the band is round-ish
    rr2 = rr2.map(function (r, i) { return max(r, rad[i]); });
    rm.grid(40, 8, function (u, v) {
      var i = Math.round(u * 40) % 40, an = u * 2 * PI, b2 = v * 2 * PI, rd = add(mul(FR.t, cos(an)), mul(FR.b, sin(an))), d = add(mul(rd, cos(b2)), mul(fax, sin(b2) * 1.25));
      return { p: add(fc, add(mul(rd, rr2[i] + tr + 0.0001), mul(d, tr))), n: norm(add(mul(rd, cos(b2)), mul(fax, sin(b2)))), uv: [u, v, 0, 0] };
    }, true);
    var ringPart = part('fingerRing' + S, 'body', rm.out(by[fg + '1' + S], 'gold'), { boneRegion: fg + '1' + S });
    if (S === 'R') {   // a small pearl set on the back of the band
      var back = M(mul(sk.arms[S].H.n, -1)), bi2 = 0, bd2 = -2; for (k = 0; k < 40; k++) { var an2 = k / 40 * 2 * PI, dd2 = dot(add(mul(FR.t, cos(an2)), mul(FR.b, sin(an2))), back); if (dd2 > bd2) { bd2 = dd2; bi2 = k; } }
      var an3 = bi2 / 40 * 2 * PI, rd3 = add(mul(FR.t, cos(an3)), mul(FR.b, sin(an3))), pm = new Mesh(); sphere(pm, add(fc, mul(rd3, rr2[bi2] + 2 * tr + 0.0016)), 0.0019, 8);
      part('ringPearl' + S, 'fingerRing' + S, pm.out(by[fg + '1' + S], 'pearl'));
    }
  });
  // --- eyelashes (lashMesh): along the upper lid margin, weighted like the margin ---
  ['L', 'R'].forEach(function (S) { part('lashes' + S, 'body', lashMesh(sk, body, S), { kind: 'skinned', perComponent: true }); });
  // --- teeth (upper on the head, lower on the jaw) and tongue, inside the mouth cavity ---
  [['teethU', 'head', 1], ['teethL', 'jaw', -1]].forEach(function (T) {
    var M = new Mesh();
    for (var k = -5; k <= 5; k++) { if (!k) continue; var u = (k - 0.5 * Math.sign(k)) / 5.5, x = u * 0.0185, z = MOUTH[2] - 0.0055 - 17 * x * x - 0.002, y = MOUTH[1] + T[2] * (0.0042 - 0.0004 * abs(u));
      var w = 0.0042 - 0.0012 * abs(u); sphere(M, hl(x, y, z), w * 0.55, 6, T[2] > 0 ? 1.6 : 1.4); }
    part(T[0], 'body', cavity(M.out(by[T[1]], 'teeth')), { inside: true, perComponent: true });
  });
  var tg = new Mesh(); sphere(tg, hl(0, -0.0708, 0.0675), 0.013, 10, 0.45); part('tongue', 'body', cavity(tg.out(by.jaw, 'tongue')), { inside: true });
  // mouth interior: light falls off toward the back of the mouth (aux.x scales direct and ambient light in the plain shader)
  function cavity(m) { var n = m.pos.length / 3, a = new Float32Array(n * 4).fill(1), zf = O[2] + MOUTH[2];
    for (var i = 0; i < n; i++) { var dz = zf - m.pos[i * 3 + 2], dx = abs(m.pos[i * 3] - O[0]); a[i * 4] = mix(1, 0.12, smooth(0.006, 0.03, dz + 0.4 * dx)); } m.aux = a; return m; }
  // --- shoes (高頭履): the foot's own SDF dilated a little and cut below the ankle (so they enclose the foot however it is
  // modelled), with an upturned toe cap; polygonized (outward winding) and skinned like the nearest foot vertex ---
  var hashF = body.hash || (body.hash = VHash(body.pos, 0.01));
  ['L', 'R'].forEach(function (S) {
    var g = sk.arms[S].leg, M2 = sk.arms[S].M, ball = M2(g.ball), ank = M2(g.ank), fwd = norm([ball[0] - ank[0], 0, ball[2] - ank[2]]), yTop = ank[1] - 0.014, tt = 0;
    while (tt < 0.15 && BF(ball[0] + fwd[0] * tt, ball[1] + 0.008, ball[2] + fwd[2] * tt, 1) < 0) tt += 0.001;
    var t0 = add(ball, [fwd[0] * (tt - 0.012), 0.012, fwd[2] * (tt - 0.012)]), t1 = add(ball, [fwd[0] * (tt + 0.006), 0.05, fwd[2] * (tt + 0.006)]), cap = Cone(t0, t1, 0.016, 0.009);
    var lo = [min(ank[0], ball[0]) - 0.07, -0.02, min(ank[2], ball[2]) - 0.08], hi = [max(ank[0], ball[0]) + 0.07, yTop + 0.012, max(ank[2], ball[2]) + 0.12];
    var tree = bounds(U(0, [Fn(function (x, y, z) { return smin(max(BF(x, y, z, 1) - 0.0018, y - yTop), cap.f(x, y, z), 0.012); }, lerp3(lo, hi, 0.5), len(sub(hi, lo)) / 2)]));
    var m = polygonize(tree, lo, hi, 0.0022), nv = m.pos.length / 3, sm = { pos: m.pos, idx: m.idx, nrm: vertexNormals(m.pos, m.idx), uv: new Float32Array(nv * 4), bi: new Uint8Array(nv * 4), bw: new Float32Array(nv * 4), mat: 'shoe' };
    for (var i = 0; i < nv; i++) { var v0 = hashF.near([m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]], 0.06); for (var k = 0; k < 4; k++) { sm.bi[i * 4 + k] = v0 >= 0 ? body.bi[v0 * 4 + k] : by['foot' + S]; sm.bw[i * 4 + k] = v0 >= 0 ? body.bw[v0 * 4 + k] : (k ? 0 : 1); } }
    part('shoe' + S, 'body', sm, { kind: 'skinned' });
  });
  chains = chains || []; ORN.forEach(function (o, i) { buildPiece(o, i, partS, by, O, HF); }); CORDS.forEach(function (o, i) { buildCord(o, i, partS, by, HF); });
  if (log) log('ornaments: ' + parts.length + ' parts');
  return { parts: parts, chains: chains, ribbonTop: chains.ribbonTop };
}

/* ================= ornaments: traced jade pieces with pearls (figure "ornaments") =================
   The user's traced outlines (tool/comb.svg, tool/zhucui.svg → tool/svg2outline.js → ORN_SHAPES, unit width, y up) are
   extruded to a thickness with rounded edges and a slight bulge toward the middle of each lobe, studded with pearls all
   round the contour (every pearl diameter + gap), bent round a cylinder / sphere to follow the head, placed by o.place
   (an ellipsoid primitive: centre, axes u / v, r[0] = half the width — the editor's gizmo moves, rotates and scales it),
   optionally mirrored to the other side, and seated on the hair (moved along its own normal until it just clears the
   strands). o: {name, shape, thickness, round, relief, bend: {radius, axis: 'y' | 'x' | 'sphere'}, pearls: {r, gap},
   material: 'jade' | 'gold' | 'horn', mirror, seat, place}. */
/*ORN_SHAPES*/var ORN_SHAPES = {"comb":[[-0.0262,-0.1938],[-0.042,-0.191],[-0.0578,-0.1883],[-0.0736,-0.1856],[-0.0894,-0.1829],[-0.1052,-0.1804],[-0.121,-0.1779],[-0.1369,-0.1754],[-0.1527,-0.173],[-0.1686,-0.1707],[-0.1845,-0.1685],[-0.2004,-0.1664],[-0.2163,-0.1644],[-0.2322,-0.1626],[-0.2482,-0.1608],[-0.2642,-0.1595],[-0.2801,-0.1582],[-0.2962,-0.1577],[-0.3122,-0.158],[-0.3282,-0.1591],[-0.3442,-0.1598],[-0.3602,-0.1594],[-0.3762,-0.1583],[-0.3921,-0.1565],[-0.408,-0.1539],[-0.4237,-0.1508],[-0.4392,-0.147],[-0.4546,-0.1423],[-0.4695,-0.1365],[-0.4837,-0.129],[-0.4955,-0.1184],[-0.5,-0.1035],[-0.4918,-0.0902],[-0.4785,-0.0815],[-0.4633,-0.0762],[-0.4477,-0.0729],[-0.4318,-0.0708],[-0.4158,-0.0695],[-0.3998,-0.0689],[-0.3837,-0.0691],[-0.3913,-0.058],[-0.4011,-0.0453],[-0.4104,-0.0323],[-0.4191,-0.0188],[-0.4268,-0.0048],[-0.4327,0.0101],[-0.4344,0.0259],[-0.4237,0.0368],[-0.4078,0.0379],[-0.3919,0.036],[-0.3762,0.0328],[-0.3607,0.0288],[-0.3453,0.0242],[-0.3301,0.0191],[-0.315,0.0138],[-0.3,0.0081],[-0.2866,0.0039],[-0.2899,0.0196],[-0.2927,0.0354],[-0.295,0.0512],[-0.2967,0.0672],[-0.2974,0.0832],[-0.2968,0.0992],[-0.2933,0.1147],[-0.283,0.1264],[-0.2671,0.1274],[-0.2515,0.1239],[-0.2365,0.1184],[-0.2219,0.1117],[-0.2076,0.1044],[-0.1937,0.0965],[-0.18,0.088],[-0.175,0.0972],[-0.1724,0.1131],[-0.1692,0.1288],[-0.1651,0.1443],[-0.1595,0.1593],[-0.1517,0.1733],[-0.1395,0.1832],[-0.124,0.1819],[-0.1101,0.1742],[-0.0977,0.164],[-0.0862,0.1529],[-0.0752,0.1412],[-0.0648,0.129],[-0.0547,0.1165],[-0.045,0.1037],[-0.0418,0.1161],[-0.038,0.1316],[-0.0329,0.1468],[-0.026,0.1613],[-0.0167,0.1743],[-0.0048,0.1849],[0.0096,0.1917],[0.0254,0.1937],[0.041,0.1906],[0.0544,0.182],[0.0651,0.1701],[0.0733,0.1564],[0.0797,0.1417],[0.0847,0.1264],[0.0885,0.1109],[0.0913,0.0951],[0.0942,0.0863],[0.1007,0.1009],[0.1081,0.1151],[0.1164,0.1288],[0.1259,0.1418],[0.1368,0.1535],[0.1498,0.1628],[0.1648,0.168],[0.1806,0.1672],[0.1953,0.1611],[0.2077,0.1511],[0.2171,0.1382],[0.2239,0.1237],[0.2283,0.1083],[0.2307,0.0924],[0.2315,0.0764],[0.2367,0.0701],[0.2508,0.0777],[0.2653,0.0845],[0.2802,0.0902],[0.2957,0.0946],[0.3115,0.0969],[0.3275,0.0964],[0.3427,0.0919],[0.3555,0.0823],[0.3642,0.069],[0.3692,0.0538],[0.3702,0.0379],[0.3677,0.0221],[0.3629,0.0068],[0.3561,-0.0077],[0.3559,-0.0147],[0.371,-0.0094],[0.3864,-0.0047],[0.4019,-0.0006],[0.4175,0.0027],[0.4334,0.0051],[0.4494,0.0062],[0.4653,0.0054],[0.4806,0.0011],[0.4931,-0.0084],[0.4992,-0.0229],[0.4982,-0.0387],[0.4916,-0.0531],[0.4814,-0.0653],[0.4693,-0.0757],[0.4562,-0.0849],[0.4421,-0.0925],[0.4277,-0.0995],[0.4129,-0.1058],[0.3979,-0.1114],[0.3827,-0.1166],[0.3673,-0.1211],[0.3519,-0.1254],[0.3362,-0.129],[0.3206,-0.1324],[0.3048,-0.1352],[0.289,-0.1377],[0.2731,-0.1398],[0.2571,-0.1411],[0.2411,-0.1423],[0.2251,-0.1434],[0.2092,-0.145],[0.1932,-0.1469],[0.1774,-0.1493],[0.1615,-0.1518],[0.1457,-0.1546],[0.13,-0.1575],[0.1143,-0.1606],[0.0985,-0.1639],[0.0829,-0.1673],[0.0672,-0.1707],[0.0516,-0.1743],[0.036,-0.178],[0.0204,-0.1818],[0.0049,-0.1857],[-0.0107,-0.1897]],"zhucui":[[-0.2976,0.2345],[-0.3114,0.2308],[-0.3252,0.2271],[-0.339,0.2233],[-0.3528,0.2196],[-0.3665,0.2159],[-0.3803,0.2122],[-0.3941,0.2085],[-0.4079,0.2113],[-0.422,0.2134],[-0.4363,0.2136],[-0.4502,0.211],[-0.463,0.2049],[-0.4733,0.195],[-0.4824,0.184],[-0.4908,0.1725],[-0.4978,0.1601],[-0.4977,0.147],[-0.4838,0.1475],[-0.4709,0.1536],[-0.4586,0.1607],[-0.4451,0.1652],[-0.4313,0.1627],[-0.4195,0.1547],[-0.4091,0.145],[-0.3978,0.1364],[-0.3838,0.134],[-0.3697,0.1359],[-0.3558,0.1392],[-0.342,0.1426],[-0.328,0.1456],[-0.3139,0.1477],[-0.2997,0.1478],[-0.2856,0.1458],[-0.2716,0.1428],[-0.2577,0.1396],[-0.2441,0.1354],[-0.2313,0.1291],[-0.2217,0.1187],[-0.2202,0.1047],[-0.2206,0.0905],[-0.2215,0.0762],[-0.2293,0.065],[-0.2432,0.063],[-0.2573,0.065],[-0.2711,0.0688],[-0.2841,0.0746],[-0.2962,0.0822],[-0.3076,0.0907],[-0.3206,0.096],[-0.3345,0.0934],[-0.3474,0.0875],[-0.3589,0.0791],[-0.3611,0.0659],[-0.3528,0.0544],[-0.3424,0.0447],[-0.3311,0.0359],[-0.3191,0.0283],[-0.306,0.0226],[-0.2924,0.0182],[-0.2799,0.0115],[-0.2707,0.0009],[-0.2683,-0.0131],[-0.2659,-0.0269],[-0.2528,-0.0301],[-0.2389,-0.0269],[-0.2258,-0.0213],[-0.2138,-0.0135],[-0.2022,-0.0053],[-0.1905,-0.011],[-0.1841,-0.0237],[-0.1843,-0.0377],[-0.1919,-0.0496],[-0.2025,-0.0591],[-0.2117,-0.07],[-0.2178,-0.0828],[-0.2148,-0.0959],[-0.2017,-0.1008],[-0.1875,-0.1023],[-0.1732,-0.1027],[-0.1596,-0.099],[-0.149,-0.0896],[-0.1414,-0.0776],[-0.1344,-0.0651],[-0.1264,-0.0533],[-0.1141,-0.0487],[-0.1048,-0.0592],[-0.1017,-0.0729],[-0.1018,-0.0872],[-0.0983,-0.1009],[-0.0889,-0.1115],[-0.077,-0.1194],[-0.0651,-0.1273],[-0.0539,-0.1361],[-0.0428,-0.1451],[-0.0314,-0.1537],[-0.0191,-0.1608],[-0.0058,-0.1659],[0.0082,-0.1689],[0.0224,-0.1701],[0.0367,-0.1701],[0.0509,-0.1695],[0.0652,-0.1687],[0.0794,-0.168],[0.0937,-0.1676],[0.1079,-0.1675],[0.1222,-0.1677],[0.1365,-0.1679],[0.1508,-0.1684],[0.165,-0.1689],[0.1793,-0.1691],[0.1935,-0.1684],[0.2078,-0.1678],[0.2128,-0.1774],[0.2094,-0.1897],[0.1963,-0.184],[0.1835,-0.1777],[0.1704,-0.1747],[0.1653,-0.1878],[0.1641,-0.2019],[0.1701,-0.2146],[0.1818,-0.2226],[0.1937,-0.2305],[0.2071,-0.2344],[0.221,-0.2315],[0.2346,-0.2272],[0.2483,-0.2231],[0.2612,-0.2173],[0.2704,-0.2065],[0.2777,-0.1942],[0.2851,-0.182],[0.2905,-0.1689],[0.2841,-0.1568],[0.2726,-0.1484],[0.2597,-0.1424],[0.246,-0.1381],[0.2444,-0.1299],[0.2586,-0.1286],[0.2728,-0.1297],[0.2869,-0.1316],[0.301,-0.1341],[0.315,-0.137],[0.3291,-0.1386],[0.343,-0.1357],[0.3569,-0.1323],[0.3709,-0.1296],[0.385,-0.1277],[0.3955,-0.1205],[0.3917,-0.1068],[0.3788,-0.1043],[0.3646,-0.1062],[0.3507,-0.1092],[0.3364,-0.1087],[0.3222,-0.1075],[0.308,-0.1062],[0.2938,-0.105],[0.2796,-0.1035],[0.2766,-0.0925],[0.2845,-0.0813],[0.2986,-0.0798],[0.3127,-0.0819],[0.3268,-0.0835],[0.3411,-0.0825],[0.3553,-0.0824],[0.3693,-0.0848],[0.3833,-0.0878],[0.3975,-0.0885],[0.4116,-0.0865],[0.4257,-0.0844],[0.44,-0.0837],[0.454,-0.0863],[0.4675,-0.0908],[0.4813,-0.0889],[0.4917,-0.0793],[0.4987,-0.067],[0.4982,-0.0532],[0.4857,-0.048],[0.4715,-0.0498],[0.4575,-0.0526],[0.4435,-0.0553],[0.4294,-0.0571],[0.4151,-0.0578],[0.4009,-0.0573],[0.3868,-0.055],[0.373,-0.0513],[0.3595,-0.0468],[0.3459,-0.0423],[0.3322,-0.0384],[0.3182,-0.0358],[0.304,-0.0351],[0.2899,-0.0373],[0.2765,-0.042],[0.2638,-0.0485],[0.2518,-0.0563],[0.2403,-0.0648],[0.2292,-0.0737],[0.218,-0.0825],[0.2055,-0.0891],[0.1954,-0.08],[0.1887,-0.0675],[0.1812,-0.0553],[0.1705,-0.046],[0.1582,-0.0387],[0.1453,-0.0327],[0.1317,-0.0285],[0.1175,-0.0273],[0.1039,-0.031],[0.0921,-0.039],[0.0806,-0.0475],[0.0699,-0.0569],[0.0623,-0.0688],[0.0636,-0.0826],[0.0704,-0.0952],[0.0821,-0.1006],[0.0946,-0.0938],[0.1066,-0.0861],[0.119,-0.0791],[0.1319,-0.073],[0.141,-0.0743],[0.1316,-0.0851],[0.1229,-0.0963],[0.1126,-0.1061],[0.0998,-0.1123],[0.086,-0.1156],[0.0718,-0.1173],[0.0576,-0.1182],[0.0433,-0.1187],[0.029,-0.1187],[0.0148,-0.1179],[0.0007,-0.1159],[-0.0128,-0.1113],[-0.0222,-0.1012],[-0.0252,-0.0873],[-0.0273,-0.0732],[-0.0247,-0.0595],[-0.0151,-0.064],[-0.011,-0.0777],[-0.0027,-0.0889],[0.011,-0.0913],[0.0249,-0.0883],[0.0377,-0.0821],[0.0449,-0.0703],[0.0402,-0.0572],[0.0319,-0.0457],[0.0335,-0.0334],[0.0472,-0.0298],[0.0611,-0.0268],[0.0603,-0.0134],[0.0615,0.0008],[0.0661,0.0143],[0.0672,0.0265],[0.0532,0.0242],[0.0395,0.0202],[0.0262,0.015],[0.0161,0.0054],[0.0158,-0.0087],[0.0113,-0.0166],[0.0015,-0.0062],[-0.0092,0.003],[-0.0227,0.0075],[-0.0367,0.0101],[-0.0508,0.0125],[-0.0631,0.0181],[-0.0524,0.0265],[-0.0388,0.0308],[-0.0248,0.0333],[-0.0105,0.0342],[0.0037,0.0354],[0.0174,0.039],[0.0298,0.046],[0.0275,0.0571],[0.0137,0.0602],[-0.0006,0.0608],[-0.0148,0.06],[-0.029,0.0584],[-0.0431,0.0562],[-0.0573,0.0544],[-0.0623,0.0623],[-0.0553,0.0748],[-0.0511,0.0883],[-0.054,0.102],[-0.0641,0.1119],[-0.0767,0.1185],[-0.0901,0.1234],[-0.1035,0.1282],[-0.0985,0.1359],[-0.0889,0.1445],[-0.0916,0.1585],[-0.09,0.1727],[-0.0899,0.1869],[-0.0947,0.2],[-0.1078,0.2042],[-0.1219,0.202],[-0.1362,0.2014],[-0.1504,0.202],[-0.1642,0.1992],[-0.1663,0.1867],[-0.1574,0.1757],[-0.1599,0.1626],[-0.1694,0.1519],[-0.1822,0.1464],[-0.1962,0.1486],[-0.2096,0.1536],[-0.2227,0.1593],[-0.2358,0.1649],[-0.2492,0.1697],[-0.2631,0.1731],[-0.2772,0.1749],[-0.2915,0.1752],[-0.3057,0.174],[-0.3198,0.1716],[-0.3337,0.1686],[-0.3477,0.1688],[-0.3549,0.1804],[-0.3516,0.194],[-0.3413,0.2036],[-0.3281,0.2087],[-0.3139,0.21],[-0.3002,0.2139],[-0.2903,0.2236]]};/*/ORN_SHAPES*/
function sd2Rings(rings) {   // signed 2D distance to a filled outline (nonzero), negative inside
  return function (x, y) { var d = 1e9, wind = 0;
    for (var r = 0; r < rings.length; r++) { var R = rings[r];
      for (var i = 0, j = R.length - 1; i < R.length; j = i++) { var ax = R[j][0], ay = R[j][1], bx = R[i][0], by = R[i][1], ex = bx - ax, ey = by - ay, wx = x - ax, wy = y - ay, t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey || 1), 0, 1), dx = wx - ex * t, dy = wy - ey * t; d = min(d, dx * dx + dy * dy);
        if ((ay > y) !== (by > y) && x < ax + (y - ay) / (by - ay) * ex) wind += by > ay ? 1 : -1; } }
    return wind !== 0 ? -sqrt(d) : sqrt(d); }; }
function ornamentSpace(o) {   // flat piece coordinates (x right, y up, z out of the face, metres) → bind space
  var P = o.place, u = norm(P.u || [1, 0, 0]), v = norm(sub(P.v || [0, 1, 0], mul(u, dot(P.v || [0, 1, 0], u)))), w = cross(u, v), B = o.bend || {}, R = B.radius || 0;
  var f = function (q) { var x = q[0], y = q[1], z = q[2];
    if (R) { if (B.axis === 'x') { var a = y / R; y = (R + z) * sin(a); z = (R + z) * cos(a) - R; } else if (B.axis === 'sphere') { var r = sqrt(x * x + y * y), a2 = r / R, k = r > 1e-9 ? (R + z) * sin(a2) / r : 1; z = (R + z) * cos(a2) - R; x *= k; y *= k; } else { var a3 = x / R; x = (R + z) * sin(a3); z = (R + z) * cos(a3) - R; } }
    return add(P.c, add(mul(u, x), add(mul(v, y), mul(w, z)))); };
  f.w = w; return f;
}
/* silk cords tying the hair (聽阮圖): a loop round the axis place.v, in the plane of place.u and its normal, radii place.r[0] /
   r[2]; `wraps` turns side by side along the axis; seated, each point is moved along its radial line onto the hair and sunk a
   little into the strands (centre ~2.5 mm off the cap). A twisted cord (ridged surface); optional knot with two short ends.
   o: {name, wraps, thickness, color, seat, ends, place} */
function buildCord(o, idx, part, by, HF) {
  var P = o.place; if (!P) return; var u = norm(P.u || [1, 0, 0]), v = norm(sub(P.v || [0, 1, 0], mul(u, dot(P.v || [0, 1, 0], u)))), w = cross(u, v), th = (o.thickness || 0.003) / 2, nW = max(1, Math.round(o.wraps || 1)), N = 120 * nW;
  var name = o.name || 'cord' + idx, bone = by[o.bone || 'head'], pts = [];
  for (var k = 0; k <= N; k++) { var a = k / N * nW * 2 * PI, ax = (k / N - 0.5) * (nW - 1) * th * 2.15, d = add(mul(u, cos(a) * P.r[0]), mul(w, sin(a) * P.r[2])), c = add(P.c, mul(v, ax)), q = add(c, d);
    if (o.seat !== false && HF) { var dl = len(d), dn = mul(d, 1 / dl), t = dl * 1.8; while (t > 0.005 && HF(c[0] + dn[0] * t, c[1] + dn[1] * t, c[2] + dn[2] * t, 1) > 0.0027 + th * 0.35) t -= 0.0005; q = add(c, mul(dn, t)); }
    pts.push(q); }
  for (var it = 0; it < 2; it++) pts = pts.map(function (q, i) { return i && i < pts.length - 1 ? lerp3(q, lerp3(pts[i - 1], pts[i + 1], 0.5), 0.5) : q; });   // smooth the seated loop
  var M = new Mesh(), NS = 8, twist = function (pp) {   // a twisted cord: a tube whose radius ripples along a helix
    M.grid(NS * 2, pp.length - 1, function (uu, vv) { var i = Math.round(vv * (pp.length - 1)), tg = norm(sub(pp[min(i + 1, pp.length - 1)], pp[max(i - 1, 0)])), F = frame(tg), a = uu * 2 * PI, dd = add(mul(F.t, cos(a)), mul(F.b, sin(a))), r = th * (1 + 0.12 * cos(2 * a + i * 0.9));
      return { p: add(pp[i], mul(dd, r)), uv: [uu, vv, 0, 0] }; }, true); };
  twist(pts); sphere(M, pts[0], th * 1.02, 6); sphere(M, pts[pts.length - 1], th * 1.02, 6);
  if (o.ends) { var kn = pts[0], down = norm(sub([0, -1, 0], mul(w, 0))), knot = new Mesh(); sphere(M, kn, th * 2.1, 8);   // a knot and two short loose ends
    [-1, 1].forEach(function (s2) { var e = [kn]; for (var q2 = 1; q2 <= 12; q2++) e.push(add(kn, add(mul(down, 0.0035 * q2), mul(u, s2 * 0.0012 * q2 * (1 - q2 / 24))))); twist(e); sphere(M, e[e.length - 1], th, 6); }); }
  part(name, 'hairCap', M.out(bone, o.color ? 'cord' + o.color : 'cord', true), { parents: ['hairCap', 'hairStrands'] });   // (mat 'cord#rrggbb': its colour)
}
function buildPiece(o, idx, part, by, O, HF) {
  var shape = ORN_SHAPES[o.shape] || o.outline; if (!shape || !o.place) return;
  var name = o.name || 'ornament' + idx, size = o.place.r[0] * 2, ring = shape.map(function (p) { return [p[0] * size, p[1] * size]; }), d2 = sd2Rings([ring]);
  var toW = ornamentSpace(o), hT = (o.thickness || 0.003) / 2, rr = min(o.round != null ? o.round : 0.001, hT * 0.95), rel = o.relief || 0, bone = by[o.bone || 'head'];
  var bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9; ring.forEach(function (p) { bx0 = min(bx0, p[0]); bx1 = max(bx1, p[0]); by0 = min(by0, p[1]); by1 = max(by1, p[1]); });
  var G = 0.0004, nx = Math.ceil((bx1 - bx0) / G) + 5, ny = Math.ceil((by1 - by0) / G) + 5, D = new Float32Array(nx * ny);   // the 2D distance on a raster, bilinear
  for (var j = 0; j < ny; j++) for (var i = 0; i < nx; i++) D[j * nx + i] = d2(bx0 - 2 * G + i * G, by0 - 2 * G + j * G);
  var dd = function (x, y) { var fx = clamp((x - bx0 + 2 * G) / G, 0, nx - 1.001), fy = clamp((y - by0 + 2 * G) / G, 0, ny - 1.001), i = floor(fx), j = floor(fy), a = fx - i, b = fy - j;
    return (D[j * nx + i] * (1 - a) + D[j * nx + i + 1] * a) * (1 - b) + (D[(j + 1) * nx + i] * (1 - a) + D[(j + 1) * nx + i + 1] * a) * b; };
  var f = function (x, y, z) { var a = dd(x, y), h = hT + rel * smooth(0, 0.006, -a), qx = a + rr, qy = abs(z) - h + rr; return sqrt(sq(max(qx, 0)) + sq(max(qy, 0))) - rr + min(max(qx, qy), 0); };   // rounded extrusion, bulging toward the middle
  var tree = bounds(U(0, [Fn(f, [(bx0 + bx1) / 2, (by0 + by1) / 2, 0], Math.hypot(bx1 - bx0, by1 - by0) / 2 + hT + rel)]));
  var m = polygonize(tree, [bx0 - 0.002, by0 - 0.002, -hT - rel - 0.002], [bx1 + 0.002, by1 + 0.002, hT + rel + 0.002], o.res || 0.0005), P = m.pos;
  // pearls all round the contour, one every pearl diameter + gap, sunk a little into the rim
  var PR = o.pearls || {}, pr = PR.r || 0.0016, step = 2 * pr + (PR.gap != null ? PR.gap : 0.0006), off = PR.offset || 0, pts = [], rims = [], acc = 0, next = 0;   // offset: pearls stand off the edge on short stalks
  if (PR.r !== 0) for (i = 0; i < ring.length; i++) { var A2 = ring[i], B2 = ring[(i + 1) % ring.length], l = Math.hypot(B2[0] - A2[0], B2[1] - A2[1]); if (l < 1e-12) continue;
    while (next <= acc + l) { var t = (next - acc) / l, x = A2[0] + (B2[0] - A2[0]) * t, y = A2[1] + (B2[1] - A2[1]) * t, gx = d2(x + 1e-4, y) - d2(x - 1e-4, y), gy = d2(x, y + 1e-4) - d2(x, y - 1e-4), gl = Math.hypot(gx, gy) || 1; var cx2 = x + gx / gl * (pr * 0.3 + off), cy2 = y + gy / gl * (pr * 0.3 + off), mid = d2(x + gx / gl * off * 0.5, y + gy / gl * off * 0.5);
      if (!off || (d2(cx2, cy2) > (pr * 0.3 + off) * 0.85 && mid > off * 0.4)) { pts.push([cx2, cy2, 0]); rims.push([x - gx / gl * 0.0014, y - gy / gl * 0.0014, 0]); }   // (standing off: only where nothing else of the piece is in the way, e.g. not in a tight notch)
      next += step; } acc += l; }
  var W = [], i3; for (i3 = 0; i3 < P.length; i3 += 3) W.push(toW([P[i3], P[i3 + 1], P[i3 + 2]])); var WP = pts.map(toW), WR = rims.map(toW);
  if (o.seat !== false && HF) {   // seated: along the piece's normal until its closest point just clears the hair strands
    var mind = 1e9; W.forEach(function (q) { mind = min(mind, HF(q[0], q[1], q[2], 1)); }); WP.forEach(function (q) { mind = min(mind, HF(q[0], q[1], q[2], 1) - pr); });
    var sh = mul(toW.w, 0.0034 - mind); W = W.map(function (q) { return add(q, sh); }); WP = WP.map(function (q) { return add(q, sh); }); WR = WR.map(function (q) { return add(q, sh); }); }
  [false].concat(o.mirror ? [true] : []).forEach(function (mir) {   // mirrored to the other side (about the head's mid-plane), winding flipped
    var X = function (q) { return mir ? [2 * O[0] - q[0], q[1], q[2]] : q; }, pos = new Float32Array(P.length), idx = new Uint32Array(m.idx);
    W.forEach(function (q, k) { q = X(q); pos[k * 3] = q[0]; pos[k * 3 + 1] = q[1]; pos[k * 3 + 2] = q[2]; });
    if (mir) for (var k = 0; k < idx.length; k += 3) { var tmp = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = tmp; }
    var nm = name + (mir ? 'M' : ''), mat = { jade: 'jadeSpray', gold: 'gold', horn: 'ivory' }[o.material || 'jade'] || 'jadeSpray';
    part(nm, 'hairCap', { pos: pos, idx: idx, nrm: vertexNormals(pos, idx), uv: new Float32Array(pos.length / 3 * 4), bone: bone, mat: mat }, { parents: ['hairCap', 'hairStrands'] });
    var stalks = off > 0.0002 && WP.length;
    if (stalks) { var sm = new Mesh(); WP.forEach(function (q, k) { tube(sm, [X(WR[k]), X(q)], [PR.stalkR || 0.00035, PR.stalkR || 0.00035], 5); }); part(nm + 'Stalks', nm, sm.out(bone, PR.stalk === 'thread' ? 'thread' : 'gold'), { perComponent: true, parents: [nm, nm + 'Pearls'] }); }   // (each stalk runs from inside the rim into its pearl)   // gold wire or silk thread
    if (WP.length) { var pm = new Mesh(); WP.forEach(function (q) { sphere(pm, X(q), pr, 6); }); part(nm + 'Pearls', stalks ? nm + 'Stalks' : nm, pm.out(bone, 'pearl'), { perComponent: true }); }
  });
}
/* ================= performance: lip-sync + choreography =================
   perform(song, syls, opts) → { controls(t) → pose controls, camera(t), dur, ... }. Stateless in t (smoothing is a
   short Gaussian over keyed channels; everything slower is precomputed on a grid) so any frame can be evaluated
   directly (screenshots, checker).
   Motion, in layers: key poses from a small 軟舞 vocabulary are placed on the phrase grid (anticipating each phrase,
   settling into a bow at cadences) → a C1 spline through them, sampled and Gaussian-smoothed (continuous acceleration)
   → overlapping action: each arm reads the spline with growing delays (shoulder, elbow, wrist, fingers), the second
   arm trails the leading one (which alternates per phrase), the head leads and the chest lags → follow-through (the
   wrist bends against the arm's motion), sleeve flicks at phrase ends, slow independent noise on every joint and
   finger → weight shifts every two beats (hip roll, S-curved spine, the free knee softens), breathing with inhales
   before phrases, a lift on high notes and a settle at cadences → soft joint limits → self-collision avoidance
   (body capsules; solved on a 30 Hz grid with warm starts and smoothed). */
var VOW = { i: [0.12, 0, 0.85], y: [0.13, 0.85, 0], 'ɨ': [0.16, 0, 0.25], u: [0.15, 1, 0], e: [0.3, 0, 0.55], 'ɛ': [0.42, 0, 0.35], 'æ': [0.56, 0, 0.25],
  a: [0.72, 0, 0.05], 'ɑ': [0.7, 0.12, 0], 'ə': [0.34, 0, 0.05], 'ɐ': [0.5, 0, 0.05], 'ʌ': [0.45, 0.05, 0], o: [0.42, 0.72, 0], 'ɔ': [0.55, 0.45, 0] };   // [jaw, round, spread]
function parseIPA(ipa) {
  var s = ipa.replace(/[˥˦˧˨˩₀-₉ˀ]/g, ''), r = { ini: '', glide: '', vow: 'ə', coda: '' };
  var m = s.match(/(p̚|t̚|k̚|i̯|u̯|m|n|ŋ)$/); if (m) { r.coda = m[1].replace('̚', ''); s = s.slice(0, -m[1].length); }
  var vi = -1; for (var i = s.length - 1; i >= 0; i--) if (VOW[s[i]]) { vi = i; break; }
  if (vi < 0) return r;
  r.vow = s[vi]; var pre = s.slice(0, vi), g = pre.match(/[jwɥɨ]+$/); if (g) { r.glide = g[0]; pre = pre.slice(0, -g[0].length); }
  r.ini = pre.replace(/ʰ/g, 'h');
  return r;
}
function iniShape(ini) {   // [jaw, round, spread, press, tongue]
  if (!ini) return [0.2, 0, 0, 0, 0];
  var c = ini[0];
  if (/[pbm]/.test(c)) return [0.03, 0, 0, 1, 0];
  if (/[fv]/.test(c)) return [0.08, 0, 0.1, 0.7, 0];
  if (/[tdnlʈɖɳszʂʐɕʑ]/.test(c) || /^t[sɕʂ]/.test(ini)) return [0.12, 0, 0.25, 0, 1];
  if (/[j]/.test(c)) return [0.12, 0, 0.6, 0, 0.5];
  if (/[w]/.test(c)) return [0.12, 0.8, 0, 0, 0];
  return [0.2, 0, 0.05, 0, 0];   // k g ŋ ʔ x ɣ h
}
function codaShape(c) {
  if (c === 'm' || c === 'p') return [0.03, 0, 0, 1, 0];
  if (c === 'n' || c === 't') return [0.13, 0, 0.2, 0, 1];
  if (c === 'ŋ' || c === 'k') return [0.2, 0, 0.05, 0, 0];
  if (c === 'i̯') return [0.13, 0, 0.7, 0, 0.3];
  if (c === 'u̯') return [0.14, 0.85, 0, 0, 0];
  return null;
}
function Track() { this.k = []; }
Track.prototype.key = function (t, v) { this.k.push([t, v]); };
Track.prototype.done = function () { this.k.sort(function (a, b) { return a[0] - b[0]; }); return this; };
Track.prototype.lin = function (t) {
  var k = this.k, n = k.length; if (!n) return 0; if (t <= k[0][0]) return k[0][1]; if (t >= k[n - 1][0]) return k[n - 1][1];
  var lo = 0, hi = n - 1; while (hi - lo > 1) { var m = (lo + hi) >> 1; if (k[m][0] <= t) lo = m; else hi = m; }
  var a = k[lo], b = k[hi], u = (t - a[0]) / max(b[0] - a[0], 1e-6); return a[1] + (b[1] - a[1]) * u;
};
Track.prototype.at = function (t, sig) { var s = 0, w = 0; for (var i = -3; i <= 3; i++) { var g = exp(-i * i / 4.5); s += g * this.lin(t + i * sig / 1.5); w += g; } return s / w; };

/* ---- dance vocabulary: slow Tang 軟舞 (綠腰 / 霓裳-like) key poses. Arm values are the left-side controls (solve()
   mirrors the math for the right); spine/chest/head are [pitch, yaw, roll]. Moderate ranges, elbows never straight. */
function A(raise, fwd, twist, elbow, pron, wflex, wdev, hand) { var H = HANDS[hand || 'relax']; return { raise: raise, fwd: fwd, twist: twist, elbow: elbow, pron: pron, wflex: wflex, wdev: wdev, clav: 0, fing: H.f.slice(), spread: H.spread, thumb: H.thumb }; }
// hand shapes: graded flexion (index least, pinky most), thumb opposition; [index, middle, ring, pinky, thumb]
var HANDS = { relax: { f: [0.16, 0.27, 0.36, 0.46, 0.3], spread: 0.12, thumb: 0.45 }, soft: { f: [0.24, 0.34, 0.42, 0.52, 0.35], spread: 0.08, thumb: 0.5 },
  open: { f: [0.04, 0.07, 0.11, 0.16, 0.02], spread: 0.45, thumb: 0.05 }, orchid: { f: [0.06, 0.95, 0.28, 0.1, 0.72], spread: 0.25, thumb: 0.75 },   // 蘭花指
  hold: { f: [0.75, 0.88, 0.95, 1.0, 0.55], spread: 0.0, thumb: 0.6 } };   // holding the sleeve edge
var POSES = {
  // before the song: arms hang relaxed, hands meet loosely in front of the lower belly, the right resting over the left
  rest:    { L: A(0.4, 0.55, 1.0, 1.45, 1.0, 0.1, 0.15, 'relax'), R: A(0.4, 0.57, 1.0, 1.5, 1.0, 0.1, 0.15, 'relax'), spine: [0.02, 0, 0], chest: [0, 0, 0], head: [0.04, 0, 0.02], yaw: 0 },
  stand:   { L: A(0.45, 0.22, 0.4, 0.62, 0.3, 0.1, 0, 'relax'), R: A(0.45, 0.2, 0.4, 0.66, 0.3, 0.12, 0, 'relax'), spine: [0.02, 0, 0], chest: [0, 0, 0], head: [0.03, 0, 0], yaw: 0 },
  fold:    { L: A(0.48, 0.42, 0.5, 0.9, 0.6, 0.25, 0.05, 'soft'), R: A(0.48, 0.4, 0.48, 0.93, 0.6, 0.28, 0.05, 'soft'), spine: [0.04, 0, 0], chest: [0.02, 0, 0], head: [0.06, 0, 0.03], yaw: 0 },
  offerL:  { L: A(0.5, 0.75, -0.1, 0.6, -0.2, -0.2, 0, 'open'), R: A(0.45, 0.15, 0.3, 0.5, 0.3, 0.12, 0, 'relax'), spine: [0, 0.1, 0.03], chest: [0, 0.05, 0], head: [-0.03, 0.16, -0.04], yaw: 0.12 },
  liftL:   { L: A(1.1, 0.45, -0.6, 0.8, 0.8, -0.35, 0, 'open'), R: A(0.45, 0.35, 0.6, 1.1, 0.5, 0.15, 0, 'soft'), spine: [-0.03, 0.06, 0.05], chest: [-0.02, 0.04, 0.02], head: [-0.07, 0.12, -0.06], yaw: 0.1 },
  orchidL: { L: A(0.45, 0.55, 0.5, 1.7, 0.4, -0.25, 0.1, 'orchid'), R: A(0.45, 0.15, 0.3, 0.55, 0.3, 0.14, 0, 'relax'), spine: [0.02, -0.08, -0.03], chest: [0, -0.04, 0], head: [0.05, -0.1, 0.08], yaw: -0.08 },
  spread:  { L: A(0.7, 0.25, -0.2, 0.45, 0.9, -0.2, 0, 'open'), R: A(0.66, 0.28, -0.2, 0.48, 0.9, -0.2, 0, 'open'), spine: [-0.03, 0, 0], chest: [-0.02, 0, 0], head: [-0.06, 0, 0], yaw: 0 },
  sweepL:  { L: A(0.75, -0.2, 0, 0.45, 0.6, -0.3, 0, 'open'), R: A(0.45, 0.6, 0.8, 1.1, 0.6, 0.05, 0, 'soft'), spine: [0, 0.16, 0.05], chest: [0, 0.08, 0.02], head: [-0.04, 0.24, -0.05], yaw: 0.3 },
  bow:     { L: A(0.48, 0.45, 0.5, 0.88, 0.6, 0.28, 0.05, 'soft'), R: A(0.48, 0.43, 0.48, 0.9, 0.6, 0.3, 0.05, 'soft'), spine: [0.13, 0, 0], chest: [0.06, 0, 0], head: [0.12, 0, 0], yaw: 0 }
};
function mirrorPose(P) { var f = function (e) { return [e[0], -e[1], -e[2]]; }; return { L: JSON.parse(JSON.stringify(P.R)), R: JSON.parse(JSON.stringify(P.L)), spine: f(P.spine), chest: f(P.chest), head: f(P.head), yaw: -P.yaw }; }
['offerL', 'liftL', 'orchidL', 'sweepL'].forEach(function (k) { POSES[k.replace(/L$/, 'R')] = mirrorPose(POSES[k]); });
// phrase motifs: [first, second] pose of a sung phrase (alternating sides, never symmetric in time)
var MOTIFS = [['offerL', 'spread', 'orchidR'], ['liftR', 'orchidL', 'offerL'], ['orchidR', 'sweepL', 'fold'], ['spread', 'liftL', 'orchidR'], ['offerR', 'orchidR', 'liftL'], ['sweepR', 'offerL', 'orchidL'], ['liftL', 'fold', 'offerR'], ['orchidL', 'offerR', 'spread']];
/* Song (宋) vocabulary: court and entertainment dance (隊舞, 大曲) was more restrained and ceremonial than the Tang 軟舞 —
   upright, smaller gestures kept near the body (the hands rarely above the shoulder), the hands often folded in front
   (叉手 / hands in the sleeves), gentle turns of the head and body. Same key-pose machinery and layers as the Tang set. */
var POSES_SONG = {
  rest:    POSES.rest, fold: POSES.fold,   // (the narrow sleeves fold at the inner elbow: Song keeps the elbows below ~1.35 rad in its own poses)
  cha:     { L: A(0.44, 0.72, 0.75, 1.32, 0.95, 0.18, 0.05, 'soft'), R: A(0.44, 0.74, 0.75, 1.36, 0.95, 0.18, 0.05, 'soft'), spine: [0.02, 0, 0], chest: [0.01, 0, 0], head: [0.04, 0, 0.02], yaw: 0 },   // hands folded at the chest (叉手)
  offerL:  { L: A(0.5, 0.62, 0.15, 0.95, 0.1, -0.12, 0, 'soft'), R: A(0.44, 0.45, 0.6, 1.25, 0.6, 0.12, 0.05, 'soft'), spine: [0.01, 0.06, 0.02], chest: [0, 0.03, 0], head: [0.0, 0.1, -0.03], yaw: 0.08 },
  liftL:   { L: A(0.82, 0.55, -0.35, 1.05, 0.7, -0.25, 0, 'open'), R: A(0.44, 0.45, 0.6, 1.3, 0.6, 0.12, 0.05, 'soft'), spine: [-0.01, 0.04, 0.03], chest: [-0.01, 0.03, 0.01], head: [-0.04, 0.08, -0.04], yaw: 0.06 },
  orchidL: { L: A(0.45, 0.62, 0.5, 1.35, 0.4, -0.2, 0.1, 'orchid'), R: A(0.44, 0.4, 0.55, 1.2, 0.5, 0.12, 0.05, 'soft'), spine: [0.02, -0.05, -0.02], chest: [0, -0.03, 0], head: [0.04, -0.07, 0.05], yaw: -0.05 },
  spread:  { L: A(0.58, 0.35, -0.1, 0.7, 0.8, -0.15, 0, 'soft'), R: A(0.56, 0.37, -0.1, 0.72, 0.8, -0.15, 0, 'soft'), spine: [-0.01, 0, 0], chest: [-0.01, 0, 0], head: [-0.03, 0, 0], yaw: 0 },
  sweepL:  { L: A(0.6, 0.05, 0.1, 0.65, 0.6, -0.2, 0, 'soft'), R: A(0.45, 0.6, 0.7, 1.35, 0.7, 0.08, 0.05, 'soft'), spine: [0, 0.1, 0.03], chest: [0, 0.05, 0.01], head: [-0.02, 0.15, -0.03], yaw: 0.2 },
  bow:     { L: A(0.46, 0.55, 0.6, 1.3, 0.8, 0.2, 0.05, 'soft'), R: A(0.46, 0.53, 0.6, 1.34, 0.8, 0.2, 0.05, 'soft'), spine: [0.09, 0, 0], chest: [0.04, 0, 0], head: [0.09, 0, 0], yaw: 0 }
};
['offerL', 'liftL', 'orchidL', 'sweepL'].forEach(function (k) { POSES_SONG[k.replace(/L$/, 'R')] = mirrorPose(POSES_SONG[k]); });
var MOTIFS_SONG = [['offerL', 'cha', 'orchidR'], ['orchidL', 'offerR', 'fold'], ['cha', 'liftR', 'offerL'], ['offerR', 'spread', 'cha'], ['orchidR', 'fold', 'liftL'], ['sweepL', 'cha', 'offerR'], ['fold', 'orchidL', 'offerR'], ['liftL', 'cha', 'orchidR']];
// joint limits (all joints): [min, max] per arm control; spine-ish limits on [pitch, yaw, roll]
var LIM = { raise: [0.4, 1.25],   // below ~0.4 rad the inner arm sinks into the chest at the armpit (skinning), leaving no room for cloth
  fwd: [-0.35, 1.15], twist: [-0.6, 1.0], elbow: [0.25, 1.9], pron: [-0.3, 1.6], wflex: [-0.75, 0.6], wdev: [-0.3, 0.3], spread: [0, 0.6], thumb: [0, 0.9], fing: [0, 1.25] };
var LIMT = [[-0.12, 0.2], [-0.45, 0.45], [-0.12, 0.12]];
// weighted sum of control objects (numbers, arrays, nested objects)
function wsum(objs, ws) {
  var a = objs[0];
  if (typeof a === 'number') { var s2 = 0; for (var i = 0; i < objs.length; i++) s2 += objs[i] * ws[i]; return s2; }
  if (Array.isArray(a)) return a.map(function (_, j) { return wsum(objs.map(function (o) { return o[j]; }), ws); });
  var o = {}; for (var k in a) o[k] = typeof a[k] === 'string' ? a[k] : wsum(objs.map(function (q) { return q[k]; }), ws); return o;
}
function blendCtl(a, b, t) { return wsum([a, b], [1 - t, t]); }
// C1 spline through keyed poses: cubic Hermite with Catmull-Rom tangents (tension), no stops at the keys
function KeySpline(keys, tension) {
  var n = keys.length, T = keys.map(function (k) { return k.t; });
  return function (t) {
    if (t <= T[0]) return keys[0].v; if (t >= T[n - 1]) return keys[n - 1].v;
    var i = 0, lo = 0, hi = n - 1; while (hi - lo > 1) { var m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; } i = lo;
    var t0 = T[i], t1 = T[i + 1], h = t1 - t0, u = (t - t0) / h, u2 = u * u, u3 = u2 * u;
    var h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    var ip = max(i - 1, 0), inn = min(i + 2, n - 1), k0 = tension * h / max(T[i + 1] - T[ip], 1e-6), k1 = tension * h / max(T[inn] - T[i], 1e-6);
    // value = h00 P_i + h01 P_{i+1} + h10 k0 (P_{i+1} - P_{i-1}) + h11 k1 (P_{i+2} - P_i)
    var objs = [keys[ip].v, keys[i].v, keys[i + 1].v, keys[inn].v], w = [-h10 * k0, h00 - h11 * k1, h01 + h10 * k0, h11 * k1];
    return wsum(objs, w);
  };
}
/* ---- body capsules (fitted to this figure's bind-pose surface) for limb–limb / limb–torso avoidance and checks ---- */
function buildCapsules(sk, body) {
  var F = body.sdf, B = sk.bones, by = sk.by, caps = [];
  function radiusAt(p, axis) {   // mean distance from p to the surface perpendicular to axis
    var t0 = perpOf(axis), t1 = cross(axis, t0), s = 0, n = 0;
    for (var k = 0; k < 8; k++) { var a = k * PI / 4, d = add(mul(t0, cos(a)), mul(t1, sin(a))), r = 0; while (r < 0.2 && F(p[0] + d[0] * r, p[1] + d[1] * r, p[2] + d[2] * r, 1) < 0) r += 0.002; s += r; n++; }
    return s / n;
  }
  function limb(name, b0, b1, shrink, from) { var a = B[by[b0]].p, b = B[by[b1]].p, ax = norm(sub(b, a)), r = min(radiusAt(lerp3(a, b, 0.4), ax), radiusAt(lerp3(a, b, 0.75), ax)) * (shrink || 0.9);
    caps.push({ name: name, bone: by[b0], a: lerp3(a, b, from || 0.06), b: lerp3(a, b, 0.94), r: r }); }
  ['L', 'R'].forEach(function (S) {
    limb('upper' + S, 'arm' + S, 'fore' + S, 0.9, 0.2);   // the shoulder end is attached to the torso: only the lower part counts
    limb('fore' + S, 'fore' + S, 'hand' + S);
    var h = B[by['hand' + S]].p, m = B[by['middle2' + S]].p; caps.push({ name: 'hand' + S, bone: by['hand' + S], a: lerp3(h, m, 0.25), b: m, r: 0.016 });
    limb('thigh' + S, 'thigh' + S, 'shin' + S, 0.85, 0.15);
  });
  // torso: a stadium cross-section (two side capsules + a centre one) per slab, fitted to rays ±x / ±z, carried by the spine bones
  var lv = [[0.9, 'root'], [1.0, 'spine'], [1.1, 'spine2'], [1.2, 'chest'], [1.33, 'chest']], hxPrev = 1;
  lv.forEach(function (L, i) {
    if (i === lv.length - 1) return;
    var y0 = L[0], y1 = lv[i + 1][0], ym = (y0 + y1) / 2, ray = function (th) { return surfaceRay(F, ym, th, [0, -0.01]); };
    var fr = ray(0)[2], bk = ray(PI)[2], cz = (fr + bk) / 2, r = (fr - bk) / 2, hx = min(ray(PI / 2)[0], -ray(-PI / 2)[0]);
    if (y1 > 1.25) hx = min(hx, hxPrev); hxPrev = hx;   // the ±x rays at shoulder height would run into the shoulders
    r = min(r, hx); var ox = max(hx - r, 0);
    [-1, 0, 1].forEach(function (sd) { caps.push({ name: 'torso' + i + (sd < 0 ? 'R' : sd > 0 ? 'L' : 'C'), bone: by[L[1]], a: [sd * ox, y0, cz], b: [sd * ox, y1, cz], r: r, torso: true }); });
  });
  // bust: a sphere per side at the most protruding point of the front sector (the stadium slabs are too narrow there)
  var best = [0, 0, 0];
  for (var y = 1.04; y <= 1.3; y += 0.01) for (var th = 0.15; th <= 1.1; th += 0.05) { var q = surfaceRay(F, y, th, [0, -0.01]), rr = Math.hypot(q[0], q[2] + 0.01); if (rr > best[0]) best = [rr, y, th]; }
  var rb = 0.05; ['L', 'R'].forEach(function (S2, k) { var th2 = best[2] * (k ? -1 : 1), cpt = [sin(th2) * (best[0] - rb), best[1], -0.01 + cos(th2) * (best[0] - rb)];
    caps.push({ name: 'bust' + S2, bone: by.spine2, a: cpt, b: cpt, r: rb, torso: true }); });
  var hc = sk.hl(0, -0.01, 0.0); caps.push({ name: 'head', bone: by.head, a: hc, b: hc, r: 0.085 });
  return caps;
}
function poseCaps(caps, sk, W) { return caps.map(function (c) { var b = sk.bones[c.bone], q = W.q[c.bone], P = W.p[c.bone], tf = function (x) { return add(P, qrot(q, sub(x, b.p))); }; return { name: c.name, a: tf(c.a), b: tf(c.b), r: c.r, torso: c.torso }; }); }
function segDist(a0, a1, b0, b1) {   // closest distance between two segments
  var d1 = sub(a1, a0), d2 = sub(b1, b0), r = sub(a0, b0), a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r), s, t;
  if (a < 1e-12 && e < 1e-12) return len(r);
  if (a < 1e-12) { s = 0; t = clamp(f / e, 0, 1); }
  else { var c = dot(d1, r); if (e < 1e-12) { t = 0; s = clamp(-c / a, 0, 1); } else { var b = dot(d1, d2), den = a * e - b * b; s = den > 1e-12 ? clamp((b * f - c * e) / den, 0, 1) : 0; t = (b * s + f) / e; if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); } } }
  return len(sub(add(a0, mul(d1, s)), add(b0, mul(d2, t))));
}
// smooth clamp: identity well inside [a, b], C∞ saturation within ~0.05 rad of the limits
function smaxk(x, y, k) { return 0.5 * (x + y + sqrt((x - y) * (x - y) + k * k)); }
function softClamp(x, a, b) { var k = 0.08; return -smaxk(-smaxk(x, a, k), -b, k); }
// sample a vector function of t on a grid (0 … t1, hz) and smooth it with a Gaussian (σ seconds); evaluated with Catmull-Rom
function Sampled(fn, t1, hz, sigma) {
  var N = ceil(t1 * hz) + 3, rows = [], n0 = 0, r = ceil(3 * sigma * hz);
  for (var i = 0; i < N; i++) rows.push(fn(i / hz)); n0 = rows[0].length;
  var ch = []; for (var k = 0; k < n0; k++) { var A2 = new Float32Array(N); for (i = 0; i < N; i++) { var s2 = 0, w = 0; for (var d = -r; d <= r; d++) { var g = exp(-sq(d / (sigma * hz)) / 2); s2 += g * rows[clamp(i + d, 0, N - 1)][k]; w += g; } A2[i] = s2 / w; } ch.push(A2); }
  return function (t) { var u = t * hz, i0 = floor(u), f = u - i0, out = new Array(n0); for (var k2 = 0; k2 < n0; k2++) out[k2] = crInterp(ch[k2], i0, f); return out; };
}
function flatten(o, out) { if (typeof o === 'number') out.push(o); else if (Array.isArray(o)) o.forEach(function (x) { flatten(x, out); }); else for (var k in o) if (typeof o[k] !== 'string') flatten(o[k], out); return out; }
function unflatten(tpl, v, c) {
  if (typeof tpl === 'number') return v[c.i++];
  if (Array.isArray(tpl)) return tpl.map(function (x) { return unflatten(x, v, c); });
  var o = {}; for (var k in tpl) o[k] = typeof tpl[k] === 'string' ? tpl[k] : unflatten(tpl[k], v, c); return o;
}
function crInterp(a, i, f) {   // Catmull-Rom on a sampled array
  var n = a.length, p0 = a[clamp(i - 1, 0, n - 1)], p1 = a[clamp(i, 0, n - 1)], p2 = a[clamp(i + 1, 0, n - 1)], p3 = a[clamp(i + 2, 0, n - 1)];
  return 0.5 * (2 * p1 + (p2 - p0) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (3 * p1 - p0 - 3 * p2 + p3) * f * f * f);
}
function capDist(A, B) { return segDist(A.a, A.b, B.a, B.b) - A.r - B.r; }
// clearance wanted between pairs (room for the cloth layers between arm and body)
var CLEAR = { torso: 0.014, forearm: 0.045, thigh: 0.014, limb: 0.012, hands: 0.008, head: 0.01 };   // forearm / hand ↔ torso: room for the dress layers
var AVOID = [];   // [capA, capB, clearance]
['L', 'R'].forEach(function (S) {
  var O2 = S === 'L' ? 'R' : 'L';
  ['upper', 'fore', 'hand'].forEach(function (p) { AVOID.push([p + S, 'torso', p === 'upper' ? CLEAR.torso : CLEAR.forearm]); AVOID.push([p + S, 'thigh' + S, CLEAR.thigh]); AVOID.push([p + S, 'thigh' + O2, CLEAR.thigh]); if (p !== 'upper') AVOID.push([p + S, 'head', CLEAR.head]); });
});
AVOID.push(['foreL', 'foreR', CLEAR.limb], ['foreL', 'handR', CLEAR.limb], ['handL', 'foreR', CLEAR.limb], ['handL', 'handR', CLEAR.hands], ['upperL', 'foreR', CLEAR.limb], ['foreL', 'upperR', CLEAR.limb]);
function penalty(cp, side) {
  var by = {}, P = 0; cp.forEach(function (c) { by[c.name] = c; });
  AVOID.forEach(function (q) {
    if (side && q[0].slice(-1) !== side && (q[1].slice(-1) !== side || q[1] === 'torso')) return;
    var A2 = by[q[0]], list = q[1] === 'torso' ? cp.filter(function (c) { return c.torso; }) : [by[q[1]]];
    list.forEach(function (B2) { var d = capDist(A2, B2) - q[2]; if (d < 0) P += d * d; });
  });
  return P;
}
// resolve limb collisions by adjusting each arm's raise / fwd / elbow / twist (continuous Gauss-Newton steps on a penalty)
function avoidSelf(sk, caps, c) {   // both arms together (symmetric problems get symmetric answers)
  var keys = [], wt = { raise: 1, fwd: 1, elbow: 0.6, twist: 0.5 };   // prefer moving the shoulder over the elbow / twist
  ['L', 'R'].forEach(function (S) { ['raise', 'fwd', 'elbow', 'twist'].forEach(function (k) { keys.push([c['arm' + S], k]); }); });
  for (var it = 0; it < 8; it++) {
    var P0 = penalty(poseCaps(caps, sk, solve(sk, c))); if (P0 <= 0) break;
    var g = keys.map(function (q) { var o = q[0][q[1]]; q[0][q[1]] = o + 0.004; var P1 = penalty(poseCaps(caps, sk, solve(sk, c))); q[0][q[1]] = o; return wt[q[1]] * (P1 - P0) / 0.004; });
    var gg = g.reduce(function (a, x) { return a + x * x; }, 0), st = min(P0 / (gg + 1e-7), 0.12 / sqrt(gg + 1e-12));   // Gauss-Newton step, at most 0.12 rad
    keys.forEach(function (q, i) { q[0][q[1]] = clamp(q[0][q[1]] - wt[q[1]] * g[i] * st, LIM[q[1]][0], LIM[q[1]][1]); });
  }
  return c;
}
function perform(song, syls, o) {
  o = o || {};
  var R = rng((o.seed || 1) * 7919 + 13), spb = 60 / song.tempo, t0 = syls[0].on - syls[0].on % 1e-9;
  // map syllables → phrases (syls are in phrase order)
  var phr = [], k = 0;
  song.phrases.forEach(function (ph, i) { var n = ph.syl.length, ss = syls.slice(k, k + n); k += n; if (!ss.length) return; phr.push({ i: i, a: ss[0].t0, b: ss[ss.length - 1].off, end: ph.end, syls: ss, notes: ph.notes }); });
  var dur = syls[syls.length - 1].off + 3.5, beat0 = syls[0].on;
  // --- mouth channels ---
  var ch = {}; ['jaw', 'round', 'spread', 'press', 'tongue', 'brow', 'smile'].forEach(function (c) { ch[c] = new Track(); });
  function put(t, v) { ch.jaw.key(t, v[0]); ch.round.key(t, v[1]); ch.spread.key(t, v[2]); ch.press.key(t, v[3]); ch.tongue.key(t, v[4]); }
  var REST = [0.02, 0, 0.05, 0.6, 0];
  put(0, REST);
  syls.forEach(function (y, i) {
    var P = parseIPA(y.ipa || ''), V = VOW[P.vow] || VOW['ə'], hiN = clamp(((y.notes[0] || 69) - 67) / 10, -0.5, 1), open = 1 + 0.35 * hiN;
    var vow = [min(0.95, V[0] * open + 0.05), V[1], V[2], 0, 0], ini = iniShape(P.ini), cd = codaShape(P.coda), gl = P.glide;
    var prevOff = i ? syls[i - 1].off : -1;
    if (y.t0 - prevOff > 0.25) put(y.t0 - 0.12, REST);   // rest before a fresh onset
    put(y.t0 + 0.01, ini); put(y.on - 0.015, ini);
    if (gl) { var gs = /[jɥ]/.test(gl) ? [0.13, gl === 'ɥ' ? 0.6 : 0, gl === 'ɥ' ? 0.2 : 0.7, 0, 0.2] : gl === 'w' ? [0.13, 0.8, 0, 0, 0] : [0.16, 0, 0.2, 0, 0]; put(y.on + 0.025, gs); put(y.on + 0.09, vow); }
    else put(y.on + 0.05, vow);
    var cdT = cd ? min(0.12, (y.off - y.on) * 0.35) : 0;
    put(y.off - cdT - 0.02, vow);
    if (cd) put(y.off - 0.02, cd);
    var nx = syls[i + 1];
    if (!nx || nx.t0 - y.off > 0.25) { put(y.off + 0.12, [0.05, 0, 0.1, 0.3, 0]); put(y.off + 0.4, REST); }
    // brows lift a little on high notes; a soft smile as phrases close
    ch.brow.key(y.on, 0.35 * max(hiN, 0)); ch.brow.key(y.off, 0.3 * max(hiN, 0));
  });
  phr.forEach(function (p) { ch.smile.key(p.a, 0); ch.smile.key(p.b - 0.3, 0.05); ch.smile.key(p.b + 0.6, p.end === '。' ? 0.35 : 0.2); ch.smile.key(p.b + 2.2, 0.08); });
  for (var c in ch) ch[c].done();
  // inhales before phrases that follow a pause
  var inh = phr.filter(function (p, i) { return !i || p.a - phr[i - 1].b > 0.6; }).map(function (p) { return p.a - 0.45; });
  // blinks
  var blinks = [], tb = 1.2; while (tb < dur) { blinks.push(tb); tb += 2.2 + R() * 3.8; }
  phr.forEach(function (p) { if (R() < 0.5) blinks.push(p.a - 0.25); }); blinks.sort(function (a, b) { return a - b; });
  // saccades: gaze targets change every 0.6–2.5 s
  var sac = [], ts = 0; while (ts < dur) { sac.push([ts, (R() - 0.5) * 0.12, (R() - 0.5) * 0.06]); ts += 0.6 + R() * 1.9; }
  // --- choreography: key poses on the phrase grid (anticipating the voice a little), cadences settle into a bow ---
  var song = o.style === 'song', PS = song ? POSES_SONG : POSES, MF = song ? MOTIFS_SONG : MOTIFS;   // (Song: a smaller, more upright vocabulary)
  var keys = [], side = (o.seed || 1) % 2 ? 1 : -1, a0 = phr[0].a;
  function key(t, name, yaw, step) { var P = JSON.parse(JSON.stringify(PS[name])); P.yaw = (yaw || 0) + P.yaw; P.step = step || [0, 0]; keys.push({ t: t, v: P, name: name }); }
  // intro: relaxed rest (hands loosely together), fold the hands, a small greeting bow, then a slow turn with a sleeve sweep and a step
  key(0, 'rest');
  if (a0 >= 6) { key(min(2.5, a0 * 0.25), 'rest'); key(a0 * 0.45, 'fold', -0.05); key(a0 * 0.6, 'bow'); key(a0 * 0.8, side > 0 ? 'sweepL' : 'sweepR', 0.3 * side, [0.02 * side, 0.01]); }   // (a short or no prelude: straight from rest into the first phrase)
  phr.forEach(function (p, i) {
    var m = MF[(i + (o.seed || 1)) % MF.length], len = p.b - p.a, yaw = (R() - 0.5) * (song ? 0.2 : 0.3), st = (i % 2 ? -1 : 1) * 0.018;
    key(p.a - 0.4, m[0], yaw, [st * 0.5, 0]);
    if (len > 5.5) { key(p.a + len * 0.38, m[1], -yaw * 0.6, [st, 0.008]); key(p.a + len * 0.74, m[2], yaw * 0.4, [st * 0.5, 0]); }
    else if (len > 3) key(p.a + len * 0.55, m[1], -yaw * 0.6, [st, 0]);
    var nx = phr[i + 1], gap = nx ? nx.a - p.b : 99;
    if (nx && gap > 1.6) key(p.b + 0.5, p.end === '。' ? 'bow' : 'fold', yaw * 0.3);
    if (nx && gap > 4) {   // interlude: a slow turn with a sleeve sweep and a small step
      side = -side; var mid = (p.b + nx.a) / 2;
      key(mid, side > 0 ? 'sweepL' : 'sweepR', side * 0.45, [side * 0.03, 0.012]);
    }
  });
  var last = phr[phr.length - 1]; key(last.b + 0.6, 'bow', 0); key(last.b + 2.2, 'fold', 0); key(dur, 'rest', 0);
  keys.sort(function (a, b) { return a.t - b.t; });
  for (var q = 1; q < keys.length; q++) if (keys[q].t < keys[q - 1].t + 1.2) keys[q].t = keys[q - 1].t + 1.2;   // keys at least 1.2 s apart
  // C1 spline through the keys, then sampled and Gaussian-smoothed (σ 0.12 s) so acceleration stays continuous too
  var SP1 = KeySpline(keys, 0.75), TPL = keys[0].v, SPS = Sampled(function (t) { return flatten(SP1(t), []); }, dur + 1, 30, 0.12);
  function SP(t) { return unflatten(TPL, SPS(t), { i: 0 }); }
  // which arm leads (alternates per phrase); the other follows ~0.22 s later
  var leadT = new Track(); phr.forEach(function (p, i) { leadT.key(p.a - 1.2, i % 2); leadT.key(p.b - 0.2, i % 2); }); leadT.done();
  // flicks of the sleeve at phrase ends: a quick wrist/forearm swing (the cloth does the rest)
  var flicks = phr.filter(function (p, i) { return song ? p.end === '。' && i % 2 : p.end === '。' || i % 2; }).map(function (p, i) { return { t: p.b + 0.15, S: i % 2 ? 'R' : 'L' }; });
  function bump(x) { return x <= 0 || x >= 1 ? 0 : sq(sq(sin(PI * x))); }   // smooth up to the third derivative
  function pos(x) { return 0.5 * (x + sqrt(x * x + 0.01)); }   // smooth max(x, 0)
  // melody, high-note lift, cadence settle and arm lag: sampled and smoothed
  var mel = new Track(); syls.forEach(function (y) { mel.key(y.on, y.notes[0]); mel.key(y.off, y.notes[y.notes.length - 1]); }); mel.done();
  var meanN = syls.reduce(function (a, y) { return a + y.notes[0]; }, 0) / syls.length;
  var liftT = new Track(); liftT.key(0, 0); syls.forEach(function (y) { var v = clamp((y.notes[0] - meanN) / 6, 0, 1); liftT.key(y.on, 0); liftT.key(y.on + min(0.4, (y.off - y.on) / 2), v); liftT.key(y.off, v); liftT.key(y.off + 0.3, 0); }); liftT.done();
  var cadences = phr.filter(function (p) { return p.end === '。'; }).map(function (p) { return p.b; });
  var AUX = Sampled(function (t) { var st = 0; cadences.forEach(function (tc) { st = max(st, bump((t - tc + 0.2) / 2.0)); }); return [mel.lin(t) - meanN, liftT.lin(t), st, smooth(0, 1, leadT.lin(t))]; }, dur + 1, 30, 0.15);
  function noise1(t, ph) { return 0.6 * sin(t * 0.83 + ph) + 0.3 * sin(t * 1.71 + ph * 2.3) + 0.1 * sin(t * 3.1 + ph * 4.1); }   // layered sines, |n| ≤ 1
  var caps = o.fig && o.fig.body && o.fig.body.sdf ? (o.fig.caps || (o.fig.caps = buildCapsules(o.fig.sk, o.fig.body))) : null;
  function armAt(t, S, dl) {   // overlapping action: shoulder, elbow, wrist and fingers follow the key pose with growing lag
    var up = SP(t - 0.16 - dl)[S], fo = SP(t - 0.25 - dl)[S], wr = SP(t - 0.36 - dl)[S], fi = SP(t - 0.45 - dl)[S], pr = SP(t - 0.3 - dl)[S], ph = S === 'L' ? 0 : 2.1;
    var a = { raise: up.raise, fwd: up.fwd, twist: up.twist, clav: 0, elbow: fo.elbow, pron: fo.pron, wflex: wr.wflex, wdev: wr.wdev, fing: fi.fing.slice(), spread: fi.spread, thumb: fi.thumb };
    // follow-through: the hand trails the arm (the wrist bends against the motion), fingers loosen while moving
    var v = (up.raise - pr.raise) / 0.14 + 0.5 * (up.fwd - pr.fwd) / 0.14, av = sqrt(v * v + 0.01) - 0.1;
    a.wflex += -0.22 * v; a.spread += 0.06 * av; a.elbow += 0.05 * av;
    // life: slow independent drift of shoulder, elbow, wrist and each finger
    a.raise += 0.035 * noise1(t, ph); a.fwd += 0.03 * noise1(t * 0.9, ph + 1); a.elbow += 0.05 * noise1(t * 1.1, ph + 2); a.wflex += 0.06 * noise1(t * 1.3, ph + 3); a.pron += 0.05 * noise1(t * 0.7, ph + 4);
    for (var f = 0; f < 5; f++) a.fing[f] += 0.04 * noise1(t * (1.2 + 0.17 * f), ph + 5 + f);
    flicks.forEach(function (fl) { if (fl.S === S) { var b = bump((t - fl.t + 0.6) / 1.0), b2 = bump((t - fl.t + 0.25) / 1.0); a.wflex += -0.45 * b + 0.25 * b2; a.pron -= 0.3 * b; a.elbow -= 0.12 * b; } });
    for (var k in LIM) if (k !== 'fing') a[k] = softClamp(a[k], LIM[k][0], LIM[k][1]);
    a.fing = a.fing.map(function (x) { return softClamp(x, LIM.fing[0], LIM.fing[1]); });
    return a;
  }
  var self = { dur: dur, t0: beat0, spb: spb, phrases: phr, syls: syls, keys: keys };
  self.controls = function (t) {
    var c = defaultControls(), beat = (t - beat0) / spb, X = AUX(t), nt = X[0], lift = X[1], settle = X[2], ld = X[3];
    // weight shift every two beats, contrapposto: hip roll, opposite shoulder tilt, the free knee softens; an S-curved spine
    var sw = sin(PI * beat / 2) * 0.8 + 0.2 * noise1(t * 0.5, 7), asw = sqrt(sw * sw + 0.01);
    var step = SP(t - 0.05).step;
    c.root = [0.011 * sw + step[0], -0.004 * asw - 0.006 * settle + 0.003 * lift, step[1]];
    c.yaw = SP(t - 0.05).yaw;
    c.hip = [0, 0, 0.032 * sw];
    var sp = SP(t - 0.08), chP = SP(t - 0.14), hd = SP(t + 0.12);   // head leads, chest lags
    c.spine = [sp.spine[0] + 0.02 * settle, sp.spine[1], sp.spine[2] - 0.045 * sw];
    c.chest = [chP.chest[0] - 0.01 * lift, chP.chest[1], chP.chest[2] - 0.02 * sw];
    c.legL = { lift: 0.02 + 0.035 * pos(sw), bend: 0.05 + 0.1 * pos(sw) + 0.06 * settle }; c.legR = { lift: 0.02 + 0.035 * pos(-sw), bend: 0.05 + 0.1 * pos(-sw) + 0.06 * settle };
    c.armL = armAt(t, 'L', 0.22 * ld); c.armR = armAt(t, 'R', 0.22 * (1 - ld));
    // breathing (+ deeper inhales before phrases; the shoulders rise a little)
    var br = 0.5 + 0.5 * sin(t * 2 * PI / 4.2); inh.forEach(function (ti) { br += 1.2 * exp(-sq((t - ti) / 0.25)); }); c.breath = br;
    c.armL.clav = 0.03 * br; c.armR.clav = 0.03 * br;
    // head: leads the turns, follows the melody (higher → chin up), counter-turns toward the audience; never still
    c.head = [hd.head[0] - 0.01 * nt - 0.03 * lift + 0.05 * settle + 0.012 * noise1(t * 0.6, 11), hd.head[1] - 0.45 * hd.yaw + 0.035 * noise1(t * 0.4, 12), hd.head[2] + 0.02 * noise1(t * 0.35, 13) + 0.03 * sw];
    c.neck = [0.02 + 0.02 * settle, -0.2 * hd.yaw, -0.01 * sw];
    for (var j = 0; j < 3; j++) { c.spine[j] = softClamp(c.spine[j], LIMT[j][0], LIMT[j][1]); c.head[j] = softClamp(c.head[j], LIMT[j][0] * 1.4, LIMT[j][1] * 1.4); }
    // face
    var sg = 0.028;
    c.jaw = ch.jaw.at(t, sg); c.lipRound = ch.round.at(t, sg); c.lipSpread = ch.spread.at(t, sg); c.lipPress = ch.press.at(t, sg * 0.8); c.tongue = ch.tongue.at(t, sg);
    var bw = ch.brow.at(t, 0.08); c.browL = bw; c.browR = bw * 0.9; c.smile = ch.smile.at(t, 0.15);
    var bl = 0; for (var j2 = 0; j2 < blinks.length; j2++) { var d = t - blinks[j2]; if (d > -0.1 && d < 0.25) bl = max(bl, d < 0.06 ? smooth(-0.07, 0.05, d) : 1 - smooth(0.06, 0.24, d)); }
    c.blinkL = c.blinkR = bl;
    // eyes lead the head: look where the head will turn, with small saccades
    var sI = 0; while (sI < sac.length - 1 && sac[sI + 1][0] <= t) sI++;
    var sa = sac[sI], spd = smooth(sa[0], sa[0] + 0.05, t), pv = sac[max(sI - 1, 0)], ah = SP(t + 0.3);   // (saccades are meant to be quick)
    c.eyeYaw = mix(pv[1], sa[1], spd) * 0.6 + 0.35 * (ah.head[1] - hd.head[1]) - 0.15 * ah.yaw; c.eyePitch = mix(pv[2], sa[2], spd) * 0.6 + c.head[0] * 0.3;
    // micro-life on every joint: tiny, slow, layered noise with its own rate and phase per joint and side (applied before
    // the self-collision correction, which therefore accounts for it; face values stay inside their ranges)
    var mi = 0; function mn(amp) { mi++; return amp * noise1(t * (0.35 + 0.37 * ((mi * 0.618) % 1)), mi * 2.39); }
    for (j = 0; j < 3; j++) { c.spine[j] += mn(0.006); c.chest[j] += mn(0.005); c.neck[j] += mn(0.012); c.head[j] += mn(0.006); c.hip[j] += mn(0.004); }
    ['L', 'R'].forEach(function (S) { var a = c['arm' + S], lg = c['leg' + S];
      a.clav += mn(0.012); a.twist += mn(0.025); a.wdev += mn(0.03); a.spread = max(0, a.spread + mn(0.03)); a.thumb = max(0, a.thumb + mn(0.04));
      lg.lift += mn(0.006); lg.bend = max(0, lg.bend + mn(0.01)); lg.ank = mn(0.02); });
    c.jaw += 0.004 * (1 + mn(1)); c.browL += mn(0.05); c.browR += mn(0.05); c.blinkL = min(1, c.blinkL + 0.03 * (1 + mn(1))); c.blinkR = min(1, c.blinkR + 0.03 * (1 + mn(1)));
    if (fix) { var u = t * FIXHZ, i0 = floor(u), f = u - i0; AK.forEach(function (k, j) { var a = c['arm' + k[1]];
      a[k[0]] = softClamp(a[k[0]] + crInterp(fix[j], i0, f), LIM[k[0]][0], LIM[k[0]][1]); }); }
    return c;
  };
  // self-collision avoidance, precomputed: solve on a 30 Hz grid, then widen (max-magnitude over ±0.1 s) and smooth
  // (Gaussian σ 0.06 s) the corrections so the result stays as smooth as the choreography itself
  var fix = null, FIXHZ = 30, AK = [['raise', 'L'], ['fwd', 'L'], ['elbow', 'L'], ['twist', 'L'], ['raise', 'R'], ['fwd', 'R'], ['elbow', 'R'], ['twist', 'R']];
  if (caps) {
    var N = ceil(dur * FIXHZ) + 2, raw = AK.map(function () { return new Float32Array(N); });
    // warm start from the previous sample's correction (decaying), so the solver keeps resolving a contact the same way
    for (var gi = 0; gi < N; gi++) { var cc = self.controls(gi / FIXHZ), before = AK.map(function (k) { return cc['arm' + k[1]][k[0]]; });
      if (gi) AK.forEach(function (k, j) { cc['arm' + k[1]][k[0]] += 0.85 * raw[j][gi - 1]; });
      avoidSelf(o.fig.sk, caps, cc); AK.forEach(function (k, j) { raw[j][gi] = cc['arm' + k[1]][k[0]] - before[j]; }); }
    fix = raw.map(function (R0) {
      var W2 = new Float32Array(N), G = new Float32Array(N);
      for (var i = 0; i < N; i++) { var m = 0; for (var d = -3; d <= 3; d++) { var x = R0[clamp(i + d, 0, N - 1)]; if (abs(x) > abs(m)) m = x; } W2[i] = m; }
      for (i = 0; i < N; i++) { var sm = 0, sw2 = 0; for (d = -5; d <= 5; d++) { var g = exp(-d * d / 6.5); sm += g * W2[clamp(i + d, 0, N - 1)]; sw2 += g; } G[i] = sm / sw2; }
      return G;
    });
  }
  self.camera = cameraPlan(self, o.fig);
  return self;
}
/* ---- camera: calm shots. Framing changes only at phrase boundaries (one continuous shot, no cuts), each shot
   lasts ≥ 6 s, sizes never go in-then-out within 10 s; changes are speed-limited eased dollies, followed by a
   critically damped spring (ω 1.2 rad/s), and the camera drifts on a slow orbit.  The target
   follows the singer's head loosely (more in close shots). Precomputed at 60 Hz → stateless camera(t). */
var FRAMES = { full: { tgt: [0, 0.95, 0], dist: 4.3, fov: 28, el: 3, follow: 0 }, wide: { tgt: [0, 1.08, 0], dist: 3.3, fov: 28, el: 3, follow: 0.2 },
  medium: { tgt: [0, 1.25, 0], dist: 2.4, fov: 28, el: 2, follow: 0.45 }, close: { tgt: [0, 1.44, 0.02], dist: 1.6, fov: 27, el: 1.5, follow: 0.7 },
  face: { tgt: [0, 1.53, 0.02], dist: 1.1, fov: 26, el: 0.5, follow: 0.85 } };
var SIZES = ['full', 'wide', 'medium', 'close', 'face'];
function cameraPlan(perf, fig) {
  var P = perf.phrases, dur = perf.dur, shots = [], a0 = P[0].a;
  function shot(t, f, o) { o = o || {}; shots.push({ t: t, f: f, az: o.az, rate: o.rate == null ? 0.3 : o.rate, cut: !!o.cut }); }
  shot(0, 'full', { az: -8, rate: 0.25 }); if (a0 > 9) shot(a0 * 0.35, 'wide', { rate: 0.3 });
  var couplet = 0;
  P.forEach(function (p, i) {
    var first = !i || P[i - 1].end === '。', t = p.a - 1.0;
    if (first) { if (i) { couplet++; shot(t, 'medium', { rate: couplet % 2 ? -0.4 : 0.4 }); } else shot(t, 'medium', { rate: -0.3 }); }   // no cuts: one continuous shot, the orbit drift reverses per couplet
    else shot(t, 'close', { rate: (i % 2 ? 1 : -1) * 0.35 });
  });
  var last = P[P.length - 1]; if (dur - last.b - 0.5 >= 6) shot(last.b + 0.5, 'wide', { rate: 0.25 });   // a closing pull-out if there is time
  // rules: min shot length, no in-then-out within 10 s (cuts reset), no repeats
  var out = [shots[0]];
  shots.slice(1).forEach(function (s) {
    var pv = out[out.length - 1]; if (s.f === pv.f && !s.cut) return;
    if (s.t - pv.t < 6) { if (s.cut) out[out.length - 1] = s.t - (out[out.length - 2] || { t: -99 }).t >= 6 ? s : pv; return; }
    var pp = out[out.length - 2], d = function (x) { return SIZES.indexOf(x.f); };
    if (!s.cut && pp && !pv.cut && s.t - pp.t < 10 && (d(pv) - d(pp)) * (d(s) - d(pv)) < 0) return;
    out.push(s);
  });
  // head track (for loose following)
  var HZ = 60, N = ceil((dur + 1) * HZ), head = [], sk = fig && fig.sk;
  for (var i = 0; i <= N; i += 4) { var hp = [0, 0, 0]; if (sk) { var W = solve(sk, perf.controls(i / HZ)); hp = sub(W.p[sk.by.neck], sk.bones[sk.by.neck].p); } head.push(hp); }
  function headAt(t) { var u = clamp(t * HZ / 4, 0, head.length - 1), i0 = floor(u), f = u - i0, A2 = head[i0], B2 = head[min(i0 + 1, head.length - 1)]; return lerp3(A2, B2, f); }
  // path: each framing change is a planned quintic move whose duration keeps every channel under its speed limit
  // (peak = 1.875 × mean); the orbit drifts at the shot's rate. A critically damped spring then follows the path (and
  // the loosely tracked head), so even rate changes and head motion come out with continuous acceleration.
  var VMAX = [0.06, 0.06, 0.06, 0.32, 2.5, 1, 1.5], w = 1.2, x = null, v = null, si = -1, tab = [], cuts = [], dt = 1 / HZ, from = null, to = null, T0 = 0, TT = 0, azAt = 0, azRate = 0;
  function frameVec(f) { var F = FRAMES[f]; return [F.tgt[0], F.tgt[1], F.tgt[2], F.dist, 0, F.el, F.fov, F.follow]; }
  function q5(u) { u = clamp(u, 0, 1); return u * u * u * (u * (u * 6 - 15) + 10); }
  for (i = 0; i <= N; i++) {
    var t = i * dt;
    while (si < out.length - 1 && out[si + 1].t <= t) {
      si++; var S = out[si], cur = from ? from.map(function (a, k) { return a + (to[k] - a) * q5((t - T0) / TT); }) : null;
      if (S.az != null) azAt = S.az; S.az0 = azAt; azRate = S.rate;
      to = frameVec(S.f); T0 = t;
      if (!cur || S.cut) { from = to; TT = 1; if (cur) cuts.push(t); x = null; }
      else { from = cur; TT = 4; for (var k = 0; k < 7; k++) if (k !== 4) TT = max(TT, 1.875 * abs(to[k] - from[k]) / VMAX[k]); S.T = TT; }
    }
    azAt += azRate * dt;
    var pth = from.map(function (a, k) { return a + (to[k] - a) * q5((t - T0) / TT); }), h = headAt(t), fw = pth[7];
    var goal = [pth[0] + fw * h[0], pth[1] + fw * h[1], pth[2] + fw * h[2], pth[3], azAt, pth[5], pth[6]];
    if (!x) { x = goal.slice(); v = [0, 0, 0, 0, 0, 0, 0]; }
    else for (k = 0; k < 7; k++) { v[k] += (w * w * (goal[k] - x[k]) - 2 * w * v[k]) * dt; x[k] += v[k] * dt; }
    tab.push(x.slice());
  }
  var fn = function (t) { var u = clamp(t * HZ, 0, tab.length - 1), i0 = floor(u), f = u - i0, A2 = tab[i0], B2 = tab[min(i0 + 1, tab.length - 1)];
    if (cuts.some(function (c) { return c > i0 * dt && c <= (i0 + 1) * dt; })) { if (t >= (i0 + 1) * dt) f = 1; else B2 = A2.map(function (a, k) { return 2 * a - tab[max(i0 - 1, 0)][k]; }); }   // no blending across a cut: extrapolate
    var r = A2.map(function (a, k) { return a + (B2[k] - a) * f; }); return { tgt: [r[0], r[1], r[2]], dist: r[3], az: r[4], el: r[5], fov: r[6] }; };
  fn.shots = out; fn.cuts = cuts;
  return fn;
}
/* ================= assemble the figure ================= */
/* the heavy, pure-data part of a build (body polygonization + weights, hair cap + strands), as transferable typed
   arrays: run it in a worker and/or cache it (stage.js keys the cache by a hash of figure.json and BUILD_VERSION) */
var BUILD_VERSION = 'b21';   // bump whenever the body / hair geometry code changes (invalidates the stage's cache)
function meshData(m) { var o = {}; for (var k in m) { var v = m[k]; if (v != null && (ArrayBuffer.isView(v) || typeof v === 'number' || typeof v === 'string')) o[k] = v; } return o; }
function prebuild(cfg, log) {
  load(cfg.def); var C = COSTUME[cfg.costume || 'tang'], sk = Skeleton(cfg.def), body = buildBody(sk, { headOnly: cfg.headOnly, def: cfg.def, res: cfg.res }, log);
  var hair = buildHair(sk, body, { hair: hairKey(C) }, log);
  return { body: meshData(body), cap: meshData(hair.cap), strands: meshData(hair.strands), coll: C.garments && !cfg.headOnly && cfg.cloth !== 'old' ? fitColliders(sk, body, log, C.garments) : null };
}
function build(cfg, log) {
  cfg = cfg || {}; log = log || function () {}; load(cfg.def);
  if (cfg.cloth === 'old') {   // (cfg.cloth 'old': the older verlet cloth (buildGarments, Sim) instead of the sewn garments; costume.<style>.old holds its keys where they differ)
    var k0 = cfg.costume || 'tang', Co = Object.assign({}, COSTUME[k0], COSTUME[k0].old); delete Co.garments; delete Co.old; COSTUME = Object.assign({}, COSTUME); COSTUME[k0] = Co; }
  var C = COSTUME[cfg.costume || 'tang'], sk = Skeleton(cfg.def), pre = cfg.pre, body;
  if (pre) { body = pre.body; body.tree = treeFromJSON(cfg.headOnly ? findGroup(cfg.def.body, 'head') : cfg.def.body, sk); body.sdf = compile(body.tree); body.headSdf = headSDF(cfg.def, sk); }
  else body = buildBody(sk, { headOnly: cfg.headOnly, def: cfg.def, res: cfg.res }, log);
  var fig = { sk: sk, body: body, cfg: cfg, parts: [] };
  fig.parts.push({ name: 'body', parent: null, mesh: body, kind: 'skinned' });
  ['L', 'R'].forEach(function (S) { fig.parts.push({ name: 'eye' + S, parent: 'body', mesh: eyeMesh(sk, S), kind: 'rigid', inside: true }); });
  var hair = pre ? { cap: pre.cap, strands: pre.strands, sdf: hairSDF(sk, HAIR[hairKey(C)], body.headSdf || body.sdf).F } : buildHair(sk, body, { hair: hairKey(C) }, log); fig.hair = hair;
  fig.parts.push({ name: 'hairCap', parent: 'body', mesh: hair.cap, kind: 'rigid', embedded: true });
  fig.parts.push({ name: 'hairStrands', parent: 'hairCap', mesh: hair.strands, kind: 'rigid', perComponent: true });
  var orn = buildOrnaments(sk, body, hair, cfg, log); fig.parts = fig.parts.concat(orn.parts); fig.chains = orn.chains; fig.ribbonTop = orn.ribbonTop;
  if (!cfg.headOnly && C.garments) fig.garb = buildCloth(sk, body, C, withShawl(C.garments, cfg.shawl === false ? null : cfg.shawl || SHAWL_DEF[cfg.costume || 'tang']), log, pre && pre.coll);   // (cfg.shawl: a drawn 帔帛 (default SHAWL_DEF), false: the older path)   // sewn garments (new cloth)
  else if (!cfg.headOnly) {
    var G = buildGarments(sk, body, orn.ribbonTop ? Object.assign({}, cfg, { ribbonTop: orn.ribbonTop }) : cfg, log); fig.garments = G; fig.cloths = G.cloths;
    fig.parts.push({ name: 'band', parent: 'body', mesh: G.band, kind: 'skinned' });
    if (G.belt) fig.parts.push({ name: 'belt', parent: 'band', mesh: G.belt, kind: 'skinned' });
    G.parts.forEach(function (p) { fig.parts.push({ name: p.name, parent: p.parent || 'band', mesh: p.mesh, kind: p.kind || 'rigid' }); });
    G.cloths.forEach(function (c) { c.parent = c.name === 'skirt' ? 'band' : c.robe ? 'body' : /^sleeve/.test(c.name) ? 'body' : /^sash/.test(c.name) ? 'sashKnot' : /^ribbon/.test(c.name) ? 'crown' : 'body';
      fig.parts.push({ name: c.name, parent: c.parent, cloth: c, kind: 'cloth', mesh: { idx: c.tris() } }); });
  }
  return fig;
}

/* ================= quick attachment check (editor) =================
   Body: one connected, watertight mesh. Every rigid / skinned part (each connected component for per-component
   parts) within eps of its parent, measured to the nearest parent vertex along its normal (vertex-level accuracy;
   tool/check.js does exact point-triangle distances over the whole song, with cloth). */
function attachCheck(fig, W, eps) {
  eps = eps || 0.002;
  var sk = fig.sk, DQ = poseDQ(sk, W), out = { problems: [], body: {} }, posed = {};
  var bc = components(fig.body.pos.length / 3, fig.body.idx), bl = boundaryLoops(fig.body).length;
  out.body = { components: bc.count, boundaryLoops: bl, ok: bc.count === 1 && bl === 0 };
  if (bc.count > 1) {   // which primitives own the stray pieces
    var size = new Int32Array(bc.count); for (var i = 0; i < bc.label.length; i++) size[bc.label[i]]++;
    var main = 0; for (i = 1; i < bc.count; i++) if (size[i] > size[main]) main = i;
    out.body.stray = []; for (i = 0; i < bc.label.length; i++) if (bc.label[i] !== main) out.body.stray.push(i);
  }
  function pose(p) {
    if (posed[p.name]) return posed[p.name];
    var m = p.mesh, n = m.pos.length / 3, P = new Float32Array(n * 3), N = new Float32Array(n * 3);
    skin(m, DQ, P, N); var H = new PHash(0.01, 18); H.build(P, n);
    return (posed[p.name] = { P: P, N: N, H: H, n: n });
  }
  var byName = {}; fig.parts.forEach(function (p) { byName[p.name] = p; });
  fig.parts.forEach(function (p) {
    if (!p.parent || p.cloth || !byName[p.parent] || !byName[p.parent].mesh.pos) return;
    var A = pose(p), B = pose(byName[p.parent]), comp = p.perComponent ? components(A.n, p.mesh.idx) : null, best = new Float64Array(comp ? comp.count : 1).fill(1e9);
    for (var v = 0; v < A.n; v++) {
      var c = comp ? comp.label[v] : 0; if (best[c] <= 0) continue;
      var x = A.P[v * 3], y = A.P[v * 3 + 1], z = A.P[v * 3 + 2], u = B.H.nearest(x, y, z); if (u < 0) continue;
      var dx = x - B.P[u * 3], dy = y - B.P[u * 3 + 1], dz = z - B.P[u * 3 + 2], d = sqrt(dx * dx + dy * dy + dz * dz), sd = dx * B.N[u * 3] + dy * B.N[u * 3 + 1] + dz * B.N[u * 3 + 2];
      best[c] = min(best[c], sd < 0 ? 0 : d);
    }
    var bad = 0, worst = 0; for (var k = 0; k < best.length; k++) if (best[k] > eps) { bad++; worst = max(worst, best[k]); }
    if (bad) out.problems.push({ part: p.name, parent: p.parent, units: best.length, detached: bad, worst: worst > 1e8 ? Infinity : worst });
  });
  return out;
}

/* ================= decals: painted makeup projected onto the skin (bind space) =================
   {name, kind: blob|brow|flower|dot|lip, c, u, v, n (projector frame), size: [sx, sy], param (brow: rotation, flower:
   petals, lip: lower height), depth: [near, far] (fade-in along n, relative to c), color (linear rgb), opacity, softness,
   gloss (lip shine), mirror (partner name)}. Drawn in order by the skin shader. */
var VERSION = 3;   // figure.json format version written by the editor and tool/upgrade.js
var DECAL_KINDS = ['blob', 'brow', 'flower', 'dot', 'lip'];
/* brow styles (decal.style on brow decals; absent = bazi). Tang names; the preset is what the editor applies when a style
   is picked (size [half-length, half-width], tilt (+ = outer end up), softness, opacity). bazi keeps the shape as is. */
var BROW_STYLES = {
  bazi:     { id: 0, zh: '八字眉', note: 'the current /\\ — inner ends raised (元和 fashion)', preset: null },
  guiye:    { id: 1, zh: '桂葉眉', note: 'short broad leaf, \\/ (outer ends up), as in 簪花仕女圖', preset: { size: [0.0105, 0.0052], param: 0.32, softness: 0.35, opacity: 0.92 } },
  queyue:   { id: 2, zh: '卻月眉', note: 'crescent (月稜眉)', preset: { size: [0.0135, 0.0034], param: 0.05, softness: 0.4, opacity: 0.9 } },
  yuanshan: { id: 3, zh: '遠山眉', note: 'long, light, gently arched', preset: { size: [0.0158, 0.0028], param: 0.06, softness: 0.6, opacity: 0.72 } },
  daoyun:   { id: 4, zh: '倒暈眉', note: 'dark at the inner end, fading outward', preset: { size: [0.0128, 0.0042], param: -0.05, softness: 0.5, opacity: 0.95 } },
  liuye:    { id: 5, zh: '柳葉眉', note: 'willow leaf: slender, tapered, slight arch', preset: { size: [0.014, 0.0031], param: 0.12, softness: 0.4, opacity: 0.9 } }
};
function browPreset(d, key) { var S = BROW_STYLES[key]; if (!S) return d; if (key === 'bazi') delete d.style; else d.style = key; if (S.preset) { d.size = S.preset.size.slice(); d.param = S.preset.param; d.softness = S.preset.softness; d.opacity = S.preset.opacity; } return d; }
function defaultDecals(O) {
  O = O || [0, 1.49, 0]; var h = function (x, y, z) { return [O[0] + x, O[1] + y, O[2] + z]; }, D = [];
  function pair(name, d) { var L = JSON.parse(JSON.stringify(d)), R = JSON.parse(JSON.stringify(d)); L.name = name + 'L'; R.name = name + 'R'; R.c[0] = -R.c[0]; R.u = [-R.u[0], R.u[1], R.u[2]]; L.mirror = R.name; R.mirror = L.name; D.push(L, R); }
  pair('rouge', { kind: 'blob', c: h(0.036, -0.017, 0.075), u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1], size: [0.021, 0.024], param: 0, depth: [-0.035, -0.005], color: [0.82, 0.33, 0.30], opacity: 0.62, softness: 0, gloss: 0 });
  pair('eyeRouge', { kind: 'blob', c: h(0.033, 0.008, 0.08), u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1], size: [0.019, 0.012], param: 0, depth: [-0.03, -0.005], color: [0.82, 0.33, 0.30], opacity: 0.34, softness: 0, gloss: 0 });
  pair('brow', { kind: 'brow', c: h(0.026, 0.031, 0.085), u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1], size: [0.0125, 0.0042], param: -0.35, depth: [-0.025, -0.005], color: [0.05, 0.035, 0.03], opacity: 0.9, softness: 0.45, gloss: 0 });
  D.push({ name: 'huadian', kind: 'flower', c: h(0, 0.047, 0.09), u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1], size: [0.0034, 0.0034], param: 5, depth: [-0.02, -0.005], color: [0.75, 0.06, 0.04], opacity: 1, softness: 0.0004, gloss: 0 });
  D.push({ name: 'huadianDot', kind: 'dot', c: h(0, 0.047, 0.09), u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1], size: [0.0012, 0.0012], param: 0, depth: [-0.02, -0.005], color: [0.9, 0.6, 0.2], opacity: 1, softness: 0.5, gloss: 0 });
  D.push({ name: 'lipTint', kind: 'lip', c: h(0, -0.0608, 0.09), u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1], size: [0.0195, 0.0068], param: 0.0095, depth: [-0.018, -0.006], color: [0.70, 0.40, 0.38], opacity: 0.35, softness: 0.45, gloss: 0 });
  D.push({ name: 'lipPaint', kind: 'lip', c: h(0, -0.0608, 0.09), u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1], size: [0.0178, 0.0058], param: 0.0082, depth: [-0.016, -0.006], color: [0.62, 0.035, 0.05], opacity: 1, softness: 0.3, gloss: 1 });
  return D;
}
/* styles: 'tang' (the top-level decals / paint) or 'song' (figure.json "styles": {"song": {"decals", "paint"}}; Song
   makeup defaults below when absent). styleDef(def, style) → the def to build / render that style with (a shallow copy
   with the style's decals and paint); the editors write back with styleStore(def, style, {decals, paint}). */
function styleDef(def, style) {
  if (def.style || !style || style === 'tang') return def;   // (a per-style file, figure.<style>.json, is used as it is)
  var S = (def.styles || {})[style] || {}, d = Object.assign({}, def);
  d.decals = S.decals || songDecals(def); d.paint = S.paint; d.style = style; return d;
}
function styleStore(def, style, o) { if (def.style || !style || style === 'tang') { for (var k in o) def[k] = o[k]; return def; } def.styles = def.styles || {}; var S = def.styles[style] = def.styles[style] || {}; for (k in o) S[k] = o[k]; return def; }
// Song makeup defaults (淡妝 / 薄妝): faint rouge, 三白 (whitened forehead, nose bridge, chin), long thin 遠山眉 in 黛,
// small lips in a soft red, 珍珠花鈿 (pearls at the brow centre and the temples, as in the Song empress portraits).
// Placed relative to the figure's own Tang brows and lips so they fit the face as edited.
// Node: the figure file for a style — figure.<style>.json, else the old combined figure.json
function figFile(style, dir) { var fs = require('fs'), path = require('path'), f = path.join(dir, 'figure.' + (style || 'tang') + '.json'); if (!fs.existsSync(f)) f = path.join(dir, 'figure.json'); return { file: f, def: JSON.parse(fs.readFileSync(f, 'utf8')) }; }
function songDecals(def) {
  var T = JSON.parse(JSON.stringify(def.decals || defaultDecals())), by = {}; T.forEach(function (d) { by[d.name] = d; });
  var O = [0, 1.49, 0], D = [], bc = by.browL ? by.browL.c : [0.026, 1.521, 0.085], lc = by.lipPaint ? by.lipPaint.c : [0, 1.4292, 0.09];
  function add2(d) { D.push(d); return d; }
  function pair(name, d) { var L = JSON.parse(JSON.stringify(d)), R = JSON.parse(JSON.stringify(d)); L.name = name + 'L'; R.name = name + 'R'; R.c[0] = -R.c[0]; R.u = [-R.u[0], R.u[1], R.u[2]]; R.n = [-R.n[0], R.n[1], R.n[2]]; L.mirror = R.name; R.mirror = L.name; D.push(L, R); }
  var white = [0.97, 0.94, 0.9];
  add2({ name: 'sanbaiForehead', kind: 'blob', c: [0, bc[1] + 0.03, bc[2] + 0.002], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1], size: [0.017, 0.014], param: 0, depth: [-0.03, -0.004], color: white, opacity: 0.22, softness: 0, gloss: 0 });
  add2({ name: 'sanbaiNose', kind: 'blob', c: [0, bc[1] - 0.026, bc[2] + 0.016], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1], size: [0.006, 0.016], param: 0, depth: [-0.03, -0.004], color: white, opacity: 0.12, softness: 0, gloss: 0 });
  add2({ name: 'sanbaiChin', kind: 'blob', c: [0, lc[1] - 0.03, lc[2] - 0.006], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1], size: [0.011, 0.008], param: 0, depth: [-0.03, -0.004], color: white, opacity: 0.2, softness: 0, gloss: 0 });
  if (by.rougeL) pair('rouge', Object.assign(JSON.parse(JSON.stringify(by.rougeL)), { color: [0.86, 0.48, 0.45], opacity: 0.26, size: [0.019, 0.021] }));
  if (by.browL) pair('brow', Object.assign(browPreset(Object.assign(JSON.parse(JSON.stringify(by.browL)), { color: [0.07, 0.065, 0.08], c: [bc[0] + 0.001, bc[1] + 0.001, bc[2]] }), 'yuanshan'), { opacity: 0.88 }));
  add2({ name: 'pearlBrow', kind: 'dot', c: [0, bc[1] + 0.016, bc[2] + 0.005], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1], size: [0.0021, 0.0021], param: 0, depth: [-0.02, -0.004], color: [0.95, 0.93, 0.88], opacity: 1, softness: 0.25, gloss: 1 });
  pair('pearlTemple', { kind: 'dot', c: [bc[0] + 0.025, bc[1] - 0.004, bc[2] - 0.022], u: [0.7, 0, -0.7], v: [0, 1, 0], n: [0.7, 0, 0.7], size: [0.0019, 0.0019], param: 0, depth: [-0.02, -0.004], color: [0.95, 0.93, 0.88], opacity: 1, softness: 0.25, gloss: 1 });
  if (by.lipPaint) add2(Object.assign(JSON.parse(JSON.stringify(by.lipPaint)), { size: [by.lipPaint.size[0] * 0.8, by.lipPaint.size[1] * 0.92], param: by.lipPaint.param * 0.9, color: [0.7, 0.1, 0.13], gloss: 0.7 }));
  T.filter(function (d) { return /^lashLine/.test(d.name); }).forEach(function (d) { D.push(d); });
  return D;
}
// pack for the shader: 6 vec4 per decal (max 24)
function packDecals(list) {
  var N = 24, out = { n: min(list.length, N), c: new Float32Array(N * 4), u: new Float32Array(N * 4), v: new Float32Array(N * 4), nn: new Float32Array(N * 4), col: new Float32Array(N * 4), p: new Float32Array(N * 4) };
  list.slice(0, N).forEach(function (d, i) {
    out.c.set([d.c[0], d.c[1], d.c[2], DECAL_KINDS.indexOf(d.kind)], i * 4); out.u.set([d.u[0], d.u[1], d.u[2], d.size[0]], i * 4); out.v.set([d.v[0], d.v[1], d.v[2], d.size[1]], i * 4);
    out.nn.set([d.n[0], d.n[1], d.n[2], d.kind === 'brow' ? (BROW_STYLES[d.style] || BROW_STYLES.bazi).id : d.gloss || 0], i * 4);   // (brows: the 4th slot is the style)
    out.col.set([d.color[0], d.color[1], d.color[2], d.opacity], i * 4); out.p.set([d.depth[0], d.depth[1], d.softness || 0, d.param || 0], i * 4);
  });
  return out;
}
/* ---- upgrade an older figure.json in place (idempotent): skeleton section, explicit face parameters, decals, eye
   sockets / lid shells as ordinary primitives (exact same numbers, so the same shape), named face groups, mirror audit */
function upgrade(def) {
  load(def); var sk = Skeleton(def), O = sk.O, log = [];
  if (!def.skeleton) { def.skeleton = skeletonToJSON(sk); log.push('added the skeleton section (built-in joints)'); }
  def.params = def.params || {};
  [['eyeOpening', AP0], ['lips', LP0], ['lashes', LS0]].forEach(function (q) { if (!def.params[q[0]]) { def.params[q[0]] = JSON.parse(JSON.stringify(q[1])); log.push('added params.' + q[0]); } });
  if (!def.decals) { def.decals = defaultDecals(O); log.push('added ' + def.decals.length + ' decals (the painted makeup)'); }
  var groupsOf = [];
  (function walk(g) { if (!g.kids) return; g.kids.forEach(function (k, i) {
    if (k.type === 'special' && /^(socketOut|socketIn|lidShell)$/.test(k.name)) {
      var sd = k.side || 1, E = add(O, [EYE_C[0] * sd, EYE_C[1], EYE_C[2]]), n;
      if (k.name === 'lidShell') n = { id: k.id, type: 'shell', c: E, r: [(SOCK_IN + SOCK_OUT) / 2, (SOCK_IN + SOCK_OUT) / 2, (SOCK_IN + SOCK_OUT) / 2], t: SOCK_OUT - SOCK_IN, u: [1, 0, 0], v: [0, 1, 0] };
      else n = { id: k.id, type: 'sphere', c: E, r: k.name === 'socketOut' ? SOCK_OUT : SOCK_IN };
      ['bone', 'sig', 'mat', 'mirror'].forEach(function (q) { if (k[q] !== undefined) n[q] = k[q]; });
      g.kids[i] = n; log.push('#' + k.id + ' ' + k.name + (k.side > 0 ? ' L' : ' R') + ' → ' + n.type);
    }
    walk(g.kids[i]); }); })(def.body);
  // names for the face groups (only where unnamed)
  function nameIf(test, name) { (function walk(g) { if (!g.kids) return; if (!g.group && g.kids.some(test)) { g.group = name; log.push('named group: ' + name); } g.kids.forEach(walk); })(def.body); }
  var hl = function (p) { return sub(p, O); };
  nameIf(function (k) { return k.type === 'special' && k.name === 'aperture'; }, 'eye openings (cut)');
  nameIf(function (k) { return k.type === 'shell'; }, 'eyelid');
  nameIf(function (k) { return k.type === 'sphere' && k.bone == null && abs(k.r - SOCK_OUT) < 1e-9; }, 'eye recesses (cut)');
  nameIf(function (k) { return k.type === 'sphere' && k.bone == null && abs(k.r - SOCK_IN) < 1e-9; }, 'eyeball sockets (cut)');
  nameIf(function (k) { return k.type === 'special' && k.name === 'mouthSlit'; }, 'mouth opening (cut)');
  nameIf(function (k) { return k.type === 'special' && /^lip/.test(k.name); }, 'lips');
  nameIf(function (k) { return k.type === 'ellipsoid' && k.bone == null && abs(hl(k.c)[1] + 0.0358) < 0.003 && abs(hl(k.c)[0]) < 0.01; }, 'nostrils (cut)');
  nameIf(function (k) { return k.type === 'ellipsoid' && k.bone == null && abs(hl(k.c)[1] + 0.0762) < 0.003; }, 'philtrum & chin crease (cut)');
  nameIf(function (k) { return k.type === 'sphere' && k.bone === 'head' && abs(hl(k.c)[1] + 0.0262) < 0.004 && abs(hl(k.c)[0]) < 1e-6; }, 'nose');
  (function walk(g) { if (!g.kids) return; if (g.group === 'eyelid') { var sh = g.kids.find(function (k) { return k.type === 'shell'; }); if (sh) { g.group = 'eyelid ' + (sh.c[0] > 0 ? 'L' : 'R'); log.push('named group: ' + g.group); } } g.kids.forEach(walk); })(def.body);
  def.version = VERSION;
  var r = auditMirror(def);
  return { log: log, mirror: r };
}

/* ================= mirror audit =================
   Every off-centre primitive should have an L/R partner whose field is its exact mirror image; centre pieces should be
   symmetric themselves. Pairs are found geometrically (the SDFs are compared at sample points), not by parameters. */
// Non-destructive: existing mutual pairs are kept (inexact ones are only reported); links are added only between
// unpaired exact mirrors; bones are never changed (mismatches reported).
function auditMirror(def, eps) {
  eps = eps || 1e-4;
  var sk = Skeleton(def), prims = [], R = rng(99), rep = { paired: [], kept: 0, inexact: [], centre: [], asymCentre: [], unpaired: [], boneMismatch: [] };
  (function walk(g) { if (g.kids) g.kids.forEach(walk); else prims.push(g); })(def.body);
  var leaf = {}; prims.forEach(function (p) { var n = treeFromJSON(p, sk); leaf[p.id] = n; });
  function f(p, x) { return leaf[p.id].f(x[0], x[1], x[2]); }
  function samples(p) { var l = leaf[p.id], out = []; for (var i = 0; i < 24; i++) out.push(add(l.c, mul([R() * 2 - 1, R() * 2 - 1, R() * 2 - 1], l.r * 1.2))); return out; }
  function mirrors(p, q) { if (p.type !== q.type || (p.type === 'special' && p.name !== q.name)) return false; var X = samples(p); for (var i = 0; i < X.length; i++) if (abs(f(p, X[i]) - f(q, mirror(X[i]))) > 1e-6) return false; return true; }
  var mirB = function (b) { return b ? b.replace(/L$/, '§').replace(/R$/, 'L').replace(/§$/, 'R') : b; };
  var byId = {}; prims.forEach(function (p) { byId[p.id] = p; });
  var mutual = function (p) { var q = byId[p.mirror]; return q && q !== p && q.mirror === p.id; };
  prims.forEach(function (p) {
    var c = leaf[p.id].c, off = abs(c[0]) > eps;
    if (mutual(p)) { if (mirrors(p, byId[p.mirror])) rep.kept++; else if (p.id < p.mirror) rep.inexact.push([p.id, p.mirror]); return; }
    if (!off) { rep.centre.push(p.id); if (!mirrors(p, p)) rep.asymCentre.push(p.id); return; }
    var q = prims.find(function (q) { return q !== p && !mutual(q) && abs(leaf[q.id].c[0] + c[0]) < 1e-3 && abs(leaf[q.id].c[1] - c[1]) < 1e-3 && abs(leaf[q.id].c[2] - c[2]) < 1e-3 && mirrors(p, q); });
    if (q) { rep.paired.push([min(p.id, q.id), max(p.id, q.id), p.type + (p.name ? ' ' + p.name : ''), p.bone]); p.mirror = q.id; q.mirror = p.id; }
    else rep.unpaired.push(p.id);
  });
  prims.forEach(function (p) { var q = byId[p.mirror]; if (q && p.id < q.id && p.bone && q.bone !== mirB(p.bone)) rep.boneMismatch.push([p.id, p.bone, q.id, q.bone]); });
  return rep;
}

/* ================= exports ================= */
var FIG = { buildCord: buildCord, hairSdf: function (def, key) { load(def); var sk = Skeleton(def); return hairSDF(sk, HAIR[key], headSDF(def, sk)).F; }, buildPiece: buildPiece, ORN_SHAPES: function () { return ORN_SHAPES; }, hairMasses: hairMasses, bunList: bunList, headSDF: headSDF, figFile: figFile, hairKey: hairKey, styleDef: styleDef, styleStore: styleStore, songDecals: songDecals, POSES_SONG: POSES_SONG, simQuality: function (o) { for (var k in o) SIMQ[k] = o[k]; return SIMQ; }, lashMesh: lashMesh, lashCurve: lashCurve, prebuild: prebuild, BUILD_VERSION: BUILD_VERSION, BROW_STYLES: BROW_STYLES, browPreset: browPreset, mouth: function () { return MOUTH; }, eyeC: function () { return EYE_C; }, avoidSelf: avoidSelf, buildCapsules: buildCapsules, poseCaps: poseCaps, capDist: capDist, AVOID: AVOID, cameraPlan: cameraPlan, FRAMES: FRAMES, HANDS: HANDS, mirrorPose: mirrorPose, VERSION: VERSION, upgrade: upgrade, defaultDecals: defaultDecals, packDecals: packDecals, DECAL_KINDS: DECAL_KINDS, params: function () { return { eyeOpening: AP, lips: LP, lashes: LS }; }, perpOf: perpOf, auditMirror: auditMirror, skeletonToJSON: skeletonToJSON, applySkeleton: applySkeleton, FIXED_JOINT: FIXED_JOINT, attachCheck: attachCheck, mirrorQ: mirrorQ, load: load, findGroup: findGroup, compileTree: compile, treeToJSON: treeToJSON, treeFromJSON: treeFromJSON, special: special, Flat: Flat, polygonize: polygonize, POSES: POSES, perform: perform, parseIPA: parseIPA, build: build, buildOrnaments: buildOrnaments, bindW: bindW, blendW: blendW, Skeleton: Skeleton, buildBody: buildBody, buildGarments: buildGarments, Sim: Sim, GSim: GSim, GDT: GDT, knotMesh: knotMesh, knotFrame: knotFrame, jadeFrame: jadeFrame, buildCloth: buildCloth, shawlStrip: shawlStrip, shawlFromCloth: shawlFromCloth, capNormal: capNormal, shawlBone: shawlBone, shawlIssues: shawlIssues, shawlFile: shawlFile, withShawl: withShawl, SHAWL_DEF: SHAWL_DEF, layPose: layPose, PIN_BONES: PIN_BONES, fitColliders: fitColliders, poseColl: poseColl, setClothLib: setClothLib, SIM_DT: SIM_DT, COSTUME: COSTUME, buildHair: buildHair, solve: solve, poseDQ: poseDQ, skin: skin, defaultControls: defaultControls, eyeMesh: eyeMesh, vertexNormals: vertexNormals, EYE_C: EYE_C, EYE_R: EYE_R, aperture: aperture, components: components, boundaryLoops: boundaryLoops, neighbors: neighbors,
  qaxis: qaxis, qmul: qmul, qrot: qrot, qconj: qconj, qslerp: qslerp, qnorm: qnorm, qfromto: qfromto, v3: { add: add, sub: sub, mul: mul, dot: dot, cross: cross, len: len, norm: norm, lerp: lerp3 },
  rng: rng, smooth: smooth, clamp: clamp, mix: mix };
if (typeof module !== 'undefined' && module.exports) module.exports = FIG; else root.FIG = FIG;
})(this);
