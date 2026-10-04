// Renders a scripted demo of the site to MP4, one frame at a time.
// The page clock is frozen and advanced 1/FPS per frame, so motion is smooth on any machine.
//
//   python3 -m http.server 8787 -d site      (in another terminal)
//   node tools/video/record.mjs              (FAST=1 for a quick low-res draft)
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const FAST = !!process.env.FAST;
const SITE = process.env.SITE || 'http://localhost:8787/';
const END_URL = process.env.END_URL || 'nishanthantony.dev';
const OUT = process.env.OUT || new URL(FAST ? './out/draft.mp4' : './out/portfolio-demo.mp4', import.meta.url).pathname;
const FPS = 30, VW = 1600, VH = 900;
const DSF = FAST ? 1 : 2;
const [OW, OH] = FAST ? [960, 540] : [1920, 1080];

/* ---------- injected before any page script: a controllable clock ---------- */
function fakeClock() {
  let now = 0;
  const T0 = Date.now();
  let raf = [], rafId = 0, tid = 0;
  const timers = new Map();
  window.requestAnimationFrame = (cb) => { const id = ++rafId; raf.push([id, cb]); return id; };
  window.cancelAnimationFrame = (id) => { raf = raf.filter((r) => r[0] !== id); };
  performance.now = () => now;
  Date.now = () => T0 + now;
  window.setTimeout = (cb, ms = 0, ...a) => { const id = ++tid; timers.set(id, { at: now + Math.max(0, +ms || 0), cb, a }); return id; };
  window.setInterval = (cb, ms = 0, ...a) => { const id = ++tid; const e = Math.max(1, +ms || 0); timers.set(id, { at: now + e, cb, a, every: e }); return id; };
  window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };

  const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  let tween = null;
  window.__scrollTween = (y, ms) => {
    const max = document.documentElement.scrollHeight - innerHeight;
    tween = { from: scrollY, to: Math.max(0, Math.min(max, y)), t0: now, ms };
  };
  const siv = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (o) {
    if (o && typeof o === 'object' && o.behavior === 'smooth') {
      const r = this.getBoundingClientRect();
      const m = parseFloat(getComputedStyle(this).scrollMarginTop) || 0;
      window.__scrollTween(scrollY + r.top - m, 1100);
    } else siv.call(this, o);
  };

  const seen = new WeakMap();
  window.__advance = (dt) => {
    const target = now + dt;
    for (;;) {
      let nx = null, nid = null;
      for (const [id, t] of timers) if (t.at <= target && (!nx || t.at < nx.at)) { nx = t; nid = id; }
      if (!nx) break;
      now = Math.max(now, nx.at);
      if (nx.every) nx.at += nx.every; else timers.delete(nid);
      try { typeof nx.cb === 'function' ? nx.cb(...nx.a) : (0, eval)(nx.cb); } catch (e) { console.error(e); }
    }
    now = target;
    if (tween) {
      const p = Math.min(1, (now - tween.t0) / tween.ms);
      window.scrollTo({ top: tween.from + (tween.to - tween.from) * ease(p), behavior: 'instant' });
      if (p >= 1) tween = null;
    }
    const q = raf; raf = [];
    for (const [, cb] of q) { try { cb(now); } catch (e) { console.error(e); } }
    for (const a of document.getAnimations()) {
      if (!seen.has(a)) { seen.set(a, now); try { a.pause(); } catch (e) {} }
      try { a.currentTime = now - seen.get(a); } catch (e) {}
    }
  };
}

/* ---------- overlay: cursor, click ring (page space) + captions, end card (screen space) ---------- */
const HUD_CSS = `
html { scroll-behavior: auto !important; }
#__cur { position: fixed; left: 0; top: 0; width: 30px; height: 30px; z-index: 2147483647; pointer-events: none; }
#__rip { position: fixed; left: 0; top: 0; width: 40px; height: 40px; border: 3px solid #FF5F00; z-index: 2147483646; pointer-events: none; opacity: 0; }
#__hud { position: fixed; left: 0; top: 0; width: ${VW}px; height: ${VH}px; transform-origin: 0 0; z-index: 2147483645; pointer-events: none; }
#__cap { position: absolute; left: 44px; bottom: 44px; display: flex; font: 500 24px/1 var(--font-mono); color: #F4F1EA; background: #111110; border: 2px solid #F4F1EA; box-shadow: 7px 7px 0 #FF5F00; opacity: 0; }
#__cap b { background: #FF5F00; color: #111110; padding: 14px 16px; border-right: 2px solid #F4F1EA; font-weight: 700; }
#__cap span { padding: 14px 18px; white-space: nowrap; }
#__end { position: absolute; inset: 0; background: #111110; color: #F4F1EA; display: flex; flex-direction: column; justify-content: center; padding: 0 150px; opacity: 0; }
#__end .k { font: 500 22px var(--font-mono); letter-spacing: .12em; text-transform: uppercase; color: #9a968b; }
#__end h1 { font: 400 150px/0.92 var(--font-serif); letter-spacing: -0.02em; margin-top: 18px; }
#__end h1 em { color: #FF5F00; }
#__end p { font: 400 28px/1.5 var(--font-mono); margin-top: 30px; color: #cfcbbf; max-width: 1100px; }
#__end .u { align-self: flex-start; margin-top: 46px; font: 700 34px var(--font-mono); background: #FF5F00; color: #111110; padding: 14px 22px; border: 2px solid #F4F1EA; box-shadow: 9px 9px 0 #F4F1EA; }
`;

function injectHud(endUrl) {
  const cur = document.createElement('div');
  cur.id = '__cur';
  cur.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M3 2L3 19L7.5 14.8L10.4 21.4L13.3 20.1L10.5 13.7L16.6 13.5Z" fill="#fff" stroke="#111110" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const rip = document.createElement('div'); rip.id = '__rip';
  const hud = document.createElement('div'); hud.id = '__hud';
  hud.innerHTML = `<div id="__cap"><b></b><span></span></div>
    <div id="__end"><span class="k">nishanth-lab shell 1.0</span><h1>Nishanth <em>Antony</em>.</h1>
    <p>AI/ML engineer in Bengaluru. Building AI that has to work on Monday, and learning whatever stack the problem needs.</p>
    <span class="u">${endUrl}</span></div>`;
  document.body.append(cur, rip, hud);
  const cap = hud.querySelector('#__cap'), end = hud.querySelector('#__end');
  let capKey = '';
  window.__frame = (s) => {
    cur.style.transform = `translate(${s.mx - 3.75}px, ${s.my - 2.5}px)`;
    if (s.rp >= 0) {
      rip.style.opacity = String(1 - s.rp);
      rip.style.transform = `translate(${s.rx - 20}px, ${s.ry - 20}px) scale(${0.35 + s.rp * 1.15})`;
    } else rip.style.opacity = '0';
    hud.style.transform = `translate(${s.cl}px, ${s.ct}px) scale(${1 / s.z})`;
    if (s.capKey !== capKey) { capKey = s.capKey; const [n, t] = s.capKey.split('|'); cap.children[0].textContent = n || ''; cap.children[1].textContent = t || ''; }
    cap.style.opacity = String(s.co);
    cap.style.transform = `translateY(${(1 - s.co) * 18}px)`;
    end.style.opacity = String(s.eo);
    cur.style.opacity = String(1 - s.eo);
    window.__advance(s.dt);
  };
}

/* ---------- director ---------- */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeIO = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const easeOut = (p) => 1 - Math.pow(1 - p, 3);

mkdirSync(dirname(OUT), { recursive: true });
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
  '-c:v', 'libx264', '-preset', FAST ? 'veryfast' : 'slow', '-crf', FAST ? '26' : '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT],
  { stdio: ['pipe', 'inherit', 'inherit'] });

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new', defaultViewport: null,
  args: ['--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none'],
});
const page = await browser.newPage();
const cdp = await page.createCDPSession();
await cdp.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: DSF, mobile: false });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'no-preference' }]);
await page.evaluateOnNewDocument(fakeClock);
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(SITE, { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);
await page.addStyleTag({ content: HUD_CSS });
await page.evaluate(injectHud, END_URL);

const st = { mx: VW + 60, my: VH * 0.8, z: 1, cx: VW / 2, cy: VH / 2, co: 0, eo: 0, capKey: '', rp: -1, rx: 0, ry: 0 };
let tweens = [], f = 0, ripF = -1, lastMouse = '';

function tw(to, sec, ease = easeIO) {
  const from = {}; for (const k in to) from[k] = st[k];
  tweens = tweens.filter((t) => !Object.keys(to).some((k) => k in t.to));
  tweens.push({ from, to, f0: f, n: Math.max(1, Math.round(sec * FPS)), ease });
}

async function frame(speed = 1) {
  for (const t of tweens) {
    const e = t.ease(clamp((f - t.f0 + 1) / t.n, 0, 1));
    for (const k in t.to) st[k] = t.from[k] + (t.to[k] - t.from[k]) * e;
  }
  tweens = tweens.filter((t) => f - t.f0 + 1 < t.n);
  st.rp = ripF >= 0 && f - ripF < 14 ? (f - ripF) / 14 : -1;

  const w = VW / st.z, h = VH / st.z;
  const cl = clamp(st.cx - w / 2, 0, VW - w), ct = clamp(st.cy - h / 2, 0, VH - h);
  await page.evaluate((s) => window.__frame(s), { ...st, cl, ct, dt: (1000 / FPS) * speed });
  const mk = `${Math.round(st.mx)},${Math.round(st.my)}`;
  if (mk !== lastMouse) { lastMouse = mk; await page.mouse.move(clamp(st.mx, 0, VW - 1), clamp(st.my, 0, VH - 1)); }

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 95 });
  const shot = sharp(Buffer.from(data, 'base64'));
  const { width: IW, height: IH } = await shot.metadata();
  const sx = IW / VW, sy = IH / VH;
  const W = Math.min(IW, Math.round(w * sx)), H = Math.min(IH, Math.round(h * sy));
  const img = await shot
    .extract({ left: clamp(Math.round(cl * sx), 0, IW - W), top: clamp(Math.round(ct * sy), 0, IH - H), width: W, height: H })
    .resize(OW, OH, { kernel: 'lanczos3' }).jpeg({ quality: 94 }).toBuffer();
  if (!ff.stdin.write(img)) await new Promise((r) => ff.stdin.once('drain', r));
  f++;
  if (f % 60 === 0) process.stdout.write(`  ${f} frames (${(f / FPS).toFixed(1)}s)\n`);
}
const wait = async (sec, speed = 1) => { for (let i = Math.round(sec * FPS); i > 0; i--) await frame(speed); };

const rect = (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
const center = (r) => ({ mx: r.x + r.width / 2, my: r.y + r.height / 2 });
const fit = (r, pad = 40, zmax = 1.6) => ({
  z: clamp(Math.min(VW / (r.width + 2 * pad), VH / (r.height + 2 * pad)), 1, zmax),
  cx: r.x + r.width / 2, cy: r.y + r.height / 2,
});
const wide = () => ({ z: 1, cx: VW / 2, cy: VH / 2 });
async function caption(n, text) {
  if (st.co > 0) { tw({ co: 0 }, 0.18); await wait(0.2); }
  st.capKey = `${n}|${text}`;
  tw({ co: 1 }, 0.35, easeOut);
}
async function click() { ripF = f; await page.mouse.click(st.mx, st.my); }
let seed = 7;
const jitter = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
async function type(text) {
  for (const ch of text) { await page.keyboard.type(ch); await wait((2 + Math.round(jitter() * 2)) / FPS); }
}
async function enter() { await page.keyboard.press('Enter'); }
async function scrollToEl(sel, offset, sec) {
  const r = await rect(sel);
  await page.evaluate((y, ms) => window.__scrollTween(scrollY + y, ms), r.y - offset, sec * 1000);
}

/* ---------- the storyboard ---------- */
console.log(`rendering ${OW}x${OH} @ ${FPS}fps -> ${OUT}`);

// boot log, in slow motion, camera easing out
const boot = await page.evaluate(() => {
  let x0 = Infinity, y0 = Infinity, x1 = 0, y1 = 0;
  for (const ln of document.querySelectorAll('#boot .boot__ln')) {
    const rg = document.createRange(); rg.selectNodeContents(ln);
    for (const r of rg.getClientRects()) { x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); }
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
});
Object.assign(st, fit(boot, 60, 2.2));
tw({ z: Math.max(1.2, st.z * 0.82) }, 2.7);
await wait(2.7, 0.62);

// hero
tw(wide(), 1.3);
await caption('01', 'a portfolio that is also a shell');
const inp = await rect('#term-input');
tw({ mx: inp.x + 60, my: inp.y + inp.height / 2 }, 1.4);
await wait(1.6);

// the terminal
tw(fit(await rect('#term'), 36, 1.62), 1.0);
await wait(0.7);
await click();
await wait(0.4);
await caption('02', 'it actually runs commands');
await type('whoami'); await wait(0.25); await enter();
await wait(2.3);
await type('ls projects'); await wait(0.2); await enter();
await wait(2.1);

// open a project from the shell
await caption('03', 'one command, any project');
await type('open samudra'); await wait(0.3); await enter();
tw(wide(), 0.9);
await wait(1.5);
await scrollToEl('#p-samudra .diagram', 230, 1.0);
await wait(1.1);
const sfig = await rect('#p-samudra .diagram__fig');
tw(fit(sfig, 30, 1.6), 1.0);
tw({ mx: sfig.x + sfig.width + 40, my: sfig.y + sfig.height + 30 }, 1.2);
await wait(2.6);

// click a pipeline open by hand
tw(wide(), 0.8);
await caption('04', 'every project shows its pipeline');
await scrollToEl('#p-payrecover .diagram', 420, 1.5);
await wait(1.6);
tw(center(await rect('#p-payrecover .diagram summary')), 0.9);
await wait(1.1);
await click();
await wait(0.5);
tw(fit(await rect('#p-payrecover .diagram__fig'), 30, 1.6), 1.0);
tw({ mx: st.mx + 170, my: st.my + 6 }, 1.4);
await wait(2.8);

// numbers: pan across the row to the grader
await caption('05', 'every claim has a number');
const m = await rect('#p-grader .metrics');
tw(fit(m, 50, 1.7), 1.3);
tw(center(await rect('#p-grader .metric--hot dd')), 1.3);
await wait(2.6);

// theme switch
tw(wide(), 0.8);
await caption('06', 'paper or ink');
tw(center(await rect('#theme-switch')), 1.1);
await wait(1.2);
await click();
await wait(1.6);

// end card
tw({ co: 0 }, 0.3);
tw({ eo: 1 }, 0.7);
await wait(3.6);

ff.stdin.end();
await new Promise((r) => ff.on('close', r));
await browser.close();
console.log(`done: ${f} frames, ${(f / FPS).toFixed(1)}s -> ${OUT}`);
