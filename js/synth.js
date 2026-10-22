/**
 * synth.js – künstliche Posen im MediaPipe-Format.
 *
 * Genutzt von den Unit-Tests (bekannte Winkel → Rückrechnung prüfen) und vom
 * Demo-Modus (simulierte Person, die durch dieselbe Analysekette läuft wie
 * die echte Kamera).
 *
 * Aufbau im Körpersystem B: x = links der Person, y = oben, z = vorne,
 * Ursprung Hüftmitte. Danach Drehung um die Hochachse (yaw, 0 = Person schaut
 * zur Kamera) und Umrechnung in die MediaPipe-Konvention
 * (x = Bild-rechts, y = unten, z = von der Kamera weg).
 */

const RAD = Math.PI / 180;

function rotX(p, a) { const c = Math.cos(a), s = Math.sin(a); return { x: p.x, y: p.y * c - p.z * s, z: p.y * s + p.z * c }; }
function rotY(p, a) { const c = Math.cos(a), s = Math.sin(a); return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c }; }
function rotZ(p, a) { const c = Math.cos(a), s = Math.sin(a); return { x: p.x * c - p.y * s, y: p.x * s + p.y * c, z: p.z }; }

/** Einfacher Pseudo-Zufall mit Startwert (reproduzierbare Tests). */
export function makeRng(seed = 1) {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  return {
    next,
    /** Normalverteilt (Box-Muller). */
    gauss() { const u = Math.max(next(), 1e-12), v = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); },
  };
}

// Rumpfpunkte relativ zur Hüftmitte (Körpersystem B, Meter), aufrecht.
const TRUNK = {
  0: [0, 0.70, 0.09],              // Nase
  1: [0.03, 0.73, 0.08], 2: [0.035, 0.73, 0.075], 3: [0.045, 0.73, 0.07],
  4: [-0.03, 0.73, 0.08], 5: [-0.035, 0.73, 0.075], 6: [-0.045, 0.73, 0.07],
  7: [0.075, 0.71, 0.0], 8: [-0.075, 0.71, 0.0], // Ohren
  9: [0.025, 0.66, 0.085], 10: [-0.025, 0.66, 0.085], // Mund
  11: [0.19, 0.50, 0.0], 12: [-0.19, 0.50, 0.0], // Schultern
};
// Arme hängen locker, Hände im Schoß/auf den Oberschenkeln (relativ zur Hüftmitte, aufrecht)
const ARMS_SIT = {
  13: [0.23, 0.24, 0.06], 14: [-0.23, 0.24, 0.06], // Ellbogen
  15: [0.17, 0.05, 0.26], 16: [-0.17, 0.05, 0.26], // Handgelenke
  17: [0.16, 0.03, 0.31], 18: [-0.16, 0.03, 0.31],
  19: [0.15, 0.04, 0.32], 20: [-0.15, 0.04, 0.32],
  21: [0.15, 0.05, 0.29], 22: [-0.15, 0.05, 0.29],
};
const ARMS_STAND = {
  13: [0.23, 0.24, 0.0], 14: [-0.23, 0.24, 0.0],
  15: [0.24, 0.0, 0.03], 16: [-0.24, 0.0, 0.03],
  17: [0.245, -0.06, 0.04], 18: [-0.245, -0.06, 0.04],
  19: [0.235, -0.07, 0.05], 20: [-0.235, -0.07, 0.05],
  21: [0.23, -0.04, 0.05], 22: [-0.23, -0.04, 0.05],
};
const HIPS = { 23: [0.10, 0, 0], 24: [-0.10, 0, 0] };
const LEGS_SIT = {
  25: [0.11, -0.03, 0.44], 26: [-0.11, -0.03, 0.44],   // Knie vorne, Oberschenkel waagerecht
  27: [0.11, -0.46, 0.45], 28: [-0.11, -0.46, 0.45],   // Knöchel
  29: [0.11, -0.49, 0.40], 30: [-0.11, -0.49, 0.40],
  31: [0.11, -0.50, 0.56], 32: [-0.11, -0.50, 0.56],
};
const LEGS_STAND = {
  25: [0.10, -0.43, 0.02], 26: [-0.10, -0.43, 0.02],
  27: [0.10, -0.85, 0.0], 28: [-0.10, -0.85, 0.0],
  29: [0.10, -0.89, -0.05], 30: [-0.10, -0.89, -0.05],
  31: [0.10, -0.91, 0.12], 32: [-0.10, -0.91, 0.12],
};

/**
 * Erzeugt eine Pose.
 * @param {object} o
 * @param {number} [o.flex=0]   Vorbeugen in Grad (+ vor)
 * @param {number} [o.lat=0]    Seitneigung in Grad (+ nach rechts)
 * @param {number} [o.twist=0]  Rumpfdrehung in Grad (+ nach rechts)
 * @param {number} [o.yaw=0]    Blickrichtung zur Kamera (0 frontal, 90 = Person schaut nach Bild-rechts)
 * @param {'sitzen'|'stehen'} [o.posture='sitzen']
 * @param {boolean} [o.legsVisible=true]
 * @param {number} [o.noise=0]  Rauschen der Weltkoordinaten (Standardabweichung in m)
 * @param {{x:number,y:number}} [o.offset]  Position der Hüftmitte im Bild (normiert)
 * @param {number} [o.imageScale=0.55]  Bildhöhe-Anteil je Meter
 * @param {number} [o.aspect=4/3]  Bildseitenverhältnis (Breite/Höhe)
 * @param {object} [o.rng]  Zufallsquelle (makeRng)
 * @returns {{world:Array, image:Array}}
 */
export function makePose(o = {}) {
  const {
    flex = 0, lat = 0, twist = 0, yaw = 0, posture = 'sitzen', legsVisible = true,
    noise = 0, offset = { x: 0.5, y: 0.6 }, imageScale = 0.55, aspect = 4 / 3,
    rng = makeRng(7), armsRaised = 0,
  } = o;

  const trunkPts = { ...TRUNK, ...(posture === 'stehen' ? ARMS_STAND : ARMS_SIT) };
  if (armsRaised) {
    // Arm über den Kopf (für die Seitneigungs-Demo): linear zwischen Ruhe und oben
    const up = { 13: [0.21, 0.78, 0.0], 15: [0.12, 1.02, 0.02], 17: [0.11, 1.07, 0.02], 19: [0.10, 1.08, 0.03], 21: [0.11, 1.05, 0.03] };
    for (const k of Object.keys(up)) {
      const a = trunkPts[k], b = up[k];
      trunkPts[k] = a.map((v, i) => v + (b[i] - v) * armsRaised);
    }
  }
  const legs = posture === 'stehen' ? LEGS_STAND : LEGS_SIT;

  const f = flex * RAD, l = lat * RAD, tw = twist * RAD, yw = yaw * RAD;
  const pts = new Array(33);
  // Rumpf: erst Drehung um die Rumpfachse, dann Seitneigung, dann Vorbeugen.
  // Drehung nach rechts = linke Schulter kommt nach vorne = Ry(-twist).
  for (const [k, p] of Object.entries(trunkPts)) {
    let q = { x: p[0], y: p[1], z: p[2] };
    q = rotY(q, -tw);
    q = rotZ(q, l);   // +l kippt „oben“ zur rechten Seite (−x)
    q = rotX(q, f);   // +f kippt „oben“ nach vorne (+z)
    pts[k] = q;
  }
  for (const [k, p] of Object.entries({ ...HIPS, ...legs })) pts[k] = { x: p[0], y: p[1], z: p[2] };

  const world = new Array(33);
  const image = new Array(33);
  for (let i = 0; i < 33; i++) {
    let q = rotY(pts[i], yw);
    // MediaPipe-Konvention: x Bild-rechts. Person schaut zur Kamera (+z),
    // ihre linke Seite (+x in B) erscheint im ungespiegelten Bild rechts.
    const raw = { x: q.x, y: -q.y, z: -q.z };
    const isLeg = i >= 25;
    const v = isLeg && !legsVisible ? 0.08 : 0.98;
    const n = noise ? () => rng.gauss() * noise : () => 0;
    world[i] = { x: raw.x + n(), y: raw.y + n(), z: raw.z + n(), visibility: v };
    image[i] = {
      x: offset.x + (raw.x * imageScale) / aspect,
      y: offset.y + raw.y * imageScale,
      z: raw.z * imageScale,
      visibility: v,
    };
  }
  return { world, image };
}
