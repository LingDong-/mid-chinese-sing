// demo.js — capsule rig + garment + WebGL2 renderer. URL params: ?garment=skirt&motion=walk&self=0&spacing=0.025&substeps=16
import { Cloth, ClothAsync, warmup } from './cloth.js';
import { Body, m4, motionNames } from './body.js';
import { makeGarment, garmentNames } from './garments.js';

const q = new URLSearchParams(location.search);
const state = { garment: q.get('garment') || 'dress', motion: q.get('motion') || 'walk', self: q.get('self') !== '0', wire: q.get('wire') === '1', showBody: q.get('body') !== '0',
  spacing: +(q.get('spacing') || 0.025), bust: q.get('bust') === '1', worker: q.get('worker') === '1', paused: false, speed: +(q.get('speed') || 1), strobe: +(q.get('strobe') || 0) };
let ghosts = [], ghostAt = 0;
// solver overrides from the url, e.g. ?bend=0.05&substeps=12 (keys as in cloth.js defaultParams, plus short aliases)
const alias = { bend: 'bendCompliance', comp: 'compressionStiffness', stretch: 'stretchCompliance', shear: 'shearCompliance', mu: 'friction', th: 'thickness' };
const overrides = {}; for (const [k, v] of q) { const key = alias[k] || k; if (['substeps', 'gravity', 'density', 'stretchCompliance', 'shearCompliance', 'bendCompliance', 'thickness', 'friction', 'damping', 'selfRadius', 'compressionStiffness', 'noise', 'ground'].includes(key)) overrides[key] = +v; }
if (overrides.ground === undefined) overrides.ground = 0;
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2', { antialias: true });
let body = new Body({ bust: q.get('bust') === '1' });
let cloth, mesh, pinTargets, time = 0, ramp = 0, renderCaps = null;

// ---------- sim setup ----------
function build() {
  if (body.bust !== state.bust) body = new Body({ bust: state.bust });
  body.pose(0, 'static');
  mesh = makeGarment(state.garment, body, state.spacing);
  if (cloth && cloth.dispose) cloth.dispose();
  const params = Object.assign({ selfCollision: state.self }, overrides);
  pinTargets = body.pinTargets(mesh.pins);
  if (state.worker) { cloth = new ClothAsync(mesh, params); cloth.reset(body.capsules, pinTargets, 30); renderCaps = new Float32Array(body.capsules); }
  else { cloth = new Cloth(mesh, params); cloth.resetColliders(body.capsules); cloth.resetPinTargets(pinTargets); for (let i = 0; i < 30; i++) cloth.step(1 / 60); } // settle on the static body
  time = 0; ramp = 0;
  clothBuffers.index(cloth.indices);
  ghosts = []; for (let k = 0; k < state.strobe; k++) ghosts.push(new Float32Array(cloth.positions)); ghostAt = 0;
}
function simFrame(dt) {
  if (state.worker && !cloth.ready) { body.pose(0, state.motion, 0); return; } // wait for the worker to finish building/settling
  ramp = Math.min(1, ramp + dt / 1.2);           // ease from rest pose into the motion
  const w = ramp * ramp * (3 - 2 * ramp);
  body.pose(time, state.motion, w);
  time += dt;
  body.pinTargets(mesh.pins, pinTargets);
  if (state.worker) { cloth.update(dt, body.capsules, pinTargets); if (cloth.renderColliders) renderCaps = cloth.renderColliders; }
  else { cloth.setColliders(body.capsules); cloth.setPinTargets(pinTargets); cloth.step(dt); }
}

// ---------- renderer ----------
const VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm;
uniform mat4 uProj, uView, uModel; uniform mat3 uNrm;
out vec3 vN; out vec3 vP;
void main() { vec4 wp = uModel * vec4(aPos, 1.0); vP = wp.xyz; vN = uNrm * aNrm; gl_Position = uProj * uView * wp; }`;
const FS = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vP; uniform vec3 uColor; uniform vec3 uEye; uniform int uMode; uniform int uTwoSided;
out vec4 o;
void main() {
  vec3 n = normalize(vN); if (uTwoSided == 1 && !gl_FrontFacing) n = -n;
  vec3 L = normalize(vec3(0.5, 0.9, 0.6));
  float diff = max(dot(n, L), 0.0), hemi = 0.5 + 0.5 * n.y;
  vec3 v = normalize(uEye - vP);
  vec3 col;
  if (uTwoSided == 1) { // fabric: soft wrapped diffuse, broad low sheen, slight fresnel (silk-like, not plastic)
    float wrap = max(0.0, (dot(n, L) + 0.4) / 1.4);
    float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    float sheen = pow(max(dot(normalize(L + v), n), 0.0), 12.0) * 0.08;
    col = uColor * (0.3 + 0.2 * hemi + 0.55 * wrap) + vec3(0.18) * fres * (0.4 + 0.6 * diff) + sheen;
  } else {
    col = uColor * (0.35 + 0.25 * hemi + 0.5 * diff);
    col += pow(max(dot(normalize(L + v), n), 0.0), 40.0) * 0.12;
  }
  if (uMode == 1) { // ground grid
    vec2 g = abs(fract(vP.xz * 2.0 - 0.5) - 0.5) / fwidth(vP.xz * 2.0); float line = 1.0 - min(min(g.x, g.y), 1.0);
    float fade = exp(-0.08 * dot(vP.xz, vP.xz)); col = mix(uColor, uColor * 0.85, line * fade); }
  if (uMode == 2) col = uColor;
  o = vec4(col, 1.0);
}`;
function program(vs, fs) {
  const p = gl.createProgram();
  for (const [t, s] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); gl.attachShader(p, sh); }
  gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {}; for (const n of ['uProj', 'uView', 'uModel', 'uNrm', 'uColor', 'uEye', 'uMode', 'uTwoSided']) u[n] = gl.getUniformLocation(p, n);
  return { p, u };
}
const prog = program(VS, FS);
function makeVAO(pos, nrm, idx, dynamic = false) {
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const pb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.bufferData(gl.ARRAY_BUFFER, pos, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  const nb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, nb); gl.bufferData(gl.ARRAY_BUFFER, nrm, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
  const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, pb, nb, ib, count: idx.length, type: idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
}
// unit sphere & unit cylinder (y axis, -0.5..0.5)
function sphere(seg = 24, rings = 16) {
  const pos = [], nrm = [], idx = [];
  for (let j = 0; j <= rings; j++) { const t = j / rings * Math.PI, y = Math.cos(t), r = Math.sin(t); for (let i = 0; i <= seg; i++) { const a = i / seg * 2 * Math.PI; pos.push(r * Math.sin(a), y, r * Math.cos(a)); nrm.push(r * Math.sin(a), y, r * Math.cos(a)); } }
  for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) { const a = j * (seg + 1) + i, b = a + seg + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  return makeVAO(new Float32Array(pos), new Float32Array(nrm), new Uint16Array(idx));
}
function cylinder(seg = 24) {
  const pos = [], nrm = [], idx = [];
  for (let i = 0; i <= seg; i++) { const a = i / seg * 2 * Math.PI, x = Math.sin(a), z = Math.cos(a); pos.push(x, -0.5, z, x, 0.5, z); nrm.push(x, 0, z, x, 0, z); }
  for (let i = 0; i < seg; i++) { const a = 2 * i; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  return makeVAO(new Float32Array(pos), new Float32Array(nrm), new Uint16Array(idx));
}
const sph = sphere(), cyl = cylinder();
const ground = makeVAO(new Float32Array([-20, 0, -20, 20, 0, -20, 20, 0, 20, -20, 0, 20]), new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), new Uint16Array([0, 2, 1, 0, 3, 2]));
const clothBuffers = (() => {
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const pb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  const nb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, nb); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
  const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bindVertexArray(null);
  const wireVao = gl.createVertexArray(); gl.bindVertexArray(wireVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, nb); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
  const wib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wib); gl.bindVertexArray(null);
  let count = 0, wcount = 0;
  return {
    index(idx) { gl.bindVertexArray(vao); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW); gl.bindVertexArray(null); count = idx.length;
      const e = new Set(), w = []; for (let t = 0; t < idx.length; t += 3) for (let k = 0; k < 3; k++) { const a = idx[t + k], b = idx[t + (k + 1) % 3], key = a < b ? a * 1e6 + b : b * 1e6 + a; if (!e.has(key)) { e.add(key); w.push(a, b); } }
      gl.bindVertexArray(wireVao); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(w), gl.STATIC_DRAW); gl.bindVertexArray(null); wcount = w.length; },
    upload(pos, nrm) { gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW); gl.bindBuffer(gl.ARRAY_BUFFER, nb); gl.bufferData(gl.ARRAY_BUFFER, nrm, gl.DYNAMIC_DRAW); },
    draw(wire) { if (wire) { gl.bindVertexArray(wireVao); gl.drawElements(gl.LINES, wcount, gl.UNSIGNED_INT, 0); } else { gl.bindVertexArray(vao); gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, 0); } gl.bindVertexArray(null); },
  };
})();

const cam = { yaw: +(q.get('yaw') || 0.6), pitch: +(q.get('pitch') || 0.25), dist: +(q.get('dist') || 3.6), ty: +(q.get('ty') || 0.9), target: [0, 0.9, 0], eye: [0, 0, 0] };
canvas.addEventListener('mousedown', e => { const sx = e.clientX, sy = e.clientY, y0 = cam.yaw, p0 = cam.pitch; const mv = ev => { cam.yaw = y0 + (ev.clientX - sx) * 0.006; cam.pitch = Math.max(-1.3, Math.min(1.3, p0 + (ev.clientY - sy) * 0.006)); }; const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); }; window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up); });
canvas.addEventListener('wheel', e => { cam.dist = Math.max(1, Math.min(10, cam.dist * Math.exp(e.deltaY * 0.001))); e.preventDefault(); }, { passive: false });
const nrmMat = (m) => new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]); // rigid: upper 3x3 (uniform scale ok for spheres)
function setModel(m) { gl.uniformMatrix4fv(prog.u.uModel, false, m); gl.uniformMatrix3fv(prog.u.uNrm, false, nrmMat(m)); }
function drawMesh(mesh, model, color, mode = 0) { setModel(model); gl.uniform3fv(prog.u.uColor, color); gl.uniform1i(prog.u.uMode, mode); gl.bindVertexArray(mesh.vao); gl.drawElements(gl.TRIANGLES, mesh.count, mesh.type, 0); gl.bindVertexArray(null); }
function render() {
  const w = canvas.clientWidth * devicePixelRatio | 0, h = canvas.clientHeight * devicePixelRatio | 0;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  gl.viewport(0, 0, w, h); gl.clearColor(0.925, 0.925, 0.918, 1); gl.enable(gl.DEPTH_TEST); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  // camera follows the hips
  const hip = body.bones[0].world; for (let i = 0; i < 3; i++) cam.target[i] += (([hip[12], cam.ty, hip[14]][i]) - cam.target[i]) * 0.08;
  cam.eye = [cam.target[0] + cam.dist * Math.cos(cam.pitch) * Math.sin(cam.yaw), cam.target[1] + cam.dist * Math.sin(cam.pitch), cam.target[2] + cam.dist * Math.cos(cam.pitch) * Math.cos(cam.yaw)];
  gl.useProgram(prog.p);
  gl.uniformMatrix4fv(prog.u.uProj, false, m4.perspective(0.8, w / h, 0.05, 100)); gl.uniformMatrix4fv(prog.u.uView, false, m4.lookAt(cam.eye, cam.target, [0, 1, 0])); gl.uniform3fv(prog.u.uEye, cam.eye);
  gl.uniform1i(prog.u.uTwoSided, 0);
  drawMesh(ground, m4.identity(), [0.9, 0.9, 0.89], 1);
  if (state.showBody) {
    const C = state.worker && renderCaps ? renderCaps : body.capsules, skin = [0.78, 0.66, 0.58]; // with the worker, draw the pose the cloth was computed for
    for (let c = 0; c < C.length; c += 7) {
      const a = [C[c], C[c + 1], C[c + 2]], b = [C[c + 3], C[c + 4], C[c + 5]], r = C[c + 6];
      drawMesh(sph, m4.mul(m4.translation(...a), m4.scale(r, r, r)), skin); drawMesh(sph, m4.mul(m4.translation(...b), m4.scale(r, r, r)), skin);
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], len = Math.hypot(...d);
      if (len > 1e-4) { // rotate y axis onto d
        const y = d.map(v => v / len), ref = Math.abs(y[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        const x = norm(cross(ref, y)), z = cross(y, x);
        const R = new Float32Array([x[0] * r, x[1] * r, x[2] * r, 0, y[0] * len, y[1] * len, y[2] * len, 0, z[0] * r, z[1] * r, z[2] * r, 0, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, 1]);
        setModel(R); gl.uniformMatrix3fv(prog.u.uNrm, false, new Float32Array([x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]])); gl.uniform3fv(prog.u.uColor, skin); gl.uniform1i(prog.u.uMode, 0);
        gl.bindVertexArray(cyl.vao); gl.drawElements(gl.TRIANGLES, cyl.count, cyl.type, 0); gl.bindVertexArray(null);
      }
    }
  }
  cloth.computeNormals(); gl.uniform1i(prog.u.uTwoSided, 1);
  if (state.strobe) { // ghost wireframes of the previous frames (temporal smoothness check)
    for (let k = 0; k < ghosts.length; k++) { clothBuffers.upload(ghosts[(ghostAt + k) % ghosts.length], cloth.normals); const sh = 0.75 - 0.5 * k / ghosts.length; setModel(m4.identity()); gl.uniform3fv(prog.u.uColor, [sh, sh, sh]); gl.uniform1i(prog.u.uMode, 2); clothBuffers.draw(true); }
    ghosts[ghostAt].set(cloth.positions); ghostAt = (ghostAt + 1) % ghosts.length;
  }
  clothBuffers.upload(cloth.positions, cloth.normals);
  setModel(m4.identity()); gl.uniform3fv(prog.u.uColor, [0.33, 0.40, 0.58]); gl.uniform1i(prog.u.uMode, 0);
  clothBuffers.draw(false);
  if (state.wire) { gl.uniform3fv(prog.u.uColor, [0.1, 0.1, 0.12]); gl.uniform1i(prog.u.uMode, 2); gl.enable(gl.POLYGON_OFFSET_FILL); gl.depthFunc(gl.LEQUAL); clothBuffers.draw(true); gl.depthFunc(gl.LESS); }
}
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(...a) || 1; return a.map(v => v / l); }

// ---------- ui ----------
const $ = id => document.getElementById(id);
for (const [id, names, key] of [['garment', garmentNames, 'garment'], ['motion', motionNames, 'motion']]) {
  const sel = $(id); for (const n of names) { const o = document.createElement('option'); o.value = o.textContent = n; sel.appendChild(o); } sel.value = state[key];
  sel.onchange = () => { state[key] = sel.value; if (key === 'garment') build(); else { time = 0; ramp = 0; } };
}
$('self').checked = state.self; $('self').onchange = e => { state.self = e.target.checked; if (cloth.setParams) cloth.setParams({ selfCollision: state.self }); else cloth.params.selfCollision = state.self; };
$('worker').checked = state.worker; $('worker').onchange = e => { state.worker = e.target.checked; build(); };
$('wire').checked = state.wire; $('wire').onchange = e => state.wire = e.target.checked;
$('bust').checked = state.bust; $('bust').onchange = e => { state.bust = e.target.checked; build(); };
$('showBody').checked = state.showBody; $('showBody').onchange = e => state.showBody = e.target.checked;
$('pause').onclick = () => { state.paused = !state.paused; $('pause').textContent = state.paused ? 'play' : 'pause'; };
$('reset').onclick = build;
window.addEventListener('keydown', e => { if (e.key === ' ') $('pause').click(); });

// ---------- loop ----------
const stats = window.stats = { fps: 0, simMs: 0, frameMs: 0, n: 0, tris: 0, contacts: 0, meanSpeed: 0, maxPen: 0, frames: 0, time: 0 };
let last = performance.now(), fpsAcc = 0, fpsN = 0;
let prevVel = null, prevVel2 = null, prevAcc = null, prevPos = null, velBuf = null, wBuf = null;
function measure() {
  const x = cloth.positions; let v = cloth.vel, w = cloth.invMass; let sp = 0, cnt = 0, jit = 0;
  if (!v) { // async: derive velocities from successive positions
    if (!velBuf || velBuf.length !== x.length) { velBuf = new Float32Array(x.length); prevPos = new Float32Array(x); wBuf = new Float32Array(cloth.n).fill(1); for (const p of cloth.pins) wBuf[p.i] = 0; }
    for (let i = 0; i < x.length; i++) velBuf[i] = (x[i] - prevPos[i]) * 60; prevPos.set(x); v = velBuf; w = wBuf;
  }
  if (!prevVel || prevVel.length !== v.length) { prevVel = new Float32Array(v); prevVel2 = new Float32Array(v); }
  for (let i = 0; i < cloth.n; i++) if (w[i] > 0) { sp += Math.hypot(v[3 * i], v[3 * i + 1], v[3 * i + 2]); jit += Math.hypot(v[3 * i] - prevVel[3 * i], v[3 * i + 1] - prevVel[3 * i + 1], v[3 * i + 2] - prevVel[3 * i + 2]); cnt++; }
  prevVel.set(v);
  stats.meanSpeed = cnt ? sp / cnt : 0;
  stats.jitter = cnt ? jit / cnt / 60 : 0; // mean per-frame velocity change expressed as a position delta (m)
  stats.jitterAvg = stats.jitterAvg === undefined ? stats.jitter : stats.jitterAvg + (stats.jitter - stats.jitterAvg) * 0.1;
  // deepest penetration of any vertex into any capsule (positive = inside the skin)
  const C = cloth.colliders || cloth.renderColliders || body.capsules; let pen = -1, pi = -1, pc = -1;
  for (let i = 0; i < cloth.n; i++) for (let c = 0; c < C.length; c += 7) {
    const ax = C[c], ay = C[c + 1], az = C[c + 2], bx = C[c + 3] - ax, by = C[c + 4] - ay, bz = C[c + 5] - az;
    let t = ((x[3 * i] - ax) * bx + (x[3 * i + 1] - ay) * by + (x[3 * i + 2] - az) * bz) / (bx * bx + by * by + bz * bz + 1e-12); t = Math.min(1, Math.max(0, t));
    const p = C[c + 6] - Math.hypot(x[3 * i] - ax - bx * t, x[3 * i + 1] - ay - by * t, x[3 * i + 2] - az - bz * t);
    if (p > pen) { pen = p; pi = i; pc = c / 7; }
  }
  stats.maxPen = pen;
  if (pen > 0.005) { const info = `t=${time.toFixed(2)} v${pi} pinned=${w[pi] === 0} cap=${pc}(${body.caps[pc] && body.bones[body.caps[pc].bone].name}) ${(pen * 1000).toFixed(0)}mm`; (stats.penLog = stats.penLog || []).push(info); if (stats.penLog.length > 40) stats.penLog.shift(); }
  // flicker: mean third difference of positions (alternating-sign jitter shows up here, smooth acceleration does not)
  if (!prevAcc || prevAcc.length !== v.length) prevAcc = new Float32Array(3 * cloth.n);
  let fl = 0; for (let i = 0; i < cloth.n; i++) if (w[i] > 0) { for (let k = 0; k < 3; k++) { const a = v[3 * i + k] - prevVel2[3 * i + k]; fl += Math.abs(a - prevAcc[3 * i + k]); prevAcc[3 * i + k] = a; } }
  stats.flicker = cnt ? fl / cnt / 60 / 3 : 0; stats.flickerAvg = stats.flickerAvg === undefined ? stats.flicker : stats.flickerAvg + (stats.flicker - stats.flickerAvg) * 0.1;
  prevVel2.set(v);
}
function frame() {
  try { frameInner(); } catch (e) { console.error(e.stack || e); $('stats').textContent = String(e.stack || e); return; }
  requestAnimationFrame(frame);
}
function frameInner() {
  const now = performance.now(), real = (now - last) / 1000; last = now;
  const t0 = performance.now();
  if (!state.paused) { simFrame(state.speed / 60); stats.simMs += (cloth.stats.ms - stats.simMs) * 0.1; }
  render();
  stats.frameMs += (performance.now() - t0 - stats.frameMs) * 0.1;
  fpsAcc += real; fpsN++; if (fpsAcc > 0.5) { stats.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
  stats.n = cloth.n; stats.tris = cloth.indices.length / 3; stats.contacts = cloth.stats.contacts; stats.frames++; stats.time = time;
  measure();
  if (stats.frames % 15 === 0) { $('stats').textContent = `${state.garment}: ${cloth.n} particles, ${stats.tris} tris${cloth.nBend ? `, ${cloth.stretchIdx.length / 2 + cloth.shearIdx.length / 2} edges, ${cloth.nBend} hinges` : ' (worker)'}\nsim ${stats.simMs.toFixed(1)} ms  frame ${stats.frameMs.toFixed(1)} ms  ${stats.fps.toFixed(0)} fps  contacts ${stats.contacts.toFixed(0)}\nmean speed ${(stats.meanSpeed * 100).toFixed(1)} cm/s  jitter ${(stats.jitterAvg * 1000).toFixed(2)} mm  flicker ${(stats.flickerAvg * 1000).toFixed(2)} mm  max penetration ${(stats.maxPen * 1000).toFixed(1)} mm`; }
}
{ const t = performance.now(); warmup(); stats.warmupMs = performance.now() - t; build(); stats.buildMs = performance.now() - t - stats.warmupMs; }
window.app = { get cloth() { return cloth; }, get body() { return body; }, state, build, measure };
requestAnimationFrame(frame);
