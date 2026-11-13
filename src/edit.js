/* edit.js — a small editor for figure.json (the body's SDF primitives and the skeleton's joints), built on figure.js
   and the stage renderer. Select primitives and joints in the viewport or the hierarchy (⇧/⌘ to add, ⇧/⌘-drag for a
   box); the gizmo (W move / E rotate / R scale; the centre handle scales uniformly) acts on the whole selection around
   its pivot. With L/R mirror on, every edit stays symmetric: partners follow, centre pieces stay on x = 0.
   The surface is re-polygonized in a worker after each edit (on mouse-up); joint edits only re-rig. */
(function () {
'use strict';
var $ = function (id) { return document.getElementById(id); }, A = window.STAGE_API, gl = A.gl, V = FIG.v3;
var STYLE = /[?&]style=song\b/.test(location.search) ? 'song' : 'tang';   // ?style=song: the Song (宋) costume and makeup
$('style').value = STYLE; $('style').onchange = function () { location.search = this.value === 'song' ? '?style=song' : ''; };
var DEF = null, sk = null, tree = null, leafById = {}, IDX = {}, GROUPS = [], sel = new Set(), primary = null, mode = 'T', undo = [], redo = [], W = null, posed = false;
var bodyItem = null, eyeItems = [], body = null, stray = [], probVerts = [], dirty = true, building = false, pending = false, buildId = 0, collapsed = new Set(), selGroup = null;
var status = function (s) { $('status').textContent = s; };
var mx = function (v) { return [-v[0], v[1], v[2]]; }, mirName = function (b) { return b ? b.replace(/L$/, '§').replace(/R$/, 'L').replace(/§$/, 'R') : b; };
var isP = function (k) { return k[0] === 'p'; }, isD = function (k) { return k[0] === 'd'; }, isJ = function (k) { return k[0] === 'j'; }, keyId = function (k) { return k.slice(2); };
var decal = function (name) { return (DEF.decals || []).find(function (d) { return d.name === name; }); };
var toS = function (c) { return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }, toL = function (c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
function mirrorDecal(d, into) { var q = into || {}; if (!('style' in d)) delete q.style; for (var k in d) if (k !== 'name' && k !== 'mirror') q[k] = JSON.parse(JSON.stringify(d[k])); ['c', 'u', 'v', 'n'].forEach(function (k) { q[k] = mx(d[k]); }); return q; }
function decalsChanged() { A.setDecals(DEF.decals || []); dirty = true; }

/* ---------- definition bookkeeping ---------- */
// the edited tree: the body, and this style's hair masses (hair.<key>.masses: buns, side / back hair as primitives)
var HKEY = 'tang', EROOT = null;
function hairG() { var H = DEF.hair && DEF.hair[HKEY]; return H ? H.masses : null; }
function index() {   // prim id → {p, parent}; groups with a path id and their prims
  IDX = {}; GROUPS = []; var hg = hairG(); EROOT = { group: 'figure', op: 'union', k: 0, kids: hg ? [DEF.body, hg] : [DEF.body] };
  if ((DEF.cords || []).length) EROOT.kids.push({ group: 'cords (silk cords tying the hair; place with the gizmo)', op: 'union', k: 0, kids: DEF.cords.map(function (o) { return o.place; }) });
  if ((DEF.ornaments || []).length) EROOT.kids.push({ group: 'ornaments (the gizmo places, rotates and scales them)', op: 'union', k: 0, kids: DEF.ornaments.map(function (o) { return o.place; }) });
  (function walk(g, path) {
    var G = { g: g, path: path, prims: [] }; GROUPS.push(G);
    g.kids.forEach(function (k, i) { if (k.kids) { var sub = walk(k, path + '.' + i); G.prims = G.prims.concat(sub.prims); } else { IDX[k.id] = { p: k, parent: g, gpath: path }; G.prims.push(k.id); } });
    return G;
  })(EROOT, '0');
}
function maxId() { var m = 0; for (var k in IDX) m = Math.max(m, +k); return m; }
function snapshot() { undo.push(JSON.stringify(DEF)); if (undo.length > 100) undo.shift(); redo = []; }
function restore(json) { DEF = JSON.parse(json); reload(); }
function reload(keepMesh) {
  FIG.load(DEF); sk = FIG.Skeleton(DEF); A.setFig({ sk: sk }); index();
  sel.forEach(function (k) { if (isP(k) ? !IDX[keyId(k)] : isD(k) ? !decal(keyId(k)) : sk.by[keyId(k)] === undefined) sel.delete(k); });
  decalsChanged();
  refreshTree(); rebuildTree(); fields(); poseNow();
  if (!keepMesh) requestBuild(); else { requestHair(); rebuildOrnaments(); }   // (hair and ornaments follow every edit)
}
function rebuildTree() {
  try { tree = FIG.treeFromJSON(DEF.body, sk); } catch (e) { status('error: ' + e.message); return; }
  leafById = {}; (function walk(n) { if (n.op) n.kids.forEach(walk); else leafById[n.pid] = n; })(tree);
  var hg = hairG(); if (hg) try { (function walk(n) { if (n.op) n.kids.forEach(walk); else leafById[n.pid] = n; })(FIG.treeFromJSON(hg, sk)); } catch (e) { status('hair error: ' + e.message); }
  (DEF.ornaments || []).concat(DEF.cords || []).forEach(function (o) { try { var l = FIG.treeFromJSON(o.place, sk); leafById[l.pid] = l; } catch (e) {} });
  dirty = true;
}
function mirrorOf(p, into) {   // write the mirror image of prim p into `into` (keeps into's id and bone)
  var q = into || {};
  q.type = p.type; ['sig', 'mat'].forEach(function (k) { if (p[k] !== undefined) q[k] = p[k]; else delete q[k]; });
  ['c', 'a', 'b', 'u', 'v'].forEach(function (k) { if (p[k]) q[k] = mx(p[k]); else delete q[k]; });
  ['r', 'ra', 'rb', 's', 'capA', 'capB', 't'].forEach(function (k) { if (p[k] !== undefined) q[k] = JSON.parse(JSON.stringify(p[k])); else delete q[k]; });
  if (p.type === 'special') { q.name = p.name; q.side = -p.side; }
  return q;
}
function isCentre(p) { return !p.mirror && Math.abs(center(p)[0]) < 1e-4; }
function symmetrize(p) {   // keep a centre piece mirror-symmetric (x = 0, one axis along x or both in the yz plane)
  if (p.c) p.c[0] = 0; if (p.a) { p.a[0] = 0; p.b[0] = 0; }
  if (p.type === 'cone') { if (p.u) { var cw = V.norm(V.sub(p.b, p.a)); p.u = Math.abs(p.u[0]) > 0.5 ? [Math.sign(p.u[0]), 0, 0] : V.norm(V.sub([0, p.u[1], p.u[2]], V.mul(cw, V.dot([0, p.u[1], p.u[2]], cw)))); } return; }
  if (p.u) {
    var u = V.norm(p.u), v = V.norm(p.v), w = V.cross(u, v), ax = [Math.abs(u[0]), Math.abs(v[0]), Math.abs(w[0])], yz = function (e) { return V.norm([0, e[1], e[2]]); };
    if (ax[0] >= ax[1] && ax[0] >= ax[2]) { p.u = [Math.sign(u[0]) || 1, 0, 0]; p.v = yz(v); }
    else if (ax[1] >= ax[2]) { p.v = [Math.sign(v[0]) || 1, 0, 0]; p.u = yz(u); }
    else { p.u = yz(u); var vv = yz(v); p.v = V.norm(V.sub(vv, V.mul(p.u, V.dot(vv, p.u)))); }
  }
}

/* ---------- surface: polygonized in a worker ---------- */
var worker = new Worker(URL.createObjectURL(new Blob(["importScripts('" + new URL('figure.js', location.href) + "');\n" +
  "onmessage = function (e) { var d = e.data; try { FIG.load(d.def); var sk = FIG.Skeleton(d.def), t = Date.now(), m = FIG.buildBody(sk, { def: d.def, res: d.res }, function () {});\n" +
  " var c = FIG.components(m.pos.length / 3, m.idx), bl = FIG.boundaryLoops(m).length;\n" +
  " postMessage({ id: d.id, pos: m.pos, nrm: m.nrm, idx: m.idx, bi: m.bi, bw: m.bw, aux: m.aux, ms: Date.now() - t, comps: c.count, label: c.label, loops: bl }); } catch (err) { postMessage({ id: d.id, error: String(err) }); } };"], { type: 'text/javascript' })));
function requestBuild() { requestHair(); rebuildOrnaments(); if (building) { pending = true; return; } building = true; status('polygonizing…'); worker.postMessage({ id: ++buildId, def: DEF, res: { body: +$('res').value.split(',')[0], fine: +$('res').value.split(',')[1] } }); }
worker.onmessage = function (e) {
  var d = e.data; building = false;
  if (d.error) status('build failed: ' + d.error);
  else {
    body = { pos: d.pos, nrm: d.nrm, idx: d.idx, bi: d.bi, bw: d.bw, aux: d.aux, label: d.label, comps: d.comps };
    var g = A.upload(body);
    if (bodyItem) bodyItem.g = g; else { bodyItem = { g: g, prog: 'skin', cull: true, set: function (pr) { gl.uniform1i(pr.u.uHeatBone, +$('heat').value); } }; A.scene.items.push(bodyItem); }
    refreshEyes();
    stray = []; if (d.comps > 1) { var size = {}; for (var i = 0; i < d.label.length; i++) size[d.label[i]] = (size[d.label[i]] || 0) + 1; var main = Object.keys(size).sort(function (a, b) { return size[b] - size[a]; })[0]; for (i = 0; i < d.label.length; i++) if (d.label[i] != main) stray.push(i); }
    status((d.pos.length / 3) + ' verts in ' + d.ms + ' ms · ' + (d.comps === 1 && !d.loops ? 'one closed surface' : d.comps + ' component(s), ' + d.loops + ' open loop(s) — stray pieces in red'));
    probVerts = []; dirty = true;
  }
  if (pending) { pending = false; requestBuild(); }
};
/* ---------- SVG ornaments: built here (finer on the stage), one plain item per part ---------- */
var ornItems = [];
function ornamentOf(k) { if (!k || !isP(k)) return null; var id = +keyId(k); return (DEF.ornaments || []).concat(DEF.cords || []).find(function (o) { return o.place && o.place.id === id; }) || null; }
function isCord(o) { return (DEF.cords || []).indexOf(o) >= 0; }
function rebuildOrnaments() {
  ornItems.forEach(function (it) { A.scene.items.splice(A.scene.items.indexOf(it), 1); }); ornItems = [];
  if (!(DEF.ornaments || []).length && !(DEF.cords || []).length) { dirty = true; return; }
  var HF = null; try { HF = FIG.hairSdf(DEF, HKEY); FIG.load(DEF); } catch (e) {}
  (DEF.cords || []).forEach(function (o, i) { var parts = []; try { FIG.buildCord(o, i, function (name, parent, mesh) { parts.push(mesh); }, sk.by, HF); } catch (e) { status('cord ' + (o.name || i) + ': ' + e.message); }
    parts.forEach(function (m) { var it = { g: A.upload(m), prog: 'plain', cull: true, set: A.plainSet(A.MATS[m.mat] || A.MATS.cord) }; ornItems.push(it); A.scene.items.push(it); }); });
  (DEF.ornaments || []).forEach(function (o, i) { var parts = [];
    try { FIG.buildPiece(Object.assign({}, o, { res: Math.max(o.res || 0.0005, 0.0008) }), i, function (name, parent, mesh) { parts.push(mesh); }, sk.by, sk.O, HF); } catch (e) { status('ornament ' + (o.name || i) + ': ' + e.message); }
    parts.forEach(function (m) { var it = { g: A.upload(m), prog: 'plain', cull: true, set: A.plainSet(A.MATS[m.mat] || A.MATS.pearl) }; ornItems.push(it); A.scene.items.push(it); }); });
  dirty = true;
}
function ornamentPanel() {
  var o = ornamentOf(primary), el = $('ornPanel'); if (!el) return; if (!o) { el.innerHTML = ''; return; }
  if (isCord(o)) { var nc = function (lab, k, v, st) { return '<label>' + lab + '</label><input type="number" step="' + st + '" data-o="' + k + '" value="' + v + '" style="width:64px">'; };
    el.innerHTML = '<div class="row"><b>cord ' + (o.name || '') + '</b><span style="color:var(--mute)">loop round the handle\'s v axis; radii r[0] / r[2] (scale with the gizmo)</span></div>' +
      '<div class="row">' + nc('wraps', 'wraps', o.wraps || 1, 1) + nc('thickness', 'thickness', o.thickness || 0.003, 0.0005) + '<label>colour</label><input type="color" data-o="color" value="' + (o.color || '#b4383c') + '">' + '</div>' +
      '<div class="row"><label><input type="checkbox" data-o="seat"' + (o.seat !== false ? ' checked' : '') + '> seat on the hair</label><label><input type="checkbox" data-o="ends"' + (o.ends ? ' checked' : '') + '> knot and loose ends</label></div>'; return; }
  var P = o.pearls || {}, B = o.bend || {}, n = function (lab, k, v, st) { return '<label>' + lab + '</label><input type="number" step="' + st + '" data-o="' + k + '" value="' + v + '" style="width:64px">'; };
  el.innerHTML = '<div class="row"><b>ornament ' + (o.name || '') + '</b><span style="color:var(--mute)">outline ' + o.shape + ' · width ' + (o.place.r[0] * 2).toFixed(3) + ' m (scale with the gizmo)</span></div>' +
    '<div class="row">' + n('thickness', 'thickness', o.thickness || 0.003, 0.0005) + n('round', 'round', o.round != null ? o.round : 0.001, 0.0002) + n('relief', 'relief', o.relief || 0, 0.0002) + '</div>' +
    '<div class="row">' + n('bend r', 'bend.radius', B.radius || 0, 0.005) + '<label>axis</label><select data-o="bend.axis">' + ['y', 'x', 'sphere'].map(function (a) { return '<option' + ((B.axis || 'y') === a ? ' selected' : '') + '>' + a + '</option>'; }).join('') + '</select>' +
    '<label>material</label><select data-o="material">' + ['jade', 'gold', 'horn'].map(function (a) { return '<option' + ((o.material || 'jade') === a ? ' selected' : '') + '>' + a + '</option>'; }).join('') + '</select></div>' +
    '<div class="row">' + n('pearl r', 'pearls.r', P.r != null ? P.r : 0.0016, 0.0002) + n('gap', 'pearls.gap', P.gap != null ? P.gap : 0.0006, 0.0002) + n('offset', 'pearls.offset', P.offset || 0, 0.0005) + '<label>stalk</label><select data-o="pearls.stalk">' + ['gold', 'thread'].map(function (a) { return '<option' + ((P.stalk || 'gold') === a ? ' selected' : '') + '>' + a + '</option>'; }).join('') + '</select></div>' +
    '<div class="row"><label><input type="checkbox" data-o="mirror"' + (o.mirror ? ' checked' : '') + '> mirror to the other side</label><label><input type="checkbox" data-o="seat"' + (o.seat !== false ? ' checked' : '') + '> seat on the hair</label></div>';
}
document.addEventListener('change', function (e) { var k = e.target.getAttribute && e.target.getAttribute('data-o'); if (!k) return; var o = ornamentOf(primary); if (!o) return; snapshot();
  var path = k.split('.'), obj = o; for (var i = 0; i < path.length - 1; i++) obj = obj[path[i]] = obj[path[i]] || {};
  obj[path[path.length - 1]] = e.target.type === 'checkbox' ? e.target.checked : e.target.tagName === 'SELECT' || e.target.type === 'color' ? e.target.value : +e.target.value; rebuildOrnaments(); });
/* ---------- hair: rebuilt from the edited masses in its own worker (lower resolution, fewer strands while editing) ---------- */
var hairWorker = new Worker(URL.createObjectURL(new Blob(["importScripts('" + new URL('figure.js', location.href) + "');\n" +
  "onmessage = function (e) { var d = e.data; try { FIG.load(d.def); var sk = FIG.Skeleton(d.def), t = Date.now(), h = FIG.buildHair(sk, { headSdf: FIG.headSDF(d.def, sk) }, { hair: d.key, hairRes: d.res, strands: d.strands }, function () {});\n" +
  " postMessage({ id: d.id, cap: h.cap, strands: h.strands, ms: Date.now() - t, pieces: FIG.components(h.cap.pos.length / 3, h.cap.idx).count }); } catch (err) { postMessage({ id: d.id, error: String(err) }); } };"], { type: 'text/javascript' })));
var hairBusy = false, hairPending = false, hairItems = [], hairId = 0;
function requestHair() { if (!$('hairPrev') || !$('hairPrev').checked) { hairItems.forEach(function (it) { A.scene.items.splice(A.scene.items.indexOf(it), 1); }); hairItems = []; dirty = true; return; }
  if (hairBusy) { hairPending = true; return; } hairBusy = true;
  var full = $('hairQ') && $('hairQ').value === 'full'; hairWorker.postMessage({ id: ++hairId, def: DEF, key: HKEY, res: full ? 0.0022 : 0.0035, strands: full ? 0 : 2500 }); }
hairWorker.onmessage = function (e) {
  var d = e.data; hairBusy = false;
  if (d.error) status('hair failed: ' + d.error);
  else { hairItems.forEach(function (it) { A.scene.items.splice(A.scene.items.indexOf(it), 1); });
    var cap = d.cap, st = d.strands; cap.bone = sk.by.head; st.bone = sk.by.head;
    hairItems = [{ g: A.upload(cap), prog: 'hair', cull: true, a2c: true, set: function (pr) { gl.uniform1f(pr.u.uStrand, 0); } }, { g: A.upload(st), prog: 'hair', a2c: true, thin: true, set: function (pr) { gl.uniform1f(pr.u.uStrand, 1); } }];
    hairItems.forEach(function (it) { A.scene.items.push(it); }); dirty = true;
    if (d.pieces > 1) status('hair: ' + d.pieces + ' separate pieces — a mass is not touching the rest (it would float)'); }
  if (hairPending) { hairPending = false; requestHair(); }
};
function refreshEyes() {
  eyeItems.forEach(function (it) { A.scene.items.splice(A.scene.items.indexOf(it), 1); }); eyeItems = [];
  ['L', 'R'].forEach(function (S) { var it = { g: A.upload(FIG.eyeMesh(sk, S)), prog: 'eye', cull: true, set: function (pr) { gl.uniform1f(pr.u.uSide, S === 'L' ? 1 : -1); } }; eyeItems.push(it); A.scene.items.push(it); });
}

/* ---------- poses ---------- */
var perf = null;
function poseNow() {
  var v = $('pose').value, C = FIG.defaultControls();
  if (v === 'bind') { W = FIG.bindW(sk); posed = false; }
  else {
    posed = true;
    if (v === 'song' && perf) C = perf.controls(+$('tpose').value);
    else if (v === 'face') { C.jaw = 0.9; C.lipRound = 0.5; C.blinkL = 1; C.smile = 0.5; }
    else if ((STYLE === 'song' ? FIG.POSES_SONG : FIG.POSES)[v]) { var P = (STYLE === 'song' ? FIG.POSES_SONG : FIG.POSES)[v]; C.armL = P.L; C.armR = P.R; C.spine = P.spine; C.head = P.head; }
    W = FIG.solve(sk, C);
  }
  A.DQ.set(FIG.poseDQ(sk, W)); dirty = true;
  $('tval').textContent = v === 'song' ? (+$('tpose').value).toFixed(2) + ' s' : '';
}
function loadSong() {
  status('composing the song for poses…');
  fetch('speech/mc_dict.json').then(function (r) { return r.json(); }).then(function (d) {
    var sg = SING.compose(SING.POEMS[0].text, d, { seed: 1 }), r = SING.render(sg, { voice: 'woman', seed: 1 });
    perf = FIG.perform(sg, r.syls, { seed: 1, style: STYLE }); $('tpose').max = perf.dur; $('tpose').value = perf.t0 + 1; status(''); poseNow();
  });
}

/* ---------- camera, projection, picking ---------- */
function camBasis() { var C = A.camMatrices(null), eye = C.eye, f = V.norm(V.sub(A.cam.tgt, eye)), r = V.norm(V.cross(f, [0, 1, 0])); return { C: C, eye: eye, f: f, r: r, u: V.cross(r, f) }; }
function project(p, C) {
  var m = C.vp, x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15], s = A.size();
  return [(x / w * 0.5 + 0.5) * s[0], (1 - (y / w * 0.5 + 0.5)) * s[1], w];
}
function ray(px, py) { var b = camBasis(), s = A.size(), t = Math.tan(A.cam.fov * Math.PI / 360), x = (2 * px / s[0] - 1) * t * s[0] / s[1], y = (1 - 2 * py / s[1]) * t; return { o: b.eye, d: V.norm(V.add(b.f, V.add(V.mul(b.r, x), V.mul(b.u, y)))) }; }
var editableJoint = function (n) { return !FIG.FIXED_JOINT.test(n); };
function pickJoint(px, py) {
  if (!$('showBones').checked) return null;
  var C = A.camMatrices(null), best = null, bd = 9 * dpr();
  sk.bones.forEach(function (b, i) { if (!editableJoint(b.name)) return; var q = project(W.p[i], C), d = Math.hypot(q[0] - px, q[1] - py); if (q[2] > 0 && d < bd) { bd = d; best = 'j:' + b.name; } });
  return best;
}
function pickDecal(px, py) {
  if (!$('showDecals').checked) return null;
  var C = A.camMatrices(null), best = null, bd = 12 * dpr(); (DEF.decals || []).forEach(function (d) { var q = project(d.c, C), dd = Math.hypot(q[0] - px, q[1] - py); if (q[2] > 0 && dd < bd) { bd = dd; best = 'd:' + d.name; } }); return best;
}
function pick(px, py) {
  var j = pickJoint(px, py) || pickDecal(px, py); if (j) return j;
  var R = ray(px, py), best = null, bt = 1e9;
  for (var id in leafById) {
    var l = leafById[id], o = R.o, d = R.d;
    if (posed && l.bone != null) { var b = sk.bones[l.bone], qi = FIG.qconj(W.q[l.bone]); o = V.add(b.p, FIG.qrot(qi, V.sub(o, W.p[l.bone]))); d = FIG.qrot(qi, d); }
    var t = 0; for (var i = 0; i < 64 && t < bt; i++) { var p = V.add(o, V.mul(d, t)), dd = l.f(p[0], p[1], p[2]); if (dd < 2e-4) { if (t < bt) { bt = t; best = 'p:' + id; } break; } t += Math.max(dd, 1e-4); if (t > 8) break; }
  }
  return best;
}
function boneXf(bi) { return posed && bi != null ? function (p) { return V.add(W.p[bi], FIG.qrot(W.q[bi], V.sub(p, sk.bones[bi].p))); } : function (p) { return p; }; }
function center(p) { return p.c ? p.c : p.a ? V.lerp(p.a, p.b, 0.5) : leafById[p.id] ? leafById[p.id].c : [0, 1, 0]; }
function itemPos(k) { if (isP(k)) { var p = IDX[keyId(k)].p, l = leafById[p.id]; return boneXf(l ? l.bone : null)(center(p)); } if (isD(k)) return decal(keyId(k)).c; return W.p[sk.by[keyId(k)]]; }

/* ---------- overlay drawing ---------- */
var lineBuf = gl.createBuffer(), lineVao = gl.createVertexArray();
gl.bindVertexArray(lineVao); gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12); gl.bindVertexArray(null);
function circle(L, c, a, b, n, col, xf) { var prev = null; for (var i = 0; i <= n; i++) { var t = i * 2 * Math.PI / n, p = xf(V.add(c, V.add(V.mul(a, Math.cos(t)), V.mul(b, Math.sin(t))))); if (prev) L.push(prev, p, col); prev = p; } }
function coneFrame(p) { var w = V.norm(V.sub(p.b, p.a)), u = p.u ? V.norm(V.sub(p.u, V.mul(w, V.dot(p.u, w)))) : FIG.perpOf(w); return [u, V.cross(w, u), w]; }
function frameOf(dir) { var t = V.norm(V.cross(dir, Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])); return [t, V.cross(dir, t)]; }
function primLines(L, p, col) {
  var l = leafById[p.id], xf = boneXf(l ? l.bone : null);
  if (p.type === 'sphere') { circle(L, p.c, [p.r, 0, 0], [0, p.r, 0], 32, col, xf); circle(L, p.c, [0, p.r, 0], [0, 0, p.r], 32, col, xf); circle(L, p.c, [p.r, 0, 0], [0, 0, p.r], 32, col, xf); }
  else if (p.type === 'ellipsoid' || p.type === 'shell') {
    var u = V.norm(p.u), v = V.norm(V.sub(p.v, V.mul(u, V.dot(p.v, u)))), w = V.cross(u, v), a = V.mul(u, p.r[0]), b = V.mul(v, p.r[1]), c = V.mul(w, p.r[2]);
    circle(L, p.c, a, b, 32, col, xf); circle(L, p.c, b, c, 32, col, xf); circle(L, p.c, a, c, 32, col, xf);
  } else if (p.type === 'cone') {
    var F = coneFrame(p), sx = p.s ? p.s[0] : 1, sy = p.s ? p.s[1] : 1, Fu = V.mul(F[0], sx), Fv = V.mul(F[1], sy);
    circle(L, p.a, V.mul(Fu, p.ra), V.mul(Fv, p.ra), 24, col, xf); circle(L, p.b, V.mul(Fu, p.rb), V.mul(Fv, p.rb), 24, col, xf);
    for (var k = 0; k < 4; k++) { var t = k * Math.PI / 2, d = V.add(V.mul(Fu, Math.cos(t)), V.mul(Fv, Math.sin(t))); L.push(xf(V.add(p.a, V.mul(d, p.ra))), xf(V.add(p.b, V.mul(d, p.rb))), col); }
  } else if (l) { var c2 = l.c, s = 0.006; [[s, 0, 0], [0, s, 0], [0, 0, s]].forEach(function (e) { L.push(xf(V.sub(c2, e)), xf(V.add(c2, e)), col); }); }
}
var space = 'world'; try { space = localStorage.getItem('editSpace') === 'local' ? 'local' : 'world'; } catch (e) {}
function setSpace(sp) { space = sp; try { localStorage.setItem('editSpace', sp); } catch (e) {} $('space').textContent = sp === 'local' ? 'local axes' : 'world axes'; $('space').className = sp === 'local' ? 'on' : ''; dirty = true; fields(); }
function frameOfItem(k) {   // the item's own axes (null: none → world)
  if (!k) return null;
  if (isD(k)) { var d = decal(keyId(k)); return [V.norm(d.u), V.norm(d.v), V.norm(d.n)]; }
  if (isJ(k)) { var bi = sk.by[keyId(k)], ch = sk.bones.find(function (b) { return b.parent === bi; }); if (!ch) return null; var w = V.norm(V.sub(ch.p, sk.bones[bi].p)), u = FIG.perpOf(w); return [u, V.cross(w, u), w]; }
  var p = IDX[keyId(k)].p;
  if (p.type === 'cone') return coneFrame(p);
  if (p.type === 'ellipsoid' || p.type === 'shell') { var u2 = V.norm(p.u), v2 = V.norm(V.sub(p.v, V.mul(u2, V.dot(p.v, u2)))); return [u2, v2, V.cross(u2, v2)]; }
  return null;
}
function gizmo(forceLocal) {   // pivot = mean of the selected items (bind pose only); axes: world, or the active item's frame
  if (!sel.size || posed) return null;
  var c = [0, 0, 0]; sel.forEach(function (k) { c = V.add(c, itemPos(k)); });
  var ax = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], act = primary && sel.has(primary) ? primary : Array.from(sel).pop();
  var local = forceLocal || space === 'local' || (mode === 'S' && sel.size === 1 && isP(act)), F = local ? frameOfItem(act) : null;
  if (F) ax = F;
  return { c: V.mul(c, 1 / sel.size), s: A.cam.dist * 0.09, ax: ax, local: !!F };
}
function partnerKey(k) { if (isP(k)) { var p = IDX[keyId(k)].p; return p.mirror && IDX[p.mirror] ? 'p:' + p.mirror : null; } if (isD(k)) { var d = decal(keyId(k)); return d && d.mirror && decal(d.mirror) ? 'd:' + d.mirror : null; } var m = mirName(keyId(k)); return m !== keyId(k) && sk.by[m] !== undefined ? 'j:' + m : null; }
function overlay(C) {
  var L = [], pts = [], primsOn = $('showPrims').checked, mir = new Set();
  if ($('mirror').checked) sel.forEach(function (k) { var m = partnerKey(k); if (m) mir.add(m); });
  for (var id in IDX) {
    var k = 'p:' + id, isSel = sel.has(k), isMir = mir.has(k);
    if (!primsOn && !isSel && !isMir) continue;
    primLines(L, IDX[id].p, isSel ? [1, 0.65, 0.25, 1] : isMir ? [1, 0.65, 0.25, 0.45] : (leafById[id] && leafById[id].bone == null) ? [0.4, 0.6, 1, 0.22] : [1, 1, 1, 0.13]);
  }
  if ($('showDecals').checked) (DEF.decals || []).forEach(function (d) {
    var k = 'd:' + d.name, col = sel.has(k) ? [1, 0.65, 0.25, 1] : mir.has(k) ? [1, 0.75, 0.4, 0.6] : [0.95, 0.5, 0.8, 0.5], ex = d.kind === 'blob' ? 2 : 1;
    var U = V.mul(d.u, d.size[0] * ex), Vv = V.mul(d.v, d.size[1] * ex), n0 = V.mul(d.n, d.depth[0]), n1 = V.mul(d.n, d.depth[1] + 0.006), cs = [];
    [n0, n1].forEach(function (nn) { [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (q) { cs.push(V.add(d.c, V.add(nn, V.add(V.mul(U, q[0]), V.mul(Vv, q[1]))))); }); });
    for (var e = 0; e < 4; e++) { L.push(cs[e], cs[(e + 1) % 4], col); L.push(cs[4 + e], cs[4 + (e + 1) % 4], col); L.push(cs[e], cs[4 + e], col); }
    pts.push(d.c, col);
  });
  if ($('showBones').checked) sk.bones.forEach(function (b, i) {
    var k = 'j:' + b.name, col = sel.has(k) ? [1, 0.65, 0.25, 1] : mir.has(k) ? [1, 0.75, 0.4, 0.7] : editableJoint(b.name) ? [0.4, 1, 0.6, 1] : [0.4, 0.6, 0.5, 0.6];
    pts.push(W.p[i], col); if (b.parent >= 0) L.push(W.p[b.parent], W.p[i], [0.4, 1, 0.6, 0.7]);
  });
  var G = gizmo();
  if (G) {
    G.ax.forEach(function (a, i) {
      var col = hover && hover.axis === i ? [1, 1, 0.35, 1] : [i === 0 ? 1 : 0.2, i === 1 ? 1 : 0.2, i === 2 ? 1 : 0.25, 1];
      if (mode === 'R') { var o = G.ax[(i + 1) % 3], q = G.ax[(i + 2) % 3]; circle(L, G.c, V.mul(o, G.s), V.mul(q, G.s), 48, col, function (x) { return x; }); }
      else { var e = V.add(G.c, V.mul(a, G.s)); L.push(G.c, e, col); if (mode === 'S') pts.push(e, col); else { var F = frameOf(a); for (var k2 = 0; k2 < 4; k2++) L.push(e, V.add(V.add(G.c, V.mul(a, G.s * 0.8)), V.mul(k2 % 2 ? F[0] : F[1], (k2 < 2 ? 1 : -1) * G.s * 0.06)), col); } }
    });
    if (mode === 'S') pts.push(G.c, hover && hover.axis === -1 ? [1, 1, 0.35, 1] : [1, 1, 1, 1]);   // centre handle: uniform scale
  }
  if (body) for (var i = 0; i < stray.length; i += 3) pts.push([body.pos[stray[i] * 3], body.pos[stray[i] * 3 + 1], body.pos[stray[i] * 3 + 2]], [1, 0.15, 0.1, 1]);
  probVerts.forEach(function (p) { pts.push(p, [1, 0.1, 0.1, 1]); });
  var arr = [], np = 0;
  for (var j = 0; j < L.length; j += 3) { arr.push.apply(arr, L[j]); arr.push.apply(arr, L[j + 2]); arr.push.apply(arr, L[j + 1]); arr.push.apply(arr, L[j + 2]); }
  var nl = arr.length / 7; for (j = 0; j < pts.length; j += 2) { arr.push.apply(arr, pts[j]); arr.push.apply(arr, pts[j + 1]); np++; }
  gl.useProgram(A.P.line.p); gl.uniformMatrix4fv(A.P.line.u.uVP, false, C.vp); gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.bindVertexArray(lineVao); gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.DYNAMIC_DRAW);
  gl.drawArrays(gl.LINES, 0, nl); if (np) gl.drawArrays(gl.POINTS, nl, np);
  gl.disable(gl.BLEND); gl.bindVertexArray(null);
}

/* ---------- reference image (a plane in the scene) ---------- */
var REF = { tex: null, aspect: 1, item: null };
function refPlane() {
  if (!REF.tex) return;
  var h = +$('refH').value, y0 = +$('refY').value, w = h * REF.aspect, side = $('refView').value === 'side', d = -0.45;
  var P = side ? [[d, y0, w / 2], [d, y0, -w / 2], [d, y0 + h, -w / 2], [d, y0 + h, w / 2]] : [[-w / 2, y0, d], [w / 2, y0, d], [w / 2, y0 + h, d], [-w / 2, y0 + h, d]];
  var m = { pos: new Float32Array([].concat.apply([], P)), nrm: new Float32Array(12), uv: new Float32Array([0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]), idx: new Uint16Array([0, 1, 2, 0, 2, 3]) };
  if (REF.item) A.scene.items.splice(A.scene.items.indexOf(REF.item), 1);
  REF.item = { g: A.upload(m), prog: 'img', world: true, cast: false, set: function (pr) { gl.activeTexture(gl.TEXTURE2); gl.bindSampler(2, null); gl.bindTexture(gl.TEXTURE_2D, REF.tex); gl.uniform1i(pr.u.uTex, 2); gl.uniform1f(pr.u.uOp, +$('refOp').value); } };
  A.scene.items.unshift(REF.item); dirty = true;
}

/* ---------- transforms on the selection ---------- */
// the edit set: selected items (+ joint descendants when "move children" is on); with mirror on, right-side items whose
// partner is also edited become followers (set to the mirror image afterwards), so the result is always symmetric
function editSet() {
  var keys = new Set(sel), mirrorOn = $('mirror').checked;
  if ($('kids').checked) sel.forEach(function (k) { if (!isJ(k)) return; var bi = sk.by[keyId(k)]; sk.bones.forEach(function (b) { for (var q = b.parent; q >= 0; q = sk.bones[q].parent) if (q === bi) { if (editableJoint(b.name)) keys.add('j:' + b.name); break; } }); });
  var lead = [], follow = [];
  keys.forEach(function (k) {
    var m = mirrorOn ? partnerKey(k) : null;
    if (!m) { lead.push(k); return; }
    var x = isP(k) ? center(IDX[keyId(k)].p)[0] : isD(k) ? decal(keyId(k)).c[0] : sk.bones[sk.by[keyId(k)]].p[0];
    if (keys.has(m) && x < 0) follow.push([m, k]); else { lead.push(k); if (!keys.has(m)) follow.push([k, m]); }
  });
  return { lead: lead, follow: follow };
}
function tipsOf(name) { var m = name.match(/^(thumb|index|middle|ring|pinky)3([LR])$/); return m ? m[1] + m[2] : null; }
function startDrag(axis, x, y, G) {
  snapshot();
  var C = A.camMatrices(null), c0 = project(G.c, C), e0 = axis >= 0 ? project(V.add(G.c, V.mul(G.ax[axis], G.s)), C) : [c0[0] + 60, c0[1] - 60];
  var E = editSet(), orig = {};
  E.lead.concat(E.follow.map(function (f) { return f[1]; })).forEach(function (k) { orig[k] = isP(k) ? JSON.parse(JSON.stringify(IDX[keyId(k)].p)) : isD(k) ? JSON.parse(JSON.stringify(decal(keyId(k)))) : sk.bones[sk.by[keyId(k)]].p.slice(); });
  drag = { params: JSON.parse(JSON.stringify(DEF.params)), kind: 'gizmo', axis: axis, axv: axis >= 0 ? G.ax[axis] : null, x: x, y: y, sdir: [e0[0] - c0[0], e0[1] - c0[1]], s: G.s, c: G.c, E: E, orig: orig, tips: JSON.parse(JSON.stringify(DEF.skeleton.tips || {})) };
}
function applyGizmo(dx, dy) {
  var D = drag, sd = D.sdir, l2 = sd[0] * sd[0] + sd[1] * sd[1] || 1, along = (dx * sd[0] + dy * sd[1]) / l2, across = (dx * -sd[1] + dy * sd[0]) / Math.sqrt(l2);
  var ax = D.axv, piv = D.c, mirrorOn = $('mirror').checked;
  var Tp, Tv = function (v) { return v; }, f = Math.exp(along * 1.2), q;
  if (mode === 'T') { if (!ax) return; var d = D.fixed || V.mul(ax, along * D.s); Tp = function (p) { return V.add(p, d); }; }
  else if (mode === 'R') { if (!ax) return; q = FIG.qaxis(ax, across * 0.01 / dpr()); Tp = function (p) { return V.add(piv, FIG.qrot(q, V.sub(p, piv))); }; Tv = function (v) { return FIG.qrot(q, v); }; }
  else Tp = ax ? function (p) { return V.add(p, V.mul(ax, (f - 1) * V.dot(V.sub(p, piv), ax))); } : function (p) { return V.add(piv, V.mul(V.sub(p, piv), f)); };
  var J = DEF.skeleton.joints, tips = DEF.skeleton.tips || (DEF.skeleton.tips = {});
  D.E.lead.forEach(function (k) {
    var o = D.orig[k];
    if (isD(k)) {   // decal: move / turn / resize its projector box
      var dd = decal(keyId(k)); dd.c = Tp(o.c).map(function (x) { return +x.toFixed(6); }); ['u', 'v', 'n'].forEach(function (q) { dd[q] = V.norm(Tv(o[q])).map(function (x) { return +x.toFixed(6); }); });
      if (mode === 'S') { dd.size = [o.size[0] * (ax ? Math.pow(f, Math.abs(V.dot(o.u, ax))) : f), o.size[1] * (ax ? Math.pow(f, Math.abs(V.dot(o.v, ax))) : f)].map(function (x) { return +x.toFixed(6); }); if (ax) dd.depth = o.depth.map(function (x) { return +(x * Math.pow(f, Math.abs(V.dot(o.n, ax)))).toFixed(6); }); }
      if (mirrorOn && !partnerKey(k)) { dd.c[0] = 0; }
      return;
    }
    if (isP(k) && IDX[keyId(k)].p.type === 'special') {   // rigged pieces: edit their rest transform (face parameters)
      var sp = IDX[keyId(k)].p, P0 = D.params, P = DEF.params;
      if (sp.name === 'aperture') {
        var E0 = P0.eyeOpening, Eo = P.eyeOpening, sgn = sp.side || 1;
        if (mode === 'T') { var dl = Tp([0, 0, 0]); Eo.off = [E0.off[0] + dl[0] * sgn, E0.off[1] + dl[1]]; }
        else if (mode === 'R' && ax && Math.abs(ax[2]) > 0.9) Eo.rot = E0.rot + across * 0.01 / dpr() * sgn * Math.sign(ax[2]);
        else if (mode === 'S') { var fx = ax ? Math.pow(f, Math.abs(ax[0])) : f, fy = ax ? Math.pow(f, Math.abs(ax[1])) : f; Eo.wLat = E0.wLat * fx; Eo.wMed = E0.wMed * fx; Eo.up = E0.up * fy; Eo.lo = E0.lo * fy; }
      } else if (/^lip|mouthSlit/.test(sp.name)) {
        var Lo = P.lips, L0 = P0.lips;
        if (mode === 'T') { var dm = Tp([0, 0, 0]); P.mouth = [P0.mouth[0], P0.mouth[1] + dm[1], P0.mouth[2] + dm[2]]; }
        else if (mode === 'S') { var gx = ax ? Math.pow(f, Math.abs(ax[0])) : f, gy = ax ? Math.pow(f, Math.abs(ax[1])) : f, gz = ax ? Math.pow(f, Math.abs(ax[2])) : f;
          Lo.wU = L0.wU * gx; Lo.wL = L0.wL * gx; Lo.slitW = L0.slitW * gx; Lo.thick = L0.thick.map(function (t) { return t * gy; }); Lo.depth = L0.depth.map(function (t) { return t * gz; }); }
      }
      FIG.load(DEF);
      return;
    }
    if (!isP(k)) {   // joint
      var n = keyId(k), np = Tp(o); if (mirrorOn && !partnerKey(k)) np[0] = 0; J[n] = np.map(function (x) { return +x.toFixed(6); });
      var tk = tipsOf(n); if (tk && D.tips[tk]) { var del = V.sub(J[n], o); tips[tk] = V.add(D.tips[tk], del).map(function (x) { return +x.toFixed(6); }); }
      return;
    }
    var p = IDX[keyId(k)].p;
    ['c', 'a', 'b'].forEach(function (kk) { if (o[kk]) p[kk] = Tp(o[kk]); });
    if (o.u) p.u = Tv(o.u); if (o.v) p.v = Tv(o.v);
    if (mode === 'S') {   // sizes: the scaled axis only (uniform from the centre handle)
      if (p.type === 'sphere') p.r = o.r * (ax ? Math.pow(f, 1 / 3) : f);
      else if (p.type === 'ellipsoid') { var u = V.norm(o.u), v = V.norm(o.v), w = V.cross(u, v); p.r = o.r.map(function (r, i) { return ax ? r * Math.pow(f, Math.abs(V.dot([u, v, w][i], ax))) : r * f; }); }
      else if (p.type === 'cone') {   // length comes from the endpoints (Tp); a cross-section axis scales s; the centre handle scales ra, rb
        var CF = coneFrame(o), s0 = o.s || [1, 1];
        if (!ax) { p.ra = o.ra * f; p.rb = o.rb * f; }
        else if (Math.abs(V.dot(CF[2], ax)) < 0.7) { p.u = CF[0]; p.s = [s0[0] * Math.pow(f, Math.abs(V.dot(CF[0], ax))), s0[1] * Math.pow(f, Math.abs(V.dot(CF[1], ax)))].map(function (x) { return +x.toFixed(5); }); }
      }
    }
    if (mirrorOn && isCentre(o)) symmetrize(p);
    ['c', 'a', 'b', 'u', 'v'].forEach(function (kk) { if (p[kk]) p[kk] = p[kk].map(function (x) { return +x.toFixed(6); }); });
    if (Array.isArray(p.r)) p.r = p.r.map(function (x) { return +x.toFixed(6); }); else if (p.r !== undefined) p.r = +p.r.toFixed(6);
  });
  D.E.follow.forEach(function (fk) {   // [leader, follower]
    if (isD(fk[0])) mirrorDecal(decal(keyId(fk[0])), decal(keyId(fk[1])));
    else if (isP(fk[0])) { if (IDX[keyId(fk[0])].p.type !== 'special') mirrorOf(IDX[keyId(fk[0])].p, IDX[keyId(fk[1])].p); }
    else { J[keyId(fk[1])] = mx(J[keyId(fk[0])]); var tk = tipsOf(keyId(fk[0])), tf = tipsOf(keyId(fk[1])); if (tk && tf && tips[tk]) tips[tf] = mx(tips[tk]); }
  });
  var all = D.E.lead.concat(D.E.follow.map(function (x) { return x[1]; }));
  if (all.some(isJ)) { sk = FIG.Skeleton(DEF); A.setFig({ sk: sk }); poseNow(); }
  if (all.some(isD)) decalsChanged();
  rebuildTree();
}

/* ---------- interaction ---------- */
var drag = null, dpr = function () { return A.size()[0] / A.canvas.clientWidth; };
A.canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
A.canvas.addEventListener('mousedown', function (e) {
  var x = e.offsetX * dpr(), y = e.offsetY * dpr(), G = gizmo(), C = A.camMatrices(null), add = e.shiftKey || e.metaKey || e.ctrlKey;
  if (G && e.button === 0 && !add) { var hh = pickHandle(x, y); if (hh) { startDrag(hh.axis, x, y, G); return; } }
  if (e.button === 0 && add) { drag = { kind: 'box', x: x, y: y, x0: x, y0: y, ex: e.clientX, ey: e.clientY }; return; }
  drag = { kind: e.button === 2 || e.button === 1 || e.altKey ? 'pan' : 'orbit', x: x, y: y, x0: x, y0: y, az: A.cam.az, el: A.cam.el, tgt: A.cam.tgt.slice() };
});
// the gizmo handle under the cursor: axis lines (outer 3/4), arrow tips, rings, the centre (scale): ~13 px, nearest wins
function pickHandle(x, y) {
  var G = gizmo(); if (!G) return null;
  var C = A.camMatrices(null), c = project(G.c, C), best = null, bd = 13 * dpr(), segd = function (a, b) { var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)); return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t); };
  if (mode === 'S') { var d0 = Math.hypot(x - c[0], y - c[1]); if (d0 < bd) { bd = d0; best = -1; } }
  G.ax.forEach(function (a, i) {
    var d = 1e9;
    if (mode === 'R') { var o = G.ax[(i + 1) % 3], q = G.ax[(i + 2) % 3], prev = null; for (var k = 0; k <= 48; k++) { var ang = k * Math.PI / 24, pp = project(V.add(G.c, V.add(V.mul(o, G.s * Math.cos(ang)), V.mul(q, G.s * Math.sin(ang)))), C); if (prev) d = Math.min(d, segd(prev, pp)); prev = pp; } }
    else { var e2 = project(V.add(G.c, V.mul(a, G.s)), C), s2 = project(V.add(G.c, V.mul(a, G.s * 0.25)), C); d = Math.min(segd(s2, e2), Math.hypot(x - e2[0], y - e2[1]) * 0.7); }
    if (d < bd) { bd = d; best = i; }
  });
  return best === null ? null : { axis: best };
}
var hover = null;
window.addEventListener('mousemove', function (e) {
  if (!drag) { if (e.target !== A.canvas) return; var hh = pickHandle(e.offsetX * dpr(), e.offsetY * dpr()); if ((hh && hh.axis) !== (hover && hover.axis)) { hover = hh; A.canvas.style.cursor = hh ? 'grab' : ''; dirty = true; } return; }
  var r = A.canvas.getBoundingClientRect(), x = (e.clientX - r.left) * dpr(), y = (e.clientY - r.top) * dpr();
  if (drag.kind === 'orbit') { A.cam.az = drag.az - (x - drag.x) * 0.25 / dpr(); A.cam.el = Math.max(-80, Math.min(80, drag.el + (y - drag.y) * 0.2 / dpr())); }
  else if (drag.kind === 'pan') { var b = camBasis(), k = A.cam.dist * 0.0012 / dpr(); A.cam.tgt = V.add(drag.tgt, V.add(V.mul(b.r, -(x - drag.x) * k), V.mul(b.u, (y - drag.y) * k))); }
  else if (drag.kind === 'box') { var m = $('marq'); m.style.display = 'block'; m.style.left = Math.min(e.clientX, drag.ex) + 'px'; m.style.top = Math.min(e.clientY, drag.ey) + 'px'; m.style.width = Math.abs(e.clientX - drag.ex) + 'px'; m.style.height = Math.abs(e.clientY - drag.ey) + 'px'; drag.x1 = x; drag.y1 = y; }
  else applyGizmo(x - drag.x, y - drag.y);
  dirty = true;
});
window.addEventListener('mouseup', function (e) {
  if (!drag) return;
  var r = A.canvas.getBoundingClientRect(), x = (e.clientX - r.left) * dpr(), y = (e.clientY - r.top) * dpr(), add = e.shiftKey || e.metaKey || e.ctrlKey;
  if (drag.kind === 'gizmo') { var joints = [].concat(drag.E.lead, drag.E.follow.map(function (f) { return f[1]; })).some(isJ); rebuildTree(); fields(); if ([].concat(drag.E.lead).some(isP)) requestBuild(); else if (joints) status('joints moved (re-rigged; the surface is unchanged)'); else status('decals moved'); }
  else if (drag.kind === 'box') {
    $('marq').style.display = 'none';
    if (Math.hypot(x - drag.x0, y - drag.y0) < 4) { var k = pick(x, y); if (k) toggle(k); }
    else { var C = A.camMatrices(null), x0 = Math.min(drag.x0, x), x1 = Math.max(drag.x0, x), y0 = Math.min(drag.y0, y), y1 = Math.max(drag.y0, y), inBox = function (p) { var q = project(p, C); return q[2] > 0 && q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1; };
      for (var id in IDX) if ($('showPrims').checked && inBox(itemPos('p:' + id))) sel.add('p:' + id);
      if ($('showBones').checked) sk.bones.forEach(function (b, i) { if (editableJoint(b.name) && inBox(W.p[i])) sel.add('j:' + b.name); });
      if ($('showDecals').checked) (DEF.decals || []).forEach(function (d) { if (inBox(d.c)) sel.add('d:' + d.name); });
      selGroup = null; selChanged(); }
  }
  else if (drag.kind === 'orbit' && Math.hypot(x - drag.x0, y - drag.y0) < 4) { var k2 = pick(x, y); if (add && k2) toggle(k2); else select(k2 ? [k2] : []); }
  drag = null;
});
A.canvas.addEventListener('wheel', function (e) { A.cam.dist = Math.max(0.1, Math.min(8, A.cam.dist * Math.exp(e.deltaY * 0.001))); dirty = true; e.preventDefault(); }, { passive: false });
window.addEventListener('keydown', function (e) {
  if (e.target.tagName === 'INPUT') return;
  var k = e.key.toLowerCase();
  if (k === 'w') setMode('T'); else if (k === 'e') setMode('R'); else if (k === 'r') setMode('S');
  else if (k === 'escape') select([]);
  else if (k === 'q') setSpace(space === 'local' ? 'world' : 'local');
  else if (k === 'f' && sel.size) { var G = gizmo(); if (G) { A.cam.tgt = G.c.slice(); A.cam.dist = 0.5; dirty = true; } }
  else if (k === 'z' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
  else if ((k === 'delete' || k === 'backspace') && sel.size) del();
});
function setMode(m) { mode = m; $('mT').className = m === 'T' ? 'on' : ''; $('mR').className = m === 'R' ? 'on' : ''; $('mS').className = m === 'S' ? 'on' : ''; dirty = true; }
function doUndo() { if (!undo.length) return; redo.push(JSON.stringify(DEF)); restore(undo.pop()); }
function doRedo() { if (!redo.length) return; undo.push(JSON.stringify(DEF)); restore(redo.pop()); }

/* ---------- selection & hierarchy ---------- */
function select(keys) { sel = new Set(keys); primary = keys.length ? keys[keys.length - 1] : null; selGroup = null; selChanged(); }
function toggle(k) { if (sel.has(k)) sel.delete(k); else { sel.add(k); primary = k; } selGroup = null; selChanged(); }
function selChanged() { setTimeout(ornamentPanel, 0); if (primary && !sel.has(primary)) primary = sel.size ? Array.from(sel).pop() : null; refreshTree(true); fields(); dirty = true; }
function refreshTree(reveal) {
  if (reveal) sel.forEach(function (k) { if (!isP(k)) return; var gp = IDX[keyId(k)].gpath.split('.'); for (var i = 1; i <= gp.length; i++) collapsed.delete(gp.slice(0, i).join('.')); });
  var h = [], groupSel = function (G) { return G.prims.length && G.prims.every(function (id) { return sel.has('p:' + id); }); };
  (function walk(g, path, d) {
    var G = GROUPS.find(function (x) { return x.path === path; }), open = !collapsed.has(path);
    h.push('<div class="grp' + (groupSel(G) ? ' sel' : '') + '" data-g="' + path + '" style="padding-left:' + (d * 10 + 2) + 'px"><span class="tw" data-t="' + path + '">' + (open ? '▾' : '▸') + '</span>' + (g.group || 'group') + ' · ' + g.op + ' k=' + (+g.k).toFixed(4) + ' (' + G.prims.length + ')</div>');
    if (!open) return;
    g.kids.forEach(function (k, i) {
      if (k.kids) walk(k, path + '.' + i, d + 1);
      else h.push('<div data-id="' + k.id + '" class="' + (sel.has('p:' + k.id) ? 'sel' : '') + '" style="padding-left:' + (d * 10 + 16) + 'px">' + (k.type === 'special' ? k.name + (k.side ? (k.side > 0 ? ' L' : ' R') : '') : k.type) + ' #' + k.id + (k.bone ? ' · ' + k.bone : ' · (cut)') + (k.mat ? ' · ' + k.mat : '') + (k.mirror ? ' ⇄' + k.mirror : '') + '</div>');
    });
  })(EROOT, '0', 0);
  var td = (DEF.decals || []).map(function (d) { return '<div data-d="' + d.name + '" class="' + (sel.has('d:' + d.name) ? 'sel' : '') + '" style="padding-left:16px">' + d.name + ' · ' + d.kind + (d.mirror ? ' ⇄' + d.mirror : '') + '</div>'; });
  h.push('<div class="grp" data-t="decals" style="padding-left:2px"><span class="tw" data-t="decals">' + (collapsed.has('decals') ? '▸' : '▾') + '</span>decals: painted makeup (' + td.length + ')</div>');
  if (!collapsed.has('decals')) h = h.concat(td);
  var tj = []; sk.bones.forEach(function (b) { if (editableJoint(b.name)) tj.push('<div data-j="' + b.name + '" class="' + (sel.has('j:' + b.name) ? 'sel' : '') + '" style="padding-left:16px">joint ' + b.name + '</div>'); });
  h.push('<div class="grp" data-t="joints" style="padding-left:2px"><span class="tw" data-t="joints">' + (collapsed.has('joints') ? '▸' : '▾') + '</span>skeleton joints (' + tj.length + ')</div>');
  if (!collapsed.has('joints')) h = h.concat(tj);
  $('tree').innerHTML = h.join('');
  var s = $('tree').querySelector('[data-id].sel, [data-j].sel, [data-d].sel'); if (s && reveal) s.scrollIntoView({ block: 'nearest' });
}
$('tree').addEventListener('click', function (e) {
  var t = e.target, add = e.shiftKey || e.metaKey || e.ctrlKey, tw = t.getAttribute('data-t');
  if (tw) { if (collapsed.has(tw)) collapsed.delete(tw); else collapsed.add(tw); refreshTree(); return; }
  var row = t.closest('div'); if (!row) return;
  var id = row.getAttribute('data-id'), j = row.getAttribute('data-j'), g = row.getAttribute('data-g'), dn = row.getAttribute('data-d');
  if (dn) { if (add) toggle('d:' + dn); else select(['d:' + dn]); }
  else if (id) { if (add) toggle('p:' + id); else select(['p:' + id]); }
  else if (j) { if (add) toggle('j:' + j); else select(['j:' + j]); }
  else if (g) { var G = GROUPS.find(function (x) { return x.path === g; }), keys = G.prims.map(function (i) { return 'p:' + i; }); if (add) keys.forEach(function (k) { sel.add(k); }); else sel = new Set(keys); primary = null; selGroup = g; selChanged(); }
});
// collapse everything below depth 2 at start
function initCollapse() { collapsed = new Set(); GROUPS.forEach(function (G) { if (G.path.split('.').length > 2) collapsed.add(G.path); }); }

/* ---------- fields ---------- */
function num(v, k, step) { return '<input type="number" step="' + (step || 0.001) + '" data-k="' + k + '" value="' + (+v).toFixed(5) + '">'; }
function vec(label, v, k) { return '<div class="f"><label>' + label + '</label>' + num(v[0], k + '.0') + num(v[1], k + '.1') + num(v[2], k + '.2') + '</div>'; }
function nudgeRow() { var F = frameOfItem(primary && sel.has(primary) ? primary : Array.from(sel).pop()); return F ? '<div class="f"><label>nudge</label>' + num(0, 'N.0', 0.0005) + num(0, 'N.1', 0.0005) + num(0, 'N.2', 0.0005) + '<span style="color:var(--mute)">m along own axes</span></div>' : ''; }
function nudge(i, dist) {   // move the selection by dist along axis i of the active item's frame (same as a local-axis drag)
  var G = gizmo(true); if (!G || !G.local || !dist) return;
  var m = mode; mode = 'T'; startDrag(i, 0, 0, G); drag.fixed = V.mul(G.ax[i], dist); applyGizmo(0, 0);
  var E = drag.E; drag = null; mode = m; rebuildTree(); if (E.lead.some(isP)) requestBuild(); fields();
}
function fields() {
  var np = 0, nj = 0, nd = 0; sel.forEach(function (k) { if (isP(k)) np++; else if (isD(k)) nd++; else nj++; });
  if (!sel.size) { $('fields').innerHTML = '<span style="color:var(--mute)">nothing selected — click a primitive (or a joint with the skeleton shown)</span>'; return; }
  if (selGroup) { var G = GROUPS.find(function (x) { return x.path === selGroup; }), g = G.g;
    $('fields').innerHTML = '<div class="row"><b>group ' + (g.group || '') + '</b><span style="color:var(--mute)">' + G.prims.length + ' primitives selected</span></div><div class="row"><label>op</label><select data-k="G.op">' + ['union', 'subtract', 'intersect'].map(function (o) { return '<option' + (g.op === o ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select><label>blend k</label>' + num(g.k, 'G.k') + '</div>'; return; }
  if (sel.size > 1) { $('fields').innerHTML = '<span>' + np + ' primitive(s), ' + nj + ' joint(s), ' + nd + ' decal(s) selected — the gizmo acts on all of them around their centre' + ($('mirror').checked ? '; mirror partners follow' : '') + '</span>'; return; }
  var k0 = Array.from(sel)[0];
  if (isD(k0)) { var d = decal(keyId(k0)), hex = '#' + d.color.map(function (c) { return ('0' + Math.round(Math.max(0, Math.min(1, toS(c))) * 255).toString(16)).slice(-2); }).join('');
    var plab = { blob: '—', brow: 'tilt (rad)', flower: 'petals', dot: '—', lip: 'lower height' }[d.kind];
    $('fields').innerHTML = '<div class="row"><b>decal ' + d.name + '</b><label>kind</label><select data-k="D.kind">' + FIG.DECAL_KINDS.map(function (q) { return '<option' + (q === d.kind ? ' selected' : '') + '>' + q + '</option>'; }).join('') + '</select></div>' +
      vec('centre', d.c, 'D.c') + '<div class="f"><label>size</label>' + num(d.size[0], 'D.size.0', 0.0005) + num(d.size[1], 'D.size.1', 0.0005) + '</div>' +
      '<div class="f"><label>depth</label>' + num(d.depth[0], 'D.depth.0', 0.001) + num(d.depth[1], 'D.depth.1', 0.001) + '<span style="color:var(--mute)">fade in along n</span></div>' +
      '<div class="row"><label>colour</label><input type="color" data-k="D.color" value="' + hex + '"><label>opacity</label>' + num(d.opacity, 'D.opacity', 0.05) + '</div>' +
      '<div class="row"><label>softness</label>' + num(d.softness || 0, 'D.softness', 0.01) + '<label>' + plab + '</label>' + num(d.param || 0, 'D.param', 0.01) + '<label>gloss</label>' + num(d.gloss || 0, 'D.gloss', 0.1) + '</div>' +
      (d.kind === 'brow' ? '<div class="row"><label>brow style</label><select data-k="D.style">' + Object.keys(FIG.BROW_STYLES).map(function (q) { var B = FIG.BROW_STYLES[q]; return '<option value="' + q + '"' + (q === (d.style || 'bazi') ? ' selected' : '') + ' title="' + B.note + '">' + B.zh + ' ' + q + '</option>'; }).join('') + '</select><span style="color:var(--mute)">picking one applies its size / tilt / softness</span></div>' : '') +
      nudgeRow() + '<div class="row"><label>mirror partner</label><input type="text" data-k="D.mirror" value="' + (d.mirror || '') + '" placeholder="decal name" style="width:90px">' + (d.mirror ? '<button id="snapMir">snap partner to mirror</button>' : '') + '</div>';
    return; }
  if (isJ(k0)) { var n = keyId(k0), b = sk.bones[sk.by[n]];
    $('fields').innerHTML = '<div class="row"><b>joint ' + n + '</b><span style="color:var(--mute)">parent ' + (b.parent >= 0 ? sk.bones[b.parent].name : '—') + (partnerKey(k0) ? ' · mirror ' + keyId(partnerKey(k0)) : '') + '</span></div>' + vec('pos', b.p, 'J') +
      nudgeRow() + '<div style="color:var(--mute)">moves the rig only (pivots for skinning and animation); the surface does not change</div>'; return; }
  var e = IDX[keyId(k0)], p = e.p, g2 = e.parent, h = '<div class="row"><b>' + p.type + (p.name ? ' ' + p.name : '') + ' #' + p.id + '</b>' + (p.mirror ? '<span style="color:var(--mute)">mirror ⇄ #' + p.mirror + '</span>' : isCentre(p) ? '<span style="color:var(--mute)">centre piece</span>' : '') + '</div>';
  if (p.c) h += vec('pos', p.c, 'c');
  if (p.type === 'sphere') h += '<div class="f"><label>r</label>' + num(p.r, 'r') + '</div>';
  if (p.type === 'ellipsoid') h += vec('radii', p.r, 'r') + vec('axis u', p.u, 'u') + vec('axis v', p.v, 'v');
  if (p.type === 'cone') { var cf = coneFrame(p), ss = p.s || [1, 1]; h += vec('a', p.a, 'a') + vec('b', p.b, 'b') + '<div class="f"><label>r a/b</label>' + num(p.ra, 'ra') + num(p.rb, 'rb') + '</div><div class="f"><label>section</label>' + num(ss[0], 's.0', 0.01) + num(ss[1], 's.1', 0.01) + '<span style="color:var(--mute)">x, y scale</span></div>' + vec('sect. u', cf[0], 'u') + '<div class="f"><label>ends</label>' + num(p.capA == null ? 1 : p.capA, 'capA', 0.05) + num(p.capB == null ? 1 : p.capB, 'capB', 0.05) + '<span style="color:var(--mute)">a, b: 1 round · 0 flat · >1 bulge</span></div>'; }
  if (p.type === 'shell') h += vec('radii', p.r, 'r') + '<div class="f"><label>thick</label>' + num(p.t, 't', 0.0002) + '</div>' + vec('axis u', p.u, 'u') + vec('axis v', p.v, 'v') + '<div style="color:var(--mute)">the blink pivots about the eyeball centre (params eye)</div>';
  if (p.type === 'special') { var P = DEF.params;
    h += '<div style="color:var(--mute)">rigged piece — the face rig animates it; drag the gizmo or edit its rest shape (shared L/R):</div>';
    if (p.name === 'aperture') { var E = P.eyeOpening; h += '<div class="f"><label>width</label>' + num(E.wMed, 'P.eyeOpening.wMed', 0.0002) + num(E.wLat, 'P.eyeOpening.wLat', 0.0002) + '<span style="color:var(--mute)">inner, outer</span></div><div class="f"><label>height</label>' + num(E.up, 'P.eyeOpening.up', 0.0002) + num(E.lo, 'P.eyeOpening.lo', 0.0002) + '<span style="color:var(--mute)">up, down</span></div><div class="f"><label>tilt</label>' + num(E.tilt, 'P.eyeOpening.tilt', 0.0002) + num(E.rot, 'P.eyeOpening.rot', 0.01) + '<span style="color:var(--mute)">corner lift, rot</span></div><div class="f"><label>offset</label>' + num(E.off[0], 'P.eyeOpening.off.0', 0.0002) + num(E.off[1], 'P.eyeOpening.off.1', 0.0002) + '</div><div class="f"><label>lashes</label>' + num(P.lashes.len, 'P.lashes.len', 0.05) + num(P.lashes.curl, 'P.lashes.curl', 0.05) + '<span style="color:var(--mute)">length, curl</span></div>'; }
    else if (/^lip|mouthSlit/.test(p.name)) { var Lp = P.lips; h += vec('mouth', P.mouth, 'P.mouth') + '<div class="f"><label>width</label>' + num(Lp.wU, 'P.lips.wU', 0.0005) + num(Lp.wL, 'P.lips.wL', 0.0005) + num(Lp.slitW, 'P.lips.slitW', 0.0005) + '</div><div class="f"><label>thick</label>' + num(Lp.thick[0], 'P.lips.thick.0', 0.05) + num(Lp.thick[1], 'P.lips.thick.1', 0.05) + '</div><div class="f"><label>depth</label>' + num(Lp.depth[0], 'P.lips.depth.0', 0.05) + num(Lp.depth[1], 'P.lips.depth.1', 0.05) + '</div><div class="f"><label>arch</label>' + num(Lp.arch, 'P.lips.arch', 0.5) + '<label>gap</label>' + num(P.halfGap, 'P.halfGap', 0.0001) + '</div>'; }
    h += vec('eyeball', P.eye.c, 'P.eye.c') + '<div class="f"><label>eye r</label>' + num(P.eye.r, 'P.eye.r') + '</div>';
  }
  h += nudgeRow();
  h += '<div class="row"><label>mirror partner #</label><input type="text" data-k="mirrorId" value="' + (p.mirror || '') + '" placeholder="id" style="width:60px">' + (p.mirror && p.type !== 'special' ? '<button id="snapMir">snap partner to mirror</button>' : '') + '</div>';
  h += '<div class="row"><label>bone</label><select data-k="bone"><option value="">(none: cut)</option>' + sk.bones.map(function (b) { return '<option' + (b.name === p.bone ? ' selected' : '') + '>' + b.name + '</option>'; }).join('') + '</select></div>';
  h += '<div class="row"><label>weight falloff</label>' + num(p.sig || 0.02, 'sig') + '<label>material</label><select data-k="mat">' + ['skin', 'lip', 'nail', 'brow'].map(function (m) { return '<option' + ((p.mat || 'skin') === m ? ' selected' : '') + '>' + m + '</option>'; }).join('') + '</select></div>';
  h += '<div class="row"><label>group</label><b>' + (g2.group || '·') + '</b><select data-k="g.op">' + ['union', 'subtract', 'intersect'].map(function (o) { return '<option' + (g2.op === o ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select><label>blend k</label>' + num(g2.k, 'g.k') + '</div>';
  $('fields').innerHTML = h;
}
$('fields').addEventListener('click', function (e) {
  if (e.target.id !== 'snapMir') return; var k0 = Array.from(sel)[0]; snapshot();
  if (isD(k0)) { var d = decal(keyId(k0)); mirrorDecal(d, decal(d.mirror)); decalsChanged(); status(d.mirror + ' is now the exact mirror of ' + d.name); return; }
  var p = IDX[keyId(k0)].p, q = IDX[p.mirror].p; mirrorOf(p, q); q.bone = mirName(p.bone); status('#' + q.id + ' is now the exact mirror of #' + p.id); reload();
});
$('fields').addEventListener('change', function (e) {
  var k = e.target.getAttribute('data-k'); if (!k) return;
  if (k.indexOf('N.') === 0) { nudge(+k.slice(2), +e.target.value); return; }
  snapshot(); var val = e.target.value, mirrorOn = $('mirror').checked;
  if (k === 'G.op' || k === 'G.k') { var G = GROUPS.find(function (x) { return x.path === selGroup; }).g; if (k === 'G.op') G.op = val; else G.k = +val; reload(); return; }
  var k0 = Array.from(sel)[0];
  if (isD(k0)) {
    var d = decal(keyId(k0)), path = k.slice(2).split('.');
    if (path[0] === 'mirror') {
      var m = val.trim(); if (m && (!decal(m) || m === d.name)) { status(m === d.name ? 'a decal cannot mirror itself' : 'no decal named ' + m); undo.pop(); fields(); return; }
      if (d.mirror && decal(d.mirror)) delete decal(d.mirror).mirror; if (m && decal(m).mirror && decal(decal(m).mirror)) delete decal(decal(m).mirror).mirror;
      if (m) { d.mirror = m; decal(m).mirror = d.name; status('paired ' + d.name + ' ⇄ ' + m + ' — "snap partner to mirror" makes it exact'); } else delete d.mirror;
    }
    else if (path[0] === 'color') d.color = [1, 3, 5].map(function (i) { return +toL(parseInt(val.substr(i, 2), 16) / 255).toFixed(4); });
    else if (path[0] === 'kind') d.kind = val;
    else if (path[0] === 'style') FIG.browPreset(d, val);
    else if (path.length > 1) d[path[0]][+path[1]] = +val; else d[path[0]] = +val;
    if (mirrorOn && d.mirror && decal(d.mirror) && path[0] !== 'mirror') mirrorDecal(d, decal(d.mirror)); else if (mirrorOn && !d.mirror && path[0] === 'c') d.c[0] = 0;
    decalsChanged(); refreshTree(); fields(); return;
  }
  if (k === 'mirrorId') {   // manual pairing (validated; breaks old pairs on both sides)
    var P0 = IDX[keyId(k0)].p, id = val.trim() === '' ? null : +val;
    if (id !== null && (!IDX[id] || id === P0.id)) { status(id === P0.id ? 'a primitive cannot mirror itself' : 'no primitive #' + val); undo.pop(); fields(); return; }
    if (P0.mirror && IDX[P0.mirror]) delete IDX[P0.mirror].p.mirror;
    if (id !== null) { var Q = IDX[id].p; if (Q.mirror && IDX[Q.mirror]) delete IDX[Q.mirror].p.mirror; P0.mirror = id; Q.mirror = P0.id; status('paired #' + P0.id + ' ⇄ #' + id + ' — "snap partner to mirror" makes #' + id + ' the exact mirror'); }
    else { delete P0.mirror; status('unpaired #' + P0.id); }
    reload(true); return;
  }
  if (isJ(k0)) { var n = keyId(k0), i = +k.split('.')[1] || 0, J = DEF.skeleton.joints; if (k === 'J.0' || k === 'J.1' || k === 'J.2') { J[n] = (J[n] || sk.bones[sk.by[n]].p).slice(); J[n][+k.split('.')[1]] = +val; var m = partnerKey(k0); if (mirrorOn && m) J[keyId(m)] = mx(J[n]); else if (mirrorOn) J[n][0] = 0; } reload(true); return; }
  var E = IDX[keyId(k0)], p = E.p;
  if (k === 'bone') { p.bone = val || null; if (p.mirror && IDX[p.mirror] && mirrorOn) IDX[p.mirror].p.bone = mirName(p.bone); }
  else if (k === 'mat') { if (val === 'skin') delete p.mat; else p.mat = val; }
  else if (k === 'g.op') E.parent.op = val;
  else if (k === 'g.k') { E.parent.k = +val; var mg = mirName(E.parent.group); if (mirrorOn && mg !== E.parent.group) { var G2 = FIG.findGroup(EROOT, mg); if (G2) G2.k = +val; } }
  else if (k.indexOf('P.') === 0) { var path = k.slice(2).split('.'), o = DEF.params; while (path.length > 1) o = o[path.shift()]; o[path[0]] = +val; FIG.load(DEF); }
  else { var parts = k.split('.'); if (parts[0] === 's' && !p.s) p.s = [1, 1]; if (parts[0] === 'u' && !p.u) p.u = coneFrame(p)[0]; if (parts.length > 1) p[parts[0]][+parts[1]] = +val; else p[k] = +val; }
  if (mirrorOn) { if (p.mirror && IDX[p.mirror]) mirrorOf(p, IDX[p.mirror].p); else if (isCentre(p)) symmetrize(p); }
  reload();
});

/* ---------- add / duplicate / delete / convert ---------- */
function newPrim(type, at, bone) {
  var c = at.slice(), id = maxId() + 1;
  if (type === 'sphere') return { id: id, type: type, c: c, r: 0.02, bone: bone, sig: 0.02 };
  if (type === 'ellipsoid') return { id: id, type: type, c: c, r: [0.03, 0.02, 0.02], u: [1, 0, 0], v: [0, 1, 0], bone: bone, sig: 0.02 };
  return { id: id, type: 'cone', a: V.add(c, [0, 0.03, 0]), b: V.add(c, [0, -0.03, 0]), ra: 0.015, rb: 0.012, bone: bone, sig: 0.02 };
}
function insertAfter(e, p) { e.parent.kids.splice(e.parent.kids.indexOf(e.p) + 1, 0, p); index(); }
function selPrims() { var out = []; sel.forEach(function (k) { if (isP(k) && IDX[keyId(k)]) out.push(IDX[keyId(k)]); }); return out; }
$('add').onclick = function () {
  var e = selPrims().pop() || { parent: DEF.body, p: DEF.body.kids[0] }; snapshot();   // (with a hair primitive selected, the new one joins its hair group)
  var at = e.p.id ? V.add(center(e.p), [0.02, 0, 0]) : [0.1, 1.2, 0.1], p = newPrim($('newType').value, at, e.p.bone || 'chest');
  insertAfter(e, p);
  if ($('mirror').checked && Math.abs(at[0]) > 1e-3) { var m = IDX[e.p.mirror]; var q = mirrorOf(p, { id: maxId() + 1, bone: mirName(p.bone) }); p.mirror = q.id; q.mirror = p.id; insertAfter(m || e, q); }
  sel = new Set(['p:' + p.id]); primary = 'p:' + p.id; reload();
};
$('dup').onclick = function () {
  var list = selPrims(); if (!list.length) return; snapshot(); var created = [], done = new Set();
  list.forEach(function (e) {
    if (done.has(e.p.id)) return;
    var p = JSON.parse(JSON.stringify(e.p)); p.id = maxId() + 1; delete p.mirror; ['c', 'a', 'b'].forEach(function (k) { if (p[k]) p[k] = V.add(p[k], [0, -0.02, 0]); });
    insertAfter(e, p); created.push('p:' + p.id); done.add(e.p.id);
    if ($('mirror').checked && e.p.mirror && IDX[e.p.mirror]) { var q = mirrorOf(p, { id: maxId() + 1, bone: mirName(p.bone) }); p.mirror = q.id; q.mirror = p.id; insertAfter(IDX[e.p.mirror], q); done.add(e.p.mirror); }
  });
  sel = new Set(created); reload();
};
function del() {
  var victims = new Map(); selPrims().forEach(function (e) { victims.set(e.p.id, e); if ($('mirror').checked && e.p.mirror && IDX[e.p.mirror]) victims.set(e.p.mirror, IDX[e.p.mirror]); });
  if (!victims.size) return;
  var count = new Map(); victims.forEach(function (v) { count.set(v.parent, (count.get(v.parent) || 0) + 1); });
  var bad = false; count.forEach(function (n, g) { if (n >= g.kids.length) bad = true; }); if (bad) { status('cannot delete every member of a group'); return; }
  snapshot(); victims.forEach(function (v) { v.parent.kids.splice(v.parent.kids.indexOf(v.p), 1); }); sel = new Set(); reload();
}
$('del').onclick = del;
$('toEll').onclick = function () {   // sphere → ellipsoid with equal radii (the same field), for per-axis scaling
  var list = []; selPrims().forEach(function (e) { list.push(e.p); if ($('mirror').checked && e.p.mirror && IDX[e.p.mirror]) list.push(IDX[e.p.mirror].p); });
  list = list.filter(function (p, i) { return p.type === 'sphere' && list.indexOf(p) === i; });
  if (!list.length) { status('select one or more spheres'); return; }
  snapshot(); list.forEach(function (p) { var r = p.r; p.type = 'ellipsoid'; p.r = [r, r, r]; p.u = [1, 0, 0]; p.v = [0, 1, 0]; });
  status(list.length + ' sphere(s) converted'); reload();
};

/* ---------- check (in-editor) ---------- */
$('check').onclick = function () {
  if (!body) return; status('building hair and ornaments for the check…');
  setTimeout(function () {
    var t0 = performance.now(), F = FIG.compileTree(tree), bm = { pos: body.pos, nrm: body.nrm, idx: body.idx, bi: body.bi, bw: body.bw, sdf: F, tree: tree };
    var parts = [{ name: 'body', mesh: bm, kind: 'skinned' }], hair = FIG.buildHair(sk, bm, { hair: FIG.hairKey(DEF.costume[STYLE] || DEF.costume.tang) }, function () {});
    ['L', 'R'].forEach(function (S) { parts.push({ name: 'eye' + S, parent: 'body', mesh: FIG.eyeMesh(sk, S) }); });
    parts.push({ name: 'hairCap', parent: 'body', mesh: hair.cap }, { name: 'hairStrands', parent: 'hairCap', mesh: hair.strands, perComponent: true });
    parts = parts.concat(FIG.buildOrnaments(sk, bm, hair, { costume: STYLE }, function () {}).parts);
    var r = FIG.attachCheck({ sk: sk, body: bm, parts: parts }, W, 0.002), lines = [];
    lines.push('body: ' + r.body.components + ' component(s), ' + r.body.boundaryLoops + ' open loop(s) ' + (r.body.ok ? 'OK' : 'FAIL'));
    probVerts = [];
    r.problems.forEach(function (q) {
      lines.push('✗ ' + q.part + ' → ' + q.parent + ': ' + q.detached + '/' + q.units + ' detached, worst ' + (isFinite(q.worst) ? (q.worst * 1000).toFixed(1) + ' mm' : 'far'));
      var pt = parts.find(function (x) { return x.name === q.part; }), P = new Float32Array(pt.mesh.pos.length); FIG.skin(pt.mesh, FIG.poseDQ(sk, W), P);
      for (var i = 0; i < P.length; i += 3 * 7) probVerts.push([P[i], P[i + 1], P[i + 2]]);
    });
    if (!r.problems.length) lines.push('all ' + (parts.length - 1) + ' rigid/skinned parts attached (≤ 2 mm) at this pose');
    lines.push('(' + ((performance.now() - t0) / 1000).toFixed(1) + ' s; the full song check incl. cloth: node tool/check.js)');
    $('report').textContent = lines.join('\n'); status(''); dirty = true;
  }, 20);
};

/* ---------- wiring ---------- */
$('space').onclick = function () { setSpace(space === 'local' ? 'world' : 'local'); };
$('mT').onclick = function () { setMode('T'); }; $('mR').onclick = function () { setMode('R'); }; $('mS').onclick = function () { setMode('S'); };
$('undo').onclick = doUndo; $('redo').onclick = doRedo; $('rebuild').onclick = requestBuild; $('res').onchange = requestBuild;
['showPrims', 'showBones', 'showDecals', 'heat'].forEach(function (k) { $(k).onchange = function () { dirty = true; if (k === 'showBones') refreshTree(); }; });
$('hairPrev').onchange = $('hairQ').onchange = function () { requestHair(); };

$('pose').onchange = function () { if (this.value === 'song' && !perf) loadSong(); else poseNow(); };
$('tpose').oninput = function () { if ($('pose').value === 'song') poseNow(); };
$('save').onclick = function () { DEF.version = FIG.VERSION; var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(DEF, null, 1)], { type: 'application/json' })); a.download = 'figure.' + STYLE + '.json'; a.click(); };
$('load').onclick = function () { $('file').click(); };
$('file').onchange = function () { var f = this.files[0]; if (!f) return; f.text().then(function (t) { snapshot(); open(JSON.parse(t)); }); };
$('refLoad').onclick = function () { $('refFile').click(); };
$('refFile').onchange = function () { var f = this.files[0]; if (!f) return; var img = new Image(); img.onload = function () {
  REF.aspect = img.width / img.height; REF.tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, REF.tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); refPlane(); }; img.src = URL.createObjectURL(f); };
['refView', 'refOp', 'refH', 'refY'].forEach(function (k) { $(k).oninput = refPlane; });
(function loop() { if (dirty && sk) { dirty = false; A.render(null, overlay); } requestAnimationFrame(loop); })();

/* ---------- start ---------- */
// open a definition: older files (no skeleton section) get the built-in joints; the L/R mirror links are audited
function open(d) {
  DEF = d; var up = FIG.upgrade(DEF), r = up.mirror;
  HKEY = FIG.hairKey((DEF.costume || {})[STYLE] || (DEF.costume || {}).tang); var H = DEF.hair && DEF.hair[HKEY];
  if (H && !H.masses) { FIG.load(DEF); index(); H.masses = FIG.hairMasses(H, FIG.Skeleton(DEF).O, maxId() + 1); }   // older files: the hair parameters become primitives (the same shape)
  if (up.log.length) console.log('upgraded on open:\n' + up.log.join('\n'));
  $('report').textContent = 'mirror audit: ' + (r.kept / 2 + r.inexact.length + r.paired.length) + ' L/R pairs (' + r.paired.length + ' newly linked' + (r.inexact.length ? ', ' + r.inexact.length + ' not exact mirrors' : '') + '), ' + r.centre.length + ' centre pieces' + (r.asymCentre.length ? ' (asymmetric: #' + r.asymCentre.join(' #') + ')' : '') + (r.unpaired.length ? '; no partner: #' + r.unpaired.join(' #') : '');
  sel = new Set(); index(); initCollapse(); reload();
}
A.P.img = A.program('layout(location=0) in vec3 aPos; layout(location=5) in vec4 aUV; uniform mat4 uVP; out vec2 vT; void main() { vT = aUV.xy; gl_Position = uVP * vec4(aPos, 1.0); }',
  'in vec2 vT; uniform sampler2D uTex; uniform float uOp; out vec4 oC; void main() { vec4 c = texture(uTex, vT); oC = vec4(c.rgb * 0.6, 1.0) * uOp; }');
A.setCam({ cam: 'full' }); A.cam.tgt = [0, 0.95, 0]; A.cam.dist = 3.2; setSpace(space);
var fl = { pos: new Float32Array([-3, 0, -3, 3, 0, -3, 3, 0, 3, -3, 0, 3]), nrm: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), idx: new Uint16Array([0, 2, 1, 0, 3, 2]) };
A.scene.items.push({ g: A.upload(fl), prog: 'floor', world: true, cast: false });
A.loadFigure().then(function (d) {
  FIG.load(d); var sk0 = FIG.Skeleton(d);
  sk0.bones.forEach(function (b, i) { var o = document.createElement('option'); o.value = i; o.textContent = b.name; $('heat').appendChild(o); });
  Object.keys(STYLE === 'song' ? FIG.POSES_SONG : FIG.POSES).concat(['face', 'song']).forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = k === 'song' ? 'song (scrub)' : k === 'face' ? 'face: open, blink, smile' : 'pose: ' + k; $('pose').appendChild(o); });
  open(d);
});
window.EDITOR = { hairInfo: function () { return [hairId, hairBusy, hairPending, hairItems.length]; }, requestHair: requestHair, setSpace: setSpace, nudge: nudge, gizmoAxes: function () { var G = gizmo(); return G && G.ax; }, def: function () { return DEF; }, sk: function () { return sk; }, sel: function () { return Array.from(sel); }, select: select, toggle: toggle, pick: pick, setMode: setMode,
  status: function () { return $('status').textContent; }, report: function () { return $('report').textContent; }, check: function () { $('check').onclick(); },
  gizmoScreen: function (i) { var G = gizmo(), C = A.camMatrices(null), d = dpr(); if (!G) return null; var c = project(G.c, C), e = i < 0 ? c : project(V.add(G.c, V.mul(G.ax[i], G.s)), C); return [c[0] / d, c[1] / d, e[0] / d, e[1] / d]; },
  jointScreen: function (n) { var C = A.camMatrices(null), d = dpr(), q = project(W.p[sk.by[n]], C); return [q[0] / d, q[1] / d]; },
  treeClickGroup: function (name) { var G = GROUPS.find(function (x) { return x.g.group === name; }); var ev = { target: { getAttribute: function () { return null; }, closest: function () { return { getAttribute: function (a) { return a === 'data-g' ? G.path : null; } }; } } }; $('tree').dispatchEvent(Object.assign(new MouseEvent('click'), {})); selGroup = G.path; sel = new Set(G.prims.map(function (i) { return 'p:' + i; })); selChanged(); return G.prims.length; } };
})();
