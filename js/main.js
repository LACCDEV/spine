/**
 * main.js – verbindet Kamera/Demo, Analyse, Modell, Coach und Darstellung.
 *
 * Datenfluss pro Bild:
 *   Quelle (Kamera → MediaPipe | Demo → synth.js)
 *     → PersonTracker (Hauptperson wählen, One-Euro-Filter)
 *     → computeTrunkAngles / PostureClassifier / MotionAnalyzer   (spine.js)
 *     → SupplyModel (Zeitraffer)                                   (supply.js)
 *     → Coach (Status, Übung)                                      (coach.js)
 *     → DiscScene (3D), Overlay (Skelett), DOM
 *
 * Robustheit: Jeder Schritt ist gekapselt; Fehler in einem Bild stoppen die
 * Schleife nicht. Im Hintergrund-Tab (kein requestAnimationFrame) läuft die
 * Analyse mit 1 Hz weiter, damit Erinnerungen funktionieren.
 */
import { computeTrunkAngles, PostureClassifier, MotionAnalyzer, imageBodyMetrics, DepthConventionCheck } from './spine.js';
import { SupplyModel, TIME_SCALES } from './supply.js';
import { Coach, formatClock, formatSimDuration } from './coach.js';
import { PoseCamera, PersonTracker, UserFacingError } from './pose.js';
import { Overlay } from './overlay.js';
import { HistoryChart } from './chart.js';
import { DemoSource } from './demo.js';

const $ = (id) => document.getElementById(id);
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* privat/gesperrt: egal */ } },
};

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------
const app = {
  mode: 'preview',              // 'preview' | 'camera' | 'still' | 'move'
  timeScale: store.get('bib.timeScale', 60),
  disc: null,
  discVisible: true,
  camera: new PoseCamera($('video')),
  tracker: new PersonTracker(),
  posture: new PostureClassifier(),
  motion: new MotionAnalyzer(),
  depthCheck: new DepthConventionCheck(),
  model: new SupplyModel(),
  coach: new Coach(),
  demo: new DemoSource('preview'),
  overlay: new Overlay($('overlay')),
  chart: new HistoryChart($('chart')),
  // letzte Analyse
  persons: [],
  primaryIndex: -1,
  angles: null,
  postureInfo: { posture: 'sitzen', assumed: true },
  reason: 'keine-person',
  lastGoodT: -Infinity,
  demoLabel: '',
  coachView: null,
  // Taktung
  lastT: null,
  lastUi: 0,
  lastChart: 0,
  frameNo: 0,
  errors: 0,
  bgTimer: null,
  lastNotify: 0,
  busy: false,
};
if (!TIME_SCALES.some((s) => s.value === app.timeScale)) app.timeScale = 60;

const DATA_GRACE = 1.5; // s: kurze Aussetzer der Erkennung überbrücken
const BASE_TITLE = document.title;

// ---------------------------------------------------------------------------
// 3D-Szene (dynamisch geladen, damit ein WebGL-Problem nicht die Seite stoppt)
// ---------------------------------------------------------------------------
async function initDisc() {
  const host = $('disc-host');
  try {
    const { DiscScene } = await import('./disc3d.js');
    if (!DiscScene.isSupported()) throw new Error('WebGL nicht verfügbar');
    app.disc = new DiscScene(host, { reducedMotion: reducedMotionQuery.matches });
    app.disc.canvas.setAttribute('aria-label', '3D-Ansicht. Mit den Pfeiltasten drehen, Pos1 setzt zurück.');
    $('view-left').addEventListener('click', () => app.disc.rotateView(0.35, 0));
    $('view-right').addEventListener('click', () => app.disc.rotateView(-0.35, 0));
    $('view-reset').addEventListener('click', () => app.disc.resetView());
    new IntersectionObserver((entries) => {
      app.discVisible = entries.some((e) => e.isIntersecting);
    }).observe(host);
  } catch (err) {
    console.warn('3D-Ansicht nicht verfügbar:', err);
    $('disc-fallback').hidden = false;
    document.querySelector('.disc-view').hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Modus wechseln
// ---------------------------------------------------------------------------
const MODE_TEXT = { preview: 'Vorschau', camera: 'Kamera aktiv', still: 'Demo: still sitzen', move: 'Demo: Wirbelsäule bewegen' };

function resetAnalysis({ resetModel }) {
  app.tracker.reset();
  app.posture.reset();
  app.motion.reset();
  app.coach.reset();
  app.persons = [];
  app.primaryIndex = -1;
  app.angles = null;
  app.lastGoodT = -Infinity;
  app.reason = 'keine-person';
  if (resetModel) { app.model.reset(); app.chart.clear(); }
}

function setMode(mode) {
  if (app.mode === 'camera' && mode !== 'camera') app.camera.stop();
  app.mode = mode;
  resetAnalysis({ resetModel: true });
  if (mode === 'still' || mode === 'move' || mode === 'preview') app.demo.setMode(mode);

  $('btn-demo-still').setAttribute('aria-pressed', String(mode === 'still'));
  $('btn-demo-move').setAttribute('aria-pressed', String(mode === 'move'));
  // Fokus nicht verlieren, wenn der fokussierte Button verschwindet oder gesperrt wird
  const focused = document.activeElement;
  $('btn-stop').hidden = mode === 'preview';
  $('btn-camera').querySelector('span').textContent = mode === 'camera' ? 'Kamera läuft' : 'Kamera starten';
  $('btn-camera').disabled = mode === 'camera';
  $('mode-chip').textContent = MODE_TEXT[mode];
  const frame = $('cam-frame');
  frame.classList.toggle('live', mode !== 'preview');
  const badge = $('cam-badge');
  badge.hidden = !(mode === 'still' || mode === 'move');
  badge.textContent = 'Demo – simulierte Person';
  if (mode !== 'camera') frame.style.aspectRatio = '';
  if ((focused === $('btn-stop') && mode === 'preview') || (focused === $('btn-camera') && mode === 'camera')) {
    (mode === 'camera' ? $('btn-stop') : $('btn-camera')).focus();
  }
  app.overlay.clear();
  setCamStatus(mode === 'preview' ? '' : mode === 'camera' ? 'Suche nach Personen …' : '');
  app.disc?.setState({ active: mode !== 'preview' });
  updateUi(true);
}

async function startCamera() {
  if (app.busy || app.mode === 'camera') return;
  app.busy = true;
  hideAlert();
  const btn = $('btn-camera');
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Starte …';
  setCamStatus('Frage die Kamera an …');
  try {
    await app.camera.start((msg) => setCamStatus(msg));
    setMode('camera');
    const v = $('video');
    if (v.videoWidth) $('cam-frame').style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`;
    if (app.camera.delegate === 'CPU') setCamStatus('Erkennung läuft auf dem Prozessor (langsamer, aber funktioniert).');
  } catch (err) {
    console.warn(err);
    const e = err instanceof UserFacingError ? err : new UserFacingError('Die Kamera ließ sich nicht starten.', { hint: 'Lade die Seite neu und versuch es noch einmal.' });
    showAlert(e.message, e.hint, { retry: e.code !== 'insecure' && e.code !== 'unsupported' });
    setCamStatus('');
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Kamera starten';
  } finally {
    app.busy = false;
  }
}

app.camera.onLost = (reason) => {
  const msg = reason === 'stalled' ? 'Das Kamerabild ist eingefroren.' : 'Die Verbindung zur Kamera ist abgebrochen.';
  showAlert(msg, 'Prüfe, ob die Kamera noch angeschlossen ist oder von einem anderen Programm benutzt wird. Dann „Erneut versuchen“.', { retry: true });
  setMode('preview');
};

$('video').addEventListener('loadedmetadata', (e) => {
  const v = e.target;
  if (app.mode === 'camera' && v.videoWidth) $('cam-frame').style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`;
});

// ---------------------------------------------------------------------------
// Meldungen
// ---------------------------------------------------------------------------
function showAlert(title, hint, { retry = false } = {}) {
  $('alert-title').textContent = title;
  $('alert-hint').textContent = hint || '';
  $('alert-retry').hidden = !retry;
  $('alert').hidden = false;
}
function hideAlert() { $('alert').hidden = true; }
function setCamStatus(text, warn = false) {
  const el = $('cam-status');
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle('warn', warn);
}

// ---------------------------------------------------------------------------
// Analyse eines Bildes
// ---------------------------------------------------------------------------
function analyze(result, t) {
  const tr = app.tracker.update(result, t);
  app.persons = tr.persons;
  app.primaryIndex = tr.primaryIndex;
  if (!tr.primary || !tr.primary.world) {
    app.reason = 'keine-person';
    return;
  }
  const { world, image } = tr.primary;
  const angles = computeTrunkAngles(world, { zSign: app.depthCheck.zSign });
  if (app.mode === 'camera') {
    const before = app.depthCheck.zSign;
    if (app.depthCheck.update(angles.faceDot) !== before) {
      console.info('Tiefenachse der Weltkoordinaten umgedreht (anatomische Prüfung: Nase vor Ohren).');
      app.tracker.worldFilter.reset();
      app.motion.reset();
    }
  }
  app.postureInfo = app.posture.update(world, t);
  const bm = imageBodyMetrics(image);
  if (bm) app.motion.pushBody(t, bm.center, bm.scale, app.postureInfo.changed);
  if (angles.ok) {
    app.angles = angles;
    app.motion.push(t, angles);
    app.lastGoodT = t;
    app.reason = angles.hipWeak ? 'huefte-schwach' : null;
  } else {
    app.reason = angles.reason;
  }
}

const REASON_TEXT = {
  'keine-person': 'Keine Person erkannt. Setz dich so vor die Kamera, dass Kopf, Schultern und Hüfte im Bild sind.',
  schultern: 'Deine Schultern sind nicht gut zu sehen. Rück etwas weiter weg oder sorg für mehr Licht.',
  huefte: 'Deine Hüfte ist nicht zu sehen. Rück etwas zurück oder stell die Kamera etwas tiefer.',
  'huefte-schwach': 'Deine Hüfte ist nur ungenau zu sehen (z. B. hinter dem Tisch). Die Werte sind dann unsicherer.',
  unklar: 'Deine Haltung ist gerade nicht eindeutig zu erkennen.',
};

// ---------------------------------------------------------------------------
// Ein Takt (Vordergrund: jedes Bild; Hintergrund: 1 Hz)
// ---------------------------------------------------------------------------
function tick(t, render) {
  const dt = app.lastT === null ? 0 : Math.min(t - app.lastT, 2);
  app.lastT = t;
  app.frameNo++;

  // 1) Quelle
  try {
    if (app.mode === 'camera') {
      // Bei langsamer Erkennung nur jedes zweite Bild auswerten
      const skip = app.camera.detectMs > 45 && app.frameNo % 2 === 1 && render;
      const res = skip ? null : app.camera.detect();
      if (res) analyze(res, t);
    } else {
      const f = app.demo.frame(t);
      app.demoLabel = f.label;
      analyze({ landmarks: f.persons.map((p) => p.image), worldLandmarks: f.persons.map((p) => p.world) }, t);
    }
  } catch (err) {
    app.errors++;
    if (app.errors < 5) console.error('Analysefehler:', err);
    if (app.errors === 60) showAlert('Bei der Auswertung gibt es wiederholt Fehler.', 'Lade die Seite neu. Die Demo funktioniert unabhängig davon.', { retry: false });
  }

  // 2) Modell und Coach
  const hasData = t - app.lastGoodT < DATA_GRACE;
  const m = app.motion.result;
  if (app.mode === 'preview') {
    app.coachView = null;
  } else if (hasData) {
    app.model.step(dt, { spine: m.spine, body: m.body, posture: app.postureInfo.posture, timeScale: app.timeScale });
    app.coachView = app.coach.update(dt, { hasData: true, motion: m, model: app.model.state(), timeScale: app.timeScale, posture: app.postureInfo.posture });
  } else {
    app.motion.decay(t, dt);
    app.model.hold(dt);
    app.coachView = app.coach.update(dt, { hasData: false, motion: m, model: app.model.state(), timeScale: app.timeScale, posture: app.postureInfo.posture });
  }

  // 3) Erinnerungen (auch im Hintergrund)
  handleReminder(t);

  // 4) Darstellung
  if (!render) return;
  const st = app.model.state();
  if (app.disc && app.discVisible) {
    const a = app.angles;
    app.disc.setState({
      flex: a ? a.flex : 0, lat: a ? a.lat : 0, twist: a ? a.twist : 0,
      fluid: st.fluid, waste: st.waste, exchange: app.mode === 'preview' ? 0.35 : st.exchange,
    });
    try { app.disc.update(dt); } catch (err) { app.errors++; if (app.errors < 5) console.error('3D-Fehler:', err); }
  }
  drawOverlay(st);
  if (t - app.lastChart >= 1 && app.mode !== 'preview') {
    app.lastChart = t;
    app.chart.push(st.fluid, Math.max(m.spine, 0.7 * m.body));
    app.chart.draw();
  }
  if (t - app.lastUi >= 0.2) { app.lastUi = t; updateUi(false); }
}

function drawOverlay(st) {
  const frame = $('cam-frame');
  app.overlay.resize(frame.clientWidth, frame.clientHeight);
  if (app.mode === 'preview') { app.overlay.clear(); return; }
  app.overlay.draw(app.persons, app.primaryIndex, { supply: st.supply }, {
    label: app.mode === 'camera' ? (app.persons.length > 1 ? 'steuert die Bandscheibe' : '') : app.demoLabel,
    colors: { primary: '#5fe3d3', other: 'rgba(235,235,230,0.85)', spine: 'rgba(255,255,255,0.95)' },
  });
}

// ---------------------------------------------------------------------------
// DOM-Aktualisierung (5×/s)
// ---------------------------------------------------------------------------
let lastStatusKey = '';
let lastExerciseId = '';

function wordFor(value, words) {
  for (const [limit, w] of words) if (value < limit) return w;
  return words[words.length - 1][1];
}

function setGauge(id, value, word) {
  const el = $(id);
  el.querySelector('.gauge__fill').style.width = `${Math.round(value * 100)}%`;
  const w = el.querySelector('.gauge__word');
  if (w.textContent !== word) w.textContent = word;
}

function setBar(id, value) {
  const el = $(id);
  const pct = Math.round(value * 100);
  el.querySelector('.bar__fill').style.width = `${pct}%`;
  el.setAttribute('aria-valuenow', String(pct));
  el.setAttribute('aria-valuetext', value >= 0.95 ? 'voll bewegt' : value >= 0.5 ? 'gut bewegt' : value > 0.05 ? 'wenig bewegt' : 'nicht bewegt');
  el.classList.toggle('done', value >= 0.95);
}

function updateUi(force) {
  const view = app.coachView ?? { key: 'idle', tone: 'neutral', title: 'Bereit', text: 'Starte die Kamera oder eine Demo, dann siehst du, wie Bewegung deine Bandscheibe versorgt.', stillReal: 0, stillSim: 0, exercise: null };
  const st = app.model.state();
  const m = app.motion.result;

  // Status (aria-live) nur bei Wechsel ändern, damit Screenreader nicht dauernd vorlesen
  if (view.key !== lastStatusKey || force) {
    lastStatusKey = view.key;
    $('status').dataset.tone = view.tone;
    $('status-title').textContent = view.title;
    $('status-text').textContent = view.text;
    const fluidWord = wordFor(st.fluid, [[0.45, 'niedrig'], [0.6, 'nimmt ab'], [0.8, 'gut'], [2, 'prall']]);
    $('disc-host').setAttribute('aria-label',
      `3D-Modell einer Lendenbandscheibe zwischen den Wirbelkörpern L4 und L5. ${MODE_TEXT[app.mode]}. Status: ${view.title}. Wasser im Kern: ${fluidWord}.`);
  }

  // Stillzeit
  const active = app.mode !== 'preview';
  $('still-clock').textContent = active ? formatClock(view.stillReal) : '0:00';
  $('still-sim').textContent = !active ? 'im Modell: –'
    : app.timeScale === 1 ? 'Echtzeit' : `im Modell: ${formatSimDuration(view.stillSim)}`;
  $('sim-time').textContent = active ? `simuliert: ${formatSimDuration(st.simSeconds)}` : 'Zeitraffer';

  // Fortschritt je Richtung
  setBar('bar-flex', m.progress.flex);
  setBar('bar-lat', m.progress.lat);
  setBar('bar-twist', m.progress.twist);

  // Modellgrößen in Worten (qualitativ, ohne Zahlen)
  setGauge('g-pump', st.exchange, wordFor(st.exchange, [[0.25, 'kaum'], [0.5, 'schwach'], [0.75, 'mittel'], [2, 'kräftig']]));
  setGauge('g-fluid', st.fluid, wordFor(st.fluid, [[0.45, 'niedrig'], [0.6, 'nimmt ab'], [0.8, 'gut'], [2, 'prall']]));
  setGauge('g-waste', st.waste, wordFor(st.waste, [[0.25, 'wenig'], [0.5, 'einige'], [0.75, 'viele'], [2, 'sehr viele']]));

  // Übung
  const ex = view.exercise;
  if (ex && ex.id !== lastExerciseId) {
    lastExerciseId = ex.id;
    $('ex-title').textContent = ex.title;
    const ol = $('ex-steps');
    ol.replaceChildren(...ex.steps.map((s) => { const li = document.createElement('li'); li.textContent = s; return li; }));
  }

  // Fakten unter dem Kamerabild
  const pc = app.persons.length;
  $('fact-persons').textContent = active ? (pc === 0 ? 'keine' : pc === 1 ? '1' : `${pc} (erste steuert)`) : '–';
  const pi = app.postureInfo;
  $('fact-posture').textContent = !active ? '–' : pi.assumed
    ? 'Sitzen (angenommen)' : pi.posture === 'stehen' ? 'Stehen' : 'Sitzen';
  $('posture-note').hidden = !(active && pi.assumed && app.persons.length > 0);
  const a = app.angles;
  let viewTxt = '–';
  if (active && a) {
    const y = Math.abs(a.viewYaw);
    viewTxt = y < 25 ? 'frontal' : y < 65 ? 'schräg' : y < 115 ? 'seitlich' : 'von hinten';
  }
  $('fact-view').textContent = viewTxt;
  const fmt = (v, pos, neg) => (Math.abs(v) < 2 ? '≈ 0°' : `${v > 0 ? '+' : '−'}${Math.round(Math.abs(v))}° ${v > 0 ? pos : neg}`);
  $('ang-flex').textContent = active && a ? fmt(a.flex, 'vor', 'zurück') : '–';
  $('ang-lat').textContent = active && a ? fmt(a.lat, 'rechts', 'links') : '–';
  $('ang-twist').textContent = active && a ? fmt(a.twist, 'rechts', 'links') : '–';

  if (app.mode === 'camera') {
    const fresh = app.lastT !== null && app.lastT - app.lastGoodT < DATA_GRACE;
    if (app.reason && REASON_TEXT[app.reason] && (!fresh || app.reason === 'huefte-schwach')) {
      setCamStatus(REASON_TEXT[app.reason] + (fresh ? '' : ' Die Simulation pausiert so lange.'), true);
    } else if (fresh) {
      setCamStatus(app.camera.delegate === 'CPU' ? 'Erkennung läuft (Prozessor).' : 'Erkennung läuft.');
    }
  }
}

// ---------------------------------------------------------------------------
// Erinnerung: Tab-Titel und (optional) Browser-Benachrichtigung
// ---------------------------------------------------------------------------
function handleReminder(t) {
  const enabled = $('chk-notify').checked;
  const key = app.coachView?.key;
  const due = enabled && app.mode !== 'preview' && (key === 'sinks' || key === 'under');
  const title = due && document.hidden ? '⏰ Zeit für Bewegung · Bandscheiben in Bewegung' : BASE_TITLE;
  if (document.title !== title) document.title = title;
  if (due && key === 'under' && document.hidden && 'Notification' in window
      && Notification.permission === 'granted' && t - app.lastNotify > 600) {
    app.lastNotify = t;
    try {
      new Notification('Zeit für Bewegung', {
        body: 'Du sitzt schon eine Weile still. Steh kurz auf oder beweg deine Wirbelsäule – deine Bandscheiben danken es dir.',
        tag: 'bib-reminder', icon: 'favicon.svg',
      });
    } catch { /* manche Browser erlauben das nur über Service Worker */ }
  }
}

async function onNotifyToggle(e) {
  store.set('bib.notify', e.target.checked);
  const note = $('notify-note');
  if (!e.target.checked) return;
  if (!('Notification' in window)) {
    note.textContent = 'Dein Browser unterstützt hier keine Benachrichtigungen. Der Hinweis im Tab-Titel funktioniert trotzdem.';
    return;
  }
  if (Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch { /* ältere Safari-Versionen */ }
  }
  note.textContent = Notification.permission === 'granted'
    ? 'Aktiv: Hinweis im Tab-Titel und als Benachrichtigung, wenn der Tab im Hintergrund ist.'
    : 'Aktiv: Hinweis im Tab-Titel. Benachrichtigungen hast du nicht erlaubt – das ist völlig in Ordnung.';
}

// ---------------------------------------------------------------------------
// Schleifen
// ---------------------------------------------------------------------------
let lastRafT = 0;
function loop(now) {
  requestAnimationFrame(loop);
  if (document.hidden) return;
  lastRafT = now / 1000;
  tick(now / 1000, true);
}

// Wächter: Im Hintergrund-Tab (oder wenn der Browser keine Animationsbilder
// liefert, z. B. verdecktes Fenster) pausiert requestAnimationFrame. Dann
// läuft die Analyse mit 1 Hz weiter – genug für Modell und Erinnerung.
function watchdog() {
  const now = performance.now() / 1000;
  if (now - lastRafT > 1.2) tick(now, false);
}

function onVisibility() {
  if (!document.hidden) document.title = BASE_TITLE;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
function initControls() {
  const sel = $('sel-timescale');
  for (const s of TIME_SCALES) {
    const o = document.createElement('option');
    o.value = String(s.value);
    o.textContent = s.label;
    sel.appendChild(o);
  }
  sel.value = String(app.timeScale);
  sel.addEventListener('change', () => {
    app.timeScale = Number(sel.value) || 60;
    store.set('bib.timeScale', app.timeScale);
  });

  $('btn-camera').addEventListener('click', startCamera);
  $('btn-demo-still').addEventListener('click', () => { hideAlert(); setMode(app.mode === 'still' ? 'preview' : 'still'); });
  $('btn-demo-move').addEventListener('click', () => { hideAlert(); setMode(app.mode === 'move' ? 'preview' : 'move'); });
  $('btn-stop').addEventListener('click', () => setMode('preview'));
  $('btn-reset').addEventListener('click', () => { app.model.reset(); app.coach.reset(); app.chart.clear(); app.chart.draw(); updateUi(true); });
  $('alert-close').addEventListener('click', hideAlert);
  $('alert-retry').addEventListener('click', startCamera);
  $('alert-demo').addEventListener('click', () => { hideAlert(); setMode('move'); });

  const chk = $('chk-notify');
  chk.checked = !!store.get('bib.notify', false);
  chk.addEventListener('change', onNotifyToggle);

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', () => app.camera.stop());
  reducedMotionQuery.addEventListener?.('change', (e) => { if (app.disc) app.disc.reducedMotion = e.matches; });
}

initControls();
setMode('preview');
app.chart.draw();
await initDisc();
requestAnimationFrame(loop);
app.bgTimer = setInterval(watchdog, 1000);
window.__bib = app; // für Tests und Neugierige (keine Funktion im normalen Betrieb)
