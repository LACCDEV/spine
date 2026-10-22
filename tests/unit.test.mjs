// Unit-Tests für Winkelberechnung, Haltung, Bewegungsmaß und Versorgungsmodell.
// Ausführen (ohne Abhängigkeiten):  node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeTrunkAngles, PostureClassifier, MotionAnalyzer, LandmarkFilter,
  OneEuroFilter, robustRange, imageBodyMetrics, thighAngle, DepthConventionCheck,
} from '../js/spine.js';
import { makePose, makeRng } from '../js/synth.js';
import { SupplyModel, supplyLevel } from '../js/supply.js';

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: erwartet ${expected}±${tol}, erhalten ${actual.toFixed(2)}`);

const YAWS = [0, 30, -45, 90, -90, 135, 180];

// ---------------------------------------------------------------------------
test('aufrecht, frontal: alle Winkel ≈ 0', () => {
  const a = computeTrunkAngles(makePose().world);
  assert.equal(a.ok, true);
  near(a.flex, 0, 0.5, 'flex');
  near(a.lat, 0, 0.5, 'lat');
  near(a.twist, 0, 0.5, 'twist');
  near(a.viewYaw, 0, 0.5, 'viewYaw');
});

test('Vorbeugen ist positiv, Strecken negativ – unabhängig von der Blickrichtung', () => {
  for (const yaw of YAWS) {
    const f = computeTrunkAngles(makePose({ flex: 30, yaw }).world);
    near(f.flex, 30, 1, `flex bei yaw ${yaw}`);
    near(f.lat, 0, 1, `lat (Übersprechen) bei yaw ${yaw}`);
    near(f.twist, 0, 1, `twist (Übersprechen) bei yaw ${yaw}`);
    const e = computeTrunkAngles(makePose({ flex: -15, yaw }).world);
    near(e.flex, -15, 1, `Strecken bei yaw ${yaw}`);
  }
});

test('Seitneigung: rechts positiv, links negativ – unabhängig von der Blickrichtung', () => {
  for (const yaw of YAWS) {
    const r = computeTrunkAngles(makePose({ lat: 20, yaw }).world);
    near(r.lat, 20, 1, `rechts bei yaw ${yaw}`);
    near(r.flex, 0, 1, `flex (Übersprechen) bei yaw ${yaw}`);
    const l = computeTrunkAngles(makePose({ lat: -20, yaw }).world);
    near(l.lat, -20, 1, `links bei yaw ${yaw}`);
  }
});

test('Drehung: rechts positiv, links negativ – unabhängig von der Blickrichtung', () => {
  for (const yaw of YAWS) {
    const r = computeTrunkAngles(makePose({ twist: 25, yaw }).world);
    near(r.twist, 25, 1, `rechts bei yaw ${yaw}`);
    near(r.flex, 0, 1, `flex (Übersprechen) bei yaw ${yaw}`);
    near(r.lat, 0, 1, `lat (Übersprechen) bei yaw ${yaw}`);
    const l = computeTrunkAngles(makePose({ twist: -25, yaw }).world);
    near(l.twist, -25, 1, `links bei yaw ${yaw}`);
  }
});

test('Drehung bleibt korrekt, wenn die Person dabei vorgebeugt ist', () => {
  const a = computeTrunkAngles(makePose({ flex: 25, twist: 20 }).world);
  near(a.twist, 20, 1.5, 'twist');
  near(a.flex, 25, 1.5, 'flex');
});

test('Vorzeichen-Plausibilität: rechte Schulter tiefer bei Neigung nach rechts', () => {
  const { world } = makePose({ lat: 20 });
  // MediaPipe: y zeigt nach unten → tiefer = größeres y. Index 12 = rechte Schulter.
  assert.ok(world[12].y > world[11].y, 'rechte Schulter sollte tiefer liegen');
  // Bei Drehung nach rechts kommt die linke Schulter (11) nach vorne = näher zur Kamera (kleineres z)
  const t = makePose({ twist: 25 }).world;
  assert.ok(t[11].z < t[12].z, 'linke Schulter sollte näher an der Kamera sein');
});

test('Blickrichtung: Seitansicht wird erkannt, Tiefenanteile passen', () => {
  const side = computeTrunkAngles(makePose({ yaw: 90 }).world);
  near(Math.abs(side.viewYaw), 90, 1, 'viewYaw');
  near(side.depthF, 0, 0.05, 'depthF seitlich');
  near(side.depthL, 1, 0.05, 'depthL seitlich');
  const front = computeTrunkAngles(makePose({ yaw: 0 }).world);
  near(front.depthF, 1, 0.05, 'depthF frontal');
});

test('fehlende Schultern oder Hüfte werden gemeldet', () => {
  const p = makePose().world;
  const noSh = p.map((q, i) => (i === 11 ? { ...q, visibility: 0.1 } : q));
  assert.deepEqual(computeTrunkAngles(noSh), { ok: false, reason: 'schultern' });
  const noHip = p.map((q, i) => (i === 23 || i === 24 ? { ...q, visibility: 0.05 } : q));
  assert.deepEqual(computeTrunkAngles(noHip), { ok: false, reason: 'huefte' });
  const weakHip = p.map((q, i) => (i === 23 || i === 24 ? { ...q, visibility: 0.35 } : q));
  const w = computeTrunkAngles(weakHip);
  assert.equal(w.ok, true);
  assert.equal(w.hipWeak, true);
  assert.equal(computeTrunkAngles(null).ok, false);
  assert.equal(computeTrunkAngles([]).ok, false);
});

test('Tiefenachse: Nase-vor-Ohren-Prüfung erkennt eine gespiegelte z-Konvention', () => {
  const ok = computeTrunkAngles(makePose({ flex: 30, twist: 20 }).world);
  assert.ok(ok.faceDot > 0.9, `faceDot bei korrekter Konvention: ${ok.faceDot}`);

  // Angenommen, MediaPipe würde z zur Kamera hin zählen: z aller Punkte negieren.
  const flipWorld = (w) => w.map((p) => ({ ...p, z: -p.z }));
  const flipped = flipWorld(makePose({ flex: 30, twist: 20 }).world);
  const wrong = computeTrunkAngles(flipped);
  assert.ok(wrong.faceDot < -0.9, 'Widerspruch wird erkannt');
  assert.ok(wrong.flex < 0, 'ohne Korrektur wäre das Vorzeichen falsch');

  const check = new DepthConventionCheck({ minSamples: 20 });
  for (let i = 0; i < 25; i++) {
    const a = computeTrunkAngles(flipped, { zSign: check.zSign });
    check.update(a.faceDot);
  }
  assert.equal(check.zSign, -1, 'Konvention wurde umgedreht');
  const fixed = computeTrunkAngles(flipped, { zSign: check.zSign });
  near(fixed.flex, 30, 1.5, 'flex nach Korrektur');
  near(fixed.twist, 20, 1.5, 'twist nach Korrektur');
  near(fixed.lat, wrong.lat, 0.01, 'Seitneigung unabhängig von z');

  // Bei korrekter Konvention bleibt es dauerhaft bei +1 (auch seitlich, mit Rauschen)
  const stable = new DepthConventionCheck({ minSamples: 20 });
  const rng = makeRng(4);
  for (let i = 0; i < 200; i++) {
    const a = computeTrunkAngles(makePose({ yaw: (i % 4) * 30, flex: 20, noise: 0.006, rng }).world, { zSign: stable.zSign });
    stable.update(a.faceDot);
  }
  assert.equal(stable.zSign, 1);
  assert.equal(stable.flips, 0);
});

// ---------------------------------------------------------------------------
test('Sitzen/Stehen bei sichtbaren Knien, Annahme ohne Knie', () => {
  const sit = makePose({ posture: 'sitzen' }).world;
  const stand = makePose({ posture: 'stehen' }).world;
  assert.ok(thighAngle(sit) > 70, 'Oberschenkel im Sitzen ≈ waagerecht');
  assert.ok(thighAngle(stand) < 15, 'Oberschenkel im Stehen ≈ senkrecht');

  const pc = new PostureClassifier({ holdFrames: 3 });
  let r = pc.update(makePose({ legsVisible: false }).world);
  assert.equal(r.posture, 'sitzen');
  assert.equal(r.assumed, true);

  for (let i = 0; i < 5; i++) r = pc.update(sit, i);
  assert.equal(r.posture, 'sitzen');
  assert.equal(r.assumed, false);

  let changed = false;
  for (let i = 0; i < 5; i++) { r = pc.update(stand, 5 + i); changed ||= r.changed; }
  assert.equal(r.posture, 'stehen');
  assert.equal(changed, true, 'Aufstehen sollte als Wechsel gemeldet werden');

  // Auch seitlich zur Kamera
  const pc2 = new PostureClassifier({ holdFrames: 1 });
  assert.equal(pc2.update(makePose({ posture: 'stehen', yaw: 90 }).world).posture, 'stehen');
});

test('Hysterese: einzelne Ausreißer kippen die Haltung nicht', () => {
  const pc = new PostureClassifier({ holdFrames: 4 });
  const sit = makePose({ posture: 'sitzen' }).world;
  const stand = makePose({ posture: 'stehen' }).world;
  for (let i = 0; i < 5; i++) pc.update(sit, i);
  pc.update(stand, 6); pc.update(stand, 7);
  assert.equal(pc.update(sit, 8).posture, 'sitzen');
});

// ---------------------------------------------------------------------------
function runSequence(fn, { seconds = 10, fps = 30, noise = 0.004, seed = 3 } = {}) {
  const rng = makeRng(seed);
  const filter = new LandmarkFilter();
  const ma = new MotionAnalyzer();
  let res;
  for (let i = 0; i < seconds * fps; i++) {
    const t = i / fps;
    const { world } = makePose({ ...fn(t), noise, rng });
    const a = computeTrunkAngles(filter.apply(world, t));
    if (a.ok) res = ma.push(t, a);
  }
  return res;
}

test('Zittern der Pose-Schätzung zählt nicht als Bewegung', () => {
  for (const yaw of [0, 90]) {
    const r = runSequence(() => ({ flex: 10, yaw }), { noise: 0.006 });
    assert.ok(r.spine < 0.05, `Bewegungsmaß bei Rauschen (yaw ${yaw}) sollte ≈0 sein, ist ${r.spine.toFixed(3)}`);
  }
});

test('Verharren in einer (auch krummen) Haltung zählt nicht als Bewegung', () => {
  const r = runSequence(() => ({ flex: 35, lat: 10, twist: 15 }));
  assert.ok(r.spine < 0.05, `spine=${r.spine}`);
});

test('Katze-Kuh, Seitneigung und Drehung werden als Bewegung erkannt', () => {
  const cat = runSequence((t) => ({ flex: 10 + 20 * Math.sin(2 * Math.PI * t / 4) }));
  assert.ok(cat.flex > 0.7 && cat.spine > 0.6, `flex=${cat.flex}`);
  assert.ok(cat.lat < 0.15 && cat.twist < 0.15, 'kaum Übersprechen');

  const side = runSequence((t) => ({ lat: 14 * Math.sin(2 * Math.PI * t / 4) }));
  assert.ok(side.lat > 0.7, `lat=${side.lat}`);

  const rot = runSequence((t) => ({ twist: 20 * Math.sin(2 * Math.PI * t / 5) }));
  assert.ok(rot.twist > 0.7, `twist=${rot.twist}`);

  // Fortschritt hält den besten Wert eine Weile
  assert.ok(rot.progress.twist >= rot.twist);
});

test('kleine Bewegung gibt Teilpunkte, große volle', () => {
  const small = runSequence((t) => ({ flex: 6 * Math.sin(2 * Math.PI * t / 4) }));
  const big = runSequence((t) => ({ flex: 25 * Math.sin(2 * Math.PI * t / 4) }));
  assert.ok(small.flex > 0.05 && small.flex < 0.6, `small=${small.flex}`);
  assert.ok(big.flex > small.flex);
});

test('robustRange ignoriert einzelne Ausreißer', () => {
  const v = Array.from({ length: 50 }, () => 10);
  v[20] = 80;
  assert.equal(robustRange(v), 0);
});

test('Ganzkörperbewegung (Gehen) wird erkannt, Stillsitzen nicht', () => {
  const ma = new MotionAnalyzer();
  let body = 0;
  for (let i = 0; i < 60; i++) {
    const t = i / 30;
    const { image } = makePose({ offset: { x: 0.3 + t * 0.2, y: 0.6 } });
    const m = imageBodyMetrics(image);
    body = ma.pushBody(t, m.center, m.scale);
  }
  assert.ok(body > 0.5, `body=${body}`);

  const ma2 = new MotionAnalyzer();
  const rng = makeRng(5);
  for (let i = 0; i < 60; i++) {
    const t = i / 30;
    const { image } = makePose({ offset: { x: 0.5 + rng.gauss() * 0.002, y: 0.6 + rng.gauss() * 0.002 } });
    const m = imageBodyMetrics(image);
    body = ma2.pushBody(t, m.center, m.scale);
  }
  assert.ok(body < 0.05, `still body=${body}`);
});

test('One-Euro-Filter dämpft Rauschen und folgt einem Sprung', () => {
  const rng = makeRng(9);
  const f = new OneEuroFilter(1.0, 0.5);
  let errRaw = 0, errF = 0;
  for (let i = 0; i < 300; i++) {
    const n = rng.gauss() * 0.01;
    const y = f.filter(n, i / 30);
    errRaw += n * n; errF += y * y;
  }
  assert.ok(errF < errRaw * 0.3, 'Rauschen deutlich reduziert');
  for (let i = 300; i < 360; i++) f.filter(1, i / 30);
  near(f.filter(1, 12), 1, 0.02, 'Sprung nach 2 s erreicht');
});

// ---------------------------------------------------------------------------
test('Versorgungsmodell: Stillsitzen verschlechtert, Bewegung erholt', () => {
  const m = new SupplyModel();
  const s0 = m.state();
  for (let i = 0; i < 90; i++) m.step(1, { spine: 0, posture: 'sitzen', timeScale: 60 }); // 90 sim-min
  const still = m.state();
  assert.ok(still.fluid < s0.fluid - 0.15, 'Flüssigkeit sinkt');
  assert.ok(still.waste > s0.waste + 0.2, 'Abfallstoffe steigen');
  assert.ok(['gedrosselt', 'unterversorgt'].includes(still.level), still.level);

  for (let i = 0; i < 60; i++) m.step(1, { spine: 1, posture: 'sitzen', timeScale: 60 });
  const moved = m.state();
  assert.ok(moved.fluid > still.fluid + 0.3, 'Flüssigkeit erholt sich');
  assert.ok(moved.waste < still.waste - 0.3, 'Abfallstoffe werden abtransportiert');
  assert.equal(moved.level, 'gut');
});

test('Versorgungsmodell: Stehen belastet weniger als Sitzen', () => {
  const sit = new SupplyModel(), stand = new SupplyModel();
  for (let i = 0; i < 60; i++) {
    sit.step(1, { spine: 0, posture: 'sitzen' });
    stand.step(1, { spine: 0, posture: 'stehen' });
  }
  assert.ok(stand.fluid > sit.fluid);
});

test('Versorgungsmodell: Ganzkörperbewegung hilft, Zeitraffer wirkt, Werte bleiben in 0…1', () => {
  const a = new SupplyModel(), b = new SupplyModel();
  for (let i = 0; i < 30; i++) {
    a.step(1, { spine: 0, body: 0 });
    b.step(1, { spine: 0, body: 1 });
  }
  assert.ok(b.fluid > a.fluid);

  const slow = new SupplyModel(), fast = new SupplyModel();
  for (let i = 0; i < 20; i++) { slow.step(1, { timeScale: 1 }); fast.step(1, { timeScale: 600 }); }
  assert.ok(Math.abs(slow.fluid - 0.75) < 0.01, 'Echtzeit: kaum Änderung in 20 s');
  assert.ok(fast.fluid < 0.5, '1 s = 10 min: deutliche Änderung');

  const m = new SupplyModel();
  m.step(1e6, { timeScale: 600 });
  m.step(NaN); m.step(-1);
  for (const k of ['fluid', 'waste', 'exchange', 'supply']) {
    assert.ok(m[k] >= 0 && m[k] <= 1 && Number.isFinite(m[k]), k);
  }
  const h = m.hold(1);
  assert.ok(Number.isFinite(h.supply));
});

test('supplyLevel-Grenzen', () => {
  assert.equal(supplyLevel(0.9), 'gut');
  assert.equal(supplyLevel(0.6), 'mittel');
  assert.equal(supplyLevel(0.4), 'gedrosselt');
  assert.equal(supplyLevel(0.1), 'unterversorgt');
});
