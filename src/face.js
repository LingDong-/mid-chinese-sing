/* face.js — a makeup painter for the singer's face (face.html), on figure.js and the stage renderer.
   Paint lives in layers (RGBA images) in a cylindrical projection of the head (see stage.js PAINT): u = angle around
   the head's vertical axis, v = height. The brush hits the posed surface under the cursor (CPU ray cast), maps the
   hit back to the bind pose (so painting works with the mouth open) and writes into the active layer; the stroke's
   footprint is round on the skin (the brush is scaled by the local radius). Save writes the layers as PNG data URLs into
   figure.json ("paint"), which stage.html uses; files without paint fall back to the decals. */
(function () {
'use strict';
var $ = function (id) { return document.getElementById(id); }, A = window.STAGE_API, gl = A.gl, V = FIG.v3, PAINT = A.PAINT;
var DEF = null, sk = null, fig = null, head = null, Pp = null, O = null, Wd = 2048, Ht = 1024, PJ = { y0: -0.16, y1: 0.12, cz: -0.01, rmax: 0.13 };
var LAYERS = [], active = 1, tool = 'brush', undo = [], redo = [], dirty = true, rgrid = null, hairItems = [], before = false;
var status = function (s) { $('status').textContent = s; };
var STYLE = /[?&]style=song\b/.test(location.search) ? 'song' : 'tang';   // ?style=song: the Song (宋) costume and makeup
$('style').value = STYLE; $('style').onchange = function () { location.search = this.value === 'song' ? '?style=song' : ''; };
var FULL = null;   // the whole file, figure.<style>.json (or an old combined figure.json: DEF is then its view for STYLE)
var DEFS = [{ name: 'powder', label: 'powder 鉛粉 (base)', gloss: -0.3 }, { name: 'rouge', label: 'rouge 紅妝' }, { name: 'eyes', label: 'eye colour' },
  { name: 'brows', label: 'brows 眉' }, { name: 'lips', label: 'lips 點脣', gloss: 1 }, { name: 'ornaments', label: '花鈿 · 面靨 · 斜紅' }];
var sRGB = function (c) { return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; };
var clamp = function (x, a, b) { return x < a ? a : x > b ? b : x; }, smooth = function (a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/* ---------- projection ---------- */
function toUV(b) { var hx = b[0] - O[0], hy = b[1] - O[1], hz = b[2] - O[2]; return [(Math.atan2(hx, hz - PJ.cz) / (2 * Math.PI) + 0.5) * Wd, (hy - PJ.y0) / (PJ.y1 - PJ.y0) * Ht, Math.hypot(hx, hz - PJ.cz)]; }
// texel → the bind-pose surface point (radius from a grid marched once through the head's SDF)
function buildRadiusGrid() {
  var F = fig.body.sdf, NU = 256, NV = 128, g = new Float32Array(NU * NV);
  for (var j = 0; j < NV; j++) for (var i = 0; i < NU; i++) {
    // march inward from outside: the outermost surface (not, e.g., the back of the open mouth)
    var th = ((i + 0.5) / NU - 0.5) * 2 * Math.PI, y = O[1] + PJ.y0 + (j + 0.5) / NV * (PJ.y1 - PJ.y0), dx = Math.sin(th), dz = Math.cos(th), t = PJ.rmax + 0.03;
    for (var k = 0; k < 300; k++) { var d = F(O[0] + dx * t, y, O[2] + PJ.cz + dz * t, 1); if (d < 1e-4) break; t -= Math.max(d * 0.9, 0.0004); if (t <= 0) { t = 0; break; } }
    g[j * NU + i] = t;
  }
  rgrid = { g: g, NU: NU, NV: NV };
}
function texelPoint(px, py) {
  var G = rgrid, fu = px / Wd * G.NU - 0.5, fv = py / Ht * G.NV - 0.5, i0 = Math.floor(fu), j0 = Math.floor(fv), a = fu - i0, b = fv - j0;
  var at = function (i, j) { return G.g[clamp(j, 0, G.NV - 1) * G.NU + ((i % G.NU) + G.NU) % G.NU]; };
  var r = (at(i0, j0) * (1 - a) + at(i0 + 1, j0) * a) * (1 - b) + (at(i0, j0 + 1) * (1 - a) + at(i0 + 1, j0 + 1) * a) * b;
  var th = (px / Wd - 0.5) * 2 * Math.PI, y = O[1] + PJ.y0 + py / Ht * (PJ.y1 - PJ.y0);
  return [O[0] + Math.sin(th) * r, y, O[2] + PJ.cz + Math.cos(th) * r];
}

/* ---------- decal shapes (the same as the stage's skin shader) → coverage at a bind-pose point ---------- */
function aaIn(d, w) { w = Math.max(w, 0.00015); return 1 - smooth(-w, w, d); }
function browShape(qx, qy, sx, sy, st, soft) {
  var x = qx / sx, e = Math.max(1 - x * x, 0), c = 0, t = sy, dens = 1;
  if (st < 0.5) return aaIn((Math.hypot(qx / sx, qy / sy) - 1) * sy, soft * sy * 0.6);
  if (st < 1.5) t = sy * Math.pow(e, 0.55) * (1.15 - 0.35 * smooth(-1, 1, x));
  else if (st < 2.5) { t = sy * Math.sqrt(e); c = sy * 2.4 * e - sy * 1.2; }
  else if (st < 3.5) { t = sy * Math.sqrt(e); c = sy * 1.8 * e - sy * 0.9; dens = 0.7; }
  else if (st < 4.5) { t = sy * Math.sqrt(e); c = sy * 0.9 * e - sy * 0.45; dens = 1 + (0.18 - 1) * smooth(-0.9, 0.9, x); }
  else { t = sy * e; c = sy * 1.2 * e - sy * 0.6; }
  return aaIn(Math.abs(qy - c) - t, soft * sy * 0.5) * (1 - smooth(0.92, 1, Math.abs(x))) * dens;
}
function decalCover(d, b) {
  var o = V.sub(b, d.c), lx = V.dot(o, d.u), ly = V.dot(o, d.v), ln = V.dot(o, d.n), sx = d.size[0], sy = d.size[1], soft = d.softness || 0, prm = d.param || 0, m;
  if (d.kind === 'blob') m = Math.exp(-((lx / sx) * (lx / sx) + (ly / sy) * (ly / sy)));
  else if (d.kind === 'brow') { var cr = Math.cos(prm), sr = Math.sin(prm), st = (FIG.BROW_STYLES[d.style] || FIG.BROW_STYLES.bazi).id; m = browShape(cr * lx + sr * ly, -sr * lx + cr * ly, sx, sy, st, soft); }
  else if (d.kind === 'flower') { var fr = Math.hypot(lx, ly), fa = Math.atan2(ly, lx); m = aaIn(fr - sx * (0.65 + 0.35 * Math.cos(prm * fa)), soft * 0.5); }
  else if (d.kind === 'dot') m = aaIn(Math.hypot(lx, ly) - sx, soft * sx * 0.5);
  else { var yy = ly > 0 ? ly / sy : ly / prm; m = aaIn((Math.hypot(lx / sx, yy) - 1) * sy, soft * sy * 0.6); }
  return clamp(m * smooth(d.depth[0], d.depth[1], ln), 0, 1) * d.opacity;
}
function layerOf(d) { return /^rouge/.test(d.name) ? 'rouge' : /^(eyeRouge|lashLine)/.test(d.name) ? 'eyes' : d.kind === 'brow' ? 'brows' : d.kind === 'lip' ? 'lips' : 'ornaments'; }
// paint coverage a with a linear colour into layer data (straight alpha, sRGB colour)
function over(D, i, col, a) {
  if (a <= 0) return; var da = D[i + 3] / 255, oa = a + da * (1 - a); if (oa <= 0) return;
  for (var k = 0; k < 3; k++) D[i + k] = Math.round((col[k] * 255 * a + D[i + k] * da * (1 - a)) / oa);
  D[i + 3] = Math.round(oa * 255);
}

/* ---------- layers ---------- */
function newLayers() { LAYERS = DEFS.map(function (L) { return { name: L.name, label: L.label, opacity: 1, blend: 'normal', visible: true, gloss: L.gloss || 0, data: new Uint8ClampedArray(Wd * Ht * 4) }; }); }
function uploadAll() { PAINT.size = [Wd, Ht]; return A.setPaint({ size: [Wd, Ht], proj: PJ, tone: PAINT.tone, layers: LAYERS }).then(function () { syncSlots(); dirty = true; }); }
function syncSlots() { PAINT.slots = LAYERS.map(function (L, i) { return { name: L.name, layer: i, opacity: L.opacity, blend: L.blend, visible: L.visible && !before, gloss: L.gloss }; }); PAINT.on = !before; dirty = true; }
// start from the current look: the built-in powder mask and every decal, rasterized into the layers
function convertDecals() {
  newLayers(); status('converting the decals and powder into paint…');
  var by = {}, decs = (DEF.decals || FIG.defaultDecals(O)).filter(function (d) { return d.opacity > 0; }); LAYERS.forEach(function (L) { by[L.name] = L; });
  var powder = [0.88, 0.79, 0.74].map(sRGB), P = by.powder.data;
  for (var py = 0; py < Ht; py += 1) for (var px = 0; px < Wd; px += 1) {
    var b = texelPoint(px + 0.5, py + 0.5), hx = b[0] - O[0], hy = b[1] - O[1], hz = b[2] - O[2];
    if (Math.hypot(hx, hz - PJ.cz) > PJ.rmax) continue;
    var face = smooth(-0.14, -0.10, hy) * smooth(-0.03, 0.07, hz + 0.02 * smooth(0, 0.06, Math.abs(hx))), headAll = smooth(-0.15, -0.11, hy);
    over(P, (py * Wd + px) * 4, powder, 0.75 * Math.max(face, 0.6 * headAll * smooth(-0.02, 0.04, hz)));
  }
  decs.forEach(function (d) {
    var L = by[layerOf(d)], col = d.color.map(sRGB), ext = Math.max(d.size[0], d.size[1], d.param || 0) * 2.2 + 0.004, c = toUV(d.c);
    var ru = ext / (2 * Math.PI * Math.max(c[2], 0.03)) * Wd, rv = ext / (PJ.y1 - PJ.y0) * Ht;
    for (var py = Math.max(0, Math.floor(c[1] - rv)); py < Math.min(Ht, Math.ceil(c[1] + rv)); py++) for (var px = Math.max(0, Math.floor(c[0] - ru)); px < Math.min(Wd, Math.ceil(c[0] + ru)); px++)
      over(L.data, (py * Wd + px) * 4, col, decalCover(d, texelPoint(px + 0.5, py + 0.5)));
  });
  undo = []; redo = []; return uploadAll().then(function () { renderLayers(); status('ready — the paint starts from the figure\'s decals'); });
}
function renderLayers() {
  var h = '';
  LAYERS.forEach(function (L, i) {
    h += '<div class="layer' + (i === active ? ' act' : '') + '" data-i="' + i + '"><input type="checkbox" data-k="visible" ' + (L.visible ? 'checked' : '') + '><span>' + L.label + '</span>' +
      '<button data-k="up" title="draw later (on top)">▲</button><button data-k="down" title="draw earlier">▼</button>' +
      '<div class="opts"><label>opacity</label><input type="range" data-k="opacity" min="0" max="1" step="0.02" value="' + L.opacity + '"><select data-k="blend"><option' + (L.blend === 'normal' ? ' selected' : '') + '>normal</option><option' + (L.blend === 'multiply' ? ' selected' : '') + '>multiply</option></select>' +
      '<label title="− matte … + glossy">gloss</label><input type="range" data-k="gloss" min="-1" max="1" step="0.1" value="' + L.gloss + '" style="max-width:54px"></div></div>';
  });
  $('layers').innerHTML = h;
}
$('layers').addEventListener('click', function (e) {
  var row = e.target.closest('.layer'); if (!row) return; var i = +row.getAttribute('data-i'), k = e.target.getAttribute('data-k');
  if (k === 'up' || k === 'down') { var j = k === 'up' ? i + 1 : i - 1; if (j < 0 || j >= LAYERS.length) return; var t = LAYERS[i]; LAYERS[i] = LAYERS[j]; LAYERS[j] = t; if (active === i) active = j; else if (active === j) active = i; uploadAll().then(renderLayers); return; }
  if (!k) { active = i; renderLayers(); }
});
$('layers').addEventListener('input', function (e) {
  var row = e.target.closest('.layer'); if (!row) return; var L = LAYERS[+row.getAttribute('data-i')], k = e.target.getAttribute('data-k');
  if (k === 'visible') L.visible = e.target.checked; else if (k === 'blend') L.blend = e.target.value; else if (k) L[k] = +e.target.value;
  syncSlots();
});

/* ---------- the figure: head only ---------- */
var items = [], lashItems = {};
function lashGeom(m) { var nv = m.pos.length / 3, aux = new Float32Array(nv * 4), uv = new Float32Array(nv * 4);
  for (var i = 0; i < nv; i++) { aux[i * 4 + 1] = (m.uv[i * 4] - 0.5) * 1.6; uv.set([0, 1, 0, m.uv[i * 4 + 1] * 0.9], i * 4); }
  return A.upload({ pos: m.pos, nrm: m.nrm, idx: m.idx, bi: m.bi, bw: m.bw, aux: aux, uv: uv }); }
var lashPend = false;
function rebuildLashes() { if (lashPend) return; lashPend = true; requestAnimationFrame(function () { lashPend = false; ['L', 'R'].forEach(function (S) { if (lashItems[S]) { var lm = FIG.lashMesh(sk, head, S); lashItems[S].g = lashGeom(lm); lashItems[S].h = lm.handles; } }); placeHandles(); dirty = true; }); }
/* lash controls: sliders for the params; three draggable points per lid (inner, middle, outer) move / bend the line */
var LSH = function () { return FIG.params().lashes; }, lashEdit = false;
function lashUI() {
  var L = LSH(), hex = '#' + L.color.map(function (c) { return ('0' + Math.round(clamp(sRGB(c), 0, 1) * 255).toString(16)).slice(-2); }).join('');
  $('lLen').value = L.len; $('lCurl').value = L.curl; $('lDen').value = L.density; $('lThk').value = L.thick; $('lCol').value = hex; [0, 1, 2].forEach(function (i) { $('lP' + i).value = L.profile[i]; });
}
[['lLen', 'len'], ['lCurl', 'curl'], ['lDen', 'density'], ['lThk', 'thick']].forEach(function (q) { $(q[0]).oninput = function () { LSH()[q[1]] = +this.value; rebuildLashes(); }; });
[0, 1, 2].forEach(function (i) { $('lP' + i).oninput = function () { LSH().profile[i] = +this.value; rebuildLashes(); }; });
$('lCol').oninput = function () { var v = this.value; LSH().color = [1, 3, 5].map(function (i) { var c = parseInt(v.substr(i, 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }); dirty = true; };
$('lEdit').onclick = function () { lashEdit = !lashEdit; this.classList.toggle('on', lashEdit); placeHandles(); };
$('lReset').onclick = function () { LSH().ctrl = [[0, 0], [0, 0], [0, 0]]; rebuildLashes(); };
function handlePos(S, i) {
  var it = lashItems[S]; if (it && it.h) return it.h[i];   // on the lash line itself (bind space; the head is at rest here)
  var s = S === 'L' ? 1 : -1, AP = FIG.params().eyeOpening, EC = FIG.eyeC(), t = [0.03, 0.5, 0.97][i], xl = (-AP.wMed + (AP.wLat + AP.wMed) * t) * 0.97, A2 = FIG.aperture(xl * s, 0, s), C = LSH().ctrl[i];
  return [O[0] + EC[0] * s + xl * s + C[0] * s, O[1] + EC[1] + A2.up + 0.0003 + C[1], O[2] + EC[2] + 0.0165];
}
function screenOf(p) { var C = A.camMatrices(null), m = C.vp, x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  var r = A.canvas.getBoundingClientRect(); return [r.left + (x / w * 0.5 + 0.5) * r.width, r.top + (0.5 - y / w * 0.5) * r.height]; }
function placeHandles() {
  var box = $('handles'); box.innerHTML = ''; if (!lashEdit || !head) return;
  ['L', 'R'].forEach(function (S) { [0, 1, 2].forEach(function (i) { var q = screenOf(handlePos(S, i)), d = document.createElement('div'); d.className = 'hdl'; d.style.left = q[0] + 'px'; d.style.top = q[1] + 'px'; d.setAttribute('data-s', S); d.setAttribute('data-i', i); box.appendChild(d); }); });
}
$('handles').addEventListener('mousedown', function (e) {
  var h = e.target.closest('.hdl'); if (!h) return; e.preventDefault(); e.stopPropagation();
  var S = h.getAttribute('data-s'), i = +h.getAttribute('data-i'), s = S === 'L' ? 1 : -1, c0 = LSH().ctrl[i].slice(), x0 = e.clientX, y0 = e.clientY;
  var r = A.canvas.getBoundingClientRect(), mpp = 2 * A.cam.dist * Math.tan(A.cam.fov * Math.PI / 360) / r.height, az = A.cam.az * Math.PI / 180;
  var mv = function (ev) { var dx = (ev.clientX - x0) * mpp, dy = -(ev.clientY - y0) * mpp; LSH().ctrl[i] = [c0[0] + dx * Math.cos(az) * s, c0[1] + dy]; rebuildLashes(); };
  var up = function () { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
  window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
});
function setup(def) {
  FULL = def; DEF = FIG.styleDef(def, STYLE); FIG.load(DEF); sk = FIG.Skeleton(DEF); O = sk.O; status('building the head…');
  return A.prebuildGeometry({ def: DEF, headOnly: true, costume: STYLE }).then(function (pre) {
    fig = FIG.build({ def: DEF, headOnly: true, costume: STYLE, pre: pre }, function () {}); head = fig.body; A.setFig(fig);
    var el = document.getElementById('progress'); if (el) el.remove();
    items.forEach(function (it) { var k = A.scene.items.indexOf(it); if (k >= 0) A.scene.items.splice(k, 1); }); items = []; hairItems = [];
    var headBones = /^(head|jaw|neck|tongue|lip|corner|cheek|brow|eye|lid)/;
    fig.parts.forEach(function (pt) {
      var m = pt.mesh, it = null, bn = m && m.bone != null ? (sk.bones[m.bone] || {}).name : null;
      if (pt.cloth || !m || !m.pos) return;
      if (pt.name === 'body') it = { g: A.upload(m), prog: 'skin', cull: true };
      else if (/^eye[LR]$/.test(pt.name)) it = { g: A.upload(m), prog: 'eye', cull: true, set: function (pr) { gl.uniform1f(pr.u.uSide, pt.name === 'eyeL' ? 1 : -1); } };
      else if (pt.name === 'hairCap') { it = { g: A.upload(m), prog: 'hair', cull: true, a2c: true, set: function (pr) { gl.uniform1f(pr.u.uStrand, 0); } }; hairItems.push(it); }
      else if (pt.name === 'hairStrands') { it = { g: A.upload(m), prog: 'hair', a2c: true, thin: true, set: function (pr) { gl.uniform1f(pr.u.uStrand, 1); } }; hairItems.push(it); }
      else if (/^lashes/.test(pt.name)) { it = { g: lashGeom(m), h: m.handles, prog: 'hair', a2c: true, thin: true, set: A.lashSet }; lashItems[pt.name.slice(-1)] = it; }
      else if (m.mat === 'petal' && bn && headBones.test(bn)) { it = { g: A.upload(m), prog: 'petal' }; hairItems.push(it); }
      else if (A.MATS[m.mat] && bn && headBones.test(bn)) { it = { g: A.upload(m), prog: 'plain', cull: true, set: A.plainSet(A.MATS[m.mat]) }; if (!/^(teeth|tongue)/.test(pt.name)) hairItems.push(it); }
      if (it) { items.push(it); A.scene.items.push(it); }
    });
    buildRadiusGrid(); pose(); lashUI();
    return DEF.paint && DEF.paint.layers ? loadPaint(DEF.paint) : convertDecals();
  });
}
function loadPaint(P) {
  Wd = P.size ? P.size[0] : 2048; Ht = P.size ? P.size[1] : 1024; if (P.proj) PJ = Object.assign({}, PJ, P.proj); if (P.tone) { PAINT.tone = { lip: P.tone.lip, cavity: P.tone.cavity }; $('lipTone').value = P.tone.lip; $('cavity').value = P.tone.cavity; }
  newLayers();
  return Promise.all(P.layers.map(function (L, i) {
    var T = LAYERS[i] || (LAYERS[i] = { data: new Uint8ClampedArray(Wd * Ht * 4) }); T.name = L.name; T.label = (DEFS.find(function (d) { return d.name === L.name; }) || {}).label || L.name;
    T.opacity = L.opacity; T.blend = L.blend; T.visible = L.visible !== false; T.gloss = L.gloss || 0;
    return new Promise(function (res) { if (!L.png) return res(); var im = new Image(); im.onload = function () { var c = document.createElement('canvas'); c.width = Wd; c.height = Ht; var g = c.getContext('2d'); g.drawImage(im, 0, 0); T.data.set(g.getImageData(0, 0, Wd, Ht).data); res(); }; im.onerror = res; im.src = L.png; });
  })).then(function () { LAYERS.length = P.layers.length; return uploadAll(); }).then(function () { renderLayers(); status('ready'); });
}

/* ---------- pose (mouth open / blink) and picking ---------- */
function pose() {
  var C = FIG.defaultControls(); if ($('mouth').checked) { C.jaw = 0.75; C.lipRound = 0.2; } if ($('blink').checked) { C.blinkL = C.blinkR = 1; }
  var W = FIG.solve(sk, C), DQ = FIG.poseDQ(sk, W); A.DQ.set(DQ); Pp = FIG.skin(head, DQ); dirty = true;
}
function camRay(px, py) {
  var C = A.camMatrices(null), eye = C.eye, f = V.norm(V.sub(A.cam.tgt, eye)), r = V.norm(V.cross(f, [0, 1, 0])), u = V.cross(r, f), s = A.size(), t = Math.tan(A.cam.fov * Math.PI / 360);
  var x = (2 * px / s[0] - 1) * t * s[0] / s[1], y = (1 - 2 * py / s[1]) * t; return { o: eye, d: V.norm(V.add(f, V.add(V.mul(r, x), V.mul(u, y)))) };
}
function pick(px, py) {   // nearest hit on the posed head → bind-pose point (barycentric)
  var R = camRay(px, py), o = R.o, d = R.d, I = head.idx, P = Pp, best = 1e9, hit = null;
  for (var t = 0; t < I.length; t += 3) {
    var a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    var e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2], e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    var px2 = d[1] * e2z - d[2] * e2y, py2 = d[2] * e2x - d[0] * e2z, pz2 = d[0] * e2y - d[1] * e2x, det = e1x * px2 + e1y * py2 + e1z * pz2; if (Math.abs(det) < 1e-12) continue;
    var inv = 1 / det, tx = o[0] - P[a], ty = o[1] - P[a + 1], tz = o[2] - P[a + 2], uu = (tx * px2 + ty * py2 + tz * pz2) * inv; if (uu < 0 || uu > 1) continue;
    var qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x, vv = (d[0] * qx + d[1] * qy + d[2] * qz) * inv; if (vv < 0 || uu + vv > 1) continue;
    var tt = (e2x * qx + e2y * qy + e2z * qz) * inv; if (tt > 1e-4 && tt < best) { best = tt; hit = [I[t], I[t + 1], I[t + 2], uu, vv]; }
  }
  if (!hit) return null; var B = head.pos, w0 = 1 - hit[3] - hit[4];
  return [0, 1, 2].map(function (k) { return B[hit[0] * 3 + k] * w0 + B[hit[1] * 3 + k] * hit[3] + B[hit[2] * 3 + k] * hit[4]; });
}

/* ---------- brushes ---------- */
var stroke = null;
function brush() { return { R: +$('size').value / 2000, hard: +$('hard').value, flow: +$('flow').value, col: hexLin($('color').value) }; }
function hexLin(h) { return [1, 3, 5].map(function (i) { return parseInt(h.substr(i, 2), 16) / 255; }); }   // (stored as sRGB)
function dab(b, mirror) {
  var L = LAYERS[active]; if (!L) return; var c = toUV(b), B = brush(), D = L.data;
  if (mirror) c[0] = Wd - c[0];
  var ru = B.R / (2 * Math.PI * Math.max(c[2], 0.02)) * Wd, rv = B.R / (PJ.y1 - PJ.y0) * Ht, x0 = Math.max(0, Math.floor(c[0] - ru)), x1 = Math.min(Wd - 1, Math.ceil(c[0] + ru)), y0 = Math.max(0, Math.floor(c[1] - rv)), y1 = Math.min(Ht - 1, Math.ceil(c[1] + rv));
  if (x1 < x0 || y1 < y0) return;
  if (tool === 'stamp') { stamp(b, mirror); return; }
  var copy = tool === 'blur' ? D.slice((y0 * Wd) * 4, ((y1 + 1) * Wd) * 4) : null;
  for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) {
    var r = Math.hypot((x + 0.5 - c[0]) / ru, (y + 0.5 - c[1]) / rv); if (r >= 1) continue;
    var f = (1 - smooth(B.hard, 1, r)) * B.flow, i = (y * Wd + x) * 4;
    if (tool === 'brush') over(D, i, B.col, f);
    else if (tool === 'eraser') D[i + 3] = Math.round(D[i + 3] * (1 - f));
    else if (tool === 'blur') { var s = [0, 0, 0, 0], n = 0; for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) { var yy = clamp(y + dy, y0, y1), xx = clamp(x + dx, 0, Wd - 1), j = ((yy - y0) * Wd + xx) * 4, a = copy[j + 3]; s[0] += copy[j] * a; s[1] += copy[j + 1] * a; s[2] += copy[j + 2] * a; s[3] += a; n++; }
      var na = s[3] / n; if (s[3] > 0) for (var k = 0; k < 3; k++) D[i + k] = Math.round(D[i + k] + (s[k] / s[3] - D[i + k]) * f); D[i + 3] = Math.round(D[i + 3] + (na - D[i + 3]) * f); }
  }
  touch(x0, y0, x1, y1);
}
function stamp(b, mirror) {   // a decal shape, oriented on the skin, centred at the hit
  var L = LAYERS[active], k = $('stamp').value, s = +$('size').value / 2000, mx = mirror ? -1 : 1, bb = mirror ? [2 * O[0] - b[0], b[1], b[2]] : b;
  var d = { c: bb, u: [mx, 0, 0], v: [0, 1, 0], n: [0, 0, 1], depth: [-0.02, 0.006], opacity: 1, softness: 0.4, param: 0, color: [0, 0, 0] };
  if (k === 'flower') Object.assign(d, { kind: 'flower', size: [s * 0.5, s * 0.5], param: 5, softness: 0.0004 });
  else if (k === 'dot') Object.assign(d, { kind: 'dot', size: [s * 0.25, s * 0.25], softness: 0.5 });
  else if (k === 'blob') Object.assign(d, { kind: 'blob', size: [s, s * 1.1] });
  else if (k === 'lip') Object.assign(d, { kind: 'lip', size: [s * 0.7, s * 0.28], param: s * 0.36, softness: 0.3 });
  else { var BS = FIG.BROW_STYLES[k]; Object.assign(d, { kind: 'brow', style: k, size: BS.preset ? [BS.preset.size[0] * s / 0.006 / 2, BS.preset.size[1] * s / 0.006 / 2] : [s, s / 3], param: BS.preset ? BS.preset.param : -0.35, softness: BS.preset ? BS.preset.softness : 0.45 }); }
  var c = toUV(bb), ext = Math.max(d.size[0], d.size[1], d.param || 0) * 2.2 + 0.003, ru = ext / (2 * Math.PI * Math.max(c[2], 0.03)) * Wd, rv = ext / (PJ.y1 - PJ.y0) * Ht, col = brush().col, fl = brush().flow;
  var x0 = Math.max(0, Math.floor(c[0] - ru)), x1 = Math.min(Wd - 1, Math.ceil(c[0] + ru)), y0 = Math.max(0, Math.floor(c[1] - rv)), y1 = Math.min(Ht - 1, Math.ceil(c[1] + rv));
  for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) over(L.data, (y * Wd + x) * 4, col, decalCover(d, texelPoint(x + 0.5, y + 0.5)) * Math.max(fl, 0.6));
  touch(x0, y0, x1, y1);
}
function touch(x0, y0, x1, y1) { if (!stroke) return; var r = stroke.rect; r[0] = Math.min(r[0], x0); r[1] = Math.min(r[1], y0); r[2] = Math.max(r[2], x1); r[3] = Math.max(r[3], y1); stroke.pend = true; }
function flush() {   // upload the stroke's dirty rows
  if (!stroke || !stroke.pend) return; var r = stroke.rect, L = LAYERS[active], y0 = r[1], y1 = r[3];
  A.paintUpload(active, 0, y0, Wd, y1 - y0 + 1, new Uint8Array(L.data.buffer, y0 * Wd * 4, (y1 - y0 + 1) * Wd * 4)); stroke.pend = false; dirty = true;
}
function beginStroke() { stroke = { layer: active, before: LAYERS[active].data.slice(), rect: [Wd, Ht, -1, -1], last: null, pend: false }; }
function endStroke() {
  if (!stroke) return; flush(); var r = stroke.rect;
  if (r[2] >= r[0]) { var y0 = r[1], y1 = r[3]; undo.push({ layer: stroke.layer, y0: y0, y1: y1, data: stroke.before.slice(y0 * Wd * 4, (y1 + 1) * Wd * 4) }); if (undo.length > 40) undo.shift(); redo = []; }
  stroke = null;
}
function swap(from, to) { var e = from.pop(); if (!e) return; var L = LAYERS[e.layer], cur = L.data.slice(e.y0 * Wd * 4, (e.y1 + 1) * Wd * 4); L.data.set(e.data, e.y0 * Wd * 4); to.push({ layer: e.layer, y0: e.y0, y1: e.y1, data: cur });
  A.paintUpload(e.layer, 0, e.y0, Wd, e.y1 - e.y0 + 1, new Uint8Array(L.data.buffer, e.y0 * Wd * 4, (e.y1 - e.y0 + 1) * Wd * 4)); dirty = true; }
function strokeTo(b) {   // dabs spaced along the stroke (in bind space), mirrored if asked
  var B = brush(), step = Math.max(B.R * (tool === 'stamp' ? 4 : 0.3), 0.0003);
  var go = function (p) { dab(p, false); if ($('mirror').checked && Math.abs(p[0] - O[0]) > 0.0015) dab(tool === 'stamp' ? p : [2 * O[0] - p[0], p[1], p[2]], tool === 'stamp'); };
  if (!stroke.last) go(b); else { var dd = V.len(V.sub(b, stroke.last)), n = Math.floor(dd / step); if (n < 1) return; for (var i = 1; i <= n; i++) go(V.lerp(stroke.last, b, i / n)); }
  stroke.last = b; flush();
}
function eyedrop(b) {
  var c = toUV(b), i = (Math.floor(c[1]) * Wd + Math.floor(c[0])) * 4, order = [active].concat(LAYERS.map(function (_, j) { return LAYERS.length - 1 - j; }));
  for (var k = 0; k < order.length; k++) { var D = LAYERS[order[k]].data; if (D[i + 3] > 10) { $('color').value = '#' + [D[i], D[i + 1], D[i + 2]].map(function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); return; } }
}

/* ---------- input ---------- */
var canvas = A.canvas, drag = null, dpr = function () { return window.devicePixelRatio || 1; };
function setTool(t) { tool = t; ['Brush', 'Erase', 'Blur', 'Pick', 'Stamp'].forEach(function (n) { $('t' + n).classList.toggle('on', { Brush: 'brush', Erase: 'eraser', Blur: 'blur', Pick: 'pick', Stamp: 'stamp' }[n] === t); }); }
['Brush', 'Erase', 'Blur', 'Pick', 'Stamp'].forEach(function (n) { $('t' + n).onclick = function () { setTool({ Brush: 'brush', Erase: 'eraser', Blur: 'blur', Pick: 'pick', Stamp: 'stamp' }[n]); }; });
canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
canvas.addEventListener('mousedown', function (e) {
  var x = e.offsetX * dpr(), y = e.offsetY * dpr();
  if (e.button === 2 || e.altKey) { drag = { kind: 'orbit', x: x, y: y, az: A.cam.az, el: A.cam.el }; return; }
  if (e.button === 1 || e.shiftKey) { drag = { kind: 'pan', x: x, y: y, tgt: A.cam.tgt.slice() }; return; }
  if (!head) return; var b = pick(x, y); if (!b) return;
  if (tool === 'pick') { eyedrop(b); return; }
  drag = { kind: 'paint' }; beginStroke(); strokeTo(b);
});
window.addEventListener('mousemove', function (e) {
  var r = canvas.getBoundingClientRect(), x = (e.clientX - r.left) * dpr(), y = (e.clientY - r.top) * dpr(); ring(e.clientX, e.clientY);
  if (!drag) return;
  if (drag.kind === 'orbit') { A.cam.az = drag.az - (x - drag.x) * 0.3 / dpr(); A.cam.el = clamp(drag.el + (y - drag.y) * 0.2 / dpr(), -60, 70); dirty = true; }
  else if (drag.kind === 'pan') { var C = A.camMatrices(null), f = V.norm(V.sub(A.cam.tgt, C.eye)), rr = V.norm(V.cross(f, [0, 1, 0])), u = V.cross(rr, f), k = A.cam.dist * 0.0012 / dpr(); A.cam.tgt = V.add(drag.tgt, V.add(V.mul(rr, -(x - drag.x) * k), V.mul(u, (y - drag.y) * k))); dirty = true; }
  else if (drag.kind === 'paint') { var b = pick(x, y); if (b) strokeTo(b); }
});
window.addEventListener('mouseup', function () { if (drag && drag.kind === 'paint') endStroke(); drag = null; });
canvas.addEventListener('wheel', function (e) { A.cam.dist = clamp(A.cam.dist * Math.exp(e.deltaY * 0.001), 0.12, 2); dirty = true; ring(e.clientX, e.clientY); e.preventDefault(); }, { passive: false });
function ring(cx, cy) {   // brush outline: its size on the skin at the current zoom
  var el = $('brushRing'), r = canvas.getBoundingClientRect(); if (cx < r.left || cx > r.right) { el.style.display = 'none'; return; }
  var px = +$('size').value / 2000 / (A.cam.dist * Math.tan(A.cam.fov * Math.PI / 360)) * r.height / 2;
  el.style.display = 'block'; el.style.left = (cx - px) + 'px'; el.style.top = (cy - px) + 'px'; el.style.width = el.style.height = (2 * px) + 'px';
}
window.addEventListener('keydown', function (e) {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) swap(redo, undo); else swap(undo, redo); return; }
  if (e.key === '[') $('size').value = Math.max(0.5, +$('size').value / 1.2); else if (e.key === ']') $('size').value = Math.min(40, +$('size').value * 1.2);
  else if (e.key === 'x') setTool('eraser'); else if (e.key === 'b') setTool('brush'); else if (e.key === 'i') setTool('pick'); else if (e.key === 'm') $('mirror').checked = !$('mirror').checked;
  $('sizeV').textContent = (+$('size').value).toFixed(1) + ' mm';
});
$('size').oninput = function () { $('sizeV').textContent = (+this.value).toFixed(1) + ' mm'; }; $('sizeV').textContent = $('size').value + ' mm';
$('undo').onclick = function () { swap(undo, redo); }; $('redo').onclick = function () { swap(redo, undo); };
$('clear').onclick = function () { beginStroke(); LAYERS[active].data.fill(0); stroke.rect = [0, 0, Wd - 1, Ht - 1]; stroke.pend = true; endStroke(); };
$('convert').onclick = function () { if (confirm('Replace all layers with the paint converted from the decals?')) convertDecals(); };
$('mouth').onchange = $('blink').onchange = pose;
$('hair').onchange = function () { var on = this.checked; hairItems.forEach(function (it) { var k = A.scene.items.indexOf(it); if (on && k < 0) A.scene.items.push(it); if (!on && k >= 0) A.scene.items.splice(k, 1); }); dirty = true; };
$('vLight').onclick = function () { PAINT.flat = false; this.classList.add('on'); $('vFlat').classList.remove('on'); dirty = true; };
$('vFlat').onclick = function () { PAINT.flat = true; this.classList.add('on'); $('vLight').classList.remove('on'); dirty = true; };
$('vBefore').onclick = function () { before = !before; this.classList.toggle('on', before); syncSlots(); status(before ? 'before: the figure\'s decals' : 'after: the painted layers'); };
$('lipTone').oninput = function () { PAINT.tone.lip = +this.value; dirty = true; }; $('cavity').oninput = function () { PAINT.tone.cavity = +this.value; dirty = true; };
var views = { cFront: [0, 2], cL: [35, 4], cR: [-35, 4], cSide: [80, 2] };
Object.keys(views).forEach(function (k) { $(k).onclick = function () { A.cam.az = views[k][0]; A.cam.el = views[k][1]; A.cam.tgt = [0, 1.49, 0.03]; A.cam.dist = 0.42; dirty = true; }; });
var stampSel = $('stamp'); Object.keys(FIG.BROW_STYLES).forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = 'brow · ' + FIG.BROW_STYLES[k].zh; stampSel.appendChild(o); });
[['flower', '花鈿 flower'], ['dot', 'dot'], ['blob', 'soft blob (rouge)'], ['lip', '點脣 lips']].forEach(function (q) { var o = document.createElement('option'); o.value = q[0]; o.textContent = q[1]; stampSel.appendChild(o); });

/* ---------- save / load ---------- */
function paintJSON() {
  var c = document.createElement('canvas'); c.width = Wd; c.height = Ht; var g = c.getContext('2d');
  return { size: [Wd, Ht], proj: PJ, tone: { lip: PAINT.tone.lip, cavity: PAINT.tone.cavity }, layers: LAYERS.map(function (L) { g.putImageData(new ImageData(new Uint8ClampedArray(L.data), Wd, Ht), 0, 0);
    return { name: L.name, opacity: L.opacity, blend: L.blend, visible: L.visible, gloss: L.gloss, png: c.toDataURL('image/png') }; }) };
}
$('save').onclick = function () {
  DEF.paint = paintJSON(); FIG.styleStore(FULL, STYLE, { paint: DEF.paint }); FULL.version = FIG.VERSION; FULL.params = FULL.params || {}; FULL.params.lashes = JSON.parse(JSON.stringify(LSH()));   // (Song paint → styles.song.paint; Tang paint untouched)
  var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(FULL, null, 1)], { type: 'application/json' })); a.download = 'figure.' + STYLE + '.json'; a.click();
  status('saved figure.' + STYLE + '.json with ' + LAYERS.length + ' ' + STYLE + ' paint layers — put it next to stage.html');
};
$('load').onclick = function () { $('file').click(); };
$('file').onchange = function () { var f = this.files[0]; if (!f) return; f.text().then(function (t) { var d = JSON.parse(t); FIG.upgrade(d); return setup(d); }); };

/* ---------- start ---------- */
A.cam.az = 0; A.cam.el = 2; A.cam.tgt = [0, 1.49, 0.03]; A.cam.dist = 0.42; A.cam.fov = 26;
(function loop() { if (dirty && head) { dirty = false; A.render(null); if (lashEdit) placeHandles(); } requestAnimationFrame(loop); })();
A.loadFigure().then(function (d) { FIG.upgrade(d); return setup(d); }).catch(function (e) { status('error: ' + e.message); console.error(e); });
window.FACE = { lashEdit: function (on) { lashEdit = on; $('lEdit').classList.toggle('on', on); placeHandles(); }, pick: pick, strokeTo: strokeTo, beginStroke: beginStroke, endStroke: endStroke, setTool: setTool, layers: function () { return LAYERS; }, setActive: function (i) { active = i; renderLayers(); }, paintJSON: paintJSON, ready: function () { return !!head && LAYERS.length > 0 && !!PAINT.tex; }, redraw: function () { dirty = true; } };
})();
