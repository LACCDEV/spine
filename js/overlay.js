/**
 * overlay.js – zeichnet Skelette, Wirbelsäulenlinie und schematische
 * Lendenbandscheiben über das Kamerabild.
 *
 * Die Landmarken kommen ungespiegelt aus MediaPipe. Gespiegelt (Selfie-
 * Ansicht) wird nur hier beim Zeichnen: x → 1 − x. So bleibt die Analyse
 * eindeutig, und Beschriftungen stehen nicht spiegelverkehrt.
 */
import { LM } from './spine.js';

// Verbindungen für ein ruhiges, gut lesbares Skelett (ohne Gesichtsdetails)
const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32],
  [15, 19], [16, 20],
];
const JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

/** Lendenbandscheiben (schematisch): Anteil der Strecke Hüftmitte → Schultermitte. */
export const LUMBAR_DISCS = [
  { name: 'L5/S1', f: 0.07, load: 1.0 },
  { name: 'L4/L5', f: 0.14, load: 0.95 },
  { name: 'L3/L4', f: 0.21, load: 0.85 },
  { name: 'L2/L3', f: 0.28, load: 0.75 },
  { name: 'L1/L2', f: 0.35, load: 0.65 },
];

/** Farbe für einen Versorgungswert 0 … 1 (rostrot → ocker → türkis). */
export function supplyColor(s, alpha = 1) {
  const stops = [
    [0.0, [179, 71, 43]],
    [0.4, [205, 145, 52]],
    [0.65, [120, 178, 150]],
    [1.0, [38, 170, 176]],
  ];
  s = Math.max(0, Math.min(1, s));
  let i = 0;
  while (i < stops.length - 2 && s > stops[i + 1][0]) i++;
  const [a, ca] = stops[i], [b, cb] = stops[i + 1];
  const k = (s - a) / (b - a);
  const c = ca.map((v, j) => Math.round(v + (cb[j] - v) * k));
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

const visOk = (p, min = 0.45) => p && (p.visibility ?? 1) >= min;

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mirror = true;
  }

  resize(w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    this.dpr = dpr;
    this.w = w;
    this.h = h;
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  px(p) {
    const x = this.mirror ? 1 - p.x : p.x;
    return [x * this.canvas.width, p.y * this.canvas.height];
  }

  /**
   * @param {Array<{image:Array}>} persons
   * @param {number} primaryIndex
   * @param {{supply:number, flex:number, lat:number}} state  für die Bandscheibenfarben
   * @param {{label?:string, colors:{primary:string, other:string, spine:string}}} style
   */
  draw(persons, primaryIndex, state, style) {
    const ctx = this.ctx;
    this.clear();
    const lw = Math.max(2, this.canvas.width / 260);
    persons.forEach((person, i) => {
      if (i !== primaryIndex) this.drawSkeleton(person.image, style.colors.other, lw * 0.75, 0.75);
    });
    const p = persons[primaryIndex];
    if (!p) return;
    this.drawSkeleton(p.image, style.colors.primary, lw, 1);
    this.drawSpine(p.image, state, style, lw);
    if (style.label) {
      const [x, y] = this.px(p.image[LM.NOSE]);
      ctx.font = `600 ${Math.round(12 * this.dpr)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = style.colors.primary;
      ctx.fillText(style.label, x, Math.max(16 * this.dpr, y - 30 * this.dpr));
    }
  }

  drawSkeleton(lms, color, lw, alpha) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [a, b] of BONES) {
      if (!visOk(lms[a]) || !visOk(lms[b])) continue;
      const [x1, y1] = this.px(lms[a]);
      const [x2, y2] = this.px(lms[b]);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();
    ctx.fillStyle = color;
    for (const j of JOINTS) {
      if (!visOk(lms[j])) continue;
      const [x, y] = this.px(lms[j]);
      ctx.beginPath();
      ctx.arc(x, y, lw * 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawSpine(lms, state, style, lw) {
    const ls = lms[LM.L_SHOULDER], rs = lms[LM.R_SHOULDER], lh = lms[LM.L_HIP], rh = lms[LM.R_HIP];
    if (!visOk(ls, 0.5) || !visOk(rs, 0.5) || !visOk(lh, 0.2) || !visOk(rh, 0.2)) return;
    const ctx = this.ctx;
    const sh = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
    const hp = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
    const [sx, sy] = this.px(sh);
    const [hx, hy] = this.px(hp);
    const len = Math.hypot(sx - hx, sy - hy);
    if (len < 10) return;

    // Wirbelsäulenlinie (leicht geschwungen wäre anatomischer, gerade ist ehrlicher)
    ctx.save();
    ctx.strokeStyle = style.colors.spine;
    ctx.lineWidth = lw * 1.6;
    ctx.setLineDash([lw * 2.5, lw * 2]);
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(sx, sy);
    ctx.stroke();
    ctx.setLineDash([]);

    // Lendenbandscheiben als quer liegende Ovale
    const ux = (sx - hx) / len, uy = (sy - hy) / len;
    const ang = Math.atan2(uy, ux) + Math.PI / 2;
    const rx = Math.max(5, len * 0.07), ry = Math.max(2.5, len * 0.022);
    for (const d of LUMBAR_DISCS) {
      // Untere Scheiben tragen mehr Last → bei gleicher Versorgung etwas ungünstiger
      const s = Math.max(0, Math.min(1, state.supply - (d.load - 0.8) * 0.15));
      const x = hx + (sx - hx) * d.f, y = hy + (sy - hy) * d.f;
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, ang, 0, Math.PI * 2);
      ctx.fillStyle = supplyColor(s, 0.95);
      ctx.fill();
      ctx.lineWidth = Math.max(1, lw * 0.5);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.stroke();
      if (d.name === 'L4/L5') {
        ctx.font = `600 ${Math.round(11 * this.dpr)}px system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const tx = x + rx + 6 * this.dpr;
        ctx.lineWidth = 3 * this.dpr;
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.strokeText('L4/L5', tx, y);
        ctx.fillStyle = '#fff';
        ctx.fillText('L4/L5', tx, y);
      }
    }
    ctx.restore();
  }
}
