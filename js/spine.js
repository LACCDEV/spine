/**
 * spine.js – Bewegungsanalyse des Rumpfes aus MediaPipe-Pose-Landmarken.
 *
 * Reine Mathematik ohne Browser-Abhängigkeiten, damit die Funktionen auch
 * unter Node getestet werden können (siehe tests/unit.test.mjs).
 *
 * KOORDINATEN
 * MediaPipe liefert „World Landmarks“ in Metern, Ursprung in der Hüftmitte.
 * Achsen wie im (nicht gespiegelten!) Kamerabild: x nach rechts im Bild,
 * y nach unten, z von der Kamera weg. Wir rechnen intern in einem
 * rechtshändigen System C mit
 *     x = Bild-rechts,  y = oben,  z = zur Kamera hin.
 * Die Analyse läuft immer auf den ungespiegelten Rohdaten. Die Spiegelung
 * (Selfie-Ansicht) passiert ausschließlich beim Zeichnen. Deshalb gilt
 * „links/rechts“ hier immer aus Sicht der Person (MediaPipe: Index 11 =
 * linke Schulter der Person).
 *
 * VORZEICHEN (aus Sicht der Person)
 *     flex  > 0  Vorbeugen (Flexion),   < 0  Strecken/Zurücklehnen
 *     lat   > 0  Seitneigung nach rechts, < 0  nach links
 *     twist > 0  Schultern gegen Becken nach rechts gedreht, < 0 nach links
 *
 * BLICKRICHTUNG
 * Der Körperbezug wird aus der Becken-Querachse (rechte → linke Hüfte) und
 * der Lotrechten gebildet. Daraus ergibt sich „vorne“ der Person – egal, ob
 * sie frontal, schräg oder seitlich zur Kamera sitzt. Die Kamera muss dafür
 * ungefähr aufrecht stehen (Lotrechte ≈ Bild-oben). Wie gut eine Richtung
 * beobachtbar ist, hängt trotzdem von der Blickrichtung ab: Was in der
 * Bildtiefe passiert, schätzt das Modell nur. Dafür liefern wir
 * „depthF“/„depthL“ (0 … 1), mit denen die Rauschgrenze angehoben wird.
 */

/** Indizes der benötigten MediaPipe-Pose-Landmarken (33 Punkte). */
export const LM = Object.freeze({
  NOSE: 0, L_EAR: 7, R_EAR: 8,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
});

const DEG = 180 / Math.PI;
const UP = { x: 0, y: 1, z: 0 };

// ---------------------------------------------------------------------------
// Kleine Vektorhilfen (Objekte {x,y,z}, bewusst ohne Klassen)
// ---------------------------------------------------------------------------
export const vec = {
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
  scale: (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s }),
  dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
  cross: (a, b) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }),
  len: (a) => Math.hypot(a.x, a.y, a.z),
  mid: (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }),
  norm(a) {
    const l = Math.hypot(a.x, a.y, a.z);
    return l > 1e-9 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
  },
  /** Anteil von a senkrecht zur Einheitsachse n. */
  reject(a, n) {
    const d = a.x * n.x + a.y * n.y + a.z * n.z;
    return { x: a.x - d * n.x, y: a.y - d * n.y, z: a.z - d * n.z };
  },
};

/**
 * MediaPipe-Weltkoordinate → internes System C (y oben, z zur Kamera).
 * zSign = −1 dreht die Tiefenrichtung um (siehe DepthConventionCheck).
 */
export function toC(p, zSign = 1) {
  return { x: p.x, y: -p.y, z: -p.z * zSign };
}

const vis = (p) => (p && typeof p.visibility === 'number' ? p.visibility : 1);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------------------
// One-Euro-Filter (Casiez, Roussel & Vogel, CHI 2012)
// Glättet stark bei langsamer Bewegung (Zittern weg) und wenig bei schneller
// Bewegung (kaum Verzögerung).
// ---------------------------------------------------------------------------
function smoothingFactor(dt, cutoff) {
  const r = 2 * Math.PI * cutoff * dt;
  return r / (r + 1);
}

export class OneEuroFilter {
  /**
   * @param {number} minCutoff  Grund-Grenzfrequenz in Hz (kleiner = glatter)
   * @param {number} beta       wie stark die Grenzfrequenz mit dem Tempo steigt
   * @param {number} dCutoff    Grenzfrequenz für die Ableitung
   */
  constructor(minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }
  reset() {
    this.x = null;
    this.dx = 0;
    this.t = null;
  }
  /** @param {number} value  @param {number} t  Zeit in Sekunden */
  filter(value, t) {
    if (this.x === null || this.t === null || t <= this.t) {
      if (this.x === null) this.x = value;
      this.t = t;
      return this.x;
    }
    const dt = Math.min(t - this.t, 0.5); // nach Pausen nicht „springen“
    this.t = t;
    const dxRaw = (value - this.x) / dt;
    this.dx += smoothingFactor(dt, this.dCutoff) * (dxRaw - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += smoothingFactor(dt, cutoff) * (value - this.x);
    return this.x;
  }
}

/** Filtert eine komplette Landmarkenliste (x, y, z je Punkt; visibility geglättet). */
export class LandmarkFilter {
  constructor({ minCutoff = 1.2, beta = 6, dCutoff = 1.0, count = 33 } = {}) {
    this.opts = { minCutoff, beta, dCutoff };
    this.count = count;
    this.reset();
  }
  reset() {
    const { minCutoff, beta, dCutoff } = this.opts;
    this.f = Array.from({ length: this.count }, () => [
      new OneEuroFilter(minCutoff, beta, dCutoff),
      new OneEuroFilter(minCutoff, beta, dCutoff),
      new OneEuroFilter(minCutoff, beta, dCutoff),
    ]);
    this.v = new Array(this.count).fill(null);
  }
  apply(landmarks, t) {
    const out = new Array(landmarks.length);
    for (let i = 0; i < landmarks.length; i++) {
      const p = landmarks[i];
      const fi = this.f[i];
      if (!fi) { out[i] = p; continue; }
      const prevV = this.v[i];
      const v = prevV === null ? vis(p) : prevV + 0.35 * (vis(p) - prevV);
      this.v[i] = v;
      out[i] = {
        x: fi[0].filter(p.x, t),
        y: fi[1].filter(p.y, t),
        z: fi[2].filter(p.z ?? 0, t),
        visibility: v,
      };
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Rumpfwinkel
// ---------------------------------------------------------------------------

/**
 * Berechnet Beugen/Strecken, Seitneigung und Drehung des Rumpfes.
 * @param {Array<{x,y,z,visibility}>} world  33 MediaPipe-Weltlandmarken (roh)
 * @returns {{ok:boolean, reason?:string, flex?:number, lat?:number, twist?:number,
 *            viewYaw?:number, depthF?:number, depthL?:number, hipWeak?:boolean,
 *            visibility?:number}}
 */
export function computeTrunkAngles(world, { minShoulderVis = 0.5, minHipVis = 0.2, goodHipVis = 0.5, zSign = 1 } = {}) {
  if (!world || world.length <= LM.R_HIP) return { ok: false, reason: 'keine-person' };
  const ls = world[LM.L_SHOULDER], rs = world[LM.R_SHOULDER];
  const lh = world[LM.L_HIP], rh = world[LM.R_HIP];
  const shoulderVis = Math.min(vis(ls), vis(rs));
  const hipVis = Math.min(vis(lh), vis(rh));
  if (shoulderVis < minShoulderVis) return { ok: false, reason: 'schultern' };
  if (hipVis < minHipVis) return { ok: false, reason: 'huefte' };

  const LS = toC(ls, zSign), RS = toC(rs, zSign), LH = toC(lh, zSign), RH = toC(rh, zSign);
  const hipMid = vec.mid(LH, RH);
  const shMid = vec.mid(LS, RS);
  const trunk = vec.sub(shMid, hipMid);
  if (vec.len(trunk) < 0.05) return { ok: false, reason: 'unklar' };
  const u = vec.norm(trunk); // Rumpfachse (Becken → Schultern)

  // Becken-Querachse zur linken Seite der Person, waagerecht gemacht.
  const pelvis = vec.sub(LH, RH);
  let lat = { x: pelvis.x, y: 0, z: pelvis.z };
  if (vec.len(lat) < 0.03) {
    // Hüften kaum unterscheidbar → hilfsweise Schulterachse nehmen
    const sh = vec.sub(LS, RS);
    lat = { x: sh.x, y: 0, z: sh.z };
    if (vec.len(lat) < 0.03) return { ok: false, reason: 'unklar' };
  }
  const L = vec.norm(lat);           // links der Person
  const F = vec.cross(L, UP);        // vorne der Person (links × oben = vorne)

  const uF = vec.dot(u, F), uU = vec.dot(u, UP), uL = vec.dot(u, L);
  const flex = Math.atan2(uF, uU) * DEG;   // + = vorbeugen
  const latBend = Math.atan2(-uL, uU) * DEG; // + = nach rechts neigen

  // Drehung: Schulter- gegen Beckenachse, beide in die Ebene senkrecht zur Rumpfachse projiziert.
  const a = vec.norm(vec.reject(pelvis, u));
  const b = vec.norm(vec.reject(vec.sub(LS, RS), u));
  const twistLeft = Math.atan2(vec.dot(vec.cross(a, b), u), vec.dot(a, b)) * DEG;

  return {
    ok: true,
    flex,
    lat: latBend,
    twist: -twistLeft, // + = nach rechts
    viewYaw: Math.atan2(F.x, F.z) * DEG, // 0 = frontal zur Kamera, ±90 = seitlich
    depthF: Math.abs(F.z), // 1 = Vorbeugen geschieht in der Bildtiefe (frontale Sicht)
    depthL: Math.abs(L.z), // 1 = Seitneigung/Schulterachse in der Bildtiefe (seitliche Sicht)
    hipWeak: hipVis < goodHipVis,
    visibility: Math.min(shoulderVis, hipVis),
    faceDot: faceForwardDot(world, F, zSign),
  };
}

/**
 * Anatomische Plausibilitätsprüfung: Die Nase liegt vor den Ohren. Liefert
 * das Skalarprodukt aus (Nase − Ohrmitte, waagerecht, normiert) und der
 * berechneten Vorwärtsrichtung F, oder undefined, wenn das Gesicht nicht gut
 * zu sehen ist. Werte nahe +1 bestätigen die Achsen, nahe −1 widersprechen.
 */
function faceForwardDot(world, F, zSign) {
  const n = world[LM.NOSE], le = world[LM.L_EAR], re = world[LM.R_EAR];
  if (!n || !le || !re || vis(n) < 0.6 || Math.min(vis(le), vis(re)) < 0.4) return undefined;
  const N = toC(n, zSign), E = vec.mid(toC(le, zSign), toC(re, zSign));
  const d = { x: N.x - E.x, y: 0, z: N.z - E.z };
  if (vec.len(d) < 0.02) return undefined;
  return vec.dot(vec.norm(d), F);
}

/**
 * Prüft fortlaufend, ob die Tiefenachse (z) der MediaPipe-Weltkoordinaten
 * so zeigt wie angenommen (von der Kamera weg). Die Dokumentation legt das
 * für Weltkoordinaten nicht ausdrücklich fest. Ist die Vorwärtsrichtung über
 * viele Bilder systematisch „hinter dem Gesicht“, wird zSign umgedreht.
 * Das betrifft die Vorzeichen von Beugen und Drehung (nicht der Seitneigung).
 */
export class DepthConventionCheck {
  constructor({ minSamples = 45, threshold = -0.3 } = {}) {
    this.minSamples = minSamples;
    this.threshold = threshold;
    this.zSign = 1;
    this.flips = 0;
    this.reset();
  }
  reset() { this.sum = 0; this.n = 0; }
  /** @param {number|undefined} faceDot  aus computeTrunkAngles (mit aktuellem zSign) */
  update(faceDot) {
    if (typeof faceDot !== 'number' || !Number.isFinite(faceDot)) return this.zSign;
    this.sum += faceDot;
    this.n++;
    if (this.n >= this.minSamples) {
      if (this.sum / this.n < this.threshold) {
        this.zSign = -this.zSign;
        this.flips++;
      }
      this.reset();
    }
    return this.zSign;
  }
}

// ---------------------------------------------------------------------------
// Sitzen oder Stehen
// ---------------------------------------------------------------------------

/** Winkel des Oberschenkels gegen die Senkrechte (0° = senkrecht nach unten) oder null. */
export function thighAngle(world, minVis = 0.5) {
  if (!world || world.length <= LM.R_KNEE) return null;
  const sides = [[LM.L_HIP, LM.L_KNEE], [LM.R_HIP, LM.R_KNEE]];
  let sum = 0, n = 0;
  for (const [h, k] of sides) {
    if (vis(world[h]) < minVis || vis(world[k]) < minVis) continue;
    const d = vec.norm(vec.sub(toC(world[k]), toC(world[h])));
    sum += Math.acos(Math.max(-1, Math.min(1, -d.y))) * DEG;
    n++;
  }
  return n ? sum / n : null;
}

/**
 * Unterscheidet Sitzen/Stehen mit Hysterese. Ohne sichtbare Knie wird Sitzen
 * angenommen (typische Schreibtischsituation) und als „angenommen“ markiert.
 */
export class PostureClassifier {
  constructor({ standBelow = 35, sitAbove = 55, holdFrames = 6 } = {}) {
    Object.assign(this, { standBelow, sitAbove, holdFrames });
    this.reset();
  }
  reset() {
    this.posture = 'sitzen';
    this.assumed = true;
    this.candidate = null;
    this.count = 0;
    this.changedAt = -Infinity;
  }
  /** @returns {{posture:'sitzen'|'stehen', assumed:boolean, angle:number|null, changed:boolean}} */
  update(world, t = 0) {
    const angle = thighAngle(world);
    if (angle === null) {
      // Knie unsichtbar: letzte sichere Einschätzung nicht überschreiben,
      // aber kenntlich machen, dass es eine Annahme ist.
      this.assumed = true;
      this.count = 0;
      return { posture: this.posture, assumed: true, angle: null, changed: false };
    }
    let next = null;
    if (angle < this.standBelow) next = 'stehen';
    else if (angle > this.sitAbove) next = 'sitzen';
    let changed = false;
    if (next && next !== this.posture) {
      if (this.candidate === next) this.count++;
      else { this.candidate = next; this.count = 1; }
      if (this.count >= this.holdFrames) {
        changed = !this.assumed; // Wechsel nur zählen, wenn vorher auch gesehen
        this.posture = next;
        this.count = 0;
        this.changedAt = t;
      }
    } else {
      this.candidate = null;
      this.count = 0;
    }
    this.assumed = false;
    return { posture: this.posture, assumed: false, angle, changed };
  }
}

// ---------------------------------------------------------------------------
// Bewegungsmaß
// ---------------------------------------------------------------------------

/**
 * Bewegungsumfang, der für die volle Punktzahl einer Richtung nötig ist
 * (Schwankungsbreite innerhalb des Zeitfensters, in Grad). Bewusst moderat,
 * damit die Übungen auch im Sitzen erreichbar sind.
 */
export const MOTION_TARGET = Object.freeze({ flex: 28, lat: 16, twist: 22 });

/**
 * Rauschgrenze in Grad: Schwankungen darunter gelten als Messzittern.
 * Sie steigt, wenn eine Richtung in der Bildtiefe liegt (schlechter sichtbar).
 */
export function noiseFloor(axis, depthF = 0.5, depthL = 0.5) {
  switch (axis) {
    case 'flex': return 3.5 + 3.5 * depthF;
    case 'lat': return 3.0 + 3.5 * depthL;
    case 'twist': return 4.0 + 4.0 * depthL;
    default: return 4;
  }
}

/** Robuste Spannweite (90. minus 10. Perzentil), unempfindlich gegen Ausreißer. */
export function robustRange(values) {
  const n = values.length;
  if (n < 3) return 0;
  const s = Float64Array.from(values).sort();
  const q = (p) => {
    const i = p * (n - 1);
    const lo = Math.floor(i), hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  };
  return q(0.9) - q(0.1);
}

const AXES = ['flex', 'lat', 'twist'];

/**
 * Sammelt Winkel über ein gleitendes Zeitfenster und leitet daraus ab,
 * „wie stark die Wirbelsäule gerade pumpt“ (0 … 1). Reines Verharren in
 * einer Haltung ergibt 0, auch wenn die Haltung ungewöhnlich ist.
 */
export class MotionAnalyzer {
  constructor({ windowSec = 6, progressSec = 20 } = {}) {
    this.windowSec = windowSec;
    this.progressSec = progressSec;
    this.reset();
  }
  reset() {
    this.samples = [];      // {t, flex, lat, twist, depthF, depthL}
    this.scoreHist = [];    // {t, flex, lat, twist}
    this.bodyBuf = [];      // jüngste Hüftpositionen {t, x, y}
    this.bodySpeed = 0;     // geglättete Geschwindigkeit in Rumpflängen/s
    this.bodyPeak = 0;      // Ganzkörperbewegung mit Nachlauf
    this.lastBodyT = null;
    this.result = this.empty();
  }
  empty() {
    return { flex: 0, lat: 0, twist: 0, spine: 0, body: 0, ranges: { flex: 0, lat: 0, twist: 0 },
      progress: { flex: 0, lat: 0, twist: 0 } };
  }

  /** Neuer Satz Rumpfwinkel (Ergebnis von computeTrunkAngles). */
  push(t, a) {
    this.samples.push({ t, flex: a.flex, lat: a.lat, twist: a.twist,
      depthF: a.depthF ?? 0.5, depthL: a.depthL ?? 0.5 });
    const cut = t - this.windowSec;
    while (this.samples.length && this.samples[0].t < cut) this.samples.shift();
    return this.evaluate(t);
  }

  /**
   * Bewegung der ganzen Person im Bild (Gehen, Aufstehen, Hinsetzen).
   * @param {number} t  Zeit in s
   * @param {{x:number,y:number}} hip  Hüftmitte in normierten Bildkoordinaten
   * @param {number} scale  Rumpflänge im Bild (normiert) zum Maßstabsausgleich
   * @param {boolean} postureChanged  Haltungswechsel Sitzen↔Stehen erkannt
   */
  pushBody(t, hip, scale, postureChanged = false) {
    // Verschiebung gegenüber der Position vor ~0,5 s statt von Bild zu Bild:
    // Bild-zu-Bild-Differenzen würden das Zittern der Schätzung verstärken.
    const buf = this.bodyBuf;
    buf.push({ t, x: hip.x, y: hip.y });
    while (buf.length > 2 && buf[1].t <= t - 0.5) buf.shift();
    if (buf.length && t - buf[0].t > 1.5) buf.splice(0, buf.length - 1); // nach Lücken neu beginnen
    const dtPeak = this.lastBodyT === null ? 0 : Math.min(t - this.lastBodyT, 1);
    const dtStep = this.lastBodyT === null ? 0 : Math.min(t - this.lastBodyT, 0.5);
    this.lastBodyT = t;
    const ref = buf[0];
    if (ref && t - ref.t >= 0.2 && scale > 0.02) {
      const d = Math.hypot(hip.x - ref.x, hip.y - ref.y) / Math.max(scale, 0.05);
      const sp = d / (t - ref.t);
      this.bodySpeed += (1 - Math.exp(-dtStep / 0.3)) * (sp - this.bodySpeed);
    }
    // 0,15 Rumpflängen/s ≈ Zittern/Umschauen; ab ~1 Rumpflänge/s volle Wertung
    let inst = clamp01((this.bodySpeed - 0.15) / 0.85);
    if (postureChanged) inst = 1;
    // Spitzenwert mit Nachlauf (~3 s), damit kurze Aktionen wie Aufstehen zählen
    this.bodyPeak = Math.max(inst, this.bodyPeak * Math.exp(-dtPeak / 3));
    this.result.body = this.bodyPeak;
    return this.bodyPeak;
  }

  /** Lässt die Werte bei fehlenden Daten sanft abklingen. */
  decay(t, dt) {
    const k = Math.exp(-dt / 2);
    for (const ax of AXES) this.result[ax] *= k;
    this.result.spine *= k;
    this.bodyPeak *= k;
    this.result.body = this.bodyPeak;
    // Zeitfenster leeren, damit alte Werte nach der Lücke nicht wieder auftauchen
    const cut = t - this.windowSec;
    while (this.samples.length && this.samples[0].t < cut) this.samples.shift();
    this.updateProgress(t);
    return this.result;
  }

  evaluate(t) {
    const r = this.result;
    const n = this.samples.length;
    const span = n > 1 ? this.samples[n - 1].t - this.samples[0].t : 0;
    if (n < 5 || span < 0.6) {
      for (const ax of AXES) r[ax] = 0;
      r.spine = 0;
      this.updateProgress(t);
      return r;
    }
    let dF = 0, dL = 0;
    for (const s of this.samples) { dF += s.depthF; dL += s.depthL; }
    dF /= n; dL /= n;
    for (const ax of AXES) {
      const range = robustRange(this.samples.map((s) => s[ax]));
      const nf = noiseFloor(ax, dF, dL);
      r.ranges[ax] = range;
      r[ax] = clamp01((range - nf) / (MOTION_TARGET[ax] - nf));
    }
    const mx = Math.max(r.flex, r.lat, r.twist);
    const mean = (r.flex + r.lat + r.twist) / 3;
    r.spine = clamp01(0.7 * mx + 0.3 * mean);
    this.updateProgress(t);
    return r;
  }

  /** Fortschritt je Richtung = bester Wert der letzten progressSec Sekunden. */
  updateProgress(t) {
    const r = this.result;
    this.scoreHist.push({ t, flex: r.flex, lat: r.lat, twist: r.twist });
    const cut = t - this.progressSec;
    while (this.scoreHist.length && this.scoreHist[0].t < cut) this.scoreHist.shift();
    for (const ax of AXES) {
      let m = 0;
      for (const s of this.scoreHist) if (s[ax] > m) m = s[ax];
      r.progress[ax] = m;
    }
  }
}

/** Hüftmitte und Rumpflänge in normierten Bildkoordinaten (für Ganzkörperbewegung). */
export function imageBodyMetrics(image) {
  if (!image || image.length <= LM.R_HIP) return null;
  const ls = image[LM.L_SHOULDER], rs = image[LM.R_SHOULDER];
  const lh = image[LM.L_HIP], rh = image[LM.R_HIP];
  if (Math.min(vis(ls), vis(rs)) < 0.5) return null;
  const sh = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const hipOk = Math.min(vis(lh), vis(rh)) >= 0.2;
  const hip = hipOk ? { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 } : null;
  const ref = hip ?? sh; // ohne Hüfte: Schultermitte verfolgen
  const scale = hip ? Math.hypot(sh.x - hip.x, sh.y - hip.y)
    : Math.hypot(ls.x - rs.x, ls.y - rs.y) * 1.4;
  return { center: ref, scale, shoulder: sh, hip };
}
