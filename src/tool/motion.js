// motion.js — motion-quality, self-collision and camera checks (shared by tool/check.js; also runs standalone, body only):
//   arch -arm64 node tool/motion.js [--poem 0] [--seed 1] [--hz 120]
// Self-collision: body capsules (fitted to the figure's surface) posed over the whole song; any non-adjacent pair closer
//   than 0 is a collision, closer than the wanted clearance is reported.  Motion quality: per-joint angular velocity,
//   acceleration and jerk of the local bone rotations (face bones separate), plus stillness (frozen frames) and
//   stop-and-go (how often the whole body comes to rest).  Camera: eye speed, acceleration, FOV / zoom rate, shot
//   lengths, in-then-out reversals.
const F = require('../figure.js');
const LIM = { foreTorso: 0.035, body: { w: 3.0, a: 25, j: 500 }, hand: { w: 6.0, a: 60, j: 1500 }, root: { v: 0.15, a: 0.5 },
  cam: { v: 0.4, a: 0.4, fov: 2, zoom: 0.3, azr: 4, shot: 6 } };
const FACE = /^(jaw|tongue|lip|corner|cheek|brow|eye|lid)/;
const HAND = /^(index|middle|ring|pinky|thumb|hand)/;
function qlog(q) { const s = Math.hypot(q[0], q[1], q[2]), a = 2 * Math.atan2(s, Math.abs(q[3])) * (q[3] < 0 ? -1 : 1); return s < 1e-12 ? [0, 0, 0] : [q[0] / s * a, q[1] / s * a, q[2] / s * a]; }
function local(sk, W, i) { const b = sk.bones[i]; return b.parent < 0 ? W.q[i] : F.qmul(F.qconj(W.q[b.parent]), W.q[i]); }
function analyze(fig, perf, o) {
  o = o || {}; const hz = o.hz || 120, dt = 1 / hz, sk = fig.sk, nb = sk.bones.length, t0 = 0, t1 = perf.dur, out = { bones: [], self: {}, cam: {} };
  const caps = fig.caps || (fig.caps = F.buildCapsules(sk, fig.body));
  // --- per-joint angular kinematics ---
  const st = sk.bones.map(b => ({ name: b.name, w: 0, a: 0, j: 0, tw: 0, ta: 0, tj: 0 }));
  let prevQ = null, w1 = null, a1 = null, rootV = 0, rootA = 0, rp = null, rv = null, still = 0, n = 0, rests = 0, moving = false, selfMin = 1e9, selfAt = 0, selfPair = '', bad = [], clr = [], fmin = { d: 1e9, t: 0, pair: '' };
  const byName = {}; caps.forEach(c => { byName[c.name] = c; });
  for (let t = t0; t <= t1; t += dt) {
    const c = perf.controls(t), W = F.solve(sk, c), Q = [];
    for (let i = 0; i < nb; i++) Q.push(local(sk, W, i));
    if (prevQ) {
      const w = Q.map((q, i) => { const d = F.qmul(q, F.qconj(prevQ[i])); return qlog(d).map(x => x / dt); });
      let bodyMax = 0;
      for (let i = 0; i < nb; i++) {
        const s = st[i], wm = Math.hypot(...w[i]); if (wm > s.w) { s.w = wm; s.tw = t; }
        if (!FACE.test(s.name)) bodyMax = Math.max(bodyMax, wm);
        if (w1) { const a = w[i].map((x, k) => (x - w1[i][k]) / dt), am = Math.hypot(...a); if (am > s.a) { s.a = am; s.ta = t; }
          if (a1) { const jm = Math.hypot(...a.map((x, k) => (x - a1[i][k]) / dt)); if (jm > s.j) { s.j = jm; s.tj = t; } } a[i] = a; }
      }
      if (w1) a1 = w.map((x, i) => x.map((y, k) => (y - w1[i][k]) / dt));
      w1 = w; n++;
      if (bodyMax < 0.03) still++;
      if (bodyMax < 0.06 && moving) { rests++; moving = false; } else if (bodyMax > 0.2) moving = true;
    }
    prevQ = Q;
    const p = c.root; if (rp) { const v = p.map((x, k) => (x - rp[k]) / dt), vm = Math.hypot(...v); rootV = Math.max(rootV, vm); if (rv) rootA = Math.max(rootA, Math.hypot(...v.map((x, k) => (x - rv[k]) / dt))); rv = v; } rp = p;
    // self-collision at 30 Hz
    if (Math.round(t * hz) % Math.round(hz / 30) === 0) {
      const cp = F.poseCaps(caps, sk, W), by = {}; cp.forEach(x => { by[x.name] = x; });
      F.AVOID.forEach(q => {
        const A = by[q[0]], list = q[1] === 'torso' ? cp.filter(x => x.torso) : [by[q[1]]];
        list.forEach(B => { const d = F.capDist(A, B); if (d < selfMin) { selfMin = d; selfAt = t; selfPair = q[0] + '~' + B.name; }
          if (d < 0) bad.push([t, q[0] + '~' + B.name, d]); else if (d < q[2] * 0.5) clr.push([t, q[0] + '~' + B.name, d]);
          if (B.torso && /^(fore|hand)/.test(q[0]) && d < fmin.d) fmin = { d, t, pair: q[0] + '~' + B.name }; });
      });
    }
  }
  out.bones = st; out.stillFrac = still / n; out.rests = rests; out.restsPerMin = rests / (t1 / 60); out.rootV = rootV; out.rootA = rootA;
  out.self = { min: selfMin, at: selfAt, pair: selfPair, hits: bad, close: clr, fore: fmin };
  // --- camera ---
  if (perf.camera) {
    const eye = c => { const az = c.az * Math.PI / 180, el = c.el * Math.PI / 180; return [c.tgt[0] + c.dist * Math.sin(az) * Math.cos(el), c.tgt[1] + c.dist * Math.sin(el), c.tgt[2] + c.dist * Math.cos(az) * Math.cos(el)]; };
    let pe = null, pv = null, pc = null, vmax = 0, amax = 0, fmax = 0, zmax = 0, azmax = 0, tv = 0, ta = 0, zs = [];
    for (let t = 0; t <= t1; t += dt) {
      const c = perf.camera(t), e = eye(c), cut = (perf.camera.cuts || []).some(x => x > t - 3 * dt && x <= t);
      if (cut) { pe = null; pv = null; }   // clean cuts are allowed (counted below), not motion
      if (pe) { const v = e.map((x, k) => (x - pe[k]) / dt), vm = Math.hypot(...v); if (vm > vmax) { vmax = vm; tv = t; }
        if (pv) { const am = Math.hypot(...v.map((x, k) => (x - pv[k]) / dt)); if (am > amax) { amax = am; ta = t; } } pv = v;
        fmax = Math.max(fmax, Math.abs(c.fov - pc.fov) / dt); const zr = (c.dist - pc.dist) / dt; zmax = Math.max(zmax, Math.abs(zr)); azmax = Math.max(azmax, Math.abs(c.az - pc.az) / dt);
        if (Math.abs(zr) > 0.02) { const sg = Math.sign(zr); if (!zs.length || zs[zs.length - 1][1] !== sg) zs.push([t, sg]); } }
      pe = e; pc = c;
    }
    const shots = perf.camera.shots || [], lens = shots.map((s, i) => (i + 1 < shots.length ? shots[i + 1].t : t1) - s.t);
    let rev = 0; for (let i = 1; i < zs.length; i++) if (zs[i][0] - zs[i - 1][0] < 10) rev++;
    out.cam = { vmax, tv, amax, ta, fmax, zmax, azmax, shots: shots.length, cuts: (perf.camera.cuts || []).length, minShot: Math.min(...lens), reversals: rev };
  }
  return out;
}
function report(r, log) {
  const L = LIM, fails = [];
  const groups = { body: r.bones.filter(b => !FACE.test(b.name) && !HAND.test(b.name)), hand: r.bones.filter(b => HAND.test(b.name)), face: r.bones.filter(b => FACE.test(b.name)) };
  ['body', 'hand'].forEach(g => {
    const worst = k => groups[g].reduce((m, b) => b[k] > m[k] ? b : m, { [k]: 0 });
    const W = worst('w'), A = worst('a'), J = worst('j');
    const ok = W.w <= L[g].w && A.a <= L[g].a && J.j <= L[g].j; if (!ok) fails.push(g);
    log(`  ${g.padEnd(5)} joints: max ω ${W.w.toFixed(2)} rad/s (${W.name} @${W.tw.toFixed(2)}s; limit ${L[g].w})  α ${A.a.toFixed(1)} rad/s² (${A.name} @${A.ta.toFixed(2)}s; ${L[g].a})  jerk ${J.j.toFixed(0)} rad/s³ (${J.name} @${J.tj.toFixed(2)}s; ${L[g].j})  ${ok ? 'OK' : 'FAIL'}`);
  });
  const fw = groups.face.reduce((m, b) => Math.max(m, b.w), 0); log(`  face  joints (info, lip-sync): max ω ${fw.toFixed(1)} rad/s`);
  const okR = r.rootV <= L.root.v && r.rootA <= L.root.a; if (!okR) fails.push('root');
  log(`  root: max speed ${(r.rootV * 100).toFixed(1)} cm/s, accel ${r.rootA.toFixed(2)} m/s²  ${okR ? 'OK' : 'FAIL'}`);
  const dead = r.bones.filter(b => b.w < 0.02 && !/^(root|tongue|lip[UL]|eye[LR]|toe[LR]|corner[LR]|cheek[LR]|brow[LR]|thumb[123][LR])$/.test(b.name)).map(b => b.name), okS = r.stillFrac < 0.02 && r.restsPerMin < 2 && !dead.length; if (!okS) fails.push('stillness');
  log(`  every joint alive: ${dead.length ? 'FAIL — never move: ' + dead.join(', ') : 'OK (' + r.bones.length + ' bones; every rotating joint moves; lips, corners, cheeks and brows are translated; thumbs held still on request)'}`);
  log(`  life: frozen frames ${(r.stillFrac * 100).toFixed(1)}% (body ω < 0.03 rad/s), full stops ${r.rests} (${r.restsPerMin.toFixed(1)}/min)  ${okS ? 'OK' : 'FAIL'}`);
  const s = r.self, okC = !s.hits.length; if (!okC) fails.push('self-collision');
  const grp = {}; s.hits.forEach(h => { grp[h[1]] = grp[h[1]] || { n: 0, d: 0, t: h[0] }; grp[h[1]].n++; if (h[2] < grp[h[1]].d) { grp[h[1]].d = h[2]; grp[h[1]].t = h[0]; } });
  log(`  self-collision (capsules, 30 Hz): min clearance ${(s.min * 1000).toFixed(1)} mm (${s.pair} @${s.at.toFixed(2)}s), ${s.hits.length} colliding frames-pairs, ${s.close.length} under half the wanted clearance  ${okC ? 'OK' : 'FAIL'}`);
  Object.keys(grp).forEach(k => log(`    ${k}: ${grp[k].n} frames, worst ${(grp[k].d * 1000).toFixed(1)} mm @${grp[k].t.toFixed(2)}s`));
  const okF = s.fore.d >= L.foreTorso; if (!okF) fails.push('forearm-torso clearance');
  log(`  forearm / hand ↔ torso and bust (room for the dress): min ${(s.fore.d * 1000).toFixed(1)} mm (${s.fore.pair} @${s.fore.t.toFixed(2)}s; ≥ ${L.foreTorso * 1000} mm)  ${okF ? 'OK' : 'FAIL'}`);
  if (r.cam.shots != null) {
    const c = r.cam, C = L.cam, ok = c.vmax <= C.v && c.amax <= C.a && c.fmax <= C.fov && c.zmax <= C.zoom && c.azmax <= C.azr && c.minShot >= C.shot && !c.reversals; if (!ok) fails.push('camera');
    log(`  camera: eye speed ${c.vmax.toFixed(2)} m/s @${c.tv.toFixed(1)}s (≤${C.v}), accel ${c.amax.toFixed(2)} m/s² @${c.ta.toFixed(1)}s (≤${C.a}), fov rate ${c.fmax.toFixed(2)}°/s (≤${C.fov}), zoom ${c.zmax.toFixed(2)} m/s (≤${C.zoom}), orbit ${c.azmax.toFixed(2)}°/s (≤${C.azr}); ${c.shots} shots (${c.cuts} cuts), shortest ${c.minShot.toFixed(1)} s (≥${C.shot}), in-then-out reversals ${c.reversals}  ${ok ? 'OK' : 'FAIL'}`);
  }
  return fails;
}
module.exports = { analyze, report, LIM };
if (require.main === module) {
  const SING = require('../sing.js'), dict = require('../speech/mc_dict.json'), args = process.argv.slice(2), opt = { poem: 0, seed: 1, hz: 120 };
  for (let i = 0; i < args.length; i++) opt[args[i].replace(/^--/, '')] = +args[++i];
  const T = Date.now(), def = F.figFile(process.env.STYLE, require('path').join(__dirname, '..')).def; F.load(def);   // (STYLE=song: figure.song.json)
  const sk = F.Skeleton(def), body = F.buildBody(sk, { def }, () => {}), fig = { sk, body };
  const P = SING.POEMS[opt.poem], song = SING.compose(P.text, dict, { seed: opt.seed }), audio = SING.render(song, { voice: 'woman', seed: opt.seed });
  const perf = F.perform(song, audio.syls, { seed: opt.seed, fig });
  console.log(`motion: ${P.title}, ${perf.dur.toFixed(1)} s, ${perf.keys.length} key poses, built in ${((Date.now() - T) / 1000).toFixed(1)} s`);
  fig.caps.forEach(c => console.log(`  cap ${c.name.padEnd(8)} r ${(c.r * 1000).toFixed(0)} mm  len ${(Math.hypot(c.a[0] - c.b[0], c.a[1] - c.b[1], c.a[2] - c.b[2]) * 1000).toFixed(0)} mm`));
  const T2 = Date.now(), r = analyze(fig, perf, { hz: opt.hz }); console.log(`  analysed in ${((Date.now() - T2) / 1000).toFixed(1)} s`);
  const fails = report(r, console.log); console.log(fails.length ? 'motion: FAIL ' + fails.join(', ') : 'motion: OK');
}
