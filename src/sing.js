/* sing.js — Middle Chinese art song. Composes a melody for a Tang/Song poem using rules learned from 姜夔's
   白石道人歌曲 (see tool/analyze.js), sings it with the mcsynth.js formant voice, and accompanies it.
   Browser: <script src="speech/mcsynth.js"></script><script src="sing.js"></script> → window.SING     Node: require('./sing.js')

   SING.compose(text, dict, opts) → song
       text: poem; ，、 = phrase end, 。！？； or newline = rhyme/sentence end, blank line = new stanza; 多音字: 字[2] or 字[baxter]
       opts: mode 宮|商|角|徵|羽 (default from seed) · seed · tempo (bpm, 66) · toneWeight (1; 0 = ignore tones)
             temp (sampling temperature, 0.9) · era: 'late' (Late Tang, default) | 'high' (盛唐: 濁上 stays 上, no register split)
             template: an earlier song (sing new words to its tune, adjusted to the tones)
             melody: fixed tune, 簡譜 tokens one per syllable (1 = 宮, ' and , for octaves, e.g. "6 1' 2'3' 5"), or [[semitones above 宮]]
   SING.render(song, opts) → {L, R, sr}
       opts: voice (woman|man|elder|crone|child) · key (midi of the mode final; default by voice) · seed (singer identity)
             band: 'xiao pipa perc' (any of xiao pipa qin perc) · mix: {voice, xiao, pluck, perc} gains · reverb (0.25) · intro (true = the last line as a prelude; a number = only its last n beats; false = none)
   SING.score(song) → 簡譜 text     SING.wav(L, R, sr) → Uint8Array     SING.POEMS → [{title, text}]
*/
(function (root) {
'use strict';
var MC = root.MC || (typeof require !== 'undefined' ? require('./speech/mcsynth.js') : null);
var PI = Math.PI, EV = null;   // EV: optional note log (render opts.events), for music.html

/* ---- learned from 8 songs / 559 syllables of 白石道人歌曲 (丘瓊蓀's 簡譜), see tool/analyze.js ----
   IV[g][d]: interval d (semitones, nearest octave) leaving scale degree g (semitones above 宮)
   TD[ab]: [up, same, down] counts for the step from a syllable of tone a to one of tone b (P 平 X 上 H 去 R 入)
   DEG: degree use · CAD: phrase-end degree relative to the mode final ('。' sentence/rhyme end, '，' clause end) */
var IV = {"0":{"0":1,"2":18,"4":25,"-1":10,"-3":18,"-6":8},"2":{"2":15,"4":7,"5":4,"-3":5,"-5":5,"-2":36},"4":{"0":2,"2":11,"3":13,"5":5,"-4":12,"-5":6,"-2":33},"6":{"0":1,"1":11,"3":4,"-2":38,"-6":1},"7":{"0":6,"2":30,"4":14,"5":14,"-1":12,"-3":8,"-5":2},"9":{"2":5,"3":17,"5":6,"-5":14,"-2":33,"-3":6},"11":{"1":2,"3":1,"-2":28,"-5":3,"-4":1}};
var TD = {"HP":[35,2,15],"PP":[34,3,94],"PH":[19,1,35],"HX":[7,0,7],"XP":[10,2,10],"HR":[16,0,6],"RP":[11,0,14],"PX":[4,1,24],"XH":[2,0,3],"HH":[14,0,8],"PR":[4,1,23],"RH":[3,0,7],"RX":[0,0,2],"XR":[6,0,1],"RR":[2,0,3],"XX":[1,0,1]};
var DEG = {"0":103,"2":77,"4":128,"6":57,"7":87,"9":120,"11":42};
var CAD = {"。0":29,"。4":10,"。7":14,"。9":4,"。3":3,"，0":12,"，2":5,"，4":17,"，5":1,"，7":7,"，9":12,"，11":5,"，3":3,"，10":1};

var SCALE = [0, 2, 4, 6, 7, 9, 11];                       // 宮 商 角 變徵 徵 羽 變宮 (Jiang Kui's 雅樂 scale)
var MODES = { '宮': 0, '商': 2, '角': 4, '徵': 7, '羽': 9 };
var TONES = 'PXHR', DIRS = [0, 1, 2];                     // up, same, down
var md = function (x) { return ((x % 12) + 12) % 12; };
var inScale = function (p) { return SCALE.indexOf(md(p)) >= 0; };

// log P(interval | degree), smoothed toward the corpus-wide interval distribution
var LIV = {}, GI = {}, GN = 0;
Object.keys(IV).forEach(function (g) { for (var d in IV[g]) { GI[d] = (GI[d] || 0) + IV[g][d]; GN += IV[g][d]; } });
SCALE.forEach(function (g) {
  var row = IV[g] || {}, n = 0; for (var d in row) n += row[d];
  LIV[g] = {};
  for (var d2 = -12; d2 <= 12; d2++) {
    var nd = d2 === 6 ? -6 : d2, a = Math.abs(d2);
    var glob = a <= 6 ? ((GI[nd] || 0) + 0.5) / (GN + 6) * (d2 === 6 || d2 === -6 ? 0.5 : 1) : a <= 9 ? 0.012 : a === 12 ? 0.006 : 0.001;
    var c = a <= 6 ? (row[nd] || 0) * (a === 6 ? 0.5 : 1) : 0;
    LIV[g][d2] = Math.log((c + 6 * glob) / (n + 6));
  }
});
// tone → direction, as log-ratio against the base rate (the interval model already has the base rate)
var PD = [0, 0, 0], PDN = 0, TROW = {}, LTD = {};
for (var k in TD) for (var i = 0; i < 3; i++) { PD[i] += TD[k][i]; PDN += TD[k][i]; (TROW[k[0]] = TROW[k[0]] || [0, 0, 0])[i] += TD[k][i]; }
TONES.split('').forEach(function (a) {
  var r = TROW[a], rn = r[0] + r[1] + r[2];
  TONES.split('').forEach(function (b) {
    var c = TD[a + b] || [0, 0, 0], n = c[0] + c[1] + c[2];
    LTD[a + b] = DIRS.map(function (j) {
      var pr = (r[j] + 2 * PD[j] / PDN) / (rn + 2), p = (c[j] + 3 * pr) / (n + 3);
      return Math.log(p / (PD[j] / PDN));
    });
  });
});
var LDEG = {}, DN = 0; for (var g in DEG) DN += DEG[g]; for (g in DEG) LDEG[g] = Math.log(DEG[g] / DN);

function seeded(s) { s = (s * 2654435761) >>> 0 || 1; return function () { s += 0x6D2B79F5; var t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* ============ text → stanzas → phrases → syllables ============ */
// readings that beat the dictionary's first entry in most verse contexts (context-dependent ones: mark in the text, e.g. 朝[2])
var PREF = { '不': 'pjut', '能': 'nong', '出': 'tsyhwit', '怨': "'jwonH", '遠': 'hjwonX', '度': 'duH', '簪': 'tsrim', '濺': 'tsjenH', '看': 'khan', '過': 'kwa' };
var VARI = { '窗': '窻', '鞍': '鞌', '峰': '峯', '群': '羣', '嘆': '歎', '床': '牀' };
function parseText(text, dict, era) {   // era: 'late' (default) | 'high' (盛唐), see speech/mcsynth.js
  var song = { stanzas: [], warn: [] }, st = [], ph = [];
  function endPh(e) { if (ph.length) { st.push({ syl: ph, end: e }); ph = []; } }
  function endSt() { endPh('。'); if (st.length) { st[st.length - 1].end = '。'; song.stanzas.push(st); st = []; } }
  text.replace(/\r/g, '').split(/\n\s*\n/).forEach(function (block) {
    (block.match(/[^\x00-\x7f][\[［][^\]］]*[\]］]|[\s\S]/gu) || []).forEach(function (t) {
      if (t === '\n') { if (ph.length) endPh('。'); return; }
      if (/^[，,、：:]$/.test(t)) return endPh('，');
      if (/^[。.！!？?；;]$/.test(t)) return endPh('。');
      if (/^[\s《》「」『』“”"'（）()·—\-]$/.test(t)) return;
      var ch = String.fromCodePoint(t.codePointAt(0)), sel = t.slice(ch.length);
      var c2 = dict[ch] ? ch : VARI[ch] && dict[VARI[ch]] ? VARI[ch] : ch;
      var s = MC.parse(sel ? c2 + sel : PREF[ch] && dict[c2] && dict[c2].split(' ').indexOf(PREF[ch]) >= 0 ? c2 + '[' + PREF[ch] + ']' : c2, dict, era)[0];
      if (!s || s.pause) { song.warn.push(ch); return; }
      s.ch = ch; ph.push({ ch: ch, s: s, tone: s.tone });
    });
    endSt();
  });
  return song;
}

/* ============ composer ============ */
function rhythm(ph, rnd, dot) {   // beats per syllable; long final; rest after sentence ends
  var n = ph.syl.length, d = [], i;
  for (i = 0; i < n - 1; i++) d.push(1);
  for (i = 0; i + 1 < n - 1; i += 2) if (rnd() < dot) { d[i] = 1.5; d[i + 1] = 0.5; }
  for (i = 0; i < n - 1; i++) if (ph.syl[i].tone === 'R' && d[i] > 1 && i + 1 < n - 1) { d[i] = 0.5; d[i + 1] = 1.5; }   // 入 wants the short slot
  var body = d.reduce(function (a, b) { return a + b; }, 0), sent = ph.end === '。';
  var last = sent ? 3 : 2, rest = sent ? 1 : 0, unit = sent ? 4 : 2, pad = Math.ceil((body + last + rest) / unit) * unit - body - last - rest;
  last += Math.ceil(pad / 2); rest += Math.floor(pad / 2);
  d.push(last); return { d: d, rest: rest };
}

// sample a phrase melody (main pitch per syllable) from the learned model: forward filtering, backward sampling
function melody(ph, c) {
  var n = ph.syl.length, P = c.cands, K = P.length, tw = c.toneW, T = 1 / c.temp, A = [], i, j, k;
  function un(i, p) {
    var g = md(p), u = LDEG[g] - Math.pow((p - c.center) / 9, 2) * 1.2;
    if (c.tpl && c.tpl[i] != null) u += p === c.tpl[i] ? 0 : -3 - 0.3 * Math.abs(p - c.tpl[i]);
    if (g === 6 || g === 11) u -= i === 0 || i === n - 1 || ph.dur[i] >= 1.5 ? 4 : 0.8;   // 變 tones: passing notes only
    if (i === n - 1) {
      var r = md(p - c.final);
      if (c.close) u += r === 0 ? (p === c.final ? 0 : -1.5) : -Infinity;
      else u += 1.5 * Math.log(((CAD[ph.end + r] || 0) + 0.5) / 60);
    }
    return u;
  }
  function tr(i, q, p) {
    var d = p - q; if (Math.abs(d) > 12) return -Infinity;
    var v = LIV[md(q)][d];
    if (tw) v += tw * LTD[ph.syl[i - 1].tone + ph.syl[i].tone][d > 0 ? 0 : d ? 2 : 1];
    return v;
  }
  function lse(a) { var m = -Infinity, s = 0, x; for (x = 0; x < a.length; x++) m = Math.max(m, a[x]); if (m === -Infinity) return m; for (x = 0; x < a.length; x++) s += Math.exp(a[x] - m); return m + Math.log(s); }
  function pick(w) { var m = -Infinity, s = 0, x, r; for (x = 0; x < w.length; x++) m = Math.max(m, w[x]); for (x = 0; x < w.length; x++) s += (w[x] = Math.exp(w[x] - m)); r = c.rnd() * s; for (x = 0; x < w.length; x++) if ((r -= w[x]) <= 0) return x; return w.length - 1; }
  // second order: state (previous pitch, this pitch); penalise leap-and-back zig-zags (1' 6 1' 6)
  function zz(z, a, b) { return b === z && Math.abs(a - z) >= 3 ? -0.5 : 0; }
  var u0 = P.map(function (p) { var u = un(0, p); if (c.prev != null && Math.abs(p - c.prev) <= 9) u += 0.5 * LIV[md(c.prev)][p - c.prev]; return u * T; });
  if (n === 1) return [P[pick(u0.slice())]];
  A[1] = [];
  for (j = 0; j < K; j++) for (k = 0; k < K; k++) A[1][j * K + k] = u0[j] + (un(1, P[k]) + tr(1, P[j], P[k])) * T;
  for (i = 2; i < n; i++) {
    A[i] = [];
    for (j = 0; j < K; j++) for (k = 0; k < K; k++) {
      var w = [], ui = (un(i, P[k]) + tr(i, P[j], P[k])) * T;
      for (var z = 0; z < K; z++) w.push(A[i - 1][z * K + j] + zz(P[z], P[j], P[k]) * T);
      A[i][j * K + k] = ui + lse(w);
    }
  }
  var out = [], x = pick(A[n - 1].slice()), jj = Math.floor(x / K), kk = x % K;
  out[n - 1] = P[kk]; out[n - 2] = P[jj];
  for (i = n - 1; i > 1; i--) {
    var w2 = []; for (z = 0; z < K; z++) w2.push(A[i - 1][z * K + jj] + zz(P[z], P[jj], P[kk]) * T);
    var zi = pick(w2); kk = jj; jj = zi; out[i - 2] = P[zi];
  }
  return out;
}
function step(p, dir) { do p += dir; while (!inScale(p) || md(p) === 6 || md(p) === 11); return p; }   // pentatonic neighbour

// melismas, after the corpus: turns (1'2'1', 454) on long notes, upward 去 / downward 平 two-note figures
function ornament(ph, mel, rnd, top) {
  return ph.syl.map(function (S, i) {
    var p = mel[i], d = ph.dur[i], nx = mel[i + 1];
    if (i === ph.syl.length - 1 && d >= 2 && S.tone !== 'R' && step(p, 1) <= top) {
      var r = rnd();
      if (r < 0.3) return [{ p: p, d: 1 / 3 }, { p: step(p, 1), d: 1 / 3 }, { p: p, d: d - 2 / 3 }];
      if (r < 0.5) return [{ p: step(p, 1), d: 0.5 }, { p: p, d: d - 0.5 }];
    }
    if (nx != null && d >= 1) {
      if (S.tone === 'H' && nx > p && step(p, 1) <= nx && rnd() < 0.3) return [{ p: p, d: d / 2 }, { p: step(p, 1), d: d / 2 }];
      if (S.tone === 'P' && nx < p && step(p, -1) >= nx && rnd() < 0.12) return [{ p: p, d: d / 2 }, { p: step(p, -1), d: d / 2 }];
    }
    return [{ p: p, d: d }];
  });
}

function parseJianpu(str) {   // "6 1' 2'3'" → [[9], [12], [14, 16]] (semitones above 宮; 1 = 宮)
  var S = { 1: 0, 2: 2, 3: 4, 4: 5, 5: 7, 6: 9, 7: 11 };
  return str.trim().split(/\s+/).map(function (t) { return (t.match(/[1-7]#?['’,]*/g) || []).map(function (x) { return S[x[0]] + (/#/.test(x) ? 1 : 0) + 12 * ((x.match(/['’]/g) || []).length - (x.match(/,/g) || []).length); }); });
}

function compose(text, dict, o) {
  o = o || {};
  var seed = o.seed == null ? 1 : o.seed, rnd = seeded(seed * 31 + 7), song = parseText(text, dict, o.era);
  var modes = ['羽', '宮', '商', '徵', '羽', '宮', '角'], mode = MODES[o.mode] != null ? o.mode : modes[Math.floor(seeded(seed)() * modes.length)];
  var fin = MODES[mode], cands = [];
  for (var p = fin - 5; p <= fin + 14; p++) if (inScale(p)) cands.push(p);
  song.mode = mode; song.final = fin; song.tempo = o.tempo || 66; song.seed = seed;
  var fixed = o.melody ? (typeof o.melody === 'string' ? parseJianpu(o.melody) : o.melody) : null, fi = 0, tplPh = o.template ? [].concat.apply([], o.template.stanzas) : null;
  var dot = o.dot == null ? (rnd() < 0.5 ? 0 : 0.35) : o.dot;
  // groups for repetition: stanzas; an 8-line regulated poem counts as two quatrains
  var groups = [], all = [];
  song.stanzas.forEach(function (st) {
    var eq = st.every(function (x) { return x.syl.length === st[0].syl.length; });
    if (st.length === 8 && eq) { groups.push(st.slice(0, 4)); groups.push(st.slice(4)); } else groups.push(st);
  });
  var prev = null, gi = 0;
  groups.forEach(function (G, gix) {
    var quat = G.length === 4 && G.every(function (x) { return x.syl.length === G[0].syl.length && x.syl.length >= 4; });
    // an earlier group with the same shape (aligned from the end) lends its tune — 上下片 / second quatrain
    var src = null;
    for (var h = 0; h < gix && !src; h++) {
      var H = groups[h], m = 0;
      for (var q = 1; q <= Math.min(H.length, G.length); q++) if (Math.abs(H[H.length - q].syl.length - G[G.length - q].syl.length) <= 1) m++; else break;   // ±1: a 襯字
      if (m >= Math.max(2, G.length - 2)) src = H;
    }
    G.forEach(function (ph, k) {
      var tp = tplPh && tplPh[gi] && tplPh[gi].syl.length === ph.syl.length ? tplPh[gi] : null;
      if (!tp && src) {
        var a = src[src.length - (G.length - k)], dn = a ? ph.syl.length - a.syl.length : 9;
        if (!dn) tp = a;
        else if (Math.abs(dn) === 1) tp = { end: a.end, main: ph.syl.map(function (S, i) { return a.main[i - dn]; }) };   // aligned from the end (cadence); an extra syllable gets a free note
      }
      if (!tp && quat && k === 3) tp = G[1];
      ph.dur = tp && tp.dur ? tp.dur.slice() : null; ph.rest = tp ? tp.rest : 0;
      if (!ph.dur) { var r = rhythm(ph, rnd, dot); ph.dur = r.d; ph.rest = r.rest; }
      if (tp && ph.end !== tp.end) { var r2 = rhythm(ph, seeded(gi), 0); ph.dur[ph.dur.length - 1] = r2.d[r2.d.length - 1]; ph.rest = r2.rest; }
      var close = k === G.length - 1;   // every stanza / quatrain closes on the mode final
      if (fixed) {
        ph.notes = ph.syl.map(function (S, i) { var f = fixed[fi++] || [fin]; return f.map(function (x, j) { return { p: x, d: ph.dur[i] / f.length }; }); });
      } else {
        var mel = melody(ph, { cands: cands, final: fin, center: fin + 7 + Math.round(rnd() * 4 - 2) + (quat && k === 2 ? 3 : 0), prev: prev, tpl: tp && tp.main, close: close,
          toneW: o.toneWeight == null ? 1 : o.toneWeight, temp: o.temp || 0.9, rnd: rnd });
        ph.notes = tp && tp.notes && tp.main.every(function (x, i) { return x === mel[i]; }) ? tp.notes.map(function (ns) { return ns.map(function (x) { return { p: x.p, d: x.d }; }); }) : ornament(ph, mel, rnd, fin + 14);
      }
      ph.main = ph.notes.map(function (ns) { return ns[0].p; });
      prev = ph.notes[ph.notes.length - 1].slice(-1)[0].p; gi++; all.push(ph);
    });
  });
  // timeline in beats
  var t = 0;
  song.stanzas.forEach(function (st, si) {
    if (si) t += 4;   // interlude
    st.forEach(function (ph) { ph.t = t; ph.syl.forEach(function (S, i) { S.t = t; S.d = ph.dur[i]; S.notes = ph.notes[i]; t += ph.dur[i]; }); t += ph.rest; });
  });
  song.beats = t; song.phrases = all;
  return song;
}

/* ============ score ============ */
function score(song) {
  var NUM = { 0: '1', 2: '2', 4: '3', 5: '4', 6: '#4', 7: '5', 9: '6', 11: '7' }, TN = { P: '平', X: '上', H: '去', R: '入' };
  function nt(p) { var o = Math.floor(p / 12), s = NUM[md(p)] || '?'; return s + (o > 0 ? '̇' : '̣').repeat(Math.abs(o)); }
  function dur(d) { return d >= 2 ? ' -'.repeat(Math.round(d) - 1) : d === 1.5 ? '·' : d === 0.5 ? '_' : ''; }
  var out = [song.mode + '調式   1 = 宮   ♩ = ' + song.tempo + '   (變徵 = #4, 變宮 = 7)'];
  song.stanzas.forEach(function (st, si) {
    if (si) out.push('');
    st.forEach(function (ph) {
      var a = '', b = '', c = '';
      ph.syl.forEach(function (S, i) {
        var n = S.notes.map(function (x) { return nt(x.p); }).join('') + dur(S.d), w = Math.max(4, n.replace(/[̣̇]/g, '').length + 2);
        a += S.ch + ' '.repeat(w - 2); b += TN[S.tone] + ' '.repeat(w - 2); c += n + ' '.repeat(Math.max(1, w - n.replace(/[̣̇]/g, '').length));
      });
      out.push(a + ph.end, b, c + (ph.rest ? '0 '.repeat(Math.round(ph.rest)) : ''), '');
    });
  });
  return out.join('\n');
}

/* ============ singer: mcsynth speech plan, time-warped onto the notes ============ */
var CODA = { '': 0.07, 'i̯': 0.09, 'u̯': 0.09, m: 0.12, n: 0.12, 'ŋ': 0.12, p: 0.085, t: 0.085, k: 0.085 };
function sing(song, o, sr) {
  var spb = 60 / song.tempo, base = o.gongHz, rnd = seeded((o.seed || 1) * 977 + 5), G = {}, FS = [], syls = [];
  function push(n, t, v) { (G[n] || (G[n] = [])).push([t, v]); }
  var t0 = o.lead;
  song.phrases.forEach(function (ph) {
    var seq = ph.syl.map(function (S) { return S.s; });
    var P = MC.plan(seq, { rnd: rnd, rate: 1, finalLen: 1, range: 1, decl: 0 }), F = P.T.f0, n = seq.length;
    var on = ph.syl.map(function (S) { return t0 + S.t * spb; });
    var L = seq.map(function (S, i) {   // source landmarks
      var tv = F[1 + 3 * i][0], te = tv + (F[3 + 3 * i][0] - tv) / 0.95;
      return { st: 0, tv: tv, te: te, g: 0.05 * S.gl.length + 0.065, c: CODA[S.coda] || 0.08 };
    });
    L.forEach(function (l, i) { l.st = i ? L[i - 1].te : 0.06; });
    var M = [];   // per syllable: [src0, src1, dst0, dst1] pieces
    L.forEach(function (l, i) {
      var S = seq[i], lead = l.tv - l.st, cs = on[i] - lead, endBeat = t0 + (ph.syl[i].t + ph.syl[i].d) * spb, off;
      if (i < n - 1) off = on[i + 1] - (L[i + 1].tv - L[i + 1].st);
      else off = endBeat - (ph.rest ? 0.12 : 0.2);
      if (/[ptk]/.test(S.coda)) off = Math.min(off, on[i] + Math.max(0.16, Math.min(0.55, 0.7 * (off - on[i]))));   // 入: clipped
      off = Math.max(off, on[i] + 0.1);
      var Rs = l.te - l.tv, Rt = off - on[i];
      if (!i) M.push([0, l.st, cs - l.st, cs]);
      M.push([l.st, l.tv, cs, on[i]]);
      if (Rt <= Rs || Rs < l.g + l.c + 0.02) M.push([l.tv, l.te, on[i], off]);
      else { M.push([l.tv, l.tv + l.g, on[i], on[i] + l.g]); M.push([l.tv + l.g, l.te - l.c, on[i] + l.g, off - l.c]); M.push([l.te - l.c, l.te, off - l.c, off]); }
      syls.push({ S: S, cs: cs, on: on[i], off: off, notes: ph.syl[i].notes, t: ph.syl[i].t, last: i === n - 1, first: i === 0 });
    });
    function map(t) {
      for (var j = M.length - 1; j >= 0; j--) if (t >= M[j][0]) { var m = M[j], k = m[1] > m[0] ? (t - m[0]) / (m[1] - m[0]) : 1; return k <= 1 ? m[2] + (m[3] - m[2]) * k : m[3] + (t - m[1]); }
      return M[0][2];
    }
    for (var nm in P.T) if (nm !== 'f0' && nm !== 'FS') P.T[nm].forEach(function (e) { push(nm, map(e[0]), e[1]); });
    P.T.FS.forEach(function (e) { FS.push([map(e[0]), e[1]]); });
    // a soft inhale before phrases that follow a real pause
    var cs0 = syls[syls.length - n].cs, prevOff = syls.length > n ? syls[syls.length - n - 1].off : -1;
    if (cs0 - prevOff > 0.6) { push('AH', cs0 - 0.45, 0); push('AH', cs0 - 0.25, 0.045); push('AH', cs0 - 0.06, 0); }
  });
  var dur = syls[syls.length - 1].off + 1;
  // f0 (semitones re 宮): notes, legato glides, 上 scoop, 去 rising release, delayed vibrato
  var K = [], vib = [];
  syls.forEach(function (y, i) {
    var ns = y.notes, beatT = function (b) { return o.lead + b * spb; }, p0 = ns[0].p, tn = y.S.tone, inf = o.inflect;
    K.push([y.cs, p0 - (tn === 'X' ? 1.6 * inf : 0.3)]); K.push([y.on + (tn === 'X' ? 0.11 : 0.03), p0]);
    var tb = y.t;
    ns.forEach(function (x, j) {
      var a = Math.max(y.on, beatT(tb)), b = j === ns.length - 1 ? y.off : Math.min(y.off, beatT(tb + x.d));
      if (j) { K.push([a - 0.035, ns[j - 1].p]); K.push([a + 0.035, x.p]); }
      if (b - a > 0.45) vib.push([a + 0.2, b, y.last ? 0.42 : 0.34]);
      if (EV) EV.push({ part: 'voice', m: 69 + 12 * Math.log2(base / 440) + x.p, t0: j ? a : y.cs, t1: b, ch: j ? '' : y.S.ch, bax: j ? '' : y.S.bax });
      tb += x.d;
    });
    var pl = ns[ns.length - 1].p;
    if (tn === 'H' && y.off - y.on > 0.3) { K.push([y.off - 0.15, pl]); K.push([y.off, pl + 1.3 * inf]); }
    else K.push([y.off, pl]);
  });
  K.sort(function (a, b) { return a[0] - b[0]; });
  var f0 = [], kp = 0, ph = rnd() * 6, vp = 0;
  for (var t = 0; t < dur; t += 0.01) {
    while (kp < K.length - 1 && K[kp + 1][0] <= t) kp++;
    var a = K[kp], b = K[Math.min(kp + 1, K.length - 1)], v = t <= a[0] || b === a ? a[1] : a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
    while (vp < vib.length - 1 && vib[vp][1] < t) vp++;
    var V = vib[vp], dep = V && t > V[0] && t < V[1] ? V[2] * Math.min(1, (t - V[0]) / 0.3) * Math.min(1, (V[1] - t) / 0.08 + 0.3) : 0;
    ph += 2 * PI * 0.01 * (5.3 + 0.35 * Math.sin(t * 0.7));
    f0.push([t, v + dep * 1.3 * Math.sin(ph)]);
  }
  G.f0 = f0; G.FS = FS.sort(function (a, b) { return a[0] - b[0]; });
  ['AV', 'AH', 'AF', 'CR', 'FNZ', 'F1', 'F2', 'F3', 'B1', 'B2', 'B3'].forEach(function (k) { if (!G[k]) G[k] = [[0, k === 'FNZ' ? 270 : 0]]; });
  // sopranos tune F1 up to the voice pitch on high notes
  var fsc = o.v.fs || 1;
  G.F1.forEach(function (e) { var hz = base * Math.pow(2, pitchAt(f0, e[0]) / 12); e[1] = Math.max(e[1], hz * 1.02 / fsc); });
  var ro = {}, vk; for (vk in o.v) ro[vk] = o.v[vk];
  ro.sr = sr; ro.rnd = rnd; ro.f0 = base; ro.vib = 0; ro.whisper = 0;
  var x = MC.render({ T: G, dur: dur }, ro);
  // dynamics: gentle phrase arch, swell on long notes
  var env = new Float32Array(x.length).fill(1);
  syls.forEach(function (y) {
    var a = Math.floor(y.on * sr), b = Math.min(x.length, Math.floor(y.off * sr)), L = b - a;
    for (var s = a; s < b; s++) { var u = (s - a) / L; env[s] = (y.first ? 0.9 : 1) * (L > sr * 0.8 ? 0.92 + 0.13 * Math.sin(PI * Math.min(1, u * 1.15)) : 1) * (y.last ? 1 - 0.18 * u : 1); }
  });
  var ka = 1 - Math.exp(-1 / (0.02 * sr)), e1 = 1, s;   // smooth (both directions) so steps don't click
  for (s = 0; s < x.length; s++) env[s] = e1 += (env[s] - e1) * ka;
  for (s = x.length - 1; s >= 0; s--) env[s] = e1 += (env[s] - e1) * ka;
  for (s = 0; s < x.length; s++) x[s] *= env[s];
  return { x: x, syls: syls };
}
function pitchAt(f0, t) { var i = Math.max(0, Math.min(f0.length - 1, Math.round(t / 0.01))); return f0[i][1]; }

/* ============ band ============ */
function Bus(n) { return { L: new Float32Array(n), R: new Float32Array(n), S: new Float32Array(n) }; }
function add(bus, i, v, pan, send) { if (i < 0 || i >= bus.L.length) return; bus.L[i] += v * (1 - pan) ; bus.R[i] += v * (1 + pan); bus.S[i] += v * send; }
var hz = function (m) { return 440 * Math.pow(2, (m - 69) / 12); };

// 簫: end-blown flute — sine-ish tone + breath noise through a resonator at the pitch; legato within a group
function xiao(bus, sr, group, rnd, gain, pan) {
  if (!group.length) return;
  var a = Math.floor(group[0].t0 * sr), b = Math.floor((group[group.length - 1].t1 + 0.25) * sr), ph = 0, f = hz(group[0].m), k = 0, nz = 0, r1 = 0, r2 = 0;
  var vibP = rnd() * 6;
  for (var s = a; s < b; s++) {
    var t = s / sr;
    while (k < group.length - 1 && t >= group[k + 1].t0) k++;
    var N = group[k], ft = hz(N.m), into = t - N.t0, len = N.t1 - N.t0;
    f += (ft - f) * (1 - Math.exp(-1 / (0.018 * sr)));
    var vib = into > 0.3 ? Math.min(1, (into - 0.3) / 0.4) * 0.006 * Math.sin(2 * PI * 4.8 * t + vibP) : 0;
    ph += f * (1 + vib) / sr; if (ph > 1) ph -= 1;
    var env = Math.min(1, (t - group[0].t0) / 0.07) * Math.min(1, Math.max(0, (group[group.length - 1].t1 + 0.12 - t) / 0.2));
    var dip = k && into < 0.05 ? 0.75 + 0.25 * into / 0.05 : 1, sw = 0.85 + 0.15 * Math.sin(PI * Math.min(1, into / Math.max(0.2, len)));
    var tone = Math.sin(2 * PI * ph) + 0.13 * Math.sin(4 * PI * ph + 0.4) + 0.05 * Math.sin(6 * PI * ph);
    var w = rnd() * 2 - 1, q = Math.exp(-PI * f * 0.25 / sr), cf = 2 * q * Math.cos(2 * PI * f / sr), y = (1 - q) * w + cf * r1 - q * q * r2; r2 = r1; r1 = y;
    nz += (w - nz) * 0.5;
    var chiff = into < 0.04 && (k === 0 || N.m !== group[k - 1].m) ? (1 - into / 0.04) * 0.25 : 0;
    add(bus, s, gain * env * dip * sw * (tone * 0.8 + y * 0.6 + (w - nz) * (0.012 + chiff * 0.5)), pan, 0.4);
  }
}
// plucked string (Karplus–Strong): pipa bright & short, qin dark & long
function pluck(bus, sr, t0, m, amp, bright, decay, pan, rnd) {
  var f = hz(m), N = Math.max(2, Math.round(sr / f)), line = new Float32Array(N), lp = 0, a = Math.floor(t0 * sr), len = Math.floor(decay * 1.3 * sr);
  for (var i = 0; i < N; i++) { lp += ((rnd() * 2 - 1) - lp) * bright; line[i] = lp; }
  var rho = Math.pow(10, -3 / (decay * f)), p = 0, prev = 0, dc = 0;
  for (var s = 0; s < len; s++) {
    var cur = line[p], nxt = line[(p + 1) % N], y = rho * (cur * 0.5 + nxt * 0.5);
    line[p] = y; p = (p + 1) % N;
    dc += (cur - dc) * 0.002; prev = cur;
    add(bus, a + s, amp * (cur - dc) * Math.min(1, s / 40), pan, 0.3);
  }
}
// 拍板 (clapper) and a small drum
function clap(bus, sr, t0, amp, rnd) {
  var a = Math.floor(t0 * sr), fr = [1850, 2900, 4300], st = fr.map(function () { return [0, 0]; });
  for (var s = 0; s < sr * 0.12; s++) {
    var x = s < sr * 0.004 ? rnd() * 2 - 1 : 0, y = 0;
    fr.forEach(function (f, j) { var q = Math.exp(-PI * 260 / sr), c = 2 * q * Math.cos(2 * PI * f / sr), o = x + c * st[j][0] - q * q * st[j][1]; st[j][1] = st[j][0]; st[j][0] = o; y += o * [1, 0.6, 0.35][j]; });
    add(bus, a + s, amp * y * 0.006, 0, 0.2);
  }
}
function drum(bus, sr, t0, amp, rnd) {
  var a = Math.floor(t0 * sr), ph = 0;
  for (var s = 0; s < sr * 0.5; s++) { var t = s / sr; ph += (95 + 70 * Math.exp(-t * 30)) / sr; add(bus, a + s, amp * (Math.sin(2 * PI * ph) * Math.exp(-t * 7) + (rnd() - 0.5) * 0.3 * Math.exp(-t * 60)), 0, 0.2); }
}

// stereo Freeverb-style hall
function reverb(bus, sr, wet) {
  var n = bus.L.length, sc = sr / 44100, CB = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], AP = [556, 441, 341, 225];
  [bus.L, bus.R].forEach(function (out, ch) {
    var combs = CB.map(function (l) { return { b: new Float32Array(Math.round((l + ch * 23) * sc * 1.25)), i: 0, f: 0 }; });
    var aps = AP.map(function (l) { return { b: new Float32Array(Math.round((l + ch * 23) * sc)), i: 0 }; });
    for (var s = 0; s < n; s++) {
      var x = bus.S[s] * 0.015, y = 0;
      for (var c = 0; c < 8; c++) { var C = combs[c], o = C.b[C.i]; C.f = o * 0.7 + C.f * 0.3; C.b[C.i] = x + C.f * 0.86; C.i = (C.i + 1) % C.b.length; y += o; }
      for (var a = 0; a < 4; a++) { var A = aps[a], bo = A.b[A.i]; A.b[A.i] = y + bo * 0.5; A.i = (A.i + 1) % A.b.length; y = bo - y; }
      out[s] += y * wet;
    }
  });
}

var KEY = { woman: 62, man: 50, elder: 48, crone: 60, child: 67 };   // midi of the mode final
function render(song, o) {
  EV = o && o.events || null;
  o = o || {};
  var sr = o.sr || 44100, voice = MC.VOICES[o.voice] ? o.voice : 'woman', v = {}, k, spb = 60 / song.tempo, rnd = seeded((o.seed || 1) * 131 + 3);
  for (k in MC.VOICES[voice]) v[k] = MC.VOICES[voice][k];
  v.jit = 0.012; v.breath = (v.breath || 0.04) * 0.7; v.tilt = (v.tilt || 2600) * 1.2;
  var fm = (o.key || KEY[voice]) , gongM = fm - song.final, band = o.band == null ? 'xiao pipa perc' : o.band;
  var last = song.phrases[song.phrases.length - 1], fullB = last.dur.reduce(function (a, b) { return a + b; }, 0) + 1;
  var introB = o.intro === false ? 0 : typeof o.intro === 'number' ? Math.min(fullB, Math.max(0, o.intro)) : fullB;   // prelude length in beats
  var lead = 0.6 + introB * spb, tail = 4;
  var V = sing(song, { gongHz: hz(gongM), seed: o.seed, v: v, lead: lead, inflect: o.inflect == null ? 1 : o.inflect }, sr);
  var n = Math.max(V.x.length, Math.ceil((lead + song.beats * spb + tail) * sr)), bus = Bus(n);
  var mix = o.mix || {}, gv = mix.voice == null ? 1 : mix.voice, gx = mix.xiao == null ? 1 : mix.xiao, gp = mix.pluck == null ? 1 : mix.pluck, gc = mix.perc == null ? 1 : mix.perc;
  for (var s = 0; s < V.x.length; s++) add(bus, s, V.x[s] * 0.5 * gv, 0, 0.22);
  var T = function (b) { return lead + b * spb; }, xo = gongM + (voice === 'man' || voice === 'elder' ? 12 : 0);
  // 簫 heterophony: the tune with graces and turns, echoes in the rests, an intro on the last line
  if (/xiao/.test(band)) {
    var groups = [], introT = 0.6;
    if (introB) {   // the last line (or, for a short prelude, its tail), ending one beat before the voice
      var g0 = [], sk = fullB - introB;
      last.notes.forEach(function (ns, i) { var tb = 0; for (var j = 0; j < i; j++) tb += last.dur[j]; ns.forEach(function (x) { if (tb + x.d > sk) g0.push({ m: xo + x.p, t0: introT + Math.max(0, tb - sk) * spb, t1: introT + (tb + x.d - sk) * spb }); tb += x.d; }); });
      groups.push(g0);
    }
    song.phrases.forEach(function (ph, pi) {
      var g = [];
      ph.syl.forEach(function (S) {
        var tb = S.t;
        S.notes.forEach(function (x) {
          var a = T(tb), b = T(tb + x.d), m = xo + x.p;
          if (x.d >= 1 && rnd() < 0.3) { g.push({ m: xo + step(x.p, 1), t0: a - 0.07, t1: a }); }
          if (x.d >= 2 && rnd() < 0.5) { var mid = a + (b - a) * 0.45; g.push({ m: m, t0: a, t1: mid }); g.push({ m: xo + step(x.p, 1), t0: mid, t1: mid + 0.09 }); g.push({ m: m, t0: mid + 0.09, t1: b }); }
          else g.push({ m: m, t0: a, t1: b });
          tb += x.d;
        });
      });
      var endB = ph.t + ph.dur.reduce(function (a, b) { return a + b; }, 0), nx = song.phrases[pi + 1], gap = (nx ? nx.t : endB + 2) - endB;
      g[g.length - 1].t1 = T(endB) - 0.05;
      if (gap >= 1.5) {   // echo the last two syllables in the rest
        var e = ph.main.slice(-2), at = endB + 0.5;
        groups.push(g); g = [];
        e.forEach(function (p, j) { g.push({ m: xo + p, t0: T(at + j * 0.5), t1: T(at + (j + 1) * 0.5) }); });
        g[g.length - 1].t1 = T(endB + gap) - 0.15;
      }
      groups.push(g);
    });
    groups.forEach(function (g) { if (EV) g.forEach(function (n) { EV.push({ part: 'xiao', m: n.m, t0: n.t0, t1: n.t1 }); }); xiao(bus, sr, g, rnd, 0.055 * gx, 0.3); });
  }
  // 琵琶 / 琴: plucks on even beats and phrase starts, 輪指 tremolo or a dyad on phrase ends
  var qin = /qin/.test(band), pipa = /pipa/.test(band);
  if (qin || pipa) {
    var po = gongM - 12 + (voice === 'man' || voice === 'elder' ? 12 : 0) - (qin ? 12 : 0), pan = -0.35;
    var P = function (t, m, a) { if (EV) EV.push({ part: qin ? 'qin' : 'pipa', m: m, t0: t, t1: t + (qin ? 1.2 : 0.4) }); a *= gp * (qin ? 0.4 : 0.3); if (qin) pluck(bus, sr, t, m, a * 0.9, 0.25, 3.2, pan, rnd); else pluck(bus, sr, t, m, a, 0.7, 1.4, pan, rnd); };
    if (introB) P(0.6, po + last.main[last.main.length - 1], 0.5);
    song.phrases.forEach(function (ph) {
      ph.syl.forEach(function (S, i) {
        var p = S.notes[0].p, end = i === ph.syl.length - 1;
        if (end) {
          P(T(S.t), po + p, 0.5); P(T(S.t) + 0.03, po + p - 12, 0.4);
          if (pipa && ph.end === '。') for (var tt = T(S.t) + 0.5; tt < T(S.t + S.d) - 0.2; tt += 1 / 11) P(tt, po + p, 0.12 * (1 - 0.5 * (tt - T(S.t)) / (S.d * spb)));
        } else if (i === 0 || (!qin && S.t % 2 === 0)) P(T(S.t), po + p, 0.35);
      });
    });
    var lp = last.main[last.main.length - 1]; P(T(song.beats) + 0.1, po + lp, 0.45); P(T(song.beats) + 0.14, po + lp - 12, 0.4);
  }
  if (/perc/.test(band)) song.phrases.forEach(function (ph) {
    var ls = ph.syl[ph.syl.length - 1]; clap(bus, sr, T(ls.t), (ph.end === '。' ? 0.9 : 0.55) * gc, rnd);
    drum(bus, sr, T(ph.t), 0.05 * gc, rnd);
    if (EV) { EV.push({ part: 'ban', t0: T(ls.t), t1: T(ls.t) + 0.12 }); EV.push({ part: 'drum', t0: T(ph.t), t1: T(ph.t) + 0.3 }); }
  });
  reverb(bus, sr, o.reverb == null ? 0.25 : o.reverb);
  var pk = 0; for (s = 0; s < n; s++) pk = Math.max(pk, Math.abs(bus.L[s]), Math.abs(bus.R[s]));
  var gn = o.raw ? 1 : pk ? 0.89 / pk : 1; for (s = 0; s < n; s++) { bus.L[s] *= gn; bus.R[s] *= gn; }
  return { L: bus.L, R: bus.R, sr: sr, syls: V.syls.map(function (y) { return { ch: y.S.ch, ipa: y.S.ipa, bax: y.S.bax, t0: y.cs, on: y.on, off: y.off, notes: y.notes.map(function (x) { return x.p + gongM; }) }; }) };
}

function wav(L, R, sr) {
  var n = L.length, b = new Uint8Array(44 + n * 4), v = new DataView(b.buffer);
  function str(o, s) { for (var i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); }
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 4, true);
  for (var i = 0; i < n; i++) { v.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true); v.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true); }
  return b;
}

var POEMS = [
  { title: '渭城曲 · 王維', text: '渭城朝[2]雨浥輕塵，客舍青青柳色新。\n勸君更[2]盡一杯酒，西出陽關無故人。' },
  { title: '涼州詞 · 王之渙', text: '黃河遠上白雲間，一片孤城萬仞山。\n羌笛何須怨楊柳，春風不度玉門關。' },
  { title: '芙蓉樓送辛漸 · 王昌齡', text: '寒雨連江夜入吳，平明送客楚山孤。\n洛陽親友如相問，一片冰心在玉壺。' },
  { title: '春曉 · 孟浩然', text: '春眠不覺[2]曉，處處聞啼鳥。\n夜來風雨聲，花落知多少[2]。' },
  { title: '靜夜思 · 李白', text: '床前明月光，疑是地上霜。\n舉頭望明月，低頭思故鄉。' },
  { title: '春望 · 杜甫', text: '國破山河在，城春草木深。感時花濺淚，恨別鳥驚心。\n烽火連三月，家書抵萬金。白頭搔更[2]短，渾欲不勝簪。' },
  { title: '楓橋夜泊 · 張繼', text: '月落烏啼霜滿天，江楓漁火對愁眠。\n姑蘇城外寒山寺，夜半鐘聲到客船。' },
  { title: '夜雨寄北 · 李商隱', text: '君問歸期未有期，巴山夜雨漲[2]秋池。\n何當共剪西窗燭，卻話巴山夜雨時。' },
  { title: '泊秦淮 · 杜牧', text: '煙籠寒水月籠沙，夜泊秦淮近酒家。\n商女不知亡國恨，隔江猶唱後庭花。' },
  { title: '虞美人 · 李煜', text: '春花秋月何時了，往事知多少[2]。小樓昨夜又東風，故國不堪回首[2]月明中。\n\n雕欄玉砌應猶在，只是朱顏改。問君能有幾[3]多愁，恰似一江春水向東流。' },
  { title: '水調歌頭 · 蘇軾', text: '明月幾[3]時有，把酒問青天。不知天上宮闕，今夕是何年。我欲乘風歸去，又恐瓊樓玉宇，高處[2]不勝寒。起舞弄清影，何似在人間。\n\n轉朱閣，低綺戶，照無眠。不應有恨，何事長向別時圓。人有悲歡離合，月有陰晴圓缺，此事古難全。但願人長久，千里共嬋娟。' }
];

var SING = { compose: compose, render: render, score: score, wav: wav, parseText: parseText, POEMS: POEMS };
if (typeof module !== 'undefined' && module.exports) module.exports = SING; else root.SING = SING;
})(this);
