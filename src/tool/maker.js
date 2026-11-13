// maker.js — small local server for maker.html: paste a poem, pick readings for 多音字, render a video to out/.
//   node tool/maker.js            then open http://localhost:8800/maker.html
// API: POST /api/readings {text} → tokens · POST /api/render {text,title,style,mode,tempo,seed,band,fps,res} → job · GET /api/jobs
// Renders run one at a time through tool/video.js (headless Chrome), from the current project files.
const http = require('http'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..'), PORT = +(process.env.PORT || 8800);
const SING = require('../sing.js'), MC = require('../speech/mcsynth.js'), dict = require('../speech/mc_dict.json');

// IPA for display: register-aware Chao tone letters (same convention as the stage subtitles)
const CHAO = { P: ['˧', '˨'], X: ['˧˥', '˨˦'], H: ['˥˨', '˦˩'], R: ['˥', '˨'] };
function ipaShow(s) { return s.ipa.replace(/[˥˧˩]+₂?$/, '').replace(/̚/g, '') + CHAO[s.tone][s.reg === 'yang' ? 1 : 0]; }
const TN = { P: '平', X: '上', H: '去', R: '入' };

// one token per character: {ch} for punctuation/space, or {ch, chosen, readings:[{bax, ipa, tone}], missing}
function readings(text, era) {
  return (text.replace(/\r/g, '').match(/[^\x00-\x7f][\[［][^\]］]*[\]］]|[\s\S]/gu) || []).map(t => {
    const ch = String.fromCodePoint(t.codePointAt(0));
    if (/[\s，。、；：！？,.;:!?《》「」『』“”"'（）()·—\-]/.test(ch)) return { ch };
    const song = SING.parseText(t, dict, era), S = song.stanzas[0] && song.stanzas[0][0] && song.stanzas[0][0].syl[0];
    if (!S) return { ch, missing: true, sel: t.length > ch.length ? t.slice(ch.length).replace(/[\[\]［］]/g, '') : '' };
    const alt = (S.s.alt && S.s.alt.length ? S.s.alt : [S.s.bax]).slice();
    if (alt.indexOf(S.s.bax) < 0) alt.unshift(S.s.bax);
    // tone label: the 切韻 category of this reading; if Late Tang pronounces it in another tone (濁上變去), show "上→去";
    // 陰/陽 = register (voiceless / voiced initial), for all four tones; readings that sound the same are marked 同音
    const R = alt.map(b => { const p = MC.parseBax(b, era), q = /X$/.test(b) ? 'X' : /H$/.test(b) ? 'H' : /(p|t|k)$/.test(b) ? 'R' : 'P';
      return { bax: b, ipa: ipaShow(p), tone: (q === p.tone ? TN[q] : TN[q] + '→' + TN[p.tone]) + (era === 'high' ? '' : p.reg === 'yang' ? '·陽' : '·陰') }; });
    R.forEach(r => { if (R.some(o => o !== r && o.ipa === r.ipa)) r.tone += ' 同音'; });
    return { ch, chosen: alt.indexOf(S.s.bax), readings: R };
  });
}

// render queue
const jobs = []; let running = null;
function next() {
  if (running || !jobs.some(j => j.status === 'queued')) return;
  const j = running = jobs.find(j => j.status === 'queued'); j.status = 'rendering'; j.started = Date.now();
  fs.mkdirSync(path.join(ROOT, 'out', '.maker'), { recursive: true });
  const f = path.join(ROOT, 'out', '.maker', 'job' + j.id + '.txt');
  fs.writeFileSync(f, '# ' + j.title + '\n' + j.text + '\n');
  const a = ['-arm64', 'node', '--experimental-websocket', 'tool/video.js', '--file', f, '--only', '0', '--style', j.style, '--band', j.band,
    '--fps', String(j.fps), '--res', String(j.res), '--seed', String(j.seed), '--out', j.out, '--port', '8791'];
  if (j.era) a.push('--era', j.era);
  if (j.aspect === 'portrait') a.push('--aspect', 'portrait');
  if (j.prelude) a.push('--prelude', j.prelude);
  if (j.mode) a.push('--mode', j.mode); if (j.tempo) a.push('--tempo', String(j.tempo));
  const p = spawn('arch', a, { cwd: ROOT });
  const log = d => { j.log = (j.log + d.toString()).split('\n').slice(-40).join('\n'); };
  p.stdout.on('data', log); p.stderr.on('data', log);
  p.on('close', code => { j.status = code === 0 && fs.existsSync(j.out) ? 'done' : 'failed'; j.secs = Math.round((Date.now() - j.started) / 1000); running = null; next(); });
}
function addJob(o) {
  const title = (o.title || '').trim() || (o.text.replace(/\[[^\]]*\]/g, '').match(/[^\s，。、；：！？]+/) || ['poem'])[0].slice(0, 12);
  const safe = title.replace(/[\/\\:*?"<>|\s]+/g, '_'), style = o.style === 'song' ? 'song' : 'tang', port = o.aspect === 'portrait', pre = /^(short|none)$/.test(o.prelude) ? o.prelude : '';
  const j = { id: jobs.length + 1, title, text: o.text, style, band: o.band === 'sing' ? 'sing' : 'full', fps: +o.fps === 60 ? 60 : 30, res: +o.res === 1080 ? 1080 : 720,
    seed: +o.seed || 1, era: o.era === 'high' ? 'high' : '', mode: /^[宮商角徵羽]$/.test(o.mode) ? o.mode : '', tempo: +o.tempo || 0, aspect: port ? 'portrait' : 'landscape', prelude: pre, status: 'queued', log: '', file: 'out/' + safe + (style === 'song' ? '_song' : '') + (port ? '_9x16' : '') + (pre ? '_' + pre : '') + '.mp4' };
  j.out = path.join(ROOT, j.file); jobs.push(j); next(); return j;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.mp4': 'video/mp4', '.webm': 'video/webm', '.png': 'image/png', '.css': 'text/css' };
http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'POST') {
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      let o; try { o = JSON.parse(body); } catch (e) { return send(400, { error: 'bad json' }); }
      if (req.url === '/api/readings') return send(200, readings(o.text || '', o.era === 'high' ? 'high' : 'late'));
      if (req.url === '/api/render') { if (!(o.text || '').trim()) return send(400, { error: 'empty poem' }); const j = addJob(o); return send(200, { id: j.id, file: j.file }); }
      send(404, { error: 'unknown' });
    }); return;
  }
  if (req.url === '/api/jobs') return send(200, jobs.map(j => ({ id: j.id, title: j.title, style: j.style, status: j.status, file: j.file, secs: j.secs, log: j.status === 'rendering' || j.status === 'failed' ? j.log : '' })));
  const u = decodeURIComponent(req.url.split('?')[0]), f = path.join(ROOT, u === '/' ? 'maker.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log('maker: http://localhost:' + PORT + '/maker.html'));
