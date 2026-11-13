// analyze.js — statistics of the 白石道人歌曲 corpus (tool/baishi.txt): tone ↔ melody, intervals, degrees.
// node tool/analyze.js
const fs = require('fs'), MC = require('../speech/mcsynth.js'), dict = require('../speech/mc_dict.json');
const SEMI = { 1: 0, 2: 2, 3: 4, 4: 5, 5: 7, 6: 9, 7: 11 };
const notes = tok => tok.match(/\d['，,]*/g).map(n => SEMI[n[0]] + 12 * ((n.match(/'/g) || []).length - (n.match(/,/g) || []).length));
const near = d => ((d % 12) + 18) % 12 - 6;           // nearest-octave interval, −6..5
const songs = [], L = fs.readFileSync(__dirname + '/baishi.txt', 'utf8').split('\n').filter(l => l && l[0] !== '#');
for (let i = 0; i < L.length; i++) {
  if (L[i][0] === '@') { songs.push({ name: L[i].slice(2), st: [] }); continue; }
  const text = L[i], toks = L[++i].trim().split(/\s+/), syl = [];
  let k = 0;
  for (const ch of text) {
    if (/[，。、；！？]/.test(ch)) { if (syl.length) syl[syl.length - 1].end = ch; continue; }
    const s = MC.parse(ch, dict)[0];
    syl.push({ ch, tone: s ? s.tone : '?', reg: s ? s.reg : '?', n: notes(toks[k++]) });
  }
  if (k !== toks.length) throw new Error(songs[songs.length - 1].name + ': ' + k + ' chars vs ' + toks.length + ' notes');
  songs[songs.length - 1].st.push(syl);
}
const all = songs.flatMap(s => s.st), N = all.reduce((a, s) => a + s.length, 0);
const miss = all.flat().filter(s => s.tone === '?').map(s => s.ch); if (miss.length) console.log('not in dict: ' + miss.join(''));
console.log(songs.length + ' songs, ' + all.length + ' stanzas, ' + N + ' syllables\n');
const T = ['P', 'X', 'H', 'R'], TN = { P: '平', X: '上', H: '去', R: '入' };
const pct = (a, b) => (100 * a / Math.max(1, b)).toFixed(0).padStart(3) + '%';
function table(title, key) {
  const c = {}; T.forEach(t => c[t] = { up: 0, eq: 0, dn: 0, n: 0 });
  const tot = { up: 0, eq: 0, dn: 0, n: 0 };
  all.forEach(st => st.forEach((s, i) => { const r = key(st, i); if (!r || !c[r[0]]) return; const d = r[1] > 0 ? 'up' : r[1] < 0 ? 'dn' : 'eq'; c[r[0]][d]++; c[r[0]].n++; tot[d]++; tot.n++; }));
  console.log(title + '\n        n    up   same  down');
  T.forEach(t => console.log('  ' + TN[t] + '  ' + String(c[t].n).padStart(4) + '  ' + pct(c[t].up, c[t].n) + '  ' + pct(c[t].eq, c[t].n) + '  ' + pct(c[t].dn, c[t].n)));
  console.log('  all ' + String(tot.n).padStart(4) + '  ' + pct(tot.up, tot.n) + '  ' + pct(tot.eq, tot.n) + '  ' + pct(tot.dn, tot.n) + '\n');
}
const last = s => s.n[s.n.length - 1];
// movement INTO a syllable (prev note → this syllable's first note), grouped by this syllable's tone
table('Into syllable (prev → this), by tone of this syllable:', (st, i) => i > 0 && !st[i - 1].end ? [st[i].tone, near(st[i].n[0] - last(st[i - 1]))] : null);
// movement OUT of a syllable (this syllable's last note → next), by tone of this syllable
table('Out of syllable (this → next), by tone of this syllable:', (st, i) => i < st.length - 1 && !st[i].end ? [st[i].tone, near(st[i + 1].n[0] - last(st[i]))] : null);
// melisma inside a syllable
table('Within melismatic syllables (first → last note):', (st, i) => st[i].n.length > 1 ? [st[i].tone, near(last(st[i]) - st[i].n[0])] : null);
// tone pairs: does pitch direction follow (Late-Tang) tone height?
const H = { P: { yin: 0, yang: -2.5 }, X: { yin: 2, yang: 0 }, H: { yin: 1, yang: -1 }, R: { yin: 2.5, yang: -1 } };
let agree = 0, dis = 0;
all.forEach(st => st.forEach((s, i) => {
  if (i === 0 || st[i - 1].end || !H[s.tone] || !H[st[i - 1].tone]) return; const a = st[i - 1], dh = H[s.tone][s.reg] - H[a.tone][a.reg], dm = near(s.n[0] - last(a));
  if (Math.abs(dh) < 1 || dm === 0) return; if (Math.sign(dh) === Math.sign(dm)) agree++; else dis++;
}));
console.log('Direction agrees with reconstructed tone height (yin/yang × tone): ' + agree + ' vs ' + dis + ' (' + pct(agree, agree + dis) + ')\n');
// intervals, degrees, cadences
const ih = {}; all.forEach(st => st.forEach((s, i) => { for (let j = 1; j < s.n.length; j++) ih[near(s.n[j] - s.n[j - 1])] = (ih[near(s.n[j] - s.n[j - 1])] || 0) + 1; if (i && !st[i - 1].end) { const d = near(s.n[0] - last(st[i - 1])); ih[d] = (ih[d] || 0) + 1; } }));
const it = Object.values(ih).reduce((a, b) => a + b);
console.log('Intervals (semitones, nearest octave):\n  ' + Object.keys(ih).sort((a, b) => a - b).map(k => k + ':' + pct(ih[k], it).trim()).join('  '));
const DEG = ['宮', '', '商', '', '角', '', '變徵', '徵', '', '羽', '', '變宮'], dh = {}, ch = {};
all.forEach(st => st.forEach(s => { s.n.forEach(p => { const d = DEG[((p - 5) % 12 + 12) % 12]; dh[d] = (dh[d] || 0) + 1; }); if (s.end) { const d = DEG[((last(s) - 5) % 12 + 12) % 12] + (s.end === '。' ? '。' : '，'); ch[d] = (ch[d] || 0) + 1; } }));
const dt = Object.values(dh).reduce((a, b) => a + b);
console.log('Degree use:  ' + Object.entries(dh).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + pct(v, dt).trim()).join('  '));
console.log('Phrase ends: ' + Object.entries(ch).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + v).join('  '));
console.log('Melismatic syllables: ' + pct(all.flat().filter(s => s.n.length > 1).length, N));
// tone-pair matrix: % of transitions going up, by (this tone → next tone); also by register
console.log('\n% up for transition this→next (rows: this tone, cols: next tone), n in brackets');
const M = {}; T.forEach(a => T.forEach(b => M[a + b] = [0, 0]));
const R = { yin: [0, 0], yang: [0, 0] };
all.forEach(st => st.forEach((s, i) => {
  if (i === st.length - 1 || s.end) return; const nx = st[i + 1], d = near(nx.n[0] - last(s)); if (!d || !M[s.tone + nx.tone]) return;
  M[s.tone + nx.tone][0] += d > 0; M[s.tone + nx.tone][1]++;
  if (nx.tone === 'P') { R[nx.reg][0] += d > 0; R[nx.reg][1]++; }
}));
console.log('      ' + T.map(t => '→' + TN[t] + '      ').join(''));
T.forEach(a => console.log('  ' + TN[a] + '  ' + T.map(b => pct(M[a + b][0], M[a + b][1]) + ' (' + String(M[a + b][1]).padStart(2) + ') ').join('')));
console.log('Into 平 by register: yin ' + pct(R.yin[0], R.yin[1]) + ' up (n ' + R.yin[1] + '), yang ' + pct(R.yang[0], R.yang[1]) + ' up (n ' + R.yang[1] + ')');
// degrees relative to each song's final note (= last note of the song)
const RD = ['1', 'b2', '2', 'b3', '3', '4', '#4', '5', 'b6', '6', 'b7', '7'], ce = {}, cc = {};
songs.forEach(sg => { const st = sg.st[sg.st.length - 1], f = last(st[st.length - 1]);
  sg.st.forEach(st => st.forEach(s => { if (!s.end) return; const k = RD[((last(s) - f) % 12 + 12) % 12]; (s.end === '。' ? ce : cc)[k] = ((s.end === '。' ? ce : cc)[k] || 0) + 1; })); });
const fmt = o => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ':' + v).join(' ');
console.log('\nPhrase ends relative to song final —  。: ' + fmt(ce) + '   ，、: ' + fmt(cc));
// compact model for sing.js: IV[deg] = {interval: count} (deg = semitone above 宮), TD[ab] = [up, same, down], DEG prior, CAD (rel. final)
const IV = {}, TD = {}, DG = {};
all.forEach(st => st.forEach((s, i) => {
  s.n.forEach((p, j) => { const g = ((p - 5) % 12 + 12) % 12; DG[g] = (DG[g] || 0) + 1;
    const nx = j < s.n.length - 1 ? s.n[j + 1] : i < st.length - 1 && !s.end ? st[i + 1].n[0] : null; if (nx == null) return;
    const d = near(nx - p); (IV[g] = IV[g] || {})[d] = (IV[g][d] || 0) + 1; });
  if (i < st.length - 1 && !s.end && H[s.tone] && H[st[i + 1].tone]) { const d = near(st[i + 1].n[0] - last(s)), k = s.tone + st[i + 1].tone; TD[k] = TD[k] || [0, 0, 0]; TD[k][d > 0 ? 0 : d ? 2 : 1]++; }
}));
const cad = {}; Object.entries(ce).forEach(([k, v]) => cad['。' + RD.indexOf(k)] = v); Object.entries(cc).forEach(([k, v]) => cad['，' + RD.indexOf(k)] = v);
console.log('\nMODEL ' + JSON.stringify({ IV, TD, DEG: DG, CAD: cad }));
