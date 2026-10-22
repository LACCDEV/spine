/**
 * pose.js – Webcam und MediaPipe Pose Landmarker.
 *
 * Alles läuft lokal im Browser. Bibliothek, WASM-Dateien und Modell liegen
 * im Repository (vendor/, models/); die Content-Security-Policy in
 * index.html verbietet zusätzlich jede Verbindung zu fremden Servern.
 * Die MediaPipe-Bibliothek wird erst beim Kamerastart nachgeladen, damit die
 * Seite und die Demo ohne die ~22 MB auskommen.
 */
import { LandmarkFilter, LM } from './spine.js';

const MP_BASE = new URL('../vendor/mediapipe/', import.meta.url);
const MODEL_URL = new URL('../models/pose_landmarker_lite.task', import.meta.url).href;

/** Fehler mit verständlicher deutscher Meldung für das UI. */
export class UserFacingError extends Error {
  constructor(message, { hint = '', code = 'unknown', cause } = {}) {
    super(message);
    this.hint = hint;
    this.code = code;
    this.cause = cause;
  }
}

/** Prüft die Voraussetzungen, bevor die Kamera angefragt wird. */
export function checkCameraSupport() {
  if (!window.isSecureContext) {
    return new UserFacingError('Die Kamera funktioniert nur über eine sichere Verbindung.', {
      code: 'insecure',
      hint: 'Öffne die Seite über https:// (z. B. GitHub Pages) oder lokal über http://localhost.',
    });
  }
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    return new UserFacingError('Dein Browser unterstützt keinen Kamerazugriff.', {
      code: 'unsupported',
      hint: 'Probier eine aktuelle Version von Chrome, Edge, Firefox oder Safari.',
    });
  }
  return null;
}

/** Übersetzt getUserMedia-Fehler in verständliche Meldungen. */
export function describeCameraError(err) {
  const name = err && err.name;
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return new UserFacingError('Du hast den Kamerazugriff nicht erlaubt.', {
        code: 'denied', cause: err,
        hint: 'Erlaube die Kamera über das Symbol links neben der Adresszeile und klick dann erneut auf „Kamera starten“. Das Bild bleibt auf deinem Gerät.',
      });
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new UserFacingError('Ich finde keine Kamera.', {
        code: 'notfound', cause: err,
        hint: 'Schließ eine Webcam an oder prüfe, ob sie im System aktiviert ist. Ohne Kamera kannst du die Demo ausprobieren.',
      });
    case 'NotReadableError':
    case 'TrackStartError':
      return new UserFacingError('Die Kamera ist gerade belegt.', {
        code: 'busy', cause: err,
        hint: 'Schließ andere Programme oder Tabs, die die Kamera nutzen (z. B. Videokonferenz), und versuch es noch einmal.',
      });
    case 'SecurityError':
      return new UserFacingError('Der Browser blockiert die Kamera auf dieser Seite.', {
        code: 'security', cause: err,
        hint: 'Prüfe die Website-Einstellungen deines Browsers oder öffne die Seite direkt (nicht eingebettet).',
      });
    case 'AbortError':
    default:
      return new UserFacingError('Die Kamera ließ sich nicht starten.', {
        code: 'other', cause: err,
        hint: 'Versuch es noch einmal. Hilft das nicht, lade die Seite neu.',
      });
  }
}

let landmarkerPromise = null;

/**
 * Lädt MediaPipe einmalig. Versucht zuerst die GPU (WebGL), dann die CPU.
 * @param {(msg:string)=>void} onStatus
 */
export function loadLandmarker(onStatus = () => {}) {
  if (landmarkerPromise) return landmarkerPromise;
  landmarkerPromise = (async () => {
    onStatus('Lade die Posenerkennung (einmalig ca. 17 MB) …');
    let vision;
    try {
      vision = await import(new URL('vision_bundle.mjs', MP_BASE).href);
    } catch (err) {
      throw new UserFacingError('Die Posenerkennung konnte nicht geladen werden.', {
        code: 'mp-load', cause: err, hint: 'Prüfe die Internetverbindung und lade die Seite neu.',
      });
    }
    const { FilesetResolver, PoseLandmarker } = vision;
    const fileset = await FilesetResolver.forVisionTasks(new URL('wasm', MP_BASE).href);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numPoses: 2,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    });
    let landmarker, delegate = 'GPU';
    try {
      landmarker = await PoseLandmarker.createFromOptions(fileset, options('GPU'));
    } catch (gpuErr) {
      console.info('GPU-Delegate nicht verfügbar, nutze CPU:', gpuErr?.message ?? gpuErr);
      delegate = 'CPU';
      try {
        landmarker = await PoseLandmarker.createFromOptions(fileset, options('CPU'));
      } catch (err) {
        throw new UserFacingError('Die Posenerkennung ließ sich nicht starten.', {
          code: 'mp-init', cause: err, hint: 'Dein Gerät unterstützt evtl. kein WebAssembly. Die Demo funktioniert trotzdem.',
        });
      }
    }
    onStatus('');
    return { landmarker, delegate };
  })();
  // Fehlgeschlagene Ladeversuche sollen beim nächsten Klick neu probiert werden.
  landmarkerPromise.catch(() => { landmarkerPromise = null; });
  return landmarkerPromise;
}

/** Mitte und Größe einer Pose im Bild (für Zuordnung und Auswahl der Hauptperson). */
function poseAnchor(lms) {
  const ls = lms[LM.L_SHOULDER], rs = lms[LM.R_SHOULDER], lh = lms[LM.L_HIP], rh = lms[LM.R_HIP];
  const cx = (ls.x + rs.x + lh.x + rh.x) / 4;
  const cy = (ls.y + rs.y + lh.y + rh.y) / 4;
  const size = Math.hypot((ls.x + rs.x - lh.x - rh.x) / 2, (ls.y + rs.y - lh.y - rh.y) / 2)
    + Math.hypot(ls.x - rs.x, ls.y - rs.y);
  const v = Math.min(ls.visibility ?? 1, rs.visibility ?? 1);
  return { cx, cy, size, v };
}

/**
 * Ordnet Posen über die Zeit zu und wählt die Hauptperson: zuerst die
 * bisherige (nächstgelegene) Hauptperson, sonst die größte/nächste Person.
 * Nur für die Hauptperson werden die Landmarken geglättet.
 */
export class PersonTracker {
  constructor() {
    this.worldFilter = new LandmarkFilter({ minCutoff: 1.2, beta: 8 });
    this.imageFilter = new LandmarkFilter({ minCutoff: 1.5, beta: 4 });
    this.reset();
  }
  reset() {
    this.primary = null; // {cx, cy}
    this.lostFor = 0;
    this.worldFilter.reset();
    this.imageFilter.reset();
  }
  /**
   * @param {{landmarks:Array, worldLandmarks:Array}} result  MediaPipe-Ergebnis
   * @param {number} t  Zeit in s
   * @returns {{persons:Array<{image:Array, world:Array|null}>, primaryIndex:number, primary:{image,world}|null}}
   */
  update(result, t) {
    const images = result?.landmarks ?? [];
    const worlds = result?.worldLandmarks ?? [];
    const persons = images.map((image, i) => {
      // Sichtbarkeit aus den Bildlandmarken übernehmen (verlässlich gesetzt)
      const w = worlds[i] ? worlds[i].map((p, k) => ({ x: p.x, y: p.y, z: p.z, visibility: image[k]?.visibility ?? p.visibility })) : null;
      return { image, world: w, anchor: poseAnchor(image) };
    });
    if (!persons.length) {
      this.lostFor++;
      if (this.lostFor > 15) this.reset();
      return { persons, primaryIndex: -1, primary: null };
    }
    let idx = -1;
    if (this.primary) {
      let best = Infinity;
      persons.forEach((p, i) => {
        const d = Math.hypot(p.anchor.cx - this.primary.cx, p.anchor.cy - this.primary.cy);
        if (d < best) { best = d; idx = i; }
      });
      if (best > 0.25) idx = -1; // zu weit weg → neue Auswahl
    }
    if (idx < 0) {
      let best = -Infinity;
      persons.forEach((p, i) => {
        const score = p.anchor.size * (0.5 + 0.5 * p.anchor.v);
        if (score > best) { best = score; idx = i; }
      });
      this.worldFilter.reset();
      this.imageFilter.reset();
    }
    this.lostFor = 0;
    const p = persons[idx];
    this.primary = { cx: p.anchor.cx, cy: p.anchor.cy };
    const primary = {
      image: this.imageFilter.apply(p.image, t),
      world: p.world ? this.worldFilter.apply(p.world, t) : null,
    };
    persons[idx] = { ...p, image: primary.image };
    return { persons, primaryIndex: idx, primary };
  }
}

/**
 * Kamera + Erkennung. Die Schleife selbst steuert main.js; hier gibt es nur
 * Start/Stopp und „Erkenne im aktuellen Bild“.
 */
export class PoseCamera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.landmarker = null;
    this.delegate = '';
    this.lastTs = 0;
    this.lastVideoTime = -1;
    this.stalledSince = null;
    this.onLost = () => {};
    this.detectMs = 0; // gleitender Mittelwert der Rechenzeit
  }

  get running() { return !!this.stream; }

  async start(onStatus) {
    const support = checkCameraSupport();
    if (support) throw support;
    // Kamera und Bibliothek parallel anfragen – das spart Wartezeit.
    const camPromise = navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30, max: 30 },
      },
    }).catch((err) => { throw describeCameraError(err); });
    const mpPromise = loadLandmarker(onStatus);
    let stream;
    try {
      stream = await camPromise;
    } catch (err) {
      mpPromise.catch(() => {}); // Ladefehler hier nicht doppelt melden
      throw err;
    }
    this.stream = stream;
    const track = stream.getVideoTracks()[0];
    if (track) {
      track.addEventListener('ended', () => this.handleLost('ended'));
      track.addEventListener('mute', () => { this.stalledSince ??= performance.now(); });
    }
    this.video.srcObject = stream;
    this.video.muted = true;
    this.video.playsInline = true;
    try { await this.video.play(); } catch { /* Autoplay-Sperre: Video läuft nach Nutzerklick ohnehin */ }
    try {
      const { landmarker, delegate } = await mpPromise;
      this.landmarker = landmarker;
      this.delegate = delegate;
    } catch (err) {
      this.stop();
      throw err instanceof UserFacingError ? err
        : new UserFacingError('Die Posenerkennung ließ sich nicht starten.', { cause: err, hint: 'Lade die Seite neu. Die Demo funktioniert auch ohne.' });
    }
    this.lastVideoTime = -1;
    this.stalledSince = null;
  }

  handleLost(reason) {
    if (!this.stream) return;
    this.stop();
    this.onLost(reason);
  }

  stop() {
    if (this.stream) for (const tr of this.stream.getTracks()) tr.stop();
    this.stream = null;
    if (this.video) this.video.srcObject = null;
  }

  /**
   * Führt die Erkennung auf dem aktuellen Videobild aus.
   * @returns {object|null}  MediaPipe-Ergebnis oder null, wenn kein neues Bild vorliegt
   */
  detect() {
    const v = this.video;
    if (!this.landmarker || !this.stream || v.readyState < 2 || !v.videoWidth) return null;
    if (v.currentTime === this.lastVideoTime) {
      // Steht das Bild länger als 4 s, gilt die Kamera als verloren.
      const now = performance.now();
      this.stalledSince ??= now;
      if (now - this.stalledSince > 4000 && !document.hidden) this.handleLost('stalled');
      return null;
    }
    this.stalledSince = null;
    this.lastVideoTime = v.currentTime;
    // Zeitstempel müssen streng steigen.
    let ts = performance.now();
    if (ts <= this.lastTs) ts = this.lastTs + 1;
    this.lastTs = ts;
    const t0 = performance.now();
    const res = this.landmarker.detectForVideo(v, ts);
    this.detectMs += 0.1 * (performance.now() - t0 - this.detectMs);
    return res;
  }
}
