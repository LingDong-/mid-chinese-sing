/* stage.js — WebGL2 renderer, audio and UI for the Tang singer (figure.js builds and animates her from figure.json).
   Audio is pluggable: SING.render (voice + 簫/琵琶/拍板) or BAND.render (band.js, full ensemble), or window.STAGE_AUDIO.
   URL params: ?shot (no UI/audio; render one frame at t) &t=12.3 &cam=full|medium|face|hands|hair|neck|auto &az= &el= &dist= &fov=
               &shawl=file|0 (the drawn 帔帛: default shawl.<style>.json if present, else the built-in; 0 = the older path) &cloth=old (the older verlet cloth, both styles) &tx,ty,tz (look-at) &poem=i &seed=n &style=tang|song (loads figure.<style>.json; &fig=file loads another) &headdress=baijiao|zhucui|gele &band (full band) &head (head only) &only=skirt,band,… / &hide=… (show only / hide these garment pieces)
   ?video (tool/video.js): offline frames through window.VIDEO; &ss=2 supersampling, &shadow=4096, &msaa=8, &cloth=full,
               &simhz=240 &iters=2 (cloth), &res= &fine= (body mesh)
   window.STAGE.shot({t, cam, …, jit, id}) re-renders without rebuilding (tool/shoot.js); id: object-id image for the jitter test.
   With window.STAGE_EDITOR set (edit.html) only the renderer is set up and exposed as window.STAGE_API. */
(function () {
'use strict';
var Q = {}; location.search.slice(1).split('&').forEach(function (kv) { if (!kv) return; var p = kv.split('='); Q[decodeURIComponent(p[0])] = p.length > 1 ? decodeURIComponent(p[1]) : '1'; });
var VIDEO = 'video' in Q, SHOT = 'shot' in Q || VIDEO;
var STYLE = Q.style === 'song' ? 'song' : 'tang', COST = Q.costume || STYLE;
// &only=a,b (show only these garment pieces) / &hide=a,b (hide these): any garment part — cloths (skirt, robeFL, sleeveL, sashL,
// ribbonL, …) and the skinned / rigid garment parts (band, belt, sashKnot); the body, hair and ornaments are always shown
// (group names expand to their pieces; the list of names present is printed in the console on load and returned by STAGE.garments())
var GARMENT = /^(band|belt|sashKnot|jadeRing|shoeL|shoeR)$/, GARMENTS = [];
var GROUPS = { robe: ['robeFL', 'robeFR', 'robeB', 'yokeL', 'yokeR'], yoke: ['yokeL', 'yokeR'], sleeves: ['sleeveL', 'sleeveR'], sash: ['sashL', 'sashR', 'sashKnot'],
  ribbons: ['ribbonL', 'ribbonR'], shoes: ['shoeL', 'shoeR'], beizi: ['robeFL', 'robeFR', 'robeB', 'yokeL', 'yokeR', 'sleeveL', 'sleeveR'], moxiong: ['band'], collar: ['band'] };
GROUPS['褙子'] = GROUPS.beizi; GROUPS['抹胸'] = GROUPS.moxiong; GROUPS['裙'] = ['skirt', 'band']; GROUPS['衫'] = ['robeFL', 'robeFR', 'robeB', 'sleeveL', 'sleeveR']; GROUPS['帔帛'] = ['shawl']; GROUPS['裙帶'] = GROUPS.sash;
function nameList(q) { var out = []; (q || '').split(',').forEach(function (n) { n = n.trim(); if (n) out = out.concat(GROUPS[n] || [n]); }); return out; }
function shown(name) { if (Q.only && nameList(Q.only).indexOf(name) < 0) return false; if (Q.hide && nameList(Q.hide).indexOf(name) >= 0) return false; return true; }
function vis(it) { return !it.garment || shown(it.garment); }   // ?style=song: the Song (宋) costume, makeup and dance
if (SHOT) document.body.className = 'shot';
var $ = function (id) { return document.getElementById(id); };
var canvas = $('c'), gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
if (!gl) { $('status').textContent = 'WebGL2 not available'; return; }
gl.getExtension('EXT_color_buffer_float'); gl.getExtension('OES_texture_float_linear');
var V = FIG.v3, status = function (s) { $('status').textContent = s; if (SHOT) console.log(s); };

/* ================= GL helpers ================= */
function shader(type, src) {
  var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { var log = gl.getShaderInfoLog(s); console.error(log + '\n' + src.split('\n').map(function (l, i) { return (i + 1) + ': ' + l; }).join('\n')); throw new Error(log); }
  return s;
}
function program(vs, fs, defs) {
  var head = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2DShadow;\n' + (defs || []).map(function (d) { return '#define ' + d + '\n'; }).join('');
  var p = gl.createProgram(); gl.attachShader(p, shader(gl.VERTEX_SHADER, head + vs)); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, head + fs)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (var i = 0; i < n; i++) { var info = gl.getActiveUniform(p, i), name = info.name.replace(/\[0\]$/, ''); u[name] = gl.getUniformLocation(p, info.name); }
  return { p: p, u: u };
}
function tex2D(w, h, ifmt, fmt, type, data, filt, wrap) {
  var t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, data || null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt || gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt === gl.LINEAR_MIPMAP_LINEAR ? gl.LINEAR : (filt || gl.LINEAR));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap || gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap || gl.CLAMP_TO_EDGE);
  return t;
}
function fbo(color, depth) {
  var f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  if (color) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
  if (depth) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
  return f;
}
// a mesh: {pos, nrm, idx, bi?, bw?, aux?, uv?, tan?}; dynamic meshes re-upload pos/nrm
function upload(m, dynamic) {
  var vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  function buf(loc, data, size, type, integer, usage) {
    var b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, usage || gl.STATIC_DRAW); gl.enableVertexAttribArray(loc);
    if (integer) gl.vertexAttribIPointer(loc, size, type, 0, 0); else gl.vertexAttribPointer(loc, size, type, false, 0, 0);
    return b;
  }
  var nv = m.pos.length / 3, g = { vao: vao, n: m.idx.length, nv: nv };
  g.pb = buf(0, m.pos, 3, gl.FLOAT, false, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
  g.nb = buf(1, m.nrm, 3, gl.FLOAT, false, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
  buf(2, m.bi || new Uint8Array(nv * 4).fill(m.bone || 0), 4, gl.UNSIGNED_BYTE, true);
  var bw = m.bw; if (!bw) { bw = new Float32Array(nv * 4); for (var i = 0; i < nv; i++) bw[i * 4] = 1; }
  buf(3, bw, 4, gl.FLOAT);
  buf(4, m.aux || new Float32Array(nv * 4).fill(1), 4, gl.FLOAT);
  buf(5, m.uv || new Float32Array(nv * 4), 4, gl.FLOAT, false, dynamic && m.uvDyn ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
  var ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW);
  g.it = m.pos.length / 3 > 65535 || m.idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
  if (g.it === gl.UNSIGNED_SHORT && !(m.idx instanceof Uint16Array)) gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(m.idx), gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  g.update = function (pos, nrm) { gl.bindBuffer(gl.ARRAY_BUFFER, g.pb); gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos); gl.bindBuffer(gl.ARRAY_BUFFER, g.nb); gl.bufferSubData(gl.ARRAY_BUFFER, 0, nrm); };
  return g;
}
function draw(g) { gl.bindVertexArray(g.vao); gl.drawElements(gl.TRIANGLES, g.n, g.it, 0); }

/* ================= matrices ================= */
function persp(fovy, asp, n, f) { var t = 1 / Math.tan(fovy / 2); return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]; }
function lookAt(e, c, up) {
  var z = V.norm(V.sub(e, c)), x = V.norm(V.cross(up, z)), y = V.cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -V.dot(x, e), -V.dot(y, e), -V.dot(z, e), 1];
}
function mmul(a, b) { var r = new Array(16); for (var i = 0; i < 4; i++) for (var j = 0; j < 4; j++) { var s = 0; for (var k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]; r[i * 4 + j] = s; } return r; }

/* ================= shaders ================= */
var NB = 72;
var VS = `
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm; layout(location=2) in uvec4 aBi; layout(location=3) in vec4 aBw; layout(location=4) in vec4 aAux; layout(location=5) in vec4 aUV;
uniform vec4 uDQ[${NB * 2}]; uniform mat4 uVP; uniform int uWorld; uniform vec2 uJit; uniform int uHeatBone; out float vHeat;
out vec3 vW; out vec3 vN; out vec3 vB; out vec4 vAux; out vec4 vUV; out vec3 vVb; out vec3 vT;
uniform vec3 uCamV;
void main() {
  vec3 p = aPos, n = aNrm; vec4 rr = vec4(0.0, 0.0, 0.0, 1.0);
  if (uWorld == 0) {
    vec4 r0 = uDQ[aBi.x * 2u], r = r0 * aBw.x, d = uDQ[aBi.x * 2u + 1u] * aBw.x;
    if (aBw.y > 0.0) { vec4 q = uDQ[aBi.y * 2u]; float s = dot(q, r0) < 0.0 ? -aBw.y : aBw.y; r += q * s; d += uDQ[aBi.y * 2u + 1u] * s; }
    if (aBw.z > 0.0) { vec4 q = uDQ[aBi.z * 2u]; float s = dot(q, r0) < 0.0 ? -aBw.z : aBw.z; r += q * s; d += uDQ[aBi.z * 2u + 1u] * s; }
    if (aBw.w > 0.0) { vec4 q = uDQ[aBi.w * 2u]; float s = dot(q, r0) < 0.0 ? -aBw.w : aBw.w; r += q * s; d += uDQ[aBi.w * 2u + 1u] * s; }
    float l = length(r); r /= l; d /= l;
    p = aPos + 2.0 * cross(r.xyz, cross(r.xyz, aPos) + r.w * aPos) + 2.0 * (r.w * d.xyz - d.w * r.xyz + cross(r.xyz, d.xyz));
    n = aNrm + 2.0 * cross(r.xyz, cross(r.xyz, aNrm) + r.w * aNrm);
    rr = r;
  }
  vW = p; vN = n; vB = aPos; vAux = aAux; vUV = aUV;
  vHeat = uHeatBone < 0 ? -1.0 : (int(aBi.x) == uHeatBone ? aBw.x : 0.0) + (int(aBi.y) == uHeatBone ? aBw.y : 0.0) + (int(aBi.z) == uHeatBone ? aBw.z : 0.0) + (int(aBi.w) == uHeatBone ? aBw.w : 0.0);
  vec3 vv = uCamV - p, qv = -rr.xyz; vVb = vv + 2.0 * cross(qv, cross(qv, vv) + rr.w * vv);
  vT = aUV.xyz + 2.0 * cross(rr.xyz, cross(rr.xyz, aUV.xyz) + rr.w * aUV.xyz);
  gl_Position = uVP * vec4(p, 1.0);
  gl_Position.xy += uJit * gl_Position.w;
}`;
var LIGHT = `
in vec3 vW; in vec3 vN; in vec3 vB; in vec4 vAux; in vec4 vUV; in vec3 vVb; in vec3 vT; in float vHeat;
uniform vec3 uCam; uniform vec3 uLP[3]; uniform vec3 uLC[3]; uniform vec3 uLD[3]; uniform vec2 uLK[3];
uniform mat4 uSM; uniform sampler2DShadow uShC; uniform sampler2D uShD; uniform float uTime;
out vec4 oC;
const float PI = 3.14159265;
float sat(float x) { return clamp(x, 0.0, 1.0); }
float sq(float x) { return x * x; }
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z); }
float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * noise(p); p = p * 2.03 + 1.7; a *= 0.5; } return s; }
// lanterns in the room, for the procedural environment
const vec3 LANT0 = vec3(-1.5, 2.45, 2.3), LANT1 = vec3(1.9, 1.31, 0.6), LANT2 = vec3(-1.45, 1.31, -1.15);
vec3 envC(vec3 d, float rough) {
  float up = d.y, r2 = rough * rough;
  vec3 wall = vec3(0.030, 0.020, 0.014), ceil = vec3(0.012, 0.010, 0.010), floorC = vec3(0.045, 0.028, 0.017);
  vec3 c = mix(floorC, wall, smoothstep(-0.35, 0.05, up));
  c = mix(c, ceil, smoothstep(0.35, 0.9, up));
  // window-ish cool patch behind right (moonlit paper screen)
  c += vec3(0.020, 0.024, 0.030) * smoothstep(0.75 - r2 * 0.6, 1.0, dot(d, normalize(vec3(0.6, 0.35, -0.75))));
  // lanterns: soft warm glows (their direct light comes from the point lights)
  vec3 L[3]; L[0] = LANT0; L[1] = LANT1; L[2] = LANT2;
  for (int i = 0; i < 3; i++) {
    vec3 ld = normalize(L[i] - vec3(0.0, 1.3, 0.0)); float a = max(dot(d, ld), 0.0), al = max(r2, 0.02), n = 2.0 / (al * al) - 2.0;
    c += vec3(1.0, 0.55, 0.25) * 0.012 * min((n + 2.0) / 6.283, 60.0) * pow(a, min(n, 3000.0)) + vec3(0.03, 0.016, 0.007) * pow(a, 3.0);
  }
  return c;
}
vec2 envBRDF(float NoV, float rough) {   // Karis' analytic approximation
  vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022), c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1; float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y; return vec2(-1.04, 1.04) * a004 + r.zw;
}
float D_GGX(float NoH, float a) { float a2 = a * a, d = NoH * NoH * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
float V_SJ(float NoV, float NoL, float a) { float a2 = a * a; float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2), gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2); return 0.5 / max(gv + gl, 1e-5); }
vec3 F_Sch(vec3 f0, float VoH) { float f = clamp(1.0 - VoH, 0.0, 1.0), f2 = f * f; return f0 + (1.0 - f0) * f2 * f2 * f; }
const vec2 PD[16] = vec2[](vec2(-0.94201624, -0.39906216), vec2(0.94558609, -0.76890725), vec2(-0.094184101, -0.92938870), vec2(0.34495938, 0.29387760),
  vec2(-0.91588581, 0.45771432), vec2(-0.81544232, -0.87912464), vec2(-0.38277543, 0.27676845), vec2(0.97484398, 0.75648379),
  vec2(0.44323325, -0.97511554), vec2(0.53742981, -0.47373420), vec2(-0.26496911, -0.41893023), vec2(0.79197514, 0.19090188),
  vec2(-0.24188840, 0.99706507), vec2(-0.81409955, 0.91437590), vec2(0.19984126, 0.78641367), vec2(0.14383161, -0.14100790));
float shadow(vec3 w, vec3 n, float soft) {   // PCSS: blocker search, then PCF with a penumbra-sized kernel
  // normal offset and depth bias grow toward grazing light: without them the face self-shadowed in stair-stepped,
  // texel-sized blocks (acne) that read as blocky patches in the highlights
  float nl = clamp(dot(n, normalize(uLP[0] - w)), 0.0, 1.0), gz = 1.0 - nl;
  vec4 s = uSM * vec4(w + n * (0.003 + 0.007 * gz), 1.0); s.xyz /= s.w; s.xyz = s.xyz * 0.5 + 0.5;
  s.z -= 0.0006 * gz;
  if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0 || s.z > 1.0) return 1.0;
  float bsum = 0.0, bn = 0.0, sr = 0.006 + 0.004 * min(soft, 1.0);
  for (int i = 0; i < 16; i++) { float d = texture(uShD, s.xy + PD[i] * sr).r; if (d < s.z - 0.0004) { bsum += d; bn += 1.0; } }
  if (bn < 0.5) return 1.0;
  float zr = bsum / bn, pen = clamp((s.z - zr) / max(zr, 1e-3) * 40.0 * soft, 0.0012 + 0.0024 * sq(min(soft, 1.0)), 0.012);   // (skin: a wider minimum penumbra, so contact shadows of the hair never show the map's texel staircase)
  float lit = 0.0;
  for (int i = 0; i < 16; i++) lit += texture(uShC, vec3(s.xy + PD[i] * pen, s.z - 0.0003));
  for (int i = 0; i < 16; i++) lit += texture(uShC, vec3(s.xy + PD[i].yx * vec2(-0.5, 0.5) * pen, s.z - 0.0003));
  return lit / 32.0;
}
float spot(int i, vec3 L) { return smoothstep(uLK[i].x, uLK[i].y, dot(-L, uLD[i])); }
`;
var FS_SKIN = LIGHT + `
uniform vec3 uO;   // head-local origin
uniform float uMakeup;
uniform int uNDec; uniform vec4 uDc[24]; uniform vec4 uDu[24]; uniform vec4 uDv[24]; uniform vec4 uDn[24]; uniform vec4 uDcol[24]; uniform vec4 uDp[24];
uniform vec3 uMouth;   // mouth centre, head-local
// painted makeup layers (face.html): a texture array in a cylindrical projection of the head (u: angle around the head's
// vertical axis, v: height); uPL[i] = (layer, opacity, blend 0 normal / 1 multiply, gloss − matte … + glossy)
uniform highp sampler2DArray uPaint; uniform int uPaintN; uniform vec4 uPL[8]; uniform vec4 uPaintProj;
uniform float uLipTone; uniform float uCavity; uniform float uFlat; uniform vec3 uEyeC;
float paintUV(vec3 h, out vec2 uv) {
  float r = length(vec2(h.x, h.z - uPaintProj.z)); uv = vec2(atan(h.x, h.z - uPaintProj.z) / 6.2831853 + 0.5, (h.y - uPaintProj.x) / (uPaintProj.y - uPaintProj.x));
  return (1.0 - smoothstep(uPaintProj.w - 0.01, uPaintProj.w, r)) * step(0.0, uv.y) * step(uv.y, 1.0);
}
// antialiased inside test from a signed distance (meters): a smooth band of 'w' plus the pixel footprint (fwidth)
float aaIn(float d, float w) { float f = fwidth(d) * 0.75 + w; return 1.0 - smoothstep(-f, f, d); }
// brow styles (Tang): returns coverage for brow-local q (x along the brow, + = outer end), half-size sz
float browShape(vec2 q, vec2 sz, float st, float soft, out float dens) {
  float x = q.x / sz.x, e = max(1.0 - x * x, 0.0), c = 0.0, t = sz.y, d; dens = 1.0;
  if (st < 0.5) { d = (length(q / sz) - 1.0) * sz.y; return aaIn(d, soft * sz.y * 0.6); }               // 八字眉: the classic tilted ellipse
  else if (st < 1.5) { t = sz.y * pow(e, 0.55) * (1.15 - 0.35 * smoothstep(-1.0, 1.0, x)); }           // 桂葉眉: broad leaf, rounder inner end
  else if (st < 2.5) { t = sz.y * sqrt(e); c = sz.y * 2.4 * e - sz.y * 1.2; }                           // 卻月眉: crescent
  else if (st < 3.5) { t = sz.y * sqrt(e); c = sz.y * 1.8 * e - sz.y * 0.9; dens = 0.7; }               // 遠山眉: long, light, gently arched
  else if (st < 4.5) { t = sz.y * sqrt(e); c = sz.y * 0.9 * e - sz.y * 0.45;                            // 倒暈眉: dark inner end, fading out
    dens = mix(1.0, 0.18, smoothstep(-0.9, 0.9, x)); }
  else { t = sz.y * e; c = sz.y * 1.2 * e - sz.y * 0.6; }                                               // 柳葉眉: willow leaf
  d = abs(q.y - c) - t;
  return aaIn(d, soft * sz.y * 0.5) * (1.0 - smoothstep(0.92, 1.0, abs(x)));
}
vec3 skinAlbedo(vec3 b, vec3 n, out float rough, out float spec) {
  vec3 base = vec3(0.74, 0.55, 0.45);   // warm pale body skin (linear)
  rough = 0.56; spec = 0.8;   // matte skin: broad, weak highlights (no porcelain glaze)
  vec3 h = b - uO;
  float face = smoothstep(-0.14, -0.10, h.y) * smoothstep(-0.03, 0.07, h.z + 0.02 * smoothstep(0.0, 0.06, abs(h.x)));
  float headAll = smoothstep(-0.15, -0.11, h.y);
  // Tang lead-white powder on the face and neck front, soft edge
  vec3 powder = vec3(0.88, 0.79, 0.74);
  if (uPaintN == 0) {   // (with painted layers the powder is the base layer)
  base = mix(base, powder, uMakeup * 0.75 * max(face, 0.6 * headAll * smoothstep(-0.02, 0.04, h.z)));
  rough = mix(rough, 0.66, face * uMakeup); spec = mix(spec, 0.5, face * uMakeup); }   // lead-white powder is matte
  // painted makeup: decals from figure.json (rouge 紅妝, 蛾眉 brows, 花鈿, lip paint 點唇 …), projected in bind space
  float lipMat = vAux.w <= 1.0 ? vAux.w : 0.0;
  // primitives with the 'lip' material: a natural, soft lip tone (the red 點唇 paint comes from the lip decals, which
  // have smooth, antialiased edges; the material boundary itself follows the mesh and would look jagged in strong red)
  float lipM = smoothstep(0.2, 0.8, lipMat);   // (before the decals, so the paint sits on top)
  base = mix(base, vec3(0.66, 0.34, 0.31), lipM * uLipTone);   // the natural lip; the red 點脣 is the (small) lip decal
  rough = mix(rough, 0.36, lipM * 0.7); spec = mix(spec, 1.3, lipM * 0.7);   // smooth lip weight (0 skin … 1 lip); ids above 1 are other materials
  for (int i = 0; i < 24; i++) {
    if (i >= uNDec || uPaintN > 0) break;
    vec3 d = b - uDc[i].xyz; float lx = dot(d, uDu[i].xyz), ly = dot(d, uDv[i].xyz), ln = dot(d, uDn[i].xyz);
    float sx = uDu[i].w, sy = uDv[i].w, soft = uDp[i].z, prm = uDp[i].w, kind = uDc[i].w, m;
    if (kind < 0.5) m = exp(-(sq(lx / sx) + sq(ly / sy)));
    else if (kind < 1.5) { float cr = cos(prm), sr = sin(prm), dens; vec2 q = mat2(cr, -sr, sr, cr) * vec2(lx, ly);
      m = browShape(q, vec2(sx, sy), uDn[i].w, soft, dens) * dens * (0.75 + 0.25 * noise(vec3(b.x * 900.0, b.y * 200.0, 0.0))); }
    else if (kind < 2.5) { float fr = length(vec2(lx, ly)), fa = atan(ly, lx); m = aaIn(fr - sx * (0.65 + 0.35 * cos(prm * fa)), soft * 0.5); }
    else if (kind < 3.5) m = aaIn(length(vec2(lx, ly)) - sx, soft * sx * 0.5);
    else { float yy = ly > 0.0 ? ly / sy : ly / prm;   // lip paint: smooth edge, mostly kept to the lip material (slight bleed)
      m = aaIn((length(vec2(lx / sx, yy)) - 1.0) * sy, soft * sy * 0.6) * mix(0.25, 1.0, lipMat); }
    float a = clamp(m * smoothstep(uDp[i].x, uDp[i].y, ln), 0.0, 1.0) * uDcol[i].w * uMakeup;
    float gl = kind > 0.5 && kind < 1.5 ? 0.0 : uDn[i].w;   // (brows carry their style in that slot)
    base = mix(base, uDcol[i].rgb, a); rough = mix(rough, 0.28, a * gl); spec = mix(spec, 1.6, a * gl);
  }
  if (uPaintN > 0) { vec2 puv; float pin = paintUV(h, puv);
    if (pin > 0.0) for (int i = 0; i < 8; i++) { if (i >= uPaintN) break; vec4 L = uPL[i];
      vec4 t = texture(uPaint, vec3(puv, L.x)); vec3 tc = pow(t.rgb, vec3(2.2)); float a = t.a * L.y * pin;
      base = L.z > 0.5 ? mix(base, base * tc, a) : mix(base, tc, a);
      rough = mix(rough, L.w > 0.0 ? 0.28 : 0.6, a * abs(L.w)); spec = mix(spec, L.w > 0.0 ? 1.6 : 0.7, a * abs(L.w));
      if (i == 0) { rough = mix(rough, 0.68, a); spec = mix(spec, 0.45, a); } } }   // layer 0 is the powder 鉛粉 base: matte where applied
  // mouth interior: a dark, warm, shadowed cavity — darker the deeper behind the lips (bind space, so it opens with the jaw)
  vec3 mq = h - uMouth;
  float cav = smoothstep(-0.005, -0.016, mq.z) * (1.0 - smoothstep(0.016, 0.024, abs(mq.x))) * (1.0 - smoothstep(0.008, 0.013, abs(mq.y + 0.002)));   // (a wider band reached the receding chin: grey 'stubble' smudges)
  cav *= mix(0.55, 1.0, smoothstep(-0.008, -0.022, mq.z)) * smoothstep(-0.07, -0.055, mq.z);   // only the mouth, not the neck behind it
  base = mix(base, vec3(0.075, 0.018, 0.014), cav * uCavity); rough = mix(rough, 0.35, cav); spec = mix(spec, 0.4, cav);
  // fingernails (painted pale rose)
  base = mix(base, vec3(0.86, 0.52, 0.50), vAux.y); rough = mix(rough, 0.36, vAux.y); spec = mix(spec, 1.1, vAux.y);
  return base;
}
void main() {
  vec3 N = normalize(vN), Vv = normalize(uCam - vW);
  if (!gl_FrontFacing) N = -N;
  float rough, spec; vec3 alb = skinAlbedo(vB, N, rough, spec);
  if (vHeat >= 0.0) alb = mix(vec3(0.05, 0.08, 0.4), mix(vec3(0.1, 0.8, 0.2), vec3(1.0, 0.15, 0.05), smoothstep(0.5, 1.0, vHeat)), smoothstep(0.0, 0.5, vHeat)) * 0.8 + 0.05;
  // micro detail: pores perturb the normal a little (faded out where they would be smaller than a pixel)
  vec3 pn = vec3(noise(vB * 2500.0), noise(vB * 2500.0 + 13.1), noise(vB * 2500.0 + 7.7)) - 0.5;
  pn *= 1.0 - smoothstep(0.4, 1.2, length(fwidth(vB * 2500.0)));
  vec3 pf = vec3(noise(vB * 6000.0 + 3.3), noise(vB * 6000.0 + 21.7), noise(vB * 6000.0 + 9.1)) - 0.5;   // finer pores
  pf *= 1.0 - smoothstep(0.4, 1.2, length(fwidth(vB * 6000.0)));
  vec3 Ns = normalize(N + pn * 0.06 + pf * 0.05);
  // slight roughness variation (mm scale) so highlights break up instead of forming smooth sheets
  rough = clamp(rough * (0.88 + 0.26 * fbm(vB * 450.0)), 0.3, 0.85);
  // geometric specular antialiasing (Kaplanyan / Tokuyoshi): widen the lobe by the normal's variation inside the pixel,
  // and keep the small, highly curved fingers less glossy
  vec3 dNx = dFdx(N), dNy = dFdy(N); float nvar = 0.5 * (dot(dNx, dNx) + dot(dNy, dNy));
  rough = sqrt(min(rough * rough + min(2.0 * nvar, 0.3), 1.0));
  spec *= mix(1.0, 0.6, smoothstep(0.5, 0.54, abs(vB.x)));
  float ao = vAux.x, th = vAux.z;
  vec3 he = vB - uO; float eyeZ = 1.0 - smoothstep(0.012, 0.026, min(length(he - uEyeC), length(he - uEyeC * vec3(-1.0, 1.0, 1.0))));
  ao = mix(ao, max(ao, 0.9), eyeZ);   // the baked occlusion in the eye sockets read as a grey ring
  // the front of the armpits (bind space): the shallow hollow between chest and arm shadowed itself in the shadow map at
  // grazing light (a dark, sharp, streaky band under the key light, gone with the shadow off or the lookup 12 mm off the
  // surface); there the lookup starts 12 mm out along the normal
  float pitM = smoothstep(0.07, 0.095, abs(vB.x)) * (1.0 - smoothstep(0.16, 0.19, abs(vB.x))) * smoothstep(1.1, 1.16, vB.y) * (1.0 - smoothstep(1.28, 1.33, vB.y)) * smoothstep(-0.04, 0.0, vB.z);
  vec3 col = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    vec3 Lv = uLP[i] - vW; float dist = length(Lv); vec3 L = Lv / dist;
    float att = spot(i, L) / (dist * dist);
    float sh = i == 0 ? shadow(vW + N * (0.012 * pitM), N, 1.0) : 1.0;
    float NoL = dot(N, L);
    // pre-integrated-ish SSS: per-channel wrapped diffuse with a reddish terminator
    vec3 w = vec3(0.42, 0.20, 0.13);
    vec3 dif = clamp((vec3(NoL) + w) / (1.0 + w), 0.0, 1.0); dif *= dif;
    dif = mix(dif * vec3(1.0, 0.88, 0.82), dif, smoothstep(0.0, 0.5, NoL));
    float shs = mix(sh, 1.0, 0.0);
    vec3 shc = pow(vec3(sh), vec3(0.5, 1.0, 1.3));   // red-tinted penumbra
    // subsurface scatter around the terminator: warm, saturated light where the surface turns away (never grey)
    float term = smoothstep(-0.35, 0.15, NoL) * (1.0 - smoothstep(0.15, 0.65, NoL));
    vec3 Dl = alb * (dif * shc + vec3(0.22, 0.07, 0.035) * term * sqrt(sh)) / PI;
    // two-lobe specular
    vec3 H = normalize(L + Vv); float NoH = max(dot(Ns, H), 0.0), NoV = max(dot(Ns, Vv), 1e-4), NoLs = max(dot(Ns, L), 0.0), VoH = max(dot(Vv, H), 0.0);
    vec3 F = F_Sch(vec3(0.028), VoH);
    // main lobe plus a weak, broader second lobe (no sharp clear-coat lobe), overall weaker
    float r2 = min(rough * 1.6, 1.0), sp = mix(D_GGX(NoH, rough) * V_SJ(NoV, NoLs, rough), D_GGX(NoH, r2) * V_SJ(NoV, NoLs, r2), 0.25);
    vec3 Sl = F * sp * NoLs * sh * spec * 0.7;
    // translucency through thin parts (ears, fingers, nostrils)
    float tr = smoothstep(0.014, 0.004, th) * sq(sat(dot(Vv, -L) * 0.7 + 0.3)) * sat(0.2 - NoL);
    vec3 Tl = alb * vec3(1.0, 0.3, 0.15) * tr * 0.6;
    col += (Dl + Sl + Tl) * uLC[i] * att;
  }
  // ambient: env irradiance + specular reflection, occluded
  // warm bounce from the red skirt / floor below and the lamps; occlusion tints toward the skin's own deep tone (coloured AO)
  // (the room's cool moonlit-screen fill turned skin shadows grey-green: skin sees it warmed by its own scatter)
  vec3 irr = envC(N, 1.0) * vec3(1.3, 1.08, 0.88) + vec3(0.013, 0.008, 0.005) + vec3(0.030, 0.010, 0.005) * smoothstep(0.3, -0.8, N.y);
  vec3 aoC = pow(vec3(ao), vec3(0.55, 0.95, 1.2));
  float NoV = max(dot(N, Vv), 1e-4); vec2 eb = envBRDF(NoV, rough);
  col += alb * irr * aoC + envC(reflect(-Vv, normalize(mix(N, Ns, 0.4))), rough) * (0.028 * eb.x + eb.y) * ao * ao * spec * 0.6;
  if (uFlat > 0.5) col = alb * 0.55;   // flat / unlit view (face.html)
  oC = vec4(col, 1.0);
}`;
var FS_EYE = LIGHT + `
uniform float uSide;
void main() {
  vec3 p = vUV.xyz, N = normalize(vN), Vv = normalize(uCam - vW), Vb = normalize(vVb);
  float rho = length(p.xy), IR = 0.0059, PR = 0.0024;
  // refraction at the cornea: find where the bent ray meets the iris plane
  vec3 nb = normalize(p - vec3(0.0, 0.0, 0.0052)); vec3 rd = refract(-Vb, nb, 1.0 / 1.376);
  float zi = 0.0098, tpar = rho < 0.0066 ? (p.z - zi) / max(-rd.z, 0.2) : 0.0;
  vec2 ip = p.xy + rd.xy * tpar; float ir = length(ip), ia = atan(ip.y, ip.x);
  float corneaM = smoothstep(0.0068, 0.0058, rho);
  // sclera: warm white, pinker and a bit veined toward the corners, darker deep in the socket
  vec3 scl = vec3(0.78, 0.70, 0.64);
  float edge = smoothstep(0.004, 0.0115, rho);
  scl = mix(scl, vec3(0.75, 0.6, 0.55), edge * 0.3);   // (the corners were pink: part of the 'ring' around the eyes)
  float veins = smoothstep(0.62, 0.8, fbm(vec3(p.xy * 900.0, uSide * 3.0))) * edge;
  scl = mix(scl, vec3(0.6, 0.15, 0.12), veins * 0.12);
  // iris: dark brown with radial fibres, lighter collarette, dark limbal ring, pupil
  float fib = fbm(vec3(ia * 9.0, ir * 1400.0, uSide)) * 0.6 + 0.4 * sin(ia * 61.0 + fbm(vec3(ia * 5.0, ir * 800.0, 2.0)) * 6.0) * 0.5 + 0.5;
  vec3 iris = mix(vec3(0.030, 0.014, 0.006), vec3(0.11, 0.055, 0.022), fib * 0.7);
  iris = mix(iris, vec3(0.16, 0.09, 0.035), smoothstep(0.0032, 0.0027, ir) * 0.6);
  iris *= mix(1.0, 0.35, smoothstep(0.0048, 0.006, ir));
  vec3 alb = mix(scl, iris, smoothstep(IR + 0.0004, IR - 0.0002, ir));
  alb = mix(alb, vec3(0.004), smoothstep(PR + 0.0002, PR - 0.0002, ir));
  // occlusion by the lids (soft): more shadow under the upper lid
  float occ = smoothstep(0.0125, 0.006, length(vec2(p.x * 0.75, max(p.y - 0.0005, 0.0) * 1.3 + min(p.y + 0.002, 0.0) * 0.7)));
  occ = mix(0.25, 1.0, occ) * mix(0.55, 1.0, smoothstep(0.0048, 0.0010, p.y));
  vec3 col = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    vec3 Lv = uLP[i] - vW; float dist = length(Lv); vec3 L = Lv / dist; float att = spot(i, L) / (dist * dist), sh = i == 0 ? shadow(vW, N, 0.5) : 1.0;
    float NoL = max(dot(N, L), 0.0); vec3 H = normalize(L + Vv); float NoH = max(dot(N, H), 0.0), NoV = max(dot(N, Vv), 1e-4);
    float rough = mix(0.16, 0.05, corneaM);
    vec3 F = F_Sch(vec3(0.025), max(dot(Vv, H), 0.0));
    col += (alb * (NoL * 0.85 + 0.15) / PI * occ + F * D_GGX(NoH, rough) * V_SJ(NoV, NoL, rough) * NoL * (occ * 0.7 + 0.3)) * sh * uLC[i] * att;
  }
  float NoV = max(dot(N, Vv), 1e-4); vec2 eb = envBRDF(NoV, 0.05);
  col += alb * envC(N, 1.0) * occ + envC(reflect(-Vv, N), 0.06) * (0.025 * eb.x + eb.y) * mix(0.4, 1.0, occ);
  oC = vec4(col, 1.0);
}`;
var FS_HAIR = LIGHT + `
uniform float uStrand; uniform float uIsLash; uniform vec3 uLashCol;
void main() {
  vec3 N = normalize(vN), Vv = normalize(uCam - vW); if (!gl_FrontFacing) N = -N;
  vec3 T = normalize(vT - N * dot(vT, N));
  float tone = uStrand > 0.5 ? vAux.x : fbm(vB * 300.0);
  vec3 base = mix(vec3(0.0055, 0.0045, 0.004), vec3(0.016, 0.011, 0.008), tone);
  if (uIsLash > 0.5) base = uLashCol;
  float alpha = 1.0;
  if (uStrand > 0.5) {
    float across = 1.0 - vAux.y * vAux.y;
    alpha = smoothstep(0.0, 0.5, across) * (1.0 - smoothstep(0.6, 1.0, vUV.w)) * 0.95;
  } else {
    // soft hairline: the cap thins out where it meets the skin
    float n = fbm(vB * 900.0);
    alpha = smoothstep(0.15, 0.85, vUV.w * (0.8 + 0.4 * n));
  }
  // strand-direction grooves on the cap
  float groove = uStrand > 0.5 ? 1.0 : 0.75 + 0.25 * sin(dot(vB, cross(T, N)) * 9000.0 + fbm(vB * 200.0) * 8.0);
  vec3 col = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    vec3 Lv = uLP[i] - vW; float dist = length(Lv); vec3 L = Lv / dist; float att = spot(i, L) / (dist * dist), sh = i == 0 ? shadow(vW, N, 0.6) : 1.0;
    float TL = dot(T, L), TV = dot(T, Vv), sTL = sqrt(max(1.0 - TL * TL, 0.0));
    float dif = mix(0.25, 1.0, max(dot(N, L), 0.0)) * sTL;
    // Kajiya-Kay style lobes: R (shifted toward the root, white) and TRT (toward the tip, tinted, wider)
    vec3 T1 = normalize(T + N * 0.08), T2 = normalize(T - N * 0.12);
    vec3 H = normalize(L + Vv);
    float s1 = pow(max(sqrt(max(1.0 - sq(dot(T1, H)), 0.0)), 0.0), 220.0), s2 = pow(max(sqrt(max(1.0 - sq(dot(T2, H)), 0.0)), 0.0), 45.0);
    vec3 spec = (vec3(0.11, 0.105, 0.10) * s1 + vec3(0.07, 0.05, 0.04) * s2 * 0.5) * (uIsLash > 0.5 ? 0.12 : 1.0);   // lashes: dark, barely a sheen
    col += (base * dif * groove + spec * groove * smoothstep(-0.2, 0.3, dot(N, L))) * sh * uLC[i] * att;
  }
  col += base * envC(N, 1.0) * 0.8 + envC(reflect(-Vv, N), 0.3) * (uIsLash > 0.5 ? 0.004 : 0.02);
  oC = vec4(col, alpha);
}`;
var FS_CLOTH = LIGHT + `
uniform sampler2D uTex; uniform vec2 uTile; uniform float uGauze; uniform float uSheen; uniform vec3 uTint; uniform float uRough; uniform float uBand; uniform float uAlpha;
uniform vec4 uTrim; uniform sampler2D uTrimTex;
void main() {
  vec3 N = normalize(vN), Vv = normalize(uCam - vW); bool back = !gl_FrontFacing; if (back) N = -N;
  vec2 uv = vUV.xy / uTile;
  if (uBand > 0.5) uv = vec2(vUV.x * 12.0, vUV.y);
  vec4 tx = texture(uTex, uv);
  vec3 alb = tx.rgb * uTint;
  if (uTrim.w > 0.5) {   // Song 褙子 edge bands (領抹): down the front edges (vUV.z = distance from the edge), round the collar
    // (the top rows) and the cuffs (past uTrim.z along the sleeve); soft (pixel-wide) boundaries
    float fz = max(fwidth(vUV.z), 1e-5), fy = max(fwidth(vUV.y), 1e-5);
    float kE = smoothstep(-fz, fz, uTrim.x - vUV.z), kC = smoothstep(-fy, fy, uTrim.y - vUV.y), kU = uTrim.z > 0.0 ? smoothstep(-fy, fy, vUV.y - uTrim.z) : 0.0;
    vec2 tuv = kE >= max(kC, kU) ? vec2(vUV.z / uTrim.x, vUV.y / uTrim.x * 0.5) : kC >= kU ? vec2(vUV.y / uTrim.y, vUV.x / uTrim.y * 0.5) : vec2((vUV.y - uTrim.z) / 0.028, vUV.x / 0.028 * 0.5);
    alb = mix(alb, texture(uTrimTex, tuv).rgb, max(kE, max(kC, kU)));
  }
  // weave: warp/weft threads perturb the normal; tangent from the uv derivatives
  vec3 dp1 = dFdx(vW), dp2 = dFdy(vW); vec2 du1 = dFdx(vUV.xy), du2 = dFdy(vUV.xy);
  vec3 Tg = normalize(dp1 * du2.y - dp2 * du1.y + 1e-7), Bt = normalize(cross(N, Tg)); Tg = cross(Bt, N);
  vec2 wv = vUV.xy * vec2(2200.0, 2200.0);
  float wx = sin(wv.x * 3.14159), wy = sin(wv.y * 3.14159), chk = step(0.0, sin(wv.x * 1.5708) * sin(wv.y * 1.5708));
  vec3 Nw = normalize(N + (Tg * wx * mix(0.06, 0.02, chk) + Bt * wy * mix(0.02, 0.06, chk)) * (1.0 - uGauze * 0.5));
  // soft fold shading from the sim normals is already in N; a little extra large-scale fold noise
  float fold = fbm(vec3(vUV.xy * vec2(9.0, 3.0), 1.0));
  vec3 col = vec3(0.0);
  float rough = uRough;
  for (int i = 0; i < 3; i++) {
    vec3 Lv = uLP[i] - vW; float dist = length(Lv); vec3 L = Lv / dist; float att = spot(i, L) / (dist * dist), sh = i == 0 ? shadow(vW, N, 1.0) : 1.0;
    float NoL = dot(Nw, L), NoV = max(dot(Nw, Vv), 1e-3);
    vec3 H = normalize(L + Vv); float NoH = max(dot(Nw, H), 0.0);
    // diffuse (wrapped a little: soft fabric) + transmission for thin cloth lit from behind
    float wrap = mix(0.15, 0.5, uGauze), dif = max((NoL + wrap) / (1.0 + wrap), 0.0);
    float trans = max(-NoL, 0.0) * mix(0.15, 0.7, uGauze);
    // silk: anisotropic specular along the warp + Charlie sheen at grazing angles
    float TH = dot(Tg, H), BH = dot(Bt, H), ax = rough * 0.35, ay = rough * 1.2;
    float dA = 1.0 / (PI * ax * ay * sq(sq(TH / ax) + sq(BH / ay) + NoH * NoH));
    float sinH = sqrt(max(1.0 - NoH * NoH, 0.0)), inv = 1.0 / 0.35, dC = (2.0 + inv) * pow(sinH, inv) / (2.0 * PI), NL = max(NoL, 0.0);
    float vis = 1.0 / (4.0 * (NL + NoV - NL * NoV) + 1e-3);
    vec3 spec = (vec3(0.04) * min(dA, 30.0) * 0.25 + alb * uSheen * dC) * NL * vis;
    col += (alb * (dif + trans) / PI + spec) * sh * uLC[i] * att;
  }
  col += alb * envC(N, 1.0) * (0.85 + 0.3 * fold) + alb * uSheen * envC(reflect(-Vv, N), 0.6) * 0.3 * pow(1.0 - max(dot(N, Vv), 0.0), 3.0);
  float alpha = 1.0;
  if (uGauze > 0.5) {
    // sheer: more opaque at grazing angles (more threads in the line of sight), print is denser
    float NoV = abs(dot(normalize(vN), Vv));
    alpha = 1.0 - pow(1.0 - uAlpha * (0.6 + 0.8 * tx.a), 1.0 / max(NoV, 0.12));
    col *= 1.0;
    oC = vec4(col * alpha, alpha);
  } else oC = vec4(col, 1.0);
}`;
var FS_PETAL = LIGHT + `
void main() {
  vec3 N = normalize(vN), Vv = normalize(uCam - vW); if (!gl_FrontFacing) N = -N;
  float v = vUV.y, ring = vUV.z;
  // peony pink: deep at the base, pale at the ruffled edge; veins
  vec3 alb = mix(vec3(0.62, 0.08, 0.16), vec3(0.95, 0.55, 0.62), smoothstep(0.0, 0.9, v) * (0.75 + 0.25 * ring));
  alb = mix(alb, vec3(0.98, 0.82, 0.84), smoothstep(0.75, 1.0, v) * 0.5);
  alb *= 0.85 + 0.15 * sin(vUV.x * 40.0 + fbm(vec3(vUV.xy * 8.0, ring)) * 6.0);
  vec3 col = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    vec3 Lv = uLP[i] - vW; float dist = length(Lv); vec3 L = Lv / dist; float att = spot(i, L) / (dist * dist), sh = i == 0 ? shadow(vW, N, 0.5) : 1.0;
    float NoL = dot(N, L), dif = max(NoL, 0.0) + max(-NoL, 0.0) * 0.6;   // thin petal: strong transmission
    vec3 H = normalize(L + Vv); float spc = D_GGX(max(dot(N, H), 0.0), 0.35) * 0.03 * max(NoL, 0.0);
    spc += 0.06 * pow(1.0 - max(dot(N, Vv), 0.0), 3.0) * max(NoL, 0.0);   // soft velvety sheen at grazing angles
    col += (alb * dif / PI + spc) * sh * uLC[i] * att;
  }
  col += alb * envC(N, 1.0) * vAux.x;
  oC = vec4(col, 1.0);
}`;
var FS_EMIT = LIGHT + `
uniform vec3 uAlb; uniform float uEmit;
void main() {
  // paper lantern: warm glow, darker ribs and a hot core seen through the paper
  float rib = smoothstep(0.02, 0.0, abs(fract(vUV.x * 8.0) - 0.5) - 0.46) + smoothstep(0.03, 0.0, abs(vUV.y - 0.5) - 0.47);
  float core = 0.6 + 0.4 * sin(vUV.y * 3.14159);
  oC = vec4(uAlb * uEmit * core * (1.0 - 0.7 * clamp(rib, 0.0, 1.0)), 1.0);
}`;
// flame flicker (shared by the flame, the silk and the lamp's point light): layered sines of time
var FLICK_GLSL = `float flick(float t, float ph) { return 1.0 + 0.07 * sin(t * 11.3 + ph) + 0.05 * sin(t * 23.1 + ph * 1.7) + 0.03 * sin(t * 41.7 + ph * 2.9); }`;
function flick(t, ph) { return 1 + 0.07 * Math.sin(t * 11.3 + ph) + 0.05 * Math.sin(t * 23.1 + ph * 1.7) + 0.03 * Math.sin(t * 41.7 + ph * 2.9); }
var FS_SILK = LIGHT + FLICK_GLSL + `
uniform vec3 uAlb; uniform float uEmit; uniform float uPh;
void main() {
  // silk panel of a framed lantern, lit from inside: brightest in front of the flame, a fine weave, darker toward the rails
  vec2 q = vUV.xy - vec2(0.5, 0.4);
  float glow = exp(-dot(q * vec2(2.2, 1.6), q * vec2(2.2, 1.6)) * 2.5);
  float weave = 0.92 + 0.08 * sin(vUV.x * 900.0) * sin(vUV.y * 700.0);
  float edge = smoothstep(0.0, 0.08, vUV.y) * smoothstep(1.0, 0.9, vUV.y);
  vec3 c = uAlb * uEmit * (0.25 + 0.75 * glow) * weave * (0.55 + 0.45 * edge) * flick(uTime, uPh);
  oC = vec4(c, 1.0);
}`;
var FS_FLAME = LIGHT + FLICK_GLSL + `
uniform float uPh;
void main() {
  float y = vUV.y, core = smoothstep(0.9, 0.2, vUV.x);   // uv.x: 0 at the axis … 1 at the rim; uv.y: bottom → tip
  vec3 c = mix(vec3(1.0, 0.35, 0.06), vec3(1.0, 0.9, 0.6), core) * mix(1.0, 0.5, y) * 40.0 * flick(uTime * 1.3, uPh + 1.0);
  oC = vec4(c, 1.0);
}`;
var FS_SCREEN = LIGHT + `
uniform sampler2D uTex;
void main() {
  vec3 N = normalize(vN), Vv = normalize(uCam - vW); if (!gl_FrontFacing) N = -N;
  vec3 alb = texture(uTex, vUV.xy).rgb * 0.9, col = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    vec3 Lv = uLP[i] - vW; float dist = length(Lv); vec3 L = Lv / dist; float att = spot(i, L) / (dist * dist), sh = i == 0 ? shadow(vW, N, 2.0) : 1.0;
    col += alb * max(dot(N, L), 0.0) / PI * sh * uLC[i] * att;
  }
  col += alb * envC(N, 1.0);
  oC = vec4(col, 1.0);
}`;
var FS_PLAIN = LIGHT + `
uniform vec3 uAlb; uniform float uRough0; uniform float uMetal; uniform float uTrans;   // uTrans: translucent stone (jade): wrapped diffuse + light through thin parts
void main() {
  vec3 N = normalize(vN), Vv = normalize(uCam - vW); if (!gl_FrontFacing) N = -N;
  vec3 dNx = dFdx(N), dNy = dFdy(N); float uRough = sqrt(min(uRough0 * uRough0 + min(dot(dNx, dNx) + dot(dNy, dNy), 0.3), 1.0));   // specular AA
  vec3 alb = uAlb, col = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    vec3 Lv = uLP[i] - vW; float dist = length(Lv); vec3 L = Lv / dist; float att = spot(i, L) / (dist * dist), sh = i == 0 ? shadow(vW, N, 1.0) : 1.0;
    vec3 H = normalize(L + Vv); float NoL = max(dot(N, L), 0.0), NoH = max(dot(N, H), 0.0), NoV = max(dot(N, Vv), 1e-4);
    vec3 f0 = mix(vec3(0.04), alb, uMetal), F = F_Sch(f0, max(dot(Vv, H), 0.0));
    col += ((1.0 - uMetal) * alb / PI + F * D_GGX(NoH, uRough) * V_SJ(NoV, NoL, uRough)) * NoL * sh * uLC[i] * att * vAux.x;
    col += (1.0 - uMetal) * alb / PI * (mix(NoL, max((dot(N, L) + 0.5) / 1.5, 0.0), uTrans) - NoL) * sh * uLC[i] * att * vAux.x;   // (wrapped diffuse; exactly 0 without uTrans)
    col += alb * alb * max(-dot(N, L), 0.0) * pow(max(dot(Vv, -L), 0.0), 2.0) * uTrans * 0.6 * uLC[i] * att * vAux.x;
  }
  vec2 eb = envBRDF(max(dot(N, Vv), 1e-4), uRough); vec3 f0 = mix(vec3(0.04), alb, uMetal);
  col += (1.0 - uMetal) * alb * envC(N, 1.0) * vAux.x + envC(reflect(-Vv, N), uRough) * (f0 * eb.x + eb.y) * vAux.x * (1.0 + 2.0 * uMetal);   // metals: brighter room reflections
  oC = vec4(col, 1.0);
}`;
var FS_FLOOR = LIGHT + `
void main() {
  vec3 N = vec3(0.0, 1.0, 0.0), Vv = normalize(uCam - vW);
  // wide dark-lacquered planks along x
  float pw = 0.19, row = floor(vW.z / pw), off = hash(vec3(row, 1.0, 2.0)) * 3.0, u = vW.x + off, plank = floor(u / 1.6);
  float seed = hash(vec3(row, plank, 5.0));
  float grain = fbm(vec3(u * 3.0, vW.z * 60.0, seed * 10.0)) * 0.6 + 0.4 * sin((vW.z + fbm(vec3(u * 0.8, vW.z * 8.0, seed)) * 0.05) * 420.0 + seed * 30.0) * 0.5 + 0.5;
  vec3 alb = mix(vec3(0.085, 0.040, 0.022), vec3(0.15, 0.075, 0.040), grain * 0.6 + seed * 0.4);
  float seam = smoothstep(0.0015, 0.0, abs(fract(vW.z / pw + 0.5) - 0.5) * pw) + smoothstep(0.002, 0.0, abs(fract(u / 1.6 + 0.5) - 0.5) * 1.6);
  alb *= 1.0 - 0.6 * seam;
  float rough = mix(0.22, 0.4, fbm(vec3(vW.xz * 4.0, 3.0)));
  vec3 col = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    vec3 Lv = uLP[i] - vW; float dist = length(Lv); vec3 L = Lv / dist; float att = spot(i, L) / (dist * dist), sh = i == 0 ? shadow(vW, N, 1.0) : 1.0;
    vec3 H = normalize(L + Vv); float NoL = max(dot(N, L), 0.0), NoH = max(dot(N, H), 0.0), NoV = max(dot(N, Vv), 1e-4);
    vec3 F = F_Sch(vec3(0.04), max(dot(Vv, H), 0.0));
    col += (alb / PI + F * D_GGX(NoH, rough) * V_SJ(NoV, NoL, rough)) * NoL * sh * uLC[i] * att;
  }
  vec2 eb = envBRDF(max(dot(N, Vv), 1e-4), rough);
  col += alb * envC(N, 1.0) + envC(reflect(-Vv, N), rough) * (0.04 * eb.x + eb.y);
  // fade into darkness far away
  col *= exp(-max(length(vW.xz - vec2(0.0, 0.0)) - 2.6, 0.0) * 0.9);
  oC = vec4(col, 1.0);
}`;
var VS_Q = `layout(location=0) in vec2 aP; out vec2 vT; void main() { vT = aP * 0.5 + 0.5; gl_Position = vec4(aP, 0.0, 1.0); }`;
var FS_DOWN = `in vec2 vT; uniform sampler2D uT; uniform vec2 uPx; uniform float uFirst; out vec4 oC;
void main() { vec3 c = vec3(0.0);
  c += texture(uT, vT + uPx * vec2(-1, -1)).rgb + texture(uT, vT + uPx * vec2(1, -1)).rgb + texture(uT, vT + uPx * vec2(-1, 1)).rgb + texture(uT, vT + uPx * vec2(1, 1)).rgb;
  c *= 0.25; if (uFirst > 0.5) { c = clamp(c, 0.0, 64.0); float l = max(c.r, max(c.g, c.b)); c *= max(l - 0.8, 0.0) / max(l, 1e-4); }
  oC = vec4(c, 1.0); }`;
var FS_UP = `in vec2 vT; uniform sampler2D uT; uniform vec2 uPx; out vec4 oC;
void main() { vec3 c = texture(uT, vT + uPx * vec2(-1, 0)).rgb + texture(uT, vT + uPx * vec2(1, 0)).rgb + texture(uT, vT + uPx * vec2(0, -1)).rgb + texture(uT, vT + uPx * vec2(0, 1)).rgb; oC = vec4(c * 0.25, 1.0); }`;
var FS_COMP = `in vec2 vT; uniform sampler2D uT; uniform sampler2D uB0; uniform sampler2D uB1; uniform sampler2D uB2; uniform float uExp; out vec4 oC;
vec3 aces(vec3 v) {   // Stephen Hill's fitted ACES
  const mat3 i = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 o = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  v = i * v; vec3 a = v * (v + 0.0245786) - 0.000090537, b = v * (0.983729 * v + 0.4329510) + 0.238081; return clamp(o * (a / b), 0.0, 1.0);
}
void main() {
  vec3 c = texture(uT, vT).rgb;
  vec3 bl = texture(uB0, vT).rgb * 0.5 + texture(uB1, vT).rgb * 0.3 + texture(uB2, vT).rgb * 0.2;
  c = c + bl * 0.12;
  vec2 q = vT - 0.5; c *= 1.0 - 0.35 * dot(q, q) * 2.0;
  c = aces(c * uExp);
  c = mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  float h = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  oC = vec4(c + (h - 0.5) / 255.0, 1.0);
}`;
var VS_SH = VS, FS_SH = `out vec4 oC; void main() { oC = vec4(1.0); }`;


/* ================= procedural textures (canvas) ================= */
function canvasTex(w, h, drawFn, wrap) {
  var c = document.createElement('canvas'); c.width = w; c.height = h; var g = c.getContext('2d'); drawFn(g, w, h);
  var t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, c); gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap === false ? gl.CLAMP_TO_EDGE : gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap === false ? gl.CLAMP_TO_EDGE : gl.REPEAT);
  var an = gl.getExtension('EXT_texture_filter_anisotropic'); if (an) gl.texParameterf(gl.TEXTURE_2D, an.TEXTURE_MAX_ANISOTROPY_EXT, 8);
  return t;
}
function petalRing(g, cx, cy, n, r0, r1, wd, fill, rot) {
  for (var i = 0; i < n; i++) { var a = rot + i * 2 * Math.PI / n; g.save(); g.translate(cx + Math.cos(a) * (r0 + r1) / 2, cy + Math.sin(a) * (r0 + r1) / 2); g.rotate(a);
    g.beginPath(); g.ellipse(0, 0, (r1 - r0) / 2, wd, 0, 0, 2 * Math.PI); g.fillStyle = fill; g.fill(); g.restore(); }
}
function pearls(g, cx, cy, r, n, rad, fill) { g.fillStyle = fill; for (var i = 0; i < n; i++) { var a = i * 2 * Math.PI / n; g.beginPath(); g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, rad, 0, 2 * Math.PI); g.fill(); } }
function tuanhua(g, cx, cy, R, pal) {   // 團花 / 寶相花 medallion
  g.beginPath(); g.arc(cx, cy, R, 0, 2 * Math.PI); g.fillStyle = pal.ring; g.fill();
  pearls(g, cx, cy, R * 0.9, 28, R * 0.045, pal.pearl);
  g.beginPath(); g.arc(cx, cy, R * 0.8, 0, 2 * Math.PI); g.fillStyle = pal.ground; g.fill();
  petalRing(g, cx, cy, 8, R * 0.38, R * 0.78, R * 0.13, pal.leaf, Math.PI / 8);
  petalRing(g, cx, cy, 8, R * 0.3, R * 0.68, R * 0.11, pal.petal, 0);
  petalRing(g, cx, cy, 8, R * 0.32, R * 0.6, R * 0.05, pal.vein, 0);
  petalRing(g, cx, cy, 6, R * 0.08, R * 0.34, R * 0.09, pal.inner, 0.3);
  g.beginPath(); g.arc(cx, cy, R * 0.1, 0, 2 * Math.PI); g.fillStyle = pal.pearl; g.fill();
}
function sprig(g, x, y, s, col, rot) { g.save(); g.translate(x, y); g.rotate(rot); petalRing(g, 0, 0, 5, s * 0.15, s, s * 0.32, col, 0); g.beginPath(); g.arc(0, 0, s * 0.18, 0, 2 * Math.PI); g.fillStyle = '#e8c070'; g.fill(); g.restore(); }
function noiseFill(g, w, h, a) { var d = g.getImageData(0, 0, w, h), R = FIG.rng(5); for (var i = 0; i < d.data.length; i += 4) { var n = (R() - 0.5) * a; d.data[i] += n; d.data[i + 1] += n; d.data[i + 2] += n; } g.putImageData(d, 0, 0); }
var TEX = {};
// the waist belt (any costume with "belt" in figure.json): plain silk in belt.color with thin edge lines in belt.edge
function beltTex(B) { return canvasTex(256, 64, function (g, w, h) { g.fillStyle = B.color || '#7d3a34'; g.fillRect(0, 0, w, h); if (B.edge !== null) { g.fillStyle = B.edge || '#c8a45c'; g.fillRect(0, 3, w, 3); g.fillRect(0, h - 6, w, 3); } noiseFill(g, w, h, 6); }); }
function hornTex() { return canvasTex(256, 256, function (g, w, h) {   // thin white horn: pale ivory, faint growth bands, a little cloudy (alpha = density)
  g.clearRect(0, 0, w, h); for (var y = 0; y < h; y++) { var a = 0.42 + 0.05 * Math.sin(y * 0.21) + 0.05 * Math.sin(y * 0.057 + 1.3); g.fillStyle = 'rgba(238,230,210,' + a.toFixed(3) + ')'; g.fillRect(0, y, w, 1); }
  noiseFill(g, w, h, 8); }); }
function makeTextures() {
  // skirt: vermilion ground, staggered medallions, small sprigs between (tile = 0.22 m)
  TEX.skirt = canvasTex(1024, 1024, function (g, w) {
    g.fillStyle = '#a3261a'; g.fillRect(0, 0, w, w);
    var pal = { ring: '#7d1a12', pearl: '#e9d6a0', ground: '#8f2016', leaf: '#3f6b55', petal: '#e7b65c', vein: '#c46a2c', inner: '#f2e2b4' };
    [[0.25, 0.25], [0.75, 0.75], [-0.25, 0.75], [1.25, 0.25], [0.25, 1.25], [0.75, -0.25]].forEach(function (c) { tuanhua(g, c[0] * w, c[1] * w, w * 0.17, pal); });
    [[0.75, 0.25], [0.25, 0.75]].forEach(function (c) { for (var k = 0; k < 4; k++) sprig(g, c[0] * w + Math.cos(k * 1.57) * w * 0.06, c[1] * w + Math.sin(k * 1.57) * w * 0.06, w * 0.035, '#d9a956', k); sprig(g, c[0] * w, c[1] * w, w * 0.04, '#e9d6a0', 0.3); });
    noiseFill(g, w, w, 10);
  });
  // band: deep green with a row of pearl roundels (聯珠紋)
  TEX.band = canvasTex(512, 128, function (g, w, h) {
    g.fillStyle = '#1d3b33'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#c9a44e'; g.fillRect(0, 6, w, 5); g.fillRect(0, h - 11, w, 5);
    for (var i = 0; i < 4; i++) { var cx = (i + 0.5) * w / 4, cy = h / 2; pearls(g, cx, cy, h * 0.3, 18, 3.4, '#efe1b0'); petalRing(g, cx, cy, 6, 4, h * 0.22, 5, '#b8452e', 0); g.beginPath(); g.arc(cx, cy, 5, 0, 7); g.fillStyle = '#efe1b0'; g.fill(); }
    noiseFill(g, w, h, 8);
  });
  // gauze: transparent with sparse gold/white sprigs and cloud scrolls (alpha = print density)
  TEX.gauze = canvasTex(512, 512, function (g, w) {
    g.fillStyle = 'rgba(236,226,214,0.0)'; g.clearRect(0, 0, w, w); g.fillStyle = 'rgba(232,220,206,0.05)'; g.fillRect(0, 0, w, w);
    var R = FIG.rng(11);
    for (var i = 0; i < 14; i++) sprig(g, R() * w, R() * w, w * (0.025 + R() * 0.02), 'rgba(226,200,140,0.75)', R() * 6);
    g.strokeStyle = 'rgba(230,214,190,0.45)'; g.lineWidth = 3;
    for (i = 0; i < 6; i++) { var x = R() * w, y = R() * w; g.beginPath(); for (var k = 0; k < 3; k++) g.arc(x + k * 18, y, 12, Math.PI, 2 * Math.PI * 0.99); g.stroke(); }
  });
  // shawl: pale celadon silk, printed small flowers and gold dust
  TEX.shawl = canvasTex(512, 512, function (g, w) {
    g.fillStyle = 'rgba(232,190,160,0.55)'; g.fillRect(0, 0, w, w);
    var R = FIG.rng(3);
    for (var i = 0; i < 26; i++) sprig(g, R() * w, R() * w, w * (0.025 + R() * 0.015), ['rgba(150,60,70,0.95)', 'rgba(70,110,120,0.9)', 'rgba(226,190,110,0.95)'][i % 3], R() * 6);
    g.fillStyle = 'rgba(230,190,100,0.8)'; for (i = 0; i < 300; i++) g.fillRect(R() * w, R() * w, 1.5, 1.5);
  });
  if (STYLE === 'song') songTextures();
  TEX.sash = canvasTex(64, 256, function (g, w, h) { g.fillStyle = '#2f5a52'; g.fillRect(0, 0, w, h); g.fillStyle = '#c7a24a'; g.fillRect(0, 0, 4, h); g.fillRect(w - 4, 0, 4, h); for (var y = 16; y < h; y += 64) sprig(g, w / 2, y, 14, '#d8b56a', 0); noiseFill(g, w, h, 8); });
}


// Song (宋) fabrics: a restrained palette — pale celadon 褙子 with tone-on-tone damask (暗花), edge bands (領抹) of
// red-brown silk with small flowers, a rose 抹胸 with embroidered sprigs, a pale pleated skirt (百迭裙)
function songTextures() {
  TEX.beizi = canvasTex(512, 512, function (g, w) {
    g.fillStyle = '#b4c7b7'; g.fillRect(0, 0, w, w); var R = FIG.rng(21);
    for (var i = 0; i < 9; i++) { var x = (i % 3 + 0.5 + (Math.floor(i / 3) % 2) * 0.5) * w / 3, y = (Math.floor(i / 3) + 0.5) * w / 3; sprig(g, x % w, y, w * 0.032, 'rgba(206,220,207,0.4)', R() * 6); }
    g.strokeStyle = 'rgba(150,172,155,0.35)'; g.lineWidth = 2; for (i = 0; i < 6; i++) { var cx = R() * w, cy = R() * w; g.beginPath(); for (var k = 0; k < 3; k++) g.arc(cx + k * 14, cy, 9, Math.PI, 2 * Math.PI * 0.99); g.stroke(); }
    noiseFill(g, w, w, 6);
  });
  TEX.trim = canvasTex(128, 256, function (g, w, h) {
    g.fillStyle = '#743630'; g.fillRect(0, 0, w, h); g.fillStyle = '#c8a45c'; g.fillRect(6, 0, 5, h); g.fillRect(w - 11, 0, 5, h);
    for (var y = 32; y < h; y += 64) { sprig(g, w / 2, y, 22, '#e9d9c4', y / 40); sprig(g, w / 2, y + 32, 12, '#d79a8a', 1); }
    noiseFill(g, w, h, 6);
  });
  TEX.bandSong = canvasTex(256, 512, function (g, w, h) {
    g.fillStyle = '#b8636a'; g.fillRect(0, 0, w, h); g.fillStyle = '#7a3036'; g.fillRect(0, 0, w, 14); g.fillStyle = '#d8b26a'; g.fillRect(0, 14, w, 4);
    var R = FIG.rng(8); for (var i = 0; i < 7; i++) sprig(g, (i % 2 + 0.5) * w / 2, 70 + i * 62, 20, i % 2 ? '#efd6cf' : '#e8c27a', R() * 6);
    noiseFill(g, w, h, 6);
  });
  TEX.skirtSong = canvasTex(256, 256, function (g, w, h) {   // one pleat per tile column: lit face, crease shadow
    var gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, '#ddcdc5'); gr.addColorStop(0.15, '#e8d9d0'); gr.addColorStop(0.75, '#e4d4cb'); gr.addColorStop(0.93, '#d5c3ba'); gr.addColorStop(1, '#ddcdc5');
    g.fillStyle = gr; g.fillRect(0, 0, w, h); noiseFill(g, w, h, 5);
  });
  TEX.sashSong = canvasTex(64, 256, function (g, w, h) { g.fillStyle = '#7d3a34'; g.fillRect(0, 0, w, h); g.fillStyle = '#c8a45c'; g.fillRect(0, 0, 3, h); g.fillRect(w - 3, 0, 3, h); noiseFill(g, w, h, 6); });
}

/* ================= props: painted folding screen, standing lanterns ================= */
function quadMesh(list) {   // list of [p0, p1, p2, p3, uv0..3] quads → mesh
  var pos = [], nrm = [], uv = [], idx = [];
  list.forEach(function (q) { var b = pos.length / 3, n = V.norm(V.cross(V.sub(q[1], q[0]), V.sub(q[3], q[0])));
    for (var k = 0; k < 4; k++) { pos.push.apply(pos, q[k]); nrm.push.apply(nrm, n); uv.push(q[4][k][0], q[4][k][1], 0, 0); }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3); });
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(uv), idx: new Uint32Array(idx) };
}
function lathe(prof, c, seg, uvRadial) {   // surface of revolution about the y axis through c; prof: [[r, y]…] (y absolute)
  var pos = [], nrm = [], uv = [], idx = [], n = prof.length, rmax = prof.reduce(function (m, p) { return Math.max(m, p[0]); }, 1e-6);
  for (var i = 0; i < n; i++) for (var j = 0; j <= seg; j++) {
    var a = j / seg * 2 * Math.PI, ca = Math.cos(a), sa = Math.sin(a), p = prof[i], pp = prof[Math.max(i - 1, 0)], pn = prof[Math.min(i + 1, n - 1)];
    var dr = pn[0] - pp[0], dy = pn[1] - pp[1], l = Math.hypot(dr, dy) || 1;   // profile normal (dy, -dr) rotated about y
    pos.push(c[0] + p[0] * ca, c[1] + p[1], c[2] + p[0] * sa); nrm.push(dy / l * ca, -dr / l, dy / l * sa);
    uv.push(uvRadial ? p[0] / rmax : j / seg, uvRadial ? i / (n - 1) : i / (n - 1), 0, 0);
  }
  for (i = 0; i < n - 1; i++) for (j = 0; j < seg; j++) { var a0 = i * (seg + 1) + j, b0 = a0 + seg + 1; idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1); }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(uv), idx: new Uint32Array(idx) };
}
function mergeMeshes(ms) {
  var pos = [], nrm = [], uv = [], idx = [];
  ms.forEach(function (m) { var b = pos.length / 3; pos.push.apply(pos, m.pos); nrm.push.apply(nrm, m.nrm); uv.push.apply(uv, m.uv); for (var i = 0; i < m.idx.length; i++) idx.push(m.idx[i] + b); });
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(uv), idx: new Uint32Array(idx) };
}
function boxQuads(c, h, list, uvs) {   // axis-aligned box (center, half sizes)
  var x0 = c[0] - h[0], x1 = c[0] + h[0], y0 = c[1] - h[1], y1 = c[1] + h[1], z0 = c[2] - h[2], z1 = c[2] + h[2], U = uvs || [[0, 0], [1, 0], [1, 1], [0, 1]];
  list.push([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], U], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], U],
    [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], U], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], U],
    [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], U], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], U]);
}
function paintScreen(g, w, h) {   // ink-wash landscape on old silk, gold-leaf clouds
  var R = FIG.rng(17), grd = g.createLinearGradient(0, 0, 0, h); grd.addColorStop(0, '#6e5e47'); grd.addColorStop(1, '#4c3f2e'); g.fillStyle = grd; g.fillRect(0, 0, w, h);
  function ridge(base, amp, sc, ph) { var pts = []; for (var x = 0; x <= w; x += 4) { var t = x / w, y = base - amp * (0.55 * Math.sin(t * sc + ph) + 0.3 * Math.sin(t * sc * 2.3 + ph * 1.7) + 0.15 * Math.sin(t * sc * 5.1 + ph * 0.3)); pts.push([x, y]); } return pts; }
  [[0.42, 0.22, 9, 1, '#857761', 0.55], [0.55, 0.2, 13, 2, '#5d5242', 0.7], [0.7, 0.16, 17, 4, '#3b3328', 0.85], [0.86, 0.1, 23, 5, '#28221b', 0.95]].forEach(function (L) {
    var pts = ridge(L[0] * h, L[1] * h, L[2], L[3]);
    g.beginPath(); g.moveTo(0, h); pts.forEach(function (p) { g.lineTo(p[0], p[1]); }); g.lineTo(w, h); g.closePath();
    var gr = g.createLinearGradient(0, L[0] * h - L[1] * h, 0, L[0] * h + 0.12 * h); gr.addColorStop(0, L[4]); gr.addColorStop(1, 'rgba(110,94,71,0)');
    g.globalAlpha = L[5]; g.fillStyle = gr; g.fill(); g.globalAlpha = 1;
    // pines along the nearer ridges
    // (the pines were removed on request; their random draws are kept so the clouds stay exactly where they were)
    if (L[0] > 0.6) for (var k = 0; k < 40; k++) { R(); R(); }
  });
  // The screen shows this painting upside down on its dark lacquer-like face, which the user likes: the clouds read as lotus
  // leaves at the bottom. Kept that way; only the sun and the pines are gone, and the leaves have very slightly softer edges.
  g.fillStyle = 'rgba(214,176,92,0.35)'; g.filter = 'blur(1.2px)';   // gold-leaf clouds (the 'lotus leaves')
  for (var k = 0; k < 9; k++) { var x = R() * w, y = (0.12 + R() * 0.25) * h; for (var j = 0; j < 5; j++) { g.beginPath(); g.ellipse(x + j * 28, y + Math.sin(j) * 6, 40, 12, 0, 0, 6.3); g.fill(); } }
  g.filter = 'none';
  g.strokeStyle = 'rgba(30,25,20,0.5)'; g.lineWidth = 2; for (k = 0; k < 7; k++) { var bx = w * (0.3 + R() * 0.2), by = h * (0.2 + R() * 0.1); g.beginPath(); g.moveTo(bx - 8, by); g.quadraticCurveTo(bx - 3, by - 5, bx, by); g.quadraticCurveTo(bx + 3, by - 5, bx + 8, by); g.stroke(); }
  noiseFill(g, w, h, 14);
}
// Song: a monumental ink landscape (山水) in the Northern Song manner — a tall central massif with flanking peaks, mist
// between the layers, texture strokes (皴) and a few trees; drawn flipped so the screen shows it the right way up
function paintScreenSong(g, w, h) {
  g.translate(0, h); g.scale(1, -1);
  var R = FIG.rng(23), grd = g.createLinearGradient(0, 0, 0, h); grd.addColorStop(0, '#7a6a51'); grd.addColorStop(1, '#5e503c'); g.fillStyle = grd; g.fillRect(0, 0, w, h);
  function peak(cx, top, wd, base, col, a) {   // a rounded massif: noisy outline, ink dark at the top fading into mist below
    g.beginPath(); g.moveTo(cx - wd, base);
    for (var t = 0; t <= 1.0001; t += 0.02) { var x = cx - wd + 2 * wd * t, e = Math.sin(Math.PI * t), y = base - (base - top) * Math.pow(e, 1.6) * (1 + 0.08 * Math.sin(t * 37 + cx) + 0.05 * Math.sin(t * 91 + cx)); g.lineTo(x, y); }
    g.lineTo(cx + wd, base); g.closePath(); var gr = g.createLinearGradient(0, top, 0, base); gr.addColorStop(0, col); gr.addColorStop(0.75, 'rgba(94,80,60,0.4)'); gr.addColorStop(1, 'rgba(94,80,60,0)');
    g.globalAlpha = a; g.fillStyle = gr; g.fill(); g.globalAlpha = 1;
    g.strokeStyle = 'rgba(25,20,15,0.35)'; g.lineWidth = 1.5; for (var k = 0; k < wd / 6; k++) { var sx = cx + (R() - 0.5) * wd * 1.2, sy = top + (base - top) * (0.1 + R() * 0.5); if (Math.abs(sx - cx) > wd * (1 - (sy - top) / (base - top)) * 0.8) continue; g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + (R() - 0.5) * 4, sy + 8 + R() * 14); g.stroke(); }
  }
  [[0.2, 0.42, 0.13, 0.78, '#6c5f4c', 0.5], [0.82, 0.38, 0.15, 0.8, '#6c5f4c', 0.5], [0.5, 0.08, 0.17, 0.8, '#2c261e', 0.9], [0.36, 0.3, 0.1, 0.82, '#3a3227', 0.8], [0.66, 0.26, 0.11, 0.82, '#3a3227', 0.8], [0.12, 0.6, 0.12, 0.95, '#2a241c', 0.85], [0.9, 0.62, 0.1, 0.95, '#2a241c', 0.85]]
    .forEach(function (P) { peak(P[0] * w, P[1] * h, P[2] * w, P[3] * h, P[4], P[5]); });
  g.fillStyle = 'rgba(150,135,110,0.25)'; g.filter = 'blur(18px)'; for (var k = 0; k < 6; k++) g.fillRect(R() * w * 0.8, h * (0.62 + R() * 0.15), w * 0.3, h * 0.05); g.filter = 'none';   // mist
  g.strokeStyle = 'rgba(28,22,16,0.7)'; g.lineWidth = 2; for (k = 0; k < 14; k++) { var tx = w * (0.05 + R() * 0.9), ty = h * (0.88 + R() * 0.06); g.beginPath(); g.moveTo(tx, ty); g.lineTo(tx + (R() - 0.5) * 6, ty - 26 - R() * 20); g.stroke(); for (var j = 0; j < 4; j++) { g.beginPath(); g.arc(tx + (R() - 0.5) * 14, ty - 24 - j * 8, 6 + R() * 4, 0, 6.3); g.fillStyle = 'rgba(30,26,20,0.35)'; g.fill(); } }
  g.setTransform(1, 0, 0, 1, 0, 0); noiseFill(g, w, h, 14);
}
function buildProps() {
  var tex = canvasTex(3072, 1024, STYLE === 'song' ? paintScreenSong : paintScreen, false), panels = [], frames = [], n = 6, pw = 0.52, ph = 1.85, z0 = -1.25;
  for (var i = 0; i < n; i++) {
    var xa = (i - n / 2) * pw, xb = xa + pw, za = z0 + (i % 2 ? 0.12 : 0), zb = z0 + (i % 2 ? 0 : 0.12), u0 = i / n, u1 = (i + 1) / n;
    panels.push([[xa, 0.06, za], [xb, 0.06, zb], [xb, ph, zb], [xa, ph, za], [[u0, 0], [u1, 0], [u1, 1], [u0, 1]]]);
    var cx = (xa + xb) / 2, cz = (za + zb) / 2;
    boxQuads([xa, ph / 2 + 0.03, za], [0.018, ph / 2 + 0.03, 0.022], frames); boxQuads([cx, ph + 0.03, cz], [pw / 2, 0.02, 0.03], frames); boxQuads([cx, 0.04, cz], [pw / 2, 0.04, 0.03], frames);
  }
  boxQuads([n / 2 * pw, ph / 2 + 0.03, z0 + (n % 2 ? 0.12 : 0)], [0.018, ph / 2 + 0.03, 0.022], frames);
  scene.items.push({ g: upload(quadMesh(panels)), prog: 'screen', world: true, set: function (pr) { gl.activeTexture(gl.TEXTURE2); gl.bindSampler(2, null); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(pr.u.uTex, 2); } });
  scene.items.push({ g: upload(quadMesh(frames)), prog: 'plain', world: true, set: plainSet({ alb: [0.05, 0.012, 0.01], rough: 0.3, metal: 0 }) });
  // lamp stands (燈檠) carrying a framed silk lantern: a turned bronze stand, a wooden frame (corner posts, top and
  // bottom rails, a cap), silk panels glowing from inside and an oil-lamp flame — the point light sits at the flame
  LAMPS.forEach(function (L, li) {
    var x = L[0], z = L[1], bronze = [], wood = [], silk = [], flame;
    bronze.push(lathe([[0, 0.0], [0.13, 0.0], [0.13, 0.018], [0.1, 0.03], [0.05, 0.05], [0.03, 0.09], [0.014, 0.11], [0.012, 0.6], [0.02, 0.62], [0.012, 0.64], [0.011, 1.12], [0.03, 1.14], [0.07, 1.15], [0.075, 1.16], [0, 1.16]], [x, 0, z], 28));
    bronze.push(lathe([[0, 1.165], [0.035, 1.165], [0.045, 1.185], [0.04, 1.19], [0.03, 1.175], [0, 1.175]], [x, 0, z], 20));   // oil dish
    var hw = 0.11, y0 = 1.17, y1 = 1.45, pw = 0.007, pq = [];
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (c) { boxQuads([x + c[0] * hw, (y0 + y1) / 2, z + c[1] * hw], [pw, (y1 - y0) / 2 + 0.012, pw], pq); });   // corner posts
    [y0, y1].forEach(function (y) { boxQuads([x, y, z + hw], [hw, 0.008, pw * 0.8], pq); boxQuads([x, y, z - hw], [hw, 0.008, pw * 0.8], pq); boxQuads([x + hw, y, z], [pw * 0.8, 0.008, hw], pq); boxQuads([x - hw, y, z], [pw * 0.8, 0.008, hw], pq); });   // rails
    boxQuads([x, y1 + 0.02, z], [hw + 0.018, 0.008, hw + 0.018], pq); boxQuads([x, y1 + 0.034, z], [hw * 0.55, 0.008, hw * 0.55], pq);   // cap
    wood.push(quadMesh(pq));
    var sv = [[0, 0], [1, 0], [1, 1], [0, 1]], e = hw - 0.002;
    silk.push([[x - e, y0, z + e], [x + e, y0, z + e], [x + e, y1, z + e], [x - e, y1, z + e], sv], [[x + e, y0, z - e], [x - e, y0, z - e], [x - e, y1, z - e], [x + e, y1, z - e], sv],
      [[x + e, y0, z + e], [x + e, y0, z - e], [x + e, y1, z - e], [x + e, y1, z + e], sv], [[x - e, y0, z - e], [x - e, y0, z + e], [x - e, y1, z + e], [x - e, y1, z - e], sv]);
    flame = lathe([[0, 1.18], [0.005, 1.188], [0.0065, 1.2], [0.005, 1.215], [0.0025, 1.232], [0, 1.245]], [x, 0, z], 14, true);
    var ph = li * 2.1;
    scene.items.push({ g: upload(mergeMeshes(bronze)), prog: 'plain', world: true, set: plainSet({ alb: [0.55, 0.38, 0.2], rough: 0.38, metal: 1 }) });
    scene.items.push({ g: upload(mergeMeshes(wood)), prog: 'plain', world: true, set: plainSet({ alb: [0.07, 0.02, 0.012], rough: 0.4, metal: 0 }) });
    scene.items.push({ g: upload(quadMesh(silk)), prog: 'silk', world: true, cast: false, set: function (pr) { gl.uniform3fv(pr.u.uAlb, [1.0, 0.58, 0.28]); gl.uniform1f(pr.u.uEmit, 2.4); gl.uniform1f(pr.u.uPh, ph); } });
    scene.items.push({ g: upload(flame), prog: 'flame', world: true, cast: false, set: function (pr) { gl.uniform1f(pr.u.uPh, ph); } });
  });
}

/* ================= scene ================= */
var DECP = null, P = {}, scene = { items: [] }, fig = null, DQ = new Float32Array(NB * 8), W = 0, H = 0, T = {};
function initPrograms() {
  P.skin = program(VS, FS_SKIN); P.eye = program(VS, FS_EYE); P.hair = program(VS, FS_HAIR); P.cloth = program(VS, FS_CLOTH); P.petal = program(VS, FS_PETAL); P.emit = program(VS, FS_EMIT); P.silk = program(VS, FS_SILK); P.flame = program(VS, FS_FLAME); P.screen = program(VS, FS_SCREEN); P.plain = program(VS, FS_PLAIN); P.floor = program(VS, FS_FLOOR); P.shadow = program(VS_SH, FS_SH);
  P.down = program(VS_Q, FS_DOWN); P.id = program(VS, 'uniform vec3 uId; out vec4 oC; void main() { oC = vec4(uId, 1.0); }'); P.line = program('layout(location=0) in vec3 aP; layout(location=1) in vec4 aC; uniform mat4 uVP; out vec4 vC; void main() { vC = aC; gl_Position = uVP * vec4(aP, 1.0); gl_PointSize = 6.0; }', 'in vec4 vC; out vec4 oC; void main() { oC = vC; }'); P.up = program(VS_Q, FS_UP); P.comp = program(VS_Q, FS_COMP);
  var q = gl.createVertexArray(); gl.bindVertexArray(q); var b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  P.quad = q;
}
function initTargets() {
  var dpr = VIDEO ? +(Q.ss || 2) : Math.min(window.devicePixelRatio || 1, 2);
  W = Math.round(canvas.clientWidth * dpr); H = Math.round(canvas.clientHeight * dpr); canvas.width = W; canvas.height = H;
  T.msaa = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, T.msaa);
  var samples = Math.min(VIDEO ? +(Q.msaa || 8) : 4, gl.getParameter(gl.MAX_SAMPLES));
  var cr = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, cr); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA16F, W, H);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, cr);
  var dr = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, dr); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, W, H);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, dr);
  T.scene = tex2D(W, H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT); T.sceneF = fbo(T.scene);
  T.bloom = []; var w = W, h = H;
  for (var i = 0; i < 5; i++) { w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); var t = tex2D(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT); T.bloom.push({ t: t, f: fbo(t), w: w, h: h }); }
  if (!T.sh) {
    T.shN = VIDEO ? Math.min(+(Q.shadow || 4096), gl.getParameter(gl.MAX_TEXTURE_SIZE)) : 2048; T.sh = tex2D(T.shN, T.shN, gl.DEPTH_COMPONENT32F, gl.DEPTH_COMPONENT, gl.FLOAT, null, gl.NEAREST); T.shF = fbo(null, T.sh);
    T.sampCmp = gl.createSampler(); gl.samplerParameteri(T.sampCmp, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE); gl.samplerParameteri(T.sampCmp, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.samplerParameteri(T.sampCmp, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.samplerParameteri(T.sampCmp, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.samplerParameteri(T.sampCmp, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.samplerParameteri(T.sampCmp, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    T.sampRaw = gl.createSampler(); gl.samplerParameteri(T.sampRaw, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.samplerParameteri(T.sampRaw, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.samplerParameteri(T.sampRaw, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.samplerParameteri(T.sampRaw, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
}
// lamps on the floor ([x, z]); the first one is the fill light
var LAMPS = [[1.9, 0.6], [-1.45, -1.15]], TNOW = 0;
// lights: key lantern (front-left, shadowed), fill (the lamp on the right, at its flame), rim (behind-right)
var LIGHTS = [
  { p: [-1.5, 2.45, 2.3], c: [1.0, 0.78, 0.58], i: 15, at: [0, 1.15, 0], cone: [0.82, 0.93] },
  { p: [1.9, 1.215, 0.6], c: [1.0, 0.7, 0.45], i: 2.6, at: [0, 1.2, 0], cone: [-0.2, 0.2], flick: 0 },
  { p: [1.0, 2.3, -2.2], c: [0.75, 0.80, 1.0], i: 6, at: [0, 1.3, 0], cone: [0.75, 0.92] }];
function lightUniforms(pr) {
  var lp = [], lc = [], ld = [], lk = [];
  LIGHTS.forEach(function (L) { lp.push.apply(lp, L.p); lc.push.apply(lc, L.c.map(function (x) { return x * L.i * (L.flick != null ? flick(TNOW, L.flick) : 1); })); ld.push.apply(ld, V.norm(V.sub(L.at, L.p))); lk.push.apply(lk, L.cone); });
  gl.uniform3fv(pr.u.uLP, lp); gl.uniform3fv(pr.u.uLC, lc); gl.uniform3fv(pr.u.uLD, ld); gl.uniform2fv(pr.u.uLK, lk);
}

/* ================= camera ================= */
var cam = { tgt: [0, 1.0, 0], az: 0, el: 4, dist: 4.2, fov: 28 };
var PRESETS = {
  full: { tgt: [0, 0.95, 0], az: 0, el: 3, dist: 4.6, fov: 28 },
  medium: { tgt: [0, 1.28, 0], az: 0, el: 2, dist: 2.2, fov: 28 },
  face: { tgt: [0, 1.49, 0.02], az: 0, el: 0, dist: 0.62, fov: 26 },
  hands: { tgt: [0.45, 1.0, 0.05], az: 20, el: 10, dist: 0.8, fov: 28 },
  hair: { tgt: [0, 1.62, 0], az: 30, el: 15, dist: 0.9, fov: 28 },
  neck: { tgt: [0, 1.36, 0.0], az: 0, el: 5, dist: 0.9, fov: 28 }
};
function setCam(o) {
  var p = PRESETS[o.cam] || {};
  ['tgt', 'az', 'el', 'dist', 'fov'].forEach(function (k) { if (p[k] !== undefined) cam[k] = p[k]; });
  if (o.az != null) cam.az = +o.az; if (o.el != null) cam.el = +o.el; if (o.dist != null) cam.dist = +o.dist; if (o.fov != null) cam.fov = +o.fov;
  if (o.tx != null) cam.tgt = [+o.tx, +o.ty, +o.tz];
}
function camMatrices(jit) {
  var a = cam.az * Math.PI / 180, e = cam.el * Math.PI / 180, eye = [cam.tgt[0] + cam.dist * Math.sin(a) * Math.cos(e), cam.tgt[1] + cam.dist * Math.sin(e), cam.tgt[2] + cam.dist * Math.cos(a) * Math.cos(e)];
  var near = Math.max(0.05, cam.dist * 0.35), far = cam.dist + 12;
  var pr = persp(cam.fov * Math.PI / 180, W / H, near, far), vw = lookAt(eye, cam.tgt, [0, 1, 0]);
  return { vp: mmul(pr, vw), eye: eye, jit: jit || [0, 0] };
}

/* ================= frame ================= */
function setCommon(pr, C, SM) {
  gl.useProgram(pr.p);
  gl.uniformMatrix4fv(pr.u.uVP, false, C.vp); if (pr.u.uCam) gl.uniform3fv(pr.u.uCam, C.eye); if (pr.u.uCamV) gl.uniform3fv(pr.u.uCamV, C.eye);
  if (pr.u.uJit) gl.uniform2fv(pr.u.uJit, C.jit);
  if (pr.u.uDQ) gl.uniform4fv(pr.u.uDQ, DQ);
  if (pr.u.uLP) lightUniforms(pr);
  if (pr.u.uTime) gl.uniform1f(pr.u.uTime, TNOW);
  if (pr.u.uSM) { gl.uniformMatrix4fv(pr.u.uSM, false, SM); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.sh); gl.bindSampler(0, T.sampCmp); gl.uniform1i(pr.u.uShC, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, T.sh); gl.bindSampler(1, T.sampRaw); gl.uniform1i(pr.u.uShD, 1); }
  if (pr.u.uO && fig) gl.uniform3fv(pr.u.uO, fig.sk.O);
  if (pr.u.uMouth) gl.uniform3fv(pr.u.uMouth, FIG.mouth());
  if (pr.u.uEyeC) gl.uniform3fv(pr.u.uEyeC, FIG.eyeC());
  if (pr.u.uIsLash) gl.uniform1f(pr.u.uIsLash, 0);
  if (pr.u.uPaintN !== undefined) {
    var PS = PAINT, n = PS.tex && PS.on ? PS.slots.length : 0;
    gl.uniform1i(pr.u.uPaintN, n); gl.uniform1f(pr.u.uLipTone, PS.tone.lip); gl.uniform1f(pr.u.uCavity, PS.tone.cavity); gl.uniform1f(pr.u.uFlat, PS.flat ? 1 : 0);
    gl.activeTexture(gl.TEXTURE7); gl.bindSampler(7, null); gl.bindTexture(gl.TEXTURE_2D_ARRAY, PS.tex || PS.dummy || (PS.dummy = paintTex(1, 1, 1))); gl.uniform1i(pr.u.uPaint, 7);
    if (n) { var pl = new Float32Array(32); PS.slots.forEach(function (sl, i) { pl.set([sl.layer, sl.visible ? sl.opacity : 0, sl.blend === 'multiply' ? 1 : 0, sl.gloss || 0], i * 4); }); gl.uniform4fv(pr.u.uPL, pl); gl.uniform4fv(pr.u.uPaintProj, PS.proj); }
  }
  if (pr.u.uMakeup) gl.uniform1f(pr.u.uMakeup, 1);
  if (pr.u.uHeatBone) gl.uniform1i(pr.u.uHeatBone, -1);
  if (pr.u.uNDec !== undefined && DECP) { gl.uniform1i(pr.u.uNDec, DECP.n); gl.uniform4fv(pr.u.uDc, DECP.c); gl.uniform4fv(pr.u.uDu, DECP.u); gl.uniform4fv(pr.u.uDv, DECP.v); gl.uniform4fv(pr.u.uDn, DECP.nn); gl.uniform4fv(pr.u.uDcol, DECP.col); gl.uniform4fv(pr.u.uDp, DECP.p); }
}
function renderIds(jit) {   // object-id image (flat colour per mesh) for the z-fighting jitter test
  var C = camMatrices(jit);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  scene.items.forEach(function (it, i) {
    if (it.thin || !vis(it)) return;   // sub-pixel cards (strands, lashes) alias under jitter without any depth conflict
    var pr = P.id, k = i + 1; setCommon(pr, C, null); gl.uniform1i(pr.u.uWorld, it.world ? 1 : 0);
    gl.uniform3f(pr.u.uId, ((k * 37) % 8) / 7, ((k * 11) % 8) / 7, (Math.floor(k / 8) % 8) / 7);
    if (it.cull) { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); } else gl.disable(gl.CULL_FACE);
    draw(it.g);
  });
  gl.disable(gl.CULL_FACE);
}
function render(jit, overlay) {
  var C = camMatrices(jit), L = LIGHTS[0];
  // shadow map from the key light
  var SM = mmul(persp(2 * Math.acos(L.cone[0]) * 0.75, 1, 1.2, 6.0), lookAt(L.p, L.at, [0, 1, 0]));
  gl.bindFramebuffer(gl.FRAMEBUFFER, T.shF); gl.viewport(0, 0, T.shN, T.shN); gl.clear(gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
  gl.colorMask(false, false, false, false);
  setCommon(P.shadow, { vp: SM, eye: L.p, jit: [0, 0] });
  scene.items.forEach(function (it) { if (it.cast !== false && vis(it)) { gl.uniform1i(P.shadow.u.uWorld, it.world ? 1 : 0); draw(it.g); } });
  gl.colorMask(true, true, true, true);
  // main pass (MSAA, HDR)
  gl.bindFramebuffer(gl.FRAMEBUFFER, T.msaa); gl.viewport(0, 0, W, H); gl.clearColor(0.006, 0.004, 0.003, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  var opaque = scene.items.filter(function (it) { return !it.gauze && vis(it); }), gauze = scene.items.filter(function (it) { return it.gauze && vis(it); });
  opaque.forEach(function (it) {
    var pr = P[it.prog]; setCommon(pr, C, SM); gl.uniform1i(pr.u.uWorld, it.world ? 1 : 0);
    if (it.set) it.set(pr);
    if (it.cull) { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); } else gl.disable(gl.CULL_FACE);
    if (it.a2c) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    draw(it.g);
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  });
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); gl.enable(gl.CULL_FACE);
  [gl.FRONT, gl.BACK].forEach(function (face) {
    gl.cullFace(face);
    gauze.forEach(function (it) { var pr = P[it.prog]; setCommon(pr, C, SM); gl.uniform1i(pr.u.uWorld, it.world ? 1 : 0); if (it.set) it.set(pr); draw(it.g); });
  });
  gl.depthMask(true); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
  // resolve, bloom, composite
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, T.msaa); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, T.sceneF);
  gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.bindVertexArray(P.quad);
  var src = T.scene, sw = W, shh = H;
  gl.useProgram(P.down.p);
  T.bloom.forEach(function (b, i) { gl.bindFramebuffer(gl.FRAMEBUFFER, b.f); gl.viewport(0, 0, b.w, b.h); gl.activeTexture(gl.TEXTURE0); gl.bindSampler(0, null); gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(P.down.u.uT, 0); gl.uniform2f(P.down.u.uPx, 0.5 / sw, 0.5 / shh); gl.uniform1f(P.down.u.uFirst, i === 0 ? 1 : 0); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); src = b.t; sw = b.w; shh = b.h; });
  gl.useProgram(P.up.p); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
  for (var i = T.bloom.length - 1; i > 0; i--) { var a = T.bloom[i], b = T.bloom[i - 1]; gl.bindFramebuffer(gl.FRAMEBUFFER, b.f); gl.viewport(0, 0, b.w, b.h); gl.bindTexture(gl.TEXTURE_2D, a.t);
    gl.uniform1i(P.up.u.uT, 0); gl.uniform2f(P.up.u.uPx, 1 / a.w, 1 / a.h); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); }
  gl.disable(gl.BLEND);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H); gl.useProgram(P.comp.p);
  [T.scene, T.bloom[0].t, T.bloom[1].t, T.bloom[2].t].forEach(function (t, i) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindSampler(i, null); gl.bindTexture(gl.TEXTURE_2D, t); });
  gl.uniform1i(P.comp.u.uT, 0); gl.uniform1i(P.comp.u.uB0, 1); gl.uniform1i(P.comp.u.uB1, 2); gl.uniform1i(P.comp.u.uB2, 3); gl.uniform1f(P.comp.u.uExp, 1.0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  if (overlay) overlay(C);
}

/* ================= pose → dual quaternions ================= */
function setPoseDQ(q, p) {   // q, p: world rotation/position per bone
  fig.sk.bones.forEach(function (b, i) {
    var r = q[i], t = V.sub(p[i], FIG.qrot(r, b.p)), d = FIG.qmul([t[0], t[1], t[2], 0], r);
    DQ.set([r[0], r[1], r[2], r[3], d[0] * 0.5, d[1] * 0.5, d[2] * 0.5, d[3] * 0.5], i * 8);
  });
}
function bindPose() { var q = [], p = []; fig.sk.bones.forEach(function (b) { q.push([0, 0, 0, 1]); p.push(b.p); }); setPoseDQ(q, p); }

function clothSet(tex, tile, gauze, sheen, tint, rough, band, alpha, trim) {
  return function (pr) { gl.uniform4fv(pr.u.uTrim, trim || [0, 0, 0, 0]); gl.activeTexture(gl.TEXTURE3); gl.bindSampler(3, null); gl.bindTexture(gl.TEXTURE_2D, TEX.trim || tex); gl.uniform1i(pr.u.uTrimTex, 3);   // (always a colour texture on unit 3: unit 0 holds the shadow map)
    gl.activeTexture(gl.TEXTURE2); gl.bindSampler(2, null); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(pr.u.uTex, 2); gl.uniform2fv(pr.u.uTile, tile);
    gl.uniform1f(pr.u.uGauze, gauze); gl.uniform1f(pr.u.uSheen, sheen); gl.uniform3fv(pr.u.uTint, tint); gl.uniform1f(pr.u.uRough, rough); gl.uniform1f(pr.u.uBand, band || 0); gl.uniform1f(pr.u.uAlpha, alpha == null ? 1 : alpha); };
}
// sewn garments (fig.garb, cloth_sim): one render mesh per piece, its panels' vertices carrying their pattern (2D) uv in
// metres (the band: fraction around × height, for its repeating border); positions and normals copied from the cloth
function buildGarb() {
  var G = fig.garb, MATG = { skirt: [TEX.skirt, [0.22, 0.22], 0, 0.7, [1, 1, 1], 0.6, 0, 1], robe: [TEX.gauze, [0.3, 0.3], 1, 0.5, [0.95, 0.93, 0.9], 0.5, 0, 0.2],
    shawl: [TEX.shawl, [0.25, 0.25], 1, 0.9, [1, 1, 1], 0.45, 0, 0.5], sash: [TEX.sash, [0.032, 0.3], 0, 0.8, [1, 1, 1], 0.45, 0, 1], band: [TEX.band, [1, 1], 0, 0.8, [1, 1, 1], 0.55, 1, 1] };
  if (STYLE === 'song') { var GS = DEF.costume.song.garments, cuff = GS.robe ? GS.robe.sleeve.len - 0.028 : 0;   // Song: the old materials (opaque 褙子 with 領抹 edge bands and cuffs, pleated skirt, rose 抹胸)
    MATG = { skirt: [TEX.skirtSong, [0.035, 0.6], 0, 0.6, [1, 1, 1], 0.6, 0, 1], robe: [TEX.beizi, [0.26, 0.26], 0, 0.75, [1, 1, 1], 0.5, 0, 1, [0.026, -9, 0, 1]], sleeve: [TEX.beizi, [0.26, 0.26], 0, 0.75, [1, 1, 1], 0.5, 0, 1, [-1, -1, cuff, 1]],
      sash: [TEX.sashSong, [0.03, 0.3], 0, 0.8, [1, 1, 1], 0.45, 0, 1], band: [TEX.bandSong, [1, 1], 0, 0.85, [1, 1, 1], 0.45, 1, 1], belt: [TEX.belt || (TEX.belt = beltTex(DEF.costume.song.belt)), [1, 1], 0, 0.9, [1, 1, 1], 0.45, 1, 1] }; }
  G.render = [];
  Object.keys(G.pieces).forEach(function (name) {
    var map = [], uv = [], idx = [];
    G.pieces[name].forEach(function (pn) {
      var o = map.length, mx = 0, my = 0; pn.uv.forEach(function (q) { mx = Math.max(mx, q[0]); my = Math.max(my, q[1]); });
      pn.uv.forEach(function (q, i) { map.push(pn.vmap[i]);
        var u = name === 'band' || name === 'belt' ? [q[0] / mx, 1 - q[1] / my] : /^sleeve/.test(name) ? [q[1], q[0]] : name === 'shawl' ? [q[0], q[1]] : [q[0], -q[1]]; uv.push(u[0], u[1], pn.edge ? pn.edge[i] : 9, 0); });
      for (var k = 0; k < pn.tris.length; k++) idx.push(pn.tris[k] + o);
    });
    var m = { pos: new Float32Array(map.length * 3), nrm: new Float32Array(map.length * 3), idx: new Uint32Array(idx), uv: new Float32Array(uv) }, g = upload(m, true);
    var mt = MATG[/^sleeve/.test(name) && MATG.sleeve ? 'sleeve' : /^(robe|sleeve)/.test(name) ? 'robe' : /^sash/.test(name) ? 'sash' : name];
    GARMENTS.push(name); scene.items.push({ garment: name, g: g, prog: 'cloth', world: true, gauze: !!mt[2], cast: !mt[2], set: clothSet(mt[0], mt[1], mt[2], mt[3], mt[4], mt[5], mt[6], mt[7], mt[8]) });
    G.render.push({ map: new Int32Array(map), m: m, g: g });
  });
  if (G.knot.length === 2) { var km = FIG.knotMesh((DEF.costume[COST].garments.sash || {}).knot), m2 = { pos: new Float32Array(km.pos.length), nrm: new Float32Array(km.pos.length), idx: km.idx };
    G.knotM = { L: km.pos, LN: km.nrm, m: m2, g: upload(m2, true) }; scene.items.push({ garment: 'sashKnot', g: G.knotM.g, prog: 'plain', world: true, cull: true, set: plainSet(MATS[(DEF.costume[COST].sash || {}).knotMat] || MATS.sashKnot) }); GARMENTS.push('sashKnot'); }
  fig.gsim = new FIG.GSim(fig);
}
function garbUpload(P, N) {
  var G = fig.garb; G.shown = P;
  G.render.forEach(function (r) { var M = r.map, pos = r.m.pos, nrm = r.m.nrm; for (var i = 0; i < M.length; i++) { var j = M[i] * 3; pos[i * 3] = P[j]; pos[i * 3 + 1] = P[j + 1]; pos[i * 3 + 2] = P[j + 2]; nrm[i * 3] = N[j]; nrm[i * 3 + 1] = N[j + 1]; nrm[i * 3 + 2] = N[j + 2]; } r.g.update(pos, nrm); });
  if (G.jade) G.jadeState = FIG.jadeFrame(P, G.jade);
  var K = G.knotM; if (K) { var f = FIG.knotFrame(P, N, G.knot); for (var i = 0; i < K.L.length; i += 3) for (var k = 0; k < 3; k++) {
    K.m.pos[i + k] = f.o[k] + f.x[k] * K.L[i] + f.y[k] * K.L[i + 1] + f.z[k] * K.L[i + 2]; K.m.nrm[i + k] = f.x[k] * K.LN[i] + f.y[k] * K.LN[i + 1] + f.z[k] * K.LN[i + 2]; } K.g.update(K.m.pos, K.m.nrm); }
}
// shots and video: the deterministic cloth (FIG.GSim, stepped in full). Live: the same state handed to a ClothAsync (a worker);
// each frame posts the pose at t and shows the latest result, with the body drawn at that result's time (carried in the
// colliders), so cloth and skin stay in sync. A jump in time (new poem, replay) re-warms.
var CA = null, caT = 0, TC = 0, TRACE = null;
// live jitter trace (tool/smoke.js jitter): per displayed frame, how far each cloth particle moved (d1) and its second
// difference (d2 = x − 2x' + x'': what reads as shaking), over the particles that are not pinned
function traceFrame() {
  var P = fig.garb && fig.garb.shown; if (!P) return; var T = TRACE, n = P.length / 3;
  if (T.p1 && T.p2) { var s1 = 0, s2 = 0, m2 = 0, d2s = [];
    for (var i = 0; i < n; i++) { var a = 0, b = 0; for (var k = 0; k < 3; k++) { var j = i * 3 + k, u = P[j] - T.p1[j], w = P[j] - 2 * T.p1[j] + T.p2[j]; a += u * u; b += w * w; } a = Math.sqrt(a); b = Math.sqrt(b); s1 += a; s2 += b; if (b > m2) m2 = b; if (i % 7 === 0) d2s.push(b); }
    d2s.sort(function (x, y) { return x - y; }); T.rows.push([s1 / n, s2 / n, d2s[Math.floor(d2s.length * 0.99)], m2, TC]); }
  T.p2 = T.p1; T.p1 = new Float32Array(P);
  var C = fig.garb.shownCaps, sh = fig.garb.pieces.shawl; if (!C || !sh) return; T.caps = T.caps || fig.garb.coll.caps.map(function (c, i) { return /^(thumb|index|middle|ring|pinky|hand|palm|knuckles)/.test(c.name) ? i : -1; }).filter(function (i) { return i >= 0; });
  sh.forEach(function (pn) { for (var k = 0; k < pn.tris.length; k += 3) { var a = pn.vmap[pn.tris[k]] * 3, b = pn.vmap[pn.tris[k + 1]] * 3, c = pn.vmap[pn.tris[k + 2]] * 3, x = (P[a] + P[b] + P[c]) / 3, y = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, z = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    T.caps.forEach(function (ci) { var o = ci * 7, ax = C[o], ay = C[o + 1], az = C[o + 2], bx = C[o + 3] - ax, by = C[o + 4] - ay, bz = C[o + 5] - az, l2 = bx * bx + by * by + bz * bz, s = l2 > 1e-12 ? Math.max(0, Math.min(1, ((x - ax) * bx + (y - ay) * by + (z - az) * bz) / l2)) : 0;
      var d = Math.hypot(x - ax - bx * s, y - ay - by * s, z - az - bz * s) - C[o + 6]; if (d < -0.001) { var nm = fig.garb.coll.caps[ci].name; T.pierce[nm] = Math.max(T.pierce[nm] || 0, -d); } }); } });
}
function clothRewarm(t) {
  var gs = fig.gsim; gs.reset(poseAt, Math.max(0, t - 2)); gs.advance(poseAt, t);
  if (CA) CA.dispose();
  CA = new CLOTH.ClothAsync(Object.assign({}, fig.garb.mesh, { positions: new Float32Array(gs.cloth.positions) }), Object.assign({}, fig.garb.params, { noise: 0 }), new URL('cloth_sim/clothworker.js?v=' + FIG.BUILD_VERSION, location.href));   // (versioned: no stale solver from the cache)
  CA.reset(gs.caps, gs.pinT, 0); caT = TC = t; garbUpload(gs.cloth.positions, gs.cloth.computeNormals());
}
function clothAdvance(t) {
  var gs = fig.gsim;
  if (SHOT) { gs.advance(poseAt, t); fig.garb.shownCaps = gs.caps; garbUpload(gs.cloth.positions, gs.cloth.computeNormals()); return t; }
  if (!CA || t < caT - 1e-3 || t - caT > 1) clothRewarm(t);
  // fixed 1/60 s steps at their own pose times, one in flight at a time (XPBD's stiffness depends on the step: the audio
  // clock's uneven frame times made the cloth pulse); if the worker falls behind, the cloth time skips ahead
  if (CA.ready && !CA.busy && t > caT + 0.5 * FIG.GDT) { if (t - caT > 4 * FIG.GDT) caT = t - FIG.GDT; caT += FIG.GDT; gs.pose(poseAt(caT, 1), caT); CA.update(FIG.GDT, gs.caps, gs.pinT); }
  if (CA.renderColliders) { var rc = CA.renderColliders; TC = rc[rc.length - 7]; fig.garb.shownCaps = rc; garbUpload(CA.positions, CA.normals); CA.renderColliders = null; }
  return TC;
}
function updateCloth() {
  fig.parts.forEach(function (p) { if (p.ring && p.ring.g && p.ring.moved) { p.ring.g.update(p.mesh.pos, p.mesh.nrm); p.ring.moved = false; }
    if (p.sway && p.g && p.swayMoved) { p.g.update(p.mesh.pos, p.mesh.nrm); p.swayMoved = false; } });
  (fig.cloths || []).forEach(function (c) {
    if (!c.rmap) { c.mesh.pos.set(c.x); c.g.update(c.mesh.pos, FIG.vertexNormals(c.mesh.pos, c.mesh.idx)); return; }
    var n = FIG.vertexNormals(c.x, c.ptris), M = c.rmap, P = c.mesh.pos, N = c.mesh.nrm;   // normals on the particle grid (no seam)
    for (var i = 0; i < M.length; i++) { var j = M[i] * 3; P[i * 3] = c.x[j]; P[i * 3 + 1] = c.x[j + 1]; P[i * 3 + 2] = c.x[j + 2]; N[i * 3] = n[j]; N[i * 3 + 1] = n[j + 1]; N[i * 3 + 2] = n[j + 2]; }
    c.g.update(P, N);
  });
  (fig.beadMeshes || []).forEach(function (B) {
    B.list.forEach(function (e, k) { var ch = fig.chains[e[0]], b = ch.beads[e[1]], x = ch.x[e[1]];
      for (var i = 0; i < B.nvs; i++) { B.m.pos[(k * B.nvs + i) * 3] = x[0] + B.T.P[i * 3] * b.r; B.m.pos[(k * B.nvs + i) * 3 + 1] = x[1] + B.T.P[i * 3 + 1] * b.r; B.m.pos[(k * B.nvs + i) * 3 + 2] = x[2] + B.T.P[i * 3 + 2] * b.r; } });
    B.g.update(B.m.pos, B.m.nrm);
  });
  var J = fig.jadeMesh, st = fig.garments ? fig.garments.jade && fig.garments.jade.state : fig.garb && fig.garb.jadeState;   // the 玉環綬 jade ring, in the ribbons' frame
  if (J && st) { for (var i = 0; i < J.nv; i++) { var x = J.L[i * 3], y = J.L[i * 3 + 1], z = J.L[i * 3 + 2], nx = J.LN[i * 3], ny = J.LN[i * 3 + 1], nz = J.LN[i * 3 + 2];
      for (var k = 0; k < 3; k++) { J.m.pos[i * 3 + k] = st.c[k] + st.a[k] * x + st.t[k] * y + st.n[k] * z; J.m.nrm[i * 3 + k] = st.a[k] * nx + st.t[k] * ny + st.n[k] * nz; } }
    J.g.update(J.m.pos, J.m.nrm); }
}
/* ================= build ================= */
var MATS = {
  gold: { prog: 'plain', alb: [1.0, 0.8, 0.4], rough: 0.13, metal: 1 }, pearl: { prog: 'plain', alb: [0.86, 0.83, 0.78], rough: 0.22, metal: 0 },
  jade: { prog: 'plain', alb: [0.22, 0.52, 0.36], rough: 0.12, metal: 0 }, leaf: { prog: 'plain', alb: [0.07, 0.16, 0.05], rough: 0.5, metal: 0 },
  stamen: { prog: 'plain', alb: [0.85, 0.62, 0.16], rough: 0.6, metal: 0 }, teeth: { prog: 'plain', alb: [0.8, 0.77, 0.7], rough: 0.3, metal: 0 },
  tongue: { prog: 'plain', alb: [0.55, 0.2, 0.2], rough: 0.4, metal: 0 }, sashKnot: { prog: 'plain', alb: [0.05, 0.2, 0.11], rough: 0.5, metal: 0 }, shoe: { prog: 'plain', alb: [0.45, 0.08, 0.06], rough: 0.5, metal: 0 },
  lacquer: { prog: 'plain', alb: [0.035, 0.03, 0.032], rough: 0.3, metal: 0 }, ivory: { prog: 'plain', alb: [0.86, 0.83, 0.74], rough: 0.32, metal: 0 },   // (Song crown, comb, flowers)
  flowerP: { prog: 'plain', alb: [0.9, 0.56, 0.62], rough: 0.55, metal: 0 }, flowerW: { prog: 'plain', alb: [0.9, 0.88, 0.82], rough: 0.55, metal: 0 }, flowerY: { prog: 'plain', alb: [0.9, 0.68, 0.22], rough: 0.55, metal: 0 }, flowerR: { prog: 'plain', alb: [0.72, 0.12, 0.15], rough: 0.55, metal: 0 },
  cord: { prog: 'plain', alb: [0.46, 0.05, 0.06], rough: 0.32, metal: 0 },   // (red silk cord tying the hair)
  thread: { prog: 'plain', alb: [0.55, 0.12, 0.1], rough: 0.6, metal: 0 },   // (silk thread holding the ornament pearls)
  knotRed: { prog: 'plain', alb: [0.36, 0.09, 0.07], rough: 0.45, metal: 0 },
  horn: { prog: 'plain', alb: [0.86, 0.82, 0.7], rough: 0.3, metal: 0 }, jadeWhite: { prog: 'plain', alb: [0.78, 0.83, 0.74], rough: 0.16, metal: 0 },   // (Song headdresses: 白角 horn, white jade, grey-green leaves, red beads)
  jadeSpray: { prog: 'plain', alb: [0.74, 0.85, 0.72], rough: 0.17, metal: 0, trans: 0.7 },   // (the 珠翠 spray: polished white-green jade)
  leafGG: { prog: 'plain', alb: [0.4, 0.46, 0.38], rough: 0.35, metal: 0 }, coral: { prog: 'plain', alb: [0.62, 0.07, 0.05], rough: 0.28, metal: 0 }   // (the Song sash knot, the ribbons' red silk)
};
function lashSet(pr) { gl.uniform1f(pr.u.uStrand, 1); gl.uniform1f(pr.u.uIsLash, 1); gl.uniform3fv(pr.u.uLashCol, FIG.params().lashes.color || [0.012, 0.009, 0.008]); }
function plainSet(m) { return function (pr) { gl.uniform3fv(pr.u.uAlb, m.alb); gl.uniform1f(pr.u.uRough0, m.rough); gl.uniform1f(pr.u.uMetal, m.metal); gl.uniform1f(pr.u.uTrans, m.trans || 0); }; }
function sphereTemplate(seg) {   // unit sphere for the bead meshes
  var P = [], I = []; for (var j = 0; j <= seg; j++) for (var i = 0; i <= seg * 2; i++) { var th = Math.PI * j / seg, ph = Math.PI * i / seg; P.push(Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)); }
  for (j = 0; j < seg; j++) for (i = 0; i < seg * 2; i++) { var a = j * (seg * 2 + 1) + i, b = a + 1, c = a + seg * 2 + 1, d = c + 1; I.push(a, c, b, b, c, d); }
  return { P: P, I: I };
}
/* ---- painted makeup (figure.json "paint"; edited in face.html). Layers are RGBA images in a cylindrical projection of
   the head: u = angle around the vertical axis through (0, ·, cz) in head space, v = height between y0 and y1; only
   within radius rmax of that axis. Without "paint" the decals and the built-in powder are used (older files). */
var PAINT = { tex: null, on: true, flat: false, slots: [], size: [2048, 1024], proj: [-0.16, 0.12, -0.01, 0.13], tone: { lip: 0.25, cavity: 0.94 } };
function paintTex(w, h, n) { var t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D_ARRAY, t); gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, w, h, n);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; }
// set up the layers: P = figure.json "paint" (layers with .png data URLs) or {layers, size, proj, tone} with .data
// (Uint8ClampedArray) per layer; resolves when the images are uploaded
function setPaint(P) {
  if (!P || !P.layers || !P.layers.length) { PAINT.tex = null; PAINT.slots = []; return Promise.resolve(); }
  PAINT.size = P.size || [2048, 1024]; var pj = P.proj || {}; PAINT.proj = [pj.y0 != null ? pj.y0 : -0.16, pj.y1 != null ? pj.y1 : 0.12, pj.cz != null ? pj.cz : -0.01, pj.rmax || 0.13];
  PAINT.tone = { lip: P.tone && P.tone.lip != null ? P.tone.lip : 0.25, cavity: P.tone && P.tone.cavity != null ? P.tone.cavity : 0.94 };
  var w = PAINT.size[0], h = PAINT.size[1], N = P.layers.length; if (PAINT.tex) gl.deleteTexture(PAINT.tex); PAINT.tex = paintTex(w, h, N);
  PAINT.slots = P.layers.map(function (L, i) { return { name: L.name, layer: i, opacity: L.opacity != null ? L.opacity : 1, blend: L.blend || 'normal', visible: L.visible !== false, gloss: L.gloss || 0 }; });
  return Promise.all(P.layers.map(function (L, i) {
    if (L.data) { paintUpload(i, 0, 0, w, h, L.data); return null; }
    if (!L.png) return null;
    return new Promise(function (res) { var im = new Image(); im.onload = function () { var c = document.createElement('canvas'); c.width = w; c.height = h; var g = c.getContext('2d'); g.drawImage(im, 0, 0, w, h);
      paintUpload(i, 0, 0, w, h, g.getImageData(0, 0, w, h).data); res(); }; im.onerror = function () { res(); }; im.src = L.png; });
  }));
}
function paintUpload(layer, x, y, w, h, data) { gl.bindTexture(gl.TEXTURE_2D_ARRAY, PAINT.tex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, x, y, layer, w, h, 1, gl.RGBA, gl.UNSIGNED_BYTE, data); }
// decals from figure.json, optionally with a brow style previewed (?brow=guiye, or STAGE.shot({brow}))
function setBrow(style) {
  var decs = JSON.parse(JSON.stringify(DEF.decals || FIG.defaultDecals(fig.sk.O)));
  if (style) decs.forEach(function (d) { if (d.kind === 'brow') FIG.browPreset(d, style); });
  DECP = FIG.packDecals(decs);
}
function setLabel(text) {
  var lb = document.getElementById('label') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'label' }));
  lb.textContent = text; lb.style.cssText = 'position:fixed;left:18px;top:12px;font:30px/1.3 serif;color:#f0e6d8;text-shadow:0 0 6px #000;z-index:5';
}
/* ---- startup: the heavy geometry (body polygonization + skin weights, hair) is built in a worker — the page never
   freezes — and cached in IndexedDB keyed by a hash of figure.json and the geometry code version, so later loads skip it */
function hashStr(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); }
function idb(fn) {   // → Promise; resolves null if IndexedDB is unavailable
  return new Promise(function (res) {
    try { var rq = indexedDB.open('mid_ch_sing', 1); rq.onupgradeneeded = function () { rq.result.createObjectStore('builds'); };
      rq.onsuccess = function () { try { fn(rq.result, res); } catch (e) { res(null); } }; rq.onerror = function () { res(null); }; } catch (e) { res(null); }
  });
}
function progress(frac, text) {
  var el = document.getElementById('progress') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'progress' }));
  el.style.cssText = 'position:fixed;left:50%;top:50%;width:320px;margin-left:-160px;font:13px/1.6 sans-serif;color:#cbbfae;text-align:center;z-index:9;pointer-events:none';
  if (frac == null) { el.remove(); return; }
  el.innerHTML = '<div>' + text + '</div><div style="height:4px;background:rgba(255,255,255,0.12);margin-top:6px"><div style="height:4px;width:' + Math.round(frac * 100) + '%;background:#c9a46a"></div></div>';
}
// the figure: figure.<style>.json (?fig=path loads any file, e.g. an old combined figure.json), else figure.json
var FIGFILE = Q.fig || 'figure.' + STYLE + '.json';
function loadFigure(file) { file = file || FIGFILE; return fetch(file).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).catch(function (e) { if (file === 'figure.json') throw e; FIGFILE = 'figure.json'; return loadFigure('figure.json'); }); }
function prebuildGeometry(cfg) {
  var key = 'build-' + FIG.BUILD_VERSION + '-' + FIGFILE + '-' + (cfg.headOnly ? 'head-' : '') + (cfg.cloth === 'old' ? 'oldcloth-' : '') + cfg.costume + '-' + JSON.stringify(cfg.res || '') + '-' + hashStr(JSON.stringify(cfg.def));
  return idb(function (db, res) { var g = db.transaction('builds').objectStore('builds').get(key); g.onsuccess = function () { res(g.result || null); }; g.onerror = function () { res(null); }; }).then(function (hit) {
    if (hit) { progress(0.95, 'loading the cached figure…'); return hit; }
    return new Promise(function (res, rej) {
      var t0 = performance.now(), frac = 0.02, target = 0.4, label = 'building the figure (first load — it is cached afterwards)';
      var marks = [[/polygonized/, 0.42, 0.5], [/sealed/, 0.5, 0.56], [/weights/, 0.58, 0.62], [/body: \d+ verts/, 0.62, 0.98], [/hair: cap/, 1, 1]];
      var tick = setInterval(function () { frac += (target - frac) * 0.03; progress(frac, label + ' · ' + ((performance.now() - t0) / 1000).toFixed(0) + ' s'); }, 100);
      var w = new Worker(URL.createObjectURL(new Blob(["importScripts('" + new URL('figure.js', location.href) + "');\n" +
        "onmessage = function (e) { var pre = FIG.prebuild(e.data, function (s) { postMessage({ log: s }); }); var tr = []; [pre.body, pre.cap, pre.strands].forEach(function (m) { for (var k in m) if (ArrayBuffer.isView(m[k])) tr.push(m[k].buffer); }); postMessage({ pre: pre }, tr); };"], { type: 'text/javascript' })));
      w.onmessage = function (e) {
        if (e.data.log) { status(e.data.log); marks.forEach(function (m) { if (m[0].test(e.data.log)) { frac = Math.max(frac, m[1]); target = m[2]; } }); return; }
        clearInterval(tick); w.terminate(); var pre = e.data.pre;
        idb(function (db, r2) { var tx = db.transaction('builds', 'readwrite'), st = tx.objectStore('builds'); st.clear(); st.put(pre, key); tx.oncomplete = function () { r2(true); }; tx.onerror = function () { r2(false); }; });
        res(pre);
      };
      w.onerror = function (e) { clearInterval(tick); rej(e); };
      w.postMessage(cfg);
    });
  });
}
function build(pre) {
  var t0 = performance.now();
  fig = FIG.build({ def: DEF, headOnly: 'head' in Q, costume: COST, pre: pre, cloth: Q.cloth, shawl: SHAWL }, status);   // (&cloth=old: the older verlet cloth instead of the sewn garments)
  setBrow(Q.brow); if (Q.label) setLabel(Q.label);
  if (DEF.paint) setPaint(DEF.paint).then(function () { lastT = -1; });
  makeTextures();
  fig.parts.forEach(function (pt) {
    var m = pt.mesh, mat = m.mat, n0 = scene.items.length;
    if (mat && /^cord#/.test(mat) && !MATS[mat]) MATS[mat] = { prog: 'plain', alb: [1, 3, 5].map(function (i) { var c = parseInt(mat.substr(4 + i, 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }), rough: 0.32, metal: 0 };   // a cord's own colour
    if (pt.cloth) return;
    if (pt.name === 'body') scene.items.push({ g: upload(m), prog: 'skin', cull: true, part: pt });
    else if (/^eye/.test(pt.name)) scene.items.push({ g: upload(m), prog: 'eye', cull: true, set: function (pr) { gl.uniform1f(pr.u.uSide, pt.name === 'eyeL' ? 1 : -1); } });
    else if (pt.name === 'hairCap') scene.items.push({ g: upload(m), prog: 'hair', cull: true, a2c: true, set: function (pr) { gl.uniform1f(pr.u.uStrand, 0); } });
    else if (pt.name === 'hairStrands') scene.items.push({ g: upload(m), prog: 'hair', a2c: true, thin: true, set: function (pr) { gl.uniform1f(pr.u.uStrand, 1); } });
    else if (/^lashes/.test(pt.name)) {
      var nv = m.pos.length / 3, aux = new Float32Array(nv * 4), uv = new Float32Array(nv * 4);
      for (var i = 0; i < nv; i++) { aux[i * 4] = 0.0; aux[i * 4 + 1] = (m.uv[i * 4] - 0.5) * 1.6; uv.set([0, 1, 0, m.uv[i * 4 + 1] * 0.9], i * 4); }
      var mm = { pos: m.pos, nrm: m.nrm, idx: m.idx, bi: m.bi, bw: m.bw, aux: aux, uv: uv };
      scene.items.push({ g: upload(mm), prog: 'hair', a2c: true, thin: true, set: lashSet });
    }
    else if (pt.name === 'sashKnot' && (fig.cfg.def.costume[COST].sash || {}).knotCloth) scene.items.push({ g: upload(m), prog: 'cloth', cull: false, keep: true, set: clothSet(STYLE === 'song' ? TEX.sashSong : TEX.sash, [0.5, 0.5], 0, 0.8, [1, 1, 1], 0.45, 0) });   // (a knot in the ribbons' own silk)
    else if (pt.name === 'belt') scene.items.push({ g: upload(m), prog: 'cloth', cull: true, keep: true, set: clothSet(TEX.belt || (TEX.belt = beltTex(fig.cfg.def.costume[COST].belt)), [1, 1], 0, 0.9, [1, 1, 1], 0.45, 1) });
    else if (pt.name === 'band') scene.items.push({ g: upload(m), prog: 'cloth', cull: true, set: STYLE === 'song' ? clothSet(TEX.bandSong, [1, 1], 0, 0.85, [1, 1, 1], 0.45, 1) : clothSet(TEX.band, [1, 1], 0, 0.8, [1, 1, 1], 0.55, 1) });
    else if (mat === 'horn') scene.items.push({ g: upload(m), prog: 'cloth', gauze: true, cast: true, keep: true, set: clothSet(TEX.horn || (TEX.horn = hornTex()), [0.06, 0.06], 1, 0.7, [1, 1, 1], 0.3, 0, 0.62) });   // translucent white horn (白角)
    else if (mat === 'petal') { var gp = upload(m, true); pt.g = gp; scene.items.push({ g: gp, prog: 'petal', a2c: false, part: pt }); }
    else if (MATS[mat]) { var gg = upload(m, !!pt.ring || !!pt.sway); if (pt.ring) pt.ring.g = gg; if (pt.sway) pt.g = gg; scene.items.push({ g: gg, prog: 'plain', cull: !/leaf|lacquer|flower/.test(mat), set: plainSet(MATS[mat]) }); }
    if (GARMENT.test(pt.name) && scene.items.length > n0) scene.items[scene.items.length - 1].tagAs = pt.name;
  });
  scene.items.forEach(function (it) { if (it.tagAs) { it.garment = it.tagAs; GARMENTS.push(it.tagAs); delete it.tagAs; } });
  // bead chains: one dynamic mesh per material
  if (fig.chains) {
    var T = sphereTemplate(6), groups = {};
    { var TI = T.I.slice(); for (var q = 0; q < TI.length; q += 3) { var tq = TI[q + 1]; TI[q + 1] = TI[q + 2]; TI[q + 2] = tq; } T = { P: T.P, I: TI }; }   // (the template winds inward: beads face out)
    fig.chains.forEach(function (ch, ci) { ch.beads.forEach(function (b, j) { (groups[b.mat] = groups[b.mat] || []).push([ci, j]); }); });
    fig.beadMeshes = Object.keys(groups).map(function (mt) {
      var list = groups[mt], nvs = T.P.length / 3, pos = new Float32Array(list.length * nvs * 3), nrm = new Float32Array(list.length * nvs * 3), idx = [];
      list.forEach(function (e, k) { T.I.forEach(function (x) { idx.push(x + k * nvs); }); for (var i = 0; i < nvs; i++) nrm.set([T.P[i * 3], T.P[i * 3 + 1], T.P[i * 3 + 2]], (k * nvs + i) * 3); });
      var m = { pos: pos, nrm: nrm, idx: new Uint32Array(idx) }, g = upload(m, true);
      scene.items.push({ g: g, prog: 'plain', world: true, cull: true, set: plainSet(MATS[mt]) });
      return { list: list, m: m, g: g, nvs: nvs, T: T };
    });
  }
  if (fig.cloths) {
    var MAT = { skirt: [TEX.skirt, [0.22, 0.22], 0, 0.7, [1, 1, 1], 0.6, 0, 1], robe: [TEX.gauze, [0.3, 0.3], 1, 0.5, [0.95, 0.93, 0.9], 0.5, 0, 0.2],
      sleeveL: [TEX.gauze, [0.3, 0.3], 1, 0.5, [0.95, 0.93, 0.9], 0.5, 0, 0.2], sleeveR: [TEX.gauze, [0.3, 0.3], 1, 0.5, [0.95, 0.93, 0.9], 0.5, 0, 0.2],
      shawl: [TEX.shawl, [0.25, 0.25], 1, 0.9, [1, 1, 1], 0.45, 0, 0.5], sashL: [TEX.sash, [0.032, 0.3], 0, 0.8, [1, 1, 1], 0.45, 0, 1], sashR: [TEX.sash, [0.032, 0.3], 0, 0.8, [1, 1, 1], 0.45, 0, 1] };
    if (STYLE === 'song') {   // Song: opaque silk 褙子 (edge bands on the front edges and collar, cuffs on the sleeves), pleated skirt
      var CS = fig.cfg.def.costume.song, cuff = CS.sleeve.len - 0.028;
      MAT = { skirt: [TEX.skirtSong, [0.035, 0.6], 0, 0.6, [1, 1, 1], 0.6, 0, 1], robe: [TEX.beizi, [0.26, 0.26], 0, 0.75, [1, 1, 1], 0.5, 0, 1, [0.026, 0.024, 0, 1]],
        sleeveL: [TEX.beizi, [0.26, 0.26], 0, 0.75, [1, 1, 1], 0.5, 0, 1, [-1, -1, cuff, 1]], sleeveR: [TEX.beizi, [0.26, 0.26], 0, 0.75, [1, 1, 1], 0.5, 0, 1, [-1, -1, cuff, 1]],
        sashL: [TEX.sashSong, [0.03, 0.3], 0, 0.8, [1, 1, 1], 0.45, 0, 1], sashR: [TEX.sashSong, [0.03, 0.3], 0, 0.8, [1, 1, 1], 0.45, 0, 1],
        ribbonL: [TEX.sashSong, [0.034, 0.3], 0, 0.9, [1.15, 1, 1], 0.4, 0, 1], ribbonR: [TEX.sashSong, [0.034, 0.3], 0, 0.9, [1.15, 1, 1], 0.4, 0, 1] };
    }
    scene.items.forEach(function (it) { if (it.prog === 'cloth' && !it.cloth && !it.keep) it.set = STYLE === 'song' ? clothSet(TEX.bandSong, [1, 1], 0, 0.85, [1, 1, 1], 0.45, 1) : clothSet(TEX.band, [1, 1], 0, 0.8, [1, 1, 1], 0.55, 1); });
    fig.cloths.forEach(function (c) {
      var rm = c.renderMesh(), nr = rm.map ? rm.map.length : c.n; c.rmap = rm.map; c.ptris = c.tris();
      var m = { pos: new Float32Array(nr * 3), nrm: new Float32Array(nr * 3), idx: rm.idx, uv: rm.uv };
      c.mesh = m; c.g = upload(m, true); var mt = MAT[c.robe ? 'robe' : c.name];       GARMENTS.push(c.name); scene.items.push({ garment: c.name, g: c.g, prog: 'cloth', world: true, gauze: !!mt[2], cast: !mt[2], set: clothSet(mt[0], mt[1], mt[2], mt[3], mt[4], mt[5], mt[6], mt[7], mt[8]), cloth: c });
    });
  }
  if ((fig.garments && fig.garments.jade) || (fig.garb && fig.garb.jade)) {   // the jade ring (環佩): a flat annulus with rounded edges round the local z axis, placed every frame
    var JR = fig.garments ? fig.garments.jade : { R: fig.garb.jade.R0, r: fig.garb.jade.r, w: fig.garb.jade.w }, L = [], I = [], NU = 64, NVr = 16, PW = 4;
    for (var a = 0; a <= NVr; a++) for (var b = 0; b <= NU; b++) { var u = b / NU * 2 * Math.PI, w = a / NVr * 2 * Math.PI, cw = Math.cos(w), sw = Math.sin(w), ex = Math.sign(cw) * Math.pow(Math.abs(cw), 2 / PW), ez = Math.sign(sw) * Math.pow(Math.abs(sw), 2 / PW), rr = JR.R + ex * JR.w / 2;
      L.push(Math.cos(u) * rr, Math.sin(u) * rr, ez * JR.r); }   // cross-section: a rounded rectangle (band width w in the plate's plane, thickness 2r across it)
    for (a = 0; a < NVr; a++) for (b = 0; b < NU; b++) { var i0 = a * (NU + 1) + b; I.push(i0, i0 + NU + 1, i0 + 1, i0 + 1, i0 + NU + 1, i0 + NU + 2); }
    var LN = FIG.vertexNormals(new Float32Array(L), new Uint32Array(I)); if (LN[0] < 0) { for (var k2 = 0; k2 < I.length; k2 += 3) { var tq = I[k2 + 1]; I[k2 + 1] = I[k2 + 2]; I[k2 + 2] = tq; } LN = FIG.vertexNormals(new Float32Array(L), new Uint32Array(I)); }   // (outward winding: vertex 0 is on the outer rim, +x)
    var jm = { pos: new Float32Array(L.length), nrm: new Float32Array(L.length), idx: new Uint32Array(I) }, jg = upload(jm, true);
    fig.jadeMesh = { L: L, LN: LN, nv: L.length / 3, m: jm, g: jg };
    scene.items.push({ garment: 'jadeRing', g: jg, prog: 'plain', world: true, cull: true, set: plainSet(MATS.jade) }); GARMENTS.push('jadeRing');
  }
  fig.sim = new FIG.Sim(fig); if (fig.garb) buildGarb();
  console.log('garment names for &only= / &hide=: ' + GARMENTS.join(', ') + ' · groups: ' + Object.keys(GROUPS).join(', '));
  var fl = { pos: new Float32Array([-6, 0, -6, 6, 0, -6, 6, 0, 6, -6, 0, 6]), nrm: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), idx: new Uint16Array([0, 2, 1, 0, 3, 2]) };
  scene.items.push({ g: upload(fl), prog: 'floor', world: true, cast: false });
  buildProps();
  status('built in ' + ((performance.now() - t0) / 1000).toFixed(1) + 's');
}
/* ================= performance, audio, camera ================= */
// the 帔帛: shawl.<style>.json if present, else figure.js's SHAWL_DEF (&shawl=file loads another, &shawl=0: the older built-in path)
var SHAWL = null;
function loadShawl() { return Q.shawl === '0' ? Promise.resolve(false) : fetch(Q.shawl || 'shawl.' + STYLE + '.json').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); }
var CLOTH = null, DEF = null, perf = null, song = null, audio = { ctx: null, buf: null, src: null, startAt: 0, off: 0, playing: false }, Wb = null, dict = null;
// the audio source is pluggable: any function (song, opts) → {L, R, sr, syls}. Built in: sing.js's own accompaniment,
// or band.js's fuller ensemble; window.STAGE_AUDIO overrides both.
var SOURCES = { sing: function (sg, o) { return SING.render(sg, o); }, band: function (sg, o) { return window.BAND ? BAND.render(sg, o) : SING.render(sg, o); } };
var source = Q.band ? 'band' : 'sing';
function audioSource(sg, o) { return (window.STAGE_AUDIO || SOURCES[source])(sg, o); }
function compose(i, seed) {
  var P = Q.text ? { title: Q.title || '', text: Q.text } : SING.POEMS[i] || SING.POEMS[0];   // ?text=…&mode=…&tempo=… (e.g. from tool/video.js --file)
  song = SING.compose(P.text, dict, { seed: seed, mode: Q.mode || undefined, tempo: Q.tempo ? +Q.tempo : undefined, era: Q.era || undefined });   // &era=high: 盛唐 tones
  var r = audioSource(song, { voice: 'woman', seed: seed, intro: Q.prelude === 'none' ? false : Q.prelude === 'short' ? 3 : undefined });   // &prelude=short|none
  perf = FIG.perform(song, r.syls, { seed: seed, fig: fig, style: STYLE }); perf.audio = r;
  fig.sim.t = null; if (fig.gsim) { fig.gsim.t = null; lastT = -1; if (!SHOT) clothRewarm(0); }   // the garments settle before the first frame
  if (!SHOT) {
    if (!audio.ctx) audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
    var b = audio.ctx.createBuffer(2, r.L.length, r.sr); b.getChannelData(0).set(r.L); b.getChannelData(1).set(r.R); audio.buf = b; audio.off = 0;
  }
}
function now() { return audio.playing ? audio.ctx.currentTime - audio.startAt : audio.off; }
function play() {
  if (!audio.buf) return;
  if (audio.playing) { audio.off = now(); audio.src.stop(); audio.playing = false; $('play').textContent = '▶'; return; }
  if (audio.off >= perf.dur - 0.5) audio.off = 0;
  audio.ctx.resume(); var s2 = audio.ctx.createBufferSource(); s2.buffer = audio.buf; s2.connect(audio.ctx.destination);
  s2.start(0, audio.off); audio.startAt = audio.ctx.currentTime - audio.off; audio.src = s2; audio.playing = true; $('play').textContent = '❚❚';
  s2.onended = function () { if (audio.src === s2 && audio.playing) { audio.playing = false; audio.off = 0; $('play').textContent = '▶'; } };
}
function poseAt(t, k) { var W = FIG.solve(fig.sk, perf.controls(t)); return k >= 1 ? W : FIG.blendW(Wb, W, k); }
// auto camera: planned by FIG.perform (calm shots changed at phrase boundaries, eased dollies, slow orbit)
function autoCam(t) { return perf.camera(t); }
var camMode = Q.cam || 'auto', lastT = -1, lastTc = 0;
if (camMode === 'orbit') document.body.classList.add('orbit');
var FPS = 0, fpsN = 0, fpsT = 0, SIMMS = 0;
function frame() {
  var t = now(), pn = performance.now(); fpsN++; if (pn - fpsT > 1000) { FPS = fpsN * 1000 / (pn - fpsT); fpsN = 0; fpsT = pn; }
  if (camMode === 'auto') { var cm = autoCam(t); ['tgt', 'dist', 'fov', 'az', 'el'].forEach(function (k) { cam[k] = cm[k]; }); }
  else if (camMode !== 'orbit') setCam({ cam: camMode });
  update(t); render(null); lyric(t); if (TRACE) traceFrame();
  requestAnimationFrame(frame);
}
// adaptive cloth rate: while the simulation leaves room in the frame, step it more often (60 → 90 → 120 Hz); back off
// when it gets tight. The cloth never trails the body either way (see Sim.advance).
var RATES = [60, 90, 120], rateI = 0, simAvg = 0, rateHold = 0;
function adaptRate(ms) {
  simAvg = simAvg ? simAvg * 0.95 + ms * 0.05 : ms; if (++rateHold < 90) return;
  if (simAvg < 6.5 && rateI < RATES.length - 1) { rateI++; fig.sim.setRate(RATES[rateI]); rateHold = 0; simAvg = 0; }
  else if (simAvg > 11 && rateI > 0) { rateI--; fig.sim.setRate(RATES[rateI]); rateHold = 0; simAvg = 0; }
}
function update(t) {
  TNOW = t;
  if (t !== lastT) { var t1 = performance.now(), tc = fig.gsim ? clothAdvance(t) : t; fig.sim.advance(poseAt, tc, SHOT ? 0 : 14); SIMMS = performance.now() - t1; updateCloth(); lastT = t; lastTc = tc; if (!SHOT && !fig.gsim) adaptRate(SIMMS); }
  FIG.poseDQ(fig.sk, poseAt(lastTc, 1), DQ);   // (the body at the time of the cloth state shown)
}
// IPA for display: mcsynth's syl.ipa ends in its tone contour plus '₂' for the yang register. Shown as register-aware Chao
// tone letters (平 ˧/˨, 上 ˧˥/˨˦, 去 ˥˨/˦˩, 入 ˥/˨ for yin/yang); the '₂' (not IPA) and the redundant unreleased-stop mark
// U+031A (which Source Code Pro places on the following tone letter) are dropped. The synth itself is untouched.
var TONE_DISP = { '˧': ['˧', '˨'], '˧˥': ['˧˥', '˨˦'], '˥˩': ['˥˨', '˦˩'], '˥': ['˥', '˨'] };
function ipaDisplay(s) {
  s = String(s || ''); var yang = /₂$/.test(s); s = s.replace(/₂/g, '').replace(/\u031A/g, '');
  var m = /[˥˦˧˨˩]+$/.exec(s); if (!m || !TONE_DISP[m[0]]) return s;
  return s.slice(0, m.index) + TONE_DISP[m[0]][yang ? 1 : 0];
}
function lyric(t) {
  var sy = perf.syls, k = -1, h = '';
  for (var i = 0; i < sy.length; i++) if (sy[i].t0 <= t + 0.05) k = i;
  if (k >= 0 && t < sy[k].off + 1.5) { var p = perf.phrases.find(function (q) { return q.syls.indexOf(sy[k]) >= 0; });
    var esc = function (x) { return String(x || '').replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); };
    if (p) { h += '<span class="sy lab"><span class="c">&#8203;</span><span class="b"><i>Baxter</i></span><span class="p"><i>IPA</i></span></span>'; }
    if (p) p.syls.forEach(function (y) { h += '<span class="sy' + (y === sy[k] && t < y.off + 0.2 ? ' on' : '') + '"><span class="c">' + esc(y.ch) + '</span><span class="b">' + esc(y.bax) + '</span><span class="p">' + esc(ipaDisplay(y.ipa)) + '</span></span>'; }); }
  if ($('lyric').innerHTML !== h) $('lyric').innerHTML = h;
}
// offline video frame (tool/video.js): planned camera, full cloth steps, render, downscale into g (w × h), burnt-in subtitles
function videoFrame(t, g, w, h) {
  var cm = autoCam(t); ['tgt', 'dist', 'fov', 'az', 'el'].forEach(function (k) { cam[k] = cm[k]; });
  update(t); render(null);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(canvas, 0, 0, w, h);
  drawLyrics(g, t, w, h);
}
// the karaoke lines drawn into a 2D canvas with the same layout as #lyric in stage.html (sizes in vw / vh of the frame)
function drawLyrics(g, t, w, h) {
  var sy = perf.syls, k = -1; for (var i = 0; i < sy.length; i++) if (sy[i].t0 <= t + 0.05) k = i;
  if (k < 0 || t >= sy[k].off + 1.5) return;
  var p = perf.phrases.find(function (q) { return q.syls.indexOf(sy[k]) >= 0; }); if (!p) return;
  var vw = w / 100, vh = h / 100, cl = function (a, x, b) { return Math.max(a, Math.min(b, x)); };
  var fc = cl(20, 2.9 * vw, 38), fb = cl(14, 2.15 * vw, 28), fl = fb * 0.6, gx = cl(12, 2.2 * vw, 34), gy = 4, bot = cl(56, 9 * vh, 110), lc = fc * 1.2, lb = fb * 1.3;
  if (h > w) { fc = 4 * vw; fb = 2.5 * vw; fl = fb * 0.6; gx = 1.4 * vw; gy = 0.6 * vh; bot = 17 * vh; lc = fc * 1.2; lb = fb * 1.3; }   // portrait (9:16): sized by width, raised clear of phone UI
  var FC = fc + 'px "HanaMinA", "Hiragino Mincho ProN", "Songti TC", serif', FB = '500 ' + fb + 'px "Source Code Pro", "Doulos SIL", Menlo, monospace', FL = '500 ' + fl + 'px "Source Code Pro", Menlo, monospace';
  var mw = function (f, s) { g.font = f; return g.measureText(s).width; };
  if (h > w) {   // portrait: one scale for the whole song, so its longest line just fits the width
    if (!perf._subK || perf._subK.w !== w) {
      var mx = 0; perf.phrases.forEach(function (q) { var s = Math.max(mw(FL, 'Baxter'), mw(FL, 'IPA')) + 0.15 * fb;
        q.syls.forEach(function (y) { s += gx + Math.max(1.4 * fc, mw(FC, y.ch), mw(FB, y.bax || ''), mw(FB, ipaDisplay(y.ipa))); }); mx = Math.max(mx, s); });
      perf._subK = { w: w, k: Math.min(2, 0.94 * w / mx) };
    }
    var K = perf._subK.k; fc *= K; fb *= K; fl *= K; gx *= K; lc *= K; lb *= K;
    FC = fc + 'px "HanaMinA", "Hiragino Mincho ProN", "Songti TC", serif'; FB = '500 ' + fb + 'px "Source Code Pro", "Doulos SIL", Menlo, monospace'; FL = '500 ' + fl + 'px "Source Code Pro", Menlo, monospace';
  }
  var items = [{ lab: true, w: Math.max(mw(FL, 'Baxter'), mw(FL, 'IPA')) + 0.15 * fb }];
  p.syls.forEach(function (y) { items.push({ y: y, on: y === sy[k] && t < y.off + 0.2, w: Math.max(1.4 * fc, mw(FC, y.ch), mw(FB, y.bax || ''), mw(FB, ipaDisplay(y.ipa))) }); });
  var lines = [[]], lw = [0], avail = w - 24;
  items.forEach(function (it) { var L = lines.length - 1, add = (lines[L].length ? gx : 0) + it.w; if (lines[L].length && lw[L] + add > avail) { lines.push([it]); lw.push(it.w); } else { lines[L].push(it); lw[L] += add; } });
  var colH = lc + 2 * lb, y0 = h - bot - lines.length * colH - (lines.length - 1) * gy;
  g.save(); g.textBaseline = 'middle';
  lines.forEach(function (L, li) {
    var x = (w - lw[li]) / 2, top = y0 + li * (colH + gy);
    L.forEach(function (it) {
      var cx = x + it.w / 2, rows = it.lab ? [[null], ['Baxter', FL, '#8a7e70'], ['IPA', FL, '#8a7e70']] :
        [[it.y.ch, FC, it.on ? '#f0a080' : '#e8dccb'], [it.y.bax || '', FB, it.on ? '#f0a080' : '#b3a491'], [ipaDisplay(it.y.ipa), FB, it.on ? '#f0a080' : '#8f8476']];
      rows.forEach(function (r, ri) { if (!r[0]) return; var yy = top + (ri === 0 ? lc / 2 : lc + lb * (ri - 0.5));
        g.font = r[1]; g.textAlign = it.lab ? 'right' : 'center'; var xx = it.lab ? x + it.w - 0.15 * fb : cx;
        g.shadowColor = '#000'; g.fillStyle = r[2];
        if (ri) { g.lineJoin = 'round'; g.strokeStyle = 'rgba(0,0,0,0.7)'; g.lineWidth = fb * 0.16; g.shadowBlur = 6 * vw / 12.8; g.strokeText(r[0], xx, yy); g.shadowBlur = 0; g.fillText(r[0], xx, yy); return; }   // transliterations: a dark outline survives compression
        g.shadowBlur = 10 * vw / 12.8; g.fillText(r[0], xx, yy); g.shadowBlur = 3 * vw / 12.8; g.fillText(r[0], xx, yy); });
      x += it.w + gx;
    });
  });
  g.restore();
}
// orbit camera: drag rotates; shift-, right- or middle-drag (or a two-finger drag) pans; wheel / pinch zooms
(function () {
  var down = null;
  function pan(dx, dy) {   // move the target in the view plane so the figure follows the pointer
    var a = cam.az * Math.PI / 180, e = cam.el * Math.PI / 180, s = 2 * cam.dist * Math.tan(cam.fov * Math.PI / 360) / (canvas.clientHeight || 1);
    var rt = [Math.cos(a), 0, -Math.sin(a)], up = [-Math.sin(a) * Math.sin(e), Math.cos(e), -Math.cos(a) * Math.sin(e)];
    cam.tgt = cam.tgt.map(function (v, k) { return v - (rt[k] * dx - up[k] * dy) * s; });   // a new array: presets are shared
  }
  function zoom(f) { cam.dist = Math.max(0.3, Math.min(8, cam.dist * f)); }
  canvas.addEventListener('contextmenu', function (e) { if (camMode === 'orbit') e.preventDefault(); });
  canvas.addEventListener('mousedown', function (e) { if (camMode !== 'orbit') return;
    down = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 1 || e.button === 2 }; e.preventDefault(); });
  window.addEventListener('mouseup', function () { down = null; });
  window.addEventListener('mousemove', function (e) { if (!down) return; var dx = e.clientX - down.x, dy = e.clientY - down.y; down.x = e.clientX; down.y = e.clientY;
    if (down.pan) pan(dx, dy); else { cam.az -= dx * 0.3; cam.el = Math.max(-10, Math.min(60, cam.el + dy * 0.2)); } });
  canvas.addEventListener('dblclick', function () { if (camMode !== 'orbit') return; setCam({ cam: 'full' }); });
  canvas.addEventListener('wheel', function (e) { if (camMode !== 'orbit') return; e.preventDefault();
    var px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    // a pinch arrives as ctrl+wheel; a mouse wheel moves in whole notches (wheelDelta multiples of 120); anything else is a trackpad two-finger drag
    var notch = e.wheelDeltaY && Math.abs(e.wheelDeltaY) % 120 === 0 && !e.deltaX;
    if (e.ctrlKey) zoom(Math.exp(e.deltaY * px * 0.01));
    else if (notch || e.deltaMode) zoom(Math.exp(e.deltaY * px * 0.001));
    else pan(-e.deltaX, -e.deltaY);
  }, { passive: false });
  // touch: one finger rotates, two fingers pan and pinch
  var tch = null;
  function tinfo(ts) { if (ts.length === 1) return { x: ts[0].clientX, y: ts[0].clientY, n: 1 };
    return { x: (ts[0].clientX + ts[1].clientX) / 2, y: (ts[0].clientY + ts[1].clientY) / 2, d: Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY), n: 2 }; }
  canvas.addEventListener('touchstart', function (e) { if (camMode !== 'orbit') return; tch = tinfo(e.touches); e.preventDefault(); }, { passive: false });
  canvas.addEventListener('touchmove', function (e) { if (!tch || camMode !== 'orbit') return; var t = tinfo(e.touches); e.preventDefault();
    if (t.n !== tch.n) { tch = t; return; }
    if (t.n === 1) { cam.az -= (t.x - tch.x) * 0.3; cam.el = Math.max(-10, Math.min(60, cam.el + (t.y - tch.y) * 0.2)); }
    else { pan(t.x - tch.x, t.y - tch.y); if (tch.d > 0 && t.d > 0) zoom(tch.d / t.d); }
    tch = t; }, { passive: false });
  canvas.addEventListener('touchend', function (e) { tch = e.touches.length ? tinfo(e.touches) : null; });
})();

initPrograms(); initTargets();
window.addEventListener('resize', function () { initTargets(); });
// the editor (edit.html) reuses this renderer without the stage app
window.STAGE_API = { gl: gl, canvas: canvas, P: P, program: program, size: function () { return [W, H]; }, camMatrices: camMatrices, scene: scene, DQ: DQ, cam: cam, setCam: setCam, render: render, upload: upload, draw: draw, setCommon: setCommon,
  makeTextures: makeTextures, loadFigure: loadFigure, figFile: function () { return FIGFILE; }, buildProps: buildProps, setFig: function (f) { fig = f; }, PAINT: PAINT, setPaint: setPaint, paintUpload: paintUpload, prebuildGeometry: prebuildGeometry, setDecals: function (list) { DECP = FIG.packDecals(list); }, initTargets: initTargets, persp: persp, lookAt: lookAt, mmul: mmul, MATS: MATS, plainSet: plainSet, lashSet: lashSet, canvasTex: canvasTex,
  // (shawl.html: the stage's own build and garment rendering)
  buildFigure: function (def, pre, shawl) { DEF = def; SHAWL = shawl; build(pre); Wb = FIG.bindW(fig.sk); return fig; }, garbUpload: garbUpload, updateCloth: updateCloth,
  rebuildGarb: function (garb) { var old = fig.garb, gs = old.render.map(function (r) { return r.g; }).concat(old.knotM ? [old.knotM.g] : []); scene.items = scene.items.filter(function (it) { return gs.indexOf(it.g) < 0; }); fig.garb = garb; buildGarb(); return fig.gsim; } };
if (window.STAGE_EDITOR) return;
SING.POEMS.forEach(function (p, i) { var o = document.createElement('option'); o.value = i; o.textContent = p.title; $('poem').appendChild(o); });
$('style').value = STYLE; $('style').onchange = function () { var q = location.search.replace(/[?&]style=[^&]*/g, '').replace(/^&/, '?'); location.search = (q ? q + '&' : '?') + 'style=' + this.value; };
$('poem').value = Q.poem || 0; $('cam').value = camMode; $('band').value = source; if (!window.BAND) $('band').style.display = 'none';
status('building…');
Promise.all([fetch('speech/mc_dict.json').then(function (r) { return r.json(); }), loadFigure(), import('./cloth_sim/cloth.js?v=' + FIG.BUILD_VERSION), loadShawl()]).then(function (res) {
  dict = res[0]; DEF = FIG.styleDef(res[1], STYLE); CLOTH = res[2]; SHAWL = res[3]; if (SHAWL) console.log('shawl: drawn (' + (Q.shawl || 'shawl.' + STYLE + '.json') + ', ' + SHAWL.points.length + ' points, laid in the ' + SHAWL.pose + ' pose)'); FIG.setClothLib(CLOTH); CLOTH.warmup();   // (the solver: JIT-warmed before the garments settle)
  if (Q.headdress && DEF.costume && DEF.costume.song) DEF.costume.song.headdress = Q.headdress;   // ?headdress=baijiao|zhucui|gele (Song; in memory only)
  if (VIDEO && Q.cloth === 'full') {   // the cloth grids from before the 25% cut (in memory only; figure.json is untouched)
    var CT = DEF.costume && DEF.costume.tang; if (CT && CT.skirt) { CT.skirt.nu = 84; CT.skirt.nv = 46; CT.robe.nu = 70; CT.robe.nv = 40; CT.sleeve.nu = 22; CT.sleeve.nv = 30; CT.shawl.nu = 9; CT.shawl.nv = 104; CT.sash.nv = 30; }
  }
  progress(0.02, 'building the figure…');
  prebuildGeometry({ def: DEF, headOnly: 'head' in Q, costume: COST, cloth: Q.cloth, res: Q.res ? { body: +Q.res, fine: +(Q.fine || 0.00125) } : undefined }).then(function (pre) { progress(0.97, 'assembling…'); return new Promise(function (r) { setTimeout(function () { r(pre); }, 30); }); }).then(function (pre) {
    build(pre); Wb = FIG.bindW(fig.sk);
    compose(+(Q.poem || 0), +(Q.seed || 1)); progress(null);
    if (VIDEO) {
      if (!('stagecloth' in Q)) { fig.sim.setRate(+(Q.simhz || 240)); FIG.simQuality({ iters: +(Q.iters || 2), allCollide: true }); }   // (default in tool/video.js: the stage's own cloth settings)
      window.VIDEO = { dur: perf.dur, audio: perf.audio, title: Q.title || (SING.POEMS[+(Q.poem || 0)] || {}).title, size: function () { return [W, H]; },
        cloth: fig.garb ? 'sewn, ' + fig.garb.n + ' particles' : fig.cloths.map(function (c) { return c.name + ' ' + c.n; }).join(', '), verts: fig.body.pos.length / 3, frame: videoFrame };
      status(''); window.READY = true;
    } else if (SHOT) {
      var t = Q.t != null ? +Q.t : perf.t0 + 2;
      setCam(Q.cam && Q.cam !== 'auto' ? Q : autoCam(t)); if (Q.cam && Q.cam !== 'auto') setCam(Q);
      var t1 = performance.now(); update(t); status('sim to ' + t + 's in ' + ((performance.now() - t1) / 1000).toFixed(1) + 's');
      render(Q.jit ? [+Q.jit * 2 / W, +Q.jit * 2 / H] : null);
      window.READY = true;
    } else { status(''); $('play').onclick = play; $('poem').onchange = function () { if (audio.playing) play(); compose(+this.value, +(Q.seed || 1)); lastT = -1; };
      $('band').onchange = function () { source = this.value; if (audio.playing) play(); status('rendering…'); var self = this; setTimeout(function () { compose(+$('poem').value, +(Q.seed || 1)); lastT = -1; status(''); }, 20); };
      $('cam').onchange = function () { camMode = this.value; document.body.classList.toggle('orbit', camMode === 'orbit'); if (camMode === 'orbit') setCam({ cam: 'full' }); }; frame(); }
  });
});
window.STAGE = { play: function () { play(); }, now: function () { return now(); }, fps: function () { return FPS; }, simms: function () { return SIMMS; }, simrate: function () { return RATES[rateI]; }, simlag: function () { return fig && fig.gsim ? lastT - lastTc : fig && fig.sim ? lastT - fig.sim.t : 0; }, clothms: function () { return CA ? CA.stats.ms : fig && fig.gsim && fig.gsim.cloth ? fig.gsim.cloth.stats.ms : 0; }, skipped: function () { return fig && fig.sim ? fig.sim.skipped || 0 : 0; }, garments: function () { return GARMENTS.slice(); }, trace: function (on) { if (on) { TRACE = { rows: [], pierce: {} }; return true; } var r = TRACE ? TRACE.rows : []; r.pierce = TRACE ? TRACE.pierce : {}; TRACE = null; return { rows: r, pierce: r.pierce }; }, shot: function (o) { if ('only' in o) Q.only = o.only.replace(/;/g, ','); if ('hide' in o) Q.hide = o.hide.replace(/;/g, ','); if (Q.lyrics) { document.body.classList.add('lyrics'); lyric(+o.t || lastT); } if (o.brow) setBrow(o.brow); if (o.label) setLabel(o.label.replace(/_/g, ' ')); if (o.t != null && +o.t !== lastT) update(+o.t); if (o.cam === 'auto') { var cm = autoCam(+o.t || lastT); ['tgt', 'dist', 'fov', 'az', 'el'].forEach(function (k) { cam[k] = cm[k]; }); } else setCam(o); (o.id ? renderIds : render)(o.jit ? [+o.jit * 2 / W, +o.jit * 2 / H] : null); return true; }, cam: cam, fig: function () { return fig; }, perf: function () { return perf; } };
})();
