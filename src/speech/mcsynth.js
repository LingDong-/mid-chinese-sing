/* mcsynth.js — Middle Chinese TTS, no deps.
   Baxter transcription → approximate IPA (EMC values, Late-Tang tone registers) → Klatt-style formant synthesizer.
   Browser: <script src="mcsynth.js"> → window.MC        Node: const MC = require('./mcsynth.js')

   MC.parse(text, dict)        text = hanzi and/or Baxter syllables (space separated); dict = mc_dict.json object
                               多音字: first dictionary reading by default; 長[2] = 2nd reading, 長[trjangX] = explicit Baxter
                               → [{bax, ipa, ...} | {pause: sec}]
   MC.synth(seq, opts)         → Float32Array (mono, opts.sr, default 22050), peak-normalised
                               opts: {voice, mood, sr, f0 (Hz), fs (formant scale), rate, breath, seed, range, ...}
   MC.VOICES                   presets: man, woman, elder, crone (elder woman), child
                               seed = speaker identity (small offsets to pitch, tract size, speed, breath...), vary scales it (0 = exact preset)
                               pitch / speed: multipliers on top of voice + seed + mood
   MC.MOODS                    neutral angry shout happy sad afraid whisper  ('？' raises the phrase end automatically)
   MC.play(text, dict, opts, audioCtx, dest) → AudioBufferSourceNode (browser)
   MC.wav(float32, sr)         → Uint8Array (16-bit PCM WAV)
*/
(function (root) {
'use strict';
var PI = Math.PI;

/* ============ Baxter → phones ============ */
var INI = { p: 'p', ph: 'pʰ', b: 'b', m: 'm', t: 't', th: 'tʰ', d: 'd', n: 'n', tr: 'ʈ', trh: 'ʈʰ', dr: 'ɖ', nr: 'ɳ',
  ts: 'ts', tsh: 'tsʰ', dz: 'dz', s: 's', z: 'z', tsr: 'tʂ', tsrh: 'tʂʰ', dzr: 'dʐ', sr: 'ʂ', zr: 'ʐ',
  tsy: 'tɕ', tsyh: 'tɕʰ', dzy: 'dʑ', sy: 'ɕ', zy: 'ʑ', ny: 'ɲ', k: 'k', kh: 'kʰ', g: 'g', ng: 'ŋ', "'": 'ʔ', x: 'x', h: 'ɣ', l: 'l', y: 'j' };
var INIK = Object.keys(INI).sort(function (a, b) { return b.length - a.length; });
var PALATAL = { 'tɕ': 1, 'tɕʰ': 1, 'dʑ': 1, 'ɕ': 1, 'ʑ': 1, 'ɲ': 1, 'j': 1 };
var VOICED_OBS = { b: 1, d: 1, 'ɖ': 1, dz: 1, 'dʐ': 1, 'dʑ': 1, g: 1, 'ɣ': 1, z: 1, 'ʐ': 1, 'ʑ': 1 };
var SONOR = { m: 1, n: 1, 'ɳ': 1, 'ɲ': 1, 'ŋ': 1, l: 1, j: 1 };

// era: 'late' (default, Late Tang: 濁上變去 + 陰/陽 registers for all tones) or 'high' (盛唐: 濁上 stays 上; no register
// split, voiced initials only depress the pitch onset slightly). Set globally with MC.setEra(), or per call.
var ERA = 'late';
function parseBax(s, era) {
  era = era || ERA;
  var bax = s, tone = 'P', m;
  if (/X$/.test(s)) { tone = 'X'; s = s.slice(0, -1); } else if (/H$/.test(s)) { tone = 'H'; s = s.slice(0, -1); }
  var ini = ''; for (var i = 0; i < INIK.length; i++) if (s.indexOf(INIK[i]) === 0) { ini = INIK[i]; break; }
  var r = s.slice(ini.length).replace(/^wj/, 'jw');
  var med = (m = r.match(/^(jw|j|w)/)) ? m[1] : ''; r = r.slice(med.length);
  while (r && !/^[aeiou+]/.test(r)) r = r.slice(1);                     // tolerate typos
  var nuc = (m = r.match(/^(ae|ea|ie|io|a|e|i|o|u|\+)/)) ? m[1] : 'o';
  var coda = r.slice(nuc.length); if (!/^(|m|n|ng|p|t|k|j|w|wng|wk)$/.test(coda)) coda = '';
  if (/^(p|t|k|wk)$/.test(coda)) tone = 'R';
  var C = INI[ini] || '', jx = med[0] === 'j', w = med.indexOf('w') >= 0, gl = [], v;
  var j = jx || !!PALATAL[C];   // palatal initials absorb Baxter's -j-
  switch (nuc) {   // nucleus → vowel (roughly Zhengzhang / Pulleyblank EMC)
    case 'a': v = j ? 'a' : 'ɑ'; break;
    case 'ae': v = /^w(ng|k)$/.test(coda) ? 'ɔ' : 'æ'; break;
    case 'ea': v = 'ɛ'; break;
    case 'e': case 'ie': v = j ? 'ɛ' : 'e'; break;
    case 'i': case '+': v = (!jx && /^(|ng|k)$/.test(coda)) || nuc === '+' ? 'ɨ' : 'i'; break;
    case 'io': v = 'ə'; gl.push('ɨ'); j = false; break;
    case 'o':
      if (/^w/.test(coda)) v = 'o';
      else if (j) { if (coda) v = 'ɐ'; else { v = 'o'; gl.push('ɨ'); j = false; } }
      else v = /^(j|m|p)$/.test(coda) ? 'ʌ' : 'ə';
      break;
    case 'u':
      if (j && !coda) { v = 'y'; j = false; }
      else if (!j && coda === 'w') v = 'ə';
      else v = 'u';
      break;
  }
  if (coda === 'w' && v === 'u') coda = '';
  if (coda === 'j' && v === 'i') coda = '';
  if (j && w) gl.unshift('ɥ'); else { if (j && !PALATAL[C]) gl.unshift('j'); if (w && C !== 'j') gl.unshift('w'); }
  var son = SONOR[C];   // (register is decided by the original initial, before 以 becomes a glide)
  if (C === 'j') {   // 以母: zero initial + palatal glide
    C = '';
    if (w && gl[0] !== 'ɥ') gl.unshift('ɥ'); else if (gl[0] !== 'ɥ' && v !== 'i' && v !== 'y') gl.unshift('j');
  }
  var K = { '': '', m: 'm', n: 'n', ng: 'ŋ', wng: 'ŋ', p: 'p', t: 't', k: 'k', wk: 'k', j: 'i̯', w: 'u̯' }[coda];
  // tone register (Late Tang yin/yang split) + 濁上變去 (voiced-obstruent rising → departing, already under way by Han Yu's time)
  var reg = VOICED_OBS[C] || (son && tone !== 'X') ? 'yang' : 'yin', dep = 0;
  if (era === 'high') { dep = VOICED_OBS[C] ? 1 : 0; reg = 'yin'; }   // 盛唐: one register; voicing lowers the onset a little
  else if (VOICED_OBS[C] && tone === 'X') tone = 'H';
  var ipa = C + gl.join('') + v + (K === 'p' || K === 't' || K === 'k' ? K + '̚' : K) + { P: '˧', X: '˧˥', H: '˥˩', R: '˥' }[tone] + (reg === 'yang' ? '₂' : '');
  return { bax: bax, ini: C || (ini === "'" ? 'ʔ' : ''), gl: gl, v: v, coda: K, tone: tone, reg: reg, dep: dep, ipa: ipa };
}

var PUNCT = { '，': 0.2, ',': 0.2, '、': 0.15, '；': 0.3, ';': 0.3, '：': 0.25, ':': 0.25, '。': 0.4, '.': 0.4, '！': 0.4, '!': 0.4, '？': 0.4, '?': 0.4, '\n': 0.45 };
function parse(text, dict, era) {   // 字 → first reading;  字[2] → 2nd reading;  字[trjangX] → given Baxter;  bare Baxter syllables ok
  var out = [], tok = text.match(/[^\x00-\x7f][\[［][^\]］]*[\]］]|[a-z'+]+[XH]?|[\s\S]/gu) || [];
  tok.forEach(function (t) {
    if (PUNCT[t]) { if (out.length && !out[out.length - 1].pause) out.push({ pause: PUNCT[t], p: /[？?]/.test(t) ? 'q' : /[！!]/.test(t) ? 'e' : '' }); return; }
    if (/^[a-z']/.test(t)) { out.push(parseBax(t, era)); return; }
    var ch = String.fromCodePoint(t.codePointAt(0)), sel = t.slice(ch.length).replace(/^[\[［]|[\]］]$/g, '').trim();
    var b = dict && (dict[ch] || dict[ch.codePointAt(0).toString(16).toUpperCase()]);   // mc_dict.json (by char) or hanzi2baxter.json (by hex)
    var all = b ? b.split(/\s+/) : [], r = /^\d+$/.test(sel) ? all[sel - 1] : sel || all[0];
    if (r) { var s = parseBax(r, era); s.ch = ch; s.alt = all; out.push(s); }
  });
  return out;
}

/* ============ phone targets ============ */
var VT = {   // F1 F2 F3 (adult male)
  i: [280, 2250, 2950], y: [280, 1850, 2250], 'ɨ': [330, 1500, 2350], u: [320, 760, 2250],
  e: [420, 2050, 2650], 'ɛ': [560, 1850, 2550], 'æ': [660, 1700, 2500], a: [780, 1450, 2500], 'ɑ': [720, 1120, 2550],
  'ə': [520, 1350, 2450], 'ɐ': [680, 1300, 2500], 'ʌ': [600, 1150, 2500], o: [450, 820, 2400], 'ɔ': [600, 900, 2500],
  j: [260, 2250, 3000], w: [290, 650, 2250], 'ɥ': [260, 1850, 2250], l: [360, 1150, 2750]
};
var CONS = {};
function defC(list, k, pl, v, asp, fr) { list.split(' ').forEach(function (c) { CONS[c] = { k: k, pl: pl, v: v, asp: asp, fr: fr }; }); }
defC('p', 'stop', 'lab', 0, 0); defC('pʰ', 'stop', 'lab', 0, 1); defC('b', 'stop', 'lab', 1, 0);
defC('t', 'stop', 'alv', 0, 0); defC('tʰ', 'stop', 'alv', 0, 1); defC('d', 'stop', 'alv', 1, 0);
defC('ʈ', 'stop', 'ret', 0, 0); defC('ʈʰ', 'stop', 'ret', 0, 1); defC('ɖ', 'stop', 'ret', 1, 0);
defC('k', 'stop', 'vel', 0, 0); defC('kʰ', 'stop', 'vel', 0, 1); defC('g', 'stop', 'vel', 1, 0);
defC('ts', 'aff', 'alv', 0, 0, 's'); defC('tsʰ', 'aff', 'alv', 0, 1, 's'); defC('dz', 'aff', 'alv', 1, 0, 's');
defC('tʂ', 'aff', 'ret', 0, 0, 'ʂ'); defC('tʂʰ', 'aff', 'ret', 0, 1, 'ʂ'); defC('dʐ', 'aff', 'ret', 1, 0, 'ʂ');
defC('tɕ', 'aff', 'pal', 0, 0, 'ɕ'); defC('tɕʰ', 'aff', 'pal', 0, 1, 'ɕ'); defC('dʑ', 'aff', 'pal', 1, 0, 'ɕ');
defC('s', 'fric', 'alv', 0, 0, 's'); defC('z', 'fric', 'alv', 1, 0, 's');
defC('ʂ', 'fric', 'ret', 0, 0, 'ʂ'); defC('ʐ', 'fric', 'ret', 1, 0, 'ʂ');
defC('ɕ', 'fric', 'pal', 0, 0, 'ɕ'); defC('ʑ', 'fric', 'pal', 1, 0, 'ɕ');
defC('x', 'fric', 'vel', 0, 0, 'x'); defC('ɣ', 'fric', 'vel', 1, 0, 'x');
defC('m', 'nas', 'lab'); defC('n', 'nas', 'alv'); defC('ɳ', 'nas', 'ret'); defC('ɲ', 'nas', 'pal'); defC('ŋ', 'nas', 'vel');
defC('l', 'lat', 'alv'); defC('ʔ', 'glot'); defC('j', 'glide'); defC('', 'zero');
var LOCUS = { lab: [250, 800, 2200], alv: [250, 1750, 2700], ret: [250, 1550, 1950], pal: [250, 2250, 3000] };
function locus(pl, V) {
  if (pl === 'vel') return V[1] > 1650 ? [250, 2300, 2650] : [250, 1250, 2150];
  return LOCUS[pl] || V;
}
function toward(L, V, k) { return [L[0] + (V[0] - L[0]) * k, L[1] + (V[1] - L[1]) * k, L[2] + (V[2] - L[2]) * k]; }
var NASF = { lab: [480, 1150, 2150], alv: [480, 1450, 2500], ret: [480, 1400, 2050], pal: [480, 2100, 2900], vel: [480, 1900, 2450] };
// frication spectra: [freq, bandwidth, gain]...
var FR = {
  s: [[5200, 1400, 1], [7800, 2500, 0.7]], 'ʂ': [[2700, 700, 1], [4300, 1500, 0.55]], 'ɕ': [[3600, 900, 1], [5600, 2000, 0.5]],
  b_lab: [[900, 1400, 0.6], [2400, 2000, 0.4]], b_alv: [[4200, 1800, 1], [6500, 2500, 0.6]], b_ret: [[2900, 1400, 1], [4600, 2000, 0.5]], b_pal: [[3400, 1200, 1], [5500, 2000, 0.5]]
};
function velFr(V) { return [[Math.max(1100, V[1] + 150), 600, 1], [3000, 1500, 0.25]]; }
var FRAMP = { s: 0.7, 'ʂ': 0.55, 'ɕ': 0.6, x: 0.25 };

var TONE = {   // semitones re speaker base: [start, end] per register
  P: { yin: [0.5, 0], yang: [-2.5, -3] },
  X: { yin: [-0.5, 4], yang: [-2.5, 1.5] },
  H: { yin: [3.5, -2.5], yang: [1.5, -4.5] },
  R: { yin: [3, 2.5], yang: [-1, -1.5] }
};

/* ============ planner: phones → parameter tracks ============ */
function plan(seq, o) {
  var T = {}, last = {}, rnd = o.rnd, rate = o.rate || 1;
  function key(n, t, v) { (T[n] || (T[n] = [])).push([t, v]); last[n] = v; }
  function set(n, t, v, r) { if (last[n] != null) key(n, t, last[n]); key(n, t + (r == null ? 0.004 : r), v); }
  function fk(t, F, B) { key('F1', t, F[0]); key('F2', t, F[1]); key('F3', t, F[2]); if (B) { key('B1', t, B[0]); key('B2', t, B[1]); key('B3', t, B[2]); } }
  var BV = [70, 90, 150], BN = [60, 300, 300], BL = [110, 130, 220];
  var t = 0.06; set('AV', 0, 0, 0); set('AH', 0, 0, 0); set('AF', 0, 0, 0); set('CR', 0, 0, 0); set('FNZ', 0, 270, 0);
  fk(0, VT['ə'], BV); key('f0', 0, 0); T.FS = [[0, FR.s]];
  var prevPause = true, phraseLen = 0, idx = 0, ptype = '', range = o.range || 1, flen = o.finalLen || 1.35;
  for (var i = 0; i < seq.length; i++) {
    var S = seq[i];
    if (S.pause) { t += S.pause / rate; prevPause = true; idx = 0; continue; }
    if (prevPause) { phraseLen = 0; for (var q = i; q < seq.length && !seq[q].pause; q++) phraseLen++; ptype = seq[q] ? seq[q].p : ''; }
    var fin = idx === phraseLen - 1, sc = (fin ? flen : 1) * (0.94 + rnd() * 0.12);
    var d = function (x) { return x / rate; }, dv = function (x) { return x * sc / rate; };
    var C = CONS[S.ini] || CONS[''], Vt = VT[S.v] || VT['ə'], G = S.gl.map(function (g) { return VT[g]; });
    if (C.k === 'glide') G.unshift(VT.j);
    // next syllable starts voiced → keep voicing through the boundary instead of restarting it
    var nx = seq[i + 1], nC = nx && !nx.pause ? CONS[nx.ini] || CONS[''] : null;
    var link = nC && (nC.v || /^(zero|glide|nas|lat)$/.test(nC.k)) ? 0.45 : 0;
    // intonation: declination, phrase type (question rises at the end, exclamation is higher & wider)
    var lift = ptype === 'e' ? 1.5 : ptype === 'q' ? 1 : 0, rg = range * (ptype === 'e' ? 1.2 : 1);
    var first = G[0] || Vt, decl = -2.2 * (o.decl == null ? 1 : o.decl) * idx / Math.max(1, phraseLen - 1) + (rnd() - 0.5) * 0.8 + lift;
    var TN = TONE[S.tone][S.reg], fa = TN[0] * rg + decl - (S.dep ? 1.2 : 0), fb = TN[1] * rg + decl - (fin && ptype !== 'q' ? 1 : 0);
    if (fin && ptype === 'q') fb = Math.max(fa, fb) + 4;
    var tv, tF;   // voice onset, time formants leave the consonant
    if (C.k === 'stop' || C.k === 'aff') {
      var cl = d(prevPause ? 0.03 : C.k === 'aff' ? 0.045 : 0.055), L = locus(C.pl, first), On = toward(L, first, 0.45);
      set('AV', t, C.v ? 0.22 : 0, 0.01); set('AH', t, 0, 0.01);
      if (C.v) fk(t + 0.012, [200, On[1], On[2]], BV);
      var tR = t + cl;
      if (C.k === 'stop') {
        T.FS.push([tR - 0.001, C.pl === 'vel' ? velFr(first) : FR['b_' + C.pl]]);
        set('AF', tR, C.v ? 0.35 : 0.6, 0.001); set('AF', tR + 0.008, 0, 0.006);
        tF = tR;
      } else {
        var fd = d(C.v ? 0.04 : 0.05); T.FS.push([tR - 0.001, FR[C.fr]]);
        set('AF', tR, FRAMP[C.fr] * (C.v ? 0.6 : 1), 0.004); set('AF', tR + fd, 0, 0.012);
        tR += fd; tF = tR - 0.01;
      }
      fk(tF, On);
      if (C.asp) { set('AH', tR, 0.5, 0.006); tv = tR + d(0.065); set('AH', tv, 0, 0.01); }
      else if (C.v) { tv = tR; set('AH', tv, 0.12, 0.004); set('AH', tv + 0.07, 0, 0.03); }   // murmured (Tang 濁音)
      else { set('AH', tR, 0.25, 0.003); tv = tR + d(0.014); set('AH', tv, 0, 0.006); }
      set('AV', tv, 1, 0.008);
    } else if (C.k === 'fric') {
      var fdur = d(C.v ? 0.08 : 0.11), sp = C.fr === 'x' ? velFr(first) : FR[C.fr];
      T.FS.push([t, sp]);
      if (C.fr === 'x') { fk(t, [Math.max(300, first[0] * 0.7), first[1], first[2]], BV); set('AH', t, C.v ? 0.15 : 0.5, 0.02); set('AH', t + fdur, 0, 0.012); }
      else fk(t + fdur - 0.01, toward(LOCUS[C.pl], first, 0.5), BV);
      set('AF', t, FRAMP[C.fr] * (C.v ? 0.45 : 1), 0.02); set('AF', t + fdur - 0.012, 0, 0.015);
      set('AV', t, C.v ? 0.4 : 0, 0.015);
      tv = t + fdur; set('AV', tv, 1, 0.012);
    } else if (C.k === 'nas') {
      var nd = d(0.07), N = NASF[C.pl];
      set('AV', t, 0.75, 0.012); fk(t, N, BN); fk(t + nd - 0.005, N, BN); set('FNZ', t, 450, 0.008);
      tv = t + nd; set('FNZ', tv, 270, 0.012); fk(tv + 0.006, toward(locus(C.pl, first), first, 0.55), BV); set('AV', tv, 1, 0.012);
    } else if (C.k === 'lat') {
      var ld = d(0.06); set('AV', t, 0.8, 0.012); fk(t, VT.l, BL); fk(t + ld * 0.6, VT.l, BL);
      tv = t + ld; fk(tv + 0.01, toward(VT.l, first, 0.4), BV); set('AV', tv, 1, 0.01);
    } else if (C.k === 'glot') {
      t += d(0.02); set('AV', t, 0, 0.004); set('CR', t, 1, 0.002); tv = t + 0.005; set('AV', tv, 1, 0.004); set('CR', tv + 0.035, 0, 0.02);
      fk(tv, first, BV);
    } else {   // zero / glide initial
      tv = t; set('AV', tv, 1, 0.03); fk(tv, first, BV);
      if (prevPause) { set('AH', tv, 0.06, 0.01); set('AH', tv + 0.04, 0, 0.02); }
    }
    // ---- rhyme ----
    var cur = tv;
    key('f0', tv, fa);
    G.forEach(function (g) { var gd = d(0.05); fk(cur + gd * 0.4, g, BV); cur += gd; });
    var vd = dv(S.coda === '' ? 0.17 : /[ptk]/.test(S.coda) ? 0.085 : /[mnŋ]/.test(S.coda) ? 0.12 : 0.11);
    fk(cur + Math.min(0.065, vd * 0.45), Vt, BV); fk(cur + vd - 0.01, Vt, BV); cur += vd;
    var rhyme0 = tv, end;
    if (/[mnŋ]/.test(S.coda)) {
      var pl = { m: 'lab', n: 'alv', 'ŋ': 'vel' }[S.coda], cd = dv(0.08), NN = NASF[pl];
      fk(cur + 0.02, toward(locus(pl, Vt), Vt, 0.5)); set('AV', cur + 0.01, 0.75, 0.03);
      set('FNZ', cur + 0.01, 450, 0.025); fk(cur + 0.035, NN, BN); fk(cur + cd, NN, BN);
      end = cur + cd; set('AV', end - 0.035, link * 0.8, 0.035); set('FNZ', end, 270, 0.02);
    } else if (S.coda === 'i̯' || S.coda === 'u̯') {
      var cd2 = dv(0.07); fk(cur + cd2, toward(Vt, S.coda === 'i̯' ? VT.i : VT.u, 0.75), BV);
      end = cur + cd2; set('AV', end - 0.04, link, 0.04);
    } else if (/[ptk]/.test(S.coda)) {
      var pl2 = { p: 'lab', t: 'alv', k: 'vel' }[S.coda], cd3 = d(0.04);
      fk(cur + cd3, toward(locus(pl2, Vt), Vt, 0.35)); set('CR', cur + cd3 - 0.02, 0.6, 0.01);
      end = cur + cd3; set('AV', end, 0, 0.006); set('CR', end + 0.01, 0, 0.005);
      end += d(0.035);
    } else {
      end = cur; set('AV', end - 0.05, link, 0.06);
      if (fin) { set('AH', end - 0.03, 0.06, 0.03); set('AH', end + 0.04, 0, 0.05); }
      end += link ? 0 : 0.01;
    }
    // f0 contour across the voiced rhyme
    var span = Math.max(0.05, (end - rhyme0)), tn = S.tone;
    var mid = tn === 'X' ? fa - 0.7 : tn === 'H' ? fa + 0.4 : (fa + fb) / 2;
    key('f0', rhyme0 + span * (tn === 'X' ? 0.35 : 0.3), mid); key('f0', rhyme0 + span * 0.95, fb);
    t = end; prevPause = false; idx++;
  }
  set('AV', t, 0, 0.02);
  return { T: T, dur: t + 0.25 };
}

/* ============ Klatt-style synthesizer ============ */
function Res() { return { a: 0, b: 0, c: 0, y1: 0, y2: 0 }; }
function setRes(r, f, bw, sr) {
  var c = -Math.exp(-2 * PI * bw / sr), b = 2 * Math.exp(-PI * bw / sr) * Math.cos(2 * PI * f / sr);
  r.a = 1 - b - c; r.b = b; r.c = c;
}
function setAnti(r, f, bw, sr) { setRes(r, f, bw, sr); var a = r.a; r.a = 1 / a; r.b = -r.b / a; r.c = -r.c / a; }
function BP() { return { a: 0, b: 0, c: 0, x1: 0, x2: 0, y1: 0, y2: 0 }; }   // unity-peak bandpass (zeros at DC & Nyquist)
function setBP(r, f, bw, sr) { var q = Math.exp(-PI * bw / sr); r.b = 2 * q * Math.cos(2 * PI * f / sr); r.c = -q * q; r.a = (1 - q * q) / 2; }
function runBP(r, x) { var y = r.a * (x - r.x2) + r.b * r.y1 + r.c * r.y2; r.x2 = r.x1; r.x1 = x; r.y2 = r.y1; r.y1 = y; return y; }

function render(P, o) {
  var sr = o.sr, n = Math.ceil(P.dur * sr), out = new Float32Array(n), T = P.T, rnd = o.rnd;
  var names = ['AV', 'AH', 'AF', 'CR', 'FNZ', 'f0', 'F1', 'F2', 'F3', 'B1', 'B2', 'B3'], ptr = {}, val = {};
  names.forEach(function (k) { T[k].sort(function (a, b) { return a[0] - b[0]; }); ptr[k] = 0; });
  function at(k, t) {
    var E = T[k], p = ptr[k];
    while (p < E.length - 1 && E[p + 1][0] <= t) p++;
    ptr[k] = p;
    if (t <= E[p][0] || p === E.length - 1) return E[p][1];
    var a = E[p], b = E[p + 1]; return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
  }
  var fs = o.fs || 1, base = o.f0 || 110, br = o.breath == null ? 0.04 : o.breath, OQ = o.oq || 0.6, wh = o.whisper || 0;
  // control smoothing (one-pole per track, seconds): removes corners / steps between segments
  var TAU = { AV: 0.006, AH: 0.004, AF: 0.0015, CR: 0.006, FNZ: 0.012, f0: 0.025, F1: 0.012, F2: 0.012, F3: 0.012, B1: 0.01, B2: 0.01, B3: 0.01 }, sk = {}, first = true;
  names.forEach(function (k) { sk[k] = 1 - Math.exp(-32 / sr / TAU[k]); });
  var vib = o.vib || 0.006, vibR = o.vibRate || 4.7, jit = o.jit || 0.02, hpA = Math.exp(-2 * PI * 70 / sr), wp = 0;
  var R1 = Res(), R2 = Res(), R3 = Res(), R4 = Res(), R5 = Res(), RNP = Res(), RNZ = Res(), FA = BP(), FA2 = BP(), FB = BP(), FB2 = BP();
  var nzx1 = 0, nzx2 = 0, ph = 0, tilt = 0, tk = 1 - Math.exp(-2 * PI * (o.tilt || 2600) / sr), pj = 1, pa = 1;
  var seedN = (rnd() * 2147483647) | 0, hp = 0, hpx = 0, FSp = 0, gA = 1, gB = 1;
  var vibP = rnd() * 6, CRF = 32, F4 = 3300 * fs, F5 = 3850 * fs;
  setRes(R4, Math.min(F4, sr * 0.45), 250, sr); setRes(R5, Math.min(F5, sr * 0.45), 300, sr); setRes(RNP, 270, 100, sr);
  var skip5 = F5 > sr * 0.45;
  for (var b0 = 0; b0 < n; b0 += CRF) {
    var t = b0 / sr;
    for (var q = 0; q < names.length; q++) { var nm = names[q], v0 = at(nm, t); val[nm] = first ? v0 : val[nm] + (v0 - val[nm]) * sk[nm]; }
    first = false;
    var av = val.AV * (1 - wh), ah = val.AH + val.AV * wh * 0.7;
    // open glottis (aspiration, breathy onsets) damps F1 strongly — without this, breath noise rumbles like wind on a mic
    var b1 = val.B1 + 260 * Math.min(1, ah * 2.5) * (1 - Math.min(1, av));
    setRes(R1, val.F1 * fs, b1, sr); setRes(R2, val.F2 * fs, val.B2, sr); setRes(R3, Math.min(val.F3 * fs, sr * 0.45), val.B3, sr);
    setAnti(RNZ, val.FNZ, 100, sr);
    while (FSp < T.FS.length - 1 && T.FS[FSp + 1][0] <= t) FSp++;
    var sp = T.FS[FSp], spc = sp[1], ff = Math.sqrt(fs);
    setBP(FA, Math.min(spc[0][0] * ff, sr * 0.42), spc[0][1], sr); setBP(FA2, Math.min(spc[0][0] * ff, sr * 0.42), spc[0][1], sr); gA = spc[0][2];
    setBP(FB, Math.min(spc[1][0] * ff, sr * 0.45), spc[1][1], sr); setBP(FB2, Math.min(spc[1][0] * ff, sr * 0.45), spc[1][1], sr); gB = spc[1][2];
    var f0 = base * Math.pow(2, val.f0 / 12) * (1 + vib * Math.sin(2 * PI * vibR * t + vibP) + 0.004 * Math.sin(2 * PI * 1.3 * t)) * (1 - 0.4 * val.CR);
    var af = val.AF * 2.5, cr = val.CR, e = Math.min(n, b0 + CRF);
    for (var j = b0; j < e; j++) {
      ph += f0 * pj / sr;
      if (ph >= 1) { ph -= 1; pj = 1 + (rnd() - 0.5) * (jit + cr * 0.5); pa = 1 - rnd() * (0.06 + cr * 0.6); }
      var x = ph / OQ, g = ph < OQ ? (2 * x - 3 * x * x) : 0;
      tilt += (g - tilt) * tk;
      seedN = (Math.imul(seedN, 1664525) + 1013904223) | 0; var w = seedN * 4.656612873e-10;
      var wd = w - wp; wp = w;   // differentiated (high-passed) noise for breath/aspiration: no low rumble
      var src = tilt * av * pa + wd * (ah * 0.4 + av * br * (ph < OQ ? 0.5 : 0.12));
      // cascade: nasal pole/zero → F5..F1
      var y = src * 0.6;
      var yz = RNZ.a * y + RNZ.b * nzx1 + RNZ.c * nzx2; nzx2 = nzx1; nzx1 = y; y = yz;
      y = RNP.a * y + RNP.b * RNP.y1 + RNP.c * RNP.y2; RNP.y2 = RNP.y1; RNP.y1 = y;
      if (!skip5) { var y5 = R5.a * y + R5.b * R5.y1 + R5.c * R5.y2; R5.y2 = R5.y1; R5.y1 = y5; y = y5; }
      var y4 = R4.a * y + R4.b * R4.y1 + R4.c * R4.y2; R4.y2 = R4.y1; R4.y1 = y4;
      var y3 = R3.a * y4 + R3.b * R3.y1 + R3.c * R3.y2; R3.y2 = R3.y1; R3.y1 = y3;
      var y2 = R2.a * y3 + R2.b * R2.y1 + R2.c * R2.y2; R2.y2 = R2.y1; R2.y1 = y2;
      var y1 = R1.a * y2 + R1.b * R1.y1 + R1.c * R1.y2; R1.y2 = R1.y1; R1.y1 = y1;
      // parallel frication branch
      var fo = 0;
      if (af > 1e-4) fo = (runBP(FA2, runBP(FA, w)) * gA + runBP(FB2, runBP(FB, w)) * gB) * af;
      var s = y1 + fo;
      hp = hpA * (hp + s - hpx); hpx = s;   // 70 Hz high-pass
      out[j] = hp;
    }
  }
  var pk = 0; for (j = 0; j < n; j++) pk = Math.max(pk, Math.abs(out[j]));
  var gn = pk > 0 ? 0.89 / pk : 0; for (j = 0; j < n; j++) out[j] *= gn;
  return out;
}

function seeded(s) { s = (s * 2654435761) >>> 0 || 1; return function () { s += 0x6D2B79F5; var t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* moods: multipliers / offsets applied on top of a voice. pitch ×f0, range ×tone excursions, rate ×speed,
   effort −1..1 (breathy/lax ↔ pressed/bright), breath +, jit (pitch roughness), vib (tremble), finalLen (phrase-final stretch) */
var MOODS = {
  neutral: {},
  angry: { pitch: 1.3, range: 1.7, rate: 1.15, effort: 1, jit: 0.04, decl: 1.6 },
  shout: { pitch: 1.5, range: 1.2, rate: 0.92, effort: 0.8, finalLen: 2, decl: 0.4 },
  happy: { pitch: 1.15, range: 1.4, rate: 1.08, effort: 0.3 },
  sad: { pitch: 0.9, range: 0.55, rate: 0.8, effort: -0.7, breath: 0.08, decl: 1.4 },
  afraid: { pitch: 1.22, range: 0.9, rate: 1.2, effort: -0.2, breath: 0.05, vib: 0.03, vibRate: 7.5 },
  whisper: { rate: 0.92, whisper: 1, range: 0.7 }
};
var VOICES = {
  man: { f0: 108, fs: 1, breath: 0.04, rate: 1, tilt: 2600 },
  woman: { f0: 200, fs: 1.16, breath: 0.07, rate: 1.05, tilt: 2200, oq: 0.68 },
  elder: { f0: 95, fs: 0.97, breath: 0.1, rate: 0.85, tilt: 1800, oq: 0.66, jit: 0.035, vib: 0.012, vibRate: 5.5 },
  crone: { f0: 170, fs: 1.1, breath: 0.13, rate: 0.82, tilt: 1700, oq: 0.72, jit: 0.04, vib: 0.016, vibRate: 5.8 },   // elder woman
  child: { f0: 270, fs: 1.28, breath: 0.06, rate: 1.1, tilt: 2400, oq: 0.66 }
};
function opts(o) {
  o = o || {}; var v = VOICES[o.voice] || VOICES.man, r = { jit: 0.02, range: 1, oq: 0.6, tilt: 2600, breath: 0.04 }, k;
  for (k in v) r[k] = v[k];
  // speaker identity from the seed: small consistent offsets (same seed = same person; vary 0 = exact preset)
  var vr = o.vary == null ? 1 : o.vary, R = seeded((o.seed == null ? 1 : o.seed) * 7919 + 13);
  function dev(a) { return 1 + (R() * 2 - 1) * a * vr; }
  r.f0 *= dev(0.12); r.fs *= dev(0.05); r.rate *= dev(0.08); r.breath *= dev(0.5); r.tilt *= dev(0.25);
  r.oq *= dev(0.08); r.range *= dev(0.25); r.jit *= dev(0.5);
  // mood on top
  var m = MOODS[o.mood] || {}, ef = m.effort || 0;
  r.f0 *= m.pitch || 1; r.rate *= m.rate || 1; r.range *= m.range || 1; r.breath += m.breath || 0;
  r.tilt *= Math.pow(2, ef * 0.9); r.oq = Math.max(0.4, Math.min(0.8, r.oq - 0.12 * ef));
  if (m.jit) r.jit = Math.max(r.jit, m.jit);
  if (m.vib) r.vib = Math.max(r.vib || 0, m.vib);
  ['vibRate', 'finalLen', 'decl', 'whisper'].forEach(function (k) { if (m[k] != null) r[k] = m[k]; });
  // explicit overrides; pitch / speed are multipliers
  for (k in o) if (!/^(mood|pitch|speed|vary)$/.test(k)) r[k] = o[k];
  if (o.pitch) r.f0 *= o.pitch; if (o.speed) r.rate *= o.speed;
  r.sr = r.sr || 22050; r.rnd = seeded(r.seed == null ? 1 : r.seed); return r;
}
function synth(seq, o) { o = opts(o); return render(plan(seq, o), o); }

function wav(x, sr) {
  var n = x.length, b = new Uint8Array(44 + n * 2), v = new DataView(b.buffer);
  function str(o, s) { for (var i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); }
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
  for (var i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 32767, true);
  return b;
}
function play(text, dict, o, ac, dest) {
  o = opts(o); var x = render(plan(parse(text, dict), o), o), b = ac.createBuffer(1, x.length, o.sr);
  b.getChannelData(0).set(x); var s = ac.createBufferSource(); s.buffer = b; s.connect(dest || ac.destination); s.start(); return s;
}

var MC = { parse: parse, parseBax: parseBax, setEra: function (e) { ERA = e === 'high' ? 'high' : 'late'; }, synth: synth, plan: plan, render: render, play: play, wav: wav, VOICES: VOICES, MOODS: MOODS };
if (typeof module !== 'undefined' && module.exports) module.exports = MC; else root.MC = MC;
})(this);
