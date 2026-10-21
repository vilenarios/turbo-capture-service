/**
 * Integration tests with real Chrome against local fixture pages.
 *
 * Run inside the built image (docker build --target test); skipped when the
 * Chrome binary is not installed. Fake host names under .public.test resolve,
 * through a test-only resolver, to addresses classed as public, and the
 * test-only dialer routes those to the fixture server on 127.0.0.1. The
 * "trap" server on 127.0.0.1 must never see a connection.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { listChromeProcesses, CHROME_PATH } from '../src/capture.js';
import { fakeNet, startTrap, listen, close } from './helpers/net.js';
import { testConfig, startApp, silentLog, pngSize } from './helpers/app.js';

const haveChrome = CHROME_PATH !== '' && fs.existsSync(CHROME_PATH);
const itest = haveChrome ? test : test.skip;

let fixture;
let P; // fixture port
let trap;
const fixtureLog = [];
let sandboxProbe = null;

function page(html, title = 'Fixture') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${html}</body></html>`;
}

before(async () => {
  trap = await startTrap();
  fixture = http.createServer((req, res) => {
    fixtureLog.push({ host: req.headers.host, url: req.url, ua: req.headers['user-agent'] });
    const T = trap.port;
    const send = (body, type = 'text/html') => {
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    const u = new URL(req.url, 'http://x');
    switch (u.pathname) {
      case '/normal':
        return send(page(`<h1 style="height:300px;background:#c00">Hello</h1><img src="/img.svg"><iframe src="http://other.public.test:${P}/frame"></iframe>`, 'Normal Page'));
      case '/img.svg':
        return send('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>', 'image/svg+xml');
      case '/frame':
        return send(page('<p>frame</p>'));
      case '/attack': {
        const targets = [`127.0.0.1:${T}`, `localhost:${T}`, `foo.localhost:${T}`, `0x7f.1:${T}`, `2130706433:${T}`, `[::ffff:127.0.0.1]:${T}`, `mixed.public.test:${P}`];
        const tags = targets
          .map((t) => `<img src="http://${t}/img"><iframe src="http://${t}/frame"></iframe><link rel="stylesheet" href="http://${t}/css"><script src="https://${t}/js"></script>`)
          .join('');
        const js = `
          const T = ${JSON.stringify(targets)};
          const tries = [];
          for (const t of T) {
            tries.push(fetch('http://' + t + '/fetch', { mode: 'no-cors' }).catch(() => {}));
            tries.push(new Promise((r) => { try { const x = new XMLHttpRequest(); x.open('GET', 'http://' + t + '/xhr'); x.onloadend = r; x.send(); } catch { r(); } }));
            tries.push(new Promise((r) => { try { const w = new WebSocket('ws://' + t + '/ws'); w.onerror = w.onclose = w.onopen = r; } catch { r(); } setTimeout(r, 3000); }));
            tries.push(new Promise((r) => { try { const w = new WebSocket('wss://' + t + '/ws'); w.onerror = w.onclose = w.onopen = r; } catch { r(); } setTimeout(r, 3000); }));
            try { navigator.sendBeacon('http://' + t + '/beacon', 'x'); } catch {}
          }
          try {
            const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${T}' }, { urls: 'turn:127.0.0.1:${T}?transport=tcp', username: 'u', credential: 'c' }] });
            pc.createDataChannel('x'); pc.createOffer().then((o) => pc.setLocalDescription(o));
          } catch {}
          Promise.all(tries).then(() => fetch('/attack-done'));
        `;
        return send(page(`${tags}<script>${js}</script>`, 'Attack'));
      }
      case '/attack-done':
        return send('ok', 'text/plain');
      case '/redirect-loopback':
        res.writeHead(302, { location: `http://127.0.0.1:${T}/pwned` });
        return res.end();
      case '/redirect-chain':
        res.writeHead(302, { location: `http://hop.public.test:${P}/redirect-loopback` });
        return res.end();
      case '/redirect-https-loopback':
        res.writeHead(302, { location: `https://127.0.0.1:${T}/pwned` });
        return res.end();
      case '/js-redirect':
        return send(page(`<script>setTimeout(() => { location.href = 'http://localhost:${T}/pwned'; }, 50)</script>`));
      case '/infinite':
        return send(
          page(
            `<div id="c"></div><script>
              let n = 0; const c = document.getElementById('c');
              function more() { for (let i = 0; i < 20; i++) { const d = document.createElement('div'); d.style.height = '200px'; d.textContent = 'item ' + (n++); c.appendChild(d); } }
              more();
              addEventListener('scroll', () => { if (innerHeight + scrollY > document.body.scrollHeight - 800) more(); });
            </script>`,
            'Infinite',
          ),
        );
      case '/noise':
        // Incompressible content: random pixels on a tall canvas.
        return send(
          page(
            `<canvas id="c" width="1000" height="6000"></canvas><script>
              const c = document.getElementById('c').getContext('2d');
              const img = c.createImageData(1000, 6000);
              for (let i = 0; i < img.data.length; i += 65536) crypto.getRandomValues(img.data.subarray(i, i + 65536));
              for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
              c.putImageData(img, 0, 0);
            </script><style>body{margin:0}</style>`,
            'Noise',
          ),
        );
      case '/tall':
        return send(page('<div style="height:50000px;background:linear-gradient(red,blue)"></div>', 'Tall'));
      case '/hang':
        return send(page(`<p>hang</p><script>setTimeout(() => { for (;;) {} }, 100)</script>`, 'Hang'));
      case '/slow':
        // Keeps the navigation pending (headers sent, body never finishes).
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<!doctype html><title>slow</title><p>');
        return; // never ends; the server is closed in after()
      case '/stealth':
        return send(
          page(
            `<script>document.title = 'wd=' + navigator.webdriver + ';hl=' + /Headless/.test(navigator.userAgent);</script>`,
            'pending',
          ),
        );
      case '/sandbox-probe':
        // While Chrome is rendering this page, look at its processes.
        sandboxProbe = probeSandbox();
        return send(page('<p>probe</p>', 'Probe'));
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  P = await listen(fixture);
});

after(async () => {
  await trap.close();
  await close(fixture);
});

function probeSandbox() {
  const mine = fs.readlinkSync('/proc/self/ns/user');
  const out = [];
  for (const p of listChromeProcesses()) {
    try {
      const cmd = fs.readFileSync(`/proc/${p.pid}/cmdline`, 'latin1');
      const type = /--type=([a-z-]+)/.exec(cmd)?.[1] ?? 'browser';
      out.push({ type, userns: fs.readlinkSync(`/proc/${p.pid}/ns/user`), pidns: fs.readlinkSync(`/proc/${p.pid}/ns/pid`) });
    } catch {
      // raced with exit
    }
  }
  return { mine, mypid: fs.readlinkSync('/proc/self/ns/pid'), procs: out };
}

async function withService(overrides, fn) {
  const net = fakeNet({ fixturePort: P });
  const cfg = testConfig({ rateLimitPerMinute: 1000, allowedPorts: null, ...overrides });
  const app = await createApp(cfg, { log: silentLog, net });
  const s = await startApp(app);
  try {
    return await fn(s.url, net, app);
  } finally {
    await s.close();
  }
}

const shoot = (base, body) =>
  fetch(`${base}/screenshot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function waitForNoChrome(ms = 5_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (listChromeProcesses().length === 0) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return listChromeProcesses().length === 0;
}

itest('a normal page renders and returns a PNG (subresources and cross-site iframe load via the proxy)', async () => {
  await withService({}, async (base, net) => {
    const before = fixtureLog.length;
    const r = await shoot(base, { url: `http://site.public.test:${P}/normal`, waitFor: 200, viewportWidth: 800, viewportHeight: 600 });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.title, 'Normal Page');
    assert.equal(j.finalUrl, `http://site.public.test:${P}/normal`);
    const png = Buffer.from(j.screenshot, 'base64');
    assert.equal(png.length, j.size);
    const dim = pngSize(png);
    assert.equal(dim.width, 800);
    assert.equal(dim.height, 600);
    const seen = fixtureLog.slice(before).map((h) => `${h.host}${h.url}`);
    assert.ok(seen.includes(`site.public.test:${P}/img.svg`), 'image loaded through proxy');
    assert.ok(seen.includes(`other.public.test:${P}/frame`), 'cross-site iframe loaded through proxy');
    assert.ok(net.dials.every((d) => d.ip === '11.22.33.44' || d.ip === '11.22.33.45'), 'only validated IPs were dialled');
    assert.ok(await waitForNoChrome(), 'chrome exited');
  });
});

itest('img/iframe/css/script/fetch/XHR/WebSocket/beacon/WebRTC to loopback never reach the trap', async () => {
  await withService({}, async (base, net) => {
    const before = fixtureLog.length;
    const r = await shoot(base, { url: `http://site.public.test:${P}/attack`, waitFor: 4000, fullPage: false });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    // Give stragglers a moment, then check.
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(trap.hits.length, 0, `trap saw: ${JSON.stringify(trap.hits).slice(0, 300)}`);
    const seen = fixtureLog.slice(before);
    assert.ok(seen.some((h) => h.url === '/attack-done'), 'attack script ran to completion');
    assert.ok(!seen.some((h) => h.host?.startsWith('mixed.public.test')), 'host with mixed public/private DNS answer was refused');
    assert.ok(!net.dials.some((d) => d.ip !== '11.22.33.44' && d.ip !== '11.22.33.45'));
  });
});

for (const [name, path] of [
  ['HTTP redirect to loopback', '/redirect-loopback'],
  ['redirect chain ending at loopback', '/redirect-chain'],
  ['redirect to https://loopback (CONNECT)', '/redirect-https-loopback'],
  ['JavaScript navigation to localhost after load', '/js-redirect'],
]) {
  itest(`top-level ${name} is refused deterministically`, async () => {
    await withService({}, async (base) => {
      const r = await shoot(base, { url: `http://site.public.test:${P}${path}`, waitFor: 1000 });
      const j = await r.json();
      assert.equal(r.status, 400, JSON.stringify(j));
      assert.equal(j.error, 'Forbidden URL');
      assert.equal(j.message, 'The page redirected to a forbidden destination');
      assert.ok(j.requestId);
      assert.equal(trap.hits.length, 0);
    });
  });
}

itest('an infinite-scroll page finishes within the deadline', async () => {
  await withService({ captureTimeoutMs: 30_000, scrollMaxMs: 3_000, scrollMaxSteps: 1000 }, async (base) => {
    const t0 = Date.now();
    const r = await shoot(base, { url: `http://site.public.test:${P}/infinite`, waitFor: 0 });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.ok(Date.now() - t0 < 20_000, `took ${Date.now() - t0} ms`);
    assert.ok(j.height <= 16_384);
  });
});

itest('a very tall page is clipped to MAX_SCREENSHOT_HEIGHT', async () => {
  await withService({ maxScreenshotHeight: 3000 }, async (base) => {
    const r = await shoot(base, { url: `http://site.public.test:${P}/tall`, waitFor: 0, viewportWidth: 640, viewportHeight: 480 });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.clipped, true);
    assert.equal(j.height, 3000);
    assert.deepEqual(pngSize(Buffer.from(j.screenshot, 'base64')), { width: 640, height: 3000 });
  });
});

itest('fullPage=false captures the viewport only', async () => {
  await withService({}, async (base) => {
    const r = await shoot(base, { url: `http://site.public.test:${P}/tall`, waitFor: 0, viewportWidth: 500, viewportHeight: 400, fullPage: false });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.clipped, false);
    assert.deepEqual(pngSize(Buffer.from(j.screenshot, 'base64')), { width: 500, height: 400 });
  });
});

for (const [name, path, mustTimeOut] of [
  ['page whose JavaScript never yields', '/hang', true],
  ['page whose response never finishes', '/slow', false],
]) {
  itest(`deadline: ${name} is bounded by CAPTURE_TIMEOUT_MS and leaves no Chrome processes`, async () => {
    await withService({ captureTimeoutMs: 8_000, navigationTimeoutMs: 30_000 }, async (base) => {
      const t0 = Date.now();
      const r = await shoot(base, { url: `http://site.public.test:${P}${path}`, waitFor: 30_000 });
      const j = await r.json();
      const took = Date.now() - t0;
      if (mustTimeOut) {
        assert.equal(r.status, 504, JSON.stringify(j));
        assert.equal(j.error, 'Capture timed out');
      } else {
        // The document committed, so a partial render may legitimately be returned.
        assert.ok(r.status === 504 || r.status === 200, `status ${r.status} ${JSON.stringify(j)}`);
      }
      assert.ok(took < 15_000, `took ${took} ms`);
      assert.ok(await waitForNoChrome(), `chrome left behind: ${JSON.stringify(listChromeProcesses())}`);
    });
  });
}

itest('client disconnect (raw socket) aborts the capture and kills Chrome', async () => {
  await withService({ captureTimeoutMs: 60_000 }, async (base, net, app) => {
    const u = new URL(base);
    const req = http.request({ host: u.hostname, port: u.port, method: 'POST', path: '/screenshot', headers: { 'content-type': 'application/json' } });
    req.on('error', () => {});
    req.end(JSON.stringify({ url: `http://site.public.test:${P}/slow`, waitFor: 30_000 }));
    const until = Date.now() + 10_000;
    while (listChromeProcesses().length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    assert.ok(listChromeProcesses().length > 0, 'chrome started');
    req.destroy();
    assert.ok(await waitForNoChrome(8_000), 'chrome killed after client went away');
    const until2 = Date.now() + 5_000;
    while (app.locals.gate.active > 0 && Date.now() < until2) await new Promise((r) => setTimeout(r, 50));
    assert.equal(app.locals.gate.active, 0, 'slot released');
  });
});

itest('concurrency cap with real captures: saturated service answers 503', async () => {
  await withService({ maxConcurrentCaptures: 1, maxQueue: 0, captureTimeoutMs: 10_000 }, async (base, net, app) => {
    const first = shoot(base, { url: `http://site.public.test:${P}/slow`, waitFor: 0 });
    const until = Date.now() + 5_000;
    while (app.locals.gate.active === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    const second = await shoot(base, { url: `http://site.public.test:${P}/normal`, waitFor: 0 });
    assert.equal(second.status, 503);
    assert.equal(second.headers.get('retry-after'), '10');
    await (await first).json();
    assert.ok(await waitForNoChrome());
  });
});

itest('stealth: navigator.webdriver is hidden and the UA does not say Headless', async () => {
  await withService({}, async (base) => {
    const before = fixtureLog.length;
    const r = await shoot(base, { url: `http://site.public.test:${P}/stealth`, waitFor: 0, fullPage: false });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.title, 'wd=false;hl=false');
    const hit = fixtureLog.slice(before).find((h) => h.url === '/stealth');
    assert.doesNotMatch(hit.ua, /Headless/);
  });
});

itest('Chrome sandbox is active when CHROME_SANDBOX=true (renderers in their own user + pid namespaces)', async (t) => {
  if (process.env.CHROME_SANDBOX === 'false') return t.skip('sandbox disabled for this run');
  await withService({}, async (base) => {
    sandboxProbe = null;
    const r = await shoot(base, { url: `http://site.public.test:${P}/sandbox-probe`, waitFor: 0, fullPage: false });
    assert.equal(r.status, 200);
    assert.ok(sandboxProbe, 'probe ran');
    const renderers = sandboxProbe.procs.filter((p) => p.type === 'renderer');
    assert.ok(renderers.length > 0, JSON.stringify(sandboxProbe));
    for (const p of renderers) {
      assert.notEqual(p.userns, sandboxProbe.mine, 'renderer in a separate user namespace');
      assert.notEqual(p.pidns, sandboxProbe.mypid, 'renderer in a separate pid namespace');
    }
  });
});

itest('pixel budget: a tall page is clipped to MAX_SCREENSHOT_PIXELS / width', async () => {
  await withService({ maxScreenshotPixels: 2_000_000 }, async (base) => {
    const r = await shoot(base, { url: `http://site.public.test:${P}/noise`, waitFor: 0, viewportWidth: 1000, viewportHeight: 600 });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j).slice(0, 200));
    assert.equal(j.clipped, true);
    assert.equal(j.height, 2000);
    assert.deepEqual(pngSize(Buffer.from(j.screenshot, 'base64')), { width: 1000, height: 2000 });
  });
});

itest('PNG byte cap: an incompressible screenshot over MAX_PNG_BYTES gets 422', async () => {
  await withService({ maxPngBytes: 500_000 }, async (base) => {
    const r = await shoot(base, { url: `http://site.public.test:${P}/noise`, waitFor: 0, viewportWidth: 1000, viewportHeight: 600 });
    const j = await r.json();
    assert.equal(r.status, 422, JSON.stringify(j).slice(0, 200));
    assert.equal(j.error, 'Screenshot too large');
    assert.ok(await waitForNoChrome());
  });
});
