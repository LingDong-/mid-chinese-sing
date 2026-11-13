// video.js — offline, deterministic render of a performance to a video file, with burnt-in subtitles and the band audio.
//   arch -arm64 node --experimental-websocket tool/video.js [--poem 2] [--band full|sing] [--fps 30] [--res 720] [--ss 2]
//        [--body 0.005 --fine 0.0018 (default: the stage's mesh)] [--simhz 60] [--iters 1] [--cloth stage|full|old] [--shadow 4096] [--msaa 8] [--fade 0 (seconds; off by default)]
//        [--file poems.txt --only k]  (a titled section of a poems file, with its --mode/--tempo/--seed)
//        [--aspect landscape|portrait] (portrait = 9:16) [--prelude full|short|none] (short: the last 3 beats; none: she starts at once)
//        [--era late|high] (盛唐 tones) [--style tang|song] [--t0 0 --t1 end] [--vbitrate 12e6] [--abitrate 256000] [--out out/<title>.mp4] [--probe]
// Body mesh and cloth default to the live stage's (its 5 / 1.8 mm mesh, so the colliders are fitted to the same mesh; the same
// garments, warm-up and fixed 1/60 s steps at the same pose times: two per frame at 30 fps), so the video shows what the stage shows; --cloth full --simhz 240 --iters 2 is the 'high fidelity'
// variant the user found worse. Headless Chrome renders stage.html?video frame by frame (window.VIDEO.frame at t = n / fps on the audio clock, audio from
// t = 0) and encodes with WebCodecs: H.264 + AAC into MP4 when the browser supports them, else VP9 + Opus into WebM.
// The encoded chunks come back to this script's small HTTP server (it also serves the project folder), which muxes them.
const http = require('http'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2), opt = { poem: 2, band: 'full', fps: 30, res: 720, ss: 2, body: 0, fine: 0, simhz: 60, iters: 1, cloth: 'stage', fade: 0, shadow: 4096, msaa: 8, seed: 1, t0: 0, t1: 0, vbitrate: 0, abitrate: 256000, port: 8790, out: '', probe: false };
for (let i = 0; i < args.length; i++) { const k = args[i].replace(/^--/, ''); if (k === 'probe') opt.probe = true; else { const v = args[++i]; opt[k] = isNaN(+v) || k === 'out' || k === 'band' || k === 'cloth' || k === 'file' || k === 'mode' || k === 'style' || k === 'era' || k === 'aspect' || k === 'prelude' ? v : +v; } }
if (opt.file) {   // --file poems.txt --only k: a "# title | --mode … --tempo … --seed …" section, as in render.js (voice is the stage's)
  const sec = fs.readFileSync(opt.file, 'utf8').split(/^# /m).slice(1)[opt.only || 0], nl = sec.indexOf('\n'), head = sec.slice(0, nl).split('|'), h = {};
  ((head[1] || '').match(/--\w+\s+("[^"]*"|\S+)/g) || []).forEach(x => { const m = x.match(/--(\w+)\s+"?([^"]*)"?/); h[m[1]] = m[2]; });
  opt.title = head[0].trim(); opt.text = sec.slice(nl + 1).trim(); opt.mode = opt.mode || h.mode; opt.tempo = opt.tempo || h.tempo;
  if (!args.includes('--seed') && h.seed) opt.seed = +h.seed;
}
const LONG = Math.round(opt.res * 16 / 9 / 2) * 2, PORT = opt.aspect === 'portrait', W = PORT ? opt.res : LONG, H = PORT ? LONG : opt.res;   // --aspect portrait: 9:16
if (!opt.vbitrate) opt.vbitrate = Math.round(12e6 * (W * H) / (1280 * 720) * (opt.fps / 30) ** 0.7);
const log = (...a) => console.log(...a);

/* ---------------- MP4 muxer (ISO BMFF, non-fragmented; moov after mdat) ---------------- */
const u8 = n => Buffer.from([n & 255]), u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff); return b; }, u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }, s32 = n => { const b = Buffer.alloc(4); b.writeInt32BE(n | 0); return b; };
const str = s => Buffer.from(s, 'latin1');
function box(type, ...parts) { const body = Buffer.concat(parts.flat(Infinity)); return Buffer.concat([u32(8 + body.length), str(type), body]); }
const full = (type, ver, flags, ...parts) => box(type, u8(ver), u8(flags >> 16), u16(flags & 0xffff), ...parts);
const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32);
function desc(tag, body) { const n = body.length; return Buffer.concat([u8(tag), u8(0x80 | (n >> 21) & 127), u8(0x80 | (n >> 14) & 127), u8(0x80 | (n >> 7) & 127), u8(n & 127), body]); }
function muxMP4(file, V, A) {
  // V: {w, h, fps, samples: [{data, pts(µs), key}], avcC}; A: {sr, samples: [{data}], asc, delay, bitrate}
  const vts = V.fps * 1000, vdur = 1000, nV = V.samples.length;
  // decode order is output order; composition offsets for reordered (B) frames
  const pts = V.samples.map(s => Math.round(s.pts * vts / 1e6)), sorted = pts.slice().sort((a, b) => a - b);
  let shift = 0; const dts = sorted.map((p, i) => p); for (let i = 0; i < nV; i++) shift = Math.max(shift, dts[i] - pts[i] + 0);
  const ctts = pts.map((p, i) => p - (dts[i] - shift)), hasCtts = ctts.some(c => c !== ctts[0]) || shift > 0;
  // interleave in ~1 s chunks
  const chunks = [], aPer = Math.max(1, Math.round(A ? A.sr / 1024 : 1));
  for (let i = 0, j = 0; i < nV || (A && j < A.samples.length);) {
    if (i < nV) { const n = Math.min(V.fps, nV - i); chunks.push({ t: 'v', a: i, n }); i += n; }
    if (A && j < A.samples.length) { const n = Math.min(aPer, A.samples.length - j); chunks.push({ t: 'a', a: j, n }); j += n; }
  }
  const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
  let off = ftyp.length + 8; const mdatParts = [];
  chunks.forEach(c => { c.off = off; const S = c.t === 'v' ? V.samples : A.samples; for (let k = c.a; k < c.a + c.n; k++) { mdatParts.push(S[k].data); off += S[k].data.length; } });
  const mdatLen = off - ftyp.length;
  const durV = nV * vdur, movieTS = 1000, durMv = Math.round(nV / V.fps * 1000), durA = A ? A.samples.length * 1024 : 0;
  const stcoFor = t => { const cs = chunks.filter(c => c.t === t); return { stsc: cs.map((c, i) => [i + 1, c.n]).filter((e, i, arr) => !i || e[1] !== arr[i - 1][1]), stco: cs.map(c => c.off) }; };
  const stscBox = list => full('stsc', 0, 0, u32(list.length), list.map(e => [u32(e[0]), u32(e[1]), u32(1)]));
  const tkhd = (id, dur, vol, w, h) => full('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(dur), u32(0), u32(0), u16(0), u16(0), u16(vol), u16(0), MATRIX, u32(w << 16), u32(h << 16));
  const mdhd = (ts, dur) => full('mdhd', 0, 0, u32(0), u32(0), u32(ts), u32(dur), u16(0x55c4), u16(0));
  const hdlr = (t, name) => full('hdlr', 0, 0, u32(0), str(t), u32(0), u32(0), u32(0), str(name + '\0'));
  const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
  const elst = (segDur, mediaTime) => box('edts', full('elst', 0, 0, u32(1), u32(segDur), s32(mediaTime), u32(0x10000)));
  // video track
  const vc = stcoFor('v');
  const avc1 = box('avc1', Buffer.alloc(6), u16(1), Buffer.alloc(16), u16(V.w), u16(V.h), u32(0x480000), u32(0x480000), u32(0), u16(1), Buffer.alloc(32), u16(0x18), u16(0xffff), box('avcC', V.avcC), box('pasp', u32(1), u32(1)));
  const keys = V.samples.map((s, i) => s.key ? i + 1 : 0).filter(Boolean);
  const vstbl = box('stbl', full('stsd', 0, 0, u32(1), avc1), full('stts', 0, 0, u32(1), u32(nV), u32(vdur)),
    hasCtts ? full('ctts', 0, 0, u32(nV), ctts.map(c => [u32(1), u32(c)])) : Buffer.alloc(0),
    full('stss', 0, 0, u32(keys.length), keys.map(u32)), stscBox(vc.stsc), full('stsz', 0, 0, u32(0), u32(nV), V.samples.map(s => u32(s.data.length))), full('stco', 0, 0, u32(vc.stco.length), vc.stco.map(u32)));
  const vtrak = box('trak', tkhd(1, durMv, 0, V.w, V.h), hasCtts ? elst(durMv, ctts[0] > 0 ? Math.min(...ctts) : 0) : Buffer.alloc(0),
    box('mdia', mdhd(vts, durV), hdlr('vide', 'Video'), box('minf', full('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)), dinf, vstbl)));
  let atrak = Buffer.alloc(0);
  if (A) {
    const ac = stcoFor('a'), nA = A.samples.length;
    const esds = full('esds', 0, 0, desc(3, Buffer.concat([u16(1), u8(0), desc(4, Buffer.concat([u8(0x40), u8(0x15), Buffer.from([0, 0, 0]), u32(A.bitrate), u32(A.bitrate), desc(5, A.asc)])), desc(6, u8(2))])));
    const mp4a = box('mp4a', Buffer.alloc(6), u16(1), Buffer.alloc(8), u16(2), u16(16), u16(0), u16(0), u32(A.sr << 16), esds);
    const astbl = box('stbl', full('stsd', 0, 0, u32(1), mp4a), full('stts', 0, 0, u32(1), u32(nA), u32(1024)), stscBox(ac.stsc),
      full('stsz', 0, 0, u32(0), u32(nA), A.samples.map(s => u32(s.data.length))), full('stco', 0, 0, u32(ac.stco.length), ac.stco.map(u32)));
    const playA = Math.min(Math.round((durA - A.delay) / A.sr * 1000), A.srcLen ? Math.round(A.srcLen / A.sr * 1000) : 1e12, durMv);   // trim the encoder's padding too
    atrak = box('trak', tkhd(2, playA, 0x100, 0, 0), elst(playA, A.delay), box('mdia', mdhd(A.sr, durA), hdlr('soun', 'Sound'), box('minf', full('smhd', 0, 0, u16(0), u16(0)), dinf, astbl)));
  }
  const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(movieTS), u32(durMv), u32(0x10000), u16(0x100), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32(A ? 3 : 2));
  const moov = box('moov', mvhd, vtrak, atrak);
  const fd = fs.openSync(file, 'w'); fs.writeSync(fd, ftyp); fs.writeSync(fd, Buffer.concat([u32(mdatLen), str('mdat')])); mdatParts.forEach(b => fs.writeSync(fd, b)); fs.writeSync(fd, moov); fs.closeSync(fd);
}
/* ---------------- WebM muxer (Matroska subset: VP9 + Opus, SimpleBlocks in 1 s clusters) ---------------- */
function ebml(id, body) { // id: number (its byte form includes the marker), body: Buffer
  const idb = []; for (let x = id; x > 0; x = Math.floor(x / 256)) idb.unshift(x & 255);
  const n = body.length, sz = Buffer.alloc(8); sz[0] = 0x01; for (let i = 0; i < 7; i++) sz[7 - i] = Math.floor(n / 2 ** (8 * i)) & 255;
  return Buffer.concat([Buffer.from(idb), sz, body]);
}
const uint = n => { const b = []; do { b.unshift(n & 255); n = Math.floor(n / 256); } while (n > 0); return Buffer.from(b); }, f64 = x => { const b = Buffer.alloc(8); b.writeDoubleBE(x); return b; };
function muxWebM(file, V, A) {
  const head = ebml(0x1A45DFA3, Buffer.concat([ebml(0x4286, uint(1)), ebml(0x42F7, uint(1)), ebml(0x42F2, uint(4)), ebml(0x42F3, uint(8)), ebml(0x4282, str('webm')), ebml(0x4287, uint(4)), ebml(0x4285, uint(2))]));
  const durMs = V.samples.length / V.fps * 1000;
  const info = ebml(0x1549A966, Buffer.concat([ebml(0x2AD7B1, uint(1000000)), ebml(0x4D80, str('mid_ch_sing')), ebml(0x5741, str('mid_ch_sing')), ebml(0x4489, f64(durMs))]));
  const vt = ebml(0xAE, Buffer.concat([ebml(0xD7, uint(1)), ebml(0x73C5, uint(1)), ebml(0x83, uint(1)), ebml(0x86, str('V_VP9')), ebml(0xE0, Buffer.concat([ebml(0xB0, uint(V.w)), ebml(0xBA, uint(V.h))]))]));
  let tracks = [vt];
  if (A) { const opusHead = Buffer.concat([str('OpusHead'), u8(1), u8(2), Buffer.from([A.delay & 255, A.delay >> 8]), Buffer.from(u32(A.sr)).reverse(), Buffer.from([0, 0, 0])]);
    tracks.push(ebml(0xAE, Buffer.concat([ebml(0xD7, uint(2)), ebml(0x73C5, uint(2)), ebml(0x83, uint(2)), ebml(0x86, str('A_OPUS')), ebml(0x63A2, A.desc || opusHead), ebml(0x56AA, uint(Math.round(A.delay / 48000 * 1e9))), ebml(0xE1, Buffer.concat([ebml(0xB5, f64(48000)), ebml(0x9F, uint(2))]))]))); }
  const tr = ebml(0x1654AE6B, Buffer.concat(tracks));
  const ev = []; V.samples.forEach(s => ev.push({ tr: 1, t: s.pts / 1000, d: s.data, key: s.key }));
  if (A) A.samples.forEach(s => ev.push({ tr: 2, t: s.pts / 1000, d: s.data, key: 1 }));
  ev.sort((a, b) => a.t - b.t || a.tr - b.tr);
  const clusters = []; let i = 0;
  while (i < ev.length) { const ct = Math.floor(ev[i].t / 1000) * 1000, blocks = [ebml(0xE7, uint(ct))];
    while (i < ev.length && ev[i].t < ct + 1000) { const e = ev[i++], rel = Math.round(e.t - ct); blocks.push(ebml(0xA3, Buffer.concat([u8(0x80 | e.tr), u16(rel), u8(e.key ? 0x80 : 0), e.d]))); }
    clusters.push(ebml(0x1F43B675, Buffer.concat(blocks))); }
  fs.writeFileSync(file, Buffer.concat([head, ebml(0x18538067, Buffer.concat([info, tr, ...clusters]))]));
}

/* ---------------- server + Chrome ---------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css', '.wav': 'audio/wav' };
const got = { v: [], a: [], meta: {} }; let done = null; const doneP = new Promise(r => done = r);
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'POST') {
    const parts = []; req.on('data', d => parts.push(d)); req.on('end', () => {
      let body = Buffer.concat(parts), meta = null;
      if (u.pathname === '/v' || u.pathname === '/a') { const jl = body.readUInt32BE(0); meta = JSON.parse(body.subarray(4, 4 + jl).toString()); body = body.subarray(4 + jl); }
      if (u.pathname === '/log') log('  [page] ' + body.toString());
      else if (u.pathname === '/meta') Object.assign(got.meta, JSON.parse(body.toString()));
      else if (u.pathname === '/v' || u.pathname === '/a') { let o = 0; meta.forEach(m => { const d = body.subarray(o, o + m[2]); o += m[2]; (u.pathname === '/v' ? got.v : got.a).push({ pts: m[0], dur: m[1], data: Buffer.from(d), key: m[3] }); }); }
      else if (u.pathname === '/done') done();
      res.end('ok');
    });
    return;
  }
  const f = path.join(ROOT, decodeURIComponent(u.pathname === '/' ? '/stage.html' : u.pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream'); res.setHeader('Cache-Control', 'no-store'); fs.createReadStream(f).pipe(res);
});
(async () => {
  await new Promise(r => server.listen(opt.port, '127.0.0.1', r));
  const chrome = spawn('/usr/bin/arch', ['-arm64', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', '--user-data-dir=' + path.join(__dirname, '.chrome-video'),
    '--remote-debugging-port=9335', '--window-size=' + W + ',' + H, '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
  const quit = code => { try { chrome.kill(); spawn('pkill', ['-f', 'user-data-dir=' + path.join(__dirname, '.chrome-video')]); } catch (e) {} server.close(); setTimeout(() => process.exit(code), 300); };
  let list; for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 300)); try { list = await (await fetch('http://127.0.0.1:9335/json/list')).json(); break; } catch (e) {} }
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl); let id = 0; const pend = {};
  const send = (m, p) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m.result || m); delete pend[m.id]; } else if (m.method === 'Runtime.exceptionThrown') log('PAGE ERROR', JSON.stringify(m.params.exceptionDetails).slice(0, 600)); else if (m.method === 'Runtime.consoleAPICalled') log('  [console] ' + m.params.args.map(a => a.value).join(' ')); };
  await new Promise(r => ws.onopen = r); await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) log('EVAL ERROR', JSON.stringify(r.exceptionDetails).slice(0, 600)); return r.result ? r.result.value : r; };
  await send('Page.navigate', { url: 'http://127.0.0.1:' + opt.port + '/stage.html?shot&t=0' });
  for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 300)); if (await ev('typeof VideoEncoder') === 'function') break; }
  // codecs: H.264 High + AAC in MP4 if supported, else VP9 + Opus in WebM
  const sup = await ev(`(async () => { const v = c => VideoEncoder.isConfigSupported({ codec: c, width: ${W}, height: ${H}, bitrate: ${opt.vbitrate}, framerate: ${opt.fps} }).then(r => r.supported).catch(() => false);
    const a = c => AudioEncoder.isConfigSupported({ codec: c, sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 }).then(r => r.supported).catch(() => false);
    return { avcH: await v('avc1.640028'), avcM: await v('avc1.4d0028'), avcB: await v('avc1.42e028'), vp9: await v('vp09.00.40.08'), aac: await a('mp4a.40.2'), opus: await a('opus') }; })()`);
  log('codec support:', JSON.stringify(sup));
  if (opt.probe) return quit(0);
  const mp4 = (sup.avcH || sup.avcM || sup.avcB) && sup.aac, vcodec = mp4 ? (sup.avcH ? 'avc1.640028' : sup.avcM ? 'avc1.4d0028' : 'avc1.42e028') : 'vp09.00.40.08', acodec = mp4 ? 'mp4a.40.2' : 'opus';
  const q = ['video', opt.style === 'song' ? 'style=song' : '', 'poem=' + opt.poem, opt.text ? 'text=' + encodeURIComponent(opt.text) + '&title=' + encodeURIComponent(opt.title) : '', opt.mode ? 'mode=' + encodeURIComponent(opt.mode) : '', opt.tempo ? 'tempo=' + opt.tempo : '', opt.era ? 'era=' + opt.era : '', opt.prelude && opt.prelude !== 'full' ? 'prelude=' + opt.prelude : '', 'seed=' + opt.seed, opt.band === 'full' ? 'band' : '', opt.body ? 'res=' + opt.body : '', opt.body ? 'fine=' + (opt.fine || 0.0018) : '', 'ss=' + opt.ss, 'shadow=' + opt.shadow, 'msaa=' + opt.msaa, 'simhz=' + opt.simhz, 'iters=' + opt.iters, opt.cloth === 'full' || opt.cloth === 'old' ? 'cloth=' + opt.cloth : '', opt.simhz === 60 && opt.iters === 1 ? 'stagecloth' : ''].filter(Boolean).join('&');
  const T0 = Date.now();
  await send('Page.navigate', { url: 'http://127.0.0.1:' + opt.port + '/stage.html?' + q });
  for (let i = 0; ; i++) { await new Promise(r => setTimeout(r, 1000)); if (await ev('!!window.VIDEO')) break; if (i % 20 === 0) log('  building… ' + (await ev("document.getElementById('status').textContent"))); if (i > 3600) { log('timed out building'); return quit(1); } }
  const info = await ev('({ dur: VIDEO.dur, title: VIDEO.title, size: VIDEO.size(), cloth: VIDEO.cloth, verts: VIDEO.verts, sr: VIDEO.audio.sr })');
  log(`built in ${((Date.now() - T0) / 1000).toFixed(0)} s: ${info.title}, ${info.dur.toFixed(1)} s, body ${info.verts} verts, render ${info.size.join('×')} → ${W}×${H}, cloth: ${info.cloth}`);
  const page = fs.readFileSync(path.join(__dirname, 'video_page.js'), 'utf8');
  const O = { fps: opt.fps, w: W, h: H, vcodec, acodec, vbitrate: opt.vbitrate, abitrate: opt.abitrate, t0: opt.t0, t1: opt.t1 || 0, fade: opt.fade };
  const T1 = Date.now(); ev('(' + page + ')(' + JSON.stringify(O) + ')'); await doneP; const renderS = (Date.now() - T1) / 1000;
  // mux
  const title = (info.title || 'video').split(' · ')[0], outF = opt.out || path.join(ROOT, 'out', title + (opt.style === 'song' ? '_song' : '') + (PORT ? '_9x16' : '') + (opt.prelude && opt.prelude !== 'full' ? '_' + opt.prelude : '') + (opt.t0 || opt.t1 ? '_' + opt.t0 + '-' + (opt.t1 || 'end') : '') + (mp4 ? '.mp4' : '.webm'));
  fs.mkdirSync(path.dirname(outF), { recursive: true });
  const M = got.meta, Vt = { w: W, h: H, fps: opt.fps, samples: got.v, avcC: M.video.description ? Buffer.from(M.video.description) : null };
  if (!got.a.length) log('WARNING: no audio chunks arrived');
  const At = got.a.length ? { sr: M.audio.sr, samples: got.a, delay: M.audio.delay, srcLen: M.audio.srcLen, bitrate: opt.abitrate, asc: M.audio.description ? Buffer.from(M.audio.description) : null, desc: M.audio.description ? Buffer.from(M.audio.description) : null } : null;
  if (mp4) { if (At && !At.asc) { const fi = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000].indexOf(At.sr); At.asc = Buffer.from([(2 << 3) | (fi >> 1), ((fi & 1) << 7) | (2 << 3)]); } muxMP4(outF, Vt, At); }
  else muxWebM(outF, Vt, At);
  const sz = fs.statSync(outF).size;
  log(`wrote ${outF}\n  ${(sz / 1e6).toFixed(1)} MB, ${vcodec} ${W}×${H} @ ${opt.fps} fps (${(opt.vbitrate / 1e6).toFixed(1)} Mbit/s target, ${got.v.length} frames, ${got.v.filter(s => s.key).length} key frames) + ${acodec} ${M.audio.sr} Hz stereo (encoder delay ${M.audio.delay} samples, trimmed by an edit list)\n  build ${((T1 - T0) / 1000).toFixed(0)} s + render/encode ${(renderS / 60).toFixed(1)} min = total ${((Date.now() - T0) / 60000).toFixed(1)} min`);
  ws.close(); quit(0);
})();
