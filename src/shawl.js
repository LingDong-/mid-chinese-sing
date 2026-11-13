/* shawl.js — the 帔帛 editor (shawl.html): draw the shawl's centreline as a curve through control points in a laying pose
   (A-pose or rest), pin points to bones, set its width and fabric, then settle or play it with the stage's own cloth
   (FIG.GSim on the cloth_sim solver: the same build, laying, warm-up and fixed 1/60 s steps as the stage's shots and
   video). Export writes shawl.tang.json; with that file in the project folder the stage, tool/video.js and tool/check.js
   build the shawl from it (FIG.build cfg.shawl; format in figure.js above shawlStrip). Renders with stage.js (STAGE_EDITOR). */
(function () {
'use strict';
var $ = function (id) { return document.getElementById(id); }, A = window.STAGE_API, gl = A.gl, V = FIG.v3;
var status = function (s) { $('status').textContent = s; }, dpr = function () { return Math.min(window.devicePixelRatio || 1, 2); };
var DEF, DICT, fig, sk, gsim, perf, spec, built = '', undo = [], redo = [], sel = -1, space = 'world', view = 'path', simState = '', playing = false, T = 0, dirty = true;
var ITEMS = [], ribbon = null, ST = null, CL = null, CAPS = null, Wl = null, ISS = null, RUN = null, drag = null, hover = null;
var Wb = null, poseAt = function (t, k) { var W = FIG.solve(sk, perf.controls(t)); return k >= 1 ? W : FIG.blendW(Wb, W, k); };
var SHOWS = { skirt: ['skirt'], band: ['band'], robe: ['robeB', 'robeFL', 'robeFR'], sleeves: ['sleeveL', 'sleeveR'], ribbons: ['sashL', 'sashR', 'sashKnot'], shoes: ['shoeL', 'shoeR'], shawl: ['shawl'] };
var busy = function (msg, fn) { status(msg); setTimeout(function () { fn(); dirty = true; }, 30); };

/* ---------- the spec: edits, undo ---------- */
var key = function () { return JSON.stringify(spec); };
function snapshot() { undo.push(key()); if (undo.length > 200) undo.shift(); redo = []; }
function restore(s) { var p = JSON.parse(s), re = p.pose !== spec.pose; spec = p; sel = Math.min(sel, spec.points.length - 1); if (re) redress(); else changed(); }
function changed() { ST = FIG.shawlStrip(spec, CAPS, CL); ribbonMesh(); panel(); dirty = true; }
function fill(o) {   // an imported file: defaults for what it leaves out
  var d = { version: 1, pose: 'A', w: spec ? spec.w : 0.16, spacing: spec ? spec.spacing : 0.02, fabric: spec ? spec.fabric : { mass: 0.06, bend: 40, friction: 0.5 }, pins: [] };
  o = Object.assign(d, o); o.fabric = Object.assign({}, d.fabric, o.fabric); o.roll = o.points.map(function (p, i) { return (o.roll || [])[i] || 0; }); o.pose = o.pose === 'rest' ? 'rest' : 'A';
  o.pins = o.pins.filter(function (q) { return q.i >= 0 && q.i < o.points.length; }).map(function (q) { return { i: q.i, bone: q.bone || 'auto', compliance: +q.compliance || 0, offset: +q.offset || 0 }; });
  return o;
}
function pinAt(i) { return spec.pins.find(function (q) { return q.i === i; }); }
function shiftPins(from, d) { spec.pins.forEach(function (q) { if (q.i >= from) q.i += d; }); }
function addPoint(at, p, roll) { snapshot(); shiftPins(at, 1); spec.points.splice(at, 0, p); spec.roll.splice(at, 0, roll || 0); sel = at; changed(); }
function insertAfter() { var i = sel < 0 ? spec.points.length - 2 : Math.min(sel, spec.points.length - 2), s = (ST.knots[i] + ST.knots[i + 1]) / 2; addPoint(i + 1, ST.at(s).p.map(r4), (spec.roll[i] + spec.roll[i + 1]) / 2); }
function append(end) { var P = spec.points, a = end ? P[P.length - 1] : P[0], b = end ? P[P.length - 2] : P[1], p = V.add(a, V.mul(V.norm(V.sub(a, b)), 0.15)).map(r4); addPoint(end ? P.length : 0, p, end ? spec.roll[P.length - 1] : spec.roll[0]); }
function delPoint() { if (sel < 0 || spec.points.length <= 2) return; snapshot(); spec.pins = spec.pins.filter(function (q) { return q.i !== sel; }); shiftPins(sel + 1, -1); spec.points.splice(sel, 1); spec.roll.splice(sel, 1); sel = Math.min(sel, spec.points.length - 1); changed(); }
var r4 = function (x) { return Math.round(x * 1e4) / 1e4; };
// the laying pose changed: carry each point with its nearest bone into the new pose, then dress the others in it
function setPose(pose) {
  if (pose === spec.pose) return; snapshot(); var W1 = Wl, W2 = FIG.layPose(sk, pose);
  spec.points = spec.points.map(function (p) { var b = FIG.shawlBone(sk, W1, p, 'auto'), q = V.add(sk.bones[b].p, FIG.qrot(FIG.qconj(W1.q[b]), V.sub(p, W1.p[b]))); return V.add(W2.p[b], FIG.qrot(W2.q[b], V.sub(q, sk.bones[b].p))).map(r4); });
  spec.pose = pose; redress();
}

/* ---------- the cloth: built with this shawl, the others dressed in the laying pose ---------- */
function rebuild() {
  A.scene.items = ITEMS; var C = DEF.costume.tang, G = FIG.buildCloth(sk, fig.body, C, FIG.withShawl(C.garments, JSON.parse(key())), null, fig.garb.coll);
  gsim = A.rebuildGarb(G); ITEMS = A.scene.items.slice(); built = key(); simState = ''; applyView();
}
function dress() {   // the others settled in the laying pose (the shawl parked): the backdrop for drawing; the strip faces them
  gsim.reset(poseAt, 0, 'dressed'); simState = 'dressed'; Wl = gsim.W; CAPS = new Float32Array(gsim.caps);
  var shM = new Uint8Array(fig.garb.n); fig.garb.shawlV.forEach(function (i) { shM[i] = 1; });
  CL = { P: gsim.dressed, N: FIG.vertexNormals(gsim.dressed, gsim.cloth.indices), skip: function (i) { return shM[i]; } };
}
function redress() { busy('dressing the figure in the ' + (spec.pose === 'rest' ? 'rest pose' : 'A-pose') + '…', function () { rebuild(); dress(); changed(); setView('path'); status(''); }); }
function ensureBuilt() { if (built !== key()) { rebuild(); dress(); } }
function settle() { pause(); busy('laying and settling…', function () { var t0 = performance.now(); ensureBuilt(); gsim.reset(poseAt, 0, true); simState = 'settled'; setView('sim'); showSim(true); status('settled in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s'); }); }
function play() {
  if (playing) return pause();
  var go = function () { playing = true; $('play').textContent = '❚❚ pause'; setView('sim'); RUN = RUN || { n: 0, pierced: 0, maxP: 0, maxC: 0 }; status(''); };
  if (built !== key() || simState !== 'song') busy('warming up (laying, settling, into the dance)…', function () { ensureBuilt(); if (T >= perf.dur - 0.05) T = 0; gsim.reset(poseAt, Math.max(0, T - 2)); gsim.advance(poseAt, T); simState = 'song'; RUN = null; showSim(); go(); });
  else go();
}
function pause() { playing = false; $('play').textContent = '▶ play'; }
function scrub(t) { pause(); T = t; busy('simulating to ' + t.toFixed(1) + ' s…', function () { ensureBuilt(); if (simState !== 'song') { gsim.reset(poseAt, Math.max(0, T - 2)); simState = 'song'; } gsim.advance(poseAt, T); RUN = null; setView('sim'); showSim(); status(''); }); }
function showSim(still) {
  var c = gsim.cloth; A.garbUpload(c.positions, c.computeNormals()); A.DQ.set(FIG.poseDQ(sk, gsim.W)); secondary(still ? gsim.W : null);
  ISS = FIG.shawlIssues(fig.garb, c.positions, gsim.caps); if (playing && RUN) { RUN.n++; if (ISS.pierced.length) RUN.pierced++; RUN.maxP = Math.max(RUN.maxP, ISS.pierced.length); RUN.maxC = Math.max(RUN.maxC, ISS.crossing.length); }
  $('time').value = T; $('tval').textContent = (still ? 'laid · ' : '') + T.toFixed(2) + ' s'; issuesText(still); dirty = true;
}
function showPath() { A.garbUpload(gsim.dressed, CL.N); A.DQ.set(FIG.poseDQ(sk, Wl)); secondary(Wl); dirty = true; }
function secondary(W) {   // bracelets, bead chains, flower: at the song time, or settled in a held pose
  if (W) { fig.sim.t = null; fig.sim.advance(function () { return W; }, 0); } else fig.sim.advance(poseAt, T, 0); A.updateCloth();
}
function issuesText(still) {
  var by = Object.keys(ISS.by).sort(function (a, b) { return ISS.by[b] - ISS.by[a]; }).map(function (k) { return k + ' ' + ISS.by[k]; }).join(', ');
  var h = (still ? 'settled in the laying pose' : 't ' + T.toFixed(2) + ' s') + '\npierced by body/hands: ' + (ISS.pierced.length ? '<b>' + ISS.pierced.length + '</b> triangles (' + by + ')' : '0') + '\nedges through robe/sleeves/skirt: ' + (ISS.crossing.length ? '<b>' + ISS.crossing.length + '</b>' : '0');
  if (RUN && RUN.n) h += '\nthis run: ' + RUN.n + ' frames, pierced in ' + RUN.pierced + ' (max ' + RUN.maxP + '), crossings max ' + RUN.maxC;
  $('issues').innerHTML = h;
}
function setView(v) { view = v; $('vPath').className = v === 'path' ? 'on' : ''; $('vSim').className = v === 'sim' ? 'on' : ''; if (v === 'path') { pause(); showPath(); } else if (simState === 'settled' || simState === 'song') showSim(simState === 'settled'); applyView(); }

/* ---------- scene: visibility, see-through, the strip preview ---------- */
function applyView() {
  ITEMS.forEach(function (it) {
    if (!it.orig) it.orig = { gauze: it.gauze, set: it.set }; var os = it.orig.set, a = 0;
    if (!it.orig.gauze && it.prog === 'skin' && $('xBody').checked) a = 0.3; else if (!it.orig.gauze && it.garment && $('xGarb').checked) a = 0.35;
    it.gauze = a ? true : it.orig.gauze;   // (see-through: drawn in the stage's blended pass at a constant alpha)
    it.set = a ? function (pr) { if (os) os(pr); gl.blendColor(0, 0, 0, a); gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA); } : it.orig.gauze ? function (pr) { gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); if (os) os(pr); } : os;
  });
  dirty = true;
}
function visible(it) {
  if (it === ribbon) return view === 'path'; if (!it.garment) return true; if (it.garment === 'shawl' && view === 'path') return false;
  for (var g in SHOWS) if (SHOWS[g].indexOf(it.garment) >= 0) return $('show_' + g).checked; return true;
}
function ribbonMesh() {   // the strip as drawn (width along the auto/rolled orientation), a two-sided plain mesh in the scene
  var D = ST.D, n = D.length, pos = new Float32Array(n * 6), nrm = new Float32Array(n * 6), w = spec.w / 2;
  D.forEach(function (d, i) { [-1, 1].forEach(function (s, k) { pos.set(V.add(d.p, V.mul(d.w, s * w)), (i * 2 + k) * 3); nrm.set(d.n, (i * 2 + k) * 3); }); });
  if (!ribbon || ribbon.n !== n) {
    var idx = new Uint32Array((n - 1) * 6); for (var i = 0; i < n - 1; i++) idx.set([i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2], i * 6);
    var it = { g: A.upload({ pos: pos, nrm: nrm, idx: idx }, true), prog: 'plain', world: true, cull: false, n: n, set: A.plainSet({ alb: [0.82, 0.55, 0.22], rough: 0.5, metal: 0 }) };
    if (ribbon) ITEMS.splice(ITEMS.indexOf(ribbon), 1); ribbon = it; ITEMS.push(it);
  } else ribbon.g.update(pos, nrm);
}

/* ---------- camera, projection, picking ---------- */
function camBasis() { var C = A.camMatrices(null), f = V.norm(V.sub(A.cam.tgt, C.eye)), r = V.norm(V.cross(f, [0, 1, 0])); return { C: C, eye: C.eye, f: f, r: r, u: V.cross(r, f) }; }
function project(p, C) { var m = C.vp, x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15], s = A.size(); return [(x / w * 0.5 + 0.5) * s[0], (1 - (y / w * 0.5 + 0.5)) * s[1], w]; }
function frameAt(i) { if (space === 'world' || !ST) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]]; var a = ST.at(ST.knots[i]); return [a.t, a.w, a.n]; }   // local: along, across, normal
function gizmo() { if (sel < 0 || view !== 'path') return null; return { c: spec.points[sel], s: A.cam.dist * 0.08, ax: frameAt(sel) }; }
function pickPoint(x, y) { var C = A.camMatrices(null), best = -1, bd = 10 * dpr(); spec.points.forEach(function (p, i) { var q = project(p, C), d = Math.hypot(q[0] - x, q[1] - y); if (q[2] > 0 && d < bd) { bd = d; best = i; } }); return best; }
function pickHandle(x, y) {
  var G = gizmo(); if (!G) return null; var C = A.camMatrices(null), c = project(G.c, C), best = null, bd = 12 * dpr();
  var segd = function (a, b) { var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)); return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t); };
  G.ax.forEach(function (a, i) { var d = segd(project(V.add(G.c, V.mul(a, G.s * 0.3)), C), project(V.add(G.c, V.mul(a, G.s)), C)); if (d < bd) { bd = d; best = i; } });
  if (Math.hypot(x - c[0], y - c[1]) < 7 * dpr()) best = -1;   // the centre: move in the screen plane
  return best === null ? null : { axis: best };
}
function frameSel() { var P = sel >= 0 ? [spec.points[sel]] : spec.points, c = [0, 0, 0]; P.forEach(function (p) { c = V.add(c, V.mul(p, 1 / P.length)); }); A.cam.tgt = c; if (sel >= 0) A.cam.dist = Math.min(A.cam.dist, 1.2); dirty = true; }
A.canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
A.canvas.addEventListener('mousedown', function (e) {
  var x = e.offsetX * dpr(), y = e.offsetY * dpr(), h = e.button === 0 && !e.shiftKey ? pickHandle(x, y) : null;
  if (h) { snapshot(); drag = { kind: 'gizmo', axis: h.axis, x: x, y: y, p0: spec.points[sel].slice(), G: gizmo() }; return; }
  drag = { kind: e.button === 2 || e.button === 1 || e.shiftKey || e.altKey ? 'pan' : 'orbit', x: x, y: y, az: A.cam.az, el: A.cam.el, tgt: A.cam.tgt.slice() };
});
window.addEventListener('mousemove', function (e) {
  var r = A.canvas.getBoundingClientRect(), x = (e.clientX - r.left) * dpr(), y = (e.clientY - r.top) * dpr();
  if (!drag) { if (e.target !== A.canvas) return; var h = pickHandle(x, y); if ((h && h.axis) !== (hover && hover.axis)) { hover = h; A.canvas.style.cursor = h ? 'grab' : ''; dirty = true; } return; }
  if (drag.kind === 'orbit') { A.cam.az = drag.az - (x - drag.x) * 0.25 / dpr(); A.cam.el = Math.max(-80, Math.min(80, drag.el + (y - drag.y) * 0.2 / dpr())); }
  else if (drag.kind === 'pan') { var b = camBasis(), k = A.cam.dist * 0.0012 / dpr(); A.cam.tgt = V.add(drag.tgt, V.add(V.mul(b.r, -(x - drag.x) * k), V.mul(b.u, (y - drag.y) * k))); }
  else { var G = drag.G, C = A.camMatrices(null), d;
    if (drag.axis >= 0) { var a = G.ax[drag.axis], c0 = project(G.c, C), e1 = project(V.add(G.c, V.mul(a, G.s)), C), ex = e1[0] - c0[0], ey = e1[1] - c0[1]; d = V.mul(a, ((x - drag.x) * ex + (y - drag.y) * ey) / (ex * ex + ey * ey || 1) * G.s); }
    else { var bb = camBasis(), k2 = 2 * Math.tan(A.cam.fov * Math.PI / 360) * V.dot(V.sub(G.c, bb.eye), bb.f) / A.size()[1]; d = V.add(V.mul(bb.r, (x - drag.x) * k2), V.mul(bb.u, -(y - drag.y) * k2)); }
    spec.points[sel] = V.add(drag.p0, d).map(r4); drag.moved = true; changed(); }
  dirty = true;
});
window.addEventListener('mouseup', function (e) {
  if (!drag) return; var r = A.canvas.getBoundingClientRect(), x = (e.clientX - r.left) * dpr(), y = (e.clientY - r.top) * dpr();
  if (drag.kind === 'gizmo' && !drag.moved) undo.pop();
  if (drag.kind === 'orbit' && Math.hypot(x - drag.x, y - drag.y) < 4 && view === 'path') { sel = pickPoint(x, y); panel(); }
  drag = null; dirty = true;
});
A.canvas.addEventListener('wheel', function (e) { A.cam.dist = Math.max(0.15, Math.min(8, A.cam.dist * Math.exp(e.deltaY * 0.001))); dirty = true; e.preventDefault(); }, { passive: false });
A.canvas.addEventListener('dblclick', function () { A.cam.tgt = [0, 1.0, 0]; A.cam.dist = 3.4; A.cam.az = 25; A.cam.el = 8; dirty = true; });
window.addEventListener('keydown', function (e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return; var k = e.key.toLowerCase();
  if ((e.metaKey || e.ctrlKey) && k === 'z') { (e.shiftKey ? doRedo : doUndo)(); e.preventDefault(); }
  else if (k === 'q') setSpace(space === 'world' ? 'local' : 'world'); else if (k === 'f') frameSel(); else if (k === 'i') insertAfter();
  else if (k === 'delete' || k === 'backspace') delPoint(); else if (k === 'escape') { sel = -1; panel(); } else if (k === ' ') { play(); e.preventDefault(); }
  dirty = true;
});
function doUndo() { if (undo.length) { redo.push(key()); restore(undo.pop()); } }
function doRedo() { if (redo.length) { undo.push(key()); restore(redo.pop()); } }
function setSpace(s) { space = s; $('space').textContent = s + ' axes'; $('space').className = s === 'local' ? 'on' : ''; dirty = true; }

/* ---------- overlay: the curve, points, pins, gizmo; the problems on the simulated shawl ---------- */
var buf = gl.createBuffer(), vao = gl.createVertexArray();
gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12); gl.bindVertexArray(null);
function overlay(C) {
  var L = [], Pt = [], Tr = [], b = camBasis(), push = function (A2, p, c) { A2.push(p[0], p[1], p[2], c[0], c[1], c[2], c[3]); }, line = function (a, c2, col) { push(L, a, col); push(L, c2, col); };
  var path = view === 'path', D = ST.D, w = spec.w / 2, cy = [0.3, 0.9, 1, 1];
  for (var i = 1; i < D.length; i++) { line(D[i - 1].p, D[i].p, path ? [1, 0.85, 0.35, 0.95] : [1, 0.85, 0.35, 0.3]); if (path && i % 3 === 0) { line(V.add(D[i - 3].p, V.mul(D[i - 3].w, w)), V.add(D[i].p, V.mul(D[i].w, w)), [1, 0.7, 0.3, 0.35]); line(V.add(D[i - 3].p, V.mul(D[i - 3].w, -w)), V.add(D[i].p, V.mul(D[i].w, -w)), [1, 0.7, 0.3, 0.35]); } }
  spec.points.forEach(function (p, j) {
    var q = pinAt(j), s = A.cam.dist * 0.008; push(Pt, p, j === sel ? [1, 0.55, 0.15, 1] : q ? cy : [1, 1, 1, path ? 1 : 0.35]);
    if (!q) return; var tp = V.add(p, V.mul(FIG.capNormal(p, CAPS).n, q.offset)), col = q.compliance ? [0.3, 0.9, 1, 0.55] : cy, bi = FIG.shawlBone(sk, Wl, tp, q.bone), bn = sk.bones[bi].name, ch = FIG.PIN_BONES[bn];
    [[b.r, b.u], [b.u, V.mul(b.r, -1)], [V.mul(b.r, -1), V.mul(b.u, -1)], [V.mul(b.u, -1), b.r]].forEach(function (e) { line(V.add(tp, V.mul(e[0], s * 1.6)), V.add(tp, V.mul(e[1], s * 1.6)), col); });   // a diamond: pins
    var a = Wl.p[bi], c2 = ch ? Wl.p[sk.by[ch]] : a, ab = V.sub(c2, a), t = Math.max(0, Math.min(1, V.dot(V.sub(tp, a), ab) / (V.dot(ab, ab) || 1))); line(tp, V.add(a, V.mul(ab, t)), [0.3, 0.9, 1, 0.3]); if (q.offset) line(p, tp, col);
  });
  var G = gizmo(); if (G) G.ax.forEach(function (a, k) { var col = hover && hover.axis === k ? [1, 1, 0.35, 1] : [k === 0 ? 1 : 0.25, k === 1 ? 1 : 0.25, k === 2 ? 1 : 0.3, 1], e2 = V.add(G.c, V.mul(a, G.s)), F = [V.norm(V.cross(a, Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]))]; F.push(V.cross(a, F[0]));
    line(G.c, e2, col); for (var k2 = 0; k2 < 4; k2++) line(e2, V.add(V.add(G.c, V.mul(a, G.s * 0.8)), V.mul(F[k2 % 2], (k2 < 2 ? 1 : -1) * G.s * 0.06)), col); });
  if (!path && ISS && (simState === 'song' || simState === 'settled')) {   // red: pierced triangles, crossing edges
    var P = gsim.cloth.positions, Z = fig.garb.issues, red = [1, 0.2, 0.15, 0.85], X = function (v) { return [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]; };
    ISS.pierced.forEach(function (t) { for (var k = 0; k < 3; k++) push(Tr, X(Z.S[t * 3 + k]), red); });
    ISS.crossing.forEach(function (e) { line(X(Z.E[e * 2]), X(Z.E[e * 2 + 1]), [1, 0.15, 0.1, 1]); });
  }
  var arr = new Float32Array(L.concat(Tr, Pt)), nl = L.length / 7, nt = Tr.length / 7, np = Pt.length / 7;
  gl.useProgram(A.P.line.p); gl.uniformMatrix4fv(A.P.line.u.uVP, false, C.vp); gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
  gl.drawArrays(gl.LINES, 0, nl); if (nt) gl.drawArrays(gl.TRIANGLES, nl, nt); if (np) gl.drawArrays(gl.POINTS, nl + nt, np);
  gl.disable(gl.BLEND); gl.bindVertexArray(null);
}

/* ---------- panel ---------- */
function num(id, v) { var el = $(id); if (document.activeElement !== el) el.value = v; }
function panel() {
  ['w', 'spacing'].forEach(function (k) { num(k, spec[k]); }); ['mass', 'bend', 'friction'].forEach(function (k) { num(k, spec.fabric[k]); }); $('pose').value = spec.pose;
  $('len').textContent = ST.L.toFixed(2) + ' m'; var e0 = ST.at(0), e1 = ST.at(ST.L), lo = function (a) { return Math.min(a.p[1] + a.w[1] * spec.w / 2, a.p[1] - a.w[1] * spec.w / 2); };
  $('ends').textContent = lo(e0).toFixed(2) + ' / ' + lo(e1).toFixed(2) + ' m';
  ['ins', 'del'].forEach(function (k) { $(k).disabled = k === 'del' ? sel < 0 || spec.points.length <= 2 : false; });
  var el = $('pt'); if (sel < 0) { el.innerHTML = '<div class="row" style="color:var(--mute)">' + spec.points.length + ' points, ' + spec.pins.length + ' pins · click a point to edit it</div>'; return; }
  var p = spec.points[sel], q = pinAt(sel), auto = q ? sk.bones[FIG.shawlBone(sk, Wl, p, 'auto')].name : '';
  var html = '<div class="row"><b>point ' + sel + '</b><span style="color:var(--mute)">of ' + spec.points.length + '</span></div>' +
    '<div class="grid"><label>x y z</label><input type="number" step="0.005" data-k="x" value="' + p[0] + '"><input type="number" step="0.005" data-k="y" value="' + p[1] + '"><input type="number" step="0.005" data-k="z" value="' + p[2] + '"></div>' +
    '<div class="grid"><label>roll °</label><input type="number" step="5" data-k="roll" value="' + spec.roll[sel] + '" title="twist of the strip about the curve (0 = auto: flat side to the nearest surface)"></div>' +
    '<div class="row"><label><input type="checkbox" data-k="pin"' + (q ? ' checked' : '') + '> pin</label>';
  if (q) html += '<select data-k="bone"><option value="auto">auto (' + auto + ')</option>' + Object.keys(FIG.PIN_BONES).map(function (b) { return '<option' + (q.bone === b ? ' selected' : '') + '>' + b + '</option>'; }).join('') + '</select></div>' +
    '<div class="row"><select data-k="strength"><option value="rigid">rigid</option><option value="loose"' + (q.compliance ? ' selected' : '') + '>loose</option></select>' +
    '<label>compliance</label><input type="number" step="0.01" min="0" data-k="compliance" value="' + q.compliance + '"' + (q.compliance ? '' : ' disabled') + ' title="m/N: how far the pin gives under 1 N"></div>' +
    '<div class="row"><label>offset</label><input type="number" step="0.005" data-k="offset" value="' + q.offset + '" title="m: off the drawn point, away from the body"></div>';
  else html += '</div>';
  el.innerHTML = html;
}
$('pt').addEventListener('change', function (e) {
  var k = e.target.getAttribute('data-k'), v = e.target.type === 'checkbox' ? e.target.checked : e.target.value, q = pinAt(sel); if (!k || sel < 0) return; snapshot();
  if (k === 'x' || k === 'y' || k === 'z') spec.points[sel]['xyz'.indexOf(k)] = +v; else if (k === 'roll') spec.roll[sel] = +v;
  else if (k === 'pin') { if (v) spec.pins.push({ i: sel, bone: 'auto', compliance: 0, offset: 0 }); else spec.pins.splice(spec.pins.indexOf(q), 1); spec.pins.sort(function (a, b) { return a.i - b.i; }); }
  else if (k === 'bone') q.bone = v; else if (k === 'strength') q.compliance = v === 'loose' ? 0.02 : 0; else if (k === 'compliance') q.compliance = Math.max(0, +v); else if (k === 'offset') q.offset = +v;
  changed();
});
['w', 'spacing', 'mass', 'bend', 'friction'].forEach(function (k) { $(k).onchange = function () { var v = +this.value; if (!(v > 0) && k !== 'friction') return panel(); snapshot(); if (k === 'w' || k === 'spacing') spec[k] = v; else spec.fabric[k] = v; changed(); }; });
$('pose').onchange = function () { setPose(this.value); };
$('vPath').onclick = function () { setView('path'); }; $('vSim').onclick = function () { if (simState === 'settled' || simState === 'song') setView('sim'); else settle(); };
$('undo').onclick = doUndo; $('redo').onclick = doRedo; $('ins').onclick = insertAfter; $('del').onclick = delPoint; $('addS').onclick = function () { append(false); }; $('addE').onclick = function () { append(true); };
$('space').onclick = function () { setSpace(space === 'world' ? 'local' : 'world'); };
$('settle').onclick = settle; $('play').onclick = play; $('time').onchange = function () { scrub(+this.value); };
$('xBody').onchange = $('xGarb').onchange = applyView;
$('poem').onchange = function () { pause(); var i = +this.value; busy('composing…', function () { compose(i); T = 0; if (simState === 'song') { simState = ''; setView('path'); } $('time').max = perf.dur; status(''); }); };
$('exp').onclick = function () {
  var r = function (x) { return +(+x).toFixed(4); }, s = '{\n  "version": 1, "pose": "' + spec.pose + '", "w": ' + r(spec.w) + ', "spacing": ' + r(spec.spacing) + ',\n  "fabric": ' + JSON.stringify(spec.fabric) + ',\n' +
    '  "pins": [' + spec.pins.map(function (q) { return JSON.stringify({ i: q.i, bone: q.bone, compliance: r(q.compliance), offset: r(q.offset) }); }).join(', ') + '],\n  "roll": ' + JSON.stringify(spec.roll.map(r)) + ',\n' +
    '  "points": [\n' + spec.points.map(function (p) { return '    ' + JSON.stringify(p.map(r)); }).join(',\n') + '\n  ]\n}\n';
  var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([s], { type: 'application/json' })); a.download = 'shawl.tang.json'; a.click(); status('exported shawl.tang.json: put it in the project folder for the stage, tool/video.js and tool/check.js');
};
$('imp').onclick = function () { $('file').click(); };
$('file').onchange = function () { var f = this.files[0]; if (!f) return; f.text().then(function (t) { var o = JSON.parse(t); if (!o.points || o.points.length < 2) throw new Error('no points'); snapshot(); var re = (o.pose === 'rest' ? 'rest' : 'A') !== spec.pose; spec = fill(o); sel = -1; if (re) redress(); else changed(); status('imported ' + f.name); }).catch(function (e) { status('import failed: ' + e.message); }); this.value = ''; };

/* ---------- start ---------- */
function compose(i) { var P = SING.POEMS[i], song = SING.compose(P.text, DICT, { seed: 1 }), r = SING.render(song, { voice: 'woman', seed: 1 }); perf = FIG.perform(song, r.syls, { seed: 1, fig: fig, style: 'tang' }); }
Object.keys(SHOWS).forEach(function (g) { var l = document.createElement('label'); l.innerHTML = '<input type="checkbox" id="show_' + g + '" checked> ' + g; $('shows').appendChild(l); l.firstChild.onchange = function () { dirty = true; }; });
SING.POEMS.forEach(function (p, i) { var o = document.createElement('option'); o.value = i; o.textContent = p.title; $('poem').appendChild(o); });
A.cam.tgt = [0, 1.0, 0]; A.cam.dist = 3.4; A.cam.az = 25; A.cam.el = 8; A.cam.fov = 28;
status('loading…');
Promise.all([fetch('speech/mc_dict.json').then(function (r) { return r.json(); }), A.loadFigure(), import('./cloth_sim/cloth.js?v=' + FIG.BUILD_VERSION), fetch('shawl.tang.json').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })]).then(function (res) {
  DICT = res[0]; DEF = FIG.styleDef(res[1], 'tang'); FIG.setClothLib(res[2]); res[2].warmup(); var file = res[3];
  return A.prebuildGeometry({ def: DEF, costume: 'tang' }).then(function (pre) {
    busy('assembling…', function () {
      fig = A.buildFigure(DEF, pre, null); sk = fig.sk; var pg = $('progress'); if (pg) pg.remove(); Wb = FIG.bindW(sk); gsim = fig.gsim; ITEMS = A.scene.items.slice(); compose(0); $('time').max = perf.dur;
      busy(file ? 'loading shawl.tang.json…' : 'the built-in shawl…', function () {
        spec = fill(JSON.parse(JSON.stringify(file || FIG.SHAWL_DEF.tang)));
        busy('dressing the figure…', function () { rebuild(); dress(); changed(); setView('path'); status(file ? 'loaded shawl.tang.json' : 'started from the built-in shawl (figure.js SHAWL_DEF; no shawl.tang.json)'); window.SHAWL_READY = true; });
      });
    });
  });
}).catch(function (e) { status('failed: ' + e.message); console.error(e); });
(function loop() {
  if (playing) { T = Math.min(T + FIG.GDT, perf.dur); gsim.advance(poseAt, T); showSim(); if (T >= perf.dur) pause(); }
  if (dirty && ST) { dirty = false; A.scene.items = ITEMS.filter(visible); A.render(null, overlay); }
  requestAnimationFrame(loop);
})();
// for tests (tool/shawl_test.js): the state and actions
window.SHAWL = { spec: function () { return spec; }, select: function (i) { sel = i; panel(); dirty = true; }, settle: settle, play: play, pause: pause, scrub: scrub, view: setView, state: function () { return { simState: simState, T: T, playing: playing, iss: ISS && { pierced: ISS.pierced.length, crossing: ISS.crossing.length }, built: built === key() }; }, project: function (p) { return project(p, A.camMatrices(null)); }, gizmo: gizmo };
})();
