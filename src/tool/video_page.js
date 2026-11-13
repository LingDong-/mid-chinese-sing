// video_page.js — injected into stage.html?video by tool/video.js. Renders every frame offline (window.VIDEO.frame),
// encodes with WebCodecs (H.264 or VP9; AAC or Opus) and POSTs the encoded chunks to the Node server, which muxes them.
// Run as an expression: (opts) => Promise; opts = {fps, w, h, vcodec, acodec, vbitrate, abitrate, t0, t1, gop}
(async function (O) {
  const V = window.VIDEO, post = async (path, body, meta) => {   // chunk metadata travels in the body: [u32 json length][json][data]
    if (meta) { const j = new TextEncoder().encode(JSON.stringify(meta)), h = new Uint8Array(4); new DataView(h.buffer).setUint32(0, j.length); body = new Blob([h, j, body]); }
    const r = await fetch(path, { method: 'POST', body }); if (!r.ok) throw new Error('POST ' + path + ' ' + r.status); return r; };
  const log = s => post('/log', String(s));
  await document.fonts.load('40px "HanaMinA"', '渭城'); await document.fonts.load('20px "Source Code Pro"', 'kʰæk˥');
  // ---- audio: the whole band track, encoded up front ----
  const A = V.audio, sr = A.sr, nA = A.L.length;
  let aMeta = null, aBuf = [], aSize = 0;
  const flushA = async () => { if (!aBuf.length) return; const m = aBuf.map(c => c.m), b = new Blob(aBuf.map(c => c.d)); aBuf = []; aSize = 0; await post('/a', b, m); };
  const aenc = new AudioEncoder({ output: (ch, md) => { if (md && md.decoderConfig && !aMeta) aMeta = md.decoderConfig; const d = new Uint8Array(ch.byteLength); ch.copyTo(d); aBuf.push({ d, m: [ch.timestamp, ch.duration || 0, d.length] }); }, error: e => log('AUDIO ERROR ' + e) });
  aenc.configure({ codec: O.acodec, sampleRate: sr, numberOfChannels: 2, bitrate: O.abitrate });
  const t0s = Math.round((O.t0 || 0) * sr), t1s = O.t1 ? Math.min(nA, Math.round(O.t1 * sr)) : nA, BL = 4096;
  for (let i = t0s; i < t1s; i += BL) {
    const n = Math.min(BL, t1s - i), pl = new Float32Array(n * 2); pl.set(A.L.subarray(i, i + n), 0); pl.set(A.R.subarray(i, i + n), n);
    if (O.fade) for (let j = 0; j < n; j++) { const tt = (i + j - t0s) / sr, te = (t1s - i - j) / sr, gn = Math.min(1, tt / O.fade, te / O.fade); if (gn < 1) { pl[j] *= gn; pl[n + j] *= gn; } }   // fade in / out
    aenc.encode(new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i - t0s) / sr * 1e6), data: pl }));
  }
  await aenc.flush(); aenc.close();
  // encoder delay (AAC priming): decode the start again and find the lag against the source by cross-correlation
  let delay = 0;
  if (O.acodec.startsWith('mp4a')) {
    const out = [], chunks = aBuf.slice(0, 120), dec = new AudioDecoder({ output: d => { const f = new Float32Array(d.numberOfFrames); d.copyTo(f, { planeIndex: 0, format: 'f32-planar' }); out.push(f); d.close(); }, error: e => log('DEC ERROR ' + e) });
    dec.configure(aMeta); chunks.forEach(c => dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: c.m[0], duration: c.m[1], data: c.d }))); await dec.flush(); dec.close();
    const D = new Float32Array(out.reduce((s, f) => s + f.length, 0)); let o = 0; out.forEach(f => { D.set(f, o); o += f.length; });
    // compare over a stretch with signal (the first second that is not silent)
    let st = t0s; while (st < t1s - sr && Math.abs(A.L[st]) < 1e-3) st++; const len = Math.min(sr, D.length - (st - t0s) - 5000);
    let best = 0, bv = -1e9; for (let lag = 0; lag <= 4096; lag++) { let s = 0; for (let j = 0; j < len; j += 2) s += A.L[st + j] * (D[st - t0s + j + lag] || 0); if (s > bv) { bv = s; best = lag; } }
    delay = best;
  }
  await flushA();
  let fs0 = t0s; while (fs0 < t1s && Math.abs(A.L[fs0]) < 1e-3) fs0++;
  log('source audio: first sound at ' + ((fs0 - t0s) / sr).toFixed(3) + ' s (video time)');
  await post('/meta', JSON.stringify({ audio: { codec: O.acodec, sr, ch: 2, delay, srcLen: t1s - t0s, description: aMeta && aMeta.description ? Array.from(new Uint8Array(aMeta.description)) : null } }));
  log('audio encoded: ' + (t1s - t0s) + ' samples at ' + sr + ' Hz, encoder delay ' + delay + ' samples');
  // ---- video ----
    // through the end of the audio (the band's last notes ring on)
  const fps = O.fps, N = Math.round(((O.t1 || Math.max(V.dur, nA / sr)) - (O.t0 || 0)) * fps), cv = document.createElement('canvas'); cv.width = O.w; cv.height = O.h;
  const g = cv.getContext('2d', { alpha: false });
  let vMeta = null, vBuf = [], vSize = 0, sent = 0;
  const flushV = async () => { if (!vBuf.length) return; const m = vBuf.map(c => c.m), b = new Blob(vBuf.map(c => c.d)); vBuf = []; vSize = 0; await post('/v', b, m); };
  const venc = new VideoEncoder({ output: (ch, md) => { if (md && md.decoderConfig && !vMeta) vMeta = md.decoderConfig; const d = new Uint8Array(ch.byteLength); ch.copyTo(d); vBuf.push({ d, m: [ch.timestamp, ch.duration || 0, d.length, ch.type === 'key' ? 1 : 0] }); vSize += d.length; }, error: e => log('VIDEO ERROR ' + e) });
  const vcfg = { codec: O.vcodec, width: O.w, height: O.h, bitrate: O.vbitrate, framerate: fps, latencyMode: 'quality', bitrateMode: 'variable' };
  if (O.vcodec.startsWith('avc1')) vcfg.avc = { format: 'avc' };
  venc.configure(vcfg);
  const T0 = performance.now();
  for (let n = 0; n < N; n++) {
    const t = (O.t0 || 0) + n / fps;
    V.frame(t, g, O.w, O.h);
    if (O.fade) { const a = 1 - Math.min(1, (n + 0.5) / fps / O.fade, (N - n - 0.5) / fps / O.fade); if (a > 0) { g.fillStyle = 'rgba(0,0,0,' + a + ')'; g.fillRect(0, 0, O.w, O.h); } }   // fade from / to black
    const vf = new VideoFrame(cv, { timestamp: Math.round(n * 1e6 / fps), duration: Math.round(1e6 / fps) });
    venc.encode(vf, { keyFrame: n % (O.gop || fps * 2) === 0 }); vf.close();
    while (venc.encodeQueueSize > 2) await new Promise(r => setTimeout(r, 1));
    if (vSize > 4e6) await flushV();
    if (n % fps === 0) { const el = (performance.now() - T0) / 1000; log('frame ' + n + '/' + N + ' (t=' + t.toFixed(1) + ' s) ' + el.toFixed(0) + ' s elapsed, ~' + (el / (n + 1) * (N - n - 1) / 60).toFixed(1) + ' min left'); }
  }
  await venc.flush(); venc.close(); await flushV();
  await post('/meta', JSON.stringify({ video: { codec: O.vcodec, w: O.w, h: O.h, fps, frames: N, description: vMeta && vMeta.description ? Array.from(new Uint8Array(vMeta.description)) : null, colorSpace: vMeta && vMeta.colorSpace } }));
  await post('/done', 'ok');
  return 'ok';
})
