/**
 * One screenshot capture: a fresh Chrome per request, every request it makes
 * forced through a per-capture egress proxy, and the whole thing bounded by a
 * hard deadline.
 */

import fs from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteerVanilla from 'puppeteer';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { startEgressProxy, BLOCKED_HEADER } from './egress-proxy.js';

const puppeteer = puppeteerExtra.addExtra(puppeteerVanilla);
puppeteer.use(StealthPlugin());

/** Absolute path of the bundled Chrome binary ('' when not installed). */
export const CHROME_PATH = await Promise.resolve()
  .then(() => puppeteerVanilla.executablePath())
  .catch(() => '');

export class CaptureError extends Error {
  /**
   * @param {'TIMEOUT'|'FORBIDDEN_DESTINATION'|'NAVIGATION_FAILED'|'ABORTED'|'INTERNAL'} code
   */
  constructor(code, message, cause) {
    super(message, { cause });
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * Environment for Chrome: HOME and XDG dirs point into the per-launch temp
 * profile, so Chrome (NSS db, fontconfig cache, crashpad) only ever writes
 * under /tmp. This is what lets the container run with a read-only root.
 */
function chromeEnv(dir) {
  return { ...process.env, HOME: dir, XDG_CONFIG_HOME: path.join(dir, '.config'), XDG_CACHE_HOME: path.join(dir, '.cache') };
}

/** Chrome flags shared by captures and the start-up self-test. */
export function chromeArgs({ proxyPort, sandbox }) {
  const args = [
    // All traffic, including loopback, goes through the egress proxy.
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    '--proxy-bypass-list=<-loopback>',
    // Chrome never needs to resolve names itself; anything that tried to
    // bypass the proxy would get NXDOMAIN.
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
    '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--dns-prefetch-disable',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-sync',
    '--no-pings',
    '--no-first-run',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--disable-dev-shm-usage',
    '--deny-permission-prompts',
  ];
  if (!sandbox) args.push('--no-sandbox', '--disable-setuid-sandbox');
  return args;
}

function chromeProcessPids(executablePath) {
  const pids = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = readFileSync(`/proc/${d}/cmdline`, 'latin1');
      if ((executablePath !== '' && cmd.startsWith(executablePath)) || cmd.includes('/chrome-linux64/chrome')) {
        const stat = readFileSync(`/proc/${d}/stat`, 'latin1');
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        pids.push({ pid: Number(d), ppid });
      }
    } catch {
      // process exited while we looked
    }
  }
  return pids;
}

/** List live Chrome processes (used by tests and the orphan reaper). */
export function listChromeProcesses() {
  return chromeProcessPids(CHROME_PATH);
}

/**
 * Kill Chrome processes that are no longer descendants of this Node process
 * (re-parented to init after their browser died). Browsers we launched are
 * always closed by capture() itself; this is the safety net.
 */
export function reapOrphanChrome() {
  const procs = listChromeProcesses();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  let killed = 0;
  for (const p of procs) {
    let cur = p;
    let ours = false;
    for (let i = 0; i < 32 && cur; i++) {
      if (cur.ppid === process.pid) {
        ours = true;
        break;
      }
      cur = byPid.get(cur.ppid);
    }
    if (!ours) {
      try {
        process.kill(p.pid, 'SIGKILL');
        killed++;
      } catch {
        // already gone
      }
    }
  }
  return killed;
}

async function closeBrowser(browser, log) {
  if (!browser) return;
  const proc = browser.process();
  try {
    await Promise.race([browser.close(), sleep(5_000).then(() => Promise.reject(new Error('close timeout')))]);
  } catch (err) {
    log.warn('browser close failed, killing', { err: err.message });
  }
  if (proc?.pid) {
    // Puppeteer starts Chrome in its own process group: kill the whole group
    // so no renderer/utility process survives.
    for (const target of [-proc.pid, proc.pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

/**
 * Launch Chrome once with the production flags and open a blank page, to fail
 * fast at start-up when the sandbox or Chrome itself cannot work.
 */
export async function selfTest(config) {
  const proxy = await startEgressProxy({ allowedPorts: config.allowedPorts });
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-selftest-'));
  let browser;
  try {
    browser = await puppeteerVanilla.launch({
      headless: true,
      pipe: true,
      userDataDir,
      args: chromeArgs({ proxyPort: proxy.port, sandbox: config.chromeSandbox }),
      env: chromeEnv(userDataDir),
      timeout: 30_000,
    });
    const page = await browser.newPage();
    await page.goto('about:blank');
    return await browser.version();
  } finally {
    await closeBrowser(browser, { warn: () => {} });
    await proxy.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
}

function hostPortOf(u) {
  try {
    const x = new URL(u);
    const port = x.port ? Number(x.port) : x.protocol === 'https:' || x.protocol === 'wss:' ? 443 : 80;
    return `${x.hostname.replace(/^\[|\]$/g, '').toLowerCase()}:${port}`;
  } catch {
    return null;
  }
}

/**
 * @param {{url: string, waitFor: number, viewportWidth: number, viewportHeight: number, fullPage: boolean}} params
 * @param {object} ctx
 * @param {object} ctx.config loaded config
 * @param {AbortSignal} ctx.signal aborted when the client disconnects
 * @param {object} ctx.log logger with info/warn/error(msg, fields)
 * @param {object} [ctx.net] { lookup, dial } overrides (tests only)
 */
export async function capture(params, ctx) {
  const { config, signal, log } = ctx;
  const started = Date.now();
  const deadline = started + config.captureTimeoutMs;
  const remaining = () => deadline - Date.now();

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new CaptureError('TIMEOUT', 'Capture deadline exceeded')), config.captureTimeoutMs);
  const onClientAbort = () => ac.abort(new CaptureError('ABORTED', 'Client disconnected'));
  if (signal?.aborted) onClientAbort();
  signal?.addEventListener('abort', onClientAbort, { once: true });

  let rejectAbort;
  const aborted = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  aborted.catch(() => {});
  let browser;
  let launching = null;
  ac.signal.addEventListener(
    'abort',
    () => {
      rejectAbort(ac.signal.reason);
      // Kill Chrome immediately so in-flight CDP calls fail fast.
      const proc = browser?.process();
      if (proc?.pid) {
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch {
          // gone
        }
      }
    },
    { once: true },
  );
  const step = (p) => {
    if (ac.signal.aborted) return Promise.reject(ac.signal.reason);
    return Promise.race([p, aborted]);
  };

  const proxy = await startEgressProxy({
    lookup: ctx.net?.lookup,
    dial: ctx.net?.dial,
    allowedPorts: config.allowedPorts,
    extraDeny: config.extraDeny,
    maxBytes: config.maxEgressBytes,
    onEvent: (e) => log.info('egress', e),
  });
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-'));
  const mainFrameNavs = [];

  try {
    launching = puppeteer.launch({
      headless: true,
      pipe: true,
      userDataDir,
      args: chromeArgs({ proxyPort: proxy.port, sandbox: config.chromeSandbox }),
      env: chromeEnv(userDataDir),
      timeout: Math.max(1_000, Math.min(30_000, remaining())),
      protocolTimeout: config.captureTimeoutMs,
      downloadBehavior: { policy: 'deny' },
    });
    browser = await step(launching);
    launching = null;

    const page = await step(browser.newPage());
    await step(page.authenticate({ username: proxy.username, password: proxy.password }));
    await step(page.setBypassServiceWorker(true));
    await step(page.setViewport({ width: params.viewportWidth, height: params.viewportHeight }));
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('request', (r) => {
      try {
        if (r.isNavigationRequest() && r.frame() === page.mainFrame()) mainFrameNavs.push(r.url());
      } catch {
        // frame detached
      }
    });

    const forbiddenNavigation = () => {
      const urls = [...mainFrameNavs, page.url()];
      return urls.some((u) => {
        const hp = hostPortOf(u);
        return hp !== null && proxy.blocked.has(hp);
      });
    };

    let response = null;
    try {
      response = await step(
        page.goto(params.url, {
          waitUntil: 'networkidle2',
          timeout: Math.max(1_000, Math.min(config.navigationTimeoutMs, remaining() - 5_000)),
        }),
      );
    } catch (err) {
      if (ac.signal.aborted) throw ac.signal.reason;
      if (forbiddenNavigation()) throw new CaptureError('FORBIDDEN_DESTINATION', 'The page redirected to a forbidden destination', err);
      // A page that never goes network-idle is still worth capturing once
      // its document has committed.
      const committed = /^https?:/.test(page.url());
      if (!(err?.name === 'TimeoutError' && committed)) {
        throw new CaptureError('NAVIGATION_FAILED', 'Failed to load the page', err);
      }
      log.warn('navigation did not reach network idle; capturing anyway', { err: err.message });
    }
    if (forbiddenNavigation() || response?.headers()?.[BLOCKED_HEADER] === '1') {
      throw new CaptureError('FORBIDDEN_DESTINATION', 'The page redirected to a forbidden destination');
    }

    // Extra settle time, clamped so the screenshot still fits in the deadline.
    await step(sleep(Math.min(params.waitFor, remaining() - 10_000)));

    if (params.fullPage && config.scrollMaxSteps > 0) {
      // Scroll to trigger lazy content; bounded by steps and time so an
      // infinite-scroll page cannot hold the capture.
      const scrollUntil = Date.now() + Math.min(config.scrollMaxMs, Math.max(0, remaining() - 8_000));
      for (let i = 0; i < config.scrollMaxSteps && Date.now() < scrollUntil; i++) {
        const atBottom = await step(
          page.evaluate((d) => {
            window.scrollBy(0, d);
            const el = document.scrollingElement || document.documentElement;
            return window.innerHeight + window.scrollY >= el.scrollHeight - 2;
          }, params.viewportHeight),
        );
        if (atBottom) break;
        await step(sleep(150));
      }
      await step(page.evaluate(() => window.scrollTo(0, 0)));
      await step(sleep(Math.min(500, remaining() - 5_000)));
    }

    if (forbiddenNavigation()) {
      throw new CaptureError('FORBIDDEN_DESTINATION', 'The page redirected to a forbidden destination');
    }

    let height = params.viewportHeight;
    let contentHeight = params.viewportHeight;
    if (params.fullPage) {
      contentHeight = await step(
        page.evaluate(() => {
          const el = document.scrollingElement || document.documentElement;
          return Math.max(el.scrollHeight, document.body ? document.body.scrollHeight : 0);
        }),
      );
      if (!Number.isFinite(contentHeight) || contentHeight < 1) contentHeight = params.viewportHeight;
      height = Math.min(Math.max(Math.ceil(contentHeight), params.viewportHeight), config.maxScreenshotHeight);
    }
    const clipped = params.fullPage && contentHeight > config.maxScreenshotHeight;

    const png = await step(
      page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: params.viewportWidth, height },
        captureBeyondViewport: params.fullPage,
      }),
    );
    const finalUrl = page.url();
    const title = await step(page.title());
    const buf = Buffer.from(png);

    return {
      screenshot: buf,
      finalUrl,
      title,
      size: buf.length,
      width: params.viewportWidth,
      height,
      clipped,
      egress: { ...proxy.stats },
      durationMs: Date.now() - started,
    };
  } catch (err) {
    if (ac.signal.aborted) throw ac.signal.reason;
    if (err instanceof CaptureError) throw err;
    throw new CaptureError('INTERNAL', 'Capture failed', err);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onClientAbort);
    if (launching) {
      // Deadline hit while Chrome was still starting: close it when it appears.
      launching.then((b) => closeBrowser(b, log)).catch(() => {});
    }
    await closeBrowser(browser, log);
    await proxy.close();
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}
