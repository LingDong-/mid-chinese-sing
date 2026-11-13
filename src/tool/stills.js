// stills.js — pull still frames out of a rendered video (decoded by Chrome's <video>), and report its duration and audio.
//   arch -arm64 node --experimental-websocket tool/stills.js out/file.mp4 t1 t2 … → tool/shots/still_<t>.png
// Also decodes the audio track (AudioContext.decodeAudioData) and reports its length and the time of its first sound.
const http = require('http'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..'), file = path.resolve(process.argv[2]), times = process.argv.slice(3).map(Number);
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end('<body style="margin:0;background:#000"><video id="v" muted playsinline style="width:100vw;height:100vh;object-fit:contain;display:block"></video></body>'); }
  if (u.pathname === '/file') { const st = fs.statSync(file), r = req.headers.range; res.setHeader('Content-Type', file.endsWith('.webm') ? 'video/webm' : 'video/mp4'); res.setHeader('Accept-Ranges', 'bytes');
    if (r) { const m = /bytes=(\d+)-(\d*)/.exec(r), a = +m[1], b = m[2] ? +m[2] : st.size - 1; res.statusCode = 206; res.setHeader('Content-Range', `bytes ${a}-${b}/${st.size}`); res.setHeader('Content-Length', b - a + 1); return fs.createReadStream(file, { start: a, end: b }).pipe(res); }
    res.setHeader('Content-Length', st.size); return fs.createReadStream(file).pipe(res); }
  res.statusCode = 404; res.end();
});
(async () => {
  await new Promise(r => server.listen(8791, '127.0.0.1', r));
  const VW = +(process.env.VW || 1280), VH = +(process.env.VH || 720);   // capture window (VW=720 VH=1280 for portrait videos at full size)
  const chrome = spawn('/usr/bin/arch', ['-arm64', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', '--user-data-dir=' + path.join(__dirname, '.chrome-stills'), '--remote-debugging-port=9336', '--window-size=' + VW + ',' + VH, '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let list; for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 300)); try { list = await (await fetch('http://127.0.0.1:9336/json/list')).json(); break; } catch (e) {} }
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl); let id = 0; const pend = {};
  const send = (m, p) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m.result || m); delete pend[m.id]; } };
  await new Promise(r => ws.onopen = r); await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
  const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result ? r.result.value : r; };
  await send('Page.navigate', { url: 'http://127.0.0.1:8791/' }); await new Promise(r => setTimeout(r, 800));
  console.log(await ev(`new Promise(r => { const v = document.getElementById('v'); v.onloadeddata = () => r('video ' + v.videoWidth + '×' + v.videoHeight + ', ' + v.duration.toFixed(3) + ' s'); v.onerror = () => r('VIDEO ERROR ' + (v.error && v.error.message)); v.src = '/file'; })`));
  console.log(await ev(`fetch('/file').then(r => r.arrayBuffer()).then(b => new OfflineAudioContext(2, 44100, 44100).decodeAudioData(b)).then(a => { const d = a.getChannelData(0); let i = 0; while (i < d.length && Math.abs(d[i]) < 1e-3) i++; return 'audio ' + a.numberOfChannels + ' ch ' + a.sampleRate + ' Hz, ' + a.duration.toFixed(3) + ' s, first sound at ' + (i / a.sampleRate).toFixed(3) + ' s'; }).catch(e => 'AUDIO ERROR ' + e)`));
  for (const t of times) {
    await ev(`new Promise(r => { const v = document.getElementById('v'); v.onseeked = () => requestAnimationFrame(() => requestAnimationFrame(r)); v.currentTime = ${t}; })`);
    fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
    const shot = await send('Page.captureScreenshot', { format: 'png' }), out = path.join(__dirname, 'shots', 'still_' + t + '.png');
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64')); console.log('  ' + out);
  }
  ws.close(); chrome.kill(); spawn('pkill', ['-f', 'user-data-dir=' + path.join(__dirname, '.chrome-stills')]); server.close(); setTimeout(() => process.exit(0), 300);
})();
