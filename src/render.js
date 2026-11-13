// render.js — compose + sing a poem to WAV (and print the score).
//   node render.js [poem# | "poem text" | file.txt] [--voice woman] [--mode 羽] [--seed 3] [--tempo 66] [--band "xiao pipa perc"]
//                  [--tune poem#|file]  (sing to the tune composed for another poem, same seed)   [--out out/name.wav]
//                  [--full]  (fuller ensemble accompaniment from band.js instead of sing.js's own)   [--era high]  (盛唐 tones; default Late Tang)
//   node render.js poems.txt [--only 3] [--full]   a file of "# title | --voice … --mode …" sections renders each one
//   node render.js --baishi 揚州慢   (a song from tool/baishi.txt with Jiang Kui's own melody, as transcribed by 丘瓊蓀)
const fs = require('fs'), SING = require('./sing.js'), dict = require('./speech/mc_dict.json');
const args = s => { const o = {}, pos = [], a = s.match(/"[^"]*"|\S+/g) || []; for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) o[a[i].slice(2)] = /^--/.test(a[i + 1] || '--') ? true : a[++i].replace(/^"|"$/g, ''); else pos.push(a[i]); return { o, pos }; };
const cli = args(process.argv.slice(2).map(x => /\s/.test(x) ? '"' + x + '"' : x).join(' ')), o = cli.o, pos = cli.pos;
const poem = x => /^\d+$/.test(x) ? SING.POEMS[+x] : fs.existsSync(x) ? { title: x.replace(/.*\/|\.\w+$/g, ''), text: fs.readFileSync(x, 'utf8') } : { title: x.slice(0, 8), text: x };

function run(P, o) {
  const seed = +(o.seed || 1), co = { seed, mode: o.mode, tempo: o.tempo && +o.tempo, melody: o.melody, toneWeight: o.tone && +o.tone, era: o.era };
  if (o.tune) co.template = SING.compose(poem(o.tune).text, dict, { seed, mode: o.mode, tempo: co.tempo });
  const song = SING.compose(P.text, dict, co);
  if (song.warn.length) console.log('not in dictionary (skipped): ' + song.warn.join(''));
  console.log(P.title + '\n' + SING.score(song));
  const ro = { voice: o.voice, seed, band: o.band === true ? '' : o.band, key: o.key && +o.key, reverb: o.reverb && +o.reverb };
  const t = Date.now(), r = o.full ? require('./band.js').render(song, ro) : SING.render(song, ro);
  const out = o.out || 'out/' + P.title.split(' ')[0] + '_' + (o.voice || 'woman') + '_' + seed + (o.full ? '_band' : '') + '.wav';
  fs.mkdirSync(require('path').dirname(out), { recursive: true });
  fs.writeFileSync(out, SING.wav(r.L, r.R, r.sr));
  console.log(out + '  ' + (r.L.length / r.sr).toFixed(1) + 's  (rendered in ' + ((Date.now() - t) / 1000).toFixed(1) + 's)\n');
}

if (o.baishi) {   // 丘's 簡譜 has 宮 = 4: convert to semitones above 宮
  const L = fs.readFileSync(__dirname + '/tool/baishi.txt', 'utf8').split('\n'), i = L.findIndex(l => l.startsWith('@ ' + o.baishi)), S = { 1: 0, 2: 2, 3: 4, 4: 5, 5: 7, 6: 9, 7: 11 }, st = [];
  for (let j = i + 1; j < L.length && L[j].trim() && L[j][0] !== '@'; j += 2) st.push([L[j], L[j + 1]]);
  o.melody = st.flatMap(x => x[1].trim().split(/\s+/)).map(t => t.match(/\d['，,]*/g).map(n => S[n[0]] - 5 + 12 * ((n.match(/'/g) || []).length - (n.match(/,/g) || []).length)));
  o.mode = o.mode || '宮'; o.tempo = o.tempo || 60; o.out = o.out || 'out/' + o.baishi + '_原譜_' + (o.voice || 'woman') + (o.full ? '_band' : '') + '.wav';
  run({ title: o.baishi, text: st.map(x => x[0]).join('\n\n') }, o);
} else if (!pos.length) SING.POEMS.forEach((p, i) => console.log(i + '  ' + p.title));
else {
  const P = poem(pos[0]);
  if (/^# /m.test(P.text)) P.text.split(/^# /m).slice(1).forEach((sec, k) => {   // file of titled sections
    if (o.only != null && +o.only !== k) return;
    const nl = sec.indexOf('\n'), head = sec.slice(0, nl).split('|'), h = args(head[1] || '');
    run({ title: head[0].trim(), text: sec.slice(nl + 1).trim() }, Object.assign({}, h.o, o, { only: undefined }));
  });
  else run(P, o);
}
