// End-to-End-Tests mit Playwright (Chromium/Chrome) und Fake-Webcam.
//
//   npm install            (installiert nur playwright-core, keinen Browser)
//   npm run e2e            (nutzt installiertes Chrome; sonst CHROME_PATH setzen)
//
// Optional: tests/fixtures/person.y4m (oder .mjpeg) – ein Video einer Person.
// Dann wird zusätzlich geprüft, ob eine Person erkannt wird.
// Screenshots landen in tests/output/.
import { chromium } from 'playwright-core';
import { mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from './serve.mjs';

const OUT = fileURLToPath(new URL('./output/', import.meta.url));
const FIXTURE_CANDIDATES = ['fixtures/person.y4m', 'fixtures/person.mjpeg'].map((p) => fileURLToPath(new URL(p, import.meta.url)));
await mkdir(OUT, { recursive: true });

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `http://localhost:${PORT}/`;

const launchOpts = (extraArgs = []) => ({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: process.env.PW_CHANNEL || 'chrome' }),
  args: [
    '--use-fake-device-for-media-stream',
    '--enable-unsafe-swiftshader', // WebGL ohne GPU im Headless-Betrieb
    '--ignore-gpu-blocklist',
    ...extraArgs,
  ],
});

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` – ${detail}` : ''}`);
}

/** Hängt Fehler-Sammler an eine Seite. */
function watch(page) {
  const log = { console: [], pageErrors: [], failed: [], bad: [], foreign: [], requests: [] };
  page.on('console', (m) => { if (m.type() === 'error') log.console.push(m.text()); });
  page.on('pageerror', (e) => log.pageErrors.push(String(e)));
  page.on('requestfailed', (r) => log.failed.push(`${r.url()} ${r.failure()?.errorText}`));
  page.on('request', (r) => {
    log.requests.push(r.url());
    const u = new URL(r.url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname) && !['data:', 'blob:'].includes(u.protocol)) log.foreign.push(r.url());
  });
  page.on('response', (r) => { if (r.status() >= 400) log.bad.push(`${r.status()} ${r.url()}`); });
  return log;
}

function reportLog(prefix, log, { allowConsole = [] } = {}) {
  const cons = log.console.filter((t) => !allowConsole.some((re) => re.test(t)));
  check(`${prefix}: keine Konsolenfehler`, cons.length === 0, cons.slice(0, 3).join(' | '));
  check(`${prefix}: keine Skriptfehler`, log.pageErrors.length === 0, log.pageErrors.slice(0, 3).join(' | '));
  check(`${prefix}: keine fehlgeschlagenen Anfragen`, log.failed.length === 0 && log.bad.length === 0, [...log.failed, ...log.bad].slice(0, 3).join(' | '));
  check(`${prefix}: keine Anfragen an fremde Server`, log.foreign.length === 0, log.foreign.slice(0, 3).join(' | '));
}

const state = (page) => page.evaluate(() => {
  const a = window.__bib;
  return {
    mode: a.mode, key: a.coachView?.key, fluid: a.model.fluid, waste: a.model.waste, exchange: a.model.exchange,
    spine: a.motion.result.spine, body: a.motion.result.body, progress: { ...a.motion.result.progress },
    posture: a.postureInfo.posture, assumed: a.postureInfo.assumed, persons: a.persons.length,
    hasDisc: !!a.disc, particles: a.disc?.pMax, delegate: a.camera.delegate, landmarker: !!a.camera.landmarker,
    detectMs: a.camera.detectMs, reason: a.reason, frameNo: a.frameNo,
  };
});

async function sampleWhile(page, seconds, fn) {
  const out = [];
  for (let i = 0; i < seconds * 2; i++) { await page.waitForTimeout(500); out.push(await fn()); }
  return out;
}

// ===========================================================================
const browser = await chromium.launch(launchOpts(['--use-fake-ui-for-media-stream']));

// --- 1. Desktop: Vorschau, Demo still, Demo bewegen -----------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const log = watch(page);
  await page.goto(BASE);
  await page.waitForFunction(() => window.__bib && window.__bib.frameNo > 20);
  let s = await state(page);
  check('Desktop: Seite lädt, 3D-Szene (WebGL) aktiv', s.hasDisc);
  check('Desktop: MediaPipe wird vor dem Kamerastart nicht geladen', !log.requests.some((u) => u.includes('mediapipe')));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}desktop-vorschau.png` });

  // Demo still sitzen (Zeitraffer 1 s = 3 min für einen schnellen Effekt)
  await page.selectOption('#sel-timescale', '180');
  await page.click('#btn-demo-still');
  const f0 = (await state(page)).fluid;
  const still = await sampleWhile(page, 10, () => state(page));
  s = still.at(-1);
  check('Demo still: kein Bewegungsmaß aus Haltungsrauschen', Math.max(...still.map((x) => x.spine)) < 0.1, `max spine ${Math.max(...still.map((x) => x.spine)).toFixed(3)}`);
  check('Demo still: Flüssigkeit sinkt, Abfallstoffe steigen', s.fluid < f0 - 0.1 && s.waste > 0.4, `fluid ${f0.toFixed(2)}→${s.fluid.toFixed(2)}, waste ${s.waste.toFixed(2)}`);
  check('Demo still: Coach eskaliert', ['sinks', 'under'].includes(s.key), s.key);
  check('Demo still: Sitzen angenommen (Knie verdeckt)', s.posture === 'sitzen' && s.assumed);
  const statusText = await page.textContent('#status-title');
  check('Demo still: Statustext sichtbar', /Versorgung sinkt|unterversorgt/.test(statusText), statusText);
  await page.screenshot({ path: `${OUT}desktop-demo-still.png` });

  // Demo Wirbelsäule bewegen
  await page.click('#btn-demo-move');
  const moving = await sampleWhile(page, 40, () => state(page));
  const maxSpine = Math.max(...moving.map((x) => x.spine));
  check('Demo bewegen: Pumpeffekt erkannt', maxSpine > 0.6 && moving.some((x) => x.key === 'pump'), `max spine ${maxSpine.toFixed(2)}`);
  const pr = moving.reduce((m, x) => ({ flex: Math.max(m.flex, x.progress.flex), lat: Math.max(m.lat, x.progress.lat), twist: Math.max(m.twist, x.progress.twist) }), { flex: 0, lat: 0, twist: 0 });
  check('Demo bewegen: alle drei Richtungen gefüllt', pr.flex > 0.8 && pr.lat > 0.8 && pr.twist > 0.8, JSON.stringify(Object.fromEntries(Object.entries(pr).map(([k, v]) => [k, v.toFixed(2)]))));
  check('Demo bewegen: Aufstehen als Stehen erkannt', moving.some((x) => x.posture === 'stehen' && !x.assumed));
  check('Demo bewegen: Ganzkörperbewegung zählt', Math.max(...moving.map((x) => x.body)) > 0.5);
  check('Demo bewegen: Versorgung erholt sich', moving.at(-1).fluid > s.fluid + 0.1 && moving.at(-1).waste < s.waste - 0.1,
    `fluid ${s.fluid.toFixed(2)}→${moving.at(-1).fluid.toFixed(2)}, waste ${s.waste.toFixed(2)}→${moving.at(-1).waste.toFixed(2)}`);
  // Screenshot während Katze-Kuh (Zyklus 46 s, Katze-Kuh 0–12 s)
  await page.click('#btn-demo-move'); await page.click('#btn-demo-move');
  await page.waitForTimeout(3100);
  await page.screenshot({ path: `${OUT}desktop-demo-bewegen.png` });
  await page.locator('.panel--disc').screenshot({ path: `${OUT}detail-bandscheibe.png` });

  // Tastatur: Fokusreihenfolge und sichtbarer Fokus
  await page.focus('#btn-stop');
  await page.keyboard.press('Enter');
  check('Tastatur: Fokus bleibt nach „Stopp“ erhalten', await page.evaluate(() => document.activeElement?.id === 'btn-camera'));
  await page.goto(BASE);
  await page.waitForFunction(() => window.__bib && window.__bib.disc && window.__bib.frameNo > 5);
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => document.activeElement?.className);
  await page.keyboard.press('Tab');
  const second = await page.evaluate(() => document.activeElement?.id);
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  check('Tastatur: Skip-Link zuerst, dann Kamera-Button, Fokus sichtbar', /skip-link/.test(first) && second === 'btn-camera' && outline !== 'none', `${first} → ${second}, outline ${outline}`);
  await page.focus('.disc-canvas');
  await page.keyboard.press('ArrowLeft');
  check('Tastatur: 3D-Ansicht per Pfeiltaste drehbar', await page.evaluate(() => Math.abs(window.__bib.disc.view.az - window.__bib.disc.view0.az) > 0.1));
  check('Barrierefreiheit: aria-live für Coach vorhanden', (await page.getAttribute('#status-live', 'aria-live')) === 'polite');

  // Hintergrund-Tab: Erinnerung im Titel
  await page.selectOption('#sel-timescale', '600');
  await page.click('label.switch');
  await page.click('#btn-demo-still');
  // Headless-Chrome schaltet bei Tab-Wechsel nicht zuverlässig auf „hidden“.
  // Daher wird der Hintergrund-Zustand simuliert: document.hidden = true.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const f1 = await page.evaluate(() => window.__bib.frameNo);
  await page.waitForTimeout(6000);
  const bg = await page.evaluate(() => ({ frames: window.__bib.frameNo, key: window.__bib.coachView?.key }));
  const title = await page.title();
  check('Hintergrund-Tab: Analyse läuft mit ~1 Hz weiter', bg.frames - f1 >= 4 && bg.frames - f1 <= 8, `${bg.frames - f1} Takte in 6 s`);
  check('Hintergrund-Tab: Titel erinnert bei langem Stillsitzen', /Zeit für Bewegung/.test(title), `Status ${bg.key}, Titel „${title}“`);
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(500);
  check('Vordergrund: Titel wieder normal', (await page.title()) === 'Bandscheiben in Bewegung');

  reportLog('Desktop', log);
  await ctx.close();
}

// --- 2. Kamera mit Fake-Webcam (Testbild ohne Person) ---------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['camera'] });
  const page = await ctx.newPage();
  const log = watch(page);
  await page.goto(BASE);
  await page.waitForFunction(() => window.__bib && window.__bib.frameNo > 5);
  await page.click('#btn-camera');
  try {
    await page.waitForFunction(() => window.__bib.mode === 'camera' && window.__bib.camera.detectMs > 0, null, { timeout: 90000 });
  } catch { /* unten als Fehler gemeldet */ }
  await page.waitForTimeout(4000);
  const s = await state(page);
  check('Kamera: MediaPipe geladen und Erkennung läuft', s.mode === 'camera' && s.landmarker && s.detectMs > 0, `delegate ${s.delegate}, ${s.detectMs.toFixed(1)} ms/Bild`);
  const wasmOk = log.requests.some((u) => u.endsWith('.wasm')) && log.requests.some((u) => u.endsWith('.task'));
  check('Kamera: WASM und Modell lokal geladen', wasmOk);
  const camStatus = await page.textContent('#cam-status');
  check('Kamera: „Keine Person erkannt“ beim Testbild', /Keine Person erkannt/.test(camStatus), camStatus);
  check('Kamera: Simulation pausiert ohne Person', s.key === 'nodata', s.key);
  await page.screenshot({ path: `${OUT}desktop-kamera-testbild.png` });
  // Kamera verlieren: Track beenden
  await page.evaluate(() => window.__bib.camera.stream.getVideoTracks()[0].dispatchEvent(new Event('ended')));
  await page.waitForTimeout(500);
  const alertTxt = await page.textContent('#alert-title');
  check('Kamera: Verlust wird gemeldet, App läuft weiter', /abgebrochen/.test(alertTxt) && (await state(page)).mode === 'preview', alertTxt);
  reportLog('Kamera', log, { allowConsole: [/OpenGL error checking is disabled/i] });
  await ctx.close();
}

// --- 3. Mobil 375 px: Screenshots der Demo-Modi, kein horizontales Scrollen ---
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const log = watch(page);
  await page.goto(BASE);
  await page.waitForFunction(() => window.__bib && window.__bib.frameNo > 20);
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  check('Mobil: kein horizontales Scrollen bei 375 px', sw <= 375, `scrollWidth ${sw}`);
  await page.screenshot({ path: `${OUT}mobil-vorschau.png` });
  await page.selectOption('#sel-timescale', '180');
  await page.click('#btn-demo-still');
  await page.waitForTimeout(8000);
  await page.screenshot({ path: `${OUT}mobil-demo-still.png`, fullPage: true });
  await page.click('#btn-demo-move');
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${OUT}mobil-demo-bewegen.png` });
  await page.screenshot({ path: `${OUT}mobil-demo-bewegen-ganz.png`, fullPage: true });
  const sw2 = await page.evaluate(() => document.documentElement.scrollWidth);
  check('Mobil: auch in der Demo kein horizontales Scrollen', sw2 <= 375, `scrollWidth ${sw2}`);
  reportLog('Mobil', log);
  await ctx.close();
}

// --- 4. Dunkelmodus und reduzierte Bewegung -------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const log = watch(page);
  await page.goto(BASE);
  await page.waitForFunction(() => window.__bib && window.__bib.frameNo > 20);
  await page.click('#btn-demo-move');
  await page.waitForTimeout(3000);
  const s = await state(page);
  check('Reduzierte Bewegung: weniger Partikel', s.particles < 200, `${s.particles}`);
  await page.screenshot({ path: `${OUT}desktop-dunkel-reduziert.png` });
  reportLog('Dunkel', log);
  await ctx.close();
}
await browser.close();

// --- 5. Kamerazugriff verweigert ------------------------------------------
{
  const b = await chromium.launch(launchOpts(['--deny-permission-prompts']));
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForFunction(() => window.__bib && window.__bib.frameNo > 5);
  await page.click('#btn-camera');
  await page.waitForSelector('#alert:not([hidden])', { timeout: 15000 }).catch(() => {});
  const t = await page.textContent('#alert-title');
  check('Verweigert: verständliche Meldung', /nicht erlaubt/.test(t), t);
  await page.screenshot({ path: `${OUT}desktop-kamera-verweigert.png` });
  await b.close();
}

// --- 6. Kein HTTPS (unsicherer Kontext) -----------------------------------
{
  const b = await chromium.launch(launchOpts(['--use-fake-ui-for-media-stream', '--host-resolver-rules=MAP unsicher.example 127.0.0.1']));
  const page = await (await b.newContext()).newPage();
  await page.goto(`http://unsicher.example:${PORT}/`);
  await page.waitForFunction(() => window.__bib && window.__bib.frameNo > 5);
  await page.click('#btn-camera');
  await page.waitForSelector('#alert:not([hidden])', { timeout: 10000 }).catch(() => {});
  const t = await page.textContent('#alert-title');
  check('Ohne HTTPS: verständliche Meldung', /sichere Verbindung/.test(t), t);
  await b.close();
}

// --- 7. Optional: Video mit Person ----------------------------------------
let fixture = null;
for (const f of FIXTURE_CANDIDATES) { try { await access(f); fixture = f; break; } catch { /* nicht vorhanden */ } }
if (fixture) {
  const b = await chromium.launch(launchOpts(['--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${fixture}`]));
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['camera'] });
  const page = await ctx.newPage();
  const log = watch(page);
  await page.goto(BASE);
  await page.click('#btn-camera');
  await page.waitForFunction(() => window.__bib.mode === 'camera' && window.__bib.camera.detectMs > 0, null, { timeout: 90000 });
  const samples = await sampleWhile(page, 8, () => state(page));
  check('Video mit Person: Person erkannt', samples.some((x) => x.persons > 0), `max Personen ${Math.max(...samples.map((x) => x.persons))}`);
  await page.screenshot({ path: `${OUT}desktop-kamera-person.png` });
  reportLog('Video', log, { allowConsole: [/OpenGL error checking is disabled/i] });
  await b.close();
} else {
  console.log('ℹ Kein Personen-Video unter tests/fixtures/ – dieser Teil wird übersprungen.');
}

server.close();
console.log(`\n${results.length - failures}/${results.length} Prüfungen bestanden. Screenshots: ${OUT}`);
process.exit(failures ? 1 : 0);
