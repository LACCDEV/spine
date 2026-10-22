/**
 * chart.js – kleines Verlaufsdiagramm (Canvas 2D) für Flüssigkeit im Kern
 * und Bewegung der Wirbelsäule. Ohne Bibliothek, passt sich Hell/Dunkel an.
 */
export class HistoryChart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{capacity?:number}} opts  Anzahl gespeicherter Punkte
   */
  constructor(canvas, { capacity = 120 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.capacity = capacity;
    this.data = [];
  }

  push(fluid, motion) {
    this.data.push({ fluid, motion });
    if (this.data.length > this.capacity) this.data.shift();
  }

  clear() { this.data = []; }

  draw() {
    const c = this.canvas, ctx = this.ctx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const css = getComputedStyle(c);
    const col = (name, fb) => css.getPropertyValue(name).trim() || fb;
    const grid = col('--chart-grid', '#d9cfbd');
    const fluidC = col('--chart-fluid', '#1f8f8a');
    const motionC = col('--chart-motion', '#9bb7c9');
    const textC = col('--ink-soft', '#55605f');

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const padL = 34, padR = 6, padT = 6, padB = 16;
    const pw = w - padL - padR, ph = h - padT - padB;

    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = textC;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    [[0, 'wenig'], [1, 'viel']].forEach(([v, label]) => {
      const y = padT + ph * (1 - v);
      ctx.beginPath(); ctx.moveTo(padL, y + 0.5); ctx.lineTo(w - padR, y + 0.5); ctx.stroke();
      ctx.fillText(label, padL - 4, y);
    });
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('früher', padL, h - 3);
    ctx.textAlign = 'right';
    ctx.fillText('jetzt', w - padR, h - 3);

    const n = this.data.length;
    if (n < 2) return;
    const x = (i) => padL + (pw * (i + this.capacity - n)) / (this.capacity - 1);
    const y = (v) => padT + ph * (1 - Math.max(0, Math.min(1, v)));

    // Bewegung als Fläche
    ctx.beginPath();
    ctx.moveTo(x(0), y(0));
    this.data.forEach((d, i) => ctx.lineTo(x(i), y(d.motion)));
    ctx.lineTo(x(n - 1), y(0));
    ctx.closePath();
    ctx.fillStyle = motionC;
    ctx.globalAlpha = 0.55;
    ctx.fill();
    ctx.globalAlpha = 1;

    // Flüssigkeit als Linie
    ctx.beginPath();
    this.data.forEach((d, i) => (i ? ctx.lineTo(x(i), y(d.fluid)) : ctx.moveTo(x(i), y(d.fluid))));
    ctx.strokeStyle = fluidC;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}
