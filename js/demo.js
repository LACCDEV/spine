/**
 * demo.js – simulierte Person für Vorschau und Demo-Modi.
 *
 * Erzeugt künstliche MediaPipe-Landmarken (synth.js) inklusive leichtem
 * Rauschen. Die Demo läuft dadurch durch dieselbe Analysekette wie die
 * echte Kamera (Filter → Winkel → Bewegungsmaß → Modell).
 *
 * Modi:
 *   preview  ruhige Vorschau vor dem Start (sanftes Wiegen, Modell pausiert)
 *   still    „still sitzen“: kaum Bewegung, nur Haltungsrauschen; Beine
 *            unsichtbar (wie am Schreibtisch) → Sitzen wird angenommen
 *   move     „Wirbelsäule bewegen“: Katze-Kuh, Seitneigung, Drehung im
 *            Wechsel, ab und zu Aufstehen
 */
import { makePose, makeRng } from './synth.js';

const smoothstep = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };

/** Ablauf im Bewegungsmodus (Sekunden). */
const MOVE_PLAN = [
  { name: 'Katze-Kuh', dur: 12, f: (t) => ({ flex: 8 + 22 * Math.sin((2 * Math.PI * t) / 4.5) }) },
  { name: 'Seitneigung', dur: 12, f: (t) => { const s = Math.sin((2 * Math.PI * t) / 5); return { lat: 17 * s, armsRaised: smoothstep(t / 1.5) * smoothstep((12 - t) / 1.5) }; } },
  { name: 'Rumpfdrehung', dur: 12, f: (t) => ({ twist: 24 * Math.sin((2 * Math.PI * t) / 5) }) },
  { name: 'Aufstehen & Gehen', dur: 10, f: (t) => ({ stand: smoothstep((t - 1) / 1.5) * smoothstep((9.5 - t) / 1.5), walk: t }) },
];
const PLAN_LEN = MOVE_PLAN.reduce((s, p) => s + p.dur, 0);

export class DemoSource {
  constructor(mode = 'preview') {
    this.rng = makeRng(42);
    this.setMode(mode);
  }

  setMode(mode) {
    this.mode = mode;
    this.t0 = null;
  }

  /** Name der aktuellen Übung (für die Beschriftung im Kamerafeld). */
  get phaseName() { return this._phase || ''; }

  /**
   * @param {number} t  Zeit in s
   * @returns {{persons:Array<{image,world}>, label:string}}
   */
  frame(t) {
    if (this.t0 === null) this.t0 = t;
    const lt = t - this.t0;
    let p = { flex: 6, lat: 0, twist: 0, posture: 'sitzen', legsVisible: true, offset: { x: 0.5, y: 0.6 }, noise: 0.004 };

    if (this.mode === 'preview') {
      p.flex = 6 + 3 * Math.sin(lt * 0.5);
      p.lat = 2.5 * Math.sin(lt * 0.37);
      p.twist = 3 * Math.sin(lt * 0.29);
      this._phase = 'Vorschau';
    } else if (this.mode === 'still') {
      // Am Schreibtisch: leicht nach vorn gesunken, Beine verdeckt
      p.flex = 14 + 0.6 * Math.sin(lt * 0.11);
      p.lat = 2 + 0.4 * Math.sin(lt * 0.07);
      p.twist = 1;
      p.legsVisible = false;
      p.offset = { x: 0.5, y: 0.7 };
      this._phase = 'Still sitzen';
    } else {
      let tt = lt % PLAN_LEN, step = MOVE_PLAN[0];
      for (const s of MOVE_PLAN) { if (tt < s.dur) { step = s; break; } tt -= s.dur; }
      const r = step.f(tt);
      this._phase = step.name;
      // sanfte Übergänge zwischen den Übungen
      const fade = smoothstep(tt / 1.2) * smoothstep((step.dur - tt) / 1.2);
      p.flex = 6 + ((r.flex ?? 6) - 6) * fade;
      p.lat = (r.lat ?? 0) * fade;
      p.twist = (r.twist ?? 0) * fade;
      p.armsRaised = r.armsRaised ?? 0;
      if (r.stand !== undefined) {
        p.posture = r.stand > 0.5 ? 'stehen' : 'sitzen';
        // Beim Aufstehen und Gehen bewegt sich die Hüfte durchs Bild
        const walkX = r.stand > 0.5 ? 0.12 * Math.sin((r.walk - 2.5) * 0.9) : 0;
        p.offset = { x: 0.5 + walkX, y: 0.6 - 0.12 * r.stand };
        p.flex = 6 + 4 * Math.sin(r.walk * 3) * r.stand;
        p.lat = 3 * Math.sin(r.walk * 3.4) * r.stand;
      }
    }
    const pose = makePose({ ...p, rng: this.rng });
    return { persons: [pose], label: this._phase };
  }
}
