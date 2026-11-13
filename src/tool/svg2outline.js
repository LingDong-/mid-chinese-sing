// svg2outline.js — turns the traced ornament SVGs (tool/comb.svg, tool/zhucui.svg) into the outlines hardcoded in figure.js
// (ORN_SHAPES): each SVG's closed path, flattened (cubic / quadratic / arc segments), with its group transforms applied,
// resampled at equal arc length, centred and scaled to unit width (y up), aspect kept.
//   arch -arm64 node tool/svg2outline.js        → rewrites the ORN_SHAPES block in figure.js
const fs = require('fs'), path = require('path'), ROOT = path.join(__dirname, '..');
var PI = Math.PI, sqrt = Math.sqrt, abs = Math.abs, cos = Math.cos, sin = Math.sin, max = Math.max;
function svgParse(txt) {
  var out = { shapes: [], strokes: [] }, stack = [[1, 0, 0, 1, 0, 0]], vb = /viewBox\s*=\s*["']([^"']+)["']/.exec(txt);
  if (vb) { var v = vb[1].trim().split(/[\s,]+/).map(Number); out.view = v; }
  function mm(a, b) { return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]]; }
  function xform(t) { var M = [1, 0, 0, 1, 0, 0], re = /(\w+)\s*\(([^)]*)\)/g, m;
    while ((m = re.exec(t || ''))) { var a = m[2].trim().split(/[\s,]+/).map(Number), T;
      if (m[1] === 'matrix') T = a; else if (m[1] === 'translate') T = [1, 0, 0, 1, a[0], a[1] || 0]; else if (m[1] === 'scale') T = [a[0], 0, 0, a[1] == null ? a[0] : a[1], 0, 0];
      else if (m[1] === 'rotate') { var r = a[0] * PI / 180, c = cos(r), sn = sin(r); T = [c, sn, -sn, c, 0, 0]; if (a.length > 2) T = mm(mm([1, 0, 0, 1, a[1], a[2]], T), [1, 0, 0, 1, -a[1], -a[2]]); }
      else if (m[1] === 'skewX') T = [1, 0, Math.tan(a[0] * PI / 180), 1, 0, 0]; else if (m[1] === 'skewY') T = [1, Math.tan(a[0] * PI / 180), 0, 1, 0, 0]; else continue;
      M = mm(M, T); } return M; }
  function attr(tag, k) { var m = new RegExp('(?:^|\\s)' + k + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')').exec(tag); return m ? (m[2] != null ? m[2] : m[3]) : null; }
  function style(tag, k) { var st = attr(tag, 'style') || '', m = new RegExp('(?:^|;)\\s*' + k + '\\s*:\\s*([^;]+)').exec(st); return m ? m[1].trim() : attr(tag, k); }
  function pathPolys(d) {   // → [{pts, closed}]
    var tok = d.match(/[a-zA-Z]|-?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/g) || [], i = 0, cmd = '', cur = [0, 0], st = [0, 0], prevC = null, prevQ = null, polys = [], pts = null, N = 12;
    var num = function () { return +tok[i++]; }, isNum = function () { return i < tok.length && !/[a-zA-Z]/.test(tok[i]); };
    function start(p) { if (pts && pts.length > 1) polys.push({ pts: pts, closed: false }); pts = [p.slice()]; }
    function line(p) { pts.push(p.slice()); }
    function cubic(p0, p1, p2, p3) { for (var k = 1; k <= N; k++) { var t = k / N, u = 1 - t; line([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]); } }
    function quad(p0, p1, p2) { for (var k = 1; k <= N; k++) { var t = k / N, u = 1 - t; line([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]); } }
    function arc(p0, rx, ry, phi, fa, fs, p1) {   // SVG endpoint → centre parameterization
      rx = abs(rx); ry = abs(ry); if (!rx || !ry) { line(p1); return; } var cp = cos(phi * PI / 180), sp = sin(phi * PI / 180), dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2, x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy;
      var lam = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry); if (lam > 1) { rx *= sqrt(lam); ry *= sqrt(lam); }
      var sg = (fa === fs ? -1 : 1) * sqrt(max(0, (rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1) / (rx * rx * y1 * y1 + ry * ry * x1 * x1))), cx1 = sg * rx * y1 / ry, cy1 = -sg * ry * x1 / rx;
      var cx = cp * cx1 - sp * cy1 + (p0[0] + p1[0]) / 2, cy = sp * cx1 + cp * cy1 + (p0[1] + p1[1]) / 2, ang = function (ux, uy, vx, vy) { var a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); return a; };
      var t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry), dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry); if (!fs && dt > 0) dt -= 2 * PI; else if (fs && dt < 0) dt += 2 * PI;
      var n = max(4, Math.ceil(abs(dt) / (PI / 12))); for (var k = 1; k <= n; k++) { var t = t1 + dt * k / n; line([cx + rx * cos(t) * cp - ry * sin(t) * sp, cy + rx * cos(t) * sp + ry * sin(t) * cp]); } }
    while (i < tok.length) {
      if (!isNum()) cmd = tok[i++]; var rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase(), o = rel ? cur : [0, 0];
      if (C === 'M') { cur = [o[0] + num(), o[1] + num()]; st = cur.slice(); start(cur); cmd = rel ? 'l' : 'L'; }
      else if (C === 'L') { cur = [o[0] + num(), o[1] + num()]; line(cur); }
      else if (C === 'H') { cur = [rel ? cur[0] + num() : num(), cur[1]]; line(cur); }
      else if (C === 'V') { cur = [cur[0], rel ? cur[1] + num() : num()]; line(cur); }
      else if (C === 'C') { var a1 = [o[0] + num(), o[1] + num()], a2 = [o[0] + num(), o[1] + num()], a3 = [o[0] + num(), o[1] + num()]; cubic(cur, a1, a2, a3); prevC = a2; cur = a3; }
      else if (C === 'S') { var r1 = prevC && /[CS]/i.test(tok[i - 5] || 'C') ? [2 * cur[0] - prevC[0], 2 * cur[1] - prevC[1]] : cur.slice(), b2 = [o[0] + num(), o[1] + num()], b3 = [o[0] + num(), o[1] + num()]; cubic(cur, r1, b2, b3); prevC = b2; cur = b3; }
      else if (C === 'Q') { var q1 = [o[0] + num(), o[1] + num()], q2 = [o[0] + num(), o[1] + num()]; quad(cur, q1, q2); prevQ = q1; cur = q2; }
      else if (C === 'T') { var tq = prevQ ? [2 * cur[0] - prevQ[0], 2 * cur[1] - prevQ[1]] : cur.slice(), t2 = [o[0] + num(), o[1] + num()]; quad(cur, tq, t2); prevQ = tq; cur = t2; }
      else if (C === 'A') { var rx = num(), ry = num(), ph = num(), fa = num(), fs = num(), e = [o[0] + num(), o[1] + num()]; arc(cur, rx, ry, ph, fa, fs, e); cur = e; }
      else if (C === 'Z') { if (pts && pts.length > 2) polys.push({ pts: pts, closed: true }); pts = null; cur = st.slice(); start(cur); }
      else { i++; }
      if (C !== 'C' && C !== 'S') prevC = null; if (C !== 'Q' && C !== 'T') prevQ = null;
    }
    if (pts && pts.length > 1) polys.push({ pts: pts, closed: false });
    return polys;
  }
  function ellipsePts(cx, cy, rx, ry) { var p = []; for (var k = 0; k < 48; k++) { var t = k / 48 * 2 * PI; p.push([cx + rx * cos(t), cy + ry * sin(t)]); } return p; }
  var re = /<\s*(\/?)\s*([a-zA-Z]+)([^>]*?)(\/?)>/g, m;
  while ((m = re.exec(txt))) {
    var close = m[1], name = m[2].toLowerCase(), tag = m[3], self = m[4];
    if (name === 'g' || name === 'svg') { if (close) { if (stack.length > 1) stack.pop(); } else if (!self) stack.push(mm(stack[stack.length - 1], xform(attr(tag, 'transform')))); continue; }
    if (close) continue;
    var M = mm(stack[stack.length - 1], xform(attr(tag, 'transform'))), id = (attr(tag, 'id') || '') + ' ' + (attr(tag, 'class') || ''), fill = style(tag, 'fill'), rule = style(tag, 'fill-rule') || 'nonzero', polys = [];
    var f = function (v) { return +(v || 0); };
    if (name === 'path') polys = pathPolys(attr(tag, 'd') || '');
    else if (name === 'polygon' || name === 'polyline') { var nn = (attr(tag, 'points') || '').trim().split(/[\s,]+/).map(Number), pp = []; for (var k = 0; k + 1 < nn.length; k += 2) pp.push([nn[k], nn[k + 1]]); polys = [{ pts: pp, closed: name === 'polygon' }]; }
    else if (name === 'rect') { var x = f(attr(tag, 'x')), y = f(attr(tag, 'y')), w = f(attr(tag, 'width')), h = f(attr(tag, 'height')); polys = [{ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true }]; }
    else if (name === 'circle') polys = [{ pts: ellipsePts(f(attr(tag, 'cx')), f(attr(tag, 'cy')), f(attr(tag, 'r')), f(attr(tag, 'r'))), closed: true }];
    else if (name === 'ellipse') polys = [{ pts: ellipsePts(f(attr(tag, 'cx')), f(attr(tag, 'cy')), f(attr(tag, 'rx')), f(attr(tag, 'ry'))), closed: true }];
    else if (name === 'line') polys = [{ pts: [[f(attr(tag, 'x1')), f(attr(tag, 'y1'))], [f(attr(tag, 'x2')), f(attr(tag, 'y2'))]], closed: false }];
    else continue;
    polys.forEach(function (P) { P.pts = P.pts.map(function (q) { return [M[0] * q[0] + M[2] * q[1] + M[4], M[1] * q[0] + M[3] * q[1] + M[5]]; }); });
    var filled = fill !== 'none' && name !== 'polyline' && name !== 'line';   // a filled path is a shape even if not closed with Z
    var cl = polys.filter(function (P) { return P.closed || (filled && fill != null); }), op = polys.filter(function (P) { return !(P.closed || (filled && fill != null)); });
    if (cl.length) out.shapes.push({ rings: cl.map(function (P) { return P.pts; }), rule: rule, id: id });
    op.forEach(function (P) { out.strokes.push({ pts: P.pts, hang: /\bhang\b/.test(id), id: id }); });
  }
  return out;
}

function outline(file, n) {
  const S = svgParse(fs.readFileSync(path.join(ROOT, file), 'utf8')), ring = S.shapes.map(s => s.rings).flat().sort((a, b) => b.length - a.length)[0];
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; ring.forEach(p => { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); });
  const L = [0]; for (let i = 1; i <= ring.length; i++) { const a = ring[i - 1], b = ring[i % ring.length]; L.push(L[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  const out = []; let j = 0; for (let k = 0; k < n; k++) { const t = L[ring.length] * k / n; while (L[j + 1] < t) j++; const a = ring[j], b = ring[(j + 1) % ring.length], f = (t - L[j]) / ((L[j + 1] - L[j]) || 1), x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f;
    out.push([+((x - (x0 + x1) / 2) / (x1 - x0)).toFixed(4), +(-(y - (y0 + y1) / 2) / (x1 - x0)).toFixed(4)]); }
  return out;
}
const shapes = { comb: outline('tool/comb.svg', 180), zhucui: outline('tool/zhucui.svg', 320) };
const F = path.join(ROOT, 'figure.js'), src = fs.readFileSync(F, 'utf8'), a = src.indexOf('/*ORN_SHAPES*/'), b = src.indexOf('/*/ORN_SHAPES*/');
fs.writeFileSync(F, src.slice(0, a) + '/*ORN_SHAPES*/var ORN_SHAPES = ' + JSON.stringify(shapes) + ';' + src.slice(b));
console.log('outlines: comb ' + shapes.comb.length + ' pts, zhucui ' + shapes.zhucui.length + ' pts → figure.js');
