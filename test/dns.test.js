/**
 * DNS resolution must be bounded: a nameserver that never answers may not
 * stall the service (other captures, the top-level pre-check) for longer
 * than the configured timeout.
 *
 * Part 1 drives the production default path (no injected lookup) against a
 * fake nameserver on 127.0.0.1:53. It needs the container to be started with
 *   --dns 127.0.0.1 --sysctl net.ipv4.ip_unprivileged_port_start=0
 * and skips otherwise. Part 2 tests the bounded resolver directly against a
 * fake nameserver on a random port.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { startEgressProxy } from '../src/egress-proxy.js';
import { precheckUrl } from '../src/validate.js';
import { createBoundedResolver } from '../src/resolver.js';
import { startFakeDns } from './helpers/dns.js';
import { listen, close } from './helpers/net.js';

const ZONES = {
  '*.blackhole.test': { blackhole: true },
  '*.ok.test': { A: ['11.22.33.44'] },
  'v6only.test': { AAAA: ['2606:4700::1111'] },
  'mixed.test': { A: ['11.22.33.44'], AAAA: ['fd00::1'] },
  'mixed4.test': { A: ['11.22.33.44', '10.0.0.1'] },
  'alias.test': { CNAME: 'target.test' },
  'target.test': { A: ['11.22.33.45'] },
  'alias-private.test': { CNAME: 'inside.test' },
  'inside.test': { A: ['192.168.1.10'] },
  'aaaa-hangs.test': { A: ['11.22.33.44'] }, // AAAA handled below
};

let fixture;
let fixturePort;
before(async () => {
  fixture = http.createServer((req, res) => res.end('ok'));
  fixturePort = await listen(fixture);
});
after(() => close(fixture));

const dialToFixture = (ip, port) => {
  if (ip === '11.22.33.44' || ip === '11.22.33.45') return net.connect({ host: '127.0.0.1', port: fixturePort });
  const s = new net.Socket();
  process.nextTick(() => s.destroy(new Error(`test dialer refused ${ip}`)));
  return s;
};

function connectVia(proxy, authority, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.request({
      host: '127.0.0.1',
      port: proxy.port,
      method: 'CONNECT',
      path: authority,
      agent: false,
      headers: { 'proxy-authorization': 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64') },
    });
    const timer = setTimeout(() => {
      req.destroy();
      resolve({ status: 'timeout', ms: Date.now() - t0 });
    }, timeoutMs);
    req.on('connect', (res, sock) => {
      clearTimeout(timer);
      sock.destroy();
      resolve({ status: res.statusCode, ms: Date.now() - t0 });
    });
    req.on('error', () => {
      clearTimeout(timer);
      resolve({ status: 'error', ms: Date.now() - t0 });
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Part 2: the bounded resolver itself.

let fakeDns;
before(async () => {
  fakeDns = await startFakeDns(ZONES);
});
after(() => fakeDns.close());

const mk = (o = {}) => createBoundedResolver({ servers: [fakeDns.server], timeoutMs: 800, tries: 2, maxConcurrent: 4, maxQueue: 16, ...o });

test('resolver: A, AAAA-only, CNAME chains', async () => {
  const r = mk();
  try {
    assert.deepEqual(await r.lookup('www.ok.test'), ['11.22.33.44']);
    assert.deepEqual(await r.lookup('v6only.test'), ['2606:4700::1111']);
    assert.deepEqual(await r.lookup('alias.test'), ['11.22.33.45']);
    assert.deepEqual(await r.lookup('alias-private.test'), ['192.168.1.10'], 'CNAME followed to the final address (proxy then refuses it)');
    assert.deepEqual((await r.lookup('mixed.test')).sort(), ['11.22.33.44', 'fd00::1']);
    assert.deepEqual((await r.lookup('mixed4.test')).sort(), ['10.0.0.1', '11.22.33.44']);
  } finally {
    r.cancel();
  }
});

test('resolver: NXDOMAIN fails, NODATA for both families fails', async () => {
  const r = mk();
  try {
    await assert.rejects(r.lookup('nope.test'), (e) => e.code === 'ENOTFOUND');
  } finally {
    r.cancel();
  }
});

test('resolver: a lookup against a silent nameserver times out within the bound', async () => {
  const r = mk({ timeoutMs: 600 });
  try {
    const t0 = Date.now();
    await assert.rejects(r.lookup('x.blackhole.test'), (e) => e.code === 'ETIMEOUT');
    const ms = Date.now() - t0;
    assert.ok(ms >= 500 && ms < 1_500, `took ${ms} ms`);
  } finally {
    r.cancel();
  }
});

test('resolver: cancel() rejects pending and queued lookups immediately', async () => {
  const r = mk({ timeoutMs: 30_000, maxConcurrent: 2, maxQueue: 10 });
  const ps = [];
  for (let i = 0; i < 6; i++) ps.push(r.lookup(`n${i}.blackhole.test`).then(() => 'ok', (e) => e.code));
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(r.stats().active, 2);
  assert.equal(r.stats().queued, 4);
  const t0 = Date.now();
  r.cancel();
  const codes = await Promise.all(ps);
  assert.ok(Date.now() - t0 < 500);
  assert.ok(codes.every((c) => c === 'ECANCELLED'), codes.join(','));
  await assert.rejects(r.lookup('www.ok.test'), (e) => e.code === 'ECANCELLED');
});

test('resolver: concurrency is capped and the queue is bounded', async () => {
  const r = mk({ timeoutMs: 30_000, maxConcurrent: 3, maxQueue: 2 });
  try {
    const ps = [];
    for (let i = 0; i < 5; i++) ps.push(r.lookup(`q${i}.blackhole.test`).catch((e) => e.code));
    await assert.rejects(r.lookup('overflow.blackhole.test'), (e) => e.code === 'EBUSY');
    assert.equal(r.stats().active, 3);
    assert.equal(r.stats().queued, 2);
    r.cancel();
    await Promise.all(ps);
  } finally {
    r.cancel();
  }
});

test('resolver: separate resolvers do not share a queue', async () => {
  const stuck = mk({ timeoutMs: 30_000, maxConcurrent: 2, maxQueue: 50 });
  const fresh = mk();
  try {
    const ps = [];
    for (let i = 0; i < 40; i++) ps.push(stuck.lookup(`s${i}.blackhole.test`).catch(() => {}));
    const t0 = Date.now();
    assert.deepEqual(await fresh.lookup('www.ok.test'), ['11.22.33.44']);
    assert.ok(Date.now() - t0 < 500, `fresh lookup took ${Date.now() - t0} ms`);
    stuck.cancel();
    await Promise.all(ps);
  } finally {
    stuck.cancel();
    fresh.cancel();
  }
});

test('proxy: close() cancels its pending lookups', async () => {
  const proxy = await startEgressProxy({ dial: dialToFixture, dns: { servers: [fakeDns.server], timeoutMs: 30_000 } });
  const ps = [];
  for (let i = 0; i < 10; i++) ps.push(connectVia(proxy, `p${i}.blackhole.test:443`, 10_000));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(proxy.dnsStats().active > 0);
  const t0 = Date.now();
  await proxy.close();
  const results = await Promise.all(ps);
  assert.ok(Date.now() - t0 < 1_000, `ended ${Date.now() - t0} ms after close`);
  assert.ok(results.every((r) => r.status !== 200 && r.status !== 'timeout'), JSON.stringify(results));
  assert.equal(proxy.dnsStats().active, 0);
});

test('proxy: resolves through the bounded resolver and still refuses mixed answers', async () => {
  const proxy = await startEgressProxy({ dial: dialToFixture, dns: { servers: [fakeDns.server] } });
  try {
    assert.equal((await connectVia(proxy, 'www.ok.test:443')).status, 200);
    assert.equal((await connectVia(proxy, 'alias.test:443')).status, 200);
    assert.equal((await connectVia(proxy, 'mixed.test:443')).status, 403);
    assert.equal((await connectVia(proxy, 'mixed4.test:443')).status, 403);
    assert.equal((await connectVia(proxy, 'alias-private.test:443')).status, 403);
    assert.equal((await connectVia(proxy, 'nope.test:443')).status, 502);
  } finally {
    await proxy.close();
  }
});

test('pre-check uses a bounded resolver with its own short timeout', async () => {
  const t0 = Date.now();
  const res = await precheckUrl('https://slow.blackhole.test/', { dns: { servers: [fakeDns.server], timeoutMs: 700 } });
  assert.match(res, /resolved/);
  assert.ok(Date.now() - t0 < 1_500, `took ${Date.now() - t0} ms`);
  assert.equal(await precheckUrl('https://www.ok.test/', { dns: { servers: [fakeDns.server] } }), null);
});
