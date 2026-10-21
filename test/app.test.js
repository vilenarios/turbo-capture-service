/**
 * HTTP-level tests with a stub capture (no Chrome): validation, 503 under
 * saturation, rate limiting behind proxies, and x402 payment gating.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { fakeNet, listen, close } from './helpers/net.js';
import { testConfig, startApp, silentLog } from './helpers/app.js';

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function stubCapture({ gate } = {}) {
  const calls = [];
  const fn = async (params) => {
    calls.push(params);
    if (gate) await gate;
    return { screenshot: PNG_1x1, finalUrl: params.url, title: 't', size: PNG_1x1.length, height: 1, clipped: false, egress: {}, durationMs: 1 };
  };
  fn.calls = calls;
  return fn;
}

const post = (base, body, headers = {}) =>
  fetch(`${base}/screenshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('health endpoint', async () => {
  const app = await createApp(testConfig(), { log: silentLog, capture: stubCapture() });
  const s = await startApp(app);
  try {
    const r = await fetch(`${s.url}/health`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.status, 'ok');
    assert.equal(j.activeCaptures, 0);
    assert.ok(r.headers.get('x-request-id'));
  } finally {
    await s.close();
  }
});

test('bad inputs get 400/413/415 with a request id and no capture', async () => {
  const cap = stubCapture();
  const n = fakeNet({});
  const app = await createApp(testConfig({ rateLimitPerMinute: 1000 }), { log: silentLog, capture: cap, net: n });
  const s = await startApp(app);
  try {
    const cases = [
      [{}, 400],
      [{ url: 'file:///etc/passwd' }, 400],
      [{ url: 'javascript:alert(1)' }, 400],
      [{ url: 'http://127.0.0.1:3001/health' }, 400],
      [{ url: 'http://169.254.169.254/latest/meta-data/' }, 400],
      [{ url: 'http://foo.localhost/' }, 400],
      [{ url: 'http://private.public.test/' }, 400],
      [{ url: 'https://site.public.test/', waitFor: '10' }, 400],
      [{ url: 'https://site.public.test/', fullPage: 'yes' }, 400],
      [{ url: 'https://site.public.test/', viewportWidth: 10_000 }, 400],
      [{ url: 'https://site.public.test/', extra: true }, 400],
      ['{not json', 400],
      [JSON.stringify({ url: 'https://site.public.test/', pad: 'x'.repeat(20_000) }), 413],
    ];
    for (const [body, status] of cases) {
      const r = await post(s.url, body);
      const j = await r.json();
      assert.equal(r.status, status, JSON.stringify(body).slice(0, 80));
      assert.ok(j.requestId, 'error carries requestId');
      assert.equal(j.requestId, r.headers.get('x-request-id'));
      assert.doesNotMatch(JSON.stringify(j), /at .*\.js:\d+/, 'no stack traces');
    }
    const wrongType = await fetch(`${s.url}/screenshot`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'url=https://site.public.test/' });
    assert.equal(wrongType.status, 415);
    assert.equal(cap.calls.length, 0);

    const ok = await post(s.url, { url: 'https://site.public.test/', fullPage: false });
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.equal(j.screenshot, PNG_1x1.toString('base64'));
    assert.equal(cap.calls.length, 1);
  } finally {
    await s.close();
  }
});

test('concurrency cap: 503 with Retry-After when slots and queue are full', async () => {
  let open;
  const gate = new Promise((r) => (open = r));
  const cap = stubCapture({ gate });
  const app = await createApp(testConfig({ rateLimitPerMinute: 1000, maxConcurrentCaptures: 2, maxQueue: 1 }), { log: silentLog, capture: cap, net: fakeNet({}) });
  const s = await startApp(app);
  try {
    const inflight = [1, 2, 3].map(() => post(s.url, { url: 'https://site.public.test/' }));
    while (app.locals.gate.active < 2 || app.locals.gate.queued < 1) await new Promise((r) => setTimeout(r, 20));
    const busy = await post(s.url, { url: 'https://site.public.test/' });
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get('retry-after'), '10');
    open();
    const results = await Promise.all(inflight);
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
    assert.equal(cap.calls.length, 3);
  } finally {
    await s.close();
  }
});

test('rate limit keys on the socket address unless TRUST_PROXY is set', async () => {
  const mk = async (trustProxy) => startApp(await createApp(testConfig({ rateLimitPerMinute: 2, trustProxy }), { log: silentLog, capture: stubCapture(), net: fakeNet({}) }));
  const body = { url: 'https://site.public.test/' };

  // Default: X-Forwarded-For is ignored, so spoofing it does not reset the limit.
  let s = await mk(false);
  try {
    const st = [];
    for (let i = 0; i < 3; i++) st.push((await post(s.url, body, { 'x-forwarded-for': `203.0.113.${i}` })).status);
    assert.deepEqual(st, [200, 200, 429]);
  } finally {
    await s.close();
  }

  // TRUST_PROXY=1: the client address comes from the last X-Forwarded-For hop.
  s = await mk(1);
  try {
    const a = [];
    for (let i = 0; i < 3; i++) a.push((await post(s.url, body, { 'x-forwarded-for': '198.51.100.7' })).status);
    assert.deepEqual(a, [200, 200, 429]);
    const other = await post(s.url, body, { 'x-forwarded-for': '198.51.100.8' });
    assert.equal(other.status, 200, 'a different real client has its own bucket');
  } finally {
    await s.close();
  }
});

/**
 * A local stand-in for an x402 facilitator. By default it never approves
 * anything; with approve=true it accepts any payload (to test what happens
 * after a payment verifies).
 */
async function startFakeFacilitator({ approve = false } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body });
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/supported')) {
        return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: [], signers: {} }));
      }
      const payer = '0x' + '34'.repeat(20);
      if (req.url.endsWith('/verify')) {
        return res.end(JSON.stringify(approve ? { isValid: true, payer } : { isValid: false, invalidReason: 'invalid_signature' }));
      }
      if (req.url.endsWith('/settle')) {
        return res.end(JSON.stringify({ success: true, transaction: '0x' + 'ab'.repeat(32), network: 'eip155:84532', payer }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, calls, close: () => close(server) };
}

test('x402: garbage or invalid payment headers cannot bypass both the limiter and payment', async () => {
  const fac = await startFakeFacilitator();
  const cfg = loadConfig({
    ENABLE_X_402: 'true',
    X_402_WALLET_ADDRESS: '0x' + '12'.repeat(20),
    X_402_NETWORK: 'base-sepolia',
    X_402_FACILITATOR_URL: fac.url,
    RATE_LIMIT_PER_MINUTE: '1',
  });
  const cap = stubCapture();
  const app = await createApp(cfg, { log: silentLog, capture: cap, net: fakeNet({}) });
  const s = await startApp(app);
  const body = { url: 'https://site.public.test/' };
  try {
    // Free tier: first request is served.
    assert.equal((await post(s.url, body)).status, 200);
    // Free tier exhausted: 402 Payment Required, not served.
    const unpaid = await post(s.url, body);
    assert.equal(unpaid.status, 402);
    assert.ok(unpaid.headers.get('payment-required'), 'x402 v2 PAYMENT-REQUIRED header present');

    const fakePayload = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: { scheme: 'exact', network: 'eip155:84532', amount: '10000', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', payTo: cfg.x402.wallet, maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } },
        payload: { signature: '0x' + '00'.repeat(65), authorization: {} },
      }),
    ).toString('base64');
    const garbage = [
      { 'x-payment': 'garbage' },
      { 'x-payment': '' },
      { 'payment-signature': 'not-base64!!' },
      { 'payment-signature': Buffer.from('{"x402Version":2}').toString('base64') },
      { 'payment-signature': fakePayload },
      { 'x-payment': fakePayload },
    ];
    for (const h of garbage) {
      const r = await post(s.url, body, h);
      assert.equal(r.status, 402, JSON.stringify(h).slice(0, 60));
    }
    assert.equal(cap.calls.length, 1, 'only the free-tier request reached the capture');
  } finally {
    await s.close();
    await fac.close();
  }
});

test('x402: a verified payment is still subject to the concurrency cap and is not settled when refused', async () => {
  const fac = await startFakeFacilitator({ approve: true });
  const cfg = {
    ...loadConfig({
      ENABLE_X_402: 'true',
      X_402_WALLET_ADDRESS: '0x' + '12'.repeat(20),
      X_402_NETWORK: 'base-sepolia',
      X_402_FACILITATOR_URL: fac.url,
      RATE_LIMIT_PER_MINUTE: '1',
    }),
    maxConcurrentCaptures: 1,
    maxQueue: 0,
  };
  let open;
  const gate = new Promise((r) => (open = r));
  const cap = stubCapture({ gate });
  const app = await createApp(cfg, { log: silentLog, capture: cap, net: fakeNet({}) });
  const s = await startApp(app);
  const body = { url: 'https://site.public.test/' };
  try {
    const first = post(s.url, body); // free tier, occupies the only slot
    while (app.locals.gate.active < 1) await new Promise((r) => setTimeout(r, 20));
    const unpaid = await post(s.url, body);
    assert.equal(unpaid.status, 402);
    const required = JSON.parse(Buffer.from(unpaid.headers.get('payment-required'), 'base64').toString());
    const payment = Buffer.from(
      JSON.stringify({ x402Version: 2, resource: required.resource, accepted: required.accepts[0], payload: { signature: '0x' + '11'.repeat(65), authorization: {} } }),
    ).toString('base64');

    const paidBusy = await post(s.url, body, { 'payment-signature': payment });
    assert.equal(paidBusy.status, 503, 'paid request respects the cap');
    assert.ok(fac.calls.some((c) => c.url.endsWith('/verify')), 'payment was verified');
    assert.ok(!fac.calls.some((c) => c.url.endsWith('/settle')), 'refused request is not settled');

    open();
    assert.equal((await first).status, 200);
    const paidOk = await post(s.url, body, { 'payment-signature': payment });
    assert.equal(paidOk.status, 200);
    assert.ok(fac.calls.some((c) => c.url.endsWith('/settle')), 'served request is settled');
    assert.equal(cap.calls.length, 2);
  } finally {
    await s.close();
    await fac.close();
  }
});
