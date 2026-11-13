// clothworker.js — runs a Cloth in a Web Worker; driven by ClothAsync in cloth.js
// cloth.js is imported with this script's own query (e.g. ?v=b16), so a versioned worker never runs a stale cached solver;
// messages that arrive while it loads are queued
let Cloth = null, cloth = null; const queue = [];
onmessage = (e) => { if (Cloth) run(e.data); else queue.push(e.data); };
import('./cloth.js' + new URL(import.meta.url).search).then(m => { Cloth = m.Cloth; m.warmup(); queue.splice(0).forEach(run); }); // warmup: get the solver JIT-compiled before the first real garment arrives
function run(m) { try { handle(m); } catch (err) { postMessage({ type: 'error', message: String(err && err.stack || err) }); } }
function handle(m) {
  if (m.type === 'init') { cloth = new Cloth(m.mesh, m.params); return; }
  if (!cloth) return;
  if (m.type === 'reset') { cloth.resetColliders(m.colliders); cloth.resetPinTargets(m.pinTargets); for (let i = 0; i < m.settleSteps; i++) cloth.step(1 / 60); postMessage({ type: 'ready' }); }
  else if (m.type === 'params') Object.assign(cloth.params, m.params);
  else if (m.type === 'step') {
    cloth.setColliders(m.colliders); cloth.setPinTargets(m.pinTargets); cloth.step(m.dt);
    const positions = new Float32Array(cloth.positions), normals = new Float32Array(cloth.computeNormals()), colliders = new Float32Array(m.colliders);
    postMessage({ type: 'frame', positions, normals, colliders, stats: cloth.stats, time: cloth.time }, [positions.buffer, normals.buffer, colliders.buffer]);
  }
}
