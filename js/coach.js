/**
 * coach.js – übersetzt Bewegungsmaß und Modellzustand in verständliche
 * Hinweise und schlägt passende Übungen vor. Reine Logik, kein DOM.
 */

/** Übungen je Bewegungsrichtung. Texte bewusst kurz und in einfacher Sprache. */
export const EXERCISES = Object.freeze({
  flex: {
    id: 'flex',
    title: 'Katze-Kuh im Sitzen',
    steps: [
      'Setz dich nach vorne auf die Stuhlkante, Hände auf die Knie.',
      'Ausatmen: Rücken rund machen, Kinn zur Brust.',
      'Einatmen: Brust nach vorne, leichtes Hohlkreuz.',
      'Langsam 5- bis 8-mal im Wechsel.',
    ],
  },
  lat: {
    id: 'lat',
    title: 'Seitneigung',
    steps: [
      'Sitz aufrecht, beide Füße am Boden.',
      'Rechten Arm über den Kopf, Oberkörper sanft nach links neigen.',
      'Kurz halten, zurück zur Mitte, dann die andere Seite.',
      'Je Seite 4- bis 5-mal.',
    ],
  },
  twist: {
    id: 'twist',
    title: 'Rumpfdrehung',
    steps: [
      'Sitz aufrecht, Hände locker vor der Brust verschränkt.',
      'Oberkörper langsam nach rechts drehen – das Becken bleibt ruhig.',
      'Zurück zur Mitte, dann nach links.',
      'Je Seite 4- bis 5-mal, ohne Schwung.',
    ],
  },
  walk: {
    id: 'walk',
    title: 'Aufstehen und ein paar Schritte',
    steps: [
      'Steh auf und geh ein paar Schritte – zum Fenster, zum Wasser, irgendwohin.',
      'Schultern locker kreisen lassen.',
      'Danach gern eine Runde Katze-Kuh im Stehen (Hände auf die Oberschenkel).',
    ],
  },
});

export const AXIS_LABEL = Object.freeze({ flex: 'Beugen & Strecken', lat: 'Seitneigung', twist: 'Drehung' });

/**
 * Stufen des Status, von gut nach kritisch. „tone“ steuert die Farbe im UI.
 * Die Texte sind qualitativ – keine Zahlen, keine Diagnosen.
 */
export const STATUS = Object.freeze({
  idle:   { tone: 'neutral', title: 'Bereit', text: 'Starte die Kamera oder eine Demo, dann siehst du, wie Bewegung deine Bandscheibe versorgt.' },
  nodata: { tone: 'neutral', title: 'Ich sehe dich gerade nicht', text: 'Setz dich so hin, dass Schultern und Hüfte im Bild sind. Die Simulation pausiert so lange.' },
  pump:   { tone: 'good', title: 'Pumpeffekt aktiv', text: 'Be- und Entlastung wechseln sich ab. Wasser und Nährstoffe strömen in den Kern, Abfallstoffe hinaus.' },
  light:  { tone: 'good', title: 'Leichte Bewegung', text: 'Gut so! Mach die Bewegung etwas größer, dann pumpt die Bandscheibe stärker.' },
  rest:   { tone: 'calm', title: 'Kurze Ruhephase', text: 'Kurze Pausen sind völlig in Ordnung. Bleib nur nicht zu lange in derselben Haltung.' },
  slow:   { tone: 'warn', title: 'Austausch gedrosselt', text: 'Ohne Bewegung fließt kaum etwas nach. Zeit für eine kleine Bewegungspause.' },
  sinks:  { tone: 'warn', title: 'Versorgung sinkt', text: 'Die Bandscheibe verliert langsam Wasser, Abfallstoffe sammeln sich. Beweg deine Wirbelsäule ein bisschen.' },
  under:  { tone: 'alert', title: 'Bandscheibe wird unterversorgt', text: 'Jetzt ist ein guter Moment: steh kurz auf oder probier die Übung unten.' },
});

const ORDER = ['pump', 'light', 'rest', 'slow', 'sinks', 'under'];

/** Schwellen für die Wirbelsäulenbewegung (0 … 1). */
export const MOVE_ON = 0.3;   // ab hier gilt „bewegt“ und die Stillzeit wird zurückgesetzt
export const PUMP_ON = 0.45;  // „Pumpeffekt aktiv“
export const LIGHT_ON = 0.12; // „Leichte Bewegung“

export class Coach {
  constructor() { this.reset(); }

  reset() {
    this.stillReal = 0;        // s Echtzeit ohne Wirbelsäulenbewegung
    this.stillSim = 0;         // s simulierte Zeit ohne Wirbelsäulenbewegung
    this.statusKey = 'idle';
    this.exercise = EXERCISES.flex;
    this.exerciseSince = 0;
    this.t = 0;
  }

  /**
   * @param {number} dt  Echtzeit-Schritt in s
   * @param {object} p
   * @param {boolean} p.hasData
   * @param {{spine:number, body:number, progress:{flex:number,lat:number,twist:number}}} p.motion
   * @param {{supply:number}} p.model
   * @param {number} p.timeScale
   * @param {string} p.posture
   */
  update(dt, { hasData, motion, model, timeScale, posture }) {
    this.t += dt;
    if (!hasData) {
      this.statusKey = 'nodata';
      return this.view();
    }
    const pump = Math.max(motion.spine, 0.7 * motion.body);
    if (pump >= MOVE_ON) {
      this.stillReal = 0;
      this.stillSim = 0;
    } else {
      this.stillReal += dt;
      this.stillSim += dt * timeScale;
    }

    // Stufe nach der (simulierten) Dauer ohne Bewegung …
    const simMin = this.stillSim / 60;
    let key;
    if (pump >= PUMP_ON) key = 'pump';
    else if (pump >= LIGHT_ON) key = 'light';
    else if (simMin < 5) key = 'rest';
    else if (simMin < 20) key = 'slow';
    else if (simMin < 45) key = 'sinks';
    else key = 'under';

    // … und nach dem Modellzustand – es gilt die ernstere Stufe (nur ohne aktive Bewegung)
    if (pump < LIGHT_ON) {
      const byModel = model.supply < 0.35 ? 'under' : model.supply < 0.5 ? 'sinks' : null;
      if (byModel && ORDER.indexOf(byModel) > ORDER.indexOf(key)) key = byModel;
    }
    this.statusKey = key;

    // Übung: die am wenigsten bewegte Richtung. Nach langem Sitzen zuerst aufstehen.
    // Wechsel frühestens nach 8 s, damit der Vorschlag nicht flackert.
    let next;
    if (posture === 'sitzen' && simMin >= 45) next = EXERCISES.walk;
    else {
      const pr = motion.progress;
      const axis = ['flex', 'lat', 'twist'].reduce((a, b) => (pr[b] < pr[a] - 0.05 ? b : a), 'flex');
      next = EXERCISES[axis];
    }
    if (next !== this.exercise && this.t - this.exerciseSince > 8) {
      this.exercise = next;
      this.exerciseSince = this.t;
    }
    return this.view();
  }

  view() {
    return {
      key: this.statusKey,
      ...STATUS[this.statusKey],
      stillReal: this.stillReal,
      stillSim: this.stillSim,
      exercise: this.exercise,
    };
  }
}

/** Formatiert Sekunden als „m:ss“ bzw. „h:mm:ss“. */
export function formatClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Formatiert simulierte Zeit grob in Worten („etwa 1 Std. 20 Min.“). */
export function formatSimDuration(sec) {
  const min = Math.round(sec / 60);
  if (min < 1) return 'unter 1 Min.';
  if (min < 60) return `${min} Min.`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} Std. ${m} Min.` : `${h} Std.`;
}
