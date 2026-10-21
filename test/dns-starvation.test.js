/**
 * Regression test for DNS starvation (review blocker). DNS resolution must be bounded: a nameserver that never answers may not
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
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { startEgressProxy } from '../src/egress-proxy.js';
import { precheckUrl } from '../src/validate.js';
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
// Part 1: production default path vs. a nameserver that never answers.

const systemDnsIsFake = (() => {
  try {
    return /^nameserver\s+127\.0\.0\.1\s*$/m.test(fs.readFileSync('/etc/resolv.conf', 'utf8'));
  } catch {
    return false;
  }
})();

test('stuck lookups from one capture do not delay another capture or the pre-check', { skip: !systemDnsIsFake && 'needs --dns 127.0.0.1' }, async (t) => {
  let dns;
  try {
    dns = await startFakeDns(ZONES, { port: 53 });
  } catch (err) {
    return t.skip(`cannot bind 127.0.0.1:53 (${err.code}); run with --sysctl net.ipv4.ip_unprivileged_port_start=0`);
  }
  const a = await startEgressProxy({ dial: dialToFixture });
  const b = await startEgressProxy({ dial: dialToFixture });
  try {
    // Capture A: a page with 40 images on hosts whose nameserver never answers.
    const stuck = [];
    for (let i = 0; i < 40; i++) stuck.push(connectVia(a, `img${i}.blackhole.test:443`, 60_000));
    await new Promise((r) => setTimeout(r, 300));

    // Capture B and a fresh pre-check must not queue behind A's lookups.
    const rb = await connectVia(b, 'www.ok.test:443', 10_000);
    assert.equal(rb.status, 200, `capture B: ${JSON.stringify(rb)}`);
    assert.ok(rb.ms < 2_000, `capture B lookup took ${rb.ms} ms`);

    const t0 = Date.now();
    const pre = await Promise.race([precheckUrl('https://www.ok.test/', {}), new Promise((r) => setTimeout(() => r('timeout'), 10_000))]);
    assert.equal(pre, null, `pre-check result ${pre}`);
    assert.ok(Date.now() - t0 < 2_000, `pre-check took ${Date.now() - t0} ms`);

    // Closing A cancels its pending lookups: every stuck request ends promptly.
    const tc = Date.now();
    await a.close();
    const results = await Promise.all(stuck);
    assert.ok(Date.now() - tc < 2_000, `stuck requests ended ${Date.now() - tc} ms after close`);
    assert.ok(results.every((r) => r.status !== 200));
  } finally {
    await a.close();
    await b.close();
    await dns.close();
  }
});

