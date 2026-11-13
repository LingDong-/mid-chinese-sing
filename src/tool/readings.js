// readings.js — list 多音字 (and missing chars) in a text file with the reading the engine picks.  node tool/readings.js file.txt
const fs = require('fs'), SING = require('../sing.js'), dict = require('../speech/mc_dict.json');
const text = fs.readFileSync(process.argv[2], 'utf8');
text.split(/\n\s*\n/).forEach(block => {
  const song = SING.parseText(block.replace(/^#.*\n/gm, ''), dict), out = [];
  if (song.warn.length) out.push('MISSING ' + song.warn.join(''));
  song.stanzas.flat().forEach(ph => ph.syl.forEach(S => { const all = S.s.alt || []; if (all.length > 1) out.push(S.ch + ':' + S.s.bax + ' (' + all.join(' ') + ')'); }));
  console.log(block.split('\n').find(l => l && l[0] !== '#').slice(0, 10) + '\n  ' + out.join('  ') + '\n');
});
