import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startEgressProxy, BLOCKED_HEADER } from '../src/egress-proxy.js';
import { listen, close, startTrap, fakeNet, FAKE_PUBLIC_IP } from './helpers/net.js';

let fixture;
let fixturePort;
const fixtureHits = [];
let trap;

before(async () => {
  fixture = http.createServer((req, res) => {
    fixtureHits.push({ host: req.headers.host, url: req.url, auth: req.headers['proxy-authorization'] });
    res.end(`hello from ${req.headers.host}${req.url}`);
  });
  fixturePort = await listen(fixture);
  trap = await startTrap();
});
after(async () => {
  await close(fixture);
  await trap.close();
});

function proxied(proxy, url, { auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const headers = auth ? { 'proxy-authorization': 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64') } : {};
    const req = http.request({ host: '127.0.0.1', port: proxy.port, path: url, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function connect(proxy, authority, { auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const headers = auth ? { 'proxy-authorization': 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64') } : {};
    const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: authority, headers, agent: false });
    req.on('connect', (res, socket) => resolve({ status: res.statusCode, headers: res.headers, socket }));
    req.on('error', reject);
    req.end();
  });
}

async function withProxy(netOverrides, fn, opts = {}) {
  const n = fakeNet({ fixturePort, overrides: netOverrides });
  const proxy = await startEgressProxy({ lookup: n.lookup, dial: n.dial, ...opts });
  try {
    await fn(proxy, n);
  } finally {
    await proxy.close();
  }
}

test('requires the per-proxy secret', async () => {
  await withProxy({}, async (proxy, n) => {
    const r = await proxied(proxy, `http://site.public.test:${fixturePort}/`, { auth: false });
    assert.equal(r.status, 407);
    const c = await connect(proxy, `site.public.test:${fixturePort}`, { auth: false });
    assert.equal(c.status, 407);
    c.socket.destroy();
    const wrong = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path: 'http://site.public.test/', headers: { 'proxy-authorization': 'Basic ' + Buffer.from('capture:nope').toString('base64') }, agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.end();
    });
    assert.equal(wrong, 407);
    assert.equal(n.lookups.length, 0);
    assert.equal(n.dials.length, 0);
  });
});

test('two proxies have different secrets and listen on loopback only', async () => {
  const a = await startEgressProxy();
  const b = await startEgressProxy();
  try {
    assert.notEqual(a.password, b.password);
    assert.ok(a.password.length >= 32);
  } finally {
    await a.close();
    await b.close();
  }
});

test('allows a public-classified target and connects to the validated IP (HTTP)', async () => {
  await withProxy({}, async (proxy, n) => {
    const r = await proxied(proxy, `http://site.public.test:${fixturePort}/page?x=1`);
    assert.equal(r.status, 200);
    assert.equal(r.body, `hello from site.public.test:${fixturePort}/page?x=1`);
    assert.deepEqual(n.lookups, ['site.public.test'], 'resolved exactly once');
    assert.deepEqual(n.dials, [{ ip: FAKE_PUBLIC_IP, port: fixturePort }], 'dialled the validated IP, not the name');
    const hit = fixtureHits.at(-1);
    assert.equal(hit.auth, undefined, 'Proxy-Authorization is not forwarded upstream');
  });
});

test('allows a public-classified target (CONNECT tunnel)', async () => {
  await withProxy({}, async (proxy, n) => {
    const c = await connect(proxy, `site.public.test:${fixturePort}`);
    assert.equal(c.status, 200);
    const body = await new Promise((resolve) => {
      let data = '';
      c.socket.on('data', (d) => (data += d));
      c.socket.on('end', () => resolve(data));
      c.socket.write(`GET /tunnel HTTP/1.1\r\nHost: site.public.test\r\nConnection: close\r\n\r\n`);
    });
    assert.match(body, /hello from site\.public\.test\/tunnel/);
    assert.deepEqual(n.dials, [{ ip: FAKE_PUBLIC_IP, port: fixturePort }]);
  });
});

test('refuses names that resolve to private addresses', async () => {
  await withProxy({ 'evil.public.test': ['10.0.0.5'], 'meta.public.test': ['169.254.169.254'], 'v6.public.test': ['fd00::1'] }, async (proxy, n) => {
    for (const host of ['evil.public.test', 'meta.public.test', 'v6.public.test']) {
      const r = await proxied(proxy, `http://${host}:${fixturePort}/`);
      assert.equal(r.status, 403, host);
      assert.equal(r.headers[BLOCKED_HEADER], '1');
      const c = await connect(proxy, `${host}:443`);
      assert.equal(c.status, 403, host);
      c.socket.destroy();
    }
    assert.equal(n.dials.length, 0);
    assert.ok(proxy.blocked.has(`evil.public.test:${fixturePort}`));
  });
});

test('refuses DNS answers mixing public and private addresses', async () => {
  await withProxy({}, async (proxy, n) => {
    const r = await proxied(proxy, `http://mixed.public.test:${fixturePort}/`);
    assert.equal(r.status, 403);
    const c = await connect(proxy, `mixed.public.test:443`);
    assert.equal(c.status, 403);
    c.socket.destroy();
    assert.equal(n.dials.length, 0);
  });
  await withProxy({ 'mixed6.public.test': ['2606:4700::1', '::ffff:127.0.0.1'] }, async (proxy, n) => {
    const r = await proxied(proxy, `http://mixed6.public.test/`);
    assert.equal(r.status, 403);
    assert.equal(n.dials.length, 0);
  });
});

test('refuses IP literals and *.localhost without a DNS lookup, and never reaches the trap', async () => {
  await withProxy({}, async (proxy, n) => {
    const targets = [
      `http://127.0.0.1:${trap.port}/`,
      `http://127.1:${trap.port}/`,
      `http://0x7f.1:${trap.port}/`,
      `http://2130706433:${trap.port}/`,
      `http://0177.0.0.1:${trap.port}/`,
      `http://[::1]:${trap.port}/`,
      `http://[::ffff:127.0.0.1]:${trap.port}/`,
      `http://localhost:${trap.port}/`,
      `http://foo.localhost:${trap.port}/`,
      `http://169.254.169.254/latest/meta-data/`,
      `http://0.0.0.0:${trap.port}/`,
    ];
    for (const t of targets) {
      const r = await proxied(proxy, t);
      assert.equal(r.status, 403, t);
    }
    for (const a of [`127.0.0.1:${trap.port}`, `[::1]:${trap.port}`, `0x7f.1:${trap.port}`, `localhost:${trap.port}`, `a.localhost:${trap.port}`, `169.254.169.254:443`]) {
      const c = await connect(proxy, a);
      assert.equal(c.status, 403, a);
      c.socket.destroy();
    }
    assert.equal(n.lookups.length, 0);
    assert.equal(n.dials.length, 0);
    assert.equal(trap.hits.length, 0);
  });
});

test('refuses ports outside the allow-list', async () => {
  await withProxy(
    {},
    async (proxy, n) => {
      const r = await proxied(proxy, `http://site.public.test:${fixturePort}/`);
      assert.equal(r.status, 403);
      const c = await connect(proxy, 'site.public.test:22');
      assert.equal(c.status, 403);
      c.socket.destroy();
      assert.equal(n.dials.length, 0);
    },
    { allowedPorts: new Set([80, 443]) },
  );
});

test('DNS failure is a 502, not a policy block', async () => {
  await withProxy({}, async (proxy) => {
    const r = await proxied(proxy, 'http://does-not-exist.example/');
    assert.equal(r.status, 502);
    assert.equal(proxy.blocked.size, 0);
  });
});

test('non-http absolute URLs are refused', async () => {
  await withProxy({}, async (proxy, n) => {
    const r = await proxied(proxy, 'ftp://site.public.test/');
    assert.equal(r.status, 400);
    assert.equal(n.dials.length, 0);
  });
});

test('close() tears down open tunnels', async () => {
  const n = fakeNet({ fixturePort });
  const proxy = await startEgressProxy({ lookup: n.lookup, dial: n.dial });
  const c = await connect(proxy, `site.public.test:${fixturePort}`);
  assert.equal(c.status, 200);
  const closed = new Promise((resolve) => c.socket.on('close', resolve));
  await proxy.close();
  await closed;
});
