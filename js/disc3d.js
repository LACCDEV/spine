/**
 * disc3d.js – animiertes 3D-Modell des Bewegungssegments L4/L5 (three.js).
 *
 * Darstellung wie in einem Anatomie-Atlas mit Schnittfenster: Aus Faserring,
 * Deckplatten und Wirbelkörpern ist vorne links ein Sektor herausgeschnitten,
 * damit man Lamellen, Gallertkern und den Stoffaustausch sehen kann.
 *
 * Koordinaten (Modell): x = links der Person, y = oben, z = vorne (Bauch).
 * Die obere Platte (L4) kippt/dreht um einen Drehpunkt über dem Kern.
 * Alle Winkel werden für die Sichtbarkeit stark übertrieben (siehe
 * EXAGGERATION) – das ist im UI vermerkt.
 *
 * Deformation (CPU, pro Bild):
 *   - Jeder Punkt des Faserrings wird zwischen der festen unteren und der
 *     bewegten oberen Platte interpoliert. Dadurch verdreht sich der Ring bei
 *     Rotation und wird auf der Druckseite niedriger.
 *   - Lokale Stauchung (1 − lokale Höhe / Ruhehöhe) drückt den Ring nach
 *     außen (Ausbuchtung), Dehnung zieht ihn leicht nach innen.
 *   - Der Kern wandert von der gestauchten Seite weg.
 *   - Flüssigkeit im Kern bestimmt Scheibenhöhe, Kernvolumen, Farbe und Glanz.
 */
import * as THREE from '../vendor/three/three.module.js';

// --- Geometrie-Konstanten (willkürliche Einheiten, Breite der Scheibe = 2) ---
const A = 1.0;            // halbe Breite (links–rechts)
const B = 0.66;           // halbe Tiefe (vorne–hinten)
const CZ = -0.05;         // Kernzentrum etwas nach hinten versetzt
const S_IN = 0.5;         // innere Grenze des Faserrings (Anteil der Kontur)
const H0 = 0.46;          // Bandscheibenhöhe bei voller Flüssigkeit
const EP_T = 0.05;        // Dicke der knorpeligen Deckplatte
const VB_H = 0.6;         // Höhe eines Wirbelkörpers (gekürzt dargestellt)
const LAMELLAE = 8;       // Zahl der sichtbaren Lamellen
const DEG = Math.PI / 180;
const CUT0 = 15 * DEG;    // Schnittfenster von … (0° = links, 90° = vorne)
const CUT1 = 105 * DEG;   // … bis
const BOTTOM_Y = -H0 / 2; // Unterkante der Scheibe (fest)

/** Übertreibung Rumpfwinkel → Segmentwinkel, mit Begrenzung (Grad). */
export const EXAGGERATION = Object.freeze({
  flex: { k: 0.4, max: 13 },
  lat: { k: 0.6, max: 11 },
  twist: { k: 0.4, max: 11 },
});

/** Kontur der Bandscheibe (nierenförmig: hinten zum Wirbelkanal eingebuchtet). */
function outline(theta) {
  const c = Math.cos(theta), s = Math.sin(theta);
  let x = A * c, z = B * s;
  if (s < 0) z += 0.28 * B * (-s) * Math.exp(-(c * c) / 0.18);
  return [x, z];
}

/** Punkt in der Scheibenebene für Winkel θ und Radialanteil s (0 = Kernmitte, 1 = Außenrand). */
function planar(theta, s) {
  const [ox, oz] = outline(theta);
  return [s * ox, CZ + s * (oz - CZ)];
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

// ---------------------------------------------------------------------------
// Prozedurale Texturen (Canvas) – keine Bilddateien nötig
// ---------------------------------------------------------------------------
function canvasTexture(w, h, draw, { repeat = false } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Äußerste Lamelle: schräg verlaufende Kollagenfasern. */
function fiberTexture() {
  return canvasTexture(256, 128, (g, w, h) => {
    g.fillStyle = '#efe3cb'; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(160,128,86,0.45)';
    g.lineWidth = 2;
    for (let i = -h; i < w + h; i += 9) {
      g.beginPath(); g.moveTo(i, h); g.lineTo(i + h * 0.6, 0); g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1;
    for (let i = -h; i < w + h; i += 9) {
      g.beginPath(); g.moveTo(i + 3, h); g.lineTo(i + 3 + h * 0.6, 0); g.stroke();
    }
  }, { repeat: true });
}

/** Schnittfläche: Lamellen als Bänder, Faserrichtung wechselt von Lamelle zu Lamelle. */
function lamellaTexture() {
  return canvasTexture(512, 256, (g, w, h) => {
    const bw = w / LAMELLAE;
    for (let i = 0; i < LAMELLAE; i++) {
      g.fillStyle = i % 2 ? '#e4d1ae' : '#f2e6cf';
      g.fillRect(i * bw, 0, bw, h);
      g.save();
      g.beginPath(); g.rect(i * bw, 0, bw, h); g.clip();
      g.strokeStyle = 'rgba(150,118,78,0.35)'; g.lineWidth = 1.5;
      const dir = i % 2 ? 1 : -1;
      for (let y = -bw; y < h + bw; y += 7) {
        g.beginPath(); g.moveTo(i * bw, y); g.lineTo((i + 1) * bw, y + dir * bw * 0.58); g.stroke();
      }
      g.restore();
      g.fillStyle = 'rgba(150,115,70,0.55)';
      g.fillRect(i * bw, 0, 2, h);
    }
  });
}

/** Spongiosa (Schnittfläche des Wirbelkörpers) mit Kapillaren nahe der Deckplatte (v = 0). */
function spongeTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#ecd6bd'; g.fillRect(0, 0, w, h);
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 420; i++) {
      const x = rnd() * w, y = rnd() * h, r = 2 + rnd() * 6;
      g.fillStyle = `rgba(${170 + rnd() * 30},${120 + rnd() * 25},${95 + rnd() * 20},0.55)`;
      g.beginPath(); g.ellipse(x, y, r, r * (0.6 + rnd() * 0.6), rnd() * 3, 0, Math.PI * 2); g.fill();
    }
    // Kapillarschlingen direkt an der Deckplatte – hier beginnt die Diffusion
    for (let i = 0; i < 70; i++) {
      const x = rnd() * w, y = h - rnd() * rnd() * 46;
      g.fillStyle = 'rgba(178,58,52,0.75)';
      g.beginPath(); g.arc(x, y, 1.4 + rnd() * 2, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = 'rgba(255,250,240,0.55)'; g.fillRect(0, h - 4, w, 4); // Kortikalis-Rand
  });
}

function dotTexture() {
  return canvasTexture(64, 64, (g, w) => {
    const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.45, 'rgba(255,255,255,0.85)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, w);
  });
}

function labelSprite(text, { color = '#1f2a2e', bg = 'rgba(250,246,238,0.92)', scale = 0.19 } = {}) {
  const font = '600 44px system-ui, -apple-system, "Segoe UI", sans-serif';
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  g.font = font;
  const tw = Math.ceil(g.measureText(text).width);
  c.width = tw + 44; c.height = 72;
  g.font = font;
  g.fillStyle = bg;
  const r = 30;
  g.beginPath();
  g.roundRect ? g.roundRect(2, 2, c.width - 4, c.height - 4, r) : g.rect(2, 2, c.width - 4, c.height - 4);
  g.fill();
  g.fillStyle = color; g.textBaseline = 'middle'; g.textAlign = 'center';
  g.fillText(text, c.width / 2, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(scale * (c.width / c.height), scale, 1);
  sp.renderOrder = 10;
  return sp;
}

// ---------------------------------------------------------------------------
// Parametrische Fläche, deren Punkte jedes Bild neu berechnet werden
// ---------------------------------------------------------------------------
class ParamSurface {
  /**
   * @param {number} nu @param {number} nv  Segmente
   * @param {(u:number,v:number)=>[number,number,number]} param  → [θ, s, t]
   * @param {(u:number,v:number)=>[number,number]} uv
   * @param {THREE.Material} material
   * @param {boolean} withColor  Vertex-Farben (für Druck-Tönung)
   */
  constructor(nu, nv, param, uv, material, withColor = false) {
    const n = (nu + 1) * (nv + 1);
    this.params = new Float32Array(n * 3);
    const uvs = new Float32Array(n * 2);
    const pos = new Float32Array(n * 3);
    let k = 0;
    for (let i = 0; i <= nu; i++) {
      for (let j = 0; j <= nv; j++, k++) {
        const u = i / nu, v = j / nv;
        const p = param(u, v);
        this.params.set(p, k * 3);
        const q = uv(u, v);
        uvs[k * 2] = q[0]; uvs[k * 2 + 1] = q[1];
      }
    }
    const idx = [];
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const a = i * (nv + 1) + j, b = a + nv + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    if (withColor) geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    geo.setIndex(idx);
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.count = n;
  }

  update(deform, colorFn) {
    const pos = this.geo.attributes.position.array;
    const col = this.geo.attributes.color?.array;
    const P = this.params, out = { x: 0, y: 0, z: 0, comp: 0 };
    for (let k = 0; k < this.count; k++) {
      deform(P[k * 3], P[k * 3 + 1], P[k * 3 + 2], out);
      pos[k * 3] = out.x; pos[k * 3 + 1] = out.y; pos[k * 3 + 2] = out.z;
      if (col && colorFn) colorFn(out, col, k * 3);
    }
    this.geo.attributes.position.needsUpdate = true;
    if (col) this.geo.attributes.color.needsUpdate = true;
    this.geo.computeVertexNormals();
  }
}

/** Kontur mit herausgeschnittenem Sektor als THREE.Shape (Shape-y = −z). */
function cutShape(scale = 1) {
  const shape = new THREE.Shape();
  shape.moveTo(0, -CZ);
  const steps = 72;
  for (let i = 0; i <= steps; i++) {
    const th = CUT1 + (i / steps) * (2 * Math.PI - (CUT1 - CUT0));
    const [x, z] = outline(th);
    const sx = x * scale, sz = CZ + (z - CZ) * scale;
    shape.lineTo(sx, -sz);
  }
  shape.lineTo(0, -CZ);
  return shape;
}

// ---------------------------------------------------------------------------
export class DiscScene {
  static isSupported() {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch { return false; }
  }

  /**
   * @param {HTMLElement} host  Container, in den das Canvas eingefügt wird
   * @param {{reducedMotion?:boolean}} opts
   */
  constructor(host, { reducedMotion = false } = {}) {
    this.host = host;
    this.reducedMotion = reducedMotion;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'default' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'disc-canvas';
    host.appendChild(this.canvas);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(26, 1, 0.1, 60);
    this.target = new THREE.Vector3(0, -0.02, -0.2);
    this.view = { az: 58 * DEG, el: 27 * DEG, dist: 7.6 };
    this.view0 = { ...this.view };

    // Zustand (Zielwerte und geglättete Anzeigewerte)
    this.input = { flex: 0, lat: 0, twist: 0, fluid: 0.75, waste: 0.3, exchange: 0.3, active: false };
    this.shown = { flex: 0, lat: 0, twist: 0, fluid: 0.75, waste: 0.3, exchange: 0.3 };
    this.T = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.topY = BOTTOM_Y + H0;
    this.Hcur = H0;
    this.nucleusCenter = new THREE.Vector3(0, 0, CZ);
    this.nucleusAxes = new THREE.Vector3(0.45, 0.18, 0.3);

    this.buildLights();
    this.buildMaterials();
    this.buildVertebrae();
    this.buildAnnulus();
    this.buildNucleus();
    this.buildParticles();
    this.buildLabels();
    this.bindInput();
    this.resize();
    this.update(0);
  }

  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xfff4e2, 0x5d6f73, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 5, 4.5);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfe3ff, 0.7);
    rim.position.set(-4, 1.5, -3);
    this.scene.add(rim);
  }

  buildMaterials() {
    this.tex = {
      fiber: fiberTexture(),
      lamella: lamellaTexture(),
      sponge: spongeTexture(),
      dot: dotTexture(),
    };
    this.tex.fiber.repeat.set(1, 1);
    const side = THREE.DoubleSide;
    this.mat = {
      annulusOuter: new THREE.MeshStandardMaterial({ map: this.tex.fiber, vertexColors: true, roughness: 0.62, metalness: 0, side }),
      annulusCut: new THREE.MeshStandardMaterial({ map: this.tex.lamella, roughness: 0.7, side }),
      annulusInner: new THREE.MeshStandardMaterial({ color: 0xe9dcc0, roughness: 0.75, side }),
      bone: new THREE.MeshStandardMaterial({ color: 0xe6d8bf, roughness: 0.82 }),
      sponge: new THREE.MeshStandardMaterial({ map: this.tex.sponge, roughness: 0.9, side, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
      endplate: new THREE.MeshStandardMaterial({ color: 0xa9d0d6, roughness: 0.45 }),
      nucleus: new THREE.MeshPhysicalMaterial({ color: 0x4fc3bd, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.15, emissive: 0x1d6f6b, emissiveIntensity: 0.25 }),
    };
  }

  /** Wirbelkörper mit Schnittfenster, Deckplatte und vereinfachtem Wirbelbogen. */
  makeVertebra(upper) {
    const g = new THREE.Group();
    const shape = cutShape(1.03);
    const bodyGeo = new THREE.ExtrudeGeometry(shape, {
      depth: VB_H, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2, curveSegments: 48,
    });
    bodyGeo.rotateX(-Math.PI / 2); // Extrusion entlang +y, Shape-y → −z
    const body = new THREE.Mesh(bodyGeo, this.mat.bone);
    const epGeo = new THREE.ExtrudeGeometry(cutShape(0.98), { depth: EP_T, bevelEnabled: false, curveSegments: 48 });
    epGeo.rotateX(-Math.PI / 2);
    const ep = new THREE.Mesh(epGeo, this.mat.endplate);

    // Schnittflächen des Wirbelkörpers mit Spongiosa-Textur (v = 0 an der Deckplatte)
    // Die Fläche wird etwas ins Schnittfenster versetzt, weil die abgerundete
    // Kante (Bevel) des Wirbelkörpers sonst davor liegt.
    const [mx, mz] = planar((CUT0 + CUT1) / 2, 0.6);
    const cutFace = (theta) => {
      const [x, z] = outline(theta);
      const dx = x, dz = z - CZ, dl = Math.hypot(dx, dz);
      let nx = -dz / dl, nz = dx / dl;
      if (nx * mx + nz * (mz - CZ) < 0) { nx = -nx; nz = -nz; }
      const ox = nx * 0.036, oz = nz * 0.036;
      const geo = new THREE.BufferGeometry();
      const y0 = upper ? EP_T : -EP_T, y1 = upper ? EP_T + VB_H : -EP_T - VB_H;
      const ex = x * 1.03 + ox, ez = CZ + (z - CZ) * 1.03 + oz;
      const pos = new Float32Array([ox, y0, CZ + oz, ex, y0, ez, ex, y1, ez, ox, y1, CZ + oz]);
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      geo.computeVertexNormals();
      return new THREE.Mesh(geo, this.mat.sponge);
    };

    if (upper) {
      ep.position.y = 0;
      body.position.y = EP_T;
    } else {
      ep.position.y = -EP_T;
      body.position.y = -EP_T - VB_H;
    }
    g.add(body, ep, cutFace(CUT0), cutFace(CUT1));

    // Wirbelbogen (umschließt den Wirbelkanal) + Dornfortsatz + Querfortsätze
    const midY = upper ? EP_T + VB_H * 0.62 : -EP_T - VB_H * 0.38;
    const canalZ = -0.48 - 0.27;
    const arch = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.075, 12, 40, Math.PI), this.mat.bone);
    arch.rotation.x = -Math.PI / 2;
    arch.position.set(0, midY, canalZ + 0.03);
    const pedicleGeo = new THREE.CylinderGeometry(0.075, 0.085, 0.32, 14);
    pedicleGeo.rotateX(Math.PI / 2);
    for (const sx of [-1, 1]) {
      const ped = new THREE.Mesh(pedicleGeo, this.mat.bone);
      ped.position.set(sx * 0.3, midY, canalZ + 0.17);
      g.add(ped);
      const tp = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.11, 0.13), this.mat.bone);
      tp.position.set(sx * 0.55, midY + 0.02, canalZ - 0.02);
      tp.rotation.z = sx * 0.12;
      g.add(tp);
    }
    const sp = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.26, 0.7), this.mat.bone);
    sp.position.set(0, midY - 0.12, canalZ - 0.55);
    sp.rotation.x = 0.35;
    g.add(arch, sp);
    return g;
  }

  buildVertebrae() {
    this.lower = new THREE.Group();
    const lv = this.makeVertebra(false);
    lv.position.set(0, BOTTOM_Y, 0);
    this.lower.add(lv);
    this.scene.add(this.lower);

    // Obere Gruppe: Ursprung im Drehpunkt (über dem Kern, Höhe der oberen Scheibenkante)
    this.upper = new THREE.Group();
    const uv = this.makeVertebra(true);
    uv.position.set(0, 0, -CZ);
    this.upper.add(uv);
    this.scene.add(this.upper);
  }

  buildAnnulus() {
    const span = 2 * Math.PI - (CUT1 - CUT0);
    const th = (u) => CUT1 + u * span;
    const sOf = (v) => S_IN + v * (1 - S_IN);
    const NU = 120, NV = 12, NS = 10;
    const g = new THREE.Group();
    this.surfaces = [
      new ParamSurface(NU, NV, (u, v) => [th(u), 1, v], (u, v) => [u * 9, v], this.mat.annulusOuter, true),
      new ParamSurface(NU, NV, (u, v) => [th(u), S_IN, v], (u, v) => [u, v], this.mat.annulusInner),
      new ParamSurface(NU, NS, (u, v) => [th(u), sOf(v), 1], (u, v) => [v, u * 6], this.mat.annulusCut),
      new ParamSurface(NU, NS, (u, v) => [th(u), sOf(v), 0], (u, v) => [v, u * 6], this.mat.annulusCut),
      new ParamSurface(NS, NV, (u, v) => [CUT0, sOf(u), v], (u, v) => [u, v], this.mat.annulusCut),
      new ParamSurface(NS, NV, (u, v) => [CUT1, sOf(u), v], (u, v) => [u, v], this.mat.annulusCut),
    ];
    for (const s of this.surfaces) g.add(s.mesh);
    this.annulus = g;
    this.scene.add(g);
    // Vorberechnete Konturpunkte sparen Trigonometrie pro Bild
    this.outlineCache = new Map();
  }

  buildNucleus() {
    const geo = new THREE.SphereGeometry(1, 48, 32);
    this.nucleus = new THREE.Mesh(geo, this.mat.nucleus);
    this.scene.add(this.nucleus);
    this.colWet = new THREE.Color(0x4cc4be);
    this.colDry = new THREE.Color(0xb3a172);
    this.emWet = new THREE.Color(0x1d6f6b);
  }

  buildParticles() {
    const max = this.reducedMotion ? 150 : 320;
    this.pMax = max;
    this.particles = Array.from({ length: max }, () => ({ active: false }));
    const geo = new THREE.BufferGeometry();
    this.pPos = new Float32Array(max * 3);
    this.pCol = new Float32Array(max * 4);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 4));
    const mat = new THREE.PointsMaterial({
      size: 0.1, map: this.tex.dot, vertexColors: true, transparent: true,
      depthWrite: false, sizeAttenuation: true, alphaTest: 0.02,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.scene.add(this.points);
    this.nutrientColor = new THREE.Color(0x2f8fe0);
    this.wasteColor = new THREE.Color(0xd9822b);
    this.spawnAcc = { nut: 0, exit: 0 };
    this.tmpV = new THREE.Vector3();
    this.tmpA = new THREE.Vector3();
    this.tmpB = new THREE.Vector3();
  }

  buildLabels() {
    const front = labelSprite('vorne · Bauch');
    front.position.set(0.3, -0.6, B + 0.45);
    const back = labelSprite('hinten · Rücken');
    back.position.set(0, 0.62, -1.6);
    // L4 hängt an der oberen (beweglichen) Gruppe, deren Ursprung im Drehpunkt liegt
    const l4 = labelSprite('L4', { scale: 0.17 });
    l4.position.set(-1.3, EP_T + VB_H * 0.5, -CZ);
    const l5 = labelSprite('L5', { scale: 0.17 });
    l5.position.set(-1.3, BOTTOM_Y - EP_T - VB_H * 0.5, 0);
    this.labels = [front, back, l4, l5];
    this.scene.add(front, back, l5);
    this.upper.add(l4);
  }

  // -------------------------------------------------------------------------
  bindInput() {
    const c = this.canvas;
    c.tabIndex = 0;
    let drag = null;
    c.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId, type: e.pointerType };
      c.setPointerCapture?.(e.pointerId);
      c.classList.add('dragging');
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      this.rotateView(-dx * 0.008, drag.type === 'touch' ? 0 : dy * 0.006);
    });
    const end = (e) => {
      if (drag && e.pointerId === drag.id) { drag = null; c.classList.remove('dragging'); }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('keydown', (e) => {
      const step = 8 * DEG;
      if (e.key === 'ArrowLeft') this.rotateView(step, 0);
      else if (e.key === 'ArrowRight') this.rotateView(-step, 0);
      else if (e.key === 'ArrowUp') this.rotateView(0, step * 0.6);
      else if (e.key === 'ArrowDown') this.rotateView(0, -step * 0.6);
      else if (e.key === 'Home' || e.key === '0') this.resetView();
      else return;
      e.preventDefault();
    });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.host);
  }

  rotateView(dAz, dEl) {
    this.view.az += dAz;
    this.view.el = Math.min(80 * DEG, Math.max(-30 * DEG, this.view.el + dEl));
  }

  resetView() { Object.assign(this.view, this.view0); }

  resize() {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Auf schmalen Bildschirmen etwas weiter weg, damit alles hineinpasst
    this.view.dist = this.view0.dist = w / h < 0.9 ? 9.4 : 7.6;
    this.camera.updateProjectionMatrix();
  }

  /** Neue Zielwerte (Rumpfwinkel in Grad, Modellzustand 0 … 1). */
  setState(s) { Object.assign(this.input, s); }

  // -------------------------------------------------------------------------
  /** Abbildung eines Punkts aus der neutralen Lage in die verformte Lage. */
  mapPoint(x, y, z, out) {
    if (y >= this.topY) {
      out.set(x, y, z).applyMatrix4(this.T);
    } else if (y <= BOTTOM_Y) {
      out.set(x, y, z);
    } else {
      const t = (y - BOTTOM_Y) / this.Hcur;
      this.tmpA.set(x, BOTTOM_Y, z);
      this.tmpB.set(x, this.topY, z).applyMatrix4(this.T);
      out.copy(this.tmpA).lerp(this.tmpB, t);
    }
    return out;
  }

  update(dt) {
    const S = this.shown, I = this.input;
    const tau = this.reducedMotion ? 0.6 : 0.28;
    const k = dt > 0 ? 1 - Math.exp(-dt / tau) : 1;
    const ex = (v, e) => Math.max(-e.max, Math.min(e.max, v * e.k));
    S.flex += (ex(I.flex, EXAGGERATION.flex) - S.flex) * k;
    S.lat += (ex(I.lat, EXAGGERATION.lat) - S.lat) * k;
    S.twist += (ex(I.twist, EXAGGERATION.twist) - S.twist) * k;
    const k2 = dt > 0 ? 1 - Math.exp(-dt / 0.8) : 1;
    S.fluid += (I.fluid - S.fluid) * k2;
    S.waste += (I.waste - S.waste) * k2;
    S.exchange += (I.exchange - S.exchange) * k2;

    // --- obere Platte ---
    this.Hcur = H0 * (0.72 + 0.28 * S.fluid);
    this.topY = BOTTOM_Y + this.Hcur;
    const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), S.flex * DEG);
    const qz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), S.lat * DEG);
    const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -S.twist * DEG);
    this.q.copy(qx).multiply(qz).multiply(qy);
    const pivot = new THREE.Vector3(0, this.topY, CZ);
    this.T.makeRotationFromQuaternion(this.q);
    const pr = pivot.clone().applyMatrix4(this.T);
    this.T.setPosition(pivot.x - pr.x, pivot.y - pr.y, pivot.z - pr.z);
    this.upper.position.copy(pivot);
    this.upper.quaternion.copy(this.q);

    // --- Faserring ---
    const Hc = this.Hcur, topY = this.topY, T = this.T, F = S.fluid;
    const a = this.tmpA, b = this.tmpB;
    const cache = this.outlineCache;
    const deform = (theta, s, t, out) => {
      let o = cache.get(theta);
      if (!o) { o = outline(theta); cache.set(theta, o); }
      const x = s * o[0], z = CZ + s * (o[1] - CZ);
      a.set(x, BOTTOM_Y, z);
      b.set(x, topY, z).applyMatrix4(T);
      const localH = b.y - a.y;
      const comp = 1 - localH / Hc; // > 0 gestaucht, < 0 gedehnt
      const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t, pz = a.z + (b.z - a.z) * t;
      const rad = (s - S_IN) / (1 - S_IN);
      const sinT = Math.sin(Math.PI * t);
      const bulge = (comp > 0 ? comp * 0.75 : comp * 0.3) * sinT * (0.35 + 0.65 * rad)
        + (F - 0.5) * 0.05 * sinT * s;
      const rx = o[0], rz = o[1] - CZ, rl = Math.hypot(rx, rz) || 1;
      out.x = px + (rx / rl) * bulge;
      out.y = py;
      out.z = pz + (rz / rl) * bulge;
      out.comp = comp;
    };
    const dry = 1 - F;
    const tint = (out, col, i) => {
      const c = Math.max(-1, Math.min(1, out.comp * 3));
      // gestaucht → wärmer/rötlicher, gedehnt → kühler; trockener → gelblicher
      col[i] = 1 - (c < 0 ? -c * 0.12 : 0);
      col[i + 1] = 1 - (c > 0 ? c * 0.2 : 0) - dry * 0.04;
      col[i + 2] = 1 - (c > 0 ? c * 0.3 : -c * -0.02) - dry * 0.14;
    };
    for (let i = 0; i < this.surfaces.length; i++) this.surfaces[i].update(deform, i === 0 ? tint : null);

    // --- Gallertkern ---
    const vol = 0.78 + 0.22 * F;
    const c0 = this.tmpV.set(0, BOTTOM_Y, CZ);
    const c1 = new THREE.Vector3(0, topY, CZ).applyMatrix4(T);
    const center = this.nucleusCenter.copy(c0).lerp(c1, 0.5);
    const shift = 0.95;
    center.x += Math.sin(S.lat * DEG) * shift;
    center.z += -Math.sin(S.flex * DEG) * shift;
    this.nucleus.position.copy(center);
    this.nucleus.quaternion.identity().slerp(this.q, 0.5);
    const ax = A * S_IN * 0.9 * vol, az = B * S_IN * 0.95 * vol, ay = Hc * 0.43 * (0.9 + 0.1 * vol);
    this.nucleus.scale.set(ax, ay, az);
    this.nucleusAxes.set(ax, ay, az);
    const m = this.mat.nucleus;
    m.color.copy(this.colDry).lerp(this.colWet, F);
    m.roughness = 0.75 - 0.57 * F;
    m.clearcoat = 0.1 + 0.9 * F;
    m.emissive.copy(this.emWet).multiplyScalar(F);

    this.updateParticles(dt);

    // --- Kamera ---
    const v = this.view;
    if (!I.active && !this.reducedMotion) v.az += dt * 0.05; // ruhige Vorschau dreht sich langsam
    const ce = Math.cos(v.el);
    this.camera.position.set(
      this.target.x + v.dist * ce * Math.cos(v.az),
      this.target.y + v.dist * Math.sin(v.el),
      this.target.z + v.dist * ce * Math.sin(v.az),
    );
    this.camera.lookAt(this.target);
    this.renderer.render(this.scene, this.camera);
  }

  // -------------------------------------------------------------------------
  // Partikel: Nährstoffe/Wasser (blau) strömen durch die Deckplatten in den
  // Kern, Abfallstoffe (ocker) sammeln sich bei Stillstand um den Kern und
  // werden bei Bewegung hinaus transportiert. Alles im Schnittfenster.
  // -------------------------------------------------------------------------
  freeParticle() {
    for (const p of this.particles) if (!p.active) return p;
    return null;
  }

  randomSectorPoint(margin = 0.1) {
    const th = CUT0 + margin + Math.random() * (CUT1 - CUT0 - 2 * margin);
    const s = 0.18 + Math.random() * 0.62;
    return planar(th, s);
  }

  spawnNutrient() {
    const p = this.freeParticle();
    if (!p) return;
    const [x, z] = this.randomSectorPoint();
    const side = Math.random() < 0.5 ? 1 : -1;
    const depth = 0.2 + Math.random() * 0.6;
    Object.assign(p, {
      active: true, kind: 'nut', phase: 0, side, x, z, age: 0,
      y: side > 0 ? this.topY + EP_T + depth : BOTTOM_Y - EP_T - depth,
      speed: 0.35 + Math.random() * 0.3,
      k: 0,
      // Ziel: Oberfläche des Kerns in Richtung des Schnittfensters (leicht innen)
      tdir: new THREE.Vector3(x, side * (0.3 + Math.random() * 0.5), z - CZ).normalize(),
    });
  }

  spawnLinger() {
    const p = this.freeParticle();
    if (!p) return;
    const mid = (CUT0 + CUT1) / 2;
    Object.assign(p, {
      active: true, kind: 'waste', phase: 'linger', age: 0,
      phi: mid + (Math.random() - 0.5) * (CUT1 - CUT0) * 0.95,
      psi: (Math.random() - 0.5) * 1.3,
      r: 1.03 + Math.random() * 0.16,
      dphi: (Math.random() - 0.5) * 0.15,
      seed: Math.random() * 10,
    });
  }

  /** Abfallpartikel verlässt den Kern Richtung Deckplatte und Wirbelkörper. */
  startExit(p, from) {
    const side = Math.random() < 0.5 ? 1 : -1;
    const [x, z] = this.randomSectorPoint(0.12);
    Object.assign(p, {
      kind: 'waste', phase: 'exit', side, x, z, k: 0,
      from: from.clone(), speed: 0.5 + Math.random() * 0.35,
      y: side > 0 ? this.topY : BOTTOM_Y,
    });
  }

  nucleusSurfacePoint(dir, scale, out) {
    const ax = this.nucleusAxes;
    out.set(dir.x * ax.x * scale, dir.y * ax.y * scale, dir.z * ax.z * scale);
    out.applyQuaternion(this.nucleus.quaternion).add(this.nucleusCenter);
    return out;
  }

  updateParticles(dt) {
    dt = Math.min(dt, 0.1);
    const S = this.shown, E = S.exchange;
    const rm = this.reducedMotion ? 0.55 : 1;
    const flow = (0.35 + 1.3 * E) * rm;

    // Neue Nährstoffe: Rate wächst mit dem Austausch; ohne Bewegung nur ein Rinnsal.
    this.spawnAcc.nut += dt * 30 * rm * Math.pow(E, 1.3);
    while (this.spawnAcc.nut >= 1) { this.spawnAcc.nut -= 1; this.spawnNutrient(); }

    // Abfallstoffe um den Kern: Anzahl folgt dem Modellwert.
    let lingerCount = 0;
    for (const p of this.particles) if (p.active && p.phase === 'linger') lingerCount++;
    const lingerTarget = Math.round(S.waste * (this.reducedMotion ? 30 : 64));
    if (lingerCount < lingerTarget && Math.random() < dt * 6) this.spawnLinger();
    // Bei Bewegung (oder Überschuss) werden Abfallstoffe abtransportiert.
    const exitChance = dt * (Math.pow(E, 2) * 0.9 + (lingerCount > lingerTarget + 2 ? 1.5 : 0));
    // Laufende Produktion, die bei gutem Austausch direkt abfließt
    this.spawnAcc.exit += dt * 8 * rm * E * (0.25 + S.waste);
    const tmp = this.tmpV;

    let i = 0;
    for (const p of this.particles) {
      const o = i * 3, c = i * 4;
      i++;
      if (!p.active) { this.pCol[c + 3] = 0; continue; }
      p.age += dt;
      let alpha = 1, color = this.nutrientColor;

      if (p.kind === 'nut') {
        if (p.phase === 0) {
          const stop = p.side > 0 ? this.topY : BOTTOM_Y;
          p.y -= p.side * p.speed * flow * dt;
          if ((p.side > 0 && p.y <= stop) || (p.side < 0 && p.y >= stop)) { p.y = stop; p.phase = 1; p.k = 0; }
          this.mapPoint(p.x, p.y, p.z, tmp);
          alpha = smooth(0, 0.4, p.age);
        } else {
          p.k += dt * p.speed * flow * 1.6;
          this.mapPoint(p.x, p.side > 0 ? this.topY : BOTTOM_Y, p.z, this.tmpA);
          const tgt = this.nucleusSurfacePoint(p.tdir, 0.85, this.tmpB);
          tmp.copy(this.tmpA).lerp(tgt, ease(Math.min(1, p.k)));
          alpha = 1 - smooth(0.7, 1, p.k);
          if (p.k >= 1) p.active = false;
        }
      } else {
        color = this.wasteColor;
        if (p.phase === 'linger') {
          p.phi += p.dphi * dt;
          if (p.phi < CUT0 || p.phi > CUT1) p.dphi = -p.dphi;
          const wob = Math.sin(p.age * 0.7 + p.seed) * 0.08;
          const d = new THREE.Vector3(Math.cos(p.phi) * Math.cos(p.psi + wob), Math.sin(p.psi + wob), Math.sin(p.phi) * Math.cos(p.psi + wob));
          this.nucleusSurfacePoint(d, p.r, tmp);
          alpha = smooth(0, 1.2, p.age);
          if (Math.random() < exitChance) this.startExit(p, tmp);
        } else if (p.phase === 'exit') {
          p.k += dt * p.speed * flow * 1.4;
          this.mapPoint(p.x, p.y, p.z, this.tmpA);
          tmp.copy(p.from).lerp(this.tmpA, ease(Math.min(1, p.k)));
          if (p.k >= 1) { p.phase = 'bone'; p.depth = 0; }
        } else { // 'bone': weiter in den Wirbelkörper, dort ausblenden
          p.depth += dt * p.speed * flow * 0.6;
          const y = p.side > 0 ? this.topY + EP_T + p.depth : BOTTOM_Y - EP_T - p.depth;
          this.mapPoint(p.x, y, p.z, tmp);
          alpha = 1 - smooth(0.25, 0.6, p.depth);
          if (p.depth > 0.6) p.active = false;
        }
      }
      this.pPos[o] = tmp.x; this.pPos[o + 1] = tmp.y; this.pPos[o + 2] = tmp.z;
      this.pCol[c] = color.r; this.pCol[c + 1] = color.g; this.pCol[c + 2] = color.b;
      this.pCol[c + 3] = alpha;
    }
    // Direkt aus dem Kern abfließende Abfallstoffe
    while (this.spawnAcc.exit >= 1) {
      this.spawnAcc.exit -= 1;
      const p = this.freeParticle();
      if (!p) break;
      const mid = (CUT0 + CUT1) / 2 + (Math.random() - 0.5) * (CUT1 - CUT0) * 0.8;
      const d = new THREE.Vector3(Math.cos(mid), (Math.random() - 0.5) * 1.2, Math.sin(mid)).normalize();
      p.active = true; p.age = 0;
      this.startExit(p, this.nucleusSurfacePoint(d, 1.0, new THREE.Vector3()));
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }

  dispose() {
    this.ro?.disconnect();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
