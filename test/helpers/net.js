/**
 * Test-only helpers: local fixture servers and a fake "public" network.
 *
 * Everything listens on 127.0.0.1. Fake host names resolve (through the
 * injected lookup) to addresses that classify as public, and the injected
 * dialer maps those addresses to the local fixture server. Production code
 * never receives these hooks.
 */

import net from 'node:net';

export const FAKE_PUBLIC_IP = '11.22.33.44';
export const FAKE_PUBLIC_IP_2 = '11.22.33.45';

export function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

export function close(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/**
 * A "trap": a raw TCP server on 127.0.0.1 that records every connection
 * attempt. Tests assert it saw nothing.
 */
export async function startTrap() {
  const hits = [];
  const server = net.createServer((sock) => {
    hits.push({ at: Date.now() });
    sock.on('data', (d) => hits.push({ data: d.toString('latin1').slice(0, 200) }));
    sock.on('error', () => {});
    sock.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 6\r\n\r\nLEAKED');
  });
  const port = await listen(server);
  return { port, hits, close: () => close(server) };
}

/**
 * Network hooks for the capture/proxy: names under .public.test resolve to
 * fake public IPs; "mixed.public.test" resolves to public + loopback.
 */
export function fakeNet({ fixturePort, overrides = {} }) {
  const lookups = [];
  const dials = [];
  return {
    lookups,
    dials,
    lookup: async (host) => {
      lookups.push(host);
      if (host in overrides) return overrides[host];
      if (host === 'mixed.public.test') return [FAKE_PUBLIC_IP, '127.0.0.1'];
      if (host === 'private.public.test') return ['10.1.2.3'];
      if (host === 'other.public.test') return [FAKE_PUBLIC_IP_2];
      if (host.endsWith('.public.test')) return [FAKE_PUBLIC_IP];
      const err = new Error(`ENOTFOUND ${host}`);
      err.code = 'ENOTFOUND';
      throw err;
    },
    dial: (ip, port) => {
      dials.push({ ip, port });
      if (ip === FAKE_PUBLIC_IP || ip === FAKE_PUBLIC_IP_2) return net.connect({ host: '127.0.0.1', port: fixturePort ?? port });
      // Anything else would be a real connection: refuse loudly in tests.
      const s = new net.Socket();
      process.nextTick(() => s.destroy(new Error(`test dialer refused ${ip}:${port}`)));
      return s;
    },
  };
}
