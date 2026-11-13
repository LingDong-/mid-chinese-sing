// body.js — a simple capsule humanoid rig: skeleton, procedural motions, world-space capsules.
// Matrices are column-major Float32Array(16).

export const m4 = {
  identity: () => new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]),
  mul(a, b, out = new Float32Array(16)) {
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0; for (let k = 0; k < 4; k++) s += a[k*4+r] * b[c*4+k]; out[c*4+r] = s;
    } return out;
  },
  translation: (x, y, z) => new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1]),
  // rotation from Euler angles (rx, ry, rz), applied as Rz * Ry * Rx... we use Ry * Rx * Rz order (yaw, pitch, roll)
  euler(rx, ry, rz) {
    const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
    const X = new Float32Array([1,0,0,0, 0,cx,sx,0, 0,-sx,cx,0, 0,0,0,1]);
    const Y = new Float32Array([cy,0,-sy,0, 0,1,0,0, sy,0,cy,0, 0,0,0,1]);
    const Z = new Float32Array([cz,sz,0,0, -sz,cz,0,0, 0,0,1,0, 0,0,0,1]);
    return m4.mul(Y, m4.mul(X, Z));
  },
  scale: (x, y, z) => new Float32Array([x,0,0,0, 0,y,0,0, 0,0,z,0, 0,0,0,1]),
  point(m, p, out = [0,0,0]) { const x = p[0], y = p[1], z = p[2]; out[0] = m[0]*x+m[4]*y+m[8]*z+m[12]; out[1] = m[1]*x+m[5]*y+m[9]*z+m[13]; out[2] = m[2]*x+m[6]*y+m[10]*z+m[14]; return out; },
  rigidInverse(m) { // inverse of rotation+translation
    const r = new Float32Array(16);
    r[0]=m[0]; r[1]=m[4]; r[2]=m[8]; r[4]=m[1]; r[5]=m[5]; r[6]=m[9]; r[8]=m[2]; r[9]=m[6]; r[10]=m[10]; r[15]=1;
    r[12] = -(r[0]*m[12]+r[4]*m[13]+r[8]*m[14]); r[13] = -(r[1]*m[12]+r[5]*m[13]+r[9]*m[14]); r[14] = -(r[2]*m[12]+r[6]*m[13]+r[10]*m[14]);
    return r;
  },
  perspective(fovy, aspect, near, far) { const f = 1 / Math.tan(fovy / 2); return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)/(near-far),-1, 0,0,2*far*near/(near-far),0]); },
  lookAt(eye, target, up) {
    let zx = eye[0]-target[0], zy = eye[1]-target[1], zz = eye[2]-target[2]; let l = Math.hypot(zx,zy,zz); zx/=l; zy/=l; zz/=l;
    let xx = up[1]*zz-up[2]*zy, xy = up[2]*zx-up[0]*zz, xz = up[0]*zy-up[1]*zx; l = Math.hypot(xx,xy,xz); xx/=l; xy/=l; xz/=l;
    const yx = zy*xz-zz*xy, yy = zz*xx-zx*xz, yz = zx*xy-zy*xx;
    return new Float32Array([xx,yx,zx,0, xy,yy,zy,0, xz,yz,zz,0, -(xx*eye[0]+xy*eye[1]+xz*eye[2]), -(yx*eye[0]+yy*eye[1]+yz*eye[2]), -(zx*eye[0]+zy*eye[1]+zz*eye[2]), 1]);
  },
};

const ARM_ANGLE = 0.55; // A-pose: arms this many radians away from vertical
const ad = [Math.sin(ARM_ANGLE), -Math.cos(ARM_ANGLE), 0];

// rest-pose joint positions (world)
const REST = {
  hips: [0, 0.98, 0], spine: [0, 1.08, 0], chest: [0, 1.2, 0], neck: [0, 1.45, 0], head: [0, 1.52, 0],
  lShoulder: [0.19, 1.42, 0], rShoulder: [-0.19, 1.42, 0],
  lHip: [0.09, 0.94, 0], rHip: [-0.09, 0.94, 0],
};
const UA = 0.29, FA = 0.26, HA = 0.17;
for (const s of ['l', 'r']) {
  const sg = s === 'l' ? 1 : -1, sh = REST[s + 'Shoulder'];
  REST[s + 'Elbow'] = [sh[0] + sg*ad[0]*UA, sh[1] + ad[1]*UA, 0];
  REST[s + 'Wrist'] = [REST[s+'Elbow'][0] + sg*ad[0]*FA, REST[s+'Elbow'][1] + ad[1]*FA, 0];
  REST[s + 'Hand'] = [REST[s+'Wrist'][0] + sg*ad[0]*HA, REST[s+'Wrist'][1] + ad[1]*HA, 0];
  REST[s + 'Knee'] = [REST[s+'Hip'][0], 0.5, 0]; REST[s + 'Ankle'] = [REST[s+'Hip'][0], 0.08, 0]; REST[s + 'Toe'] = [REST[s+'Hip'][0], 0.03, 0.16];
}

// bones: name, parent, joint (origin) in rest pose
const BONES = [
  ['hips', null, 'hips'], ['spine', 'hips', 'spine'], ['chest', 'spine', 'chest'], ['neck', 'chest', 'neck'], ['head', 'neck', 'head'],
  ['lUpperArm', 'chest', 'lShoulder'], ['lForearm', 'lUpperArm', 'lElbow'], ['lHand', 'lForearm', 'lWrist'],
  ['rUpperArm', 'chest', 'rShoulder'], ['rForearm', 'rUpperArm', 'rElbow'], ['rHand', 'rForearm', 'rWrist'],
  ['lThigh', 'hips', 'lHip'], ['lShin', 'lThigh', 'lKnee'], ['lFoot', 'lShin', 'lAnkle'],
  ['rThigh', 'hips', 'rHip'], ['rShin', 'rThigh', 'rKnee'], ['rFoot', 'rShin', 'rAnkle'],
];
// capsules: bone, from joint, to joint (names; world rest positions converted to bone-local), radius
const CAPS = [
  ['hips', [-0.065, 0.0, 0], [0.065, 0.0, 0], 0.115],      // pelvis, wide
  ['spine', [0, -0.08, 0], [0, 0.2, 0], 0.11],              // abdomen
  ['chest', [-0.065, 0.08, 0], [-0.065, 0.16, 0], 0.115],  // chest: two upright lobes give shoulder width
  ['chest', [0.065, 0.08, 0], [0.065, 0.16, 0], 0.115],
  ['chest', [0, 0.0, 0], [0, 0.17, 0], 0.11],
  ['neck', [0, 0, 0], [0, 0.11, 0], 0.055],
  ['head', [0, 0.07, 0], [0, 0.15, 0.01], 0.1], // chin clears the shoulder line so necklines have room
  ['lUpperArm', 'lShoulder', 'lElbow', 0.048], ['lForearm', 'lElbow', 'lWrist', 0.038], ['lHand', 'lWrist', 'lHand', 0.032],
  ['rUpperArm', 'rShoulder', 'rElbow', 0.048], ['rForearm', 'rElbow', 'rWrist', 0.038], ['rHand', 'rWrist', 'rHand', 0.032],
  ['lThigh', 'lHip', 'lKnee', 0.078], ['lShin', 'lKnee', 'lAnkle', 0.052], ['lFoot', 'lAnkle', 'lToe', 0.04],
  ['rThigh', 'rHip', 'rKnee', 0.078], ['rShin', 'rKnee', 'rAnkle', 0.052], ['rFoot', 'rAnkle', 'rToe', 0.04],
];

export class Body {
  constructor({ bust = false } = {}) {
    this.bust = bust;
    this.bones = BONES.map(([name, parent, joint]) => ({ name, parent, rest: REST[joint], offset: parent ? sub(REST[joint], REST[BONES.find(b => b[0] === parent)[2]]) : REST[joint].slice(), rot: [0, 0, 0], world: m4.identity() }));
    this.index = Object.fromEntries(this.bones.map((b, i) => [b.name, i]));
    this.joints = REST;
    this.radii = { torsoX: 0.065 + 0.115, torsoZ: 0.115, hipX: 0.065 + 0.115, hipZ: 0.115, arm: 0.048, thigh: 0.078 };
    const caps = CAPS.slice();
    if (bust) for (const sx of [-1, 1]) caps.push(['chest', [sx * 0.07, 0.085, 0.075], [sx * 0.07, 0.085, 0.08], 0.068, true]);
    this.caps = caps.map(([bone, a, b, r, isBust]) => {
      const rest = REST[BONES.find(x => x[0] === bone)[2]];
      const la = typeof a === 'string' ? sub(REST[a], rest) : a, lb = typeof b === 'string' ? sub(REST[b], rest) : b;
      return { bone: this.index[bone], a: la, b: lb, r, bust: !!isBust, world: [rest[0] + la[0], rest[1] + la[1], rest[2] + la[2]] }; // world = rest-pose centre
    });
    this.root = [0, 0, 0]; this.rootYaw = 0;
    this.capsules = new Float32Array(7 * this.caps.length);
    this.pose(0, 'idle');
  }
  armDir(side) { return [side === 'l' ? ad[0] : -ad[0], ad[1], ad[2]]; }
  restInverse(boneName) { // function mapping a world point (rest pose) to bone-local coords
    const b = this.bones[this.index[boneName]]; const r = b.rest;
    return p => [p[0] - r[0], p[1] - r[1], p[2] - r[2]];
  }
  // forward kinematics; writes bone.world and this.capsules
  fk() {
    for (const b of this.bones) {
      const local = m4.mul(m4.translation(b.offset[0], b.offset[1], b.offset[2]), m4.euler(b.rot[0], b.rot[1], b.rot[2]));
      if (b.parent) m4.mul(this.bones[this.index[b.parent]].world, local, b.world);
      else { const rootM = m4.mul(m4.translation(this.root[0], this.root[1], this.root[2]), m4.euler(0, this.rootYaw, 0)); m4.mul(rootM, local, b.world); }
    }
    const C = this.capsules, tmp = [0, 0, 0];
    for (let i = 0; i < this.caps.length; i++) {
      const c = this.caps[i], w = this.bones[c.bone].world, o = 7 * i;
      m4.point(w, c.a, tmp); C[o] = tmp[0]; C[o+1] = tmp[1]; C[o+2] = tmp[2];
      m4.point(w, c.b, tmp); C[o+3] = tmp[0]; C[o+4] = tmp[1]; C[o+5] = tmp[2];
      C[o+6] = c.r;
    }
    return C;
  }
  pinTargets(pins, out) {
    out = out || new Float32Array(3 * pins.length); const tmp = [0, 0, 0];
    for (let k = 0; k < pins.length; k++) { m4.point(this.bones[this.index[pins[k].bone]].world, pins[k].local, tmp); out[3*k] = tmp[0]; out[3*k+1] = tmp[1]; out[3*k+2] = tmp[2]; }
    return out;
  }
  // procedural motions. t in seconds.
  pose(t, motion, weight = 1) {
    const B = this.bones, I = this.index, set = (n, x, y, z) => { const r = B[I[n]].rot; r[0] = x; r[1] = y; r[2] = z; };
    for (const b of B) b.rot[0] = b.rot[1] = b.rot[2] = 0;
    this.root[0] = this.root[2] = 0; this.root[1] = 0; this.rootYaw = 0;
    const s = Math.sin, c = Math.cos, pi = Math.PI;
    const arm = (side, raise, fwd, elbow, across = 0) => { // raise: sideways abduction (rad, from the A-pose), fwd: forward flexion, elbow: flexion, across: horizontal adduction (arm swung across the body)
      const sg = side === 'l' ? 1 : -1;
      set(side + 'UpperArm', -fwd, -sg * across, sg * raise); set(side + 'Forearm', -elbow, 0, 0);
    };
    const walk = (f, amp, stride) => { // f: cycles per second
      const w = 2 * pi * f * t;
      this.root[1] = -0.02 + 0.025 * Math.abs(c(w));
      set('lThigh', -amp * s(w), 0, 0); set('rThigh', amp * s(w), 0, 0);
      set('lShin', Math.max(0, 0.9 * amp * s(w - 1.2) + 0.3 * amp), 0, 0); set('rShin', Math.max(0, -0.9 * amp * s(w - 1.2) + 0.3 * amp), 0, 0);
      set('lFoot', 0.15 * s(w), 0, 0); set('rFoot', -0.15 * s(w), 0, 0);
      set('hips', 0, 0.1 * s(w), 0.04 * s(w)); set('spine', 0.05, -0.08 * s(w), -0.03 * s(w)); set('chest', 0.02, -0.08 * s(w), 0);
      set('lUpperArm', amp * 0.9 * s(w), 0, 0.0); set('rUpperArm', -amp * 0.9 * s(w), 0, 0.0);
      set('lForearm', -0.4 - 0.3 * s(w), 0, 0.2); set('rForearm', -0.4 + 0.3 * s(w), 0, -0.2);
      set('head', -0.05, 0.1 * s(w), 0);
      // travel along a circle
      const R = 1.6, speed = stride * f, ang = speed * t / R;
      this.root[0] = R * s(ang); this.root[2] = R * c(ang); this.rootYaw = ang;
    };
    switch (motion) {
      case 'idle': {
        set('spine', 0.02 * s(t * 1.5), 0.04 * s(t * 0.7), 0); set('chest', 0.02 * s(t * 1.5 + 1), 0, 0.02 * s(t * 0.9));
        set('lUpperArm', 0.05 * s(t), 0, 0.03 * s(t * 1.3)); set('rUpperArm', 0.05 * s(t + 1), 0, -0.03 * s(t * 1.3));
        set('lForearm', -0.2, 0, 0); set('rForearm', -0.2, 0, 0);
        set('head', 0, 0.2 * s(t * 0.6), 0);
        this.root[0] = 0.02 * s(t * 0.8); this.root[2] = 0.02 * s(t * 0.5);
        break;
      }
      case 'walk': walk(0.9, 0.5, 1.3); break;
      case 'run': walk(1.5, 0.85, 2.4); set('spine', 0.2, B[I.spine].rot[1], B[I.spine].rot[2]); break;
      case 'spin': {
        this.rootYaw = 3.5 * t; this.root[1] = 0.0;
        set('lUpperArm', 0, 0, 1.2); set('rUpperArm', 0, 0, -1.2); set('lForearm', 0, 0, 0.3); set('rForearm', 0, 0, -0.3);
        set('head', 0, 0.4 * s(3.5 * t), 0);
        break;
      }
      case 'dance': {
        const w = 2 * pi * 1.0 * t;
        this.root[1] = 0.06 * Math.abs(s(w)) - 0.03; this.root[0] = 0.25 * s(0.5 * w); this.root[2] = 0.15 * s(0.25 * w);
        this.rootYaw = 0.6 * s(0.25 * w) + (t % 12 > 9 ? 2 * pi * ((t % 12 - 9) / 1.5) : 0); // a full turn every 12 s
        set('hips', 0.1 * s(w), 0.3 * s(0.5 * w), 0.15 * s(w));
        set('spine', 0.15 * s(w * 0.5), 0.3 * s(0.5 * w + 1), 0.15 * s(w * 0.5)); set('chest', 0.1 * s(w + 0.5), 0.2 * s(0.5 * w), 0.1 * s(w));
        set('lThigh', -0.5 * Math.max(0, s(w)), 0, -0.2 - 0.15 * s(0.5 * w)); set('rThigh', -0.5 * Math.max(0, -s(w)), 0, 0.2 + 0.15 * s(0.5 * w));
        set('lShin', 0.7 * Math.max(0, s(w)) + 0.2, 0, 0); set('rShin', 0.7 * Math.max(0, -s(w)) + 0.2, 0, 0);
        // arms: raise, wave, swing
        const raise = 0.5 + 0.5 * s(0.5 * w);
        set('lUpperArm', 0.5 * s(w) - 1.0 * raise, 0.5 * s(0.5 * w), 2.0 * raise - 0.3); set('rUpperArm', -0.5 * s(w) - 1.0 * raise, -0.5 * s(0.5 * w), -2.0 * raise + 0.3);
        set('lForearm', -0.6 - 0.5 * s(2 * w), 0, 0.3 * s(w)); set('rForearm', -0.6 + 0.5 * s(2 * w), 0, -0.3 * s(w));
        set('head', 0.1 * s(w), 0.4 * s(0.5 * w), 0.1 * s(w + 1));
        break;
      }
      // arm helpers: side s = 'l'|'r'. raise = sideways abduction, fwd = forward flexion (rad), elbow = flexion (rad, 0 = straight)
      case 'wave': { // right arm up, waving from the elbow; left arm relaxed
        arm('r', 1.9, 0.3, 1.6 + 0.5 * s(8 * t), 0.0); arm('l', 0, 0.05 * s(t), 0.25, 0);
        set('spine', 0, 0.1 * s(2 * t), 0.05); set('head', 0, 0.3 * s(1.3 * t), 0.1 * s(2 * t));
        break;
      }
      case 'curl': { // bicep curls, both arms, slight body bob
        const e = 1.2 - 1.1 * c(2 * pi * 0.7 * t);
        arm('l', 0.1, 0.15, e, 0); arm('r', 0.1, 0.15, e, 0);
        this.root[1] = -0.01 * (1 + c(2 * pi * 0.7 * t)); set('spine', 0.05 * c(2 * pi * 0.7 * t), 0, 0);
        break;
      }
      case 'reach': { // alternate forward reaches: arm swings forward while the elbow extends
        const w = 2 * pi * 0.6 * t, kL = 0.5 + 0.5 * s(w), kR = 0.5 - 0.5 * s(w);
        arm('l', 0.15, 1.5 * kL, 1.8 * (1 - kL) + 0.1, 0); arm('r', 0.15, 1.5 * kR, 1.8 * (1 - kR) + 0.1, 0);
        set('spine', 0.1 * (kL + kR - 1), 0.35 * s(w), 0); set('chest', 0, 0.2 * s(w), 0);
        break;
      }
      case 'stretch': { // arms overhead, bend side to side, elbows flexing on the way up
        const k = 0.5 - 0.5 * c(0.9 * t), e = 1.2 * Math.max(0, s(0.9 * t));
        arm('l', 2.7 * k, 0.1, e, 0); arm('r', 2.7 * k, 0.1, e, 0);
        set('spine', 0.05, 0, 0.35 * s(0.45 * t)); set('chest', 0, 0, 0.15 * s(0.45 * t)); set('head', -0.2 * k, 0, 0);
        break;
      }
      case 'punch': { // alternating straight punches with hip/torso twist
        const w = 2 * pi * 1.1 * t, pL = Math.max(0, s(w)), pR = Math.max(0, -s(w));
        arm('l', 0.4, 0.4 + 1.2 * pL, 2.2 - 2.0 * pL, 0); arm('r', 0.4, 0.4 + 1.2 * pR, 2.2 - 2.0 * pR, 0);
        set('hips', 0, 0.3 * s(w), 0); set('spine', 0.15, 0.3 * s(w), 0); set('chest', 0, 0.2 * s(w), 0);
        set('lThigh', -0.25, 0, -0.15); set('rThigh', 0.25, 0, 0.15); set('lShin', 0.3, 0, 0); set('rShin', 0.3, 0, 0); this.root[1] = -0.05;
        break;
      }
      case 'hug': { // arms cross in front of the chest, then open wide; shoulders roll
        const k = 0.5 - 0.5 * c(1.0 * t);
        arm('l', 0.2 + 0.6 * (1 - k), 1.4 * k, 1.6 * k + 0.2, 0.9 * k); arm('r', 0.2 + 0.6 * (1 - k), 1.4 * k, 1.6 * k + 0.2, 0.9 * k);
        set('spine', 0.15 * k, 0, 0); set('chest', 0.1 * k, 0, 0); set('head', 0.15 * k, 0, 0);
        break;
      }
      case 'bow': { // bend forward at the hips, arms hanging, then straighten and raise the arms
        const k = 0.5 - 0.5 * c(0.8 * t), up = Math.max(0, -s(0.8 * t));
        set('hips', -1.1 * k, 0, 0); set('spine', -0.2 * k, 0, 0); set('head', 0.5 * k, 0, 0);
        set('lThigh', 1.1 * k, 0, 0); set('rThigh', 1.1 * k, 0, 0); this.root[1] = -0.03 * k;
        arm('l', 0.2 + 1.0 * up, 0.9 * k, 0.3 + 0.9 * up, 0); arm('r', 0.2 + 1.0 * up, 0.9 * k, 0.3 + 0.9 * up, 0);
        break;
      }
      case 'elbows': { // shoulders cycle through abduction angles while elbows flex: the pose space a sleeve has to survive
        const w = 2 * pi * 0.5 * t;
        arm('l', 0.8 + 0.7 * s(0.5 * w), 0.4 + 0.4 * s(0.7 * w), 1.0 + 0.9 * s(w), 0); arm('r', 0.8 - 0.7 * s(0.5 * w), 0.4 - 0.4 * s(0.7 * w), 1.0 - 0.9 * s(w), 0);
        set('spine', 0, 0.15 * s(0.3 * w), 0);
        break;
      }
      case 'armsup': {
        const k = 0.5 - 0.5 * c(1.2 * t);
        set('lUpperArm', -0.4 * k, 0, 2.4 * k); set('rUpperArm', -0.4 * k, 0, -2.4 * k);
        set('lForearm', -0.2 - 0.5 * k, 0, 0); set('rForearm', -0.2 - 0.5 * k, 0, 0);
        set('spine', 0.3 * s(0.6 * t), 0.5 * s(0.4 * t), 0.25 * s(0.5 * t));
        break;
      }
      case 'static': break;
    }
    if (weight < 1) { for (const b of B) { b.rot[0] *= weight; b.rot[1] *= weight; b.rot[2] *= weight; } this.root[0] *= weight; this.root[1] *= weight; this.root[2] *= weight; this.rootYaw *= weight; }
    return this.fk();
  }
}
export const motionNames = ['idle', 'walk', 'run', 'dance', 'spin', 'wave', 'curl', 'reach', 'stretch', 'punch', 'hug', 'bow', 'elbows', 'armsup', 'static'];
function sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
