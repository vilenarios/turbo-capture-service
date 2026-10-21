/**
 * Egress proxy: an in-process HTTP forward proxy (plain HTTP + CONNECT)
 * that headless Chrome is forced to use for every request it makes.
 *
 * For each request the proxy:
 *   1. requires the per-proxy secret (Proxy-Authorization: Basic),
 *   2. refuses non-allowed ports and forbidden host names,
 *   3. resolves the host ONCE (all A/AAAA records),
 *   4. refuses the request if ANY resolved address is non-public,
 *   5. connects to the exact validated IP (no second lookup, so no DNS
 *      rebinding window between check and use).
 *
 * One proxy is created per capture, listens on 127.0.0.1 only, and is closed
 * (destroying every tunnel) when the capture ends.
 */

import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import crypto from 'node:crypto';
import { isPublicAddress, isForbiddenHostname, normalizeHost } from './address.js';

export const BLOCKED_HEADER = 'x-capture-blocked';

/** Default resolver: getaddrinfo for all A/AAAA records. */
export async function defaultLookup(host) {
  const res = await dns.promises.lookup(host, { all: true, verbatim: true });
  return res.map((r) => r.address);
}

/** Default dialer: TCP connect to an already-validated IP. */
export function defaultDial(ip, port) {
  return net.connect({ host: ip, port });
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

class Refusal extends Error {
  constructor(reason, status = 403) {
    super(reason);
    this.status = status;
  }
}

/**
 * Validate a host:port target and return the ordered list of validated IPs
 * (IPv4 first). Throws Refusal when the target must not be contacted.
 *
 * @param {string} rawHost host as written in the request (may be bracketed IPv6)
 * @param {number} port
 * @param {object} opts
 */
export async function resolveAndValidate(rawHost, port, opts) {
  const { lookup = defaultLookup, allowedPorts = null, extraDeny = [] } = opts;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Refusal('invalid port', 400);

  // Re-parse through the WHATWG URL parser so numeric/hex/octal IPv4 forms
  // are normalised exactly as Chrome does.
  let hostname;
  try {
    const bracketed = rawHost.includes(':') && !rawHost.startsWith('[') ? `[${rawHost}]` : rawHost;
    hostname = new URL(`http://${bracketed}/`).hostname;
  } catch {
    throw new Refusal('invalid host', 400);
  }
  const { host, isIp } = normalizeHost(hostname);
  if (!isIp && isForbiddenHostname(host)) throw new Refusal('forbidden host name');
  if (isIp && !isPublicAddress(host, { extraDeny })) throw new Refusal(`non-public address ${host}`);
  if (allowedPorts && !allowedPorts.has(port)) throw new Refusal(`port ${port} not allowed`);

  let addresses;
  if (isIp) {
    addresses = [host];
  } else {
    try {
      addresses = await lookup(host);
    } catch {
      throw new Refusal('DNS resolution failed', 502);
    }
    if (!Array.isArray(addresses) || addresses.length === 0) throw new Refusal('DNS resolution failed', 502);
  }
  for (const a of addresses) {
    if (!isPublicAddress(a, { extraDeny })) throw new Refusal(`non-public address ${a}`);
  }
  const v4 = addresses.filter((a) => !a.includes(':'));
  const v6 = addresses.filter((a) => a.includes(':'));
  return { host, addresses: [...v4, ...v6] };
}

function dialFirst(addresses, port, dial, connectTimeoutMs) {
  return new Promise((resolve, reject) => {
    let i = 0;
    const tryNext = (lastErr) => {
      if (i >= addresses.length) return reject(lastErr ?? new Error('connect failed'));
      const ip = addresses[i++];
      const sock = dial(ip, port);
      const timer = setTimeout(() => sock.destroy(new Error('connect timeout')), connectTimeoutMs);
      const onError = (err) => {
        clearTimeout(timer);
        sock.removeListener('connect', onConnect);
        sock.destroy();
        tryNext(err);
      };
      const onConnect = () => {
        clearTimeout(timer);
        sock.removeListener('error', onError);
        resolve({ sock, ip });
      };
      sock.once('error', onError);
      sock.once('connect', onConnect);
    };
    tryNext();
  });
}

/**
 * Start a proxy. Returns { port, username, password, close(), blocked, stats }.
 *
 * @param {object} opts
 * @param {(host: string) => Promise<string[]>} [opts.lookup] resolver (tests inject one)
 * @param {(ip: string, port: number) => net.Socket} [opts.dial] dialer (tests inject one)
 * @param {Set<number>|null} [opts.allowedPorts] null = any port
 * @param {Array} [opts.extraDeny] parsed extra CIDRs
 * @param {number} [opts.connectTimeoutMs]
 * @param {number} [opts.maxBytes] total bytes (both directions) before tunnels are cut
 * @param {(event: object) => void} [opts.onEvent] log hook
 */
export async function startEgressProxy(opts = {}) {
  const {
    lookup = defaultLookup,
    dial = defaultDial,
    allowedPorts = null,
    extraDeny = [],
    connectTimeoutMs = 10_000,
    maxBytes = 200 * 1024 * 1024,
    onEvent = () => {},
  } = opts;
  const username = 'capture';
  const password = crypto.randomBytes(24).toString('hex');
  const expectedAuth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const vOpts = { lookup, allowedPorts, extraDeny };

  /** host:port strings the proxy refused (used to explain navigation failures). */
  const blocked = new Set();
  const stats = { allowed: 0, refused: 0, bytes: 0 };
  const sockets = new Set();
  let closed = false;

  const track = (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  };
  const countBytes = (s) => {
    s.on('data', (chunk) => {
      stats.bytes += chunk.length;
      if (stats.bytes > maxBytes) {
        onEvent({ type: 'byte-cap', bytes: stats.bytes });
        for (const x of sockets) x.destroy();
      }
    });
  };

  const authOk = (req) => {
    const got = req.headers['proxy-authorization'];
    if (typeof got !== 'string') return false;
    const a = Buffer.from(got);
    const b = Buffer.from(expectedAuth);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const refuse = (host, port, err) => {
    if ((err.status ?? 403) === 403) blocked.add(`${host}:${port}`);
    stats.refused++;
    onEvent({ type: 'refused', host, port, reason: err.message });
  };

  const server = http.createServer();
  server.on('connection', track);

  // Plain-HTTP proxying (absolute-form request targets).
  server.on('request', async (req, res) => {
    if (!authOk(req)) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="capture"', 'Content-Length': 0 });
      return res.end();
    }
    let target;
    try {
      target = new URL(req.url);
      if (target.protocol !== 'http:') throw new Error('scheme');
    } catch {
      res.writeHead(400, { 'Content-Length': 0, [BLOCKED_HEADER]: '1' });
      return res.end();
    }
    const port = target.port ? Number(target.port) : 80;
    let validated;
    try {
      validated = await resolveAndValidate(target.hostname, port, vOpts);
    } catch (err) {
      refuse(target.hostname.replace(/^\[|\]$/g, ''), port, err);
      const body = 'Blocked by capture egress policy';
      res.writeHead(err.status ?? 403, {
        'Content-Type': 'text/plain',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        [BLOCKED_HEADER]: '1',
      });
      return res.end(body);
    }
    if (closed) return res.destroy();

    let upstreamSock;
    try {
      ({ sock: upstreamSock } = await dialFirst(validated.addresses, port, dial, connectTimeoutMs));
    } catch (err) {
      onEvent({ type: 'connect-failed', host: validated.host, port, reason: err.message });
      res.writeHead(502, { 'Content-Length': 0 });
      return res.end();
    }
    track(upstreamSock);
    countBytes(upstreamSock);
    stats.allowed++;

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
    }
    headers.host = target.host;
    headers.connection = 'close';
    const upstreamReq = http.request({
      method: req.method,
      path: target.pathname + target.search,
      headers,
      createConnection: () => upstreamSock,
    });
    upstreamReq.on('response', (up) => {
      const outHeaders = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = v;
      }
      res.writeHead(up.statusCode ?? 502, outHeaders);
      up.pipe(res);
    });
    upstreamReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Length': 0 });
      res.destroy();
    });
    req.pipe(upstreamReq);
  });

  // CONNECT tunnels (HTTPS, WebSockets).
  server.on('connect', async (req, clientSock, head) => {
    track(clientSock);
    clientSock.on('error', () => {});
    if (!authOk(req)) {
      clientSock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="capture"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(req.url ?? '');
    if (!m) {
      clientSock.end(`HTTP/1.1 400 Bad Request\r\n${BLOCKED_HEADER}: 1\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const rawHost = m[1].replace(/^\[|\]$/g, '');
    const port = Number(m[2]);
    let validated;
    try {
      validated = await resolveAndValidate(rawHost, port, vOpts);
    } catch (err) {
      refuse(rawHost, port, err);
      const status = err.status ?? 403;
      const text = status === 403 ? 'Forbidden' : status === 400 ? 'Bad Request' : 'Bad Gateway';
      clientSock.end(`HTTP/1.1 ${status} ${text}\r\n${BLOCKED_HEADER}: 1\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    if (closed) return clientSock.destroy();
    let upstreamSock;
    try {
      ({ sock: upstreamSock } = await dialFirst(validated.addresses, port, dial, connectTimeoutMs));
    } catch (err) {
      onEvent({ type: 'connect-failed', host: validated.host, port, reason: err.message });
      clientSock.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    track(upstreamSock);
    countBytes(upstreamSock);
    stats.allowed++;
    upstreamSock.on('error', () => clientSock.destroy());
    clientSock.on('error', () => upstreamSock.destroy());
    clientSock.on('close', () => upstreamSock.destroy());
    upstreamSock.on('close', () => clientSock.destroy());
    clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstreamSock.write(head);
    upstreamSock.pipe(clientSock);
    clientSock.pipe(upstreamSock);
  });

  // Upgrade requests on the plain-HTTP path are never tunnelled: Chrome
  // sends WebSockets through CONNECT, so anything here is unexpected.
  server.on('upgrade', (req, sock) => {
    sock.end(`HTTP/1.1 403 Forbidden\r\n${BLOCKED_HEADER}: 1\r\nContent-Length: 0\r\n\r\n`);
  });
  server.on('clientError', (err, sock) => sock.destroy());

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    port,
    username,
    password,
    blocked,
    stats,
    async close() {
      closed = true;
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
