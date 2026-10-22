/**
 * supply.js – stark vereinfachtes, qualitatives Versorgungsmodell einer
 * Bandscheibe. KEIN physiologisches Modell, keine echten Messwerte.
 *
 * Biomechanische Grundidee (siehe README):
 *  - Die erwachsene Bandscheibe hat im Inneren praktisch keine Blutgefäße.
 *    Nährstoffe (z. B. Glukose, Sauerstoff) gelangen per Diffusion aus den
 *    Kapillaren der Wirbelkörper über die knorpeligen Deckplatten in den
 *    Gallertkern; Stoffwechselprodukte (z. B. Laktat) nehmen den Rückweg.
 *  - Wechselnde Be- und Entlastung wirkt wie ein Schwamm: Unter Last wird
 *    Flüssigkeit herausgedrückt, bei Entlastung saugt der Kern wieder an.
 *    Dieser konvektive „Pumpeffekt“ unterstützt den Austausch.
 *  - Lange gleichbleibende Last (z. B. unbewegtes Sitzen) drückt über die
 *    Zeit Wasser heraus und der Austausch stagniert.
 *
 * Zustandsgrößen (alle dimensionslos 0 … 1):
 *    fluid     Flüssigkeit im Kern (1 = prall, 0 = ausgetrocknet)
 *    exchange  aktueller Austausch durch Bewegung (schnelle Größe)
 *    waste     angesammelte Abfallstoffe
 *    supply    abgeleiteter Versorgungsindex für Anzeige/Coach
 *
 * Gleichungen (t in simulierten Minuten):
 *    E  → E* = E_BASE + (1 − E_BASE) · pump            (Zeitkonstante in ECHTZEIT, s. u.)
 *    dF/dt = K_IN · E · (1 − F)  −  K_OUT · Last · F · (1 − 0,7 · E)
 *    dW/dt = W_PROD − K_CLEAR · E · W
 *    S     = 0,5 · F + 0,3 · (1 − W) + 0,2 · E
 *
 * Die Raten sind frei gewählt, damit der Effekt in der Animation gut
 * sichtbar ist: Unbewegtes Sitzen senkt F mit einer Zeitkonstanten von rund
 * einer (simulierten) Stunde Richtung ~0,35, aktive Bewegung bringt F in
 * rund 20–25 Minuten wieder Richtung ~0,9. Das sind Gestaltungsentscheidungen,
 * keine medizinischen Werte.
 */

export const RATES = Object.freeze({
  E_BASE: 0.15,       // Grund-Diffusion ohne Bewegung (der Austausch stoppt nie ganz)
  E_TAU_REAL: 1.2,    // s Echtzeit: wie schnell der Austausch auf Bewegung reagiert
  K_IN: 0.039,        // 1/min: Wasseraufnahme bei Entlastung/Bewegung
  K_OUT: 0.0121,      // 1/min: Wasserverlust unter Dauerlast
  W_PROD: 0.0106,     // 1/min: Entstehung von Stoffwechselprodukten
  K_CLEAR: 0.083,     // 1/min: Abtransport proportional zum Austausch
  LOAD_SIT: 1.0,      // relative Dauerlast im Sitzen (Annahme der Aufgabenstellung; Studienlage
  LOAD_STAND: 0.75,   // je nach Sitzhaltung uneinheitlich, siehe README) und im Stehen
  MAX_SUBSTEP: 0.5,   // min: numerische Schrittweite für große Zeitraffer
});

/** Zeitraffer-Stufen: simulierte Sekunden je Echtzeit-Sekunde. */
export const TIME_SCALES = Object.freeze([
  { value: 1, label: 'Echtzeit' },
  { value: 60, label: '1 s = 1 Min.' },
  { value: 180, label: '1 s = 3 Min.' },
  { value: 600, label: '1 s = 10 Min.' },
]);

/** Einordnung des Versorgungsindex in Worte. */
export function supplyLevel(s) {
  if (s >= 0.7) return 'gut';
  if (s >= 0.5) return 'mittel';
  if (s >= 0.35) return 'gedrosselt';
  return 'unterversorgt';
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class SupplyModel {
  constructor(initial = {}) {
    this.initial = { fluid: 0.75, waste: 0.3, exchange: 0.3, ...initial };
    this.reset();
  }

  reset() {
    this.fluid = this.initial.fluid;
    this.waste = this.initial.waste;
    this.exchange = this.initial.exchange;
    this.simSeconds = 0;
    this.supply = this.computeSupply();
  }

  computeSupply() {
    return clamp01(0.5 * this.fluid + 0.3 * (1 - this.waste) + 0.2 * this.exchange);
  }

  /**
   * Ein Zeitschritt.
   * @param {number} dtReal  vergangene Echtzeit in s
   * @param {object} inp
   * @param {number} inp.spine  Bewegungsmaß der Wirbelsäule 0 … 1
   * @param {number} [inp.body=0]  Ganzkörperbewegung 0 … 1
   * @param {'sitzen'|'stehen'} [inp.posture='sitzen']
   * @param {number} [inp.timeScale=60]  simulierte s je Echtzeit-s
   */
  step(dtReal, { spine = 0, body = 0, posture = 'sitzen', timeScale = 60 } = {}) {
    if (!(dtReal > 0)) return this.state();
    dtReal = Math.min(dtReal, 2); // Schutz gegen große Lücken (Tab im Hintergrund)
    const R = RATES;

    // Pumpeffekt: Wirbelsäulenbewegung zählt voll, Ganzkörperbewegung (Gehen,
    // Aufstehen) bewegt die Wirbelsäule mit und zählt etwas weniger.
    const pump = clamp01(Math.max(spine, 0.7 * body));
    const target = R.E_BASE + (1 - R.E_BASE) * pump;
    this.exchange += (1 - Math.exp(-dtReal / R.E_TAU_REAL)) * (target - this.exchange);

    const load = posture === 'stehen' ? R.LOAD_STAND : R.LOAD_SIT;
    let remaining = (dtReal * timeScale) / 60; // simulierte Minuten
    this.simSeconds += dtReal * timeScale;
    const E = this.exchange;
    while (remaining > 1e-9) {
      const h = Math.min(remaining, R.MAX_SUBSTEP);
      remaining -= h;
      const F = this.fluid, W = this.waste;
      const dF = R.K_IN * E * (1 - F) - R.K_OUT * load * F * (1 - 0.7 * E);
      const dW = R.W_PROD - R.K_CLEAR * E * W;
      this.fluid = clamp01(F + h * dF);
      this.waste = clamp01(W + h * dW);
    }
    this.supply = this.computeSupply();
    return this.state();
  }

  /** Keine verwertbaren Daten: Zustand halten, nur der Austausch klingt ab. */
  hold(dtReal) {
    if (dtReal > 0) {
      const k = 1 - Math.exp(-Math.min(dtReal, 2) / RATES.E_TAU_REAL);
      this.exchange += k * (RATES.E_BASE - this.exchange);
      this.supply = this.computeSupply();
    }
    return this.state();
  }

  state() {
    return {
      fluid: this.fluid,
      waste: this.waste,
      exchange: this.exchange,
      supply: this.supply,
      level: supplyLevel(this.supply),
      simSeconds: this.simSeconds,
    };
  }
}
