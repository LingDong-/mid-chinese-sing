/* band.js — a fuller 燕樂-style ensemble around sing.js's voice (sing.js itself is used untouched).
   笙 sheng (gagaku-like clusters on the tune) · 笛 di (heterophony with membrane buzz) · 簫 xiao · 琵琶 pipa · 箏 zheng (runs, fills)
   · 阮 ruan (low line) · 鼓 drum · 拍板 clapper · 方響 chime. Verses build up: the first stanza (or first half) is lighter.
   Browser: after sing.js, <script src="band.js"></script> → window.BAND      Node: require('./band.js')
   BAND.render(song, opts) → {L, R, sr, syls}   opts as SING.render, plus band: any of 'sheng di xiao pipa zheng ruan drum ban bell'
*/
(function (root) {
'use strict';
var SING = root.SING || require('./sing.js'), PI = Math.PI, EV = null, PART = '';   // EV/PART: optional note log (opts.events), for music.html
var PENTA = [0, 2, 4, 7, 9], md = function (x) { return ((x % 12) + 12) % 12; };
var hz = function (m) { return 440 * Math.pow(2, (m - 69) / 12); };
function seeded(s) { s = (s * 2654435761) >>> 0 || 1; return function () { s += 0x6D2B79F5; var t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function pstep(p, dir) { do p += dir; while (PENTA.indexOf(md(p)) < 0); return p; }

function Bus(n) { return { L: new Float32Array(n), R: new Float32Array(n), S: new Float32Array(n) }; }
function add(b, i, v, pan, send) { if (i < 0 || i >= b.L.length) return; b.L[i] += v * (1 - pan); b.R[i] += v * (1 + pan); b.S[i] += v * send; }

// sustained winds: a legato line of {m, t0, t1}; P = {harm, noise, buzz, vib, att, rel, gain, pan, send, det}
function wind(b, sr, line, P, rnd) {
  if (!line.length) return;
  if (EV) line.forEach(function (n) { EV.push({ part: P.part, m: n.m, t0: n.t0, t1: n.t1 }); });
  var a = Math.floor(line[0].t0 * sr), e = Math.floor((line[line.length - 1].t1 + P.rel + 0.05) * sr), k = 0, f = hz(line[0].m), ph = [0, 0], vp = rnd() * 6, r1 = 0, r2 = 0, hp = 0;
  var end = line[line.length - 1].t1, st = line[0].t0;
  for (var s = a; s < e; s++) {
    var t = s / sr;
    while (k < line.length - 1 && t >= line[k + 1].t0) k++;
    var N = line[k], into = t - N.t0;
    f += (hz(N.m) - f) * (1 - Math.exp(-1 / (0.02 * sr)));
    var vib = P.vib && into > 0.35 ? P.vib * Math.min(1, (into - 0.35) / 0.4) * Math.sin(2 * PI * 5 * t + vp) : 0;
    var env = Math.min(1, (t - st) / P.att) * Math.max(0, Math.min(1, (end - t) / P.rel + 1)) * (k && into < 0.04 && N.m !== line[k - 1].m ? 0.8 + 5 * into : 1);
    var y = 0;
    for (var v = 0; v < (P.det ? 2 : 1); v++) {
      ph[v] += f * (1 + vib + (v ? P.det : 0)) / sr; ph[v] -= Math.floor(ph[v]);
      for (var h = 0; h < P.harm.length; h++) y += P.harm[h] * Math.sin(2 * PI * (h + 1) * ph[v] + h);
    }
    var w = rnd() * 2 - 1, q = Math.exp(-PI * f * 0.3 / sr), c = 2 * q * Math.cos(2 * PI * f / sr), ns = (1 - q) * w + c * r1 - q * q * r2; r2 = r1; r1 = ns;
    if (P.buzz) { var bz = y * y * y; hp += (bz - hp) * 0.2; y += (bz - hp) * P.buzz; }   // 笛膜 membrane rattle
    add(b, s, P.gain * env * (y + ns * P.noise), P.pan, P.send);
  }
}
// Karplus–Strong pluck
function pluck(b, sr, t0, m, amp, bright, decay, pan, send, rnd) {
  if (EV) EV.push({ part: PART, m: m, t0: t0, t1: t0 + Math.min(1, decay * 0.4) });
  var f = hz(m), N = Math.max(2, Math.round(sr / f)), line = new Float32Array(N), lp = 0, a = Math.floor(t0 * sr), len = Math.floor(decay * 1.2 * sr);
  for (var i = 0; i < N; i++) { lp += ((rnd() * 2 - 1) - lp) * bright; line[i] = lp; }
  var rho = Math.pow(10, -3 / (decay * f)), p = 0, dc = 0;
  for (var s = 0; s < len; s++) { var cur = line[p]; line[p] = rho * 0.5 * (cur + line[(p + 1) % N]); p = (p + 1) % N; dc += (cur - dc) * 0.002; add(b, a + s, amp * (cur - dc) * Math.min(1, s / 30), pan, send); }
}
function drum(b, sr, t0, amp, rnd) {
  if (EV) EV.push({ part: 'drum', t0: t0, t1: t0 + 0.25, v: amp });
  var a = Math.floor(t0 * sr), ph = 0;
  for (var s = 0; s < sr * 0.6; s++) { var t = s / sr; ph += (78 + 60 * Math.exp(-t * 25)) / sr; add(b, a + s, amp * (Math.sin(2 * PI * ph) * Math.exp(-t * 6) + (rnd() - 0.5) * 0.4 * Math.exp(-t * 45)), 0, 0.2); }
}
function clap(b, sr, t0, amp, rnd) {
  if (EV) EV.push({ part: 'ban', t0: t0, t1: t0 + 0.12 });
  var a = Math.floor(t0 * sr), fr = [1850, 2900, 4300], st = [[0, 0], [0, 0], [0, 0]];
  for (var s = 0; s < sr * 0.12; s++) {
    var x = s < sr * 0.004 ? rnd() * 2 - 1 : 0, y = 0;
    for (var j = 0; j < 3; j++) { var q = Math.exp(-PI * 260 / sr), c = 2 * q * Math.cos(2 * PI * fr[j] / sr), o = x + c * st[j][0] - q * q * st[j][1]; st[j][1] = st[j][0]; st[j][0] = o; y += o * [1, 0.6, 0.35][j]; }
    add(b, a + s, amp * y * 0.006, 0.1, 0.2);
  }
}
function chime(b, sr, t0, m, amp) {
  if (EV) EV.push({ part: 'bell', m: m, t0: t0, t1: t0 + 2 });   // 方響: struck metal slab, inharmonic partials
  var a = Math.floor(t0 * sr), f = hz(m), P = [[1, 1, 1.6], [2.76, 0.5, 3], [5.4, 0.25, 5], [8.93, 0.12, 8]];
  for (var s = 0; s < sr * 3; s++) { var t = s / sr, y = 0; for (var j = 0; j < 4; j++) y += P[j][1] * Math.sin(2 * PI * f * P[j][0] * t) * Math.exp(-t * P[j][2]); add(b, a + s, amp * y * Math.min(1, s / 20), -0.15, 0.5); }
}
function reverb(b, sr, wet, size) {
  var n = b.L.length, sc = sr / 44100, CB = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], AP = [556, 441, 341, 225];
  [b.L, b.R].forEach(function (out, ch) {
    var combs = CB.map(function (l) { return { b: new Float32Array(Math.round((l + ch * 23) * sc * size)), i: 0, f: 0 }; });
    var aps = AP.map(function (l) { return { b: new Float32Array(Math.round((l + ch * 23) * sc)), i: 0 }; });
    for (var s = 0; s < n; s++) {
      var x = b.S[s] * 0.015, y = 0;
      for (var c = 0; c < 8; c++) { var C = combs[c], o = C.b[C.i]; C.f = o * 0.65 + C.f * 0.35; C.b[C.i] = x + C.f * 0.87; C.i = (C.i + 1) % C.b.length; y += o; }
      for (var a = 0; a < 4; a++) { var A = aps[a], bo = A.b[A.i]; A.b[A.i] = y + bo * 0.5; A.i = (A.i + 1) % A.b.length; y = bo - y; }
      out[s] += y * wet;
    }
  });
}

function render(song, o) {
  o = o || {};
  var sr = o.sr || 44100, spb = 60 / song.tempo, rnd = seeded((o.seed || 1) * 733 + 11), parts = o.band || 'sheng di xiao pipa zheng ruan drum ban bell';
  var has = function (k) { return parts.indexOf(k) >= 0; };
  EV = o.events || null;
  var V = SING.render(song, { voice: o.voice, seed: o.seed, key: o.key, band: '', reverb: 0, raw: true, sr: sr, intro: o.intro, inflect: o.inflect, events: EV });
  var S0 = song.phrases[0].syl[0], lead = V.syls[0].on - S0.t * spb, gongM = V.syls[0].notes[0] - S0.notes[0].p;
  var low = /man|elder/.test(o.voice || '') ? 12 : 0, T = function (b) { return lead + b * spb; };
  var n = Math.max(V.L.length, Math.ceil((T(song.beats) + 6) * sr)), b = Bus(n), s;
  for (s = 0; s < V.L.length; s++) { b.L[s] += V.L[s]; b.R[s] += V.R[s]; b.S[s] += V.L[s] * 0.25; }

  // the tune as phrases of notes (with the intro = the last phrase played before the voice enters)
  var PH = song.phrases.map(function (ph, i) {
    var ns = [];
    ph.syl.forEach(function (S) { var tb = S.t; S.notes.forEach(function (x) { ns.push({ p: x.p, b0: tb, b1: tb + x.d, main: tb === S.t, syl: S }); tb += x.d; }); });
    var nPh = song.phrases.length, st = song.stanzas.length;
    var sec = st > 1 ? song.stanzas.findIndex(function (s) { return s.indexOf(ph) >= 0; }) : i >= nPh / 2 ? 1 : 0;
    return { ph: ph, ns: ns, b0: ph.t, b1: ns[ns.length - 1].b1, full: sec > 0, last: i === nPh - 1 };
  });
  var lastPh = PH[PH.length - 1], introB = lead / spb - 0.6 / spb;
  if (o.intro !== false) {
    var off = -1 - lastPh.b1, ins = lastPh.ns.filter(function (x) { return x.b1 + off > -introB + 1e-9; })   // the last line ending a beat before the voice (a short prelude keeps its tail)
      .map(function (x) { return { p: x.p, b0: Math.max(x.b0 + off, -introB), b1: x.b1 + off, main: x.main || x.b0 + off < -introB }; });
    if (ins.length) PH.unshift({ ns: ins, b0: ins[0].b0, b1: lastPh.b1 + off, full: true, intro: true });
  }
  var fin = song.final;

  PH.forEach(function (P, pi) {
    var ns = P.ns, nx = PH[pi + 1], gapEnd = nx ? nx.b0 : P.b1 + 3;
    // 笙: three sustained lines — the tune, a fifth/fourth (whichever is in the pentatonic), the octave above
    if (has('sheng')) [0, 1, 2].forEach(function (v) {
      var line = ns.filter(function (x) { return x.main || x.b1 - x.b0 >= 1; }).map(function (x) {
        var p = x.p + low, q = v === 0 ? p : v === 2 ? p + 12 : PENTA.indexOf(md(p + 7)) >= 0 ? p + 7 : p + 5;
        return { m: gongM + q, t0: T(x.b0), t1: T(x.b1) };
      });
      for (var j = 0; j < line.length - 1; j++) line[j].t1 = line[j + 1].t0;
      if (line.length) line[line.length - 1].t1 = T(Math.min(gapEnd, P.b1 + 1.5)) - 0.1;
      wind(b, sr, line, { harm: [1, 0.55, 0.45, 0.3, 0.25, 0.18, 0.12, 0.08], part: 'sheng', noise: 0.05, att: 0.12, rel: 0.25, gain: (P.full ? 0.014 : 0.01) * (v ? 0.7 : 1), pan: 0.35 - v * 0.1, send: 0.5, det: 0.0012, vib: 0 }, rnd);
    });
    // 笛 (full sections) / 簫 (light sections): heterophony an octave up, graces and trills on long notes
    var useDi = has('di') && P.full, useXiao = has('xiao') && !useDi;
    if (useDi || useXiao) {
      var o8 = (useDi ? 12 : 0) + low, line = [];
      ns.forEach(function (x) {
        var a = T(x.b0), e = T(x.b1), m = gongM + x.p + o8;
        if (rnd() < 0.3 && x.b1 - x.b0 >= 1) line.push({ m: gongM + pstep(x.p, 1) + o8, t0: a - 0.07, t1: a });
        if (x.b1 - x.b0 >= 2 && useDi) { line.push({ m: m, t0: a, t1: a + (e - a) * 0.4 }); for (var tt = a + (e - a) * 0.4; tt < a + (e - a) * 0.6; tt += 0.07) line.push({ m: line.length % 2 ? gongM + pstep(x.p, 1) + o8 : m, t0: tt, t1: tt + 0.07 }); line.push({ m: m, t0: a + (e - a) * 0.6, t1: e }); }
        else line.push({ m: m, t0: a, t1: e });
      });
      if (gapEnd - P.b1 >= 1.5 && !P.intro) {   // answer the singer in the rest
        var e2 = ns.filter(function (x) { return x.main; }).slice(-3).map(function (x) { return x.p; }).reverse();
        e2.forEach(function (p, j) { line.push({ m: gongM + p + o8, t0: T(P.b1 + 0.5 * j), t1: T(P.b1 + 0.5 * (j + 1)) }); });
        line[line.length - 1].t1 = T(gapEnd) - 0.2;
      }
      wind(b, sr, line, useDi ? { part: 'di', harm: [1, 0.4, 0.28, 0.15, 0.1, 0.05], noise: 0.12, buzz: 0.25, att: 0.04, rel: 0.12, gain: 0.021, pan: -0.25, send: 0.4, vib: 0.007 }
        : { part: 'xiao', harm: [1, 0.13, 0.05], noise: 0.5, att: 0.07, rel: 0.2, gain: 0.04, pan: 0.3, send: 0.45, vib: 0.005 }, rnd);
    }
    // 琵琶: the tune note on every beat (octave below on the downbeat), 輪指 on long cadences
    if (has('pipa')) { PART = 'pipa';
      var po = gongM + low - 12;
      for (var bt = Math.ceil(P.b0); bt < P.b1; bt++) {
        var x = ns.filter(function (z) { return z.b0 <= bt && z.b1 > bt; })[0]; if (!x) continue;
        var down = md(Math.round(bt)) % 4 === 0, longEnd = x === ns[ns.length - 1] && x.b1 - x.b0 >= 2;
        if (!P.full && !down && !longEnd && bt !== Math.ceil(P.b0)) continue;
        pluck(b, sr, T(bt), po + x.p + 12, 0.14, 0.75, 1.2, -0.45, 0.3, rnd);
        if (down) pluck(b, sr, T(bt) + 0.025, po + x.p, 0.12, 0.6, 1.4, -0.45, 0.3, rnd);
        if (longEnd && bt === Math.ceil(x.b0) && P.full) for (var tq = T(bt) + 0.4; tq < T(x.b1) - 0.3; tq += 1 / 12) pluck(b, sr, tq, po + x.p + 12, 0.05, 0.75, 0.8, -0.45, 0.3, rnd);
      }
    }
    // 箏: an upward glissando into each full phrase, a falling pentatonic arpeggio in rests
    if (has('zheng') && P.full) { PART = 'zheng';
      var zf = gongM + low, first = ns[0].p, g = first - 12;
      for (var k = 0; g < first; k++, g = pstep(g, 1)) pluck(b, sr, T(P.b0) - 0.045 * (6 - Math.min(6, k)) - 0.05, zf + g, 0.09 + 0.015 * k, 0.8, 2.2, 0.5, 0.4, rnd);
      if (gapEnd - P.b1 >= 1.5) for (var j2 = 0, z = ns[ns.length - 1].p + 12; j2 < 6; j2++, z = pstep(z, -1)) pluck(b, sr, T(P.b1 + 0.5 + j2 * 0.25), zf + z, 0.1, 0.8, 2.2, 0.5, 0.4, rnd);
    }
    // 阮: low line, the tune's degree two octaves down on beats 1 and 3
    PART = 'ruan'; if (has('ruan') && P.full) for (var bb = Math.ceil(P.b0 / 2) * 2; bb < P.b1; bb += 2) {
      var xr = ns.filter(function (z) { return z.b0 <= bb && z.b1 > bb; })[0]; if (!xr) continue;
      var r = xr === ns[ns.length - 1] ? fin : xr.p; pluck(b, sr, T(bb), gongM + low - 12 + md(r) - (md(r) > 7 ? 12 : 0), 0.2, 0.35, 1.6, 0.05, 0.15, rnd);
    }
    // percussion: drum pattern in full sections, 拍板 on phrase ends, 方響 at stanza starts and the end
    if (has('drum') && P.full) for (var d = Math.ceil(P.b0); d < Math.min(gapEnd, P.b1 + 2); d++) { var bi = md(d) % 4; drum(b, sr, T(d), bi === 0 ? 0.05 : bi === 2 ? 0.03 : 0.012, rnd); if (bi === 3) drum(b, sr, T(d + 0.5), 0.015, rnd); }
    if (has('ban') && !P.intro) { var ls = ns[ns.length - 1]; clap(b, sr, T(Math.floor(ls.b0)), P.ph.end === '。' ? 0.9 : 0.5, rnd); }
    if (has('bell') && !P.intro && song.stanzas.some(function (st) { return st[0] === P.ph; })) chime(b, sr, T(P.b0), gongM + fin + 12 + low, 0.03);
  });
  if (has('bell')) chime(b, sr, T(song.beats) + 0.1, gongM + fin + 12 + low, 0.04);
  if (has('sheng')) [0, 7, 12].forEach(function (iv) { wind(b, sr, [{ m: gongM + fin + low + iv, t0: T(song.beats) + 0.05, t1: T(song.beats) + 3 }], { part: 'sheng', harm: [1, 0.55, 0.45, 0.3, 0.25, 0.18], noise: 0.05, att: 0.5, rel: 1.2, gain: 0.008, pan: 0.3, send: 0.5, det: 0.0012 }, rnd); });

  reverb(b, sr, o.reverb == null ? 0.28 : o.reverb, 1.35);
  var pk = 0; for (s = 0; s < n; s++) pk = Math.max(pk, Math.abs(b.L[s]), Math.abs(b.R[s]));
  var gn = o.raw ? 1 : 0.89 / (pk || 1); for (s = 0; s < n; s++) { b.L[s] *= gn; b.R[s] *= gn; }
  return { L: b.L, R: b.R, sr: sr, syls: V.syls };
}

var BAND = { render: render };
if (typeof module !== 'undefined' && module.exports) module.exports = BAND; else root.BAND = BAND;
})(this);
